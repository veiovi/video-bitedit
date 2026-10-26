// A local project is an ordinary folder of clips plus `videdit.json`, which
// holds the timeline and the asset list. Agents may edit `videdit.json`
// directly: external changes bump the version so an open editor reloads.
//
// <folder>/videdit.json          timeline + assets (agent-editable)
// <folder>/exports/              finished renders
// <folder>/imports/              files uploaded through the editor or pulled from the cloud
// <folder>/.videdit/             thumbnails, transcripts, comments, render history, cloud link

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Transcript } from '../shared/captions';
import { type Asset, type Comment, type ProjectDoc, type RenderRecord, emptyDoc, newId, HISTORY, type HistoryEntry, renderActive, summariseDoc, usedAssetIds } from '../shared/project';
import { computePeaks, makeFilmstrip, makeThumbnail, mediaKind, mimeFor, probeMedia } from './media';

export const PROJECT_FILE = 'videdit.json';
const SKIP_DIRS = new Set(['.videdit', 'exports', 'node_modules', '.git']);
const SCAN_DEPTH = 3;

export interface LocalAsset extends Asset {
  /** Path relative to the project folder. */
  path: string;
}

export interface ProjectFile {
  videdit: 1;
  id: string;
  version: number;
  doc: ProjectDoc;
  assets: LocalAsset[];
}

export interface LocalRender extends RenderRecord {
  outputPath: string | null;
  watchUrl: string | null;
}

export interface RemoteLink {
  serverUrl: string;
  projectId: string;
  editKey: string;
  /** Cloud version this folder last pushed or pulled. */
  syncedVersion: number;
}

function writeJsonAtomic(file: string, data: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, file);
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export class LocalProject {
  readonly dir: string;
  private file: string;
  private lastMtime = 0;
  private data!: ProjectFile;

  constructor(dir: string) {
    this.dir = path.resolve(dir);
    this.file = path.join(this.dir, PROJECT_FILE);
    mkdirSync(path.join(this.dir, '.videdit', 'thumbs'), { recursive: true });
    if (!existsSync(this.file)) {
      this.data = { videdit: 1, id: newId(14), version: 1, doc: emptyDoc(path.basename(this.dir)), assets: [] };
      this.write();
    }
    this.read();
  }

  static exists(dir: string) {
    return existsSync(path.join(dir, PROJECT_FILE));
  }

  private read() {
    const mtime = statSync(this.file).mtimeMs;
    if (mtime === this.lastMtime) return;
    const external = this.lastMtime !== 0;
    const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as ProjectFile;
    if (parsed.videdit !== 1 || !parsed.doc || !Array.isArray(parsed.assets)) {
      throw new Error(`${this.file} is not a Video bitEdit project file`);
    }
    this.data = parsed;
    this.lastMtime = mtime;
    if (external) {
      // Edited outside the editor (by an agent or by hand): make open editors reload.
      this.data.version += 1;
      this.write();
      this.snapshot('external');
    }
  }

  private write() {
    writeJsonAtomic(this.file, this.data);
    this.lastMtime = statSync(this.file).mtimeMs;
  }

  get state(): ProjectFile {
    this.read();
    return this.data;
  }

  /** Replace the document if `baseVersion` matches; returns the new version or null on conflict. */
  save(doc: ProjectDoc, baseVersion: number): number | null {
    this.read();
    if (baseVersion !== this.data.version) return null;
    this.data.doc = doc;
    this.data.version += 1;
    this.write();
    this.snapshot('editor');
    return this.data.version;
  }

  /** Overwrite the document unconditionally (cut lists, pull, restore). */
  replaceDoc(doc: ProjectDoc, source: HistoryEntry['source'] = 'cut') {
    this.read();
    this.data.doc = doc;
    this.data.version += 1;
    this.write();
    this.snapshot(source);
  }

  // ---- Version history (.videdit/history/<version>.json) ----

  private historyDir() {
    const dir = path.join(this.dir, '.videdit', 'history');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private historyFiles(): string[] {
    return readdirSync(this.historyDir())
      .filter((f) => /^\d+\.json$/.test(f))
      .sort((a, b) => parseInt(b) - parseInt(a));
  }

  /**
   * Record the current document. Editor saves within HISTORY.coalesceMs of the
   * previous editor snapshot replace it; everything else starts a new entry.
   */
  private snapshot(source: HistoryEntry['source']) {
    const dir = this.historyDir();
    const now = Date.now();
    const [latest] = this.historyFiles();
    let createdAt = now;
    if (latest && source === 'editor') {
      const prev = readJson<{ source: string; createdAt: number } | null>(path.join(dir, latest), null);
      if (prev?.source === 'editor' && now - prev.createdAt < HISTORY.coalesceMs) {
        createdAt = prev.createdAt;
        rmSync(path.join(dir, latest), { force: true });
      }
    }
    writeJsonAtomic(path.join(dir, `${this.data.version}.json`), {
      version: this.data.version,
      source,
      createdAt,
      updatedAt: now,
      doc: this.data.doc,
    });
    for (const old of this.historyFiles().slice(HISTORY.keep)) rmSync(path.join(dir, old), { force: true });
  }

  history(): HistoryEntry[] {
    this.read();
    if (this.historyFiles().length === 0) this.snapshot('import');
    return this.historyFiles().flatMap((f) => {
      const v = readJson<{ version: number; source: HistoryEntry['source']; createdAt: number; updatedAt: number; doc: ProjectDoc } | null>(
        path.join(this.historyDir(), f),
        null,
      );
      return v ? [{ version: v.version, source: v.source, createdAt: v.createdAt, updatedAt: v.updatedAt, ...summariseDoc(v.doc) }] : [];
    });
  }

  versionDoc(version: number): ProjectDoc | null {
    return readJson<{ doc: ProjectDoc } | null>(path.join(this.historyDir(), `${version}.json`), null)?.doc ?? null;
  }

  /** Make an old version current again, as a new version; media it uses comes back to the bin. */
  restore(version: number): number {
    const doc = this.versionDoc(version);
    if (!doc) throw new Error(`Version ${version} not found`);
    const used = usedAssetIds(doc);
    this.read();
    for (const a of this.data.assets) if (used.has(a.id) && a.status === 'deleted') a.status = 'ready';
    this.replaceDoc(doc, 'restore');
    return this.data.version;
  }

  asset(id: string): LocalAsset | undefined {
    return this.state.assets.find((a) => a.id === id);
  }

  assetFile(asset: LocalAsset): string {
    return path.join(this.dir, asset.path);
  }

  thumbFile(assetId: string): string {
    return path.join(this.dir, '.videdit', 'thumbs', `${assetId}.jpg`);
  }

  peaksFile(assetId: string): string {
    return path.join(this.dir, '.videdit', 'thumbs', `${assetId}.peaks.json`);
  }

  filmstripFile(assetId: string): string {
    return path.join(this.dir, '.videdit', 'thumbs', `${assetId}.filmstrip.jpg`);
  }

  private filmstripJobs = new Map<string, Promise<void>>();

  /**
   * Make the filmstrip sprite for a video imported before filmstrips existed
   * (once, even when asked twice at once) and record it on the asset.
   */
  ensureFilmstrip(asset: LocalAsset): Promise<void> {
    const source = this.assetFile(asset);
    if (asset.kind !== 'video' || asset.filmstrip !== undefined || !existsSync(source)) return Promise.resolve();
    let job = this.filmstripJobs.get(asset.id);
    if (!job) {
      job = makeFilmstrip(source, asset.duration, this.filmstripFile(asset.id))
        .then((filmstrip) => {
          this.read();
          const a = this.data.assets.find((x) => x.id === asset.id);
          if (!a) return;
          // null records a video FFmpeg could not sample, so it is not retried every time.
          a.filmstrip = filmstrip;
          this.write();
        })
        .finally(() => this.filmstripJobs.delete(asset.id));
      this.filmstripJobs.set(asset.id, job);
    }
    return job;
  }

  /** Make missing filmstrips one after another; editors see them the next time they load the project. */
  backfillFilmstrips(): Promise<void> {
    const missing = this.state.assets.filter((a) => a.kind === 'video' && a.status !== 'deleted' && a.filmstrip === undefined);
    return missing.reduce((chain, a) => chain.then(() => this.ensureFilmstrip(a)), Promise.resolve());
  }

  private peaksJobs = new Map<string, Promise<void>>();

  /** Make the waveform for a video or audio file imported before it had one (once, even when asked twice at once). */
  ensurePeaks(asset: LocalAsset): Promise<void> {
    const out = this.peaksFile(asset.id);
    const source = this.assetFile(asset);
    if (asset.kind === 'image' || existsSync(out) || !existsSync(source)) return Promise.resolve();
    let job = this.peaksJobs.get(asset.id);
    if (!job) {
      job = computePeaks(source)
        .then((peaks) => writeFileSync(out, JSON.stringify(peaks ?? [])))
        .finally(() => this.peaksJobs.delete(asset.id));
      this.peaksJobs.set(asset.id, job);
    }
    return job;
  }

  transcriptFile(assetId: string): string {
    return path.join(this.dir, '.videdit', 'transcripts', `${assetId}.json`);
  }

  transcript(assetId: string): Transcript | null {
    return readJson<Transcript | null>(this.transcriptFile(assetId), null);
  }

  saveTranscript(t: Transcript) {
    mkdirSync(path.dirname(this.transcriptFile(t.assetId)), { recursive: true });
    writeJsonAtomic(this.transcriptFile(t.assetId), t);
  }

  /** assetId → transcript for every asset that has one. */
  get transcripts(): Record<string, Transcript> {
    const out: Record<string, Transcript> = {};
    for (const a of this.state.assets) {
      const t = this.transcript(a.id);
      if (t) out[a.id] = t;
    }
    return out;
  }

  /** Register a media file that lives inside the project folder. */
  async addFile(absPath: string, opts: { id?: string; name?: string } = {}): Promise<LocalAsset | null> {
    const rel = path.relative(this.dir, absPath).split(path.sep).join('/');
    const existing = this.state.assets.find((a) => a.path === rel);
    if (existing) return existing;
    const probe = await probeMedia(absPath);
    if (!probe) return null;
    const id = opts.id ?? newId();
    const hasThumb = await makeThumbnail(absPath, probe.kind, probe.duration, this.thumbFile(id));
    const filmstrip = probe.kind === 'video' ? await makeFilmstrip(absPath, probe.duration, this.filmstripFile(id)) : undefined;
    // Video waveforms show under the filmstrip; an empty list marks a file with no sound.
    if (probe.kind !== 'image') writeFileSync(this.peaksFile(id), JSON.stringify((await computePeaks(absPath)) ?? []));
    const asset: LocalAsset = {
      id,
      kind: probe.kind,
      name: opts.name ?? path.basename(absPath),
      mime: mimeFor(absPath),
      size: statSync(absPath).size,
      duration: probe.duration,
      width: probe.width,
      height: probe.height,
      hasThumb,
      ...(filmstrip !== undefined && { filmstrip }),
      status: 'ready',
      createdAt: Date.now(),
      path: rel,
    };
    this.read();
    this.data.assets.push(asset);
    this.write();
    return asset;
  }

  /** Find media files in the folder that are not yet assets and add them. */
  async scan(): Promise<LocalAsset[]> {
    const known = new Set(this.state.assets.map((a) => a.path));
    const found: string[] = [];
    const walk = (dir: string, depth: number) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') && entry.name !== '.') continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name) && depth < SCAN_DEPTH) walk(abs, depth + 1);
        } else if (mediaKind(entry.name)) {
          const rel = path.relative(this.dir, abs).split(path.sep).join('/');
          if (!known.has(rel)) found.push(abs);
        }
      }
    };
    walk(this.dir, 0);
    found.sort();
    const added: LocalAsset[] = [];
    for (const file of found) {
      const asset = await this.addFile(file);
      if (asset) added.push(asset);
    }
    return added;
  }

  /** Re-read each video's size from the file, fixing records made before rotation was taken into account. */
  async refreshDimensions(ids: string[]) {
    const fixes = new Map<string, { width: number | null; height: number | null }>();
    for (const id of ids) {
      const a = this.asset(id);
      if (!a || a.kind !== 'video' || !existsSync(this.assetFile(a))) continue;
      const probe = await probeMedia(this.assetFile(a));
      if (probe && (probe.width !== a.width || probe.height !== a.height)) fixes.set(id, { width: probe.width, height: probe.height });
    }
    if (fixes.size === 0) return;
    this.read();
    for (const a of this.data.assets) Object.assign(a, fixes.get(a.id) ?? {});
    this.write();
  }

  /** Hide an asset from the bin. Its entry is kept so older versions still find their media. */
  removeAsset(id: string) {
    this.read();
    const a = this.data.assets.find((x) => x.id === id);
    if (a) a.status = 'deleted';
    this.write();
  }

  renameAsset(id: string, name: string) {
    this.read();
    const a = this.data.assets.find((x) => x.id === id);
    if (a) a.name = name;
    this.write();
  }

  // ---- Side files ----

  private side(name: string) {
    return path.join(this.dir, '.videdit', name);
  }

  get comments(): Comment[] {
    return readJson<Comment[]>(this.side('comments.json'), []);
  }

  set comments(list: Comment[]) {
    writeJsonAtomic(this.side('comments.json'), list);
  }

  get renders(): LocalRender[] {
    return readJson<LocalRender[]>(this.side('renders.json'), []);
  }

  set renders(list: LocalRender[]) {
    writeJsonAtomic(this.side('renders.json'), list);
  }

  updateRender(id: string, patch: Partial<LocalRender>): LocalRender | undefined {
    const list = this.renders;
    const r = list.find((x) => x.id === id);
    if (!r) return undefined;
    Object.assign(r, patch, { updatedAt: Date.now() });
    this.renders = list;
    return r;
  }

  /**
   * Renders run inside the editor that queued them, so one this folder still lists as on its way
   * was cut off when that editor closed. Marks those stopped, or they would keep Render & publish
   * switched off. The editor calls it when it opens the folder.
   */
  endInterruptedRenders() {
    for (const r of this.renders) {
      if (!renderActive(r)) continue;
      this.updateRender(
        r.id,
        r.status === 'uploading' && r.outputPath
          ? { status: 'done', phase: null, error: 'Publishing stopped when the editor closed. Publish it again.' }
          : { status: 'failed', phase: null, error: 'Stopped when the editor closed. Render it again.' },
      );
    }
  }

  get remote(): RemoteLink | null {
    return readJson<RemoteLink | null>(this.side('remote.json'), null);
  }

  set remote(link: RemoteLink | null) {
    writeJsonAtomic(this.side('remote.json'), link);
  }

  exportsDir(): string {
    const dir = path.join(this.dir, 'exports');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  importsDir(): string {
    const dir = path.join(this.dir, 'imports');
    mkdirSync(dir, { recursive: true });
    return dir;
  }
}
