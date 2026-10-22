// Waveform peaks per asset (50 per second, 0..255), fetched once per project
// and shared by the timeline's waveforms, the level meters, Normalize and
// ducking. Loaded peaks are also kept in a small store so meters can redraw
// when they arrive.

import { create } from 'zustand';
import { peaksUrl } from './api';

const cache = new Map<string, Promise<number[] | null>>();

/** assetId → peaks once loaded (null: the asset has none). Keyed by project too, via `projectId`. */
export const usePeakStore = create<{ projectId: string; byAsset: Record<string, number[] | null> }>(() => ({ projectId: '', byAsset: {} }));

export function loadPeaks(projectId: string, assetId: string): Promise<number[] | null> {
  const key = `${projectId}/${assetId}`;
  let p = cache.get(key);
  if (!p) {
    p = fetch(peaksUrl(projectId, assetId))
      .then((r) => (r.ok ? (r.json() as Promise<number[]>) : null))
      .catch(() => null);
    cache.set(key, p);
    void p.then((peaks) => {
      usePeakStore.setState((s) => (s.projectId === projectId ? { byAsset: { ...s.byAsset, [assetId]: peaks } } : { projectId, byAsset: { [assetId]: peaks } }));
    });
  }
  return p;
}

/** Peaks already loaded for an asset of this project, or undefined while unknown. */
export function peaksNow(projectId: string, assetId: string): number[] | null | undefined {
  const s = usePeakStore.getState();
  return s.projectId === projectId ? s.byAsset[assetId] : undefined;
}

/** Start loading the peaks of these assets (already loading or loaded ones are skipped). */
export function ensurePeaks(projectId: string, assetIds: Iterable<string>) {
  for (const id of assetIds) void loadPeaks(projectId, id);
}
