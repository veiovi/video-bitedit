// Word-timed transcripts and caption clips.
//
// A transcript is an asset sidecar with word timings in source seconds. A
// caption clip carries the words it shows in frames relative to the clip's
// start; the composition groups them into short lines and highlights the word
// being spoken. Lines hold 3–4 words and break at punctuation and at pauses.

import type { CaptionWord, Clip, Timeline, Track } from './project';
import { clipEnd } from './project';

export interface TranscriptWord {
  text: string;
  /** Source seconds. */
  start: number;
  end: number;
}

export interface Transcript {
  assetId: string;
  /** Tool that produced it, e.g. "whisper" or "whisper-cpp". */
  engine: string;
  model: string;
  language?: string;
  createdAt: number;
  words: TranscriptWord[];
}

/** Shape check for transcripts received over the API. */
export function isTranscript(x: unknown): x is Transcript {
  const t = x as Transcript;
  return (
    typeof t === 'object' &&
    t !== null &&
    typeof t.engine === 'string' &&
    Array.isArray(t.words) &&
    t.words.every((w) => typeof w?.text === 'string' && Number.isFinite(w.start) && Number.isFinite(w.end))
  );
}

export function transcriptText(t: Pick<Transcript, 'words'>): string {
  return t.words.map((w) => w.text).join(' ');
}

/** A pause at least this long starts a new caption line. */
export const CAPTION_PAUSE_MS = 140;
export const CAPTION_MAX_WORDS = 4;
/** How long a line stays up after its last word when the next line is later. */
export const CAPTION_HOLD_SECONDS = 0.6;

const BREAK_AFTER = /[.,!?;:…—–]["')\]]*$/;

export interface CaptionLine {
  words: CaptionWord[];
  /** Frames relative to the clip: when the line appears and disappears. */
  start: number;
  end: number;
}

/** Split a run of n words into ceil(n / max) chunks of near-equal size (5 → 3 + 2, 7 → 4 + 3). */
function balance(words: CaptionWord[], max: number): CaptionWord[][] {
  const count = Math.ceil(words.length / max);
  const out: CaptionWord[][] = [];
  let i = 0;
  for (let k = 0; k < count; k++) {
    const size = Math.ceil((words.length - i) / (count - k));
    out.push(words.slice(i, i + size));
    i += size;
  }
  return out;
}

/** Group caption words into display lines with their on-screen ranges. */
export function chunkCaptions(
  words: CaptionWord[],
  fps: number,
  opts: { maxWords?: number; pauseMs?: number; holdSeconds?: number } = {},
): CaptionLine[] {
  const max = Math.max(1, opts.maxWords ?? CAPTION_MAX_WORDS);
  // Words sit on whole frames, so the pause threshold is rounded to frames too.
  const pause = Math.max(1, Math.round(((opts.pauseMs ?? CAPTION_PAUSE_MS) / 1000) * fps));
  const sorted = [...words].filter((w) => w.text.trim()).sort((a, b) => a.start - b.start);
  // Phrases end at punctuation or a pause; long phrases are then balanced into lines.
  const phrases: CaptionWord[][] = [];
  let current: CaptionWord[] = [];
  sorted.forEach((w, i) => {
    current.push(w);
    const next = sorted[i + 1];
    if (!next || BREAK_AFTER.test(w.text) || next.start - w.end >= pause) {
      phrases.push(current);
      current = [];
    }
  });
  const groups = phrases.flatMap((p) => balance(p, max));
  const hold = Math.round((opts.holdSeconds ?? CAPTION_HOLD_SECONDS) * fps);
  return groups.map((g, i) => {
    const last = g[g.length - 1];
    const next = groups[i + 1];
    const end = Math.max(last.end, Math.min(next ? next[0].start : Infinity, last.end + hold));
    return { words: g, start: g[0].start, end };
  });
}

/** Index of the word being spoken at `frame` within a line: the last word that has started. */
export function activeWordIndex(line: CaptionLine, frame: number): number {
  let active = -1;
  line.words.forEach((w, i) => {
    if (w.start <= frame) active = i;
  });
  return active;
}

/**
 * Words for a clip whose content now begins `delta` frames later and lasts
 * `duration` frames: shifted, clipped to the clip, and dropped when outside it.
 */
export function retimeWords(words: CaptionWord[] | undefined, delta: number, duration: number): CaptionWord[] | undefined {
  if (!words) return undefined;
  const out: CaptionWord[] = [];
  for (const w of words) {
    const start = w.start - delta;
    const end = w.end - delta;
    if (end <= 0 || start >= duration) continue;
    out.push({ text: w.text, start: Math.max(0, start), end: Math.min(duration, end) });
  }
  return out;
}

/** Transcript words heard during a media clip, in frames relative to the clip. */
export function clipWords(clip: Clip, transcript: Pick<Transcript, 'words'>, fps: number): CaptionWord[] {
  const srcIn = clip.in ?? 0;
  const out: CaptionWord[] = [];
  for (const w of transcript.words) {
    const start = Math.round(w.start * fps) - srcIn;
    const end = Math.max(start + 1, Math.round(w.end * fps) - srcIn);
    // Keep a word only if most of it is inside the clip.
    const mid = (start + end) / 2;
    if (mid < 0 || mid >= clip.duration) continue;
    out.push({ text: w.text, start: Math.max(0, start), end: Math.min(clip.duration, end) });
  }
  return out;
}

/**
 * Caption clips for every audible media clip whose asset has a transcript,
 * one per media clip, covering the same range. Overlapping media is resolved
 * by the caller's placement (overwrite).
 */
export function captionClipsFor(
  t: Timeline,
  transcripts: Record<string, Pick<Transcript, 'words'>>,
  make: (range: { start: number; duration: number }, words: CaptionWord[]) => Clip,
): Clip[] {
  const tracks = new Map<string, Track>(t.tracks.map((x) => [x.id, x]));
  const out: Clip[] = [];
  const sources = t.clips
    .filter((c) => (c.kind === 'video' || c.kind === 'audio') && c.assetId && transcripts[c.assetId])
    .filter((c) => {
      const track = tracks.get(c.trackId);
      return track && !track.muted && !track.hidden && (track.volume ?? 1) > 0 && (c.volume ?? 1) > 0;
    })
    .sort((a, b) => a.start - b.start);
  for (const c of sources) {
    const words = clipWords(c, transcripts[c.assetId!], t.fps);
    if (words.length) out.push(make({ start: c.start, duration: clipEnd(c) - c.start }, words));
  }
  return out;
}
