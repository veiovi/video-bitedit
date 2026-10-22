import { describe, expect, it } from 'vitest';
import { activeWordIndex, captionClipsFor, chunkCaptions, clipWords, retimeWords } from '../src/shared/captions';
import type { CaptionWord, Clip } from '../src/shared/project';
import { emptyTimeline } from '../src/shared/project';
import { cleanWords, parseWhisperCppJson, parseWhisperJson } from '../src/node/transcribe';

/** Words at 30 fps, each `len` frames long with `gap` frames between them unless given. */
function words(spec: string, len = 6, gap = 1): CaptionWord[] {
  let at = 0;
  return spec.split(' ').map((text) => {
    const w = { text, start: at, end: at + len };
    at += len + gap;
    return w;
  });
}

const texts = (lines: { words: CaptionWord[] }[]) => lines.map((l) => l.words.map((w) => w.text).join(' '));

describe('caption chunking', () => {
  it('makes lines of at most four words, balancing long phrases', () => {
    expect(texts(chunkCaptions(words('one two three four five six seven'), 30))).toEqual(['one two three four', 'five six seven']);
    expect(texts(chunkCaptions(words('one two three four five'), 30))).toEqual(['one two three', 'four five']);
    expect(texts(chunkCaptions(words('one two three four five six'), 30))).toEqual(['one two three', 'four five six']);
  });

  it('breaks after punctuation', () => {
    expect(texts(chunkCaptions(words('So, here we go. Ready?'), 30))).toEqual(['So,', 'here we go.', 'Ready?']);
  });

  it('breaks at pauses of 140 ms or more', () => {
    const at = (text: string, start: number) => ({ text, start, end: start + 6 });
    // 4 frames at 30 fps (133 ms) rounds to the 140 ms threshold; 3 frames (100 ms) does not.
    const paused = [at('a', 0), at('b', 10), at('c', 17), at('d', 24)];
    expect(texts(chunkCaptions(paused, 30))).toEqual(['a', 'b c d']);
    const brief = [at('a', 0), at('b', 9)];
    expect(texts(chunkCaptions(brief, 30))).toEqual(['a b']);
  });

  it('holds a line until the next one starts, or briefly after its last word', () => {
    const lines = chunkCaptions(
      [
        { text: 'Hello.', start: 0, end: 10 },
        { text: 'Again', start: 14, end: 20 },
        { text: 'later.', start: 21, end: 30 },
        { text: 'Bye', start: 200, end: 210 },
      ],
      30,
    );
    expect(lines.map((l) => [l.start, l.end])).toEqual([
      [0, 14],
      [14, 48],
      [200, 228],
    ]);
  });

  it('highlights the last word that has started', () => {
    const [line] = chunkCaptions(words('one two three'), 30);
    expect([0, 6, 7, 13, 14, 40].map((f) => activeWordIndex(line, f))).toEqual([0, 0, 1, 1, 2, 2]);
  });
});

describe('caption timing', () => {
  it('retimes words when a clip head is trimmed and drops words outside', () => {
    expect(retimeWords(words('a b c'), 7, 8)).toEqual([
      { text: 'b', start: 0, end: 6 },
      { text: 'c', start: 7, end: 8 },
    ]);
  });

  it('maps transcript seconds into a media clip by its source in-point', () => {
    const clip: Clip = { id: 'c', kind: 'video', trackId: 'v1', start: 100, duration: 60, assetId: 'x', in: 30 };
    const t = {
      words: [
        { text: 'before', start: 0.5, end: 0.9 },
        { text: 'edge', start: 0.95, end: 1.2 },
        { text: 'inside', start: 2, end: 2.5 },
        { text: 'after', start: 3, end: 3.4 },
      ],
    };
    expect(clipWords(clip, t, 30)).toEqual([
      { text: 'edge', start: 0, end: 6 },
      { text: 'inside', start: 30, end: 45 },
    ]);
  });

  it('captions audible clips that have transcripts, one caption clip per media clip', () => {
    const t = emptyTimeline();
    t.clips = [
      { id: 'a', kind: 'video', trackId: 'v1', start: 0, duration: 60, assetId: 'talk', in: 0 },
      { id: 'b', kind: 'video', trackId: 'v1', start: 60, duration: 60, assetId: 'talk', in: 300 },
      { id: 'm', kind: 'video', trackId: 'v2', start: 0, duration: 60, assetId: 'talk', in: 0, volume: 0 },
      { id: 'n', kind: 'audio', trackId: 'a1', start: 0, duration: 60, assetId: 'music', in: 0 },
    ];
    const transcripts = {
      talk: {
        words: [
          { text: 'first', start: 0.2, end: 0.6 },
          { text: 'second', start: 10.5, end: 11 },
        ],
      },
    };
    const made = captionClipsFor(t, transcripts, (range, w) => ({ id: 'x', kind: 'caption', trackId: 'v3', ...range, words: w }));
    expect(made.map((c) => [c.start, c.duration, c.words!.map((w) => w.text)])).toEqual([
      [0, 60, ['first']],
      [60, 60, ['second']],
    ]);
  });
});

describe('transcript parsing', () => {
  it('reads OpenAI whisper word timestamps', () => {
    const json = JSON.stringify({
      language: 'en',
      segments: [{ words: [{ word: ' Hello', start: 0.1, end: 0.4 }, { word: ' world.', start: 0.5, end: 0.9 }] }],
    });
    expect(parseWhisperJson(json)).toEqual({
      language: 'en',
      words: [
        { text: 'Hello', start: 0.1, end: 0.4 },
        { text: 'world.', start: 0.5, end: 0.9 },
      ],
    });
  });

  it('reads whisper.cpp word segments and skips non-speech tags', () => {
    const json = JSON.stringify({
      result: { language: 'en' },
      transcription: [
        { text: '[BLANK_AUDIO]', offsets: { from: 0, to: 500 } },
        { text: ' Hi', offsets: { from: 500, to: 800 } },
        { text: ' there', offsets: { from: 800, to: 1100 } },
        { text: '!', offsets: { from: 1100, to: 1150 } },
      ],
    });
    expect(parseWhisperCppJson(json).words).toEqual([
      { text: 'Hi', start: 0.5, end: 0.8 },
      { text: 'there!', start: 0.8, end: 1.15 },
    ]);
  });

  it('drops empty words and repairs reversed timings', () => {
    expect(cleanWords([{ text: ' ', start: 0, end: 1 }, { text: 'x', start: 2, end: 1 }])).toEqual([{ text: 'x', start: 2, end: 2.01 }]);
  });
});
