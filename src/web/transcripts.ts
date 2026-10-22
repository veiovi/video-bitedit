// Transcripts for the text-based editing panel: fetched per asset from
// /m/:id/a/:aid/transcript, plus the panel's word selection (shaded on the
// ruler) and the last cut it made (so clicking that cut undoes it).

import { create } from 'zustand';
import { type Transcript, isTranscript } from '../shared/captions';
import type { ProjectDoc } from '../shared/project';
import { transcriptUrl } from './api';

interface TranscriptState {
  projectId: string;
  /** assetId → transcript, or null when the asset has none. Missing while loading. */
  byAsset: Record<string, Transcript | null>;
  /** Timeline frames of the words selected in the panel, shaded on the ruler. */
  range: { start: number; end: number } | null;
  /** The last cut made from the panel: the document it produced and where it closed. */
  lastCut: { after: ProjectDoc; at: number } | null;
}

export const useTranscripts = create<TranscriptState>(() => ({ projectId: '', byAsset: {}, range: null, lastCut: null }));

const inflight = new Set<string>();

/** Fetch the transcripts of these assets that are not loaded yet (or all of them with `force`). */
export async function loadTranscripts(projectId: string, assetIds: string[], force = false) {
  if (useTranscripts.getState().projectId !== projectId) useTranscripts.setState({ projectId, byAsset: {}, range: null, lastCut: null });
  const known = useTranscripts.getState().byAsset;
  const wanted = assetIds.filter((id) => (force || !(id in known)) && !inflight.has(`${projectId}/${id}`));
  await Promise.all(
    wanted.map(async (id) => {
      const key = `${projectId}/${id}`;
      inflight.add(key);
      let t: Transcript | null = null;
      try {
        const res = await fetch(transcriptUrl(projectId, id), { cache: 'no-cache' });
        const data: unknown = res.ok ? await res.json() : null;
        t = isTranscript(data) ? data : null;
      } catch {
        t = null;
      } finally {
        inflight.delete(key);
      }
      if (useTranscripts.getState().projectId === projectId) useTranscripts.setState((s) => ({ byAsset: { ...s.byAsset, [id]: t } }));
    }),
  );
}
