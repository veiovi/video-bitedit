// Designed slides for explainers, drawn by Remotion in the Bit Edit look:
// cream paper, ink type, retro accent colours and staggered entrances.

import type React from 'react';
import { AbsoluteFill, Img, useCurrentFrame, useVideoConfig } from 'remotion';
import { easeOutBack } from '../shared/effects';
import type { Clip, SlidePalette } from '../shared/project';
import { easeOutCubic } from '../shared/themes';

const PALETTES: Record<SlidePalette, { bg: string; ink: string; accent: string; muted: string }> = {
  paper: { bg: '#f1e9db', ink: '#1f1915', accent: '#b0583a', muted: '#7a6655' },
  ink: { bg: '#16130f', ink: '#f1e9db', accent: '#5e9c97', muted: '#a89a88' },
  rust: { bg: '#b0583a', ink: '#fbf3e6', accent: '#1f1915', muted: '#f1d7a6' },
  turquoise: { bg: '#5e9c97', ink: '#10201f', accent: '#fbf3e6', muted: '#1f3d3b' },
  mustard: { bg: '#c49a3c', ink: '#1f1915', accent: '#fbf3e6', muted: '#4a3a1a' },
};

const DISPLAY = '"Space Mono", "JetBrains Mono", ui-monospace, monospace';
const BODY = '"Inter Variable", Inter, "Helvetica Neue", Arial, sans-serif';

/** Rise-and-fade entrance for element `i`, staggered by 6 frames. */
function useEnter(i: number) {
  const frame = useCurrentFrame();
  const t = Math.max(0, Math.min(1, (frame - 4 - i * 6) / 14));
  const e = easeOutCubic(t);
  return { opacity: e, transform: `translateY(${(1 - e) * 40}px)` };
}

function Kicker({ text, color, i = 0 }: { text?: string; color: string; i?: number }) {
  const s = useEnter(i);
  if (!text) return null;
  return (
    <div style={{ ...s, fontFamily: DISPLAY, fontSize: 30, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color }}>
      {text}
    </div>
  );
}

function Title({ text, color, size, i = 1 }: { text: string; color: string; size: number; i?: number }) {
  const s = useEnter(i);
  return (
    <div style={{ ...s, fontFamily: DISPLAY, fontSize: size, fontWeight: 700, lineHeight: 1.08, letterSpacing: '-0.02em', color, whiteSpace: 'pre-wrap' }}>
      {text}
    </div>
  );
}

function Body({ text, color, i = 2 }: { text?: string; color: string; i?: number }) {
  const s = useEnter(i);
  if (!text) return null;
  return <div style={{ ...s, fontFamily: BODY, fontSize: 40, lineHeight: 1.4, color, maxWidth: 1100, whiteSpace: 'pre-wrap' }}>{text}</div>;
}

function Bullet({ text, n, i, ink, accent }: { text: string; n: number; i: number; ink: string; accent: string }) {
  const s = useEnter(i);
  return (
    <div style={{ ...s, display: 'flex', gap: 28, alignItems: 'baseline', fontFamily: BODY, fontSize: 46, color: ink, lineHeight: 1.3 }}>
      <span style={{ fontFamily: DISPLAY, fontSize: 30, fontWeight: 700, color: accent, minWidth: 54 }}>{String(n).padStart(2, '0')}</span>
      <span>{text}</span>
    </div>
  );
}

/** A slowly drifting accent bar, so static slides still breathe. */
function Bar({ color }: { color: string }) {
  const frame = useCurrentFrame();
  const w = 140 * easeOutBack(Math.min(1, frame / 18));
  return <div style={{ width: w, height: 12, background: color, marginBottom: 36 }} />;
}

function Picture({ src, style }: { src?: string; style?: React.CSSProperties }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  if (!src) return null;
  const zoom = 1 + 0.08 * (frame / Math.max(1, durationInFrames));
  return (
    <div style={{ overflow: 'hidden', ...style }}>
      <Img src={src} style={{ width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${zoom})` }} />
    </div>
  );
}

export const SlideClip: React.FC<{ clip: Clip; src?: string }> = ({ clip, src }) => {
  const { width, height } = useVideoConfig();
  const s = clip.slide!;
  const p = PALETTES[s.palette ?? 'paper'];
  const pad = Math.round(width * 0.07);
  const scale = Math.min(width / 1920, height / 1080) * (height > width ? 1.25 : 1);
  const inner: React.CSSProperties = { width: 1920, height: 1080, transform: `scale(${scale})`, transformOrigin: 'top left' };
  const frame: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    width: width / scale,
    height: height / scale,
    background: p.bg,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    gap: 28,
    padding: pad / scale,
  };

  let content: React.ReactNode;
  switch (s.layout) {
    case 'bullets':
      content = (
        <>
          <Bar color={p.accent} />
          <Kicker text={s.kicker} color={p.muted} />
          <Title text={s.title} color={p.ink} size={84} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 26, marginTop: 24 }}>
            {(s.bullets ?? []).map((b, i) => (
              <Bullet key={i} text={b} n={i + 1} i={i + 2} ink={p.ink} accent={p.accent} />
            ))}
          </div>
        </>
      );
      break;
    case 'stat':
      content = (
        <>
          <Kicker text={s.kicker} color={p.muted} />
          <Title text={s.stat ?? ''} color={p.accent} size={260} i={1} />
          <Title text={s.title} color={p.ink} size={72} i={2} />
          <Body text={s.body} color={p.muted} i={3} />
        </>
      );
      break;
    case 'quote':
      content = (
        <>
          <div style={{ fontFamily: DISPLAY, fontSize: 200, lineHeight: 0.6, color: p.accent }}>“</div>
          <Title text={s.title} color={p.ink} size={76} />
          <Body text={s.body} color={p.muted} />
        </>
      );
      break;
    case 'image':
      return (
        <AbsoluteFill style={{ background: p.bg }}>
          <Picture src={src} style={{ position: 'absolute', inset: 0 }} />
          <AbsoluteFill style={{ background: `linear-gradient(0deg, ${p.bg}f2 0%, ${p.bg}c0 28%, transparent 60%)` }} />
          <div style={{ ...inner, position: 'absolute', top: 0, left: 0 }}>
            <div style={{ ...frame, background: 'transparent', justifyContent: 'flex-end' }}>
              <Kicker text={s.kicker} color={p.accent} />
              <Title text={s.title} color={p.ink} size={88} />
              <Body text={s.body} color={p.ink} />
            </div>
          </div>
        </AbsoluteFill>
      );
    case 'split':
      return (
        <AbsoluteFill style={{ background: p.bg, flexDirection: height > width ? 'column' : 'row' }}>
          <div style={{ flex: 1, position: 'relative' }}>
            <div style={{ ...inner, position: 'absolute', top: 0, left: 0 }}>
              <div style={{ ...frame, width: (height > width ? width : width / 2) / scale, height: (height > width ? height / 2 : height) / scale, background: 'transparent' }}>
                <Bar color={p.accent} />
                <Kicker text={s.kicker} color={p.muted} />
                <Title text={s.title} color={p.ink} size={76} />
                <Body text={s.body} color={p.muted} />
                {(s.bullets ?? []).map((b, i) => (
                  <Bullet key={i} text={b} n={i + 1} i={i + 3} ink={p.ink} accent={p.accent} />
                ))}
              </div>
            </div>
          </div>
          <Picture src={src} style={{ flex: 1, borderLeft: height > width ? undefined : `10px solid ${p.ink}`, borderTop: height > width ? `10px solid ${p.ink}` : undefined }} />
        </AbsoluteFill>
      );
    default:
      content = (
        <>
          <Bar color={p.accent} />
          <Kicker text={s.kicker} color={p.muted} />
          <Title text={s.title} color={p.ink} size={120} />
          <Body text={s.body} color={p.muted} />
        </>
      );
  }
  return (
    <AbsoluteFill style={{ background: p.bg }}>
      <div style={{ ...inner, position: 'absolute', top: 0, left: 0 }}>
        <div style={frame}>{content}</div>
      </div>
    </AbsoluteFill>
  );
};
