// Auto-ducking: lower music while someone speaks. Speech is found on the
// other tracks, from transcript words where an asset has a transcript and
// from waveform peaks otherwise. The result is ordinary volume keyframes on
// the music clips (tagged `duck`), so it can be tweaked by hand afterwards.

import { clipWords, type Transcript } from './captions';
import { cropKeys } from './keyframes';
import { type PeaksLookup, audible, clipLevelAt, fromDb } from './levels';
import type { Clip, Keyframe, Timeline } from './project';

/** Timeline frames [start, end) where speech plays. */
export interface SpeechRange {
  start: number;
  end: number;
}

export interface DuckingOptions {
  /** How far the music dips, in dB (negative). */
  depth: number;
  /** Frames the music takes to dip before speech starts. */
  attack: number;
  /** Frames it takes to come back up after speech ends. */
  release: number;
  /** Pauses shorter than this stay ducked instead of swelling up between phrases. */
  minGap: number;
}

export const DUCKING_DEFAULTS: DuckingOptions = { depth: -12, attack: 6, release: 12, minGap: 15 };

export const DUCKING_LIMITS = {
  depth: { min: -24, max: -6 },
  attack: { min: 1, max: 30 },
  release: { min: 1, max: 60 },
} as const;

/** Peaks above this (−26 dBFS), after the clip's gain, count as speech. */
export const SPEECH_THRESHOLD = 0.05;

/** Sort ranges and merge any that overlap or sit closer than `gap` frames. */
export function mergeRanges(ranges: readonly SpeechRange[], gap = 0): SpeechRange[] {
  const sorted = ranges.filter((r) => r.end > r.start).map((r) => ({ ...r })).sort((a, b) => a.start - b.start);
  const out: SpeechRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start - last.end < gap) last.end = Math.max(last.end, r.end);
    else out.push(r);
  }
  return out;
}

/**
 * Where speech plays on a timeline, leaving out `exceptTrack` (the music).
 * Sources are audible clips on unmuted tracks (video tracks not hidden).
 * Clips whose asset has a transcript use its word timings; the rest use their
 * peaks: frames whose level, after the clip's gain, rises above `threshold`.
 */
export function speechRanges(
  t: Timeline,
  exceptTrack: string,
  sources: { peaks: PeaksLookup; transcripts?: Record<string, Pick<Transcript, 'words'> | null | undefined> },
  threshold = SPEECH_THRESHOLD,
): SpeechRange[] {
  const tracks = new Map(t.tracks.map((x) => [x.id, x]));
  const ranges: SpeechRange[] = [];
  for (const c of t.clips) {
    const track = tracks.get(c.trackId);
    if (!track || track.id === exceptTrack || track.muted || (track.kind === 'video' && track.hidden) || !audible(c)) continue;
    if ((track.volume ?? 1) <= 0) continue;
    const transcript = sources.transcripts?.[c.assetId!];
    if (transcript) {
      for (const w of clipWords(c, transcript, t.fps)) ranges.push({ start: c.start + w.start, end: c.start + w.end });
      continue;
    }
    const peaks = sources.peaks(c.assetId!);
    if (!peaks?.length) continue;
    let from = -1;
    for (let f = 0; f <= c.duration; f++) {
      const loud = f < c.duration && clipLevelAt(c, f, peaks, t.fps) * (track.volume ?? 1) > threshold;
      if (loud && from < 0) from = f;
      if (!loud && from >= 0) {
        ranges.push({ start: c.start + from, end: c.start + f });
        from = -1;
      }
    }
  }
  return mergeRanges(ranges);
}

/**
 * Volume keys that duck each music clip under the speech ranges, in frames
 * relative to the clip and tagged `duck`. The music sits at its own volume
 * and dips by `depth` dB from `attack` frames before each phrase until
 * `release` frames after it; phrases closer than `minGap` (or than the ramps
 * need) share one dip. Clips the speech never reaches get no keys.
 */
export function duckingKeys(musicClips: readonly Clip[], speech: readonly SpeechRange[], options: Partial<DuckingOptions> = {}): Record<string, Keyframe[]> {
  const o = { ...DUCKING_DEFAULTS, ...options };
  const attack = Math.max(1, Math.round(o.attack));
  const release = Math.max(1, Math.round(o.release));
  const phrases = mergeRanges(speech, Math.max(Math.round(o.minGap), attack + release));
  const out: Record<string, Keyframe[]> = {};
  for (const clip of musicClips) {
    const base = clip.volume ?? 1;
    const low = Math.round(base * fromDb(Math.min(0, o.depth)) * 1000) / 1000;
    const end = clip.start + clip.duration;
    const near = phrases.filter((p) => p.end + release > clip.start && p.start - attack < end);
    if (near.length === 0) continue;
    const keys: Keyframe[] = near.flatMap((p) => [
      { frame: p.start - attack - clip.start, value: base, duck: true as const },
      { frame: p.start - clip.start, value: low, duck: true as const },
      { frame: p.end - clip.start, value: low, duck: true as const },
      { frame: p.end + release - clip.start, value: base, duck: true as const },
    ]);
    const cropped = cropKeys(keys, clip.duration);
    if (cropped.some((k) => k.value !== base)) out[clip.id] = cropped;
  }
  return out;
}
