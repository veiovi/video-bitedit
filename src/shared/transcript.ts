// The transcript of a timeline, for editing video by editing text.
//
// Words come from the transcripts of the media clips that can be heard,
// mapped through each clip's start and in-point to timeline frames, plus the
// words of caption clips over stretches with no such media. Speech a cut has
// removed (the source between two neighbouring clips of the same file) shows
// as a struck-through run at the cut, so it can be put back.

import type { Transcript } from './captions';
import { clipWords } from './captions';
import { type Clip, type Timeline, clipEnd } from './project';

export interface TranscriptWordItem {
  type: 'word';
  text: string;
  /** Timeline frames. */
  start: number;
  end: number;
  /** The clip the word is heard in (a media clip, or a caption clip). */
  clipId: string;
}

export interface TranscriptCutItem {
  type: 'cut';
  /** Words that were cut, in the order they were spoken. */
  words: string[];
  /** Timeline frame where the cut closed. */
  at: number;
  /** Frames of source the cut removed. */
  frames: number;
  /** Clips ending at the cut that would play on into the removed source. */
  clipIds: string[];
}

export type TranscriptItem = TranscriptWordItem | TranscriptCutItem;

export interface TranscriptParagraph {
  items: TranscriptItem[];
}

/** A pause longer than this starts a new paragraph. */
export const PARAGRAPH_PAUSE_SECONDS = 1;

/** Media clips with a transcript, in timeline order. */
function transcribedMedia(t: Timeline, transcripts: Record<string, Pick<Transcript, 'words'>>): Clip[] {
  return t.clips
    .filter((c) => (c.kind === 'video' || c.kind === 'audio') && c.assetId && transcripts[c.assetId] && !c.disabled)
    .sort((a, b) => a.start - b.start);
}

/** Whether a clip's sound plays in the preview and export. */
function audible(t: Timeline, c: Clip): boolean {
  const track = t.tracks.find((x) => x.id === c.trackId);
  return Boolean(track && !track.muted && !track.hidden && !c.muted && (c.volume ?? 1) > 0 && (track.volume ?? 1) > 0);
}

/**
 * Every word heard on the timeline in order, with struck-through runs where
 * cuts removed speech, grouped into paragraphs at pauses.
 */
export function timelineTranscript(
  t: Timeline,
  transcripts: Record<string, Pick<Transcript, 'words'>>,
  opts: { pauseSeconds?: number } = {},
): TranscriptParagraph[] {
  const all = transcribedMedia(t, transcripts);
  const media = all.filter((c) => audible(t, c));
  const words: TranscriptWordItem[] = [];
  const seen = new Set<string>();
  const push = (w: TranscriptWordItem) => {
    // A video and its detached audio carry the same words.
    const key = `${w.start}:${w.text}`;
    if (seen.has(key)) return;
    seen.add(key);
    words.push(w);
  };
  for (const c of media) {
    for (const w of clipWords(c, transcripts[c.assetId!], t.fps)) {
      push({ type: 'word', text: w.text, start: c.start + w.start, end: c.start + w.end, clipId: c.id });
    }
  }
  // Caption clips fill in where no transcribed media plays.
  for (const c of t.clips) {
    if (c.kind !== 'caption' || c.disabled || !c.words?.length) continue;
    if (media.some((m) => m.start < clipEnd(c) && clipEnd(m) > c.start)) continue;
    for (const w of c.words) push({ type: 'word', text: w.text, start: c.start + w.start, end: c.start + w.end, clipId: c.id });
  }

  // Cuts: neighbouring clips of one file, where the second starts later in the
  // source. A muted video counts too, so putting the speech back also puts
  // back the picture that goes with its detached sound.
  const cuts = new Map<string, TranscriptCutItem & { heard: boolean }>();
  for (const a of all) {
    const b = all.find((x) => x.trackId === a.trackId && x.assetId === a.assetId && x.start === clipEnd(a));
    if (!b) continue;
    const from = (a.in ?? 0) + a.duration;
    const to = b.in ?? 0;
    if (to <= from) continue;
    const removed = transcripts[a.assetId!].words.filter((w) => {
      const mid = ((w.start + w.end) / 2) * t.fps;
      return mid >= from && mid < to;
    });
    if (removed.length === 0) continue;
    const key = `${b.start}:${a.assetId}:${from}:${to}`;
    const heard = audible(t, a) || audible(t, b);
    const known = cuts.get(key);
    if (known) {
      known.clipIds.push(a.id);
      known.heard ||= heard;
    } else cuts.set(key, { type: 'cut', words: removed.map((w) => w.text), at: b.start, frames: to - from, clipIds: [a.id], heard });
  }
  const heardCuts: TranscriptCutItem[] = [...cuts.values()].filter((c) => c.heard).map(({ heard: _h, ...c }) => c);

  const items: TranscriptItem[] = [...words, ...heardCuts].sort((x, y) => {
    const fx = x.type === 'word' ? x.start : x.at;
    const fy = y.type === 'word' ? y.start : y.at;
    // A cut sits before the first word that follows it.
    return fx - fy || (x.type === 'cut' ? -1 : 0) - (y.type === 'cut' ? -1 : 0);
  });

  const pause = Math.round((opts.pauseSeconds ?? PARAGRAPH_PAUSE_SECONDS) * t.fps);
  const paragraphs: TranscriptParagraph[] = [];
  let current: TranscriptItem[] = [];
  let lastEnd: number | null = null;
  for (const item of items) {
    if (item.type === 'word') {
      if (lastEnd !== null && item.start - lastEnd > pause && current.length) {
        paragraphs.push({ items: current });
        current = [];
      }
      lastEnd = Math.max(lastEnd ?? 0, item.end);
    }
    current.push(item);
  }
  if (current.length) paragraphs.push({ items: current });
  return paragraphs;
}

/** The frames a run of words covers: from the first word's start to the last word's end. */
export function wordsRange(words: Pick<TranscriptWordItem, 'start' | 'end'>[]): { start: number; end: number } | null {
  if (words.length === 0) return null;
  return { start: Math.min(...words.map((w) => w.start)), end: Math.max(...words.map((w) => w.end)) };
}

/** Index of the word being spoken at `frame`: the last word that has started and not long ended. */
export function wordAt(words: Pick<TranscriptWordItem, 'start' | 'end'>[], frame: number): number {
  let found = -1;
  for (let i = 0; i < words.length; i++) {
    if (words[i].start > frame) break;
    if (frame < words[i].end || (i + 1 < words.length && frame < words[i + 1].start)) found = i;
  }
  return found;
}
