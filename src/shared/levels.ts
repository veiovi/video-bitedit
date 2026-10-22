// Audio levels from the stored waveform peaks: 50 peaks per second of source,
// each the loudest sample in its 20 ms as 0..255 of full scale. The meters,
// Normalize and the speech detection behind ducking all read levels from
// here, applying the same gain the composition applies (clip volume with its
// keyframes, fades and track volume), so they agree with the preview and the
// export without listening to either.

import { valueAt } from './keyframes';
import { type Clip, type Timeline, clipSpeed, fadeEnvelope } from './project';

export const PEAKS_PER_SECOND = 50;

/** Peaks per asset ID; null or missing while unknown. */
export type PeaksLookup = (assetId: string) => number[] | null | undefined;

/** Linear amplitude to dBFS (−Infinity for silence). */
export function toDb(amplitude: number): number {
  return amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity;
}

/** dBFS to linear amplitude. */
export function fromDb(db: number): number {
  return 10 ** (db / 20);
}

/** "−6.0 dB", "+1.2 dB", "−∞ dB" */
export function dbLabel(amplitude: number): string {
  const db = toDb(amplitude);
  if (db === -Infinity) return '−∞ dB';
  return `${db > 0.05 ? '+' : db < -0.05 ? '−' : ''}${Math.abs(db).toFixed(1)} dB`;
}

/** Whether a clip makes sound in the composition (before track mute). */
export function audible(clip: Clip): boolean {
  if (clip.disabled || !clip.assetId) return false;
  if (clip.kind === 'audio') return true;
  return clip.kind === 'video' && !clip.muted && !clip.freeze;
}

/**
 * The loudest source sample (0..1 of full scale) that a clip plays during
 * frame `rel` (relative to its start), from its peaks.
 */
export function sourcePeakAt(clip: Clip, rel: number, peaks: readonly number[], fps: number): number {
  const speed = clipSpeed(clip);
  if (speed === 0 || peaks.length === 0) return 0;
  const s0 = ((clip.in ?? 0) + rel * speed) / fps;
  const a = Math.max(0, Math.floor(s0 * PEAKS_PER_SECOND + 1e-9));
  const b = Math.max(a + 1, Math.ceil((s0 + speed / fps) * PEAKS_PER_SECOND - 1e-9));
  let max = 0;
  for (let i = a; i < b && i < peaks.length; i++) if (peaks[i] > max) max = peaks[i];
  return max / 255;
}

/** A clip's own gain at frame `rel`: its volume (with keyframes) times its fades. */
export function clipGainAt(clip: Clip, rel: number): number {
  return valueAt(clip, 'volume', rel) * fadeEnvelope(clip, rel);
}

/** A clip's level at frame `rel`, before track volume: source peak × clip gain. */
export function clipLevelAt(clip: Clip, rel: number, peaks: readonly number[], fps: number): number {
  return sourcePeakAt(clip, rel, peaks, fps) * clipGainAt(clip, rel);
}

export interface MixLevels {
  /** Per track (video tracks carry their clips' sound): peak level after track volume, 0 when muted. */
  tracks: Record<string, number>;
  /** The tracks combined by power (root of the summed squares): the mix's peak, estimated. */
  master: number;
}

/**
 * Levels at timeline `frame`, as the composition plays it: muted tracks and
 * hidden video tracks are silent, disabled clips skipped. The master combines
 * the tracks by power, which is how the peaks of unrelated sounds (a voice and
 * a music bed) add up; measured against exports it lands within a dB or two of
 * the mix's sample peak. The same sound on two tracks can reach the plain sum.
 */
export function mixLevels(t: Timeline, frame: number, peaks: PeaksLookup): MixLevels {
  const tracks: Record<string, number> = {};
  let power = 0;
  for (const track of t.tracks) {
    const silent = track.muted || (track.kind === 'video' && track.hidden);
    let level = 0;
    if (!silent) {
      for (const c of t.clips) {
        if (c.trackId !== track.id || frame < c.start || frame >= c.start + c.duration || !audible(c)) continue;
        const p = peaks(c.assetId!);
        if (p) level += clipLevelAt(c, frame - c.start, p, t.fps);
      }
      level *= track.volume ?? 1;
    }
    tracks[track.id] = level;
    power += level * level;
  }
  return { tracks, master: Math.sqrt(power) };
}

/** The loudest source sample (0..1) anywhere in the stretch of source a clip plays. */
export function clipPeak(clip: Clip, peaks: readonly number[], fps: number): number {
  const speed = clipSpeed(clip);
  if (speed === 0 || peaks.length === 0) return 0;
  const s0 = (clip.in ?? 0) / fps;
  const s1 = s0 + (clip.duration * speed) / fps;
  const a = Math.max(0, Math.floor(s0 * PEAKS_PER_SECOND + 1e-9));
  const b = Math.min(peaks.length, Math.max(a + 1, Math.ceil(s1 * PEAKS_PER_SECOND - 1e-9)));
  let max = 0;
  for (let i = a; i < b; i++) if (peaks[i] > max) max = peaks[i];
  return max / 255;
}

/** Where Normalize puts a clip's loudest sample. */
export const NORMALIZE_TARGET_DB = -1;

/**
 * The clip gain that brings a source peak (0..1) to `targetDb`, kept at or
 * under `max` (MAX_VOLUME); null for silence, which no gain can raise.
 */
export function normalizeGain(peak: number, targetDb = NORMALIZE_TARGET_DB, max = 2): number | null {
  if (!(peak > 0)) return null;
  return Math.min(max, fromDb(targetDb) / peak);
}
