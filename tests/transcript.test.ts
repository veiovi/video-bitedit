import { describe, expect, it } from 'vitest';
import { CAPTION_LOOKS, captionLines, captionPosition, captionY, contrastText, wordLooks, wordsPerLine } from '../src/shared/captionLooks';
import { addClip, cutRange, detachAudio, updateTrack } from '../src/shared/edits';
import { type Clip, type Timeline, emptyTimeline, filmstripFrame, filmstripPlan, isFilmstrip } from '../src/shared/project';
import { type TranscriptCutItem, type TranscriptWordItem, timelineTranscript, wordAt, wordsRange } from '../src/shared/transcript';

const fps = 30;
// One word per second of source: "w0" at 0–0.5 s, "w1" at 1–1.5 s, …
const words = Array.from({ length: 20 }, (_, i) => ({ text: `w${i}`, start: i, end: i + 0.5 }));
const transcripts = { a: { words } };

function clip(id: string, start: number, duration: number, extra: Partial<Clip> = {}): Clip {
  return { id, kind: 'video', trackId: 'v1', start, duration, assetId: 'a', in: 0, ...extra };
}

const withClips = (...clips: Clip[]): Timeline => clips.reduce((t, c) => addClip(t, c), emptyTimeline());
const flat = (t: Timeline) => timelineTranscript(t, transcripts).flatMap((p) => p.items);
const texts = (t: Timeline) => flat(t).map((i) => (i.type === 'word' ? i.text : `~${i.words.join(' ')}~`));

describe('timeline transcript', () => {
  it('maps source words to timeline frames through start and in-point', () => {
    const t = withClips(clip('x', 60, 90, { in: 150 }));
    const items = flat(t) as TranscriptWordItem[];
    expect(items.map((w) => [w.text, w.start, w.end])).toEqual([
      ['w5', 60, 75],
      ['w6', 90, 105],
      ['w7', 120, 135],
    ]);
  });

  it('shows the words a cut removed as a struck run at the cut', () => {
    const t = cutRange(withClips(clip('x', 0, 300)), 60, 120);
    expect(texts(t)).toEqual(['w0', 'w1', '~w2 w3~', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9']);
    const cut = flat(t).find((i) => i.type === 'cut') as TranscriptCutItem;
    expect(cut).toMatchObject({ at: 60, frames: 60, clipIds: [t.clips[0].id] });
  });

  it('follows clip speed for words and cuts', () => {
    // At 2× the clip plays source frames 0–300 in 150 timeline frames: one word every 15 frames.
    const t = cutRange(withClips(clip('x', 0, 150, { speed: 2 })), 30, 60);
    expect(texts(t)).toEqual(['w0', 'w1', '~w2 w3~', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9']);
    const cut = flat(t).find((i) => i.type === 'cut') as TranscriptCutItem;
    // The cut removed 60 source frames, which is 30 frames on the timeline at 2×.
    expect(cut).toMatchObject({ at: 30, frames: 30 });
  });

  it('counts a video and its detached audio once', () => {
    let t = cutRange(withClips(clip('x', 0, 150)), 30, 60);
    t = detachAudio(t, t.clips.map((c) => c.id));
    expect(texts(t)).toEqual(['w0', '~w1~', 'w2', 'w3', 'w4']);
    const cut = flat(t).find((i) => i.type === 'cut') as TranscriptCutItem;
    // Restoring must lengthen the audio clip too.
    expect(cut.clipIds).toHaveLength(2);
  });

  it('skips media that cannot be heard', () => {
    const t = updateTrack(withClips(clip('x', 0, 90)), 'v1', { muted: true });
    expect(flat(t)).toEqual([]);
  });

  it('uses caption words where no transcribed media plays', () => {
    const t = withClips({ id: 'c', kind: 'caption', trackId: 'v2', start: 300, duration: 60, words: [{ text: 'hello', start: 0, end: 10 }] });
    expect(flat(t)).toMatchObject([{ text: 'hello', start: 300, end: 310, clipId: 'c' }]);
    // Over transcribed media, the media's words win.
    const both = addClip(t, clip('x', 300, 60));
    expect(texts(both)).toEqual(['w0', 'w1']);
  });

  it('starts a paragraph after a pause of more than a second', () => {
    const t = withClips(clip('x', 0, 60), clip('y', 200, 30, { in: 0 }));
    expect(timelineTranscript(t, transcripts).map((p) => p.items.length)).toEqual([2, 1]);
  });

  it('finds the range of a run of words and the word at a frame', () => {
    const ws = [
      { start: 0, end: 10 },
      { start: 20, end: 30 },
    ];
    expect(wordsRange(ws)).toEqual({ start: 0, end: 30 });
    expect(wordsRange([])).toBeNull();
    expect(wordAt(ws, 5)).toBe(0);
    expect(wordAt(ws, 15)).toBe(0);
    expect(wordAt(ws, 25)).toBe(1);
    expect(wordAt(ws, 40)).toBe(-1);
  });
});

describe('caption looks', () => {
  const line = { start: 0, end: 60, words: [
    { text: 'one', start: 0, end: 10 },
    { text: 'two', start: 20, end: 30 },
    { text: 'three', start: 40, end: 50 },
  ] };

  it('has at least the six animated looks plus classic', () => {
    expect(CAPTION_LOOKS.map((l) => l.id)).toEqual(['classic', 'karaoke', 'pop', 'bounce', 'typewriter', 'highlight', 'oneWord']);
  });

  it('karaoke fills spoken words and part of the current one', () => {
    expect(wordLooks('karaoke', line, 25, fps).map((w) => w.fill)).toEqual([1, 0.5, 0]);
  });

  it('pop hides words not yet spoken and scales the new one in', () => {
    const looks = wordLooks('pop', line, 21, fps);
    expect(looks[2].opacity).toBe(0);
    expect(looks[1].scale).toBeLessThan(1);
    expect(wordLooks('pop', line, 35, fps)[1].scale).toBeCloseTo(1);
  });

  it('typewriter reveals letters with the speech', () => {
    expect(wordLooks('typewriter', line, 45, fps).map((w) => w.chars)).toEqual([3, 3, 3]);
    expect(wordLooks('typewriter', line, 20, fps).map((w) => w.chars)).toEqual([3, 1, 0]);
  });

  it('highlight boxes and bounce lifts only the spoken word', () => {
    expect(wordLooks('highlight', line, 22, fps).map((w) => Boolean(w.box))).toEqual([false, true, false]);
    const bounce = wordLooks('bounce', line, 24, fps);
    expect(bounce[1].lift).toBeGreaterThan(0);
    expect(bounce[0].lift).toBe(0);
  });

  it('is a pure function of the frame', () => {
    for (const look of CAPTION_LOOKS) expect(wordLooks(look.id, line, 23, fps)).toEqual(wordLooks(look.id, line, 23, fps));
  });

  it('breaks lines by words per line, one word for the one-word look', () => {
    const ws = Array.from({ length: 6 }, (_, i) => ({ text: `w${i}`, start: i * 5, end: i * 5 + 4 }));
    expect(captionLines(ws, fps, { wordsPerLine: 2 }).map((l) => l.words.length)).toEqual([2, 2, 2]);
    expect(captionLines(ws, fps, { captionLook: 'oneWord', wordsPerLine: 4 }).map((l) => l.words.length)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(wordsPerLine({ wordsPerLine: 12 })).toBe(6);
    expect(wordsPerLine({})).toBe(4);
  });

  it('places captions inside the safe area for the frame shape', () => {
    const vertical = { width: 1080, height: 1920 };
    const wide = { width: 1920, height: 1080 };
    expect(captionY('bottom', vertical)).toBeLessThan(captionY('bottom', wide));
    expect(captionY('top', vertical)).toBeGreaterThan(captionY('top', wide));
    for (const p of ['top', 'middle', 'bottom'] as const) expect(captionPosition(captionY(p, vertical))).toBe(p);
  });

  it('picks readable text over an accent colour', () => {
    expect(contrastText('#ffd84d')).toBe('#111111');
    expect(contrastText('#1a1a8c')).toBe('#ffffff');
  });
});

describe('filmstrip', () => {
  it('samples every 2 s, up to 60 frames', () => {
    expect(filmstripPlan(18)).toEqual({ frames: 9, every: 2 });
    expect(filmstripPlan(0.5)).toEqual({ frames: 1, every: 2 });
    const long = filmstripPlan(600);
    expect(long.frames).toBe(60);
    expect(long.every * long.frames).toBeGreaterThanOrEqual(600);
  });

  it('maps source seconds to a sprite frame', () => {
    const strip = { frames: 9, every: 2 };
    expect(filmstripFrame(strip, 0)).toBe(0);
    expect(filmstripFrame(strip, 3.9)).toBe(1);
    expect(filmstripFrame(strip, 100)).toBe(8);
  });

  it('checks filmstrip metadata', () => {
    expect(isFilmstrip({ frames: 9, every: 2, width: 160, height: 90 })).toBe(true);
    expect(isFilmstrip({ frames: 9, every: 2, width: 160 })).toBe(false);
    expect(isFilmstrip({ frames: 600, every: 2, width: 160, height: 90 })).toBe(false);
  });
});
