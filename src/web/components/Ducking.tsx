// Duck under speech: the settings and buttons, shown in an audio clip's
// inspector and in the popover from an audio track header's right-click.

import { useEffect } from 'react';
import { DUCKING_LIMITS } from '../../shared/ducking';
import { duckTrack, isDucked, setDucking, unduckTrack, useDucking } from '../audio';
import { activeTimeline, useEditor } from '../store';

/** Depth, attack and release, and the buttons that duck a track or take the ducking out. */
export function DuckingControls({ trackId, disabled }: { trackId: string; disabled?: boolean }) {
  const opts = useDucking();
  const fps = useEditor((s) => activeTimeline(s).fps);
  const ducked = useEditor((s) => isDucked(activeTimeline(s).clips, trackId));
  const secs = (f: number) => `${(f / fps).toFixed(2)}s`;
  return (
    <div className="ducking">
      <label className="field slider">
        <span>Depth</span>
        <input type="range" min={DUCKING_LIMITS.depth.min} max={DUCKING_LIMITS.depth.max} step={1} value={opts.depth} onChange={(e) => setDucking({ depth: Number(e.target.value) })} />
        <output>{opts.depth} dB</output>
      </label>
      <label className="field slider">
        <span>Attack</span>
        <input type="range" min={DUCKING_LIMITS.attack.min} max={DUCKING_LIMITS.attack.max} step={1} value={opts.attack} onChange={(e) => setDucking({ attack: Number(e.target.value) })} />
        <output>{secs(opts.attack)}</output>
      </label>
      <label className="field slider">
        <span>Release</span>
        <input type="range" min={DUCKING_LIMITS.release.min} max={DUCKING_LIMITS.release.max} step={1} value={opts.release} onChange={(e) => setDucking({ release: Number(e.target.value) })} />
        <output>{secs(opts.release)}</output>
      </label>
      <div className="button-row">
        <button className="small" disabled={disabled} onClick={() => void duckTrack(trackId)} title="Lower this track wherever someone speaks on the other tracks, with volume keyframes you can edit">
          {ducked ? 'Duck again' : 'Duck under speech'}
        </button>
        <button className="small" disabled={disabled || !ducked} onClick={() => unduckTrack(trackId)} title="Take out the keyframes ducking added; ones set by hand stay">
          Remove ducking
        </button>
      </div>
    </div>
  );
}

/** The ducking popover for an audio track, opened from its header. Closes on Escape or a press outside. */
export function DuckMenu({ trackId, x, y, onClose }: { trackId: string; x: number; y: number; onClose: () => void }) {
  const name = useEditor((s) => activeTimeline(s).tracks.find((t) => t.id === trackId)?.name ?? '');
  const canEdit = useEditor((s) => s.canEdit);
  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e.type === 'pointerdown' && (e.target as HTMLElement).closest('.duck-menu')) return;
      onClose();
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', close, true);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', close, true);
    };
  }, [onClose]);
  return (
    <div className="duck-menu" role="dialog" aria-label={`Ducking for ${name}`} style={{ left: Math.min(x, window.innerWidth - 300), top: Math.min(y, window.innerHeight - 200) }}>
      <strong>Duck {name} under speech</strong>
      <DuckingControls trackId={trackId} disabled={!canEdit} />
    </div>
  );
}
