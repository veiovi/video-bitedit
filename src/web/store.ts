import type { PlayerRef } from '@remotion/player';
import { create } from 'zustand';
import { adjacentEditPoint, closeGaps, closeRange, deleteClips, detachAudio, mainTrackId, moveClips, pasteClips, rippleDeleteClips, toggleClipsEnabled, updateTimeline } from '../shared/edits';
import { type Asset, type Clip, type ProjectDoc, type ServerInfo, type Timeline, clipEnd, newId, timelineDuration, trackAccepts } from '../shared/project';

const HISTORY_LIMIT = 200;
const RIPPLE_KEY = 'videdit.ripple';
const LINKAGE_KEY = 'videdit.linkage';

/** Toggles default on unless this browser turned them off. */
function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) !== '0';
  } catch {
    return true;
  }
}

function writeFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? '1' : '0');
  } catch {
    // Private mode or blocked storage: the setting lasts for this tab only.
  }
}

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

export interface UploadState {
  name: string;
  progress: number;
  error?: string;
}

export interface EditorState {
  projectId: string;
  server: ServerInfo | null;
  doc: ProjectDoc;
  timelineId: string;
  version: number;
  assets: Asset[];
  canEdit: boolean;
  past: ProjectDoc[];
  future: ProjectDoc[];
  selection: string[];
  playhead: number;
  playing: boolean;
  pxPerFrame: number;
  saveState: SaveState;
  uploads: Record<string, UploadState>;
  toast: string | null;
  player: PlayerRef | null;
  snapping: boolean;
  /**
   * Main track magnet: the main track (V1) stays gapless. Drops on it insert
   * at clip edges, moves reorder, and trims and deletes ripple.
   */
  ripple: boolean;
  /** Linkage: the other tracks follow the main track's ripples, and captions and overlays travel with their clip. */
  linkage: boolean;
  /** Clips copied or cut in this tab, waiting to be pasted. */
  clipboard: Clip[] | null;
  /** A replacement waiting for the replace dialog: which clip gets which asset. */
  replacing: { clipId: string; assetId: string } | null;
  /** An empty stretch of a track, selected by clicking it; Delete closes it. */
  gap: { trackId: string; start: number; end: number } | null;
  /**
   * Timeline pointer tool: select/move, razor (click a clip to cut it), or
   * forward/backward (select everything right or left of the click and drag it).
   */
  tool: 'select' | 'razor' | 'forward' | 'backward';
  /** Which side panel tab is open. */
  panel: 'inspector' | 'comments' | 'history' | 'export';
  /** Preview shuttle speed (J/K/L); negative plays backwards. */
  playbackRate: number;

  load(projectId: string, doc: ProjectDoc, version: number, assets: Asset[], canEdit: boolean): void;
  /** Apply an edit and record it for undo. */
  apply(fn: (doc: ProjectDoc) => ProjectDoc): void;
  /** Apply an edit to the active timeline. */
  applyTimeline(fn: (t: Timeline) => Timeline): void;
  setTimeline(id: string): void;
  /** Show an in-progress edit (during a drag) without recording history. */
  preview(doc: ProjectDoc): void;
  /** Finish a gesture started from `base`, recording one undo step. */
  commitFrom(base: ProjectDoc): void;
  undo(): void;
  redo(): void;
  select(ids: string[]): void;
  setRipple(on: boolean): void;
  setLinkage(on: boolean): void;
  seek(frame: number): void;
  setZoom(pxPerFrame: number): void;
  setToast(msg: string | null): void;
}

export const useEditor = create<EditorState>((set, get) => ({
  projectId: '',
  server: null,
  doc: null as unknown as ProjectDoc,
  timelineId: '',
  version: 0,
  assets: [],
  canEdit: false,
  past: [],
  future: [],
  selection: [],
  playhead: 0,
  playing: false,
  pxPerFrame: 4,
  saveState: 'saved',
  uploads: {},
  toast: null,
  player: null,
  snapping: true,
  ripple: readFlag(RIPPLE_KEY),
  linkage: readFlag(LINKAGE_KEY),
  clipboard: null,
  replacing: null,
  gap: null,
  tool: 'select',
  panel: 'inspector',
  playbackRate: 1,

  load: (projectId, doc, version, assets, canEdit) =>
    set({
      projectId,
      doc,
      version,
      assets,
      canEdit,
      past: [],
      future: [],
      saveState: 'saved',
      timelineId: doc.timelines.some((t) => t.id === get().timelineId) ? get().timelineId : doc.timelines[0].id,
    }),

  apply: (fn) => {
    const { doc, past, canEdit } = get();
    if (!canEdit) return;
    const next = fn(doc);
    if (next === doc) return;
    set({ doc: next, past: [...past, doc].slice(-HISTORY_LIMIT), future: [], saveState: 'dirty' });
  },

  applyTimeline: (fn) => {
    const id = get().timelineId;
    get().apply((doc) => updateTimeline(doc, id, fn));
  },

  setTimeline: (id) => {
    get().player?.pause();
    set({ timelineId: id, selection: [], gap: null, replacing: null, playhead: 0 });
  },

  preview: (doc) => {
    if (!get().canEdit) return;
    set({ doc, saveState: 'dirty' });
  },

  commitFrom: (base) => {
    const { doc, past } = get();
    if (doc === base) return;
    set({ past: [...past, base].slice(-HISTORY_LIMIT), future: [], saveState: 'dirty' });
  },

  undo: () => {
    const { past, future, doc, canEdit } = get();
    if (!canEdit || past.length === 0) return;
    set({ doc: past[past.length - 1], past: past.slice(0, -1), future: [doc, ...future], saveState: 'dirty' });
  },

  redo: () => {
    const { past, future, doc, canEdit } = get();
    if (!canEdit || future.length === 0) return;
    set({ doc: future[0], future: future.slice(1), past: [...past, doc], saveState: 'dirty' });
  },

  select: (ids) => set({ selection: ids, gap: null }),

  setRipple: (on) => {
    writeFlag(RIPPLE_KEY, on);
    set({ ripple: on });
    // Like CapCut, turning the magnet on closes the main track's gaps.
    if (on) get().applyTimeline((t) => closeMainGaps(t, get().linkage));
  },

  setLinkage: (on) => {
    writeFlag(LINKAGE_KEY, on);
    set({ linkage: on });
  },

  seek: (frame) => {
    const f = Math.max(0, Math.round(frame));
    get().player?.seekTo(f);
    set({ playhead: f });
  },

  setZoom: (pxPerFrame) => set({ pxPerFrame: Math.min(40, Math.max(0.05, pxPerFrame)) }),

  setToast: (toast) => set({ toast }),
}));

/** Where main-track ripples apply: every unlocked track with linkage on, otherwise the main track alone. */
export function rippleScope(t: Timeline, linkage: boolean): string | undefined {
  return linkage ? undefined : mainTrackId(t);
}

function closeMainGaps(t: Timeline, linkage: boolean): Timeline {
  const main = mainTrackId(t);
  return main ? closeGaps(t, main, rippleScope(t, linkage)) : t;
}

/**
 * Delete the selected clips, or close the selected gap.
 * - `lift` leaves a gap.
 * - `auto` (Delete) ripples main-track clips while the magnet is on and lifts
 *   the rest.
 * - `ripple` (X, Shift+Delete) always closes the gap: through the linked
 *   tracks for main-track clips, on their own track for the others.
 */
export function deleteSelection(mode: 'lift' | 'auto' | 'ripple') {
  const s = useEditor.getState();
  if (s.gap) {
    const g = s.gap;
    s.applyTimeline((t) => closeRange(t, g.start, g.end, g.trackId === mainTrackId(t) ? rippleScope(t, s.linkage) : g.trackId));
    useEditor.setState({ gap: null });
    return;
  }
  if (s.selection.length === 0) return;
  const ids = s.selection;
  s.applyTimeline((t) => {
    if (mode === 'lift') return deleteClips(t, ids, false);
    const main = mainTrackId(t);
    const onMain = ids.filter((id) => t.clips.find((c) => c.id === id)?.trackId === main);
    const others = ids.filter((id) => !onMain.includes(id));
    const rippleMain = mode === 'ripple' || s.ripple;
    let next = rippleMain && onMain.length ? rippleDeleteClips(t, onMain, rippleScope(t, s.linkage)) : deleteClips(t, onMain, false);
    next = deleteClips(next, others, mode === 'ripple');
    return next;
  });
}

/** Video clips whose sound can be detached: unmuted, with media. */
export const detachable = (clips: Clip[]) => clips.filter((c) => c.kind === 'video' && !c.muted && c.assetId);

/** Move the sound of the selected video clips onto audio tracks, then select the new audio clips. */
export function detachSelection() {
  const s = useEditor.getState();
  const before = new Set(activeTimeline(s).clips.map((c) => c.id));
  const ids = detachable(selectedClips(s)).map((c) => c.id);
  if (ids.length === 0) return;
  s.applyTimeline((t) => detachAudio(t, ids));
  const added = activeTimeline(useEditor.getState()).clips.filter((c) => !before.has(c.id)).map((c) => c.id);
  if (added.length === 0) return s.setToast('No free audio track: every one is full or locked');
  s.select(added);
  if (added.length < ids.length) s.setToast('Some clips kept their sound: no free audio track');
}

// ---- Clipboard, nudging, enable/disable and navigation ----

/** Copy the selected clips to the clipboard (kept in this tab). */
export function copySelection(): boolean {
  const clips = selectedClips(useEditor.getState());
  if (clips.length === 0) return false;
  useEditor.setState({ clipboard: clips });
  return true;
}

/** Copy, then delete the way Delete does. */
export function cutSelection() {
  if (copySelection()) deleteSelection('auto');
}

/**
 * Put copies of clips with the first at `at`, then select them. Clips from a
 * single track go to `trackId` when given (and it takes them). With the
 * magnet on, copies landing on the main track insert.
 */
function placeCopies(clips: Clip[], at: number, trackId?: string) {
  const s = useEditor.getState();
  const known = new Set(s.assets.map((a) => a.id));
  const target = trackId ? activeTimeline(s).tracks.find((t) => t.id === trackId) : undefined;
  const oneTrack = new Set(clips.map((c) => c.trackId)).size === 1;
  const retrack = target && oneTrack && clips.every((c) => trackAccepts(target, c.kind));
  const copies = clips
    .filter((c) => !c.assetId || known.has(c.assetId))
    .map((c) => ({ ...c, id: newId(), trackId: retrack ? target.id : c.trackId }));
  if (copies.length === 0) return s.setToast('Nothing to paste: the copied media is not in this project');
  s.applyTimeline((t) => {
    const main = mainTrackId(t);
    const insert = s.ripple && copies.some((c) => c.trackId === main) ? { onlyTrack: rippleScope(t, s.linkage) } : undefined;
    const next = pasteClips(t, copies, at, insert);
    return s.ripple ? closeMainGaps(next, s.linkage) : next;
  });
  const placed = new Set(activeTimeline(useEditor.getState()).clips.map((c) => c.id));
  s.select(copies.map((c) => c.id).filter((id) => placed.has(id)));
}

/** Paste the clipboard at a frame (the playhead by default), optionally onto a given track. */
export function pasteClipboard(frame?: number, trackId?: string) {
  const s = useEditor.getState();
  if (s.clipboard?.length) placeCopies(s.clipboard, frame ?? s.playhead, trackId);
}

/** Duplicate the selection right after itself. */
export function duplicateSelection() {
  const clips = selectedClips(useEditor.getState());
  if (clips.length) placeCopies(clips, Math.max(...clips.map(clipEnd)));
}

/** Move the selected clips by `delta` frames. With the magnet on, main-track clips stay put. */
export function nudgeSelection(delta: number) {
  const s = useEditor.getState();
  const t = activeTimeline(s);
  const main = mainTrackId(t);
  const ids = s.selection.filter((id) => !(s.ripple && t.clips.find((c) => c.id === id)?.trackId === main));
  if (ids.length === 0) {
    if (s.selection.length) s.setToast('Main-track clips stay in place while the magnet is on (P)');
    return;
  }
  s.applyTimeline((tl) => moveClips(tl, ids, delta));
}

/** Turn the selected clips off, or back on. */
export function toggleEnabledSelection() {
  const s = useEditor.getState();
  if (s.selection.length) s.applyTimeline((t) => toggleClipsEnabled(t, s.selection));
}

/** Move the playhead to the previous or next clip edge or marker. */
export function seekEdit(dir: -1 | 1) {
  const s = useEditor.getState();
  const t = activeTimeline(s);
  const f = adjacentEditPoint(t, s.playhead, dir);
  if (f !== null) s.seek(Math.min(f, Math.max(0, timelineDuration(t) - 1)));
}

/** Zoom so the whole timeline fits the visible width. */
export function zoomToFit() {
  const s = useEditor.getState();
  const t = activeTimeline(s);
  const scroller = document.querySelector('.timeline-scroll');
  const width = (scroller?.clientWidth ?? 1000) - 180;
  s.setZoom(width / Math.max(t.fps * 5, timelineDuration(t)));
  if (scroller) scroller.scrollLeft = 0;
}

/** Open the replace dialog for swapping a clip's media (dropped onto the clip, or chosen in the inspector). */
export function replaceWithAsset(clipId: string, asset: Asset) {
  useEditor.setState({ replacing: { clipId, assetId: asset.id } });
}

/** The timeline being edited; falls back to the first if the active one was removed. */
export function activeTimeline(state: Pick<EditorState, 'doc' | 'timelineId'>): Timeline {
  return state.doc.timelines.find((t) => t.id === state.timelineId) ?? state.doc.timelines[0];
}

export function selectedClips(state: EditorState): Clip[] {
  return activeTimeline(state).clips.filter((c) => state.selection.includes(c.id));
}

/** Source length in frames for trimming; images and text are unbounded. */
export function sourceFrames(assets: Asset[], fps: number) {
  return (clip: Clip) => {
    if (!clip.assetId) return Infinity;
    const asset = assets.find((a) => a.id === clip.assetId);
    if (!asset || asset.duration === null || asset.kind === 'image') return Infinity;
    return Math.floor(asset.duration * fps);
  };
}
