// Crash protection: while edits are unsaved, the document is mirrored to this
// browser's storage. If the tab closes, the network drops or a save conflicts,
// the work can be brought back from the History panel (or is restored
// automatically when nothing else changed on the server meanwhile).

import type { ProjectDoc } from '../shared/project';

export interface Draft {
  doc: ProjectDoc;
  /** Server version the edits were based on. */
  baseVersion: number;
  savedAt: number;
  reason: 'unsaved' | 'conflict';
}

const key = (projectId: string) => `videdit.draft.${projectId}`;

export function readDraft(projectId: string): Draft | null {
  try {
    const raw = localStorage.getItem(key(projectId));
    return raw ? (JSON.parse(raw) as Draft) : null;
  } catch {
    return null;
  }
}

export function writeDraft(projectId: string, draft: Draft) {
  try {
    localStorage.setItem(key(projectId), JSON.stringify(draft));
  } catch {
    // Storage full or unavailable; the server copy and history still apply.
  }
}

export function clearDraft(projectId: string) {
  try {
    localStorage.removeItem(key(projectId));
  } catch {
    // Nothing to clear.
  }
}
