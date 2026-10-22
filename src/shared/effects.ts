// Effect and transition catalogue: labels for the editor and pure maths the
// composition uses. Everything is a function of the frame, so the preview and
// the render match exactly.

import type { Effect, EffectType, GradePreset, TransitionType } from './project';

export const EFFECTS: Record<EffectType, { label: string; defaults: Effect }> = {
  autoColor: { label: 'Auto colour', defaults: { type: 'autoColor', amount: 1 } },
  grade: { label: 'Colour grade', defaults: { type: 'grade', preset: 'tealOrange', amount: 0.8 } },
  grain: { label: 'Film grain', defaults: { type: 'grain', amount: 0.5, seed: 1 } },
  vignette: { label: 'Vignette', defaults: { type: 'vignette', amount: 0.6 } },
  lightLeak: { label: 'Light leak', defaults: { type: 'lightLeak', amount: 0.6, seed: 1 } },
  glitch: { label: 'Glitch', defaults: { type: 'glitch', amount: 0.5, seed: 1 } },
  kenBurns: { label: 'Ken Burns', defaults: { type: 'kenBurns', from: 1, to: 1.15, panX: 0, panY: 0 } },
  zoomPunch: { label: 'Zoom punch', defaults: { type: 'zoomPunch', amount: 0.15 } },
  blur: { label: 'Blur', defaults: { type: 'blur', amount: 0.3 } },
};

export const GRADES: Record<GradePreset, { label: string; matrix: number[]; css: { contrast: number; saturate: number; brightness: number } }> = {
  warm: {
    label: 'Warm',
    matrix: [1.08, 0.04, 0, 0, 0.02, 0, 1, 0.02, 0, 0.01, 0, 0, 0.86, 0, 0, 0, 0, 0, 1, 0],
    css: { contrast: 1.04, saturate: 1.08, brightness: 1 },
  },
  cool: {
    label: 'Cool',
    matrix: [0.9, 0, 0, 0, 0, 0, 1, 0.04, 0, 0.01, 0.02, 0.04, 1.1, 0, 0.03, 0, 0, 0, 1, 0],
    css: { contrast: 1.03, saturate: 0.95, brightness: 1 },
  },
  tealOrange: {
    label: 'Teal & orange',
    matrix: [1.12, 0.05, -0.1, 0, 0.01, -0.02, 1, 0.04, 0, 0, -0.12, 0.08, 1.08, 0, 0.02, 0, 0, 0, 1, 0],
    css: { contrast: 1.08, saturate: 1.15, brightness: 1 },
  },
  mono: {
    label: 'Mono',
    matrix: [0.3, 0.59, 0.11, 0, 0, 0.3, 0.59, 0.11, 0, 0, 0.3, 0.59, 0.11, 0, 0, 0, 0, 0, 1, 0],
    css: { contrast: 1.1, saturate: 1, brightness: 1 },
  },
  noir: {
    label: 'Noir',
    matrix: [0.3, 0.59, 0.11, 0, 0, 0.3, 0.59, 0.11, 0, 0, 0.3, 0.59, 0.11, 0, 0, 0, 0, 0, 1, 0],
    css: { contrast: 1.35, saturate: 1, brightness: 0.95 },
  },
  vintage: {
    label: 'Vintage',
    matrix: [0.9, 0.3, 0.05, 0, 0.04, 0.25, 0.75, 0.05, 0, 0.03, 0.2, 0.25, 0.55, 0, 0.05, 0, 0, 0, 1, 0],
    css: { contrast: 0.92, saturate: 1, brightness: 1.02 },
  },
  faded: {
    label: 'Faded',
    matrix: [0.85, 0.1, 0.05, 0, 0.06, 0.05, 0.85, 0.1, 0, 0.06, 0.05, 0.1, 0.8, 0, 0.08, 0, 0, 0, 1, 0],
    css: { contrast: 0.9, saturate: 0.85, brightness: 1.02 },
  },
  punchy: {
    label: 'Punchy',
    matrix: [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0],
    css: { contrast: 1.2, saturate: 1.35, brightness: 1 },
  },
};

export const TRANSITIONS: Record<TransitionType, string> = {
  fade: 'Crossfade',
  dipBlack: 'Dip to black',
  dipWhite: 'Dip to white',
  slide: 'Slide',
  whip: 'Whip pan',
  wipe: 'Wipe',
  zoom: 'Zoom',
};

const IDENTITY = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];

/** The grade's colour matrix blended toward identity by `amount`. */
export function gradeMatrix(preset: GradePreset, amount = 1): string {
  const m = GRADES[preset]?.matrix ?? IDENTITY;
  return m.map((v, i) => +(IDENTITY[i] + (v - IDENTITY[i]) * amount).toFixed(4)).join(' ');
}

export function gradeCss(preset: GradePreset, amount = 1): string {
  const c = GRADES[preset]?.css;
  if (!c) return '';
  const mix = (v: number) => +(1 + (v - 1) * amount).toFixed(3);
  return `contrast(${mix(c.contrast)}) saturate(${mix(c.saturate)}) brightness(${mix(c.brightness)})`;
}

export const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
export const easeInOut = (t: number) => {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
};
export const easeOutBack = (t: number) => {
  const s = clamp01(t) - 1;
  return 1 + 2.70158 * s ** 3 + 1.70158 * s ** 2;
};

/** Deterministic 0..1 noise from a seed and an integer step. */
export function hash01(seed: number, step: number): number {
  let h = (seed * 374761393 + step * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
