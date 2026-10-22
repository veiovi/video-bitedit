// Local editor server: serves the built web app and the same /api and /m
// routes as the Cloudflare Worker, backed by a project folder on disk. Renders
// run in this process. Share/publish actions talk to the configured cloud.

import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { isTranscript } from '../shared/captions';
import { type Comment, type ProjectDoc, RENDER_PRESETS, type RenderPresetId, type ServerInfo, findTimeline, newId, timelineDuration } from '../shared/project';
import { publishRender, pushProject, viewUrl, editUrl } from './cloud';
import { loadConfig } from './config';
import { generateIntoProject, openRouterKey } from './imagegen';
import { type LocalAsset, type LocalRender, LocalProject } from './local-project';
import { mimeFor } from './media';
import { renderTimeline } from './render';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLIENT_DIR = path.join(ROOT, 'dist/client');

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

function send(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function body(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

async function jsonBody<T>(req: http.IncomingMessage): Promise<T> {
  try {
    return JSON.parse((await body(req)).toString('utf8') || '{}') as T;
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function serveFile(req: http.IncomingMessage, res: http.ServerResponse, file: string, opts: { type?: string; download?: string } = {}) {
  if (!existsSync(file)) throw new HttpError(404, 'File not found');
  const size = statSync(file).size;
  const headers: http.OutgoingHttpHeaders = {
    'content-type': opts.type ?? mimeFor(file),
    'accept-ranges': 'bytes',
    'cache-control': 'no-cache',
  };
  if (opts.download) headers['content-disposition'] = `attachment; filename="${opts.download.replace(/[^\w.\- ]/g, '_')}"`;
  const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && size > 0) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (start > end) {
      res.writeHead(416, { 'content-range': `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
    if (req.method === 'HEAD') return void res.end();
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'content-length': size });
  if (req.method === 'HEAD') return void res.end();
  createReadStream(file).pipe(res);
}

function publicAsset(a: LocalAsset) {
  const { path: _path, ...rest } = a;
  return rest;
}

function publicRender(r: LocalRender) {
  return r;
}

export interface LocalServer {
  url: string;
  project: LocalProject;
  close(): Promise<void>;
}

export async function startLocalServer(project: LocalProject, opts: { port?: number; host?: string } = {}): Promise<LocalServer> {
  const host = opts.host ?? '127.0.0.1';
  let baseUrl = '';
  let rendering: Promise<void> = Promise.resolve();

  function mediaSources(): Record<string, string> {
    const sources: Record<string, string> = {};
    for (const a of project.state.assets) sources[a.id] = `${baseUrl}/m/${project.state.id}/a/${a.id}`;
    return sources;
  }

  /** Renders run one at a time, in the order they were requested. */
  function enqueueRender(render: LocalRender, doc: ProjectDoc) {
    rendering = rendering.then(async () => {
      const safeTitle =
        `${doc.title || 'video'} ${render.timelineName}`.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'video';
      const ext = RENDER_PRESETS[render.preset].audioOnly ? 'mp3' : 'mp4';
      const output = path.join(project.exportsDir(), `${safeTitle}-${render.id}.${ext}`);
      project.updateRender(render.id, { status: 'rendering', progress: 0 });
      try {
        await renderTimeline({
          doc,
          timelineId: render.timelineId,
          sources: mediaSources(),
          preset: render.preset,
          output,
          onProgress: (progress) => project.updateRender(render.id, { progress }),
        });
        project.updateRender(render.id, { status: 'done', progress: 1, outputPath: output, outputSize: statSync(output).size });
        if (render.autoPublish) await publishLocalRender(render.id);
      } catch (err) {
        project.updateRender(render.id, { status: 'failed', error: (err as Error).message.slice(0, 4000) });
      }
    });
  }

  async function publishLocalRender(renderId: string) {
    const render = project.renders.find((r) => r.id === renderId);
    if (!render?.outputPath) throw new HttpError(409, 'Render has no output');
    const config = loadConfig();
    if (!config) throw new HttpError(409, 'No cloud configured. Run `videdit deploy` first.');
    project.updateRender(renderId, { status: 'uploading' });
    try {
      await pushProject(project, config, { force: false });
      const watchUrl = await publishRender(project, config, render.outputPath, render.preset, render.timelineId, {
        title: render.publishTitle ?? project.state.doc.title,
        description: render.publishDescription ?? '',
      });
      project.updateRender(renderId, { status: 'done', watchUrl, publishedAt: Date.now() });
    } catch (err) {
      project.updateRender(renderId, { status: 'done', error: `Publish failed: ${(err as Error).message}` });
      throw err;
    }
  }

  async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const m = (pattern: string) => url.pathname.match(new RegExp('^' + pattern.replace(/:\w+/g, '([^/]+)') + '$'));
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const state = project.state;
    const checkProject = (id: string) => {
      if (id !== state.id) throw new HttpError(404, 'Project not found');
    };
    let p: RegExpMatchArray | null;

    if (method === 'GET' && url.pathname === '/api/health') {
      const remote = project.remote;
      const info: ServerInfo = {
        ok: true,
        mode: 'local',
        cloudConfigured: Boolean(loadConfig()),
        imageGeneration: Boolean(openRouterKey()),
        remote: remote
          ? { serverUrl: remote.serverUrl, projectId: remote.projectId, editUrl: editUrl(remote), viewUrl: viewUrl(remote) }
          : null,
      };
      return send(res, 200, info);
    }
    if (method === 'GET' && url.pathname === '/api/workspace') return send(res, 200, { ok: true });
    // Loopback only: lets the local editor show and copy the cloud workspace key.
    if (method === 'GET' && url.pathname === '/api/local-workspace') return send(res, 200, loadConfig());
    if (method === 'GET' && url.pathname === '/api/projects') {
      return send(res, 200, [{ id: state.id, title: state.doc.title, version: state.version, updatedAt: Date.now() }]);
    }
    if (method === 'GET' && url.pathname === '/api/published') return send(res, 200, []);

    if ((p = m('/api/p/:id')) && method === 'GET') {
      checkProject(p[1]);
      await project.scan();
      // Videos imported before filmstrips existed get one in the background.
      void project.backfillFilmstrips().catch(() => undefined);
      const s = project.state;
      return send(res, 200, {
        project: { id: s.id, title: s.doc.title, version: s.version, doc: s.doc, updatedAt: Date.now() },
        assets: s.assets.filter((a) => a.status !== 'deleted').map(publicAsset),
        canEdit: true,
      });
    }
    if ((p = m('/api/p/:id/version')) && method === 'GET') {
      checkProject(p[1]);
      return send(res, 200, { version: project.state.version });
    }
    if ((p = m('/api/p/:id')) && method === 'PUT') {
      checkProject(p[1]);
      const { doc, baseVersion } = await jsonBody<{ doc: ProjectDoc; baseVersion: number }>(req);
      const version = project.save(doc, baseVersion);
      if (version === null) return send(res, 409, { error: 'conflict', version: project.state.version, doc: project.state.doc });
      return send(res, 200, { version });
    }

    // Uploads through the local editor land in <folder>/imports.
    if ((p = m('/api/p/:id/assets')) && method === 'POST') {
      checkProject(p[1]);
      const meta = await jsonBody<{ name: string; size: number; kind: string }>(req);
      const id = newId();
      const dir = path.join(project.dir, '.videdit', 'uploads', id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, `name-${String(meta.name || 'file').replace(/[/\\]/g, '_').slice(0, 200)}`), '');
      const asset = { id, name: String(meta.name || 'file'), kind: meta.kind, size: meta.size, status: 'uploading' };
      return send(res, 201, { asset });
    }
    if ((p = m('/api/p/:id/assets/:aid/parts/:n')) && method === 'PUT') {
      checkProject(p[1]);
      const dir = path.join(project.dir, '.videdit', 'uploads', p[2]);
      if (!existsSync(dir)) throw new HttpError(404, 'Upload not found');
      await pipeline(req, createWriteStream(path.join(dir, String(Number(p[3])))));
      return send(res, 200, { partNumber: Number(p[3]), etag: p[3] });
    }
    if ((p = m('/api/p/:id/assets/:aid/complete')) && method === 'POST') {
      checkProject(p[1]);
      const aid = p[2];
      const { parts, name } = await jsonBody<{ parts: { partNumber: number }[]; name?: string }>(req);
      const dir = path.join(project.dir, '.videdit', 'uploads', aid);
      const pending = readdirSync(dir);
      const fileName = (name || pending.find((f) => f.startsWith('name-'))?.slice(5) || `${aid}.bin`).replace(/[/\\]/g, '_');
      let target = path.join(project.importsDir(), fileName);
      if (existsSync(target)) target = path.join(project.importsDir(), `${aid}-${fileName}`);
      const out = createWriteStream(target);
      for (const part of [...parts].sort((a, b) => a.partNumber - b.partNumber)) {
        await new Promise<void>((resolve, reject) => {
          const r = createReadStream(path.join(dir, String(part.partNumber)));
          r.on('error', reject);
          r.on('end', resolve);
          r.pipe(out, { end: false });
        });
      }
      await new Promise<void>((resolve) => out.end(resolve));
      rmSync(dir, { recursive: true, force: true });
      const asset = await project.addFile(target, { id: aid });
      if (!asset) throw new HttpError(400, 'Could not read that media file');
      return send(res, 200, { asset: publicAsset(asset) });
    }
    if ((p = m('/api/p/:id/assets/:aid/transcript')) && method === 'PUT') {
      checkProject(p[1]);
      if (!project.asset(p[2])) throw new HttpError(404, 'Asset not found');
      const t = await jsonBody<unknown>(req);
      if (!isTranscript(t)) throw new HttpError(400, 'Expected a transcript with words');
      project.saveTranscript({ ...t, assetId: p[2] });
      return send(res, 200, { ok: true });
    }
    if ((p = m('/api/p/:id/assets/:aid/(thumb|peaks|filmstrip)')) && method === 'PUT') {
      // Thumbnails, peaks and filmstrips are generated locally with FFmpeg; accept and ignore browser ones.
      await body(req);
      return send(res, 200, { ok: true });
    }
    if ((p = m('/api/p/:id/assets/:aid')) && method === 'PATCH') {
      checkProject(p[1]);
      const { name } = await jsonBody<{ name?: string }>(req);
      if (name) project.renameAsset(p[2], name.slice(0, 200));
      return send(res, 200, { asset: publicAsset(project.asset(p[2])!) });
    }
    if ((p = m('/api/p/:id/assets/:aid')) && method === 'DELETE') {
      checkProject(p[1]);
      // Remove from the bin only; never delete the user's source file.
      project.removeAsset(p[2]);
      return send(res, 200, { ok: true });
    }

    if ((p = m('/api/p/:id/comments')) && method === 'GET') {
      checkProject(p[1]);
      return send(res, 200, project.comments);
    }
    if ((p = m('/api/p/:id/comments')) && method === 'POST') {
      checkProject(p[1]);
      const b = await jsonBody<{ frame: number; author: string; body: string }>(req);
      const text = String(b.body || '').trim().slice(0, 2000);
      if (!text) throw new HttpError(400, 'Empty comment');
      const c: Comment = {
        id: newId(),
        frame: Math.max(0, Math.round(Number(b.frame) || 0)),
        author: String(b.author || 'Anonymous').slice(0, 60),
        body: text,
        resolved: false,
        createdAt: Date.now(),
      };
      project.comments = [...project.comments, c].sort((a, b2) => a.frame - b2.frame);
      return send(res, 201, c);
    }
    if ((p = m('/api/p/:id/comments/:cid')) && method === 'PATCH') {
      checkProject(p[1]);
      const { resolved } = await jsonBody<{ resolved: boolean }>(req);
      project.comments = project.comments.map((c) => (c.id === p![2] ? { ...c, resolved } : c));
      return send(res, 200, { ok: true });
    }
    if ((p = m('/api/p/:id/comments/:cid')) && method === 'DELETE') {
      checkProject(p[1]);
      project.comments = project.comments.filter((c) => c.id !== p![2]);
      return send(res, 200, { ok: true });
    }

    if ((p = m('/api/p/:id/renders')) && method === 'GET') {
      checkProject(p[1]);
      return send(res, 200, [...project.renders].reverse().map(publicRender));
    }
    if ((p = m('/api/p/:id/renders')) && method === 'POST') {
      checkProject(p[1]);
      const b = await jsonBody<{ preset: RenderPresetId; timelineId?: string; publish?: boolean; title?: string; description?: string }>(req);
      if (!(b.preset in RENDER_PRESETS)) throw new HttpError(400, 'Unknown preset');
      const doc = project.state.doc;
      const timeline = findTimeline(doc, b.timelineId);
      if (!timeline) throw new HttpError(400, 'Unknown timeline');
      if (timelineDuration(timeline) === 0) throw new HttpError(400, 'The timeline is empty');
      if (b.publish && !loadConfig()) throw new HttpError(409, 'No cloud configured. Run `videdit deploy` first.');
      const now = Date.now();
      const render: LocalRender = {
        id: newId(),
        projectId: project.state.id,
        timelineId: timeline.id,
        timelineName: timeline.name,
        preset: b.preset,
        docVersion: project.state.version,
        status: 'queued',
        progress: 0,
        worker: 'local',
        outputSize: null,
        error: null,
        autoPublish: Boolean(b.publish),
        publishedAt: null,
        publishTitle: b.title ?? null,
        publishDescription: b.description ?? null,
        createdAt: now,
        updatedAt: now,
        outputPath: null,
        watchUrl: null,
      };
      project.renders = [...project.renders, render];
      enqueueRender(render, doc);
      return send(res, 201, render);
    }
    if ((p = m('/api/p/:id/renders/:rid/publish')) && method === 'POST') {
      checkProject(p[1]);
      const b = await jsonBody<{ title?: string; description?: string }>(req);
      project.updateRender(p[2], { publishTitle: b.title ?? null, publishDescription: b.description ?? null });
      await publishLocalRender(p[2]);
      return send(res, 200, project.renders.find((r) => r.id === p![2]));
    }
    if ((p = m('/api/p/:id/renders/:rid')) && method === 'DELETE') {
      checkProject(p[1]);
      project.renders = project.renders.filter((r) => r.id !== p![2]);
      return send(res, 200, { ok: true });
    }

    if ((p = m('/api/p/:id/history')) && method === 'GET') {
      checkProject(p[1]);
      return send(res, 200, project.history());
    }
    if ((p = m('/api/p/:id/history/:version')) && method === 'GET') {
      checkProject(p[1]);
      const doc = project.versionDoc(Number(p[2]));
      if (!doc) throw new HttpError(404, 'Version not found');
      return send(res, 200, { version: Number(p[2]), doc });
    }
    if ((p = m('/api/p/:id/history/:version/restore')) && method === 'POST') {
      checkProject(p[1]);
      return send(res, 200, { version: project.restore(Number(p[2])) });
    }
    if ((p = m('/api/p/:id/generate')) && method === 'POST') {
      checkProject(p[1]);
      const b = await jsonBody<{ prompt?: string; aspect?: string; name?: string }>(req);
      const promptText = String(b.prompt ?? '').trim().slice(0, 2000);
      if (!promptText) throw new HttpError(400, 'Describe the image to generate');
      if (!openRouterKey()) throw new HttpError(409, 'No OpenRouter key. Run `videdit config openrouter-key`.');
      const asset = await generateIntoProject(project, { prompt: promptText, aspect: b.aspect, name: b.name });
      return send(res, 201, { asset: publicAsset(asset) });
    }

    // Local-only: share the folder to the cloud, or bring cloud edits back.
    if ((p = m('/api/p/:id/push')) && method === 'POST') {
      checkProject(p[1]);
      const config = loadConfig();
      if (!config) throw new HttpError(409, 'No cloud configured. Run `videdit deploy` first.');
      const { force } = await jsonBody<{ force?: boolean }>(req);
      const link = await pushProject(project, config, { force: Boolean(force) });
      return send(res, 200, { editUrl: editUrl(link), viewUrl: viewUrl(link) });
    }

    throw new HttpError(404, 'Not found');
  }

  async function handleMedia(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    let p = url.pathname.match(/^\/m\/([^/]+)\/a\/([^/]+)(\/thumb|\/peaks|\/transcript|\/filmstrip)?$/);
    if (p) {
      const asset = project.asset(p[2]);
      if (!asset || p[1] !== project.state.id) throw new HttpError(404, 'Asset not found');
      if (p[3] === '/thumb') return serveFile(req, res, project.thumbFile(asset.id), { type: 'image/jpeg' });
      if (p[3] === '/peaks') {
        await project.ensurePeaks(asset);
        return serveFile(req, res, project.peaksFile(asset.id), { type: 'application/json' });
      }
      if (p[3] === '/transcript') return serveFile(req, res, project.transcriptFile(asset.id), { type: 'application/json' });
      if (p[3] === '/filmstrip') return serveFile(req, res, project.filmstripFile(asset.id), { type: 'image/jpeg' });
      return serveFile(req, res, project.assetFile(asset));
    }
    p = url.pathname.match(/^\/m\/([^/]+)\/r\/([^/]+)$/);
    if (p) {
      const render = project.renders.find((r) => r.id === p![2]);
      if (!render?.outputPath) throw new HttpError(404, 'Render not found');
      return serveFile(req, res, render.outputPath, {
        download: url.searchParams.has('download') ? path.basename(render.outputPath) : undefined,
      });
    }
    throw new HttpError(404, 'Not found');
  }

  async function handleStatic(_req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    let file = path.join(CLIENT_DIR, rel);
    if (!file.startsWith(CLIENT_DIR) || !rel || !existsSync(file) || statSync(file).isDirectory()) {
      file = path.join(CLIENT_DIR, 'index.html');
    }
    if (!existsSync(file)) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      return void res.end('The web app is not built. Run `npm run build` in the Video bitEdit folder.');
    }
    res.writeHead(200, {
      'content-type': STATIC_TYPES[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': file.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(await readFile(file));
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else if (url.pathname.startsWith('/m/')) await handleMedia(req, res, url);
      else await handleStatic(req, res, url);
    } catch (err) {
      if (res.headersSent) return void res.end();
      if (err instanceof HttpError) send(res, err.status, { error: err.message });
      else {
        console.error(err);
        send(res, 500, { error: (err as Error).message });
      }
    }
  });

  const port = await listen(server, host, opts.port ?? 4848);
  baseUrl = `http://${host}:${port}`;
  return {
    url: baseUrl,
    project,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Listen on `preferred`, or the next free port. Pass 0 for any free port. */
function listen(server: http.Server, host: string, preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = preferred;
    const attempt = () => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && port !== 0 && port < preferred + 20) {
          port += 1;
          attempt();
        } else reject(err);
      });
      server.listen(port, host, () => resolve((server.address() as AddressInfo).port));
    };
    attempt();
  });
}
