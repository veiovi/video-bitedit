// Visual themes for text and titles. A project picks a theme (doc.theme);
// each text clip starts from the theme's preset and may override any field.
//
// Easing curves: smooth ease-in-out, overshoot "pop", soft spring.

import type { ProjectDoc, TextStyle } from './project';

export type TextAnimation = 'none' | 'fade' | 'rise' | 'pop' | 'typewriter' | 'slam';
export type TextPreset = 'title' | 'caption' | 'lowerThird';

export interface Theme {
  id: string;
  name: string;
  description: string;
  fontFamily: string;
  /** Default project background for this theme. */
  background: string;
  animation: TextAnimation;
  presets: Record<TextPreset, Omit<TextStyle, 'text'>>;
}

const sans = '"Inter Variable", Inter, "Helvetica Neue", Arial, sans-serif';
const condensed = 'Anton, Impact, "Arial Black", sans-serif';
const serif = '"Playfair Display", Georgia, "Times New Roman", serif';

/** Font faces the composition must load before rendering a frame. */
export const TITLE_FONT_FACES = ['700 64px "Inter Variable"', '400 64px Anton', '500 64px "Playfair Display"', '700 64px "Space Mono"'];

// Title styles for text clips (separate from the editor's UI skins).
export const THEMES: Theme[] = [
  {
    id: 'clean',
    name: 'Clean',
    description: 'Minimal white type, soft fades',
    fontFamily: sans,
    background: '#000000',
    animation: 'rise',
    presets: {
      title: { fontSize: 120, color: '#ffffff', background: 'transparent', fontWeight: 700, x: 0.5, y: 0.5 },
      caption: { fontSize: 56, color: '#ffffff', background: 'rgba(0,0,0,0.55)', fontWeight: 600, x: 0.5, y: 0.86, highlight: '#ffd84d' },
      lowerThird: { fontSize: 48, color: '#ffffff', background: 'rgba(20,20,20,0.8)', fontWeight: 600, x: 0.26, y: 0.82 },
    },
  },
  {
    id: 'bold',
    name: 'Bold',
    description: 'Heavy punchy type for social clips',
    fontFamily: condensed,
    background: '#111111',
    animation: 'slam',
    presets: {
      title: { fontSize: 150, color: '#ffe14d', background: 'transparent', fontWeight: 900, x: 0.5, y: 0.5 },
      caption: { fontSize: 64, color: '#111111', background: '#ffe14d', fontWeight: 900, x: 0.5, y: 0.84, highlight: '#e8261c' },
      lowerThird: { fontSize: 52, color: '#ffffff', background: '#ff3b30', fontWeight: 900, x: 0.27, y: 0.82 },
    },
  },
  {
    id: 'cinematic',
    name: 'Cinematic',
    description: 'Elegant serif, slow fades',
    fontFamily: serif,
    background: '#050505',
    animation: 'fade',
    presets: {
      title: { fontSize: 110, color: '#f3ead8', background: 'transparent', fontWeight: 500, x: 0.5, y: 0.5 },
      caption: { fontSize: 50, color: '#f3ead8', background: 'transparent', fontWeight: 400, x: 0.5, y: 0.88, highlight: '#e0b45c' },
      lowerThird: { fontSize: 44, color: '#f3ead8', background: 'rgba(0,0,0,0.6)', fontWeight: 500, x: 0.25, y: 0.83 },
    },
  },
];

export function getTheme(id: string | undefined): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

export function defaultTextStyle(doc: Pick<ProjectDoc, 'theme'>, preset: TextPreset = 'title'): Omit<TextStyle, 'text'> {
  const theme = getTheme(doc.theme);
  return { ...theme.presets[preset], preset, animation: theme.animation };
}

/**
 * Look for caption clips: the theme's caption preset, larger and higher in a
 * vertical frame so lines clear the platform's own buttons and text.
 */
export function captionStyle(doc: Pick<ProjectDoc, 'theme'>, frame: { width: number; height: number }): Omit<TextStyle, 'text'> {
  const base = defaultTextStyle(doc, 'caption');
  const vertical = frame.height > frame.width;
  return {
    ...base,
    animation: 'none',
    highlight: base.highlight ?? '#ffd84d',
    fontSize: Math.round(base.fontSize * (vertical ? 1.4 : 1)),
    y: vertical ? 0.7 : base.y,
  };
}

// ---- Easing ----

const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
/** Smooth ease-in-out (smoothstep of smoothstep). */
export const smooth = (t: number) => {
  const s = clamp01(t);
  const e = s * s * (3 - 2 * s);
  return e * e * (3 - 2 * e);
};
export const easeOutCubic = (t: number) => 1 - (1 - clamp01(t)) ** 3;
/** Overshoots past 1 before settling. */
export const easeOutBack = (t: number) => {
  const s = clamp01(t) - 1;
  const c = 1.70158;
  return 1 + (c + 1) * s ** 3 + c * s ** 2;
};
/** Damped spring settling at 1. */
export const spring = (t: number, damping = 7, frequency = 2.2) => {
  const s = Math.max(0, t);
  return 1 - Math.exp(-damping * s) * Math.cos(2 * Math.PI * frequency * s);
};

export interface TextMotion {
  opacity: number;
  translateY: number;
  scale: number;
  /** Characters revealed for typewriter, or Infinity. */
  chars: number;
}

/** Entrance animation state, `seconds` after the clip starts. */
export function textMotion(animation: TextAnimation | undefined, seconds: number, length: number): TextMotion {
  const d = 0.6;
  const t = seconds / d;
  switch (animation) {
    case 'fade':
      return { opacity: smooth(seconds / 1.2), translateY: 0, scale: 1, chars: Infinity };
    case 'rise':
      return { opacity: smooth(t), translateY: (1 - easeOutCubic(t)) * 0.6, scale: 1, chars: Infinity };
    case 'pop':
      return { opacity: clamp01(t * 2), translateY: 0, scale: 0.6 + 0.4 * easeOutBack(t), chars: Infinity };
    case 'slam':
      return { opacity: clamp01(t * 4), translateY: 0, scale: 1 + 0.6 * (1 - spring(seconds, 9, 2.6)), chars: Infinity };
    case 'typewriter':
      return { opacity: 1, translateY: 0, scale: 1, chars: Math.floor(seconds * 24) >= length ? Infinity : Math.floor(seconds * 24) };
    default:
      return { opacity: 1, translateY: 0, scale: 1, chars: Infinity };
  }
}
