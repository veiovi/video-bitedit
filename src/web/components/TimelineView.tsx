// Multi-track timeline: ruler, track headers, clips with move/trim by
// pointer, drops from the media bin, snapping, and a playhead. With magnetic
// editing on, trims ripple through every unlocked track.

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  addClip,
  addTrack,
  boundaryNear,
  canReplace,
  clipsFrom,
  closeGaps,
  closeRange,
  gapAt,
  insertClip,
  mainTrackId,
  moveClip,
  moveClips,
  moveMainClip,
  removeTrack,
  rippleTrim,
  setFade,
  snap,
  snapPoints,
  splitAt,
  trimClip,
  updateTimeline,
  updateTrack,
} from '../../shared/edits';
import { type Asset, type Clip, type Timeline, type Track, TRACK_LIMITS, clipEnd, fadeEnvelope, formatTimecode, newId, parseTimecode, timelineDuration, trackAccepts, trackColor } from '../../shared/project';
import { defaultTextStyle, type TextPreset } from '../../shared/themes';
import { peaksUrl, thumbUrl } from '../api';
import { Icon } from './Icon';
import {
  activeTimeline,
  copySelection,
  cutSelection,
  deleteSelection,
  detachSelection,
  detachable,
  duplicateSelection,
  pasteClipboard,
  replaceWithAsset,
  rippleScope,
  sourceFrames,
  toggleEnabledSelection,
  useEditor,
} from '../store';
import { kindOf, uploadFile } from '../upload';
import { HelpTip } from './Help';

export const ASSET_MIME = 'application/x-videdit-asset';
export const TEXT_MIME = 'application/x-videdit-text';
/** Extra drag type naming the asset's kind, so a hover can tell whether it may replace a clip. */
export const assetKindMime = (kind: Asset['kind']) => `application/x-videdit-kind-${kind}`;
/** Track header width; narrower on phones (matches --header-w in styles.css). */
function useHeaderWidth(): number {
  const query = '(max-width: 860px)';
  const [narrow, setNarrow] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow ? 92 : 168;
}
const ROW_H = { video: 56, audio: 44 } as const;

type DraggedKind = Asset['kind'] | 'text';

/** What is being dragged in: a bin asset, a text preset, or one or more files from the desktop. */
function draggedKind(dt: DataTransfer): { kind: DraggedKind | null; files: number } {
  if (dt.types.includes(TEXT_MIME)) return { kind: 'text', files: 0 };
  const tagged = dt.types.find((t) => t.startsWith('application/x-videdit-kind-'));
  if (tagged) return { kind: tagged.slice('application/x-videdit-kind-'.length) as Asset['kind'], files: 0 };
  if (dt.types.includes('Files')) {
    const items = [...dt.items].filter((i) => i.kind === 'file');
    const type = items[0]?.type ?? '';
    const kind = type.startsWith('video/') ? 'video' : type.startsWith('audio/') ? 'audio' : type.startsWith('image/') ? 'image' : null;
    return { kind, files: items.length };
  }
  return { kind: null, files: 0 };
}

/**
 * Where a drop lands, following CapCut: onto a clip of the same family opens
 * the replace dialog; onto the main track with the magnet on it inserts at
 * the nearest clip edge and pushes the rest right; anywhere else it places
 * the clip, overwriting what is there.
 */
interface DropTarget {
  mode: 'place' | 'insert' | 'replace';
  trackId: string;
  frame: number;
  clipId?: string;
}
const SNAP_PX = 10;

/** Build a clip for an asset (or a text preset) placed at `start` on `track`. */
export function clipFor(
  asset: Asset | null,
  track: Track,
  start: number,
  timeline: Timeline,
  theme: string | undefined,
  preset: TextPreset = 'title',
): Clip | null {
  const fps = timeline.fps;
  if (!asset) {
    if (track.kind !== 'video') return null;
    const style = defaultTextStyle({ theme }, preset);
    const label = preset === 'title' ? 'Title' : preset === 'caption' ? 'Caption text' : 'Name · Role';
    return { id: newId(), kind: 'text', trackId: track.id, start, duration: fps * 3, text: { ...style, text: label } };
  }
  if (!trackAccepts(track, asset.kind)) return null;
  const vertical = timeline.height > timeline.width;
  const duration = asset.kind === 'image' ? fps * 4 : Math.max(1, Math.floor((asset.duration ?? 4) * fps));
  return {
    id: newId(),
    kind: asset.kind,
    trackId: track.id,
    start,
    duration,
    assetId: asset.id,
    in: asset.kind === 'image' ? undefined : 0,
    fit: asset.kind !== 'audio' && vertical ? 'cover' : undefined,
  };
}

function rulerStep(pxPerFrame: number, fps: number): number {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
  for (const s of steps) if (s * fps * pxPerFrame >= 80) return s;
  return 3600;
}

const Ruler = memo(function Ruler({ width, fps, pxPerFrame }: { width: number; fps: number; pxPerFrame: number }) {
  const step = rulerStep(pxPerFrame, fps);
  const ticks: number[] = [];
  for (let sec = 0; sec * fps * pxPerFrame < width; sec += step) ticks.push(sec);
  return (
    <>
      {ticks.map((sec) => (
        <div key={sec} className="tick" style={{ left: sec * fps * pxPerFrame }}>
          <span>{formatTimecode(sec * fps, fps).replace(/:00$/, '')}</span>
        </div>
      ))}
    </>
  );
});

function Playhead({ height }: { height: number }) {
  const playhead = useEditor((s) => s.playhead);
  const px = useEditor((s) => s.pxPerFrame);
  return <div className="playhead" style={{ transform: `translateX(${playhead * px}px)`, height }} />;
}

interface DragState {
  kind: 'move' | 'trim-start' | 'trim-end' | 'fade-in' | 'fade-out';
  clipId: string;
  pointerX: number;
  pointerY: number;
  baseDoc: ReturnType<typeof useEditor.getState>['doc'];
  baseTimeline: Timeline;
  baseClip: Clip;
  /** Clips moved together (a multi-selection); the dragged clip snaps for all of them. */
  group: string[];
  moved: boolean;
  /** ⌥-drag: the clips being moved are fresh copies, and the originals stay. */
  duplicate: boolean;
}

/** A right-click menu on a clip (acting on the selection) or on empty track space. */
interface MenuState {
  x: number;
  y: number;
  frame: number;
  onClip: boolean;
  /** The track under the pointer, for pasting onto it. */
  trackId?: string;
}

export function TimelineView({ comments }: { comments: { frame: number; id: string }[] }) {
  const doc = useEditor((s) => s.doc);
  const timelineId = useEditor((s) => s.timelineId);
  const timeline = activeTimeline({ doc, timelineId });
  const assets = useEditor((s) => s.assets);
  const selection = useEditor((s) => s.selection);
  const px = useEditor((s) => s.pxPerFrame);
  const canEdit = useEditor((s) => s.canEdit);
  const snapping = useEditor((s) => s.snapping);
  const ripple = useEditor((s) => s.ripple);
  const linkage = useEditor((s) => s.linkage);
  const gap = useEditor((s) => s.gap);
  const tool = useEditor((s) => s.tool);
  const projectId = useEditor((s) => s.projectId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const tracksRef = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState | null>(null);
  const volumeBase = useRef<typeof doc | null>(null);
  const [dropHint, setDropHint] = useState<DropTarget | null>(null);
  /** Box selection on empty timeline space, in pixels relative to the tracks area. */
  const marquee = useRef<{ x: number; y: number; additive: boolean; base: string[] } | null>(null);
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  /** Holding ⌘/Ctrl during a drag turns snapping off, like CapCut. */
  const noSnap = useRef(false);
  /** While dragging: a readout of the new position, length or fade, and the snap line. */
  const [hud, setHud] = useState<{ x: number; y: number; text: string } | null>(null);
  const [guide, setGuide] = useState<number | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const mainId = mainTrackId(timeline);
  const HEADER_W = useHeaderWidth();

  const duration = timelineDuration(timeline);
  const contentWidth = Math.max((duration + timeline.fps * 20) * px, (scrollRef.current?.clientWidth ?? 1200) - HEADER_W);
  const assetById = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);
  const totalHeight = timeline.tracks.reduce((h, t) => h + ROW_H[t.kind], 0);
  // Every second audio track gets the alternate clip colour (voice vs music in the skins).
  const colors = new Map(
    timeline.tracks.map((t) => [t.id, trackColor(t, timeline.tracks.filter((x) => x.kind === t.kind).indexOf(t))]),
  );
  const tint = (id: string) => ({ '--tc': colors.get(id) }) as React.CSSProperties;

  // Keep the playhead in view while playing.
  useEffect(
    () =>
      useEditor.subscribe((s, prev) => {
        if (s.playhead === prev.playhead || !s.playing || !scrollRef.current) return;
        const el = scrollRef.current;
        const x = s.playhead * s.pxPerFrame;
        const view = el.clientWidth - HEADER_W;
        if (x > el.scrollLeft + view - 40 || x < el.scrollLeft) el.scrollLeft = Math.max(0, x - view * 0.2);
      }),
    [HEADER_W],
  );

  // ⌘/Ctrl + wheel (or a trackpad pinch) zooms around the pointer.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const s = useEditor.getState();
      const x = e.clientX - el.getBoundingClientRect().left - HEADER_W;
      const frame = (el.scrollLeft + x) / s.pxPerFrame;
      s.setZoom(s.pxPerFrame * Math.exp(-Math.max(-50, Math.min(50, e.deltaY)) * 0.01));
      requestAnimationFrame(() => (el.scrollLeft = Math.max(0, frame * useEditor.getState().pxPerFrame - x)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [HEADER_W]);

  // The menu closes on Escape, on scrolling, and on a press anywhere outside it.
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e.type === 'pointerdown' && (e.target as HTMLElement).closest('.context-menu')) return;
      setMenu(null);
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', close, true);
    window.addEventListener('wheel', close, true);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', close, true);
      window.removeEventListener('wheel', close, true);
    };
  }, [menu]);

  function frameAt(clientX: number): number {
    const rect = tracksRef.current!.getBoundingClientRect();
    return Math.max(0, Math.round((clientX - rect.left) / px));
  }

  function trackAt(clientY: number): Track | undefined {
    const rect = tracksRef.current!.getBoundingClientRect();
    let y = clientY - rect.top;
    for (const t of timeline.tracks) {
      y -= ROW_H[t.kind];
      if (y < 0) return t;
    }
    return undefined;
  }

  function snapFrame(frame: number, exclude: string[]): number {
    if (!snapping || noSnap.current) return frame;
    // Mid-drag, snap to the timeline as it was, not to the preview the dragged clip has already carved into.
    const pts = [...snapPoints(drag.current?.baseTimeline ?? timeline, exclude), useEditor.getState().playhead];
    return snap(frame, pts, SNAP_PX / px);
  }

  function startDrag(e: React.PointerEvent, kind: DragState['kind'], clip: Clip, group: string[]) {
    const state = useEditor.getState();
    if (!state.canEdit) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    let base = activeTimeline(state);
    // ⌥-drag moves copies and leaves the originals where they are.
    const duplicate = kind === 'move' && e.altKey;
    if (duplicate) {
      const copyOf = new Map(group.map((id) => [id, newId()]));
      base = { ...base, clips: [...base.clips, ...base.clips.filter((c) => copyOf.has(c.id)).map((c) => ({ ...c, id: copyOf.get(c.id)! }))] };
      clip = { ...clip, id: copyOf.get(clip.id)! };
      group = group.map((id) => copyOf.get(id)!);
    }
    drag.current = {
      kind,
      clipId: clip.id,
      pointerX: e.clientX,
      pointerY: e.clientY,
      baseDoc: state.doc,
      baseTimeline: base,
      baseClip: clip,
      group,
      moved: false,
      duplicate,
    };
  }

  /**
   * Select-forward/backward tools (] and [): everything from `frame` to the
   * right, or everything before it (Shift: this track only), ready to drag.
   */
  function selectSide(e: React.PointerEvent, frame: number, trackId: string | undefined, clicked?: Clip) {
    const state = useEditor.getState();
    const t = activeTimeline(state);
    const only = e.shiftKey ? trackId : undefined;
    const ids =
      state.tool === 'backward'
        ? t.clips.filter((c) => c.start < frame && (!only || c.trackId === only)).map((c) => c.id)
        : clipsFrom(t, frame, only);
    if (clicked && !ids.includes(clicked.id)) ids.push(clicked.id);
    state.select(ids);
    const anchor = clicked ?? t.clips.filter((c) => ids.includes(c.id)).sort((a, b) => a.start - b.start)[0];
    if (anchor) startDrag(e, 'move', anchor, ids);
  }

  function onClipPointerDown(e: React.PointerEvent, clip: Clip, kind: DragState['kind']) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const state = useEditor.getState();
    if (state.tool === 'razor' && state.canEdit) {
      const at = snapFrame(frameAt(e.clientX), [clip.id]);
      state.applyTimeline((t) => splitAt(t, at, [clip.id]));
      return;
    }
    if ((state.tool === 'forward' || state.tool === 'backward') && kind === 'move') {
      selectSide(e, state.tool === 'forward' ? clip.start : clip.start + clip.duration, clip.trackId, clip);
      return;
    }
    if (e.shiftKey || e.metaKey) {
      state.select(state.selection.includes(clip.id) ? state.selection.filter((id) => id !== clip.id) : [...state.selection, clip.id]);
      return;
    }
    if (!state.selection.includes(clip.id)) state.select([clip.id]);
    // Dragging one clip of a multi-selection moves the whole selection.
    const group = kind === 'move' && state.selection.includes(clip.id) && state.selection.length > 1 ? state.selection : [clip.id];
    startDrag(e, kind, clip, group);
  }

  function onLanePointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    const state = useEditor.getState();
    const frame = frameAt(e.clientX);
    const track = trackAt(e.clientY);
    if (state.tool === 'forward' || state.tool === 'backward') {
      selectSide(e, frame, track?.id);
      return;
    }
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    if (!additive) {
      state.select([]);
      state.seek(frame);
      // Clicking empty space between main-track clips selects that gap, so Delete can close it.
      // Overlay and audio tracks are free placement: their gaps are deliberate timing, so a stray
      // click there must not arm a Delete that would slide every later cutaway out of sync.
      const t = activeTimeline(state);
      const g = track && track.id === mainTrackId(t) ? gapAt(t, track.id, frame) : null;
      if (g && track && !track.locked) useEditor.setState({ gap: { trackId: track.id, ...g } });
    }
    // Dragging from here draws a selection box.
    const rect = tracksRef.current!.getBoundingClientRect();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    marquee.current = { x: e.clientX - rect.left, y: e.clientY - rect.top, additive, base: additive ? state.selection : [] };
  }

  /** Clips inside a selection box (pixels relative to the tracks area). */
  function clipsInBox(b: { x: number; y: number; w: number; h: number }): string[] {
    const t = activeTimeline(useEditor.getState());
    const f0 = b.x / px;
    const f1 = (b.x + b.w) / px;
    let top = 0;
    const rows = new Map<string, [number, number]>();
    for (const tr of t.tracks) {
      rows.set(tr.id, [top, top + ROW_H[tr.kind]]);
      top += ROW_H[tr.kind];
    }
    return t.clips
      .filter((c) => {
        const [r0, r1] = rows.get(c.trackId) ?? [0, 0];
        return c.start < f1 && c.start + c.duration > f0 && r0 < b.y + b.h && r1 > b.y;
      })
      .map((c) => c.id);
  }

  function onPointerMove(e: React.PointerEvent) {
    noSnap.current = e.metaKey || e.ctrlKey;
    const m = marquee.current;
    if (m && !drag.current) {
      const rect = tracksRef.current!.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (!box && Math.abs(x - m.x) < 4 && Math.abs(y - m.y) < 4) return;
      const b = { x: Math.min(x, m.x), y: Math.min(y, m.y), w: Math.abs(x - m.x), h: Math.abs(y - m.y) };
      setBox(b);
      useEditor.setState({ gap: null });
      useEditor.getState().select([...new Set([...m.base, ...clipsInBox(b)])]);
      return;
    }
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.pointerX) / px;
    if (!d.moved && Math.abs(e.clientX - d.pointerX) < 3 && Math.abs(e.clientY - d.pointerY) < 3) return;
    d.moved = true;
    const state = useEditor.getState();
    const lengths = sourceFrames(state.assets, d.baseTimeline.fps);
    let next: Timeline;
    const base = d.baseTimeline;
    const main = mainTrackId(base);
    const magnet = state.ripple && main !== undefined;
    const scope = rippleScope(base, state.linkage);
    // Main-track trims ripple while the magnet is on (through the linked tracks); other tracks just trim.
    const trim: typeof trimClip =
      magnet && d.baseClip.trackId === main ? (t, id, edge, f, len) => rippleTrim(t, id, edge, f, len, scope) : trimClip;
    // With the magnet on, the main track never keeps a gap.
    const gapless = (t: Timeline) => (magnet ? closeGaps(t, main!, scope) : t);
    let snapLine: number | null = null;
    if (d.kind === 'move') {
      const rawStart = d.baseClip.start + dx;
      const rawEnd = rawStart + d.baseClip.duration;
      // Snap by whichever edge found a snap point, the closer one if both did.
      const snappedStart = snapFrame(rawStart, d.group);
      const snappedEnd = snapFrame(rawEnd, d.group);
      const startHit = snappedStart !== rawStart;
      const endHit = snappedEnd !== rawEnd;
      const byStart = startHit && (!endHit || Math.abs(snappedStart - rawStart) <= Math.abs(snappedEnd - rawEnd));
      const start = byStart ? snappedStart : endHit ? snappedEnd - d.baseClip.duration : rawStart;
      if (byStart || endHit) snapLine = byStart ? snappedStart : snappedEnd;
      const track = trackAt(e.clientY);
      const targetId = track && trackAccepts(track, d.baseClip.kind) && !track.locked ? track.id : d.baseClip.trackId;
      if (d.group.length > 1) {
        next = gapless(moveClips(base, d.group, start - d.baseClip.start));
      } else if (magnet && d.baseClip.trackId === main && targetId === main && !d.duplicate) {
        // Reorder on the main track: the clip lands on the nearest clip edge, carrying its linked clips.
        next = moveMainClip(base, d.clipId, start, state.linkage);
      } else if (magnet && targetId === main) {
        // Onto the main track from elsewhere: insert at the nearest edge.
        const without = { ...base, clips: base.clips.filter((c) => c.id !== d.clipId) };
        next = insertClip(without, { ...d.baseClip, trackId: main!, start: boundaryNear(without, main!, start) }, scope);
      } else {
        next = gapless(moveClip(base, d.clipId, start, targetId));
      }
    } else if (d.kind === 'fade-in' || d.kind === 'fade-out') {
      const c = d.baseClip;
      next = d.kind === 'fade-in' ? setFade(base, c.id, 'in', (c.fadeIn ?? 0) + dx) : setFade(base, c.id, 'out', (c.fadeOut ?? 0) - dx);
    } else {
      const raw = d.kind === 'trim-start' ? d.baseClip.start + dx : clipEnd(d.baseClip) + dx;
      const edge = snapFrame(raw, [d.clipId]);
      if (edge !== raw) snapLine = edge;
      next = trim(d.baseTimeline, d.clipId, d.kind === 'trim-start' ? 'start' : 'end', edge, lengths);
    }
    state.preview(updateTimeline(d.baseDoc, d.baseTimeline.id, () => next));
    setGuide(snapLine);
    const rect = tracksRef.current!.getBoundingClientRect();
    setHud({ x: e.clientX - rect.left, y: e.clientY - rect.top, text: dragReadout(d, next) });
  }

  /** What the readout says while dragging: where the clip now starts, its new length, or the fade. */
  function dragReadout(d: DragState, t: Timeline): string {
    const c = t.clips.find((x) => x.id === d.clipId) ?? d.baseClip;
    const fps = t.fps;
    const secs = (f: number) => `${f < 0 ? '−' : '+'}${(Math.abs(f) / fps).toFixed(2)}s`;
    if (d.kind === 'fade-in') return `Fade in ${((c.fadeIn ?? 0) / fps).toFixed(2)}s`;
    if (d.kind === 'fade-out') return `Fade out ${((c.fadeOut ?? 0) / fps).toFixed(2)}s`;
    if (d.kind === 'move') return `${d.duplicate ? 'Copy at ' : ''}${formatTimecode(c.start, fps)}  ${secs(c.start - d.baseClip.start)}`;
    return `Length ${(c.duration / fps).toFixed(2)}s  ${secs(c.duration - d.baseClip.duration)}`;
  }

  function onPointerUp() {
    marquee.current = null;
    setBox(null);
    setHud(null);
    setGuide(null);
    noSnap.current = false;
    const d = drag.current;
    drag.current = null;
    if (!d?.moved) return;
    useEditor.getState().commitFrom(d.baseDoc);
    if (d.duplicate) useEditor.getState().select(d.group.filter((id) => activeTimeline(useEditor.getState()).clips.some((c) => c.id === id)));
  }

  function openMenu(e: React.MouseEvent, clip?: Clip) {
    e.preventDefault();
    const state = useEditor.getState();
    if (!state.canEdit) return;
    if (clip && !state.selection.includes(clip.id)) state.select([clip.id]);
    setMenu({ x: e.clientX, y: e.clientY, frame: frameAt(e.clientX), onClip: Boolean(clip), trackId: trackAt(e.clientY)?.id });
  }

  function onRulerPointer(e: React.PointerEvent) {
    if (e.type === 'pointerdown') (e.target as HTMLElement).setPointerCapture(e.pointerId);
    if (e.buttons !== 1) return;
    useEditor.getState().seek(frameAt(e.clientX));
  }

  function dropTarget(e: React.DragEvent): DropTarget | null {
    const { kind, files } = draggedKind(e.dataTransfer);
    const t = activeTimeline(useEditor.getState());
    const track = trackAt(e.clientY);
    if (!track || track.locked) return null;
    const frame = frameAt(e.clientX);
    const under = t.clips.find((c) => c.trackId === track.id && c.start <= frame && frame < clipEnd(c));
    // The middle of a clip means "replace"; its outer fifth (at least 12 px) means "insert at this edge".
    const edge = Math.max(12 / px, under ? under.duration * 0.2 : 0);
    const inMiddle = under && frame - under.start >= edge && clipEnd(under) - frame >= edge;
    if (under && inMiddle && kind && kind !== 'text' && files <= 1 && canReplace(under, kind)) {
      return { mode: 'replace', trackId: track.id, frame: under.start, clipId: under.id };
    }
    const state = useEditor.getState();
    if (state.ripple && track.id === mainTrackId(t) && kind !== 'text') {
      return { mode: 'insert', trackId: track.id, frame: boundaryNear(t, track.id, frame) };
    }
    return { mode: 'place', trackId: track.id, frame: snapFrame(frame, []) };
  }

  function onDragOver(e: React.DragEvent) {
    noSnap.current = e.metaKey || e.ctrlKey;
    const types = e.dataTransfer.types;
    if (!canEdit || !(types.includes(ASSET_MIME) || types.includes(TEXT_MIME) || types.includes('Files'))) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const target = dropTarget(e);
    setDropHint((prev) =>
      prev && target && prev.mode === target.mode && prev.trackId === target.trackId && prev.frame === target.frame ? prev : target,
    );
  }

  /** Put an asset on the timeline at a drop target. Returns the frame after it, for the next file. */
  function dropAsset(asset: Asset | null, preset: TextPreset | '', target: DropTarget): number {
    const state = useEditor.getState();
    if (target.mode === 'replace' && target.clipId && asset) {
      replaceWithAsset(target.clipId, asset);
      state.select([target.clipId]);
      return target.frame;
    }
    const t = activeTimeline(state);
    const kind = asset ? asset.kind : 'text';
    let track = t.tracks.find((x) => x.id === target.trackId);
    if (!track || !trackAccepts(track, kind)) track = t.tracks.find((x) => trackAccepts(x, kind) && !x.locked);
    if (!track) return target.frame;
    const clip = clipFor(asset, track, target.frame, t, state.doc.theme, preset || 'title');
    if (!clip) return target.frame;
    state.applyTimeline((tl) => (target.mode === 'insert' ? insertClip(tl, clip, rippleScope(tl, state.linkage)) : addClip(tl, clip)));
    state.select([clip.id]);
    return clip.start + clip.duration;
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDropHint(null);
    const target = dropTarget(e);
    if (!target) return;
    const files = [...e.dataTransfer.files].filter((f) => kindOf(f));
    if (files.length) {
      // Desktop files upload first, then land where they were dropped, one after another.
      const projectId = useEditor.getState().projectId;
      void (async () => {
        let next = target;
        for (const file of files) {
          const asset = await uploadFile(projectId, file);
          if (!asset) continue;
          const end = dropAsset(asset, '', next);
          next = { ...next, mode: next.mode === 'replace' ? 'place' : next.mode, frame: end, clipId: undefined };
        }
      })();
      return;
    }
    const assetId = e.dataTransfer.getData(ASSET_MIME);
    const asset = assetId ? (assetById.get(assetId) ?? null) : null;
    if (assetId && !asset) return;
    dropAsset(asset, e.dataTransfer.getData(TEXT_MIME) as TextPreset, target);
  }

  const setTrack = (trackId: string, patch: Partial<Track>) => useEditor.getState().applyTimeline((t) => updateTrack(t, trackId, patch));

  const playhead = useEditor((s) => s.playhead);
  const videoCount = timeline.tracks.filter((t) => t.kind === 'video').length;
  const audioCount = timeline.tracks.filter((t) => t.kind === 'audio').length;
  const canDetach = detachable(timeline.clips.filter((c) => selection.includes(c.id))).length > 0;

  return (
    <div className={`timeline panel tool-${tool}`}>
      <div className="timeline-toolbar">
        <span className="panel-num">04</span>
        <h2 className="timeline-title">Timeline</h2>
        <HelpTip id="timeline" />
        <div className="tool-group tools">
          <button className={tool === 'select' ? 'on' : ''} title="Select and move (V)" onClick={() => useEditor.setState({ tool: 'select' })}>
            <Icon name="pointer" />
          </button>
          <button
            className={tool === 'razor' ? 'on' : ''}
            disabled={!canEdit}
            title="Razor: click a clip to cut it (C)"
            onClick={() => useEditor.setState({ tool: 'razor' })}
          >
            <Icon name="razor" />
          </button>
          <button
            className={tool === 'backward' ? 'on' : ''}
            disabled={!canEdit}
            title="Select backward: click to select everything to the left, then drag it ([; Shift-click for one track)"
            onClick={() => useEditor.setState({ tool: 'backward' })}
          >
            <Icon name="backward" />
          </button>
          <button
            className={tool === 'forward' ? 'on' : ''}
            disabled={!canEdit}
            title="Select forward: click to select everything to the right, then drag it (]; Shift-click for one track)"
            onClick={() => useEditor.setState({ tool: 'forward' })}
          >
            <Icon name="forward" />
          </button>
          <button
            className={ripple ? 'on' : ''}
            title={`Main track magnet ${ripple ? 'on' : 'off'} (P): V1 stays gapless; drops insert, moves reorder, trims and deletes close up`}
            onClick={() => useEditor.getState().setRipple(!ripple)}
          >
            <Icon name="magnet" />
          </button>
          <button
            className={linkage ? 'on' : ''}
            title={`Linkage ${linkage ? 'on' : 'off'} (\`): captions and overlays follow main-track edits`}
            onClick={() => useEditor.getState().setLinkage(!linkage)}
          >
            <Icon name="link" />
          </button>
          <button
            className={snapping ? 'on' : ''}
            title={`Snapping ${snapping ? 'on' : 'off'} (N)`}
            onClick={() => useEditor.setState((s) => ({ snapping: !s.snapping }))}
          >
            <Icon name="snap" />
          </button>
        </div>
        <HelpTip id="tools" />
        <div className="tool-group">
          <button disabled={!canEdit} title="Undo (⌘Z)" onClick={() => useEditor.getState().undo()}>
            <Icon name="undo" />
          </button>
          <button disabled={!canEdit} title="Redo (⇧⌘Z)" onClick={() => useEditor.getState().redo()}>
            <Icon name="redo" />
          </button>
        </div>
        <div className="tool-group edit-tools">
          <button
            disabled={!canEdit}
            title="Split at playhead (S)"
            onClick={() => {
              const s = useEditor.getState();
              s.applyTimeline((t) => splitAt(t, s.playhead, s.selection.length ? s.selection : undefined));
            }}
          >
            Split
          </button>
          <button
            disabled={!canEdit || selection.length === 0}
            title="Delete, leaving a gap (Z)"
            onClick={() => deleteSelection('lift')}
          >
            Lift
          </button>
          <button
            disabled={!canEdit || (selection.length === 0 && !gap)}
            title={
              'Delete and close the gap (X / Shift+Delete): main-track clips through the linked tracks, others on their own track. With a gap selected, close it'
            }
            onClick={() => deleteSelection('ripple')}
          >
            {gap ? 'Close gap' : 'Ripple delete'}
          </button>
          <button
            disabled={!canEdit || !canDetach}
            title="Detach audio: move the selected video clips' sound to its own clip on an audio track, to trim and fade it separately"
            onClick={detachSelection}
          >
            Detach audio
          </button>
        </div>
        <div className="tool-group track-tools">
          <button
            disabled={!canEdit || videoCount >= TRACK_LIMITS.video}
            onClick={() => useEditor.getState().applyTimeline((t) => addTrack(t, 'video'))}
          >
            + Video
          </button>
          <button
            disabled={!canEdit || audioCount >= TRACK_LIMITS.audio}
            onClick={() => useEditor.getState().applyTimeline((t) => addTrack(t, 'audio'))}
          >
            + Audio
          </button>
        </div>
        <div className="tool-group grow" />
        <TimecodeJump playhead={playhead} duration={duration} fps={timeline.fps} />
        <div className="tool-group zoom">
          <button title="Zoom out (-)" onClick={() => useEditor.getState().setZoom(px / 1.5)}>
            <Icon name="minus" />
          </button>
          <input
            type="range"
            min={-4}
            max={3.6}
            step={0.01}
            value={Math.log2(px)}
            onChange={(e) => useEditor.getState().setZoom(2 ** Number(e.target.value))}
            aria-label="Zoom"
          />
          <button title="Zoom in (=)" onClick={() => useEditor.getState().setZoom(px * 1.5)}>
            <Icon name="plus" />
          </button>
        </div>
      </div>

      <div className="timeline-scroll" ref={scrollRef}>
        <div className="timeline-grid" style={{ width: HEADER_W + contentWidth }}>
          <div className="ruler-row">
            <div className="corner" style={{ width: HEADER_W }} />
            <div
              className="ruler"
              style={{ width: contentWidth }}
              onPointerDown={onRulerPointer}
              onPointerMove={onRulerPointer}
            >
              <Ruler width={contentWidth} fps={timeline.fps} pxPerFrame={px} />
              {timeline.markers.map((m) => (
                <div
                  key={m.id}
                  className="marker"
                  style={{ left: m.frame * px }}
                  title={`${m.label}: click to jump here${canEdit ? ', double-click to remove' : ''}`}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    useEditor.getState().seek(m.frame);
                  }}
                  onDoubleClick={() => useEditor.getState().applyTimeline((t) => ({ ...t, markers: t.markers.filter((x) => x.id !== m.id) }))}
                />
              ))}
              {comments.map((c) => (
                <div key={c.id} className="comment-pin" style={{ left: c.frame * px }} />
              ))}
            </div>
          </div>
          <div className="tracks-row">
            <div className="track-headers" style={{ width: HEADER_W }}>
              {timeline.tracks.map((t) => (
                <div key={t.id} className={`track-header ${t.kind}`} style={{ height: ROW_H[t.kind], ...tint(t.id) }}>
                  <span
                    className={`track-badge ${t.kind} ${t.id === mainId ? 'main' : ''}`}
                    title={t.id === mainId ? 'Main track: the magnet keeps it gapless' : undefined}
                  >
                    {t.name}
                  </span>
                  <span className="track-label">{t.kind === 'video' ? 'Video' : 'Audio'}</span>
                  <div className="track-buttons">
                    {t.kind === 'video' ? (
                      <button
                        className={t.hidden ? 'on warn' : ''}
                        title={t.hidden ? 'Show track' : 'Hide track'}
                        disabled={!canEdit}
                        onClick={() => setTrack(t.id, { hidden: !t.hidden })}
                      >
                        <Icon name={t.hidden ? 'eye-off' : 'eye'} />
                      </button>
                    ) : (
                      <button
                        className={t.muted ? 'on warn' : ''}
                        title={t.muted ? 'Unmute track' : 'Mute track'}
                        disabled={!canEdit}
                        onClick={() => setTrack(t.id, { muted: !t.muted })}
                      >
                        <Icon name={t.muted ? 'mute' : 'speaker'} />
                      </button>
                    )}
                    <button
                      className={t.locked ? 'on' : ''}
                      title={t.locked ? 'Unlock track' : 'Lock track'}
                      disabled={!canEdit}
                      onClick={() => setTrack(t.id, { locked: !t.locked })}
                    >
                      <Icon name={t.locked ? 'lock' : 'unlock'} />
                    </button>
                    {canEdit && timeline.tracks.filter((x) => x.kind === t.kind).length > 1 && (
                      <button
                        className="remove-track"
                        title="Remove track and its clips"
                        onClick={() => {
                          const n = timeline.clips.filter((c) => c.trackId === t.id).length;
                          if (n === 0 || confirm(`Remove ${t.name} and its ${n} clip(s)?`)) {
                            useEditor.getState().applyTimeline((tl) => removeTrack(tl, t.id));
                          }
                        }}
                      >
                        <Icon name="close" />
                      </button>
                    )}
                  </div>
                  <input
                    className="track-volume"
                    type="range"
                    min={0}
                    max={2}
                    step={0.01}
                    value={t.volume ?? 1}
                    disabled={!canEdit}
                    title={`Track volume ${Math.round((t.volume ?? 1) * 100)}%`}
                    onChange={(e) =>
                      useEditor.getState().preview(
                        updateTimeline(useEditor.getState().doc, timeline.id, (tl) => updateTrack(tl, t.id, { volume: Number(e.target.value) })),
                      )
                    }
                    onPointerDown={() => (volumeBase.current = useEditor.getState().doc)}
                    onPointerUp={() => {
                      if (volumeBase.current) useEditor.getState().commitFrom(volumeBase.current);
                      volumeBase.current = null;
                    }}
                  />
                </div>
              ))}
            </div>
            <div
              className="tracks"
              ref={tracksRef}
              style={{ width: contentWidth, height: totalHeight }}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerDown={(e) => {
                const el = e.target as HTMLElement;
                // Empty lane space (including a selected gap) seeks, selects gaps and starts a selection box.
                if (el === e.currentTarget || el.classList.contains('track-lane') || el.classList.contains('gap')) onLanePointerDown(e);
              }}
              onDoubleClick={(e) => {
                const g = useEditor.getState().gap;
                if (g && (e.target as HTMLElement).classList.contains('gap')) {
                  useEditor.getState().applyTimeline((t) => closeRange(t, g.start, g.end, g.trackId === mainTrackId(t) ? rippleScope(t, linkage) : g.trackId));
                  useEditor.setState({ gap: null });
                }
              }}
              onContextMenu={(e) => {
                const el = e.target as HTMLElement;
                if (el === e.currentTarget || el.classList.contains('track-lane') || el.classList.contains('gap')) openMenu(e);
              }}
              onDragOver={onDragOver}
              onDragLeave={(e) => {
                // Moving over a clip fires dragleave on the lane; only clear when leaving the timeline.
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropHint(null);
              }}
              onDrop={onDrop}
            >
              {timeline.tracks.map((t) => (
                <div
                  key={t.id}
                  className={`track-lane ${t.kind} ${t.locked ? 'locked' : ''} ${dropHint?.trackId === t.id ? 'drop' : ''}`}
                  style={{ height: ROW_H[t.kind], ...tint(t.id) }}
                >
                  {timeline.clips
                    .filter((c) => c.trackId === t.id)
                    .map((c) => (
                      <ClipView
                        key={c.id}
                        clip={c}
                        asset={c.assetId ? assetById.get(c.assetId) : undefined}
                        px={px}
                        fps={timeline.fps}
                        selected={selection.includes(c.id)}
                        thumb={c.assetId && assetById.get(c.assetId)?.hasThumb ? thumbUrl(projectId, c.assetId) : undefined}
                        dimmed={Boolean(t.muted || t.hidden)}
                        projectId={projectId}
                        onPointerDown={onClipPointerDown}
                        onContextMenu={openMenu}
                      />
                    ))}
                  {gap?.trackId === t.id && (
                    <div
                      className="gap"
                      style={{ left: gap.start * px, width: (gap.end - gap.start) * px }}
                      title="Gap: press Delete or double-click to close it"
                    />
                  )}
                  {dropHint?.trackId === t.id && dropHint.mode === 'replace' && (() => {
                    const target = timeline.clips.find((c) => c.id === dropHint.clipId);
                    return target ? (
                      <div className="replace-target" style={{ left: target.start * px, width: target.duration * px }}>
                        <span>Replace</span>
                      </div>
                    ) : null;
                  })()}
                  {dropHint?.trackId === t.id && dropHint.mode !== 'replace' && (
                    <div className={`drop-line ${dropHint.mode}`} style={{ left: dropHint.frame * px }} />
                  )}
                </div>
              ))}
              {box && <div className="marquee" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} />}
              {guide !== null && <div className="snap-line" style={{ left: guide * px }} />}
              {hud && (
                <div className="drag-readout" style={{ left: hud.x, top: hud.y }}>
                  {hud.text}
                </div>
              )}
              <Playhead height={totalHeight} />
            </div>
          </div>
        </div>
      </div>
      {menu && <ClipMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** Jump the playhead by typing a time into the timecode (12.5, 1:05, 00:12:15, or +2 / -2 relative). */
function TimecodeJump({ playhead, duration, fps }: { playhead: number; duration: number; fps: number }) {
  const [text, setText] = useState<string | null>(null);
  if (text === null) {
    return (
      <button className="timecode jump" title="Type a time to jump to: 12.5, 1:05, 00:12:15, or +2 / -2" onClick={() => setText(formatTimecode(playhead, fps))}>
        {formatTimecode(playhead, fps)} <span className="muted">/ {formatTimecode(duration, fps)}</span>
      </button>
    );
  }
  const jump = () => {
    const f = parseTimecode(text, fps, playhead);
    if (f === null) useEditor.getState().setToast(`Not a time: "${text}". Try 12.5, 1:05 or 00:12:15`);
    else useEditor.getState().seek(Math.min(f, Math.max(0, duration - 1)));
    setText(null);
  };
  return (
    <input
      className="timecode timecode-input"
      aria-label="Jump to time"
      autoFocus
      value={text}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') jump();
        if (e.key === 'Escape') setText(null);
      }}
      onBlur={() => setText(null)}
    />
  );
}

/** Right-click menu: clip actions on the selection, or paste and markers on empty track space. */
function ClipMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const s = useEditor.getState();
  const t = activeTimeline(s);
  const picked = t.clips.filter((c) => s.selection.includes(c.id));
  const canSplit = picked.some((c) => c.start < s.playhead && s.playhead < clipEnd(c));
  const allOff = picked.length > 0 && picked.every((c) => c.disabled);
  const item = (label: string, keys: string, run: () => void, disabled = false) => (
    <button
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        onClose();
        run();
      }}
    >
      <span>{label}</span>
      <kbd>{keys}</kbd>
    </button>
  );
  // Keep the menu on screen.
  const left = Math.min(menu.x, window.innerWidth - 230);
  const top = Math.min(menu.y, window.innerHeight - (menu.onClip ? 330 : 90));
  return (
    <div className="context-menu" role="menu" style={{ left, top }} onContextMenu={(e) => e.preventDefault()}>
      {menu.onClip ? (
        <>
          {item('Split at playhead', 'S', () => s.applyTimeline((tl) => splitAt(tl, s.playhead, s.selection)), !canSplit)}
          {item('Copy', '⌘C', copySelection)}
          {item('Cut', '⌘X', cutSelection)}
          {item('Paste at playhead', '⌘V', () => pasteClipboard(), !s.clipboard?.length)}
          {item('Duplicate', '⌘D', duplicateSelection)}
          <hr />
          {item('Detach audio', '', detachSelection, detachable(picked).length === 0)}
          {item(allOff ? 'Turn clip on' : 'Turn clip off', '⇧E', toggleEnabledSelection)}
          <hr />
          {item('Delete', '⌫', () => deleteSelection('auto'))}
          {item('Ripple delete', 'X', () => deleteSelection('ripple'))}
        </>
      ) : (
        <>
          {item('Paste here', '⌘V', () => pasteClipboard(menu.frame, menu.trackId), !s.clipboard?.length)}
          {item('Add marker here', 'M', () =>
            s.applyTimeline((tl) => ({ ...tl, markers: [...tl.markers, { id: newId(), frame: menu.frame, label: `Marker ${tl.markers.length + 1}` }] })),
          )}
        </>
      )}
    </div>
  );
}

const peaksCache = new Map<string, Promise<number[] | null>>();

function loadPeaks(projectId: string, assetId: string): Promise<number[] | null> {
  const key = `${projectId}/${assetId}`;
  let p = peaksCache.get(key);
  if (!p) {
    p = fetch(peaksUrl(projectId, assetId))
      .then((r) => (r.ok ? (r.json() as Promise<number[]>) : null))
      .catch(() => null);
    peaksCache.set(key, p);
  }
  return p;
}

const PEAKS_PER_SECOND = 50;

/** Waveform peaks for a clip's media; null while loading or when it has none, [] when a video has no sound. */
function usePeaks(projectId: string, assetId: string | undefined, enabled: boolean): number[] | null {
  const [peaks, setPeaks] = useState<number[] | null>(null);
  useEffect(() => {
    if (enabled && assetId) void loadPeaks(projectId, assetId).then(setPeaks);
  }, [projectId, assetId, enabled]);
  return enabled ? peaks : null;
}

/** Mirrored waveform for the part of the source the clip plays, shaped by its volume and fades. */
function Waveform({ peaks, clip, fps, width }: { peaks: number[]; clip: Clip; fps: number; width: number }) {
  if (width < 4) return null;
  const bars = Math.min(Math.floor(width / 3), 1500);
  const from = ((clip.in ?? 0) / fps) * PEAKS_PER_SECOND;
  const span = (clip.duration / fps) * PEAKS_PER_SECOND;
  let d = '';
  for (let i = 0; i < bars; i++) {
    const a = Math.floor(from + (i / bars) * span);
    const b = Math.max(a + 1, Math.floor(from + ((i + 1) / bars) * span));
    let max = 0;
    for (let j = a; j < b && j < peaks.length; j++) max = Math.max(max, peaks[j]);
    const gain = Math.min(1, (clip.volume ?? 1) * fadeEnvelope(clip, ((i + 0.5) / bars) * clip.duration));
    const h = Math.max(0.5, (max / 255) * 48 * gain);
    d += `M${(i / bars) * 1000} ${50 - h}V${50 + h}`;
  }
  return (
    <svg className="waveform" viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden>
      <path d={d} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const KIND_ICON = { video: 'film', image: 'image', text: 'text', caption: 'text', slide: 'grid', audio: 'music' } as const;

const ClipView = memo(function ClipView({
  clip,
  asset,
  px,
  fps,
  selected,
  thumb,
  dimmed,
  projectId,
  onPointerDown,
  onContextMenu,
}: {
  clip: Clip;
  asset?: Asset;
  px: number;
  fps: number;
  selected: boolean;
  thumb?: string;
  dimmed: boolean;
  projectId: string;
  onPointerDown: (e: React.PointerEvent, clip: Clip, kind: DragState['kind']) => void;
  onContextMenu: (e: React.MouseEvent, clip: Clip) => void;
}) {
  const width = Math.max(2, clip.duration * px);
  const label =
    clip.kind === 'text'
      ? (clip.text?.text ?? '')
      : clip.kind === 'caption'
        ? (clip.words ?? []).map((w) => w.text).join(' ')
        : clip.kind === 'slide'
          ? `Slide · ${clip.slide?.title ?? ''}`
          : (asset?.name.replace(/\.[^.]+$/, '') ?? 'Missing media');
  const generated = clip.kind === 'text' || clip.kind === 'caption' || clip.kind === 'slide';
  const vol = clip.volume ?? 1;
  const peaks = usePeaks(projectId, clip.assetId, clip.kind === 'audio' || (clip.kind === 'video' && !clip.muted));
  const wave = peaks && peaks.length > 0 ? peaks : null;
  // Slides draw without the fade envelope, so they get no fade knobs.
  const fadeable = clip.kind !== 'slide' && width >= 36;
  const secs = (frames = 0) => `${(frames / fps).toFixed(1)}s`;
  return (
    <div
      className={`clip ${clip.kind} ${selected ? 'selected' : ''} ${dimmed ? 'dimmed' : ''} ${!asset && !generated ? 'missing' : ''} ${clip.kind === 'video' && wave ? 'has-wave' : ''} ${clip.disabled ? 'disabled' : ''}`}
      style={{ left: clip.start * px, width }}
      onPointerDown={(e) => onPointerDown(e, clip, 'move')}
      onContextMenu={(e) => onContextMenu(e, clip)}
      title={`${label}${clip.disabled ? ' (turned off)' : ''}\n${formatTimecode(clip.start, fps)} → ${formatTimecode(clip.start + clip.duration, fps)} (${(clip.duration / fps).toFixed(2)}s)`}
    >
      {thumb && (clip.kind === 'video' || clip.kind === 'image') && <div className="clip-thumb" style={{ backgroundImage: `url(${thumb})` }} />}
      {wave && <Waveform peaks={wave} clip={clip} fps={fps} width={width} />}
      {(clip.fadeIn ?? 0) > 0 && <div className="fade in" style={{ width: (clip.fadeIn ?? 0) * px }} />}
      {(clip.fadeOut ?? 0) > 0 && <div className="fade out" style={{ width: (clip.fadeOut ?? 0) * px }} />}
      <div className="clip-label">
        <Icon name={KIND_ICON[clip.kind]} />
        <span>{label}</span>
        {clip.disabled && <span className="badge">Off</span>}
        {clip.muted && (
          <span className="badge" title="Sound off: its audio was detached or muted">
            <Icon name="mute" />
          </span>
        )}
        {vol !== 1 && !clip.muted && clip.kind !== 'image' && !generated && <span className="badge">{Math.round(vol * 100)}%</span>}
      </div>
      <div className="handle start" onPointerDown={(e) => onPointerDown(e, clip, 'trim-start')} />
      <div className="handle end" onPointerDown={(e) => onPointerDown(e, clip, 'trim-end')} />
      {fadeable && (
        <>
          <div
            className="fade-handle in"
            style={{ left: `max(var(--fade-knob-inset), ${(clip.fadeIn ?? 0) * px}px)` }}
            title={`Fade in ${secs(clip.fadeIn)}: drag to change`}
            onPointerDown={(e) => onPointerDown(e, clip, 'fade-in')}
          />
          <div
            className="fade-handle out"
            style={{ right: `max(var(--fade-knob-inset), ${(clip.fadeOut ?? 0) * px}px)` }}
            title={`Fade out ${secs(clip.fadeOut)}: drag to change`}
            onPointerDown={(e) => onPointerDown(e, clip, 'fade-out')}
          />
        </>
      )}
    </div>
  );
});
