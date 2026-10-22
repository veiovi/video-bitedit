// Edit the video by editing its text. The transcript of the current timeline
// reads as paragraphs; click a word to jump there, drag or shift-click to
// select a run (shaded on the ruler), and Delete cuts those frames from every
// unlocked track. Cut speech stays visible, struck through; clicking it puts
// it back.

import { useEffect, useMemo, useRef, useState } from 'react';
import { cutRange, restoreSourceGap } from '../../shared/edits';
import { formatTimecode } from '../../shared/project';
import { type TranscriptCutItem, type TranscriptWordItem, timelineTranscript, wordAt, wordsRange } from '../../shared/transcript';
import { activeTimeline, useEditor } from '../store';
import { loadTranscripts, useTranscripts } from '../transcripts';

/** Cut the frames of a run of words from every unlocked track, as one undo step. */
function cutWords(words: TranscriptWordItem[]) {
  const range = wordsRange(words);
  const s = useEditor.getState();
  if (!range || !s.canEdit) return;
  const before = s.doc;
  s.applyTimeline((t) => cutRange(t, range.start, range.end));
  const after = useEditor.getState().doc;
  if (after === before) return s.setToast('Nothing to cut there: every track is locked');
  useTranscripts.setState({ lastCut: { after, at: range.start }, range: null });
  s.seek(range.start);
  s.setToast(`Cut ${words.length} word${words.length === 1 ? '' : 's'} (${((range.end - range.start) / activeTimeline(s).fps).toFixed(1)} s)`);
}

/** Undo the last cut made in the panel, if nothing has changed since. */
function undoLastCut(): boolean {
  const s = useEditor.getState();
  const last = useTranscripts.getState().lastCut;
  if (!s.canEdit || !last || last.after !== s.doc) return false;
  s.undo();
  useTranscripts.setState({ lastCut: null });
  return true;
}

/** Put back speech a cut removed: undo when it was the last edit, otherwise reopen the source. */
function restoreCut(cut: TranscriptCutItem) {
  const s = useEditor.getState();
  if (!s.canEdit) return;
  if (useTranscripts.getState().lastCut?.at === cut.at && undoLastCut()) return;
  s.applyTimeline((t) => restoreSourceGap(t, cut.at, cut.frames, cut.clipIds));
  useTranscripts.setState({ lastCut: null });
  s.setToast('Restored the cut speech. Captions over it are not restored; regenerate them if needed.');
}

/** Shading on the ruler for the words selected in the transcript. */
export function TranscriptRangeMark({ px }: { px: number }) {
  const range = useTranscripts((s) => s.range);
  if (!range) return null;
  return <div className="text-range" style={{ left: range.start * px, width: Math.max(2, (range.end - range.start) * px) }} title="Selected in the transcript" />;
}

export function TranscriptPanel() {
  const projectId = useEditor((s) => s.projectId);
  const doc = useEditor((s) => s.doc);
  const timelineId = useEditor((s) => s.timelineId);
  const canEdit = useEditor((s) => s.canEdit);
  const timeline = activeTimeline({ doc, timelineId });
  const byAsset = useTranscripts((s) => s.byAsset);
  const lastCut = useTranscripts((s) => s.lastCut);
  const body = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [sel, setSel] = useState<{ anchor: number; focus: number } | null>(null);
  const [now, setNow] = useState(-1);

  const mediaIds = useMemo(
    () => [...new Set(timeline.clips.filter((c) => (c.kind === 'video' || c.kind === 'audio') && c.assetId).map((c) => c.assetId!))],
    [timeline.clips],
  );
  useEffect(() => {
    void loadTranscripts(projectId, mediaIds);
  }, [projectId, mediaIds]);

  const transcripts = useMemo(() => {
    const out: Record<string, { words: { text: string; start: number; end: number }[] }> = {};
    for (const [id, t] of Object.entries(byAsset)) if (t) out[id] = t;
    return out;
  }, [byAsset]);
  const paragraphs = useMemo(() => timelineTranscript(timeline, transcripts), [timeline, transcripts]);
  const words = useMemo(() => paragraphs.flatMap((p) => p.items.filter((i): i is TranscriptWordItem => i.type === 'word')), [paragraphs]);
  const loading = mediaIds.some((id) => !(id in byAsset));

  // Word indices shift after any edit, so the selection starts over.
  useEffect(() => setSel(null), [paragraphs]);

  const lo = sel ? Math.min(sel.anchor, sel.focus) : -1;
  const hi = sel ? Math.max(sel.anchor, sel.focus) : -1;
  const selected = sel ? words.slice(lo, hi + 1) : [];

  useEffect(() => {
    useTranscripts.setState({ range: sel ? wordsRange(words.slice(lo, hi + 1)) : null });
  }, [sel, words, lo, hi]);
  useEffect(() => () => useTranscripts.setState({ range: null }), []);

  // Follow the playhead: highlight the word being spoken, and keep it in view while playing.
  useEffect(() => {
    const update = (frame: number, playing: boolean) => {
      const i = wordAt(words, frame);
      setNow(i);
      if (playing && i >= 0) {
        const el = body.current?.querySelector<HTMLElement>(`[data-w="${i}"]`);
        const box = body.current?.getBoundingClientRect();
        const r = el?.getBoundingClientRect();
        if (el && box && r && (r.top < box.top || r.bottom > box.bottom)) el.scrollIntoView({ block: 'center' });
      }
    };
    update(useEditor.getState().playhead, false);
    return useEditor.subscribe((s, prev) => {
      if (s.playhead !== prev.playhead) update(s.playhead, s.playing);
    });
  }, [words]);

  useEffect(() => {
    const up = () => (dragging.current = false);
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  }, []);

  const onWordDown = (e: React.PointerEvent, i: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    body.current?.focus();
    if (e.shiftKey && sel) {
      setSel({ anchor: sel.anchor, focus: i });
      return;
    }
    dragging.current = true;
    setSel({ anchor: i, focus: i });
    useEditor.getState().seek(words[i].start);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected.length) {
      // Keep the timeline's Delete from also removing selected clips.
      e.preventDefault();
      e.stopPropagation();
      if (canEdit) cutWords(selected);
    } else if (e.key === 'Escape' && sel) {
      e.stopPropagation();
      setSel(null);
    }
  };

  const undoable = lastCut && lastCut.after === doc;
  let index = -1;

  return (
    <div className="transcript-panel">
      <div className="transcript-bar">
        <span className="hint">
          {selected.length
            ? `${selected.length} word${selected.length === 1 ? '' : 's'} · ${formatTimecode(selected[0].start, timeline.fps)}–${formatTimecode(selected[selected.length - 1].end, timeline.fps)}`
            : words.length
              ? 'Click a word to jump there. Drag or ⇧-click to select, ⌫ to cut.'
              : ''}
        </span>
        <div className="grow" />
        {canEdit && undoable && (
          <button className="small" onClick={() => undoLastCut()} title="Undo the last cut made here (⌘Z)">
            Undo cut
          </button>
        )}
        {canEdit && (
          <button className="small primary" disabled={selected.length === 0} onClick={() => cutWords(selected)} title="Cut the selected words from every unlocked track (⌫)">
            Cut
          </button>
        )}
        <button className="small ghost" onClick={() => void loadTranscripts(projectId, mediaIds, true)} title="Fetch transcripts again">
          ↻
        </button>
      </div>
      <div className="transcript-body" ref={body} tabIndex={0} onKeyDown={onKeyDown} aria-label="Transcript">
        {paragraphs.map((p, pi) => (
          <p key={pi}>
            {p.items.map((item, ii) => {
              if (item.type === 'cut') {
                return [
                  <span
                    key={`c${ii}`}
                    className={`cut-run ${canEdit ? 'restorable' : ''}`}
                    title={canEdit ? 'Cut. Click to put it back.' : 'Cut'}
                    onClick={() => restoreCut(item)}
                  >
                    {item.words.join(' ')}
                  </span>,
                  ' ',
                ];
              }
              index += 1;
              const i = index;
              return [
                <span
                  key={`w${ii}`}
                  data-w={i}
                  className={`word ${i >= lo && i <= hi ? 'sel' : ''} ${i === now ? 'now' : ''}`}
                  onPointerDown={(e) => onWordDown(e, i)}
                  onPointerEnter={() => dragging.current && setSel((s) => (s ? { anchor: s.anchor, focus: i } : s))}
                >
                  {item.text}
                </span>,
                ' ',
              ];
            })}
          </p>
        ))}
        {words.length === 0 && !loading && (
          <div className="transcript-empty">
            <p>No transcript for the clips on this timeline yet.</p>
            <p>
              Make one on your computer with <code>videdit transcribe &lt;folder&gt;</code> (from a checkout:{' '}
              <code>node bin/videdit.mjs transcribe &lt;folder&gt;</code>). It runs Whisper locally and stores word timings next to each clip;
              cloud projects get them with <code>videdit push</code>. Then press ↻.
            </p>
          </div>
        )}
        {words.length === 0 && loading && <div className="transcript-empty">Loading transcripts…</div>}
      </div>
    </div>
  );
}
