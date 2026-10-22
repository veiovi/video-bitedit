// Renders clip effects as CSS/SVG so they look identical in the Player and in
// the headless-Chrome render. No randomness except hash01(seed, frame).

import type React from 'react';
import { AbsoluteFill, interpolate } from 'remotion';
import { correctionMatrix } from '../shared/autocolor';
import { easeInOut, easeOutBack, gradeCss, gradeMatrix, hash01 } from '../shared/effects';
import type { Clip, Effect, Transition } from '../shared/project';

export interface EffectState {
  /** CSS filter for the media layer. */
  filter: string;
  /** Extra transform applied around the media (motion effects). */
  transform: string;
  /** SVG <filter> definitions referenced by `filter`. */
  defs: React.ReactNode;
  /** Overlays drawn above the media. */
  overlays: React.ReactNode;
}

/** Combine a clip's effects at `frame` (relative to the clip's start). */
export function applyEffects(clip: Clip, frame: number, width: number): EffectState {
  const filters: string[] = [];
  const transforms: string[] = [];
  const defs: React.ReactNode[] = [];
  const overlays: React.ReactNode[] = [];
  const px = width / 1920;

  (clip.effects ?? []).forEach((fx: Effect, i) => {
    const amount = fx.amount ?? 1;
    const seed = fx.seed ?? 1;
    const key = `${clip.id}-${i}`;
    switch (fx.type) {
      case 'grade': {
        const preset = fx.preset ?? 'tealOrange';
        const id = `grade-${key}`;
        defs.push(
          <filter key={id} id={id} colorInterpolationFilters="sRGB">
            <feColorMatrix type="matrix" values={gradeMatrix(preset, amount)} />
          </filter>,
        );
        filters.push(`url(#${id})`, gradeCss(preset, amount));
        break;
      }
      case 'autoColor': {
        if (!fx.gains || !fx.offsets) break;
        const id = `auto-${key}`;
        const mix = (g: number) => 1 + (g - 1) * amount;
        defs.push(
          <filter key={id} id={id} colorInterpolationFilters="sRGB">
            <feColorMatrix
              type="matrix"
              values={correctionMatrix({
                gains: fx.gains.map(mix) as [number, number, number],
                offsets: fx.offsets.map((o) => o * amount) as [number, number, number],
              })}
            />
          </filter>,
        );
        filters.push(`url(#${id})`);
        break;
      }
      case 'blur':
        filters.push(`blur(${(amount * 14 * px).toFixed(2)}px)`);
        break;
      case 'kenBurns': {
        const t = easeInOut(frame / Math.max(1, clip.duration));
        const scale = interpolate(t, [0, 1], [fx.from ?? 1, fx.to ?? 1.15]);
        const x = (fx.panX ?? 0) * t * 100;
        const y = (fx.panY ?? 0) * t * 100;
        transforms.push(`translate(${x}%, ${y}%) scale(${scale.toFixed(4)})`);
        break;
      }
      case 'zoomPunch':
        transforms.push(`scale(${(1 + (fx.amount ?? 0.15) * easeOutBack(frame / 5)).toFixed(4)})`);
        break;
      case 'glitch': {
        const step = Math.floor(frame / 2);
        if (hash01(seed, step) > 1 - 0.22 * amount) {
          const dx = (hash01(seed + 7, step) - 0.5) * 60 * amount * px;
          const skew = (hash01(seed + 13, step) - 0.5) * 10 * amount;
          transforms.push(`translateX(${dx.toFixed(1)}px) skewX(${skew.toFixed(2)}deg)`);
          filters.push(`hue-rotate(${Math.round(hash01(seed + 3, step) * 120)}deg) saturate(1.8)`);
          overlays.push(
            <AbsoluteFill
              key={`glitch-${key}`}
              style={{
                mixBlendMode: 'screen',
                opacity: 0.55 * amount,
                background: `repeating-linear-gradient(0deg, rgba(255,0,80,0.35) 0 ${2 * px}px, transparent ${2 * px}px ${6 * px}px),
                  linear-gradient(90deg, rgba(0,255,230,0.25), transparent 30%, transparent 70%, rgba(255,40,120,0.25))`,
                transform: `translateY(${((hash01(seed + 21, step) - 0.5) * 40).toFixed(1)}%)`,
              }}
            />,
          );
        }
        break;
      }
      case 'grain': {
        const id = `grain-${key}`;
        overlays.push(
          <AbsoluteFill key={id} style={{ mixBlendMode: 'overlay', opacity: 0.1 + 0.3 * amount }}>
            <svg width="100%" height="100%" preserveAspectRatio="none">
              <filter id={id}>
                <feTurbulence type="fractalNoise" baseFrequency={0.85} numOctaves={2} seed={(seed * 97 + frame) % 9973} />
                <feColorMatrix type="saturate" values="0" />
              </filter>
              <rect width="100%" height="100%" filter={`url(#${id})`} />
            </svg>
          </AbsoluteFill>,
        );
        break;
      }
      case 'vignette':
        overlays.push(
          <AbsoluteFill
            key={`vig-${key}`}
            style={{ background: `radial-gradient(ellipse at center, transparent 42%, rgba(0,0,0,${(0.8 * amount).toFixed(2)}) 100%)` }}
          />,
        );
        break;
      case 'lightLeak': {
        const t = frame / 30;
        const x = 50 + 40 * Math.sin(t * 0.55 + seed);
        const y = 30 + 25 * Math.cos(t * 0.4 + seed * 2);
        const pulse = 0.55 + 0.45 * Math.sin(t * 1.1 + seed * 3);
        overlays.push(
          <AbsoluteFill
            key={`leak-${key}`}
            style={{
              mixBlendMode: 'screen',
              opacity: amount * pulse * 0.8,
              background: `radial-gradient(ellipse 60% 80% at ${x}% ${y}%, rgba(255,140,60,0.85), transparent 70%),
                radial-gradient(ellipse 40% 60% at ${100 - x}% ${100 - y}%, rgba(255,70,120,0.55), transparent 70%)`,
            }}
          />,
        );
        break;
      }
    }
  });

  return {
    filter: filters.join(' '),
    transform: transforms.join(' '),
    defs: defs.length ? (
      <svg width={0} height={0} style={{ position: 'absolute' }} aria-hidden>
        {defs}
      </svg>
    ) : null,
    overlays,
  };
}

export interface TransitionState {
  opacity: number;
  transform: string;
  clipPath?: string;
  filter: string;
  /** Audio gain for the incoming clip. */
  gain: number;
  /** Colour flash drawn above the incoming clip (dips). */
  flash?: { color: string; opacity: number };
}

/** The incoming clip's look during its transition, `frame` frames after its start. */
export function enterTransition(t: Transition | undefined, frame: number): TransitionState {
  const none: TransitionState = { opacity: 1, transform: '', filter: '', gain: 1 };
  if (!t || t.duration <= 0 || frame >= t.duration) return none;
  const p = Math.max(0, frame / t.duration);
  const e = easeInOut(p);
  switch (t.type) {
    case 'fade':
      return { ...none, opacity: e, gain: e };
    case 'dipBlack':
    case 'dipWhite':
      return {
        ...none,
        opacity: p < 0.5 ? 0 : 1,
        gain: p < 0.5 ? 0 : (p - 0.5) * 2,
        flash: { color: t.type === 'dipBlack' ? '#000' : '#fff', opacity: 1 - Math.abs(2 * p - 1) },
      };
    case 'slide':
      return { ...none, transform: `translateX(${((1 - e) * 100).toFixed(2)}%)`, gain: e };
    case 'whip': {
      const speed = Math.sin(Math.PI * p);
      return { ...none, transform: `translateX(${((1 - e) * 100).toFixed(2)}%)`, filter: `blur(${(speed * 18).toFixed(1)}px)`, gain: e };
    }
    case 'wipe':
      return { ...none, clipPath: `inset(0 ${((1 - e) * 100).toFixed(2)}% 0 0)`, gain: e };
    case 'zoom':
      return { ...none, opacity: e, transform: `scale(${(1.3 - 0.3 * e).toFixed(4)})`, gain: e };
  }
}

/** How the outgoing clip's continued tail moves during the transition. */
export function exitTransition(t: Transition, frame: number): { transform: string; filter: string; gain: number } {
  const p = Math.max(0, Math.min(1, frame / t.duration));
  const e = easeInOut(p);
  switch (t.type) {
    case 'slide':
      return { transform: `translateX(${(-e * 100).toFixed(2)}%)`, filter: '', gain: 1 - e };
    case 'whip':
      return { transform: `translateX(${(-e * 100).toFixed(2)}%)`, filter: `blur(${(Math.sin(Math.PI * p) * 18).toFixed(1)}px)`, gain: 1 - e };
    case 'zoom':
      return { transform: `scale(${(1 + 0.3 * e).toFixed(4)})`, filter: '', gain: 1 - e };
    case 'dipBlack':
    case 'dipWhite':
      return { transform: '', filter: '', gain: p < 0.5 ? 1 - 2 * p : 0 };
    default:
      return { transform: '', filter: '', gain: 1 - e };
  }
}
