import { useEffect, useState } from 'react';
import { type FrameRange, RENDER_PRESETS, type RenderPresetId, type RenderRecord, type Timeline, formatTimecode, timelineDuration } from '../../shared/project';
import { api, renderUrl } from '../api';
import { activeTimeline, formatSeconds, markedRange, useEditor } from '../store';
import { CopyLine, WorkspaceCard, useWorkspace } from './KeyBox';
import { HelpTip } from './Help';

type Render = RenderRecord & { watchUrl?: string | null };

const STATUS: Record<RenderRecord['status'], string> = {
  queued: 'Waiting for a render worker',
  rendering: 'Rendering',
  uploading: 'Uploading',
  done: 'Ready',
  failed: 'Failed',
};

/** What part of the timeline to export: all of it, the in/out range, or a range marker's span (`marker:<id>`). */
type RangeChoice = 'all' | 'inout' | `marker:${string}`;

const span = (r: FrameRange, fps: number) => `${formatTimecode(r.start, fps)}–${formatTimecode(r.end, fps)} · ${formatSeconds(r.end - r.start, fps)}`;

function choiceRange(choice: RangeChoice, timeline: Timeline, inout: FrameRange | null): FrameRange | null {
  if (choice === 'inout') return inout;
  if (choice.startsWith('marker:')) {
    const m = timeline.markers.find((x) => `marker:${x.id}` === choice && x.duration);
    return m ? { start: m.frame, end: Math.min(m.frame + (m.duration ?? 0), timelineDuration(timeline)) } : null;
  }
  return null;
}

function watchLink(r: Render): string | null {
  if (r.watchUrl) return r.watchUrl;
  return r.publishedAt ? `${location.origin}/w/${r.id}` : null;
}

export function ExportPanel() {
  const projectId = useEditor((s) => s.projectId);
  const canEdit = useEditor((s) => s.canEdit);
  const doc = useEditor((s) => s.doc);
  const timelineId = useEditor((s) => s.timelineId);
  const server = useEditor((s) => s.server);
  const saveState = useEditor((s) => s.saveState);
  const timeline = activeTimeline({ doc, timelineId });
  const [renders, setRenders] = useState<Render[]>([]);
  const [preset, setPreset] = useState<RenderPresetId>('mp4-1080p');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const local = server?.mode === 'local';
  const workspace = useWorkspace();
  const markIn = useEditor((s) => s.markIn);
  const markOut = useEditor((s) => s.markOut);
  const playhead = useEditor((s) => s.playhead);
  const inout = markedRange({ doc, timelineId, markIn, markOut });
  const rangeMarkers = timeline.markers.filter((m) => m.duration);
  const [choice, setChoice] = useState<RangeChoice>(() => (inout ? 'inout' : 'all'));
  const range = choiceRange(choice, timeline, inout);
  // A choice that no longer exists (range cleared, marker deleted) falls back to the whole timeline.
  const rangeLost = choice !== 'all' && !range;

  const load = () => api.listRenders(projectId).then(setRenders).catch(() => undefined);
  const active = renders.some((r) => r.status === 'queued' || r.status === 'rendering' || r.status === 'uploading');
  useEffect(() => {
    void load();
    const t = setInterval(load, active ? 2000 : 10000);
    return () => clearInterval(t);
  }, [projectId, active]);

  async function start(publish: boolean) {
    setBusy(true);
    try {
      const s = useEditor.getState();
      if (s.saveState !== 'saved') await new Promise((r) => setTimeout(r, 1200));
      const multi = doc.timelines.length > 1;
      await api.createRender(projectId, preset, {
        timelineId: timeline.id,
        publish,
        title: title || `${doc.title}${multi ? ` · ${timeline.name}` : ''}`,
        description,
        range: rangeLost ? null : range,
      });
      await load();
    } catch (err) {
      useEditor.getState().setToast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** Export still: the frame under the playhead as a PNG, rendered like any other job. */
  async function exportStill() {
    setBusy(true);
    try {
      const at = Math.min(playhead, Math.max(0, timelineDuration(timeline) - 1));
      await api.createRender(projectId, 'still-png', { timelineId: timeline.id, publish: false, range: { start: at, end: at + 1 } });
      await load();
    } catch (err) {
      useEditor.getState().setToast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const empty = timelineDuration(timeline) === 0;
  const fpsOf = (id: string) => doc.timelines.find((t) => t.id === id)?.fps ?? timeline.fps;
  return (
    <div className="export">
      {canEdit && (
        <div className="export-form">
          <div className="export-target">
            Exporting <strong>{timeline.name}</strong> · {timeline.width}×{timeline.height} <HelpTip id="export" />
          </div>
          <label className="field">
            <span>Format</span>
            <select value={preset} onChange={(e) => setPreset(e.target.value as RenderPresetId)}>
              {Object.entries(RENDER_PRESETS)
                .filter(([, p]) => !p.still)
                .map(([id, p]) => (
                  <option key={id} value={id}>
                    {p.label}
                  </option>
                ))}
            </select>
          </label>
          <label className="field">
            <span>Range</span>
            <select value={rangeLost ? 'all' : choice} onChange={(e) => setChoice(e.target.value as RangeChoice)} aria-label="Export range">
              <option value="all">Whole timeline</option>
              <option value="inout" disabled={!inout}>
                {inout ? `In–out · ${span(inout, timeline.fps)}` : 'In–out range (mark with I and O)'}
              </option>
              {rangeMarkers.map((m) => (
                <option key={m.id} value={`marker:${m.id}`}>
                  {m.label} · {span({ start: m.frame, end: m.frame + (m.duration ?? 0) }, timeline.fps)}
                </option>
              ))}
            </select>
          </label>
          <label className="field stacked">
            <span>Title for the watch page</span>
            <input placeholder={doc.title} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
          </label>
          <label className="field stacked">
            <span>Description</span>
            <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} />
          </label>
          <div className="button-row">
            <button disabled={busy || empty} onClick={() => start(false)}>
              Render
            </button>
            <button
              className="primary"
              disabled={busy || empty || (local && !server?.cloudConfigured)}
              onClick={() => start(true)}
              title={local && !server?.cloudConfigured ? 'Run `videdit deploy` to enable publishing' : 'Render and publish a public watch page'}
            >
              Render &amp; publish
            </button>
          </div>
          <div className="button-row still-row">
            <button className="small" disabled={busy || empty} onClick={exportStill} title="Render the frame under the playhead as a PNG">
              Export still (PNG) at {formatTimecode(playhead, timeline.fps)}
            </button>
          </div>
          {saveState !== 'saved' && <p className="hint">Saving your latest edit first…</p>}
          {!local && (
            <div className={`worker-note ${renders.some((r) => r.status === 'queued') ? 'waiting' : ''}`}>
              <p className="hint">
                <HelpTip id="worker" /> Renders run on any computer running the render worker, then appear here (published ones get a watch page).
                {renders.some((r) => r.status === 'queued') && <strong> A render is waiting: start a worker.</strong>}
              </p>
              {workspace ? (
                <WorkspaceCard serverUrl={workspace.serverUrl} workspaceKey={workspace.workspaceKey} />
              ) : (
                <>
                  <CopyLine label="Render machine (run in a terminal)" value={`npx videdit login ${location.origin} && npx videdit worker`} />
                  <p className="hint">It asks for the workspace key, which the person who deployed gets with <code>videdit key</code>.</p>
                </>
              )}
            </div>
          )}
          {local && server?.cloudConfigured && workspace && (
            <details className="workspace-details">
              <summary>Workspace key for publishing</summary>
              <WorkspaceCard serverUrl={workspace.serverUrl} workspaceKey={workspace.workspaceKey} />
            </details>
          )}
          {local && !server?.cloudConfigured && (
            <p className="hint">
              Rendering runs on this computer. To publish, run <code>videdit deploy</code> once.
            </p>
          )}
        </div>
      )}
      <ul className="render-list">
        {renders.map((r) => {
          const watch = watchLink(r);
          return (
            <li key={r.id} className={r.status}>
              <div className="render-head">
                <strong>{r.timelineName}</strong>
                <span className="muted">{RENDER_PRESETS[r.preset]?.label}</span>
              </div>
              {r.range && (
                <div className="render-range muted">
                  {RENDER_PRESETS[r.preset]?.still
                    ? `Frame at ${formatTimecode(r.range.start, fpsOf(r.timelineId))}`
                    : `Range ${span(r.range, fpsOf(r.timelineId))}`}
                </div>
              )}
              {r.status === 'done' && RENDER_PRESETS[r.preset]?.still && (
                <a href={renderUrl(projectId, r.id)} target="_blank" rel="noreferrer">
                  <img className="still-thumb" src={renderUrl(projectId, r.id)} alt={`Still of ${r.timelineName}`} />
                </a>
              )}
              <div className="render-status">
                {STATUS[r.status]}
                {(r.status === 'rendering' || r.status === 'uploading') && ` ${Math.round(r.progress * 100)}%`}
                {r.autoPublish && !r.publishedAt && r.status !== 'failed' && ' · will publish'}
              </div>
              {(r.status === 'rendering' || r.status === 'uploading') && (
                <div className="bar">
                  <div style={{ width: `${Math.round(r.progress * 100)}%` }} />
                </div>
              )}
              {r.error && <div className="error">{r.error}</div>}
              <div className="button-row">
                {r.status === 'done' && (
                  <a className="button small" href={renderUrl(projectId, r.id, true)}>
                    Download
                  </a>
                )}
                {watch && (
                  <>
                    <a className="button small primary" href={watch} target="_blank" rel="noreferrer">
                      Watch page
                    </a>
                    <button className="small" onClick={() => navigator.clipboard.writeText(watch)}>
                      Copy link
                    </button>
                  </>
                )}
                {canEdit && r.status === 'done' && !watch && !RENDER_PRESETS[r.preset]?.still && (local ? server?.cloudConfigured : true) && (
                  <button
                    className="small"
                    onClick={async () => {
                      try {
                        await api.publishRender(projectId, r.id, title || doc.title, description);
                        await load();
                      } catch (err) {
                        useEditor.getState().setToast((err as Error).message);
                      }
                    }}
                  >
                    Publish
                  </button>
                )}
                {canEdit && !local && r.publishedAt && (
                  <button
                    className="small"
                    onClick={async () => {
                      await api.unpublishRender(projectId, r.id);
                      await load();
                    }}
                  >
                    Unpublish
                  </button>
                )}
                {canEdit && r.status !== 'rendering' && r.status !== 'uploading' && (
                  <button
                    className="small ghost"
                    title="Delete render"
                    onClick={async () => {
                      await api.deleteRender(projectId, r.id);
                      await load();
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            </li>
          );
        })}
        {renders.length === 0 && <li className="empty">No renders yet.</li>}
      </ul>
    </div>
  );
}
