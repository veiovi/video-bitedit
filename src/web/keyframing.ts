// Keyframing in the editor: which property the inspector touched last (the
// one `;` keys), and the undoable actions behind the ◆ buttons, the timeline
// diamonds and the shortcut.

import { create } from 'zustand';
import { removeKeyframe, setKeyframe } from '../shared/edits';
import { PROP_LABELS, animatableProps, valueAt } from '../shared/keyframes';
import { type Clip, type KeyframeProp, clipEnd } from '../shared/project';
import { activeTimeline, selectedClips, useEditor } from './store';

/** The property last changed or keyed in the inspector; `;` keys it. */
export const useKeyProp = create<{ prop: KeyframeProp | null }>(() => ({ prop: null }));

export function noteKeyProp(prop: KeyframeProp) {
  if (useKeyProp.getState().prop !== prop) useKeyProp.setState({ prop });
}

/** The playhead as a frame of `clip`, kept inside it. */
export function clipFrame(clip: Clip, playhead: number): number {
  return Math.min(Math.max(0, playhead - clip.start), clip.duration - 1);
}

/** Whether the playhead is over the clip. */
export const playheadIn = (clip: Clip, playhead: number) => playhead >= clip.start && playhead < clipEnd(clip);

/** Add a key for `prop` at the playhead with the value showing there, or remove the key that is there. One undo step. */
export function toggleKeyframe(clipId: string, prop: KeyframeProp) {
  const s = useEditor.getState();
  const clip = activeTimeline(s).clips.find((c) => c.id === clipId);
  if (!clip) return;
  if (!playheadIn(clip, s.playhead)) return s.setToast('Move the playhead over the clip to key it');
  noteKeyProp(prop);
  const f = s.playhead - clip.start;
  const there = clip.keyframes?.[prop]?.some((k) => k.frame === f);
  s.applyTimeline((t) => (there ? removeKeyframe(t, clip.id, prop, f) : setKeyframe(t, clip.id, prop, f, valueAt(clip, prop, f))));
}

/**
 * The `;` shortcut: toggle a key on the selected clip for the property last
 * used in the inspector, or opacity (volume for audio clips) by default.
 */
export function toggleKeyAtPlayhead() {
  const s = useEditor.getState();
  const picked = selectedClips(s);
  if (picked.length !== 1) return s.setToast('Select one clip to add a keyframe');
  const clip = picked[0];
  const props = animatableProps(clip);
  if (props.length === 0) return s.setToast('This clip has nothing to animate');
  const last = useKeyProp.getState().prop;
  const prop = last && props.includes(last) ? last : props.includes('opacity') ? 'opacity' : props[0];
  const had = clip.keyframes?.[prop]?.some((k) => k.frame === s.playhead - clip.start);
  toggleKeyframe(clip.id, prop);
  if (playheadIn(clip, s.playhead)) s.setToast(`${PROP_LABELS[prop]} keyframe ${had ? 'removed' : 'added'}`);
}
