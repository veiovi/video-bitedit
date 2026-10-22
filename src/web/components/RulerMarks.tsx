// The ruler's interactive layers: the in/out range with draggable handles,
// markers (click to jump, drag to move, drag a range marker's end to resize,
// double-click to edit) and comment pins. The ruler's corner holds the
// in/out readout and the marker list.

import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { CHAPTER_MIN_SECONDS, chaptersFromMarkers, moveMarker, removeMarker, snap, snapPoints, updateMarker, updateTimeline } from '../../shared/edits';
import { MARKER_COLORS, type Marker, type ProjectDoc, type Timeline, formatTimecode, timelineDuration } from '../../shared/project';
import { activeTimeline, clearMarks, formatSeconds, markedRange, useEditor } from '../store';

const SNAP_PX = 10;

/** Which marker popovers are open, and where (viewport pixels). */
const useRulerUi = create<{ editing: { id: string; x: number; y: number } | null; list: { x: number; y: number } | null }>(() => ({
  editing: null,
  list: null,
}));

/** Open the marker editor under an element (a marker on the ruler, or a row in the list). */
function editMarker(id: string, el: Element) {
  if (!useEditor.getState().canEdit) return;
  const r = el.getBoundingClientRect();
  useRulerUi.setState({ editing: { id, x: r.left + r.width / 2, y: r.bottom + 6 } });
}

/** The frame under the pointer, from the ruler's left edge. */
function frameAt(el: Element, clientX: number, px: number): number {
  const ruler = el.closest('.ruler') ?? el;
  return Math.max(0, Math.round((clientX - ruler.getBoundingClientRect().left) / px));
}

/** Snap a frame to cuts, markers (except `skip`) and the playhead, unless snapping is off or ⌘/Ctrl is held. */
function snapper(t: Timeline, px: number, e: { metaKey: boolean; ctrlKey: boolean }, skip?: string): (f: number) => number {
  const s = useEditor.getState();
  if (!s.snapping || e.metaKey || e.ctrlKey) return (f) => f;
  const pts = [...snapPoints({ ...t, markers: t.markers.filter((m) => m.id !== skip) }), s.playhead];
  return (f) => snap(f, pts, SNAP_PX / px);
}

const markerTitle = (m: Marker, fps: number) =>
  `${m.label} · ${formatTimecode(m.frame, fps)}${m.duration ? ` → ${formatTimecode(m.frame + m.duration, fps)} (${formatSeconds(m.duration, fps)})` : ''}`;

/** The in/out range on the ruler: shaded, with a handle at each end that drags (and snaps). */
export function InOutRange({ px }: { px: number }) {
  const doc = useEditor((s) => s.doc);
  const timelineId = useEditor((s) => s.timelineId);
  const markIn = useEditor((s) => s.markIn);
  const markOut = useEditor((s) => s.markOut);
  const range = markedRange({ doc, timelineId, markIn, markOut });
  const drag = useRef<'in' | 'out' | null>(null);
  const [dragging, setDragging] = useState(false);
  if (!range) return null;
  const t = activeTimeline({ doc, timelineId });
  const width = (range.end - range.start) * px;

  const down = (edge: 'in' | 'out') => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = edge;
    setDragging(true);
  };
  const move = (e: React.PointerEvent) => {
    // Keep the ruler from seeking while a handle is dragged.
    e.stopPropagation();
    const edge = drag.current;
    if (!edge) return;
    const s = useEditor.getState();
    const r = markedRange(s);
    if (!r) return;
    const f = snapper(t, px, e)(frameAt(e.currentTarget, e.clientX, px));
    if (edge === 'in') s.setMarks(Math.min(f, r.end - 1), s.markOut);
    else s.setMarks(s.markIn, Math.min(timelineDuration(t), Math.max(f, r.start + 1)));
  };
  const up = () => {
    drag.current = null;
    setDragging(false);
  };
  const handle = (edge: 'in' | 'out') => (
    <div
      className={`inout-handle ${edge}`}
      style={{ left: (edge === 'in' ? range.start : range.end) * px }}
      title={`${edge === 'in' ? 'In' : 'Out'} point ${formatTimecode(edge === 'in' ? range.start : range.end, t.fps)}: drag to move (snaps to cuts and markers; hold ⌘ to stop snapping)`}
      onPointerDown={down(edge)}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    />
  );
  return (
    <>
      <div className={`inout-range ${dragging ? 'dragging' : ''}`} style={{ left: range.start * px, width }}>
        {(dragging || width > 64) && <span className="inout-length">{formatSeconds(range.end - range.start, t.fps)}</span>}
      </div>
      {handle('in')}
      {handle('out')}
    </>
  );
}

/** The in/out range carried down over the tracks, faintly. */
export function InOutShade({ px, height }: { px: number; height: number }) {
  const doc = useEditor((s) => s.doc);
  const timelineId = useEditor((s) => s.timelineId);
  const markIn = useEditor((s) => s.markIn);
  const markOut = useEditor((s) => s.markOut);
  const range = markedRange({ doc, timelineId, markIn, markOut });
  if (!range) return null;
  return <div className="inout-shade" style={{ left: range.start * px, width: (range.end - range.start) * px, height }} />;
}

interface MarkerDrag {
  id: string;
  mode: 'move' | 'resize';
  x: number;
  base: ProjectDoc;
  timeline: Timeline;
  marker: Marker;
  moved: boolean;
}

/** Point and range markers on the ruler. */
export function MarkerLayer({ timeline, px }: { timeline: Timeline; px: number }) {
  const canEdit = useEditor((s) => s.canEdit);
  const drag = useRef<MarkerDrag | null>(null);
  const [readout, setReadout] = useState<{ x: number; text: string } | null>(null);

  function down(e: React.PointerEvent, m: Marker, mode: MarkerDrag['mode']) {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const s = useEditor.getState();
    drag.current = { id: m.id, mode, x: e.clientX, base: s.doc, timeline: activeTimeline(s), marker: m, moved: false };
  }

  function move(e: React.PointerEvent) {
    e.stopPropagation();
    const d = drag.current;
    if (!d || !canEdit) return;
    if (!d.moved && Math.abs(e.clientX - d.x) < 3) return;
    d.moved = true;
    const dx = (e.clientX - d.x) / px;
    const toSnap = snapper(d.timeline, px, e, d.id);
    const m = d.marker;
    let next: Timeline;
    if (d.mode === 'resize') {
      const end = toSnap(m.frame + (m.duration ?? 0) + dx);
      next = updateMarker(d.timeline, d.id, { duration: Math.max(1, end - m.frame) });
    } else {
      // Snap by the start, or by the end of a range marker, whichever is closer.
      const raw = Math.max(0, m.frame + dx);
      const byStart = toSnap(raw);
      const rawEnd = raw + (m.duration ?? 0);
      const byEnd = m.duration ? toSnap(rawEnd) - m.duration : raw;
      const start = byStart !== raw && (byEnd === raw || Math.abs(byStart - raw) <= Math.abs(byEnd - raw)) ? byStart : byEnd;
      next = moveMarker(d.timeline, d.id, Math.round(start));
    }
    useEditor.getState().preview(updateTimeline(d.base, d.timeline.id, () => next));
    const now = next.markers.find((x) => x.id === d.id) ?? m;
    const fps = d.timeline.fps;
    setReadout({
      x: (d.mode === 'resize' ? now.frame + (now.duration ?? 0) : now.frame) * px,
      text: d.mode === 'resize' ? `Length ${formatSeconds(now.duration ?? 0, fps)}` : formatTimecode(now.frame, fps),
    });
  }

  function up() {
    const d = drag.current;
    drag.current = null;
    setReadout(null);
    if (!d) return;
    const s = useEditor.getState();
    if (d.moved) s.commitFrom(d.base);
    else s.seek(d.marker.frame);
  }

  return (
    <>
      {timeline.markers.map((m) => (
        <div
          key={m.id}
          className={`marker ${m.duration ? 'range' : 'point'}`}
          style={{ left: m.frame * px, width: m.duration ? Math.max(4, m.duration * px) : undefined, ...(m.color && ({ '--mc': m.color } as React.CSSProperties)) }}
          title={`${markerTitle(m, timeline.fps)}\nClick to jump here${canEdit ? ', drag to move, double-click to rename, recolour or delete' : ''}`}
          onPointerDown={(e) => down(e, m, 'move')}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onDoubleClick={(e) => editMarker(m.id, e.currentTarget)}
        >
          {m.duration && canEdit && (
            <div
              className="marker-end"
              title="Drag to change the range marker's length"
              onPointerDown={(e) => down(e, m, 'resize')}
              onPointerMove={move}
              onPointerUp={up}
              onPointerCancel={up}
            />
          )}
        </div>
      ))}
      {readout && (
        <div className="marker-readout" style={{ left: readout.x }}>
          {readout.text}
        </div>
      )}
    </>
  );
}

/** Comment pins: click one to jump to it and see it in the comments panel. */
export function CommentPins({ comments, px }: { comments: { id: string; frame: number; author?: string; body?: string }[]; px: number }) {
  const fps = useEditor((s) => activeTimeline(s).fps);
  return (
    <>
      {comments.map((c) => (
        <button
          key={c.id}
          className="comment-pin"
          style={{ left: c.frame * px }}
          title={`${formatTimecode(c.frame, fps)}${c.author ? ` · ${c.author}` : ''}${c.body ? `: ${c.body.slice(0, 140)}` : ''}\nClick to jump here and open the comment`}
          aria-label={`Comment at ${formatTimecode(c.frame, fps)}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => {
            const s = useEditor.getState();
            s.seek(c.frame);
            useEditor.setState({ panel: 'comments', highlightComment: c.id });
          }}
        />
      ))}
    </>
  );
}

/** Close a popover on Escape or a press outside `selector`. */
function useDismiss(open: boolean, selector: string, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onEvent = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e.type === 'pointerdown' && (e.target as HTMLElement).closest(selector)) return;
      close();
    };
    window.addEventListener('pointerdown', onEvent, true);
    window.addEventListener('keydown', onEvent, true);
    return () => {
      window.removeEventListener('pointerdown', onEvent, true);
      window.removeEventListener('keydown', onEvent, true);
    };
  }, [open, selector, close]);
}

const closeEditor = () => useRulerUi.setState({ editing: null });
const closeList = () => useRulerUi.setState({ list: null });

/** Rename, recolour, shorten to a point, or delete a marker. Every change is one undo step. */
function MarkerEditor() {
  const editing = useRulerUi((s) => s.editing);
  const doc = useEditor((s) => s.doc);
  const timelineId = useEditor((s) => s.timelineId);
  const t = activeTimeline({ doc, timelineId });
  const m = editing ? t.markers.find((x) => x.id === editing.id) : undefined;
  useDismiss(Boolean(m), '.marker-editor', closeEditor);
  if (!editing || !m) return null;
  const apply = (fn: (tl: Timeline) => Timeline) => useEditor.getState().applyTimeline(fn);
  const remove = () => {
    apply((tl) => removeMarker(tl, m.id));
    closeEditor();
  };
  const left = Math.max(8, Math.min(editing.x - 120, window.innerWidth - 248));
  const top = Math.min(editing.y, window.innerHeight - 190);
  return (
    <div
      className="marker-editor"
      role="dialog"
      aria-label={`Marker ${m.label}`}
      style={{ left, top }}
      onKeyDown={(e) => {
        // Shortcuts stay inside the popover; Delete removes the marker unless typing in the name.
        e.stopPropagation();
        if ((e.key === 'Delete' || e.key === 'Backspace') && !(e.target instanceof HTMLInputElement)) {
          e.preventDefault();
          remove();
        }
      }}
    >
      <input
        key={m.id}
        aria-label="Marker name"
        defaultValue={m.label}
        maxLength={80}
        autoFocus
        onFocus={(e) => e.target.select()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            apply((tl) => updateMarker(tl, m.id, { label: e.currentTarget.value }));
            closeEditor();
          }
          if (e.key === 'Escape') closeEditor();
        }}
        onBlur={(e) => apply((tl) => updateMarker(tl, m.id, { label: e.target.value }))}
      />
      <div className="marker-colors" role="radiogroup" aria-label="Marker colour">
        <button
          role="radio"
          aria-checked={!m.color}
          className={`none ${!m.color ? 'on' : ''}`}
          title="Default colour"
          onClick={() => apply((tl) => updateMarker(tl, m.id, { color: null }))}
        />
        {MARKER_COLORS.map((c) => (
          <button
            key={c.hex}
            role="radio"
            aria-checked={m.color === c.hex}
            className={m.color === c.hex ? 'on' : ''}
            style={{ background: c.hex }}
            title={c.name}
            aria-label={c.name}
            onClick={() => apply((tl) => updateMarker(tl, m.id, { color: c.hex }))}
          />
        ))}
      </div>
      <div className="marker-meta">
        {formatTimecode(m.frame, t.fps)}
        {m.duration ? ` → ${formatTimecode(m.frame + m.duration, t.fps)} · ${formatSeconds(m.duration, t.fps)}` : ' · point marker'}
      </div>
      <div className="button-row">
        <button className="small" onClick={() => useEditor.getState().seek(m.frame)}>
          Go to
        </button>
        {m.duration && (
          <button className="small" title="Keep only the start: a point marker" onClick={() => apply((tl) => updateMarker(tl, m.id, { duration: null }))}>
            Make point
          </button>
        )}
        <div className="grow" />
        <button className="small danger" title="Delete marker (Delete)" onClick={remove}>
          Delete
        </button>
      </div>
    </div>
  );
}

/** Every marker in time order; click to jump, edit, or copy the point markers as video chapters. */
function MarkerList() {
  const list = useRulerUi((s) => s.list);
  const doc = useEditor((s) => s.doc);
  const timelineId = useEditor((s) => s.timelineId);
  const canEdit = useEditor((s) => s.canEdit);
  const [note, setNote] = useState('');
  const t = activeTimeline({ doc, timelineId });
  useDismiss(Boolean(list), '.marker-list, .marker-editor, .corner-button', closeList);
  if (!list) return null;
  const markers = [...t.markers].sort((a, b) => a.frame - b.frame);
  const points = markers.filter((m) => !m.duration).length;

  async function copyChapters() {
    const c = chaptersFromMarkers(t);
    const parts = [`Copied ${c.chapters.length} chapter${c.chapters.length === 1 ? '' : 's'}`];
    if (c.skipped.length) {
      parts.push(
        `Skipped ${c.skipped.map((x) => `"${x.label}"`).join(', ')}: closer than ${CHAPTER_MIN_SECONDS} s to the chapter before or to the end`,
      );
    }
    if (c.tooFew) parts.push('YouTube shows chapters only when there are at least 3');
    try {
      await navigator.clipboard.writeText(c.text);
    } catch {
      parts[0] = 'Could not reach the clipboard; select and copy the lines below';
    }
    setNote(`${parts.join('. ')}.`);
    useEditor.getState().setToast(parts[0]);
  }

  return (
    <div className="marker-list" role="dialog" aria-label="Markers" style={{ left: Math.max(8, Math.min(list.x, window.innerWidth - 330)), top: list.y }}>
      <div className="marker-list-head">
        <strong>Markers</strong>
        <span className="muted">{markers.length}</span>
        <div className="grow" />
        <button className="ghost small" aria-label="Close" onClick={closeList}>
          ×
        </button>
      </div>
      {markers.length === 0 ? (
        <p className="hint">No markers yet. M adds one at the playhead; ⌥M adds a range marker over the in/out range or the selected clips.</p>
      ) : (
        <ul>
          {markers.map((m) => (
            <li key={m.id}>
              <button className="marker-row" title={markerTitle(m, t.fps)} onClick={() => useEditor.getState().seek(m.frame)}>
                <span className={`marker-dot ${m.duration ? 'range' : ''}`} style={m.color ? { background: m.color } : undefined} />
                <span className="marker-name">{m.label}</span>
                <span className="marker-tc">
                  {formatTimecode(m.frame, t.fps)}
                  {m.duration ? ` · ${formatSeconds(m.duration, t.fps)}` : ''}
                </span>
              </button>
              {canEdit && (
                <button className="small ghost" title="Rename, recolour or delete" aria-label={`Edit ${m.label}`} onClick={(e) => editMarker(m.id, e.currentTarget)}>
                  Edit
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <button className="small" disabled={points === 0} title="Point markers as 0:00 Title lines for a video description" onClick={copyChapters}>
        Copy as YouTube chapters
      </button>
      {note && <p className="hint chapter-note">{note}</p>}
    </div>
  );
}

/** The ruler's corner: the marker list button and the in/out readout. */
export function RulerCorner() {
  const doc = useEditor((s) => s.doc);
  const timelineId = useEditor((s) => s.timelineId);
  const markIn = useEditor((s) => s.markIn);
  const markOut = useEditor((s) => s.markOut);
  const range = markedRange({ doc, timelineId, markIn, markOut });
  const t = activeTimeline({ doc, timelineId });
  const listOpen = useRulerUi((s) => Boolean(s.list));
  return (
    <div className="ruler-corner">
      <button
        className={`corner-button ${listOpen ? 'on' : ''}`}
        title="Markers: list, jump, edit, and copy as chapters"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          useRulerUi.setState({ list: listOpen ? null : { x: r.left, y: r.bottom + 4 } });
        }}
      >
        <span className="marker-glyph" aria-hidden />
        <span className="corner-label">Markers</span> {t.markers.length}
      </button>
      {range && (
        <span
          className="inout-readout"
          title={`In/out range ${formatTimecode(range.start, t.fps)} → ${formatTimecode(range.end, t.fps)}. ⇧Space plays it, ⇧Z lifts it, ⇧X extracts it, ⌥X clears it.`}
        >
          <span className="corner-label">In/out</span> {formatSeconds(range.end - range.start, t.fps)}
          <button className="ghost" aria-label="Clear in and out points" title="Clear in and out (⌥X)" onClick={clearMarks}>
            ×
          </button>
        </span>
      )}
      <MarkerList />
      <MarkerEditor />
    </div>
  );
}
