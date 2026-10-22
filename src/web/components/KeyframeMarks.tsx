// Keyframes on the timeline: diamonds along the bottom edge of the selected
// clip, and the volume curve of an audio clip with volume keys.

import { moveKeyframe, removeKeyframe, updateTimeline } from '../../shared/edits';
import { KEYFRAME_PROPS, PROP_LABELS, valueAt } from '../../shared/keyframes';
import type { Clip, KeyframeProp } from '../../shared/project';
import { useEditor } from '../store';

/** Same scale as the volume line: 0 (top) is 200%, 1 (bottom) silent; square root, like a fader. */
const volumeToY = (v: number) => 1 - Math.sqrt(Math.max(0, Math.min(v, 2)) / 2);

/** Keyed frames of a clip, each with the properties keyed there. */
function keyedFrames(clip: Clip): { frame: number; props: KeyframeProp[] }[] {
  const at = new Map<number, KeyframeProp[]>();
  for (const prop of KEYFRAME_PROPS) for (const k of clip.keyframes?.[prop] ?? []) at.set(k.frame, [...(at.get(k.frame) ?? []), prop]);
  return [...at].sort((a, b) => a[0] - b[0]).map(([frame, props]) => ({ frame, props }));
}

/**
 * One diamond per keyed frame (all the properties keyed there move together).
 * Drag to move in time, snapped to frames and kept inside the clip, as one
 * undo step; ⌥-click deletes; a plain click puts the playhead on it.
 */
export function KeyDiamonds({ clip, px }: { clip: Clip; px: number }) {
  const marks = keyedFrames(clip);
  if (marks.length === 0) return null;
  const onPointerDown = (e: React.PointerEvent, frame: number, props: KeyframeProp[]) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const s = useEditor.getState();
    if (!s.canEdit) return s.seek(clip.start + frame);
    if (e.altKey) {
      s.applyTimeline((t) => props.reduce((tl, p) => removeKeyframe(tl, clip.id, p, frame), t));
      return;
    }
    const base = s.doc;
    const timelineId = s.timelineId;
    const x0 = e.clientX;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 3) return;
      moved = true;
      const to = Math.min(Math.max(0, frame + Math.round((ev.clientX - x0) / px)), clip.duration - 1);
      useEditor.getState().preview(updateTimeline(base, timelineId, (t) => props.reduce((tl, p) => moveKeyframe(tl, clip.id, p, frame, to), t)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (moved) useEditor.getState().commitFrom(base);
      else useEditor.getState().seek(clip.start + frame);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  return (
    <div className="key-marks">
      {marks.map(({ frame, props }, i) => (
        <div
          key={i}
          className={`key-diamond ${props.length === 1 ? `k-${props[0]}` : 'k-many'}`}
          // Kept clear of the clip's edges so keys on the first and last frames stay grabbable.
          style={{ left: Math.min(Math.max(frame * px, 5), clip.duration * px - 5) }}
          title={`${props.map((p) => PROP_LABELS[p]).join(', ')} keyframe at ${frame} frames: drag to move, ⌥-click to delete`}
          onPointerDown={(e) => onPointerDown(e, frame, props)}
        />
      ))}
    </div>
  );
}

/** The volume curve through an audio clip's volume keys, on the volume line's scale. */
export function VolumeCurve({ clip }: { clip: Clip }) {
  const samples = 160;
  const frames = new Set<number>([0, clip.duration - 1, ...(clip.keyframes?.volume ?? []).map((k) => k.frame)]);
  for (let i = 0; i <= samples; i++) frames.add(Math.round((i / samples) * (clip.duration - 1)));
  const pts = [...frames]
    .sort((a, b) => a - b)
    .map((f) => `${((f + 0.5) / clip.duration) * 1000},${volumeToY(valueAt(clip, 'volume', f)) * 100}`)
    .join(' ');
  return (
    <div className="volume-curve" title="Volume keyframes: move the diamonds, or set values in the inspector">
      <svg viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden>
        <polyline points={pts} vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}
