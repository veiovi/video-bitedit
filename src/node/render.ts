// Render a timeline document with Remotion (headless Chrome + FFmpeg) using
// the same composition the browser preview plays.

import { bundle } from '@remotion/bundler';
import { type OnBrowserDownload, ensureBrowser, renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import { execFile } from 'node:child_process';
import { rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { toolPath } from './media';
import { type FrameRange, RENDER_PRESETS, type ProjectDoc, type RenderPhase, type RenderPresetId, findTimeline } from '../shared/project';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let bundled: Promise<string> | undefined;

/** Bundle the composition once per process; later renders reuse it. */
function serveUrl(): Promise<string> {
  bundled ??= bundle({ entryPoint: path.join(ROOT, 'src/remotion/index.ts') }).catch((err) => {
    bundled = undefined;
    throw err;
  });
  return bundled;
}

export interface RenderOptions {
  doc: ProjectDoc;
  /** Timeline ID or name; defaults to the first timeline. */
  timelineId?: string;
  /** assetId → URL reachable from this machine (http:// or https://). */
  sources: Record<string, string>;
  preset: RenderPresetId;
  output: string;
  onProgress?: (progress: number) => void;
  /**
   * The steps before the first frame: the one-time renderer download, then preparing; null once
   * frames render. Without it, Remotion prints the download's progress to the terminal itself.
   */
  onPhase?: (phase: RenderPhase | null) => void;
  /** Normalise loudness to -14 LUFS (social-platform level) after rendering. Default true. */
  normalize?: boolean;
  /** Frames [start, end) to render; the whole timeline when unset. A still renders the frame at `start`. */
  range?: FrameRange | null;
}

/**
 * Remotion's `onBrowserDownload` hook, reporting the first render's download of Chrome Headless
 * Shell as a phase. The download reports every chunk, so only whole-percent changes go through.
 */
export function browserDownloadPhase(onPhase: (phase: RenderPhase) => void): OnBrowserDownload {
  return () => {
    let last = -1;
    return {
      version: null,
      onProgress: ({ alreadyAvailable, percent, totalSizeInBytes }) => {
        const whole = Math.floor(percent * 100);
        if (alreadyAvailable || whole === last) return;
        last = whole;
        onPhase(
          percent >= 1
            ? { label: 'Unpacking the renderer', progress: null }
            : { label: `Downloading the renderer (once, ${Math.round(totalSizeInBytes / 1_048_576)} MB)`, progress: percent },
        );
      },
    };
  };
}

export async function renderTimeline({ doc, timelineId, sources, preset, output, onProgress, onPhase, normalize = true, range }: RenderOptions): Promise<void> {
  const timeline = findTimeline(doc, timelineId);
  if (!timeline) throw new Error(`No timeline "${timelineId}"`);
  if (onPhase) {
    onPhase({ label: 'Preparing', progress: null });
    // Fetch the browser now rather than inside selectComposition, so the download can report progress.
    await ensureBrowser({ onBrowserDownload: browserDownloadPhase(onPhase) });
    onPhase({ label: 'Preparing', progress: null });
  }
  const url = await serveUrl();
  const inputProps = { timeline, theme: doc.theme, sources };
  const composition = await selectComposition({ serveUrl: url, id: 'Timeline', inputProps });
  onPhase?.(null);
  const p = RENDER_PRESETS[preset];
  if (p.still) {
    const frame = Math.min(Math.max(0, range?.start ?? 0), composition.durationInFrames - 1);
    await renderStill({ composition, serveUrl: url, inputProps, frame, output, imageFormat: 'png', scale: p.scale, timeoutInMilliseconds: 120_000 });
    onProgress?.(1);
    return;
  }
  // Remotion's frame range is inclusive at both ends.
  const frameRange: [number, number] | undefined = range
    ? [Math.max(0, range.start), Math.min(composition.durationInFrames, range.end) - 1]
    : undefined;
  let last = -1;
  await renderMedia({
    frameRange,
    composition,
    serveUrl: url,
    inputProps,
    codec: p.audioOnly ? 'mp3' : 'h264',
    scale: p.scale,
    outputLocation: output,
    // Media is streamed from a server that may be slow; allow generous time per frame.
    timeoutInMilliseconds: 120_000,
    onProgress: ({ progress }) => {
      const rounded = Math.floor(progress * 100);
      if (rounded !== last) {
        last = rounded;
        onProgress?.(progress);
      }
    },
  });
  if (normalize) await normalizeLoudness(output, p.audioOnly);
}

/**
 * One-pass EBU R128 loudness normalisation (-14 LUFS, -1.5 dBTP) of the
 * rendered file's audio. Video is stream-copied, so pictures are untouched.
 */
async function normalizeLoudness(file: string, audioOnly: boolean) {
  const tmp = file.replace(/(\.\w+)$/, '.norm$1');
  const audio = audioOnly ? ['-c:a', 'libmp3lame', '-b:a', '192k'] : ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'];
  try {
    await run(toolPath('ffmpeg'), ['-y', '-v', 'error', '-i', file, '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', ...audio, tmp], {
      maxBuffer: 10_000_000,
    });
    await rename(tmp, file);
  } catch {
    // No audio stream, or FFmpeg unavailable: keep the original render.
    await rm(tmp, { force: true });
  }
}
