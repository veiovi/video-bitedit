// Animated caption looks. Each look decides, frame by frame, how every word
// of the caption line on screen is drawn: its opacity, scale, lift, colour,
// how much of it is revealed or filled, and whether a box sits behind it.
// Everything is a pure function of the frame, so the preview and the export
// match exactly.

import { type CaptionLine, chunkCaptions } from './captions';
import type { CaptionWord, TextStyle } from './project';
import { easeOutBack, easeOutCubic } from './themes';

export type CaptionLook = 'classic' | 'karaoke' | 'pop' | 'bounce' | 'typewriter' | 'highlight' | 'oneWord';

export const CAPTION_LOOKS: { id: CaptionLook; label: string; description: string }[] = [
  { id: 'classic', label: 'Classic', description: 'The whole line, the spoken word in the accent colour' },
  { id: 'karaoke', label: 'Karaoke', description: 'Words fill with the accent colour as they are spoken' },
  { id: 'pop', label: 'Pop', description: 'Each word scales in as it is spoken' },
  { id: 'bounce', label: 'Bounce', description: 'The spoken word hops up' },
  { id: 'typewriter', label: 'Typewriter', description: 'Letters type on with the speech' },
  { id: 'highlight', label: 'Highlight box', description: 'A box in the accent colour behind the spoken word' },
  { id: 'oneWord', label: 'One word', description: 'One big word at a time' },
];

export type CaptionPosition = 'top' | 'middle' | 'bottom';

export const WORDS_PER_LINE = { min: 1, max: 6, default: 4 } as const;

/**
 * Where a caption line sits (its centre, 0..1 of the frame height) for a
 * position, clear of the buttons and text social apps draw over vertical
 * video and of the edges of a wide frame.
 */
export function captionY(position: CaptionPosition, frame: { width: number; height: number }): number {
  const vertical = frame.height > frame.width;
  if (position === 'middle') return 0.5;
  if (position === 'top') return vertical ? 0.2 : 0.12;
  return vertical ? 0.7 : 0.86;
}

/** The named position nearest a caption's y, for showing which one is chosen. */
export function captionPosition(y: number): CaptionPosition {
  return y < 0.35 ? 'top' : y > 0.62 ? 'bottom' : 'middle';
}

export function wordsPerLine(style: Pick<TextStyle, 'captionLook' | 'wordsPerLine'>): number {
  if (style.captionLook === 'oneWord') return 1;
  const n = Math.round(style.wordsPerLine ?? WORDS_PER_LINE.default);
  return Math.max(WORDS_PER_LINE.min, Math.min(WORDS_PER_LINE.max, n));
}

/** The caption lines of a clip's words, for its look and words-per-line setting. */
export function captionLines(words: CaptionWord[], fps: number, style: Pick<TextStyle, 'captionLook' | 'wordsPerLine'>): CaptionLine[] {
  return chunkCaptions(words, fps, { maxWords: wordsPerLine(style) });
}

export interface WordLook {
  opacity: number;
  scale: number;
  /** Upward lift in em. */
  lift: number;
  /** Draw in the accent colour. */
  accent: boolean;
  /** Karaoke: 0..1 of the word filled with the accent colour, left to right. */
  fill?: number;
  /** Typewriter: characters shown; the rest keep their space. */
  chars?: number;
  /** A box in the accent colour behind the word. */
  box?: boolean;
}

/** Size multiplier for a look's text, relative to the caption's font size. */
export function lookScale(look: CaptionLook | undefined): number {
  return look === 'oneWord' ? 1.7 : 1;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** How each word of `line` draws at `frame` (relative to the caption clip). */
export function wordLooks(look: CaptionLook | undefined, line: CaptionLine, frame: number, fps: number): WordLook[] {
  // The spoken word: the last one that has started.
  let active = -1;
  line.words.forEach((w, i) => {
    if (w.start <= frame) active = i;
  });
  const popFrames = Math.max(1, Math.round(fps * 0.16));
  return line.words.map((w, i) => {
    const spoken = i <= active;
    const isActive = i === active;
    const since = frame - w.start;
    const progress = clamp01((frame - w.start) / Math.max(1, w.end - w.start));
    const base: WordLook = { opacity: 1, scale: 1, lift: 0, accent: false };
    switch (look) {
      case 'karaoke':
        return { ...base, fill: i < active ? 1 : isActive ? progress : 0 };
      case 'pop':
        if (!spoken) return { ...base, opacity: 0 };
        return { ...base, accent: isActive, opacity: clamp01((since + 1) / popFrames), scale: 0.4 + 0.6 * easeOutBack(since / popFrames) };
      case 'bounce': {
        if (!isActive) return base;
        // Up and back down over the first part of the word.
        const hop = clamp01(since / Math.max(2, Math.round(fps * 0.3)));
        return { ...base, accent: true, lift: 0.28 * Math.sin(Math.PI * easeOutCubic(hop)) };
      }
      case 'typewriter': {
        const chars = i < active ? w.text.length : isActive ? Math.max(1, Math.ceil(progress * w.text.length)) : 0;
        return { ...base, chars };
      }
      case 'highlight':
        return { ...base, box: isActive };
      case 'oneWord':
        return { ...base, accent: true, opacity: clamp01((since + 1) / popFrames), scale: 0.7 + 0.3 * easeOutBack(since / popFrames) };
      default:
        return { ...base, accent: isActive, scale: isActive ? 1.05 : 1 };
    }
  });
}

/** Text colour that reads on top of `hex`: near-black on light colours, white on dark ones. */
export function contrastText(hex: string): string {
  const m = hex.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
  if (!m) return '#111111';
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => parseInt(x, 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55 ? '#111111' : '#ffffff';
}
