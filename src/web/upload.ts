// Browser-side media ingest: probe duration and size, make a thumbnail, then
// upload in chunks small enough for the Worker's request limit.

import type { Asset, AssetKind } from '../shared/project';
import { api } from './api';
import { useEditor } from './store';
import { applyPatches, locationPatches } from '../shared/location';

const PART_SIZE = 16 * 1024 * 1024;
const PARALLEL_PARTS = 3;

export function kindOf(file: File): AssetKind | null {
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  if (file.type.startsWith('image/')) return 'image';
  if (/\.(mp4|mov|webm|mkv|m4v)$/i.test(file.name)) return 'video';
  if (/\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(file.name)) return 'audio';
  if (/\.(png|jpe?g|gif|webp)$/i.test(file.name)) return 'image';
  return null;
}

interface Probe {
  duration: number | null;
  width: number | null;
  height: number | null;
  thumb: Blob | null;
}

const PEAKS_PER_SECOND = 50;

/** Waveform peaks for audio and video files small enough to decode in memory. */
async function audioPeaks(file: File): Promise<number[] | null> {
  if (file.size > 150 * 1024 * 1024) return null;
  try {
    const ctx = new OfflineAudioContext(1, 1, 8000);
    const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
    const data = buffer.getChannelData(0);
    const bucket = Math.max(1, Math.floor(buffer.sampleRate / PEAKS_PER_SECOND));
    const peaks: number[] = [];
    for (let i = 0; i < data.length; i += bucket) {
      let max = 0;
      for (let j = i; j < Math.min(i + bucket, data.length); j++) max = Math.max(max, Math.abs(data[j]));
      peaks.push(Math.min(255, Math.round(max * 255)));
    }
    return peaks;
  } catch {
    return null;
  }
}

function canvasThumb(source: CanvasImageSource, w: number, h: number): Promise<Blob | null> {
  const scale = Math.min(1, 320 / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
}

async function probe(file: File, kind: AssetKind): Promise<Probe> {
  const url = URL.createObjectURL(file);
  try {
    if (kind === 'image') {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { duration: null, width: img.naturalWidth, height: img.naturalHeight, thumb: await canvasThumb(img, img.naturalWidth, img.naturalHeight) };
    }
    const el = document.createElement(kind === 'video' ? 'video' : 'audio');
    el.preload = 'metadata';
    el.muted = true;
    el.src = url;
    await new Promise<void>((resolve, reject) => {
      el.onloadedmetadata = () => resolve();
      el.onerror = () => reject(new Error(`This browser cannot read ${file.name}. Try an H.264 MP4, WebM, MP3 or WAV.`));
    });
    const duration = Number.isFinite(el.duration) ? el.duration : null;
    if (!(el instanceof HTMLVideoElement)) return { duration, width: null, height: null, thumb: null };
    el.currentTime = Math.min(1, (duration ?? 0) / 10);
    await new Promise<void>((resolve) => {
      el.onseeked = () => resolve();
      setTimeout(resolve, 3000);
    });
    const thumb = el.videoWidth ? await canvasThumb(el, el.videoWidth, el.videoHeight) : null;
    return { duration, width: el.videoWidth || null, height: el.videoHeight || null, thumb };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function uploadFile(projectId: string, file: File): Promise<Asset | null> {
  const kind = kindOf(file);
  const key = `${file.name}-${file.size}-${Date.now()}`;
  const setUpload = (patch: Partial<{ name: string; progress: number; error?: string }> | null) =>
    useEditor.setState((s) => {
      const uploads = { ...s.uploads };
      if (patch === null) delete uploads[key];
      else uploads[key] = Object.assign({ name: file.name, progress: 0 }, uploads[key], patch);
      return { uploads };
    });

  if (!kind) {
    useEditor.getState().setToast(`${file.name}: unsupported file type`);
    return null;
  }
  setUpload({ progress: 0 });
  try {
    const meta = await probe(file, kind);
    const { asset } = await api.createAsset(projectId, {
      kind,
      name: file.name,
      mime: file.type || 'application/octet-stream',
      size: file.size,
      duration: meta.duration,
      width: meta.width,
      height: meta.height,
    });
    useEditor.setState((s) => ({ assets: [...s.assets, asset] }));

    // Blank out where the file was shot (phone GPS) before it leaves this computer.
    const patches = await locationPatches(file.name, file.size, async (at, n) => new Uint8Array(await file.slice(at, at + n).arrayBuffer()));
    const count = Math.max(1, Math.ceil(file.size / PART_SIZE));
    const parts: { partNumber: number; etag: string }[] = [];
    let next = 1;
    let sent = 0;
    async function lane() {
      while (next <= count) {
        const n = next++;
        const start = (n - 1) * PART_SIZE;
        let chunk: Blob = file.slice(start, start + PART_SIZE);
        if (patches.some((p) => p.offset < start + chunk.size && p.offset + p.bytes.length > start)) {
          const bytes = new Uint8Array(await chunk.arrayBuffer());
          applyPatches(bytes, start, patches);
          chunk = new Blob([bytes]);
        }
        const part = await api.uploadPart(projectId, asset.id, n, chunk);
        parts.push({ partNumber: part.partNumber, etag: part.etag });
        sent += chunk.size;
        setUpload({ progress: sent / file.size });
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL_PARTS, count) }, lane));
    parts.sort((a, b) => a.partNumber - b.partNumber);
    const done = await api.completeAsset(projectId, asset.id, parts);
    if (meta.thumb) {
      await api.putThumb(projectId, asset.id, meta.thumb);
      done.asset.hasThumb = true;
    }
    if (kind === 'audio' || kind === 'video') {
      const peaks = await audioPeaks(file);
      if (peaks) await api.putPeaks(projectId, asset.id, peaks);
    }
    useEditor.setState((s) => ({ assets: s.assets.map((a) => (a.id === asset.id ? done.asset : a)) }));
    setUpload(null);
    return done.asset;
  } catch (err) {
    setUpload({ error: (err as Error).message });
    useEditor.getState().setToast(`${file.name}: ${(err as Error).message}`);
    return null;
  }
}
