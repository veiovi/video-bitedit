// One caption line drawn in its look at a frame. The composition uses it for
// caption clips, and the inspector's look picker uses the same component for
// its live previews, so both show exactly what the export renders.

import type React from 'react';
import type { CaptionLine } from '../shared/captions';
import { contrastText, lookScale, wordLooks } from '../shared/captionLooks';
import type { TextStyle } from '../shared/project';
import { easeOutBack } from '../shared/themes';

export interface CaptionLineViewProps {
  line: CaptionLine;
  /** Frame relative to the caption clip. */
  frame: number;
  fps: number;
  style: Omit<TextStyle, 'text'>;
  /** Font family when the style has none (the theme's). */
  fontFamily: string;
  /** Accent colour (the style's highlight or the theme's). */
  accent: string;
  /** Extra scale and rotation from the clip. */
  scale?: number;
  rotation?: number;
  /** Multiplies the font size, for small previews. */
  sizeFactor?: number;
}

export const CaptionLineView: React.FC<CaptionLineViewProps> = ({ line, frame, fps, style: t, fontFamily, accent, scale = 1, rotation = 0, sizeFactor = 1 }) => {
  const look = t.captionLook ?? 'classic';
  const looks = wordLooks(look, line, frame, fps);
  // Classic lines pop in as a whole; the other looks animate word by word.
  const linePop = look === 'classic' ? 0.9 + 0.1 * easeOutBack((frame - line.start) / Math.max(1, Math.round(fps * 0.18))) : 1;
  const boxed = t.background !== 'transparent';
  const accentText = contrastText(accent);
  return (
    <div
      style={{
        position: 'absolute',
        left: `${t.x * 100}%`,
        top: `${t.y * 100}%`,
        transform: `translate(-50%, -50%) scale(${scale * linePop}) rotate(${rotation}deg)`,
        fontSize: t.fontSize * lookScale(look) * sizeFactor,
        fontWeight: t.fontWeight,
        color: t.color,
        background: t.background,
        padding: boxed ? '0.15em 0.45em' : 0,
        borderRadius: '0.14em',
        fontFamily: t.fontFamily ?? fontFamily,
        textShadow: boxed ? undefined : '0 0.05em 0.4em rgba(0,0,0,0.75), 0 0 0.14em rgba(0,0,0,0.9)',
        textAlign: 'center',
        lineHeight: 1.15,
        width: 'max-content',
        maxWidth: '86%',
        whiteSpace: 'normal',
        textTransform: look === 'oneWord' ? 'uppercase' : undefined,
      }}
    >
      {line.words.map((w, i) => {
        const l = looks[i];
        const shown = l.chars === undefined ? w.text : w.text.slice(0, l.chars);
        const hidden = l.chars === undefined ? '' : w.text.slice(l.chars);
        const fill = l.fill;
        const span: React.CSSProperties = {
          display: 'inline-block',
          marginRight: i < line.words.length - 1 ? '0.3em' : 0,
          opacity: l.opacity,
          transform: l.scale !== 1 || l.lift ? `translateY(${-l.lift}em) scale(${l.scale})` : undefined,
          color: l.box ? accentText : l.accent ? accent : undefined,
          background: l.box ? accent : undefined,
          // The box grows past the word (a spread shadow) without moving its neighbours.
          boxShadow: l.box ? `0 0 0 0.12em ${accent}` : undefined,
          borderRadius: l.box ? '0.1em' : undefined,
          textShadow: l.box ? 'none' : undefined,
        };
        if (fill !== undefined) {
          // Karaoke: the word fills with the accent colour from the left.
          const pct = Math.round(fill * 1000) / 10;
          Object.assign(span, {
            backgroundImage: `linear-gradient(90deg, ${accent} ${pct}%, ${t.color} ${pct}%)`,
            WebkitBackgroundClip: 'text',
            backgroundClip: 'text',
            color: 'transparent',
            WebkitTextFillColor: 'transparent',
            // A text shadow would paint over the clipped fill; a drop shadow sits under it.
            textShadow: 'none',
            filter: boxed ? undefined : 'drop-shadow(0 0.04em 0.16em rgba(0,0,0,0.85))',
          });
        }
        return (
          <span key={`${w.start}-${i}`} style={span}>
            {shown}
            {hidden && <span style={{ opacity: 0 }}>{hidden}</span>}
          </span>
        );
      })}
    </div>
  );
};
