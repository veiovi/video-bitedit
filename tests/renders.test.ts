import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RenderPhase, renderActive, watchRenderId } from '../src/shared/project';
import { type LocalRender, LocalProject } from '../src/node/local-project';
import { type LocalServer, startLocalServer } from '../src/node/local-server';
import { browserDownloadPhase } from '../src/node/render';

describe('renderActive', () => {
  it('is true while a render is queued, rendering or uploading', () => {
    expect(['queued', 'rendering', 'uploading', 'done', 'failed'].map((status) => renderActive({ status: status as LocalRender['status'] }))).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
  });
});

describe('watchRenderId', () => {
  it('reads the render ID at the end of a watch page URL', () => {
    expect(watchRenderId('https://videdit.example.workers.dev/w/0JXZyCgbi7G8')).toBe('0JXZyCgbi7G8');
    expect(watchRenderId('https://videdit.example.workers.dev/w/0JXZyCgbi7G8/')).toBe('0JXZyCgbi7G8');
  });

  it('is null for anything else', () => {
    for (const url of [null, undefined, '', 'not a url', 'https://example.com/p/abc', 'https://example.com/w/abc/extra']) expect(watchRenderId(url), String(url)).toBeNull();
  });
});

describe('browserDownloadPhase', () => {
  it('reports the download in whole percents, then unpacking', () => {
    const phases: RenderPhase[] = [];
    const { onProgress, version } = browserDownloadPhase((p) => phases.push(p))({ chromeMode: 'headless-shell' });
    expect(version).toBeNull();
    const total = 171 * 1_048_576;
    for (const percent of [0, 0.001, 0.004, 0.5, 0.503, 1]) onProgress({ alreadyAvailable: false, percent, downloadedBytes: percent * total, totalSizeInBytes: total });
    expect(phases).toEqual([
      { label: 'Downloading the renderer (once, 171 MB)', progress: 0 },
      { label: 'Downloading the renderer (once, 171 MB)', progress: 0.5 },
      { label: 'Unpacking the renderer', progress: null },
    ]);
  });

  it('stays quiet when the browser is already there', () => {
    const phases: RenderPhase[] = [];
    browserDownloadPhase((p) => phases.push(p))({ chromeMode: 'headless-shell' }).onProgress({ alreadyAvailable: true, percent: 1, downloadedBytes: 0, totalSizeInBytes: 0 });
    expect(phases).toEqual([]);
  });
});

describe('the local server', () => {
  /** A stand-in for the cloud Worker that records each request and answers with `status`. */
  let cloud: http.Server;
  let cloudUrl = '';
  let cloudStatus = 200;
  const calls: Array<{ method?: string; url?: string; workspaceKey?: string; editKey?: string }> = [];
  let dir = '';
  let server: LocalServer | undefined;
  const env = { ...process.env };

  beforeEach(async () => {
    calls.length = 0;
    cloudStatus = 200;
    cloud = http.createServer((req, res) => {
      calls.push({ method: req.method, url: req.url, workspaceKey: req.headers['x-workspace-key'] as string, editKey: req.headers['x-edit-key'] as string });
      res.writeHead(cloudStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify(cloudStatus === 200 ? { ok: true } : { error: 'Render not found' }));
    });
    await new Promise<void>((resolve) => cloud.listen(0, '127.0.0.1', resolve));
    cloudUrl = `http://127.0.0.1:${(cloud.address() as AddressInfo).port}`;
    dir = mkdtempSync(path.join(os.tmpdir(), 'videdit-renders-'));
    // The cloud config comes from these, never from ~/.config/videdit.
    Object.assign(process.env, { VIDEDIT_CONFIG_DIR: path.join(dir, 'config'), VIDEDIT_SERVER_URL: cloudUrl, VIDEDIT_WORKSPACE_KEY: 'test-workspace-key' });
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    await new Promise((resolve) => cloud.close(resolve));
    process.env = { ...env };
    rmSync(dir, { recursive: true, force: true });
  });

  function projectWith(renders: Array<Partial<LocalRender>>) {
    const project = new LocalProject(path.join(dir, 'film'));
    project.remote = { serverUrl: cloudUrl, projectId: 'cloudproject1', editKey: 'test-edit-key', syncedVersion: 1 };
    const now = Date.now();
    project.renders = renders.map((r, i) => ({
      id: `render${i}`,
      projectId: project.state.id,
      timelineId: 'main',
      timelineName: 'Main',
      preset: 'mp4-1080p',
      docVersion: 1,
      status: 'done',
      progress: 1,
      worker: 'local',
      outputSize: 100,
      error: null,
      autoPublish: true,
      publishedAt: null,
      publishTitle: null,
      publishDescription: null,
      createdAt: now,
      updatedAt: now,
      outputPath: null,
      watchUrl: null,
      ...r,
    }));
    return project;
  }

  const unpublish = (project: LocalProject, id: string) =>
    fetch(`${server!.url}/api/p/${project.state.id}/renders/${id}/publish`, { method: 'DELETE' });

  it('unpublishes a render published from this folder by taking down its cloud watch page', async () => {
    const project = projectWith([{ publishedAt: Date.now(), watchUrl: `${cloudUrl}/w/abcdefghijkl` }]);
    server = await startLocalServer(project, { port: 0 });
    const res = await unpublish(project, 'render0');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: 'render0', publishedAt: null, watchUrl: null });
    expect(calls).toEqual([{ method: 'DELETE', url: '/api/p/cloudproject1/renders/abcdefghijkl/publish', workspaceKey: 'test-workspace-key', editKey: 'test-edit-key' }]);
  });

  it('clears a watch page the cloud no longer has', async () => {
    cloudStatus = 404;
    const project = projectWith([{ publishedAt: Date.now(), watchUrl: `${cloudUrl}/w/abcdefghijkl` }]);
    server = await startLocalServer(project, { port: 0 });
    expect((await unpublish(project, 'render0')).status).toBe(200);
    expect(project.renders[0]).toMatchObject({ publishedAt: null, watchUrl: null });
  });

  it('keeps the render published when the cloud refuses', async () => {
    cloudStatus = 500;
    const project = projectWith([{ publishedAt: 1, watchUrl: `${cloudUrl}/w/abcdefghijkl` }]);
    server = await startLocalServer(project, { port: 0 });
    expect((await unpublish(project, 'render0')).status).toBe(500);
    expect(project.renders[0]).toMatchObject({ publishedAt: 1, watchUrl: `${cloudUrl}/w/abcdefghijkl` });
  });

  it('leaves renders on their way alone when it starts for a CLI command', async () => {
    const project = projectWith([{ status: 'rendering', progress: 0.5 }]);
    server = await startLocalServer(project, { port: 0 });
    expect(project.renders[0]).toMatchObject({ status: 'rendering', error: null });
  });

  it('marks renders an earlier editor cut off as stopped when the editor opens the folder again', () => {
    const project = projectWith([
      { status: 'rendering', progress: 0, phase: { label: 'Downloading the renderer (once, 171 MB)', progress: 0.4 }, outputSize: null },
      { status: 'uploading', phase: { label: 'Publishing', progress: null }, outputPath: path.join(dir, 'film.mp4') },
      { status: 'done' },
    ]);
    project.endInterruptedRenders();
    expect(project.renders.map((r) => [r.status, r.phase ?? null, r.error])).toEqual([
      ['failed', null, 'Stopped when the editor closed. Render it again.'],
      ['done', null, 'Publishing stopped when the editor closed. Publish it again.'],
      ['done', null, null],
    ]);
    expect(project.renders.some(renderActive)).toBe(false);
  });
});
