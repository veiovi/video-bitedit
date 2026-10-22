import { useEffect, useState } from 'react';
import { type HistoryEntry, summariseDoc } from '../../shared/project';
import { api } from '../api';
import { type Draft, clearDraft, readDraft } from '../drafts';
import { useEditor } from '../store';
import { HelpTip } from './Help';

const SOURCE: Record<HistoryEntry['source'], string> = {
  editor: 'Edited',
  push: 'Pushed from a folder',
  pull: 'Pulled from the cloud',
  cut: 'Built from a cut list',
  restore: 'Restored',
  external: 'Changed on disk (agent)',
  import: 'First version',
};

function when(ts: number): string {
  const d = new Date(ts);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

export function HistoryPanel() {
  const projectId = useEditor((s) => s.projectId);
  const version = useEditor((s) => s.version);
  const canEdit = useEditor((s) => s.canEdit);
  const saveState = useEditor((s) => s.saveState);
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.history(projectId).then(setEntries).catch(() => undefined);
    setDraft(readDraft(projectId));
  }, [projectId, version, saveState]);

  async function restore(v: number) {
    if (!confirm(`Restore version ${v}? Your current version stays in the history.`)) return;
    setBusy(true);
    try {
      await api.restoreVersion(projectId, v);
      const { project, assets, canEdit: ce } = await api.getProject(projectId);
      useEditor.getState().load(projectId, project.doc, project.version, assets, ce);
      useEditor.getState().setToast(`Restored version ${v}`);
    } catch (err) {
      useEditor.getState().setToast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const pendingDraft = draft && saveState === 'saved' && draft.doc !== useEditor.getState().doc ? draft : null;

  return (
    <div className="history">
      <p className="hint">
        <HelpTip id="history" /> Every change saves automatically. While you edit, a snapshot is kept about every 30 seconds, and the last 300 versions can be
        restored. Restoring adds a new version, so nothing is overwritten.
      </p>
      {pendingDraft && (
        <div className="draft-card">
          <strong>Unsaved changes from this browser</strong>
          <div className="muted small">
            {pendingDraft.reason === 'conflict' ? 'Kept when someone else saved at the same time' : 'Not saved before the page closed'} ·{' '}
            {when(pendingDraft.savedAt)} · {summariseDoc(pendingDraft.doc).clips} clips
          </div>
          <div className="button-row">
            {canEdit && (
              <button
                className="small primary"
                onClick={() => {
                  useEditor.getState().apply(() => pendingDraft.doc);
                  clearDraft(projectId);
                  setDraft(null);
                }}
              >
                Bring back
              </button>
            )}
            <button
              className="small"
              onClick={() => {
                clearDraft(projectId);
                setDraft(null);
              }}
            >
              Discard
            </button>
          </div>
        </div>
      )}
      <ul className="history-list">
        {entries.map((e) => (
          <li key={e.version} className={e.version === version ? 'current' : ''}>
            <div className="history-main">
              <strong>v{e.version}</strong> <span className="muted">{SOURCE[e.source] ?? e.source}</span>
              <div className="muted small">
                {when(e.updatedAt)} · {e.timelines} timeline{e.timelines === 1 ? '' : 's'} · {e.clips} clips
              </div>
            </div>
            {e.version === version ? (
              <span className="current-tag">Current</span>
            ) : (
              canEdit && (
                <button className="small" disabled={busy} onClick={() => restore(e.version)}>
                  Restore
                </button>
              )
            )}
          </li>
        ))}
        {entries.length === 0 && <li className="empty">No history yet.</li>}
      </ul>
    </div>
  );
}
