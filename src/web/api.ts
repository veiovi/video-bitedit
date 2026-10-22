import type { Asset, Comment, Filmstrip, HistoryEntry, ProjectDoc, ProjectRecord, PublishedVideo, RenderPresetId, RenderRecord, ServerInfo } from '../shared/project';

const WORKSPACE_KEY = 'videdit.workspaceKey';
const editKeyName = (projectId: string) => `videdit.edit.${projectId}`;

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable (private mode); keys then last for this page only.
  }
}

export const keys = {
  workspace: () => storageGet(WORKSPACE_KEY),
  setWorkspace: (k: string | null) => storageSet(WORKSPACE_KEY, k),
  edit: (projectId: string) => storageGet(editKeyName(projectId)),
  setEdit: (projectId: string, k: string | null) => storageSet(editKeyName(projectId), k),
};

/** Pull an edit key out of the URL fragment (#k=...) into storage, then tidy the URL. */
export function captureEditKeyFromUrl(projectId: string) {
  const match = location.hash.match(/k=([\w-]+)/);
  if (match) {
    keys.setEdit(projectId, match[1]);
    history.replaceState(null, '', location.pathname + location.search);
  }
}

/** An unlock link (…/#ws=KEY) stores the workspace key in this browser, then tidies the URL. */
export function captureWorkspaceKeyFromUrl() {
  const match = location.hash.match(/ws=([\w-]+)/);
  if (match) {
    keys.setWorkspace(match[1]);
    history.replaceState(null, '', location.pathname + location.search);
  }
}

export const unlockLink = (serverUrl: string, key: string) => `${serverUrl.replace(/\/+$/, '')}/#ws=${key}`;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

function authHeaders(projectId?: string): Record<string, string> {
  const h: Record<string, string> = {};
  const ws = keys.workspace();
  if (ws) h['x-workspace-key'] = ws;
  const ek = projectId ? keys.edit(projectId) : null;
  if (ek) h['x-edit-key'] = ek;
  return h;
}

async function request<T>(method: string, path: string, opts: { projectId?: string; body?: unknown; raw?: BodyInit } = {}): Promise<T> {
  const headers = authHeaders(opts.projectId);
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, {
    method,
    headers,
    body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText, data);
  return data as T;
}

export const mediaUrl = (projectId: string, assetId: string) => `/m/${projectId}/a/${assetId}`;
export const thumbUrl = (projectId: string, assetId: string) => `/m/${projectId}/a/${assetId}/thumb`;
export const filmstripUrl = (projectId: string, assetId: string) => `/m/${projectId}/a/${assetId}/filmstrip`;
export const transcriptUrl = (projectId: string, assetId: string) => `/m/${projectId}/a/${assetId}/transcript`;
export const peaksUrl = (projectId: string, assetId: string) => `/m/${projectId}/a/${assetId}/peaks`;
export const renderUrl = (projectId: string, renderId: string, download = false) =>
  `/m/${projectId}/r/${renderId}${download ? '?download=1' : ''}`;

export const api = {
  checkWorkspace: () => request<{ ok: boolean }>('GET', '/api/workspace'),
  listProjects: () =>
    request<{ id: string; title: string; version: number; updatedAt: number; deletedAt?: number | null }[]>('GET', '/api/projects'),
  createProject: (title: string) => request<{ id: string; editKey: string }>('POST', '/api/projects', { body: { title } }),
  deleteProject: (id: string) => request<{ ok: true }>('DELETE', `/api/p/${id}`),
  getProject: (id: string) =>
    request<{ project: ProjectRecord; assets: Asset[]; canEdit: boolean }>('GET', `/api/p/${id}`, { projectId: id }),
  getVersion: (id: string) => request<{ version: number }>('GET', `/api/p/${id}/version`),
  saveProject: (id: string, doc: ProjectDoc, baseVersion: number) =>
    request<{ version: number }>('PUT', `/api/p/${id}`, { projectId: id, body: { doc, baseVersion } }),
  rotateEditKey: (id: string) => request<{ editKey: string }>('POST', `/api/p/${id}/edit-key`, { projectId: id }),

  createAsset: (id: string, meta: Partial<Asset>) =>
    request<{ asset: Asset }>('POST', `/api/p/${id}/assets`, { projectId: id, body: meta }),
  uploadPart: (id: string, assetId: string, n: number, chunk: Blob) =>
    request<{ partNumber: number; etag: string }>('PUT', `/api/p/${id}/assets/${assetId}/parts/${n}`, { projectId: id, raw: chunk }),
  completeAsset: (id: string, assetId: string, parts: { partNumber: number; etag: string }[]) =>
    request<{ asset: Asset }>('POST', `/api/p/${id}/assets/${assetId}/complete`, { projectId: id, body: { parts } }),
  putThumb: (id: string, assetId: string, jpeg: Blob) =>
    request<{ ok: true }>('PUT', `/api/p/${id}/assets/${assetId}/thumb`, { projectId: id, raw: jpeg }),
  putPeaks: (id: string, assetId: string, peaks: number[]) =>
    request<{ ok: true }>('PUT', `/api/p/${id}/assets/${assetId}/peaks`, { projectId: id, raw: JSON.stringify(peaks) }),
  putFilmstrip: (id: string, assetId: string, strip: Filmstrip, jpeg: Blob) =>
    request<{ asset: Asset }>(
      'PUT',
      `/api/p/${id}/assets/${assetId}/filmstrip?${new URLSearchParams(Object.entries(strip).map(([k, v]) => [k, String(v)]))}`,
      { projectId: id, raw: jpeg },
    ),
  renameAsset: (id: string, assetId: string, name: string) =>
    request<{ asset: Asset }>('PATCH', `/api/p/${id}/assets/${assetId}`, { projectId: id, body: { name } }),
  deleteAsset: (id: string, assetId: string) => request<{ ok: true }>('DELETE', `/api/p/${id}/assets/${assetId}`, { projectId: id }),

  listComments: (id: string) => request<Comment[]>('GET', `/api/p/${id}/comments`),
  addComment: (id: string, frame: number, author: string, body: string) =>
    request<Comment>('POST', `/api/p/${id}/comments`, { body: { frame, author, body } }),
  resolveComment: (id: string, commentId: string, resolved: boolean) =>
    request<{ ok: true }>('PATCH', `/api/p/${id}/comments/${commentId}`, { projectId: id, body: { resolved } }),
  deleteComment: (id: string, commentId: string) =>
    request<{ ok: true }>('DELETE', `/api/p/${id}/comments/${commentId}`, { projectId: id }),

  listRenders: (id: string) => request<RenderRecord[]>('GET', `/api/p/${id}/renders`),
  createRender: (id: string, preset: RenderPresetId, opts: { timelineId: string; publish: boolean; title?: string; description?: string }) =>
    request<RenderRecord>('POST', `/api/p/${id}/renders`, { projectId: id, body: { preset, ...opts } }),
  deleteRender: (id: string, renderId: string) => request<{ ok: true }>('DELETE', `/api/p/${id}/renders/${renderId}`, { projectId: id }),
  publishRender: (id: string, renderId: string, title: string, description: string) =>
    request<RenderRecord>('POST', `/api/p/${id}/renders/${renderId}/publish`, { projectId: id, body: { title, description } }),
  unpublishRender: (id: string, renderId: string) =>
    request<RenderRecord>('DELETE', `/api/p/${id}/renders/${renderId}/publish`, { projectId: id }),

  generateImage: (id: string, prompt: string, aspect: string) =>
    request<{ asset: Asset }>('POST', `/api/p/${id}/generate`, { projectId: id, body: { prompt, aspect } }),
  history: (id: string) => request<HistoryEntry[]>('GET', `/api/p/${id}/history`),
  versionDoc: (id: string, version: number) => request<{ version: number; doc: ProjectDoc }>('GET', `/api/p/${id}/history/${version}`),
  restoreVersion: (id: string, version: number) =>
    request<{ version: number }>('POST', `/api/p/${id}/history/${version}/restore`, { projectId: id }),
  untrashProject: (id: string) => request<{ ok: true }>('POST', `/api/p/${id}/untrash`),
  /** Local mode only: the cloud workspace this machine deployed or logged in to. */
  localWorkspace: () => request<{ serverUrl: string; workspaceKey: string } | null>('GET', '/api/local-workspace'),
  health: () => request<ServerInfo>('GET', '/api/health'),
  /** Local mode only: upload this folder to the configured cloud. */
  push: (id: string, force = false) => request<{ editUrl: string; viewUrl: string }>('POST', `/api/p/${id}/push`, { body: { force } }),

  getPublished: (renderId: string) => request<PublishedVideo>('GET', `/api/w/${renderId}`),
  listPublished: () => request<PublishedVideo[]>('GET', '/api/published'),
};
