// Cloudflare Worker: JSON API under /api, media streaming under /m, and
// link-preview metadata for public watch pages under /w. Everything else is
// the single-page app served from static assets.
//
// Access model:
//   - Project ID (in the URL) grants read access, comments, and media playback.
//   - The project's edit key (x-edit-key) grants edits, uploads, renders and publishing.
//   - The workspace key (x-workspace-key) grants everything, plus creating
//     projects and claiming render jobs.

import { isTranscript } from '../shared/captions';
import {
  CLIENT_ID_PATTERN,
  HISTORY,
  type HistoryEntry,
  type Asset,
  type Comment,
  type ProjectDoc,
  type PublishedVideo,
  RENDER_PRESETS,
  type RenderPresetId,
  type RenderRecord,
  emptyDoc,
  findTimeline,
  isFilmstrip,
  newId,
  pickVersions,
  renderExt,
  renderMime,
  renderRange,
  summariseDoc,
  timelineDuration,
  usedAssetIds,
} from '../shared/project';

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  ASSETS: Fetcher;
  WORKSPACE_KEY?: string;
  /** Optional: enables AI stills (POST /api/p/:id/generate) for editors. */
  OPENROUTER_API_KEY?: string;
  IMAGE_MODEL?: string;
}

const MAX_DOC_BYTES = 2_000_000;
const MAX_UPLOAD_BYTES = 20 * 1024 ** 3;
const STALE_RENDER_MS = 15 * 60 * 1000;

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isWorkspace(req: Request, env: Env): boolean {
  const key = req.headers.get('x-workspace-key');
  return Boolean(env.WORKSPACE_KEY && key && timingSafeEqual(key, env.WORKSPACE_KEY));
}

function requireWorkspace(req: Request, env: Env) {
  if (!env.WORKSPACE_KEY) throw new HttpError(500, 'WORKSPACE_KEY is not configured on the server');
  if (!isWorkspace(req, env)) throw new HttpError(401, 'Workspace key required');
}

async function readJson<T>(req: Request, limit = MAX_DOC_BYTES): Promise<T> {
  const text = await req.text();
  if (text.length > limit) throw new HttpError(413, 'Request too large');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

interface ProjectRow {
  id: string;
  edit_key_hash: string;
  title: string;
  doc: string;
  version: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

async function getProject(env: Env, id: string, includeTrashed = false): Promise<ProjectRow> {
  const row = await env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(id).first<ProjectRow>();
  if (!row || (row.deleted_at && !includeTrashed)) throw new HttpError(404, 'Project not found');
  return row;
}

async function canEdit(req: Request, env: Env, project: ProjectRow): Promise<boolean> {
  if (isWorkspace(req, env)) return true;
  const key = req.headers.get('x-edit-key');
  return Boolean(key && timingSafeEqual(await sha256(key), project.edit_key_hash));
}

async function requireEdit(req: Request, env: Env, projectId: string): Promise<ProjectRow> {
  const project = await getProject(env, projectId);
  if (!(await canEdit(req, env, project))) throw new HttpError(403, 'Edit key required');
  return project;
}

interface AssetRow {
  id: string;
  project_id: string;
  kind: Asset['kind'];
  name: string;
  mime: string;
  size: number;
  duration: number | null;
  width: number | null;
  height: number | null;
  r2_key: string;
  upload_id: string | null;
  has_thumb: number;
  /** JSON Filmstrip, or NULL (column added in migration 0003). */
  filmstrip?: string | null;
  status: Asset['status'];
  created_at: number;
}

function parseFilmstrip(text: string | null | undefined): Asset['filmstrip'] {
  if (!text) return null;
  try {
    const f: unknown = JSON.parse(text);
    return isFilmstrip(f) ? f : null;
  } catch {
    return null;
  }
}

function toAsset(r: AssetRow): Asset {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    mime: r.mime,
    size: r.size,
    duration: r.duration,
    width: r.width,
    height: r.height,
    hasThumb: Boolean(r.has_thumb),
    filmstrip: parseFilmstrip(r.filmstrip),
    status: r.status,
    createdAt: r.created_at,
  };
}

interface RenderRow {
  id: string;
  project_id: string;
  timeline_id: string;
  timeline_name: string;
  preset: RenderPresetId;
  doc_version: number;
  doc: string;
  status: RenderRecord['status'];
  progress: number;
  worker: string | null;
  output_key: string | null;
  output_size: number | null;
  upload_id: string | null;
  error: string | null;
  auto_publish: number;
  published_at: number | null;
  publish_title: string | null;
  publish_description: string | null;
  /** The rendered frames [range_start, range_end); both null for the whole timeline. */
  range_start: number | null;
  range_end: number | null;
  created_at: number;
  updated_at: number;
}

function toRender(r: RenderRow): RenderRecord {
  return {
    id: r.id,
    projectId: r.project_id,
    timelineId: r.timeline_id,
    timelineName: r.timeline_name,
    preset: r.preset,
    docVersion: r.doc_version,
    status: r.status,
    progress: r.progress,
    worker: r.worker,
    outputSize: r.output_size,
    error: r.error,
    autoPublish: Boolean(r.auto_publish),
    publishedAt: r.published_at,
    publishTitle: r.publish_title,
    publishDescription: r.publish_description,
    range: r.range_start !== null && r.range_end !== null ? { start: r.range_start, end: r.range_end } : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function getRender(env: Env, projectId: string, renderId: string): Promise<RenderRow> {
  const row = await env.DB.prepare('SELECT * FROM renders WHERE id = ? AND project_id = ?')
    .bind(renderId, projectId)
    .first<RenderRow>();
  if (!row) throw new HttpError(404, 'Render not found');
  return row;
}

function outputExt(preset: RenderPresetId): string {
  return renderExt(preset);
}

function validateDoc(doc: ProjectDoc) {
  if (!doc || doc.schema !== 1 || !Array.isArray(doc.timelines) || doc.timelines.length === 0 || doc.timelines.length > 20) {
    throw new HttpError(400, 'Invalid project document');
  }
  for (const t of doc.timelines) {
    if (!Array.isArray(t.tracks) || !Array.isArray(t.clips)) throw new HttpError(400, 'Invalid timeline');
    if (!(t.fps > 0 && t.fps <= 120 && t.width > 0 && t.width <= 7680 && t.height > 0 && t.height <= 7680)) {
      throw new HttpError(400, 'Invalid timeline dimensions');
    }
  }
}

/** Serve an R2 object with Range and conditional request support so browsers can seek. */
async function serveObject(req: Request, env: Env, key: string, opts: { download?: string; cache?: string } = {}) {
  const object = await env.MEDIA.get(key, { range: req.headers, onlyIf: req.headers });
  if (!object) return new Response('Not found', { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', opts.cache ?? 'private, max-age=3600');
  if (opts.download) headers.set('content-disposition', `attachment; filename="${opts.download.replace(/[^\w.\- ]/g, '_')}"`);
  if (!('body' in object) || !object.body) {
    return new Response(null, { status: 304, headers });
  }
  const range = object.range as { offset?: number; length?: number; suffix?: number } | undefined;
  if (range && req.headers.has('range')) {
    const offset = range.suffix !== undefined ? object.size - range.suffix : (range.offset ?? 0);
    const length = range.suffix !== undefined ? range.suffix : (range.length ?? object.size - offset);
    headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set('content-length', String(length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set('content-length', String(object.size));
  return new Response(object.body, { status: 200, headers });
}

type Handler = (req: Request, env: Env, params: string[], url: URL) => Promise<Response>;

const routes: [string, RegExp, Handler][] = [];
function route(method: string, pattern: string, handler: Handler) {
  routes.push([method, new RegExp('^' + pattern.replace(/:\w+/g, '([^/]+)') + '$'), handler]);
}

// ---- Projects ----

route('GET', '/api/health', async (_req, env) => json({ ok: true, mode: 'cloud', imageGeneration: Boolean(env.OPENROUTER_API_KEY) }));

route('GET', '/api/workspace', async (req, env) => json({ ok: isWorkspace(req, env) }));

route('POST', '/api/projects', async (req, env) => {
  requireWorkspace(req, env);
  const body = await readJson<{ title?: string; doc?: ProjectDoc }>(req);
  const title = (body.title || 'Untitled project').slice(0, 200);
  const doc = body.doc ? { ...body.doc, title } : emptyDoc(title);
  validateDoc(doc);
  const id = newId(14);
  const editKey = newId(28);
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO projects (id, edit_key_hash, title, doc, version, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
  )
    .bind(id, await sha256(editKey), title, JSON.stringify(doc), now, now)
    .run();
  await recordVersion(env, id, 1, JSON.stringify(doc), 'import', now);
  return json({ id, editKey }, 201);
});

route('GET', '/api/projects', async (req, env) => {
  requireWorkspace(req, env);
  const { results } = await env.DB.prepare(
    'SELECT id, title, version, updated_at, deleted_at FROM projects ORDER BY updated_at DESC LIMIT 500',
  ).all<{ id: string; title: string; version: number; updated_at: number; deleted_at: number | null }>();
  return json(results.map((r) => ({ id: r.id, title: r.title, version: r.version, updatedAt: r.updated_at, deletedAt: r.deleted_at })));
});

route('POST', '/api/p/:id/untrash', async (req, env, [id]) => {
  requireWorkspace(req, env);
  await getProject(env, id, true);
  await env.DB.prepare('UPDATE projects SET deleted_at = NULL WHERE id = ?').bind(id).run();
  return json({ ok: true });
});

route('GET', '/api/p/:id', async (req, env, [id]) => {
  const project = await getProject(env, id);
  const { results } = await env.DB.prepare('SELECT * FROM assets WHERE project_id = ? ORDER BY created_at')
    .bind(id)
    .all<AssetRow>();
  return json({
    project: {
      id: project.id,
      title: project.title,
      version: project.version,
      doc: JSON.parse(project.doc),
      updatedAt: project.updated_at,
    },
    assets: results.map(toAsset),
    canEdit: await canEdit(req, env, project),
  });
});

route('GET', '/api/p/:id/version', async (_req, env, [id]) => {
  const row = await env.DB.prepare('SELECT version FROM projects WHERE id = ?').bind(id).first<{ version: number }>();
  if (!row) throw new HttpError(404, 'Project not found');
  return json({ version: row.version });
});

route('PUT', '/api/p/:id', async (req, env, [id]) => {
  await requireEdit(req, env, id);
  const { doc, baseVersion } = await readJson<{ doc: ProjectDoc; baseVersion: number }>(req);
  validateDoc(doc);
  const now = Date.now();
  const result = await env.DB.prepare(
    'UPDATE projects SET doc = ?, title = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? RETURNING version',
  )
    .bind(JSON.stringify(doc), String(doc.title).slice(0, 200), now, id, baseVersion)
    .first<{ version: number }>();
  if (!result) {
    const current = await getProject(env, id);
    return json({ error: 'conflict', version: current.version, doc: JSON.parse(current.doc) }, 409);
  }
  const source = req.headers.get('x-videdit-source') === 'push' ? 'push' : 'editor';
  await recordVersion(env, id, result.version, JSON.stringify(doc), source, now);
  return json({ version: result.version });
});

/**
 * Add a history snapshot. Saves within HISTORY.coalesceMs of the last editor
 * snapshot replace it (so typing doesn't create hundreds of rows); pushes and
 * restores always start a new entry. Keeps the newest HISTORY.keep entries.
 */
async function recordVersion(env: Env, id: string, version: number, doc: string, source: HistoryEntry['source'], now: number) {
  const last = await env.DB.prepare('SELECT version, source, created_at FROM project_versions WHERE project_id = ? ORDER BY version DESC LIMIT 1')
    .bind(id)
    .first<{ version: number; source: string; created_at: number }>();
  if (last && source === 'editor' && last.source === 'editor' && now - last.created_at < HISTORY.coalesceMs) {
    await env.DB.prepare('UPDATE project_versions SET version = ?, doc = ?, updated_at = ? WHERE project_id = ? AND version = ?')
      .bind(version, doc, now, id, last.version)
      .run();
  } else {
    await env.DB.prepare(
      'INSERT OR REPLACE INTO project_versions (project_id, version, doc, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(id, version, doc, source, now, now)
      .run();
  }
  await env.DB.prepare(
    `DELETE FROM project_versions WHERE project_id = ? AND version NOT IN
       (SELECT version FROM project_versions WHERE project_id = ? ORDER BY version DESC LIMIT ?)`,
  )
    .bind(id, id, HISTORY.keep)
    .run();
}

route('GET', '/api/p/:id/history', async (_req, env, [id]) => {
  await getProject(env, id);
  const { results } = await env.DB.prepare(
    'SELECT version, source, created_at, updated_at, doc FROM project_versions WHERE project_id = ? ORDER BY version DESC LIMIT ?',
  )
    .bind(id, HISTORY.keep)
    .all<{ version: number; source: HistoryEntry['source']; created_at: number; updated_at: number; doc: string }>();
  const entries: HistoryEntry[] = results.map((r) => ({
    version: r.version,
    source: r.source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...summariseDoc(JSON.parse(r.doc) as ProjectDoc),
  }));
  return json(entries);
});

route('GET', '/api/p/:id/history/:version', async (_req, env, [id, version]) => {
  await getProject(env, id);
  const row = await env.DB.prepare('SELECT doc FROM project_versions WHERE project_id = ? AND version = ?')
    .bind(id, Number(version))
    .first<{ doc: string }>();
  if (!row) throw new HttpError(404, 'Version not found');
  return json({ version: Number(version), doc: JSON.parse(row.doc) });
});

/** Make an old version current again (as a new version, so nothing is overwritten). */
route('POST', '/api/p/:id/history/:version/restore', async (req, env, [id, version]) => {
  const project = await requireEdit(req, env, id);
  const row = await env.DB.prepare('SELECT doc FROM project_versions WHERE project_id = ? AND version = ?')
    .bind(id, Number(version))
    .first<{ doc: string }>();
  if (!row) throw new HttpError(404, 'Version not found');
  const doc = JSON.parse(row.doc) as ProjectDoc;
  const now = Date.now();
  const result = await env.DB.prepare(
    'UPDATE projects SET doc = ?, title = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? RETURNING version',
  )
    .bind(row.doc, String(doc.title).slice(0, 200), now, id, project.version)
    .first<{ version: number }>();
  if (!result) throw new HttpError(409, 'The project changed while restoring; try again');
  await recordVersion(env, id, result.version, row.doc, 'restore', now);
  // Bring back any media the restored version uses that was removed from the bin since.
  const used = [...usedAssetIds(doc)];
  if (used.length) {
    await env.DB.prepare(`UPDATE assets SET status = 'ready' WHERE project_id = ? AND status = 'deleted' AND id IN (${used.map(() => '?').join(',')})`)
      .bind(id, ...used)
      .run();
  }
  return json({ version: result.version });
});

// Issue a fresh edit link. The old one stops working.
route('POST', '/api/p/:id/edit-key', async (req, env, [id]) => {
  await requireEdit(req, env, id);
  const editKey = newId(28);
  await env.DB.prepare('UPDATE projects SET edit_key_hash = ? WHERE id = ?').bind(await sha256(editKey), id).run();
  return json({ editKey });
});

route('DELETE', '/api/p/:id', async (req, env, [id], url) => {
  requireWorkspace(req, env);
  await getProject(env, id, true);
  // Default: move to the trash. Only ?purge=1 deletes media and history for good.
  if (!url.searchParams.has('purge')) {
    await env.DB.prepare('UPDATE projects SET deleted_at = ? WHERE id = ?').bind(Date.now(), id).run();
    return json({ ok: true, trashed: true });
  }
  let cursor: string | undefined;
  do {
    const listing = await env.MEDIA.list({ prefix: `p/${id}/`, cursor });
    if (listing.objects.length) await env.MEDIA.delete(listing.objects.map((o) => o.key));
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM comments WHERE project_id = ?').bind(id),
    env.DB.prepare('DELETE FROM renders WHERE project_id = ?').bind(id),
    env.DB.prepare('DELETE FROM assets WHERE project_id = ?').bind(id),
    env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(id),
  ]);
  return json({ ok: true });
});

// ---- Assets (chunked upload through the Worker, under the 100 MB request limit) ----

route('POST', '/api/p/:id/assets', async (req, env, [id]) => {
  await requireEdit(req, env, id);
  const body = await readJson<Partial<Asset>>(req);
  const kind = body.kind;
  if (kind !== 'video' && kind !== 'audio' && kind !== 'image') throw new HttpError(400, 'Unsupported asset kind');
  const size = Number(body.size);
  if (!(size > 0 && size <= MAX_UPLOAD_BYTES)) throw new HttpError(400, 'Invalid file size');
  // Pushes from a local project keep their asset IDs so the timeline needs no rewriting.
  let assetId = newId();
  if (body.id !== undefined) {
    if (!CLIENT_ID_PATTERN.test(String(body.id))) throw new HttpError(400, 'Invalid asset id');
    const taken = await env.DB.prepare('SELECT 1 FROM assets WHERE id = ?').bind(body.id).first();
    if (taken) throw new HttpError(409, 'Asset id already exists');
    assetId = String(body.id);
  }
  const key = `p/${id}/a/${assetId}/source`;
  const mime = String(body.mime || 'application/octet-stream').slice(0, 100);
  const upload = await env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType: mime } });
  await env.DB.prepare(
    `INSERT INTO assets (id, project_id, kind, name, mime, size, duration, width, height, r2_key, upload_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?)`,
  )
    .bind(
      assetId,
      id,
      kind,
      String(body.name || 'file').slice(0, 200),
      mime,
      size,
      body.duration ?? null,
      body.width ?? null,
      body.height ?? null,
      key,
      upload.uploadId,
      Date.now(),
    )
    .run();
  const row = await env.DB.prepare('SELECT * FROM assets WHERE id = ?').bind(assetId).first<AssetRow>();
  return json({ asset: toAsset(row!) }, 201);
});

async function getAssetRow(env: Env, projectId: string, assetId: string): Promise<AssetRow> {
  const row = await env.DB.prepare('SELECT * FROM assets WHERE id = ? AND project_id = ?')
    .bind(assetId, projectId)
    .first<AssetRow>();
  if (!row) throw new HttpError(404, 'Asset not found');
  return row;
}

route('PUT', '/api/p/:id/assets/:aid/parts/:n', async (req, env, [id, aid, n]) => {
  await requireEdit(req, env, id);
  const asset = await getAssetRow(env, id, aid);
  if (asset.status !== 'uploading' || !asset.upload_id) throw new HttpError(409, 'Upload already finished');
  const partNumber = Number(n);
  if (!(partNumber >= 1 && partNumber <= 10000) || !req.body) throw new HttpError(400, 'Invalid part');
  const upload = env.MEDIA.resumeMultipartUpload(asset.r2_key, asset.upload_id);
  const part = await upload.uploadPart(partNumber, req.body);
  return json(part);
});

route('POST', '/api/p/:id/assets/:aid/complete', async (req, env, [id, aid]) => {
  await requireEdit(req, env, id);
  const asset = await getAssetRow(env, id, aid);
  if (asset.status !== 'uploading' || !asset.upload_id) throw new HttpError(409, 'Upload already finished');
  const { parts } = await readJson<{ parts: R2UploadedPart[] }>(req);
  const upload = env.MEDIA.resumeMultipartUpload(asset.r2_key, asset.upload_id);
  const object = await upload.complete(parts);
  await env.DB.prepare("UPDATE assets SET status = 'ready', upload_id = NULL, size = ? WHERE id = ?")
    .bind(object.size, aid)
    .run();
  return json({ asset: toAsset(await getAssetRow(env, id, aid)) });
});

route('PUT', '/api/p/:id/assets/:aid/thumb', async (req, env, [id, aid]) => {
  await requireEdit(req, env, id);
  const asset = await getAssetRow(env, id, aid);
  const bytes = await req.arrayBuffer();
  if (bytes.byteLength > 2_000_000) throw new HttpError(413, 'Thumbnail too large');
  await env.MEDIA.put(asset.r2_key.replace(/source$/, 'thumb.jpg'), bytes, { httpMetadata: { contentType: 'image/jpeg' } });
  await env.DB.prepare('UPDATE assets SET has_thumb = 1 WHERE id = ?').bind(aid).run();
  return json({ ok: true });
});

// Filmstrip sprite (see shared/project.ts Filmstrip) made by the uploader; its
// layout comes in the query string: ?frames=&every=&width=&height=.
route('PUT', '/api/p/:id/assets/:aid/filmstrip', async (req, env, [id, aid], url) => {
  await requireEdit(req, env, id);
  const asset = await getAssetRow(env, id, aid);
  if (asset.kind !== 'video') throw new HttpError(400, 'Only videos have filmstrips');
  const meta = Object.fromEntries(['frames', 'every', 'width', 'height'].map((k) => [k, Number(url.searchParams.get(k))]));
  if (!isFilmstrip(meta)) throw new HttpError(400, 'Expected frames, every, width and height');
  const bytes = await req.arrayBuffer();
  if (bytes.byteLength > 4_000_000) throw new HttpError(413, 'Filmstrip too large');
  await env.MEDIA.put(asset.r2_key.replace(/source$/, 'filmstrip.jpg'), bytes, { httpMetadata: { contentType: 'image/jpeg' } });
  await env.DB.prepare('UPDATE assets SET filmstrip = ? WHERE id = ?').bind(JSON.stringify(meta), aid).run();
  return json({ asset: toAsset(await getAssetRow(env, id, aid)) });
});

// AI stills: generate with OpenRouter (default meta/muse-image) and store as an image asset.
route('POST', '/api/p/:id/generate', async (req, env, [id]) => {
  await requireEdit(req, env, id);
  if (!env.OPENROUTER_API_KEY) throw new HttpError(409, 'Image generation is not enabled on this server');
  const body = await readJson<{ prompt?: string; aspect?: string; name?: string }>(req, 10_000);
  const prompt = String(body.prompt ?? '').trim().slice(0, 2000);
  if (!prompt) throw new HttpError(400, 'Describe the image to generate');
  const aspect = /^\d{1,2}:\d{1,2}$/.test(String(body.aspect)) ? String(body.aspect) : '16:9';
  const res = await fetch('https://openrouter.ai/api/v1/images', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'X-Title': 'Video bitEdit' },
    body: JSON.stringify({ model: env.IMAGE_MODEL || 'meta/muse-image', prompt: `${prompt}\n\nAspect ratio ${aspect}.`, aspect_ratio: aspect }),
  });
  const data = (await res.json().catch(() => ({}))) as { data?: { b64_json?: string; media_type?: string }[]; error?: { message?: string } };
  const item = data.data?.[0];
  if (!res.ok || !item?.b64_json) throw new HttpError(502, `Image generation failed: ${data.error?.message ?? res.status}`);
  const bytes = Uint8Array.from(atob(item.b64_json), (c) => c.charCodeAt(0));
  const mime = item.media_type || 'image/png';
  const assetId = newId();
  const key = `p/${id}/a/${assetId}/source`;
  await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: mime } });
  await env.MEDIA.put(key.replace(/source$/, 'thumb.jpg'), bytes, { httpMetadata: { contentType: mime } });
  const ext = mime.split('/')[1] || 'png';
  const name = `${String(body.name || prompt).replace(/[^\w -]+/g, '').trim().slice(0, 40) || 'generated'}.${ext}`;
  await env.DB.prepare(
    `INSERT INTO assets (id, project_id, kind, name, mime, size, duration, width, height, r2_key, upload_id, has_thumb, status, created_at)
     VALUES (?, ?, 'image', ?, ?, ?, NULL, NULL, NULL, ?, NULL, 1, 'ready', ?)`,
  )
    .bind(assetId, id, name, mime, bytes.byteLength, key, Date.now())
    .run();
  return json({ asset: toAsset(await getAssetRow(env, id, assetId)) }, 201);
});

// Waveform peaks (JSON array of 0..255 amplitudes) computed by the uploader.
route('PUT', '/api/p/:id/assets/:aid/peaks', async (req, env, [id, aid]) => {
  await requireEdit(req, env, id);
  const asset = await getAssetRow(env, id, aid);
  const text = await req.text();
  if (text.length > 1_000_000) throw new HttpError(413, 'Peaks too large');
  await env.MEDIA.put(asset.r2_key.replace(/source$/, 'peaks.json'), text, { httpMetadata: { contentType: 'application/json' } });
  return json({ ok: true });
});

// Word-timed transcript (see shared/captions.ts) made by `videdit transcribe`.
route('PUT', '/api/p/:id/assets/:aid/transcript', async (req, env, [id, aid]) => {
  await requireEdit(req, env, id);
  const asset = await getAssetRow(env, id, aid);
  const t = await readJson<unknown>(req, 10_000_000);
  if (!isTranscript(t)) throw new HttpError(400, 'Expected a transcript with words');
  await env.MEDIA.put(asset.r2_key.replace(/source$/, 'transcript.json'), JSON.stringify({ ...t, assetId: aid }), {
    httpMetadata: { contentType: 'application/json' },
  });
  return json({ ok: true });
});

route('PATCH', '/api/p/:id/assets/:aid', async (req, env, [id, aid]) => {
  await requireEdit(req, env, id);
  await getAssetRow(env, id, aid);
  const body = await readJson<Partial<Asset>>(req);
  if (body.name) {
    await env.DB.prepare('UPDATE assets SET name = ? WHERE id = ?').bind(String(body.name).slice(0, 200), aid).run();
  }
  return json({ asset: toAsset(await getAssetRow(env, id, aid)) });
});

route('DELETE', '/api/p/:id/assets/:aid', async (req, env, [id, aid]) => {
  await requireEdit(req, env, id);
  const asset = await getAssetRow(env, id, aid);
  if (asset.upload_id) {
    await env.MEDIA.resumeMultipartUpload(asset.r2_key, asset.upload_id).abort().catch(() => undefined);
  }
  if (asset.status === 'uploading') {
    await env.MEDIA.delete(['source', 'thumb.jpg', 'filmstrip.jpg', 'peaks.json', 'transcript.json'].map((f) => asset.r2_key.replace(/source$/, f)));
    await env.DB.prepare('DELETE FROM assets WHERE id = ?').bind(aid).run();
  } else {
    // Hide from the bin but keep the media, so older versions of the timeline still play.
    await env.DB.prepare("UPDATE assets SET status = 'deleted' WHERE id = ?").bind(aid).run();
  }
  return json({ ok: true });
});

// ---- Comments (anyone with the project link may comment) ----

route('GET', '/api/p/:id/comments', async (_req, env, [id]) => {
  await getProject(env, id);
  const { results } = await env.DB.prepare('SELECT * FROM comments WHERE project_id = ? ORDER BY frame, created_at')
    .bind(id)
    .all<{ id: string; frame: number; author: string; body: string; resolved: number; created_at: number }>();
  const comments: Comment[] = results.map((r) => ({
    id: r.id,
    frame: r.frame,
    author: r.author,
    body: r.body,
    resolved: Boolean(r.resolved),
    createdAt: r.created_at,
  }));
  return json(comments);
});

route('POST', '/api/p/:id/comments', async (req, env, [id]) => {
  await getProject(env, id);
  const body = await readJson<{ frame: number; author: string; body: string }>(req, 10_000);
  const text = String(body.body || '').trim().slice(0, 2000);
  if (!text) throw new HttpError(400, 'Empty comment');
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM comments WHERE project_id = ?').bind(id).first<{ n: number }>();
  if ((count?.n ?? 0) >= 2000) throw new HttpError(429, 'Comment limit reached');
  const comment: Comment = {
    id: newId(),
    frame: Math.max(0, Math.round(Number(body.frame) || 0)),
    author: String(body.author || 'Anonymous').trim().slice(0, 60) || 'Anonymous',
    body: text,
    resolved: false,
    createdAt: Date.now(),
  };
  await env.DB.prepare('INSERT INTO comments (id, project_id, frame, author, body, resolved, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
    .bind(comment.id, id, comment.frame, comment.author, comment.body, comment.createdAt)
    .run();
  return json(comment, 201);
});

route('PATCH', '/api/p/:id/comments/:cid', async (req, env, [id, cid]) => {
  await requireEdit(req, env, id);
  const body = await readJson<{ resolved: boolean }>(req, 1000);
  await env.DB.prepare('UPDATE comments SET resolved = ? WHERE id = ? AND project_id = ?')
    .bind(body.resolved ? 1 : 0, cid, id)
    .run();
  return json({ ok: true });
});

route('DELETE', '/api/p/:id/comments/:cid', async (req, env, [id, cid]) => {
  await requireEdit(req, env, id);
  await env.DB.prepare('DELETE FROM comments WHERE id = ? AND project_id = ?').bind(cid, id).run();
  return json({ ok: true });
});

// ---- Renders and publishing ----

route('GET', '/api/p/:id/renders', async (_req, env, [id]) => {
  await getProject(env, id);
  const { results } = await env.DB.prepare('SELECT * FROM renders WHERE project_id = ? ORDER BY created_at DESC LIMIT 50')
    .bind(id)
    .all<RenderRow>();
  return json(results.map(toRender));
});

route('POST', '/api/p/:id/renders', async (req, env, [id]) => {
  const project = await requireEdit(req, env, id);
  const body = await readJson<{
    preset: RenderPresetId;
    timelineId?: string;
    publish?: boolean;
    title?: string;
    description?: string;
    worker?: string;
    range?: unknown;
  }>(req, 20_000);
  if (!(body.preset in RENDER_PRESETS)) throw new HttpError(400, 'Unknown preset');
  const doc = JSON.parse(project.doc) as ProjectDoc;
  const timeline = findTimeline(doc, body.timelineId);
  if (!timeline) throw new HttpError(400, 'Unknown timeline');
  if (timelineDuration(timeline) === 0) throw new HttpError(400, 'The timeline is empty');
  const still = RENDER_PRESETS[body.preset].still;
  if (body.publish && still) throw new HttpError(400, 'Stills cannot be published');
  let range;
  try {
    range = renderRange(body.range, timelineDuration(timeline), still);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  // A workspace client that renders the job itself (`videdit publish`) claims it immediately.
  const selfRender = Boolean(body.worker) && isWorkspace(req, env);
  const now = Date.now();
  const renderId = newId();
  await env.DB.prepare(
    `INSERT INTO renders (id, project_id, timeline_id, timeline_name, preset, doc_version, doc, status, progress, worker,
                          auto_publish, publish_title, publish_description, range_start, range_end, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      renderId,
      id,
      timeline.id,
      timeline.name,
      body.preset,
      project.version,
      project.doc,
      selfRender ? 'rendering' : 'queued',
      selfRender ? String(body.worker).slice(0, 100) : null,
      body.publish ? 1 : 0,
      body.title ? String(body.title).slice(0, 200) : null,
      body.description ? String(body.description).slice(0, 5000) : null,
      range?.start ?? null,
      range?.end ?? null,
      now,
      now,
    )
    .run();
  return json(toRender(await getRender(env, id, renderId)), 201);
});

route('DELETE', '/api/p/:id/renders/:rid', async (req, env, [id, rid]) => {
  await requireEdit(req, env, id);
  const render = await getRender(env, id, rid);
  if (render.output_key) await env.MEDIA.delete(render.output_key);
  await env.DB.prepare('DELETE FROM renders WHERE id = ?').bind(rid).run();
  return json({ ok: true });
});

route('POST', '/api/p/:id/renders/:rid/publish', async (req, env, [id, rid]) => {
  const project = await requireEdit(req, env, id);
  const render = await getRender(env, id, rid);
  if (render.status !== 'done') throw new HttpError(409, 'Only finished renders can be published');
  if (RENDER_PRESETS[render.preset].still) throw new HttpError(409, 'Stills cannot be published');
  const body = await readJson<{ title?: string; description?: string }>(req, 20_000);
  await env.DB.prepare('UPDATE renders SET published_at = ?, publish_title = ?, publish_description = ?, updated_at = ? WHERE id = ?')
    .bind(
      render.published_at ?? Date.now(),
      String(body.title || project.title).slice(0, 200),
      String(body.description || '').slice(0, 5000),
      Date.now(),
      rid,
    )
    .run();
  return json(toRender(await getRender(env, id, rid)));
});

route('DELETE', '/api/p/:id/renders/:rid/publish', async (req, env, [id, rid]) => {
  await requireEdit(req, env, id);
  await getRender(env, id, rid);
  await env.DB.prepare('UPDATE renders SET published_at = NULL, updated_at = ? WHERE id = ?').bind(Date.now(), rid).run();
  return json(toRender(await getRender(env, id, rid)));
});

function publishedVideo(row: RenderRow): PublishedVideo {
  const doc = JSON.parse(row.doc) as ProjectDoc;
  const timeline = findTimeline(doc, row.timeline_id) ?? doc.timelines[0];
  const scale = RENDER_PRESETS[row.preset].scale;
  const sources = new Set(timeline.clips.map((c) => c.assetId).filter(Boolean));
  return {
    renderId: row.id,
    projectId: row.project_id,
    timelineName: row.timeline_name,
    title: row.publish_title || doc.title,
    description: row.publish_description || '',
    preset: row.preset,
    outputSize: row.output_size,
    publishedAt: row.published_at!,
    durationFrames: row.range_start !== null && row.range_end !== null ? row.range_end - row.range_start : timelineDuration(timeline),
    fps: timeline.fps,
    width: Math.round((timeline.width * scale) / 2) * 2,
    height: Math.round((timeline.height * scale) / 2) * 2,
    sourceCount: sources.size,
  };
}

route('GET', '/api/w/:rid', async (_req, env, [rid]) => {
  const row = await env.DB.prepare('SELECT * FROM renders WHERE id = ? AND published_at IS NOT NULL').bind(rid).first<RenderRow>();
  if (!row) throw new HttpError(404, 'Video not found');
  // Other published cuts of the same project (e.g. the full movie and its short) for the version switcher.
  const { results } = await env.DB.prepare('SELECT * FROM renders WHERE project_id = ? AND published_at IS NOT NULL')
    .bind(row.project_id)
    .all<RenderRow>();
  // This render stands for its timeline even if a newer one of it was published later.
  const candidates = results.filter((r) => r.id === row.id || r.timeline_id !== row.timeline_id);
  const versions = pickVersions(candidates.map((r) => ({ ...publishedVideo(r), timelineId: r.timeline_id })));
  return json({ ...publishedVideo(row), versions });
});

route('GET', '/api/published', async (_req, env) => {
  const { results } = await env.DB.prepare(
    'SELECT * FROM renders WHERE published_at IS NOT NULL ORDER BY published_at DESC LIMIT 60',
  ).all<RenderRow>();
  return json(results.map(publishedVideo));
});

// ---- Render workers (authenticated with the workspace key) ----

route('POST', '/api/worker/claim', async (req, env) => {
  requireWorkspace(req, env);
  const { worker } = await readJson<{ worker: string }>(req, 1000);
  const now = Date.now();
  await env.DB.prepare(
    "UPDATE renders SET status = 'queued', worker = NULL, progress = 0 WHERE status IN ('rendering', 'uploading') AND updated_at < ?",
  )
    .bind(now - STALE_RENDER_MS)
    .run();
  const row = await env.DB.prepare(
    `UPDATE renders SET status = 'rendering', worker = ?, progress = 0, error = NULL, updated_at = ?
     WHERE id = (SELECT id FROM renders WHERE status = 'queued' ORDER BY created_at LIMIT 1) AND status = 'queued'
     RETURNING *`,
  )
    .bind(String(worker || 'worker').slice(0, 100), now)
    .first<RenderRow>();
  if (!row) return json({ render: null });
  const { results } = await env.DB.prepare("SELECT * FROM assets WHERE project_id = ? AND status = 'ready'")
    .bind(row.project_id)
    .all<AssetRow>();
  return json({ render: toRender(row), doc: JSON.parse(row.doc), assets: results.map(toAsset) });
});

async function workerRender(req: Request, env: Env, rid: string): Promise<RenderRow> {
  requireWorkspace(req, env);
  const row = await env.DB.prepare('SELECT * FROM renders WHERE id = ?').bind(rid).first<RenderRow>();
  if (!row) throw new HttpError(404, 'Render not found');
  return row;
}

route('POST', '/api/worker/renders/:rid/progress', async (req, env, [rid]) => {
  const row = await workerRender(req, env, rid);
  if (row.status !== 'rendering' && row.status !== 'uploading') throw new HttpError(409, 'Render is not active');
  const { progress, status } = await readJson<{ progress: number; status?: 'rendering' | 'uploading' }>(req, 1000);
  await env.DB.prepare('UPDATE renders SET progress = ?, status = ?, updated_at = ? WHERE id = ?')
    .bind(Math.min(1, Math.max(0, Number(progress) || 0)), status ?? row.status, Date.now(), rid)
    .run();
  return json({ ok: true });
});

route('POST', '/api/worker/renders/:rid/fail', async (req, env, [rid]) => {
  await workerRender(req, env, rid);
  const { error } = await readJson<{ error: string }>(req, 20_000);
  await env.DB.prepare("UPDATE renders SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
    .bind(String(error || 'Render failed').slice(0, 4000), Date.now(), rid)
    .run();
  return json({ ok: true });
});

route('POST', '/api/worker/renders/:rid/upload', async (req, env, [rid]) => {
  const row = await workerRender(req, env, rid);
  const key = `p/${row.project_id}/r/${rid}/output.${outputExt(row.preset)}`;
  const contentType = renderMime(row.preset);
  const upload = await env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType } });
  await env.DB.prepare("UPDATE renders SET status = 'uploading', output_key = ?, upload_id = ?, updated_at = ? WHERE id = ?")
    .bind(key, upload.uploadId, Date.now(), rid)
    .run();
  return json({ ok: true });
});

route('PUT', '/api/worker/renders/:rid/upload/:n', async (req, env, [rid, n]) => {
  const row = await workerRender(req, env, rid);
  if (!row.output_key || !row.upload_id || !req.body) throw new HttpError(409, 'No upload in progress');
  const part = await env.MEDIA.resumeMultipartUpload(row.output_key, row.upload_id).uploadPart(Number(n), req.body);
  await env.DB.prepare('UPDATE renders SET updated_at = ? WHERE id = ?').bind(Date.now(), rid).run();
  return json(part);
});

route('POST', '/api/worker/renders/:rid/complete', async (req, env, [rid]) => {
  const row = await workerRender(req, env, rid);
  if (!row.output_key || !row.upload_id) throw new HttpError(409, 'No upload in progress');
  const { parts } = await readJson<{ parts: R2UploadedPart[] }>(req);
  const object = await env.MEDIA.resumeMultipartUpload(row.output_key, row.upload_id).complete(parts);
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE renders SET status = 'done', progress = 1, upload_id = NULL, output_size = ?, updated_at = ?,
       published_at = CASE WHEN auto_publish = 1 THEN COALESCE(published_at, ?) ELSE published_at END
     WHERE id = ?`,
  )
    .bind(object.size, now, now, rid)
    .run();
  return json({ ok: true });
});

// ---- Media ----

route('GET', '/m/:id/a/:aid', async (req, env, [id, aid]) => {
  const asset = await getAssetRow(env, id, aid);
  if (asset.status !== 'ready') throw new HttpError(409, 'Upload not finished');
  return serveObject(req, env, asset.r2_key);
});

route('GET', '/m/:id/a/:aid/thumb', async (req, env, [id, aid]) => {
  const asset = await getAssetRow(env, id, aid);
  return serveObject(req, env, asset.r2_key.replace(/source$/, 'thumb.jpg'));
});

route('GET', '/m/:id/a/:aid/filmstrip', async (req, env, [id, aid]) => {
  const asset = await getAssetRow(env, id, aid);
  return serveObject(req, env, asset.r2_key.replace(/source$/, 'filmstrip.jpg'));
});

route('GET', '/m/:id/a/:aid/peaks', async (req, env, [id, aid]) => {
  const asset = await getAssetRow(env, id, aid);
  return serveObject(req, env, asset.r2_key.replace(/source$/, 'peaks.json'));
});

route('GET', '/m/:id/a/:aid/transcript', async (req, env, [id, aid]) => {
  const asset = await getAssetRow(env, id, aid);
  // Re-transcribing replaces it, so always revalidate.
  return serveObject(req, env, asset.r2_key.replace(/source$/, 'transcript.json'), { cache: 'no-cache' });
});

route('GET', '/m/:id/r/:rid', async (req, env, [id, rid], url) => {
  const render = await getRender(env, id, rid);
  if (render.status !== 'done' || !render.output_key) throw new HttpError(409, 'Render not finished');
  const doc = JSON.parse(render.doc) as ProjectDoc;
  const download = url.searchParams.has('download')
    ? `${doc.title || 'video'} - ${render.timeline_name}.${outputExt(render.preset)}`
    : undefined;
  return serveObject(req, env, render.output_key, { download, cache: render.published_at ? 'public, max-age=3600' : undefined });
});

// ---- Link previews for watch pages ----

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

async function watchPage(req: Request, env: Env, rid: string, url: URL): Promise<Response> {
  const page = await env.ASSETS.fetch(new Request(new URL('/', url), req));
  const row = await env.DB.prepare('SELECT * FROM renders WHERE id = ? AND published_at IS NOT NULL').bind(rid).first<RenderRow>();
  if (!row) return page;
  const video = publishedVideo(row);
  const media = `${url.origin}/m/${row.project_id}/r/${rid}`;
  const tags = [
    ['og:title', video.title],
    ['og:description', video.description || 'Made with Video bitEdit'],
    ['og:type', 'video.other'],
    ['og:url', url.href],
    ['og:video', media],
    ['og:video:type', renderMime(row.preset)],
    ['og:video:width', String(video.width)],
    ['og:video:height', String(video.height)],
  ]
    .map(([p, c]) => `<meta property="${p}" content="${escapeAttr(c)}">`)
    .join('');
  return new HTMLRewriter()
    .on('head', {
      element: (el) => {
        el.append(tags, { html: true });
      },
    })
    .on('title', {
      element: (el) => {
        el.setInnerContent(`${video.title} · Video bitEdit`);
      },
    })
    .transform(page);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    try {
      const watch = url.pathname.match(/^\/w\/([^/]+)$/);
      if (watch && req.method === 'GET') return await watchPage(req, env, watch[1], url);
      const method = req.method === 'HEAD' ? 'GET' : req.method;
      for (const [m, re, handler] of routes) {
        if (m !== method) continue;
        const match = url.pathname.match(re);
        if (match) return await handler(req, env, match.slice(1).map(decodeURIComponent), url);
      }
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/m/')) return json({ error: 'Not found' }, 404);
      return env.ASSETS.fetch(req);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: 'Internal error' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
