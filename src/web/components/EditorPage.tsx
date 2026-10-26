import { useCallback, useEffect, useState } from 'react';
import { addTimeline, cropRange, deleteSide, deriveTimeline, mainTrackId, removeTimeline, splitAt, updateTimeline } from '../../shared/edits';
import { type Comment, FORMATS, type FormatId, emptyTimeline, newId, timelineDuration } from '../../shared/project';
import { api, captureEditKeyFromUrl, keys } from '../api';
import { readDraft } from '../drafts';
import { SKINS, applySkin, currentSkin } from '../skins';
import {
  activeTimeline,
  addMarkerAtPlayhead,
  addRangeMarker,
  clearMarks,
  copyAttributes,
  copySelection,
  cutMarkedRange,
  cutSelection,
  deleteSelection,
  duplicateSelection,
  freezeAtPlayhead,
  markInAtPlayhead,
  markOutAtPlayhead,
  nudgeSelection,
  pasteAttributesToSelection,
  pasteClipboard,
  playMarkedRange,
  rippleScope,
  seekEdit,
  toggleEnabledSelection,
  toggleLoop,
  trimSelectionToPlayhead,
  useEditor,
  zoomToFit,
} from '../store';
import { toggleKeyAtPlayhead } from '../keyframing';
import { startSync } from '../sync';
import { CommentsPanel } from './Comments';
import { WorkspaceCard, useWorkspace } from './KeyBox';
import { ExportPanel } from './ExportPanel';
import { HistoryPanel } from './HistoryPanel';
import { InspectorPanel } from './Inspector';
import { MediaBin } from './MediaBin';
import { Preview } from './Preview';
import { ReplaceDialog } from './ReplaceDialog';
import { TimelineView } from './TimelineView';
import { TranscriptPanel } from './TranscriptPanel';
import { CommandPalette, openPalette } from './CommandPalette';
import { HelpButton, HelpTip } from './Help';

type MobilePanel = 'media' | 'inspector' | 'transcript' | 'comments' | 'history' | 'export';

/**
 * Coding Agent Optimized View, narrow panes: the panel dock under the timeline
 * folds away. Keep in sync with the matching block in styles.css.
 */
const FOLDING_DOCK = '(min-width: 481px) and (max-width: 699px) and (min-height: 600px)';
const DOCK_KEY = 'videdit.dock';

function readDockOpen(): boolean {
  try {
    return localStorage.getItem(DOCK_KEY) !== '0';
  } catch {
    return true;
  }
}

function writeDockOpen(open: boolean) {
  try {
    localStorage.setItem(DOCK_KEY, open ? '1' : '0');
  } catch {
    // Private mode or blocked storage: the dock state lasts for this tab only.
  }
}

function SkinPicker() {
  const [skin, setSkin] = useState(currentSkin);
  const [open, setOpen] = useState(false);
  return (
    <div className="skin-picker">
      <button className="brand" onClick={() => setOpen(!open)} title="Change editor style">
        <span className="brand-num">{skin.num}</span>
        <span className="brand-slash">/</span>
        <span className="brand-name">{skin.name}</span>
      </button>
      {open && (
        <div className="menu" onMouseLeave={() => setOpen(false)}>
          {SKINS.map((s) => (
            <button
              key={s.id}
              className={s.id === skin.id ? 'on' : ''}
              onClick={() => {
                applySkin(s);
                setSkin(s);
                setOpen(false);
              }}
            >
              <span className={`swatch swatch-${s.id}`} />
              {s.num} / {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ShareDialog({ onClose }: { onClose: () => void }) {
  const projectId = useEditor((s) => s.projectId);
  const server = useEditor((s) => s.server);
  const canEdit = useEditor((s) => s.canEdit);
  const [links, setLinks] = useState<{ editUrl: string | null; viewUrl: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const local = server?.mode === 'local';
  const workspace = useWorkspace();

  useEffect(() => {
    if (local) {
      if (server?.remote) setLinks({ editUrl: server.remote.editUrl, viewUrl: server.remote.viewUrl });
    } else {
      const key = keys.edit(projectId);
      setLinks({ editUrl: key ? `${location.origin}/p/${projectId}#k=${key}` : null, viewUrl: `${location.origin}/p/${projectId}` });
    }
  }, [local, server, projectId]);

  async function push(force = false) {
    setBusy(true);
    setError('');
    try {
      const res = await api.push(projectId, force);
      setLinks(res);
      useEditor.setState({ server: await api.health() });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text);
    useEditor.getState().setToast('Link copied');
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h2>Share</h2>
          <HelpTip id="share" />
          <div className="grow" />
          <button className="ghost" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">
          {local && !server?.cloudConfigured && (
            <p>
              This project lives on your computer. To share it, connect a Cloudflare account once with
              <code> videdit deploy</code>, then come back here.
            </p>
          )}
          {local && server?.cloudConfigured && (
            <>
              <p>Upload this folder's timeline and clips to your cloud so others can edit, comment and publish.</p>
              <div className="button-row">
                <button className="primary" disabled={busy} onClick={() => push(false)}>
                  {busy ? 'Uploading…' : server?.remote ? 'Push latest changes' : 'Share to cloud'}
                </button>
                {error.includes('pull') && (
                  <button disabled={busy} onClick={() => push(true)}>
                    Overwrite cloud copy
                  </button>
                )}
              </div>
              {error && <p className="error">{error}</p>}
              {!links && workspace && <WorkspaceCard serverUrl={workspace.serverUrl} workspaceKey={workspace.workspaceKey} compact />}
            </>
          )}
          {links && (
            <div className="links">
              {links.editUrl && (
                <label className="field stacked">
                  <span>
                    Edit link — anyone with it can edit <HelpTip id="edit-link" />
                  </span>
                  <div className="copy-row">
                    <input readOnly value={links.editUrl} onFocus={(e) => e.target.select()} />
                    <button onClick={() => copy(links.editUrl!)}>Copy</button>
                  </div>
                </label>
              )}
              <label className="field stacked">
                <span>
                  View link — watch, scrub and comment <HelpTip id="view-link" />
                </span>
                <div className="copy-row">
                  <input readOnly value={links.viewUrl} onFocus={(e) => e.target.select()} />
                  <button onClick={() => copy(links.viewUrl)}>Copy</button>
                </div>
              </label>
              {!local && canEdit && (
                <button
                  className="small"
                  onClick={async () => {
                    if (!confirm('Create a new edit link? The current edit link will stop working.')) return;
                    const { editKey } = await api.rotateEditKey(projectId);
                    keys.setEdit(projectId, editKey);
                    setLinks({ editUrl: `${location.origin}/p/${projectId}#k=${editKey}`, viewUrl: `${location.origin}/p/${projectId}` });
                  }}
                >
                  Reset edit link
                </button>
              )}
              {workspace && <WorkspaceCard serverUrl={workspace.serverUrl} workspaceKey={workspace.workspaceKey} />}
              {!local && !links.editUrl && canEdit && (
                <p className="hint">You are editing with the workspace key. Reset the edit link to get a shareable one.</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TimelineSwitcher() {
  const doc = useEditor((s) => s.doc);
  const timelineId = useEditor((s) => s.timelineId);
  const canEdit = useEditor((s) => s.canEdit);
  const current = activeTimeline({ doc, timelineId });
  const aspect = (w: number, h: number) => (w === h ? '1:1' : w > h ? '16:9' : '9:16');

  function onChange(value: string) {
    const state = useEditor.getState();
    if (!value.startsWith('__')) return state.setTimeline(value);
    const id = newId(8);
    if (value === '__short') {
      const secs = timelineDuration(current) / current.fps;
      const answer = prompt(`Short from "${current.name}": which range, in seconds? (blank = whole cut)`, secs > 60 ? '0-60' : '');
      if (answer === null) return;
      let t = deriveTimeline(current, 'Short', 'vertical');
      const m = answer.match(/^\s*([\d.]+)\s*-\s*([\d.]+)\s*$/);
      if (m) t = cropRange(t, Number(m[1]) * current.fps, Number(m[2]) * current.fps);
      state.apply((d) => addTimeline(d, { ...t, id }));
    } else if (value.startsWith('__new_')) {
      const format = value.slice(6) as FormatId;
      state.apply((d) => addTimeline(d, { ...emptyTimeline(`${FORMATS[format].label.split(' ')[0]} cut`, format), id }));
    } else if (value === '__duplicate') {
      const copy = { ...current, id, name: `${current.name} copy`, clips: current.clips.map((c) => ({ ...c, id: newId() })) };
      state.apply((d) => addTimeline(d, copy));
    } else if (value === '__rename') {
      const name = prompt('Timeline name', current.name);
      if (name) state.apply((d) => updateTimeline(d, current.id, (t) => ({ ...t, name: name.slice(0, 60) })));
      return;
    } else if (value === '__delete') {
      if (confirm(`Delete timeline "${current.name}"? Its clips are removed; media stays in the bin.`)) {
        state.apply((d) => removeTimeline(d, current.id));
        state.setTimeline(useEditor.getState().doc.timelines[0].id);
      }
      return;
    }
    state.setTimeline(id);
  }

  return (
    <select className="timeline-select" value={current.id} onChange={(e) => onChange(e.target.value)} aria-label="Timeline">
      {doc.timelines.map((t) => (
        <option key={t.id} value={t.id}>
          {t.name} · {aspect(t.width, t.height)}
        </option>
      ))}
      {canEdit && (
        <optgroup label="New">
          <option value="__short">9:16 short from {current.name}…</option>
          <option value="__new_landscape">Empty 16:9</option>
          <option value="__new_vertical">Empty 9:16</option>
          <option value="__new_square">Empty 1:1</option>
          <option value="__duplicate">Duplicate {current.name}</option>
          <option value="__rename">Rename {current.name}…</option>
          {doc.timelines.length > 1 && <option value="__delete">Delete {current.name}…</option>}
        </optgroup>
      )}
    </select>
  );
}

function useKeyboard() {
  useEffect(() => {
    let shuttle = 0;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select, [contenteditable]')) return;
      const s = useEditor.getState();
      const t = activeTimeline(s);
      const mod = e.metaKey || e.ctrlKey;
      const player = s.player;
      const key = e.key.toLowerCase();
      if (mod && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
        return;
      }
      if (mod && key === 'y') return void (e.preventDefault(), s.redo());
      // ⌥⌘C / ⌥⌘V copy a clip's look and paste it onto the selection. Matched by physical key, since ⌥ changes e.key on a Mac.
      if (mod && e.altKey && (e.code === 'KeyC' || e.code === 'KeyV')) {
        e.preventDefault();
        if (e.code === 'KeyC') copyAttributes();
        else pasteAttributesToSelection();
        return;
      }
      // Split: ⌘B splits the selection (or every track) at the playhead; ⇧⌘B splits every track.
      if (mod && key === 'b') {
        e.preventDefault();
        s.applyTimeline((tl) => splitAt(tl, s.playhead, !e.shiftKey && s.selection.length ? s.selection : undefined));
        return;
      }
      if (mod && key === 'a') {
        e.preventDefault();
        s.select(t.clips.map((c) => c.id));
        return;
      }
      // Clipboard. Copy and cut leave text the person selected on the page alone.
      const textSelected = Boolean(window.getSelection()?.toString());
      if (mod && (key === 'c' || key === 'x') && s.selection.length && !textSelected) {
        e.preventDefault();
        if (key === 'c') copySelection();
        else cutSelection();
        return;
      }
      if (mod && key === 'v' && s.clipboard?.length) return void (e.preventDefault(), pasteClipboard());
      if (mod && key === 'd') return void (e.preventDefault(), duplicateSelection());
      if (mod) return;
      // ⌥[ / ⌥] (or ⇧[ / ⇧]) trim the selected clips' start or end to the playhead.
      if ((e.altKey || e.shiftKey) && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
        e.preventDefault();
        trimSelectionToPlayhead(e.code === 'BracketLeft' ? 'start' : 'end');
        return;
      }
      if (e.shiftKey && e.code === 'KeyF') {
        e.preventDefault();
        freezeAtPlayhead();
        return;
      }
      // ⌥X clears the in and out points; ⌥M adds a range marker. Matched by physical key, since ⌥ changes e.key on a Mac.
      if (e.altKey && (e.code === 'KeyX' || e.code === 'KeyM')) {
        e.preventDefault();
        if (e.code === 'KeyX') clearMarks();
        else addRangeMarker();
        return;
      }
      switch (key) {
        case ' ':
        case 'k':
          e.preventDefault();
          shuttle = 0;
          if (key === ' ' && e.shiftKey) {
            playMarkedRange();
            break;
          }
          useEditor.setState({ playbackRate: 1 });
          if (key === 'k') player?.pause();
          else player?.toggle();
          break;
        case 'l':
        case 'j': {
          if (key === 'l' && e.shiftKey) {
            toggleLoop();
            break;
          }
          const dir = key === 'l' ? 1 : -1;
          shuttle = Math.sign(shuttle) === dir ? Math.min(4, Math.abs(shuttle) * 2) * dir : dir;
          useEditor.setState({ playbackRate: shuttle });
          player?.play();
          break;
        }
        case 'arrowleft':
        case 'arrowright': {
          e.preventDefault();
          const step = (e.shiftKey ? t.fps : 1) * (key === 'arrowright' ? 1 : -1);
          // ⌥ nudges the selected clips instead of moving the playhead.
          if (e.altKey) nudgeSelection(step);
          else s.seek(s.playhead + step);
          break;
        }
        case 'arrowup':
        case 'arrowdown':
          e.preventDefault();
          seekEdit(key === 'arrowdown' ? 1 : -1);
          break;
        case ',':
        case '.':
        case '<':
        case '>': {
          // ⇧ nudges by a second; on a US keyboard ⇧, and ⇧. arrive as < and >.
          const big = e.shiftKey || key === '<' || key === '>';
          nudgeSelection((big ? t.fps : 1) * (key === '.' || key === '>' ? 1 : -1));
          break;
        }
        case 'e':
          if (e.shiftKey) toggleEnabledSelection();
          break;
        case 'home':
          s.seek(0);
          break;
        case 'end':
          s.seek(Math.max(0, timelineDuration(t) - 1));
          break;
        case 's':
          s.applyTimeline((tl) => splitAt(tl, s.playhead, s.selection.length ? s.selection : undefined));
          break;
        case 'i':
          markInAtPlayhead();
          break;
        case 'o':
          markOutAtPlayhead();
          break;
        case 'x':
          // ⇧X extracts the in/out range when one is set.
          if (!(e.shiftKey && cutMarkedRange('extract'))) deleteSelection('ripple');
          break;
        case 'z':
          // ⇧Z lifts the in/out range when one is set, and otherwise fits the timeline to the window.
          if (e.shiftKey) {
            if (!cutMarkedRange('lift')) zoomToFit();
          } else deleteSelection('lift');
          break;
        case 'delete':
        case 'backspace':
          e.preventDefault();
          // Main-track clips ripple while the magnet is on; Shift always closes the gap.
          deleteSelection(e.shiftKey ? 'ripple' : 'auto');
          break;
        case 'q':
        case 'w': {
          // Delete left/right of the playhead: the selection, or the main-track clip under it.
          const main = mainTrackId(t);
          const under = (c: { start: number; duration: number }) => c.start < s.playhead && s.playhead < c.start + c.duration;
          const picked = s.selection.length
            ? t.clips.filter((c) => s.selection.includes(c.id) && under(c))
            : t.clips.filter((c) => c.trackId === main && under(c));
          const side = key === 'q' ? 'left' : 'right';
          const onMain = picked.filter((c) => c.trackId === main).map((c) => c.id);
          const others = picked.filter((c) => c.trackId !== main).map((c) => c.id);
          s.applyTimeline((tl) => deleteSide(deleteSide(tl, others, s.playhead, side), onMain, s.playhead, side, s.ripple, rippleScope(tl, s.linkage)));
          if (side === 'left' && onMain.length && s.ripple) s.seek(Math.min(...picked.map((c) => c.start)));
          break;
        }
        case ';':
          // Add or remove a keyframe at the playhead on the selected clip.
          toggleKeyAtPlayhead();
          break;
        case '[':
          useEditor.setState({ tool: s.tool === 'backward' ? 'select' : 'backward' });
          break;
        case ']':
          useEditor.setState({ tool: s.tool === 'forward' ? 'select' : 'forward' });
          break;
        case 'p':
          s.setRipple(!s.ripple);
          break;
        case 'n':
          useEditor.setState({ snapping: !s.snapping });
          break;
        case '`':
          s.setLinkage(!s.linkage);
          break;
        case '=':
        case '+':
          s.setZoom(s.pxPerFrame * 1.5);
          break;
        case '-':
          s.setZoom(s.pxPerFrame / 1.5);
          break;
        case '0':
          zoomToFit();
          break;
        case 'm':
          addMarkerAtPlayhead();
          break;
        case 'b':
        case 'c':
          useEditor.setState({ tool: s.tool === 'razor' ? 'select' : 'razor' });
          break;
        case 'a':
        case 'v':
        case 'escape':
          useEditor.setState({ tool: 'select' });
          if (key === 'escape') s.select([]);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function EditorPage({ projectId }: { projectId: string }) {
  const doc = useEditor((s) => s.doc);
  const canEdit = useEditor((s) => s.canEdit);
  const saveState = useEditor((s) => s.saveState);
  const toast = useEditor((s) => s.toast);
  const server = useEditor((s) => s.server);
  const panel = useEditor((s) => s.panel);
  const [error, setError] = useState('');
  const [sharing, setSharing] = useState(false);
  const [mobile, setMobile] = useState<MobilePanel>('media');
  const [dockOpen, setDockOpen] = useState(readDockOpen);
  const [comments, setComments] = useState<Comment[]>([]);

  const loadComments = useCallback(() => {
    api.listComments(projectId).then(setComments).catch(() => undefined);
  }, [projectId]);

  useEffect(() => {
    captureEditKeyFromUrl(projectId);
    let stop: (() => void) | undefined;
    Promise.all([api.health(), api.getProject(projectId)])
      .then(([info, { project, assets, canEdit }]) => {
        useEditor.setState({ server: info });
        useEditor.getState().load(projectId, project.doc, project.version, assets, canEdit);
        // Edits that never reached the server (tab closed, offline): bring them
        // back if the server copy hasn't moved on; otherwise History offers them.
        const draft = readDraft(projectId);
        if (draft && canEdit && draft.baseVersion === project.version && JSON.stringify(draft.doc) !== JSON.stringify(project.doc)) {
          useEditor.getState().apply(() => draft.doc);
          useEditor.getState().setToast('Restored unsaved changes from this browser');
        }
        document.title = `${project.doc.title} · Video bitEdit`;
        stop = startSync(projectId);
      })
      .catch((err) => setError((err as Error).message));
    loadComments();
    const t = setInterval(loadComments, 10000);
    return () => {
      stop?.();
      clearInterval(t);
    };
  }, [projectId, loadComments]);

  useKeyboard();

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => useEditor.getState().setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (saveState === 'saved') return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [saveState]);

  if (error) {
    return (
      <div className="center-page">
        <h1>Can't open this project</h1>
        <p>{error}</p>
        <a href="/">Home</a>
      </div>
    );
  }
  if (!doc) return <div className="center-page">Loading…</div>;

  const showDock = (open: boolean) => {
    setDockOpen(open);
    writeDockOpen(open);
  };
  const openPanel = (p: EditorPanel) => {
    useEditor.setState({ panel: p });
    setMobile(p);
    showDock(true);
  };
  // In a narrow agent pane the active tab folds the panel away to give the
  // timeline the room; elsewhere the tabs only switch.
  const pickTab = (p: MobilePanel) => {
    if (p === mobile && window.matchMedia(FOLDING_DOCK).matches) return showDock(!dockOpen);
    if (p === 'media') {
      setMobile('media');
      showDock(true);
    } else openPanel(p);
  };
  const timelineComments = comments.filter((c) => !c.resolved);

  return (
    <div className={`app m-${mobile}${dockOpen ? '' : ' dock-closed'}`}>
      <header className="topbar">
        <SkinPicker />
        <div className="title-wrap">
          <input
            className="project-title"
            value={doc.title}
            disabled={!canEdit}
            aria-label="Project title"
            onChange={(e) => useEditor.getState().apply((d) => ({ ...d, title: e.target.value.slice(0, 200) }))}
          />
        </div>
        <div className="top-actions">
          <span className={`save-state ${saveState}`}>
            {!canEdit ? 'View only' : saveState === 'saved' ? 'Saved' : saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Not saved' : 'Unsaved'}
          </span>
          <HelpTip id="save" />
          <span className="mode-tag">{server?.mode === 'local' ? 'Local' : 'Cloud'}</span>
          <button className="palette-btn" onClick={openPalette} title="Command palette (⌘K)">
            ⌘K
          </button>
          <HelpButton />
          <button onClick={() => setSharing(true)}>Share</button>
          {canEdit && (
            <button className="primary export-btn" onClick={() => openPanel('export')}>
              Export
            </button>
          )}
        </div>
      </header>

      <MediaBin />

      <section className="panel preview-panel">
        <div className="panel-head">
          <span className="panel-num">02</span>
          <h2>Preview</h2>
          <HelpTip id="preview" />
          <div className="grow" />
          <TimelineSwitcher />
          <HelpTip id="timelines" />
        </div>
        <Preview />
      </section>

      <aside className="panel side">
        <div className="panel-head tabs">
          <span className="panel-num">03</span>
          {(['inspector', 'transcript', 'comments', 'history', 'export'] as const).map((p) => (
            <button key={p} className={`tab ${panel === p ? 'on' : ''}`} onClick={() => openPanel(p)}>
              {p === 'inspector' ? 'Inspector' : p === 'transcript' ? 'Transcript' : p === 'comments' ? `Comments${timelineComments.length ? ` ${timelineComments.length}` : ''}` : p === 'history' ? 'History' : 'Export'}
            </button>
          ))}
          <HelpTip id="side" />
        </div>
        <div className="side-body">
          {panel === 'inspector' && <InspectorPanel />}
          {panel === 'transcript' && <TranscriptPanel />}
          {panel === 'comments' && <CommentsPanel comments={comments} reload={loadComments} />}
          {panel === 'history' && <HistoryPanel />}
          {panel === 'export' && <ExportPanel />}
        </div>
      </aside>

      <TimelineView comments={timelineComments} />

      <nav className="mobile-tabs">
        {(['media', 'inspector', 'transcript', 'comments', 'history', 'export'] as const).map((p) => (
          <button
            key={p}
            className={mobile === p ? 'on' : ''}
            aria-expanded={mobile === p ? dockOpen : undefined}
            onClick={() => pickTab(p)}
          >
            {p === 'media' ? 'Media' : p === 'inspector' ? 'Edit' : p === 'transcript' ? 'Text' : p === 'comments' ? 'Notes' : p === 'history' ? 'History' : 'Export'}
          </button>
        ))}
      </nav>

      {sharing && <ShareDialog onClose={() => setSharing(false)} />}
      <ReplaceDialog />
      <CommandPalette />
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

type EditorPanel = 'inspector' | 'transcript' | 'comments' | 'history' | 'export';
