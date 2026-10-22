// FFmpeg helpers for local ingest: probe media and make thumbnails. Uses the
// system ffmpeg/ffprobe when present, otherwise the binaries Remotion ships.

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { type AssetKind, FILMSTRIP, type Filmstrip, filmstripPlan } from '../shared/project';

const run = promisify(execFile);
const require = createRequire(import.meta.url);

interface Tool {
  bin: string;
  env?: NodeJS.ProcessEnv;
}

function findTool(name: 'ffmpeg' | 'ffprobe'): Tool {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, name);
    if (dir && existsSync(candidate)) return { bin: candidate };
  }
  const pkg = `@remotion/compositor-${process.platform}-${process.arch}${process.platform === 'linux' ? '-gnu' : ''}`;
  try {
    const dir = path.dirname(require.resolve(`${pkg}/package.json`));
    return { bin: path.join(dir, name), env: { ...process.env, DYLD_LIBRARY_PATH: dir, LD_LIBRARY_PATH: dir } };
  } catch {
    throw new Error(`${name} not found. Install FFmpeg (https://ffmpeg.org) or reinstall dependencies.`);
  }
}

export const toolPath = (name: 'ffmpeg' | 'ffprobe') => findTool(name).bin;

let ffprobe: Tool | undefined;
let ffmpeg: Tool | undefined;

const MEDIA_EXT: Record<string, AssetKind> = {
  mp4: 'video', mov: 'video', webm: 'video', mkv: 'video', m4v: 'video',
  mp3: 'audio', wav: 'audio', m4a: 'audio', aac: 'audio', ogg: 'audio', flac: 'audio', opus: 'audio',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
};

const MIME: Record<string, string> = {
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', m4v: 'video/mp4',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac', opus: 'audio/opus',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
};

const ext = (file: string) => path.extname(file).slice(1).toLowerCase();
export const mediaKind = (file: string): AssetKind | null => MEDIA_EXT[ext(file)] ?? null;
export const mimeFor = (file: string): string => MIME[ext(file)] ?? 'application/octet-stream';

export interface ProbeResult {
  kind: AssetKind;
  duration: number | null;
  width: number | null;
  height: number | null;
}

export async function probeMedia(file: string): Promise<ProbeResult | null> {
  const kind = mediaKind(file);
  if (!kind) return null;
  ffprobe ??= findTool('ffprobe');
  try {
    const { stdout } = await run(ffprobe.bin, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], {
      env: ffprobe.env,
      maxBuffer: 10_000_000,
    });
    const info = JSON.parse(stdout) as {
      format?: { duration?: string };
      streams?: {
        codec_type: string;
        width?: number;
        height?: number;
        disposition?: { attached_pic?: number };
        tags?: { rotate?: string };
        side_data_list?: { rotation?: number }[];
      }[];
    };
    const video = info.streams?.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
    const duration = kind === 'image' ? null : Number(info.format?.duration) || null;
    // A "video" file without a video stream is really audio.
    const actualKind: AssetKind = kind === 'video' && !video ? 'audio' : kind;
    // Phones store portrait video as landscape plus a rotation; report the size as it plays.
    const rotation = Number(video?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? video?.tags?.rotate ?? 0);
    const turned = Math.abs(rotation) % 180 === 90;
    const width = (turned ? video?.height : video?.width) ?? null;
    const height = (turned ? video?.width : video?.height) ?? null;
    return { kind: actualKind, duration, width, height };
  } catch {
    return null;
  }
}

export async function makeThumbnail(file: string, kind: AssetKind, duration: number | null, out: string): Promise<boolean> {
  if (kind === 'audio') return false;
  ffmpeg ??= findTool('ffmpeg');
  const seek = kind === 'video' ? ['-ss', String(Math.min(1, (duration ?? 0) / 10))] : [];
  try {
    await run(ffmpeg.bin, ['-y', '-v', 'error', ...seek, '-i', file, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', out], {
      env: ffmpeg.env,
    });
    return existsSync(out);
  } catch {
    return false;
  }
}

/**
 * A filmstrip sprite for a video: one frame every couple of seconds (see
 * filmstripPlan), each FILMSTRIP.width pixels wide, side by side in one JPEG.
 * Frame i shows the source at i × every seconds. Returns null when FFmpeg
 * cannot read the video.
 */
export async function makeFilmstrip(file: string, duration: number | null, out: string): Promise<Filmstrip | null> {
  if (!duration || duration <= 0) return null;
  ffmpeg ??= findTool('ffmpeg');
  ffprobe ??= findTool('ffprobe');
  const { frames, every } = filmstripPlan(duration);
  try {
    await run(
      ffmpeg.bin,
      ['-y', '-v', 'error', '-i', file, '-an', '-vf', `fps=1/${every},scale=${FILMSTRIP.width}:-2,tile=${frames}x1`, '-frames:v', '1', '-q:v', '5', out],
      { env: ffmpeg.env, maxBuffer: 10_000_000 },
    );
    const { stdout } = await run(ffprobe.bin, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out], {
      env: ffprobe.env,
    });
    const [w, h] = stdout.trim().split(',').map(Number);
    if (!(w > 0 && h > 0)) return null;
    return { frames, every, width: Math.round(w / frames), height: h };
  } catch {
    return null;
  }
}

export const PEAKS_PER_SECOND = 50;

/**
 * Waveform peaks: `perSecond` values per second (PEAKS_PER_SECOND for
 * waveforms), each the loudest sample of any channel in that stretch as
 * 0..255 of full scale. Decoded at 48 kHz and streamed, so the peaks are true
 * sample peaks (meters and Normalize rely on that) without holding the whole
 * file in memory.
 */
export async function computePeaks(file: string, perSecond = PEAKS_PER_SECOND): Promise<number[] | null> {
  ffmpeg ??= findTool('ffmpeg');
  const rate = 48_000;
  const channels = 2;
  const bucket = Math.round(rate / perSecond) * channels;
  return new Promise((resolve) => {
    const child = spawn(ffmpeg!.bin, ['-v', 'error', '-i', file, '-vn', '-ac', String(channels), '-ar', String(rate), '-f', 's16le', '-'], {
      env: ffmpeg!.env,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const peaks: number[] = [];
    let max = 0;
    let n = 0;
    let carry: Buffer | null = null;
    child.stdout.on('data', (chunk: Buffer) => {
      const buf = carry ? Buffer.concat([carry, chunk]) : chunk;
      const whole = buf.length - (buf.length % 2);
      for (let i = 0; i < whole; i += 2) {
        const v = Math.abs(buf.readInt16LE(i));
        if (v > max) max = v;
        if (++n === bucket) {
          peaks.push(Math.min(255, Math.round((max / 32768) * 255)));
          max = 0;
          n = 0;
        }
      }
      carry = whole < buf.length ? buf.subarray(whole) : null;
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (n > 0) peaks.push(Math.min(255, Math.round((max / 32768) * 255)));
      resolve(code === 0 ? peaks : null);
    });
  });
}

/** Mono 16 kHz WAV of a file's audio, the input speech-to-text engines expect. */
export async function extractSpeechAudio(file: string, out: string): Promise<void> {
  ffmpeg ??= findTool('ffmpeg');
  await run(ffmpeg.bin, ['-y', '-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out], { env: ffmpeg.env });
}

/** RGB bytes of `count` small frames sampled evenly between `from` and `to` seconds. */
export async function sampleFrames(file: string, from: number, to: number, count = 8): Promise<Buffer> {
  ffmpeg ??= findTool('ffmpeg');
  const frames: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    const t = from + ((to - from) * (i + 0.5)) / count;
    try {
      const { stdout } = await run(
        ffmpeg.bin,
        ['-v', 'error', '-ss', t.toFixed(3), '-i', file, '-frames:v', '1', '-vf', 'scale=96:-2', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
        { env: ffmpeg.env, encoding: 'buffer', maxBuffer: 10_000_000 },
      );
      frames.push(stdout);
    } catch {
      // Past the end or undecodable frame: skip it.
    }
  }
  return Buffer.concat(frames);
}
