// Keyframe animation for clip properties: opacity, scale, position, rotation
// and volume. A clip keeps, per property, a list of keys in frames relative to
// its start; between two keys the value follows the first key's ease, and
// before the first or after the last key it holds that key's value.
//
// Plain arithmetic only, so the same code runs in the composition (preview
// and export), in the editor and in tests.

import type { Clip, ClipKind, Keyframe, KeyframeEase, KeyframeProp, Keyframes } from './project';

export const KEYFRAME_PROPS: readonly KeyframeProp[] = ['opacity', 'scale', 'offsetX', 'offsetY', 'rotation', 'volume'];

export const KEYFRAME_EASES: readonly { id: KeyframeEase; label: string }[] = [
  { id: 'linear', label: 'Linear' },
  { id: 'easeIn', label: 'Ease in' },
  { id: 'easeOut', label: 'Ease out' },
  { id: 'easeInOut', label: 'Ease in-out' },
  { id: 'hold', label: 'Hold' },
];

/** The value a property has when the clip leaves it unset. */
export const PROP_DEFAULTS: Record<KeyframeProp, number> = { opacity: 1, scale: 1, offsetX: 0, offsetY: 0, rotation: 0, volume: 1 };

/** Allowed range of each property's keys. Volume tops out at MAX_VOLUME (2 = 200%). */
export const PROP_LIMITS: Record<KeyframeProp, { min: number; max: number }> = {
  opacity: { min: 0, max: 1 },
  scale: { min: 0.01, max: 10 },
  offsetX: { min: -2, max: 2 },
  offsetY: { min: -2, max: 2 },
  rotation: { min: -3600, max: 3600 },
  volume: { min: 0, max: 2 },
};

export const PROP_LABELS: Record<KeyframeProp, string> = {
  opacity: 'Opacity',
  scale: 'Scale',
  offsetX: 'Position X',
  offsetY: 'Position Y',
  rotation: 'Rotation',
  volume: 'Volume',
};

/** Which properties a clip of this kind can animate (what the composition draws for it). */
export function animatableProps(clip: Pick<Clip, 'kind' | 'freeze'>): KeyframeProp[] {
  switch (clip.kind as ClipKind) {
    case 'audio':
      return ['volume'];
    case 'video':
      return clip.freeze ? ['opacity', 'scale', 'offsetX', 'offsetY', 'rotation'] : [...KEYFRAME_PROPS];
    case 'image':
      return ['opacity', 'scale', 'offsetX', 'offsetY', 'rotation'];
    case 'text':
    case 'caption':
      return ['opacity', 'scale', 'rotation'];
    default:
      return [];
  }
}

/** Progress 0..1 through a span shaped by `ease`; cubic curves for the eased shapes. */
export function easeProgress(ease: KeyframeEase | undefined, t: number): number {
  const x = Math.max(0, Math.min(1, t));
  switch (ease) {
    case 'hold':
      return 0;
    case 'easeIn':
      return x * x * x;
    case 'easeOut':
      return 1 - (1 - x) ** 3;
    case 'easeInOut':
      return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
    default:
      return x;
  }
}

/** The value of a sorted key list at `frame` (relative to the clip), or `fallback` with no keys. */
export function curveAt(keys: readonly Keyframe[] | undefined, frame: number, fallback: number): number {
  if (!keys || keys.length === 0) return fallback;
  if (frame <= keys[0].frame) return keys[0].value;
  const last = keys[keys.length - 1];
  if (frame >= last.frame) return last.value;
  // Keys are few; a linear scan is fast and simple.
  let i = 0;
  while (keys[i + 1].frame <= frame) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const p = easeProgress(a.ease, (frame - a.frame) / (b.frame - a.frame));
  return a.value + (b.value - a.value) * p;
}

/** A clip property's static value, with its default filled in. */
export function staticValue(clip: Clip, prop: KeyframeProp): number {
  return clip[prop] ?? PROP_DEFAULTS[prop];
}

/** Whether the clip animates `prop`. */
export function hasKeys(clip: Clip, prop: KeyframeProp): boolean {
  return Boolean(clip.keyframes?.[prop]?.length);
}

/**
 * The value of a clip property at `frame` (relative to the clip's start): the
 * keyframe curve when the property has keys, otherwise its static value.
 */
export function valueAt(clip: Clip, prop: KeyframeProp, frame: number): number {
  return curveAt(clip.keyframes?.[prop], frame, staticValue(clip, prop));
}

/** The clip as it stands at `frame`: every animated property replaced by its value there. */
export function clipAt(clip: Clip, frame: number): Clip {
  if (!clip.keyframes) return clip;
  const out: Clip = { ...clip };
  for (const prop of KEYFRAME_PROPS) if (hasKeys(clip, prop)) out[prop] = valueAt(clip, prop, frame);
  return out;
}

/** Sorted by frame, one key per frame (the later one in the list wins), on whole frames. */
export function normalizeKeys(keys: readonly Keyframe[]): Keyframe[] {
  const byFrame = new Map<number, Keyframe>();
  for (const k of keys) {
    if (!Number.isFinite(k.frame) || !Number.isFinite(k.value)) continue;
    const frame = Math.round(k.frame);
    byFrame.set(frame, { ...k, frame });
  }
  return [...byFrame.values()].sort((a, b) => a.frame - b.frame);
}

/** Keyframes with empty properties removed; undefined when nothing is left. */
export function tidyKeyframes(kf: Keyframes | undefined): Keyframes | undefined {
  if (!kf) return undefined;
  const out: Keyframes = {};
  for (const prop of KEYFRAME_PROPS) if (kf[prop]?.length) out[prop] = kf[prop];
  return Object.keys(out).length ? out : undefined;
}

/**
 * One property's keys cut to frames [0, duration − 1] of a clip. Where the
 * curve runs past an edge, a key goes on the edge with the value the curve
 * had there (taking the ease of the span it cuts), so the curve inside stays
 * as it was: exactly for linear and hold spans; an eased span cut part-way
 * keeps its ends and its ease.
 */
export function cropKeys(keys: readonly Keyframe[], duration: number): Keyframe[] {
  const last = Math.max(0, duration - 1);
  if (keys.length === 0) return [];
  const inside = keys.filter((k) => k.frame >= 0 && k.frame <= last);
  const out: Keyframe[] = [...inside];
  const spanAt = (f: number) => [...keys].reverse().find((k) => k.frame <= f);
  if (keys[0].frame < 0 && !inside.some((k) => k.frame === 0)) {
    const before = spanAt(0);
    out.unshift(edgeKey(0, curveAt(keys, 0, 0), before));
  }
  if (keys[keys.length - 1].frame > last && !out.some((k) => k.frame === last)) {
    const before = spanAt(last);
    out.push(edgeKey(last, curveAt(keys, last, 0), before));
  }
  return normalizeKeys(out);
}

function edgeKey(frame: number, value: number, span: Keyframe | undefined): Keyframe {
  const k: Keyframe = { frame, value };
  if (span?.ease && span.ease !== 'linear') k.ease = span.ease;
  if (span?.duck) k.duck = true;
  return k;
}

/**
 * Keyframes for a clip whose content now begins `delta` frames later (its head
 * was trimmed by `delta`, or grown by −delta) and lasts `duration` frames.
 * Keys move with the content and are cut to the new length (see cropKeys).
 */
export function retimeKeyframes(kf: Keyframes | undefined, delta: number, duration: number): Keyframes | undefined {
  if (!kf) return undefined;
  const out: Keyframes = {};
  for (const prop of KEYFRAME_PROPS) {
    const keys = kf[prop];
    if (!keys?.length) continue;
    out[prop] = cropKeys(
      keys.map((k) => ({ ...k, frame: k.frame - delta })),
      duration,
    );
  }
  return tidyKeyframes(out);
}

/** Keys stretched in time by `factor` (a speed change), rounded to frames and cut to `duration`. */
export function scaleKeyframes(kf: Keyframes | undefined, factor: number, duration: number): Keyframes | undefined {
  if (!kf) return undefined;
  const out: Keyframes = {};
  for (const prop of KEYFRAME_PROPS) {
    const keys = kf[prop];
    if (keys?.length) out[prop] = cropKeys(normalizeKeys(keys.map((k) => ({ ...k, frame: Math.round(k.frame * factor) }))), duration);
  }
  return tidyKeyframes(out);
}

/** Keys moved by `delta` frames without cutting (e.g. a transition tail continuing after its clip). */
export function shiftKeyframes(kf: Keyframes | undefined, delta: number): Keyframes | undefined {
  if (!kf) return undefined;
  const out: Keyframes = {};
  for (const prop of KEYFRAME_PROPS) {
    const keys = kf[prop];
    if (keys?.length) out[prop] = keys.map((k) => ({ ...k, frame: k.frame + delta }));
  }
  return tidyKeyframes(out);
}

/** The keys of `kf` that apply to a clip of this kind; undefined when none do. */
export function keyframesFor(clip: Pick<Clip, 'kind' | 'freeze'>, kf: Keyframes | undefined): Keyframes | undefined {
  if (!kf) return undefined;
  const allowed = animatableProps(clip);
  const out: Keyframes = {};
  for (const prop of allowed) if (kf[prop]?.length) out[prop] = kf[prop]!.map((k) => ({ ...k }));
  return tidyKeyframes(out);
}

/** The nearest key frame before (`dir` −1) or after (1) `frame`, across `props`; null when there is none. */
export function adjacentKey(clip: Clip, props: readonly KeyframeProp[], frame: number, dir: -1 | 1): number | null {
  const frames = props.flatMap((p) => clip.keyframes?.[p]?.map((k) => k.frame) ?? []).filter((f) => (dir > 0 ? f > frame : f < frame));
  if (frames.length === 0) return null;
  return dir > 0 ? Math.min(...frames) : Math.max(...frames);
}

/** Shape check for keyframes read from a file or the network: whole frames, finite values, known eases. */
export function validKeyframes(x: unknown): x is Keyframes {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const eases = new Set(KEYFRAME_EASES.map((e) => e.id));
  return Object.entries(x).every(
    ([prop, keys]) =>
      (KEYFRAME_PROPS as readonly string[]).includes(prop) &&
      Array.isArray(keys) &&
      keys.every(
        (k: Keyframe) =>
          typeof k === 'object' &&
          k !== null &&
          Number.isInteger(k.frame) &&
          k.frame >= 0 &&
          Number.isFinite(k.value) &&
          (k.ease === undefined || eases.has(k.ease)),
      ),
  );
}
