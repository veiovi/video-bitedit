// Keeps the editor's document in step with the server: debounced saves with
// optimistic concurrency, plus polling so other open editors and viewers pick
// up changes.

import { api, ApiError } from './api';
import { clearDraft, writeDraft } from './drafts';
import { useEditor } from './store';

const SAVE_DELAY_MS = 700;
const POLL_MS = 4000;

export function startSync(projectId: string): () => void {
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let saving = false;
  let stopped = false;
  let failures = 0;

  async function save() {
    const state = useEditor.getState();
    if (saving || state.saveState !== 'dirty' || !state.canEdit) return;
    saving = true;
    const doc = state.doc;
    useEditor.setState({ saveState: 'saving' });
    try {
      const { version } = await api.saveProject(projectId, doc, state.version);
      const stillCurrent = useEditor.getState().doc === doc;
      useEditor.setState({ version, saveState: stillCurrent ? 'saved' : 'dirty' });
      if (stillCurrent) clearDraft(projectId);
      failures = 0;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Someone else saved first. Keep our version as a draft (restorable from
        // History), then load theirs.
        writeDraft(projectId, { doc, baseVersion: state.version, savedAt: Date.now(), reason: 'conflict' });
        await reload('This project was changed elsewhere. Your version is kept under History → Unsaved changes.');
      } else {
        // Offline or server error: keep the draft and retry with backoff.
        failures += 1;
        useEditor.setState({ saveState: 'dirty', toast: failures === 1 ? `Not saved yet (${(err as Error).message}) — retrying…` : null });
        clearTimeout(saveTimer);
        saveTimer = setTimeout(save, Math.min(30_000, 2000 * 2 ** failures));
        saving = false;
        return;
      }
    } finally {
      saving = false;
      if (useEditor.getState().saveState === 'dirty' && failures === 0) schedule();
    }
  }

  function schedule() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, SAVE_DELAY_MS);
  }

  async function reload(toast?: string) {
    const { project, assets, canEdit } = await api.getProject(projectId);
    const s = useEditor.getState();
    useEditor.setState({
      doc: project.doc,
      version: project.version,
      assets,
      canEdit,
      past: [],
      future: [],
      saveState: 'saved',
      timelineId: project.doc.timelines.some((t) => t.id === s.timelineId) ? s.timelineId : project.doc.timelines[0].id,
      selection: s.selection.filter((id) => project.doc.timelines.some((t) => t.clips.some((c) => c.id === id))),
      toast: toast ?? s.toast,
    });
  }

  const unsubscribe = useEditor.subscribe((s, prev) => {
    if (s.doc !== prev.doc && s.saveState === 'dirty') {
      writeDraft(projectId, { doc: s.doc, baseVersion: s.version, savedAt: Date.now(), reason: 'unsaved' });
      schedule();
    }
  });

  const poll = setInterval(async () => {
    if (stopped || document.hidden) return;
    const s = useEditor.getState();
    if (s.saveState !== 'saved') return;
    try {
      const { version } = await api.getVersion(projectId);
      if (version > useEditor.getState().version && useEditor.getState().saveState === 'saved') await reload();
    } catch {
      // Offline or transient; the next poll retries.
    }
  }, POLL_MS);

  const flush = () => {
    if (useEditor.getState().saveState === 'dirty') void save();
  };
  window.addEventListener('pagehide', flush);

  return () => {
    stopped = true;
    flush();
    clearInterval(poll);
    clearTimeout(saveTimer);
    unsubscribe();
    window.removeEventListener('pagehide', flush);
  };
}

/** Re-fetch the asset list, e.g. after a collaborator uploads. */
export async function refreshAssets(projectId: string) {
  const { assets } = await api.getProject(projectId);
  useEditor.setState({ assets });
}
