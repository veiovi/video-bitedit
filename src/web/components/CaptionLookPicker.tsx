// The caption look picker: one tile per look, each a small live preview drawn
// by the same component the composition uses for caption clips, plus the
// position buttons (inside the platform safe area).

import { useEffect, useState } from 'react';
import { CAPTION_LOOKS, type CaptionLook, type CaptionPosition, captionLines, captionPosition, captionY } from '../../shared/captionLooks';
import type { TextStyle } from '../../shared/project';
import { getTheme } from '../../shared/themes';
import { CaptionLineView } from '../../remotion/CaptionLine';

const FPS = 30;
const LOOP = 90;
const SAMPLE = ['Every', 'word', 'lands', 'right', 'on', 'time'].map((text, i) => ({ text, start: 6 + i * 12, end: 6 + i * 12 + 10 }));

/** A frame counter that loops while the component is shown. */
function useLoopFrame(length: number): number {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      setFrame(Math.floor(((now - t0) / 1000) * FPS) % length);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [length]);
  return frame;
}

function LookPreview({ look, style, themeId, frame }: { look: CaptionLook; style: Omit<TextStyle, 'text'>; themeId?: string; frame: number }) {
  const theme = getTheme(themeId);
  const s = { ...style, captionLook: look, x: 0.5, y: 0.5, fontSize: 11 };
  const lines = captionLines(SAMPLE, FPS, { captionLook: look, wordsPerLine: Math.min(3, style.wordsPerLine ?? 3) });
  const line = lines.find((l) => frame >= l.start && frame < l.end) ?? lines[lines.length - 1];
  return (
    <div className="look-preview">
      <CaptionLineView line={line} frame={frame} fps={FPS} style={s} fontFamily={theme.fontFamily} accent={style.highlight ?? theme.presets.caption.highlight ?? '#ffd84d'} />
    </div>
  );
}

export function CaptionLookPicker({
  style,
  themeId,
  frameSize,
  disabled,
  onChange,
}: {
  style: Omit<TextStyle, 'text'>;
  themeId?: string;
  frameSize: { width: number; height: number };
  disabled?: boolean;
  onChange: (patch: Partial<TextStyle>) => void;
}) {
  const frame = useLoopFrame(LOOP);
  const current = style.captionLook ?? 'classic';
  const position = captionPosition(style.y);
  return (
    <>
      <div className="look-grid" role="radiogroup" aria-label="Caption look">
        {CAPTION_LOOKS.map((l) => (
          <button
            key={l.id}
            type="button"
            role="radio"
            aria-checked={current === l.id}
            className={`look-tile ${current === l.id ? 'on' : ''}`}
            disabled={disabled}
            title={l.description}
            onClick={() => onChange({ captionLook: l.id })}
          >
            <LookPreview look={l.id} style={style} themeId={themeId} frame={frame} />
            <span className="look-name">{l.label}</span>
          </button>
        ))}
      </div>
      <div className="field">
        <span>Position</span>
        <div className="seg">
          {(['top', 'middle', 'bottom'] as CaptionPosition[]).map((p) => (
            <button
              key={p}
              type="button"
              className={`small ${position === p ? 'on' : ''}`}
              disabled={disabled}
              onClick={() => onChange({ y: captionY(p, frameSize) })}
              title={`Place captions at the ${p}, inside the safe area`}
            >
              {p === 'top' ? 'Top' : p === 'middle' ? 'Middle' : 'Bottom'}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
