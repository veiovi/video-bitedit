import { describe, expect, it } from 'vitest';
import { DUCKING_DEFAULTS, duckingKeys, mergeRanges, speechRanges } from '../src/shared/ducking';
import { valueAt } from '../src/shared/keyframes';
import { clipLevelAt, clipPeak, dbLabel, mixLevels, normalizeGain, sourcePeakAt, toDb } from '../src/shared/levels';
import { type Clip, type Timeline, emptyTimeline } from '../src/shared/project';

const clip = (id: string, extra: Partial<Clip> = {}): Clip => ({ id, kind: 'audio', trackId: 'a1', start: 0, duration: 300, assetId: id, in: 0, ...extra });

/** 50 peaks per second at a constant level, with a louder stretch. */
function peaks(seconds: number, level: number, loud?: { from: number; to: number; level: number }): number[] {
  return Array.from({ length: seconds * 50 }, (_, i) => (loud && i >= loud.from * 50 && i < loud.to * 50 ? loud.level : level));
}

const timeline = (...clips: Clip[]): Timeline => ({ ...emptyTimeline(), clips });

describe('levels from peaks', () => {
  it('reads the source under a frame, following in-point and speed', () => {
    const p = peaks(10, 0, { from: 2, to: 3, level: 255 });
    // 30 fps: frame 60 is second 2.
    expect(sourcePeakAt(clip('a'), 60, p, 30)).toBe(1);
    expect(sourcePeakAt(clip('a'), 59, p, 30)).toBe(0);
    expect(sourcePeakAt(clip('a', { in: 30 }), 30, p, 30)).toBe(1);
    expect(sourcePeakAt(clip('a', { speed: 2 }), 30, p, 30)).toBe(1);
    expect(sourcePeakAt(clip('a', { kind: 'video', freeze: true }), 60, p, 30)).toBe(0);
  });

  it('applies clip volume, keyframes and fades', () => {
    const p = peaks(10, 255);
    expect(clipLevelAt(clip('a', { volume: 0.5 }), 100, p, 30)).toBe(0.5);
    expect(clipLevelAt(clip('a', { fadeIn: 10 }), 5, p, 30)).toBe(0.5);
    const keyed = clip('a', { volume: 2, keyframes: { volume: [{ frame: 0, value: 0 }, { frame: 100, value: 1 }] } });
    expect(clipLevelAt(keyed, 50, p, 30)).toBe(0.5);
  });

  it('mixes tracks with their volume, mutes and hidden video, and sums the master', () => {
    const t = timeline(clip('a', { trackId: 'a1' }), clip('b', { trackId: 'a2' }), clip('v', { kind: 'video', trackId: 'v1' }));
    const lookup = () => peaks(10, 51); // 0.2
    let mix = mixLevels(t, 10, lookup);
    expect(mix.tracks.a1).toBeCloseTo(0.2);
    expect(mix.master).toBeCloseTo(0.6);
    const quiet = { ...t, tracks: t.tracks.map((x) => (x.id === 'a2' ? { ...x, muted: true } : x.id === 'a1' ? { ...x, volume: 0.5 } : x.id === 'v1' ? { ...x, hidden: true } : x)) };
    mix = mixLevels(quiet, 10, lookup);
    expect(mix.tracks.a1).toBeCloseTo(0.1);
    expect(mix.tracks.a2).toBe(0);
    expect(mix.master).toBeCloseTo(0.1);
    // Outside every clip, and with peaks still loading, it is silent.
    expect(mixLevels(t, 500, lookup).master).toBe(0);
    expect(mixLevels(t, 10, () => null).master).toBe(0);
  });

  it('formats dB', () => {
    expect(toDb(1)).toBe(0);
    expect(dbLabel(0.5)).toBe('−6.0 dB');
    expect(dbLabel(2)).toBe('+6.0 dB');
    expect(dbLabel(0)).toBe('−∞ dB');
  });
});

describe('normalize', () => {
  it('finds the loudest peak in the part of the source a clip plays', () => {
    const p = peaks(20, 50, { from: 15, to: 16, level: 200 });
    expect(clipPeak(clip('a', { duration: 300 }), p, 30)).toBeCloseTo(50 / 255);
    expect(clipPeak(clip('a', { duration: 300, speed: 2 }), p, 30)).toBeCloseTo(200 / 255);
    expect(clipPeak(clip('a', { in: 450, duration: 30 }), p, 30)).toBeCloseTo(200 / 255);
  });

  it('brings the peak to −1 dBFS, capped at the maximum gain', () => {
    expect(toDb(0.5 * normalizeGain(0.5)!)).toBeCloseTo(-1);
    expect(normalizeGain(0.01)).toBe(2);
    expect(normalizeGain(0)).toBeNull();
    expect(toDb(0.4 * normalizeGain(0.4, -6)!)).toBeCloseTo(-6);
  });
});

describe('ducking', () => {
  it('merges ranges that overlap or sit within the gap', () => {
    expect(mergeRanges([{ start: 50, end: 60 }, { start: 0, end: 10 }, { start: 15, end: 20 }], 6)).toEqual([
      { start: 0, end: 20 },
      { start: 50, end: 60 },
    ]);
  });

  it('dips by the depth from attack before speech to release after it', () => {
    const music = clip('m', { trackId: 'a2', volume: 0.8 });
    const keys = duckingKeys([music], [{ start: 100, end: 160 }])['m'];
    expect(keys.map((k) => k.frame)).toEqual([100 - DUCKING_DEFAULTS.attack, 100, 160, 160 + DUCKING_DEFAULTS.release]);
    expect(toDb(keys[1].value / 0.8)).toBeCloseTo(-12, 1);
    const c = { ...music, keyframes: { volume: keys } };
    expect(valueAt(c, 'volume', 50)).toBe(0.8);
    expect(valueAt(c, 'volume', 130)).toBeCloseTo(0.2);
    expect(valueAt(c, 'volume', 97)).toBeCloseTo(0.5);
  });

  it('keeps short pauses ducked and takes options', () => {
    const keys = duckingKeys([clip('m')], [{ start: 100, end: 120 }, { start: 130, end: 150 }], { depth: -6, attack: 2, release: 4, minGap: 15 })['m'];
    expect(keys.map((k) => k.frame)).toEqual([98, 100, 150, 154]);
    expect(toDb(keys[1].value)).toBeCloseTo(-6, 1);
    const apart = duckingKeys([clip('m')], [{ start: 100, end: 120 }, { start: 200, end: 220 }], { attack: 2, release: 4, minGap: 15 })['m'];
    expect(apart).toHaveLength(8);
  });

  it('works in clip time and cuts keys to clips the speech crosses', () => {
    const keys = duckingKeys([clip('m', { start: 110, duration: 100 })], [{ start: 100, end: 150 }])['m'];
    expect(keys[0].frame).toBe(0);
    expect(keys.map((k) => k.frame)).toEqual([0, 40, 52]);
    expect(duckingKeys([clip('m', { start: 400, duration: 100 })], [{ start: 100, end: 150 }])).toEqual({});
  });

  it('finds speech from transcripts first, then from loud peaks, on other audible tracks', () => {
    const voice = clip('voice', { trackId: 'a1', start: 30, duration: 300 });
    const vid = clip('vid', { kind: 'video', trackId: 'v1', start: 0, duration: 300 });
    const music = clip('music', { trackId: 'a2' });
    const t = timeline(voice, vid, music);
    const lookup = (id: string) => (id === 'vid' ? peaks(10, 2, { from: 4, to: 5, level: 120 }) : peaks(10, 255));
    const ranges = speechRanges(t, 'a2', { peaks: lookup, transcripts: { voice: { words: [{ text: 'hi', start: 1, end: 2 }] } } });
    expect(ranges).toEqual([
      { start: 60, end: 90 },
      { start: 120, end: 150 },
    ]);
    // The music track is never its own speech; muted tracks and quiet clips are not speech.
    const muted = { ...t, tracks: t.tracks.map((x) => (x.id === 'a1' ? { ...x, muted: true } : x)) };
    expect(speechRanges(muted, 'a2', { peaks: lookup })).toEqual([{ start: 120, end: 150 }]);
  });
});
