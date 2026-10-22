// Client for a deployed Video bitEdit Worker: push a local folder, pull cloud edits
// back, upload locally rendered videos, and run the render worker loop.

import { createWriteStream, existsSync } from 'node:fs';
import { open, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isTranscript } from '../shared/captions';
import { type Asset, type FrameRange, type ProjectDoc, type ProjectRecord, type RenderPresetId, type RenderRecord, newId, renderExt, usedAssetIds } from '../shared/project';
import type { CloudConfig } from './config';
import { type LocalProject, type RemoteLink } from './local-project';
import { renderTimeline } from './render';
import { applyPatches, locationPatches } from '../shared/location';

const PART_SIZE = 16 * 1024 * 1024;

export class CloudError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(
  config: CloudConfig,
  method: string,
  pathname: string,
  opts: { json?: unknown; raw?: Uint8Array; editKey?: string } = {},
): Promise<T> {
  // Saves from the CLI show up as "push" in the project's history.
  const headers: Record<string, string> = { 'x-workspace-key': config.workspaceKey, 'x-videdit-source': 'push' };
  if (opts.editKey) headers['x-edit-key'] = opts.editKey;
  if (opts.json !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(config.serverUrl + pathname, {
    method,
    headers,
    body: (opts.raw as BodyInit | undefined) ?? (opts.json !== undefined ? JSON.stringify(opts.json) : undefined),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON error page.
  }
  if (!res.ok) throw new CloudError(res.status, (data as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

export const editUrl = (link: RemoteLink) => `${link.serverUrl}/p/${link.projectId}#k=${link.editKey}`;
export const viewUrl = (link: Pick<RemoteLink, 'serverUrl' | 'projectId'>) => `${link.serverUrl}/p/${link.projectId}`;

/** Upload a file in parts; `putPart` sends one chunk and returns its etag record. */
async function uploadInParts(
  file: string,
  putPart: (n: number, chunk: Uint8Array) => Promise<{ partNumber: number; etag: string }>,
  onProgress?: (sent: number, total: number) => void,
) {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    const read = async (at: number, n: number) => {
      const buf = new Uint8Array(Math.max(0, Math.min(n, size - at)));
      await fh.read(buf, 0, buf.length, at);
      return buf;
    };
    // Blank out where the file was shot (phone GPS); the local original keeps it.
    const patches = await locationPatches(file, size, read);
    const parts: { partNumber: number; etag: string }[] = [];
    let offset = 0;
    let n = 1;
    do {
      const length = Math.min(PART_SIZE, size - offset);
      const buf = new Uint8Array(length);
      await fh.read(buf, 0, length, offset);
      parts.push(await putPart(n, applyPatches(buf, offset, patches)));
      offset += length;
      n += 1;
      onProgress?.(offset, size);
    } while (offset < size);
    return parts;
  } finally {
    await fh.close();
  }
}

export interface PushOptions {
  force?: boolean;
  log?: (msg: string) => void;
}

/**
 * Make the cloud copy match this folder: create the cloud project on first
 * push, upload any assets it is missing (keeping their IDs), then save the
 * timeline. Refuses to overwrite cloud edits that were never pulled unless
 * `force` is set.
 */
export async function pushProject(project: LocalProject, config: CloudConfig, opts: PushOptions = {}): Promise<RemoteLink> {
  const log = opts.log ?? (() => undefined);
  let link = project.remote;
  if (link && link.serverUrl !== config.serverUrl) link = null;
  const state = project.state;

  if (!link) {
    const created = await call<{ id: string; editKey: string }>(config, 'POST', '/api/projects', { json: { title: state.doc.title } });
    link = { serverUrl: config.serverUrl, projectId: created.id, editKey: created.editKey, syncedVersion: 1 };
    project.remote = link;
    log(`Created cloud project ${created.id}`);
  }
  const remote = await call<{ project: ProjectRecord; assets: Asset[] }>(config, 'GET', `/api/p/${link.projectId}`, {
    editKey: link.editKey,
  });
  if (remote.project.version !== link.syncedVersion && !opts.force) {
    throw new CloudError(409, 'The cloud copy has edits you have not pulled. Run `videdit pull` first, or push with --force.');
  }

  const remoteIds = new Set(remote.assets.filter((a) => a.status === 'ready').map((a) => a.id));
  const usedIds = usedAssetIds(state.doc);
  for (const asset of state.assets) {
    if (remoteIds.has(asset.id)) continue;
    if (asset.status === 'deleted' && !usedIds.has(asset.id)) continue;
    const file = project.assetFile(asset);
    if (!existsSync(file)) {
      if (usedIds.has(asset.id)) throw new Error(`Missing source file for ${asset.name}: ${asset.path}`);
      continue;
    }
    const stale = remote.assets.find((a) => a.id === asset.id);
    if (stale) await call(config, 'DELETE', `/api/p/${link.projectId}/assets/${asset.id}`, { editKey: link.editKey });
    log(`Uploading ${asset.name} (${(asset.size / 1e6).toFixed(1)} MB)`);
    const { path: _p, hasThumb: _h, status: _s, createdAt: _c, ...meta } = asset;
    await call(config, 'POST', `/api/p/${link.projectId}/assets`, { json: meta, editKey: link.editKey });
    const parts = await uploadInParts(file, (n, chunk) =>
      call(config, 'PUT', `/api/p/${link!.projectId}/assets/${asset.id}/parts/${n}`, { raw: chunk, editKey: link!.editKey }),
    );
    await call(config, 'POST', `/api/p/${link.projectId}/assets/${asset.id}/complete`, { json: { parts }, editKey: link.editKey });
    remoteIds.add(asset.id);
    const thumb = project.thumbFile(asset.id);
    if (existsSync(thumb)) {
      await call(config, 'PUT', `/api/p/${link.projectId}/assets/${asset.id}/thumb`, {
        raw: await readFile(thumb),
        editKey: link.editKey,
      });
    }
  }

  // Waveforms go up for any media whose cloud copy has none, including media
  // uploaded before video waveforms existed. One too large for the Worker is skipped.
  for (const asset of state.assets) {
    if (!remoteIds.has(asset.id) || asset.kind === 'image') continue;
    const head = await fetch(`${config.serverUrl}/m/${link.projectId}/a/${asset.id}/peaks`, { method: 'HEAD' });
    if (head.ok) continue;
    await project.ensurePeaks(asset);
    const peaks = project.peaksFile(asset.id);
    if (!existsSync(peaks)) continue;
    try {
      await call(config, 'PUT', `/api/p/${link.projectId}/assets/${asset.id}/peaks`, { raw: await readFile(peaks), editKey: link.editKey });
    } catch (err) {
      log(`Skipped the waveform for ${asset.name}: ${(err as Error).message}`);
    }
  }

  // Transcripts are small and may be added after the media was uploaded, so send them every time.
  for (const asset of state.assets) {
    const file = project.transcriptFile(asset.id);
    if (!remoteIds.has(asset.id) || !existsSync(file)) continue;
    await call(config, 'PUT', `/api/p/${link.projectId}/assets/${asset.id}/transcript`, { raw: await readFile(file), editKey: link.editKey });
  }

  const saved = await call<{ version: number }>(config, 'PUT', `/api/p/${link.projectId}`, {
    json: { doc: state.doc, baseVersion: remote.project.version },
    editKey: link.editKey,
  });
  link = { ...link, syncedVersion: saved.version };
  project.remote = link;
  log(`Pushed timeline (cloud version ${saved.version})`);
  return link;
}

/** Bring the cloud timeline (and any media added in the cloud) into this folder. */
export async function pullProject(project: LocalProject, config: CloudConfig, log: (msg: string) => void = () => undefined) {
  const link = project.remote;
  if (!link) throw new Error('This folder has not been pushed yet.');
  const remote = await call<{ project: ProjectRecord; assets: Asset[] }>(config, 'GET', `/api/p/${link.projectId}`, {
    editKey: link.editKey,
  });
  const local = new Set(project.state.assets.map((a) => a.id));
  for (const asset of remote.assets) {
    if (local.has(asset.id) || asset.status !== 'ready') continue;
    log(`Downloading ${asset.name}`);
    const res = await fetch(`${link.serverUrl}/m/${link.projectId}/a/${asset.id}`);
    if (!res.ok || !res.body) throw new Error(`Download failed for ${asset.name}: ${res.status}`);
    let target = path.join(project.importsDir(), asset.name.replace(/[/\\]/g, '_'));
    if (existsSync(target)) target = path.join(project.importsDir(), `${asset.id}-${asset.name.replace(/[/\\]/g, '_')}`);
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(target));
    await project.addFile(target, { id: asset.id, name: asset.name });
  }
  for (const asset of remote.assets) {
    if (asset.status !== 'ready' || project.transcript(asset.id)) continue;
    const res = await fetch(`${link.serverUrl}/m/${link.projectId}/a/${asset.id}/transcript`);
    if (!res.ok) continue;
    const t: unknown = await res.json();
    if (isTranscript(t)) project.saveTranscript({ ...t, assetId: asset.id });
  }
  project.replaceDoc(remote.project.doc, 'pull');
  project.remote = { ...link, syncedVersion: remote.project.version };
  log(`Pulled cloud version ${remote.project.version}`);
}

/**
 * Swap the video behind an existing render, keeping its ID — so a published
 * watch page keeps its URL but shows the corrected video.
 */
export async function replaceRenderOutput(config: CloudConfig, renderId: string, file: string): Promise<string> {
  await uploadRenderOutput(config, renderId, file);
  return `${config.serverUrl}/w/${renderId}`;
}

async function uploadRenderOutput(config: CloudConfig, renderId: string, file: string) {
  await call(config, 'POST', `/api/worker/renders/${renderId}/upload`, { json: {} });
  const parts = await uploadInParts(file, (n, chunk) => call(config, 'PUT', `/api/worker/renders/${renderId}/upload/${n}`, { raw: chunk }));
  await call(config, 'POST', `/api/worker/renders/${renderId}/complete`, { json: { parts } });
}

/** Upload a video rendered on this machine and publish it. Returns the watch page URL. */
export async function publishRender(
  project: LocalProject,
  config: CloudConfig,
  file: string,
  preset: RenderPresetId,
  timelineId: string,
  meta: { title: string; description: string; range?: FrameRange | null },
): Promise<string> {
  const link = project.remote;
  if (!link) throw new Error('Push the project before publishing.');
  const render = await call<RenderRecord>(config, 'POST', `/api/p/${link.projectId}/renders`, {
    json: { preset, timelineId, publish: true, worker: 'local', ...meta },
    editKey: link.editKey,
  });
  await uploadRenderOutput(config, render.id, file);
  return `${config.serverUrl}/w/${render.id}`;
}

/** Claim and render queued cloud jobs until stopped (or once, with `once`). */
export async function runWorker(config: CloudConfig, opts: { once?: boolean; pollMs?: number; log?: (msg: string) => void } = {}) {
  const log = opts.log ?? console.log;
  // A random name, so render records never show this computer's hostname.
  const worker = `worker-${newId(6)}`;
  const pollMs = opts.pollMs ?? 5000;
  log(`Render worker ${worker} polling ${config.serverUrl}`);
  for (;;) {
    const job = await call<{ render: RenderRecord | null; doc?: ProjectDoc; assets?: Asset[] }>(config, 'POST', '/api/worker/claim', {
      json: { worker },
    }).catch((err) => {
      log(`Claim failed: ${(err as Error).message}`);
      return { render: null };
    });
    if (!job.render || !job.doc) {
      if (opts.once) return;
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }
    const { render, doc } = job;
    const sources: Record<string, string> = {};
    for (const a of job.assets ?? []) sources[a.id] = `${config.serverUrl}/m/${render.projectId}/a/${a.id}`;
    const output = path.join(os.tmpdir(), `videdit-${render.id}.${renderExt(render.preset)}`);
    log(`Rendering ${render.id} (${doc.title} · ${render.timelineName}, ${render.preset})`);
    try {
      let lastReport = 0;
      await renderTimeline({
        doc,
        timelineId: render.timelineId,
        sources,
        preset: render.preset,
        output,
        range: render.range,
        onProgress: (progress) => {
          if (Date.now() - lastReport < 2000 && progress < 1) return;
          lastReport = Date.now();
          void call(config, 'POST', `/api/worker/renders/${render.id}/progress`, { json: { progress } }).catch(() => undefined);
        },
      });
      log(`Uploading ${render.id}`);
      await uploadRenderOutput(config, render.id, output);
      log(`Done ${render.id}${render.autoPublish ? ` → ${config.serverUrl}/w/${render.id}` : ''}`);
    } catch (err) {
      log(`Render ${render.id} failed: ${(err as Error).message}`);
      await call(config, 'POST', `/api/worker/renders/${render.id}/fail`, { json: { error: (err as Error).message } }).catch(() => undefined);
    } finally {
      await rm(output, { force: true });
    }
    if (opts.once) return;
  }
}
