import type { CaptionLook } from './captionLooks';
import type { TextAnimation, TextPreset } from './themes';

// The project document: one shared asset bin and several timelines (for
// example a 16:9 main cut and a 9:16 short). All times are integer frames at
// the timeline's fps, which keeps edits exact and makes the same data drive
// both preview and render.

export type AssetKind = 'video' | 'audio' | 'image';
export type TrackKind = 'video' | 'audio';
export type ClipKind = 'video' | 'audio' | 'image' | 'text' | 'caption' | 'slide';

export interface Asset {
  id: string;
  kind: AssetKind;
  name: string;
  mime: string;
  size: number;
  /** Seconds; null for images. */
  duration: number | null;
  width: number | null;
  height: number | null;
  hasThumb: boolean;
  /** Videos: a sprite of frames sampled through the file, served at /m/:id/a/:aid/filmstrip. */
  filmstrip?: Filmstrip | null;
  /** `deleted` assets are hidden from the bin but kept, so older versions still play. */
  status: 'uploading' | 'ready' | 'deleted';
  createdAt: number;
}

/**
 * A filmstrip sprite: `frames` frames side by side in one JPEG row, frame i
 * showing the source at i × `every` seconds. `width` and `height` are one
 * frame's size in pixels.
 */
export interface Filmstrip {
  frames: number;
  every: number;
  width: number;
  height: number;
}

export const FILMSTRIP = { every: 2, maxFrames: 60, width: 160 } as const;

/** How to sample a video of `duration` seconds: a frame every 2 s, at most 60 frames. */
export function filmstripPlan(duration: number): { frames: number; every: number } {
  const d = Math.max(0, duration);
  const every = Math.max(FILMSTRIP.every, Math.ceil((d / FILMSTRIP.maxFrames) * 100) / 100);
  return { frames: Math.max(1, Math.min(FILMSTRIP.maxFrames, Math.ceil(d / every))), every };
}

/** Which sprite frame shows the source at `seconds`. */
export function filmstripFrame(strip: Pick<Filmstrip, 'frames' | 'every'>, seconds: number): number {
  return Math.max(0, Math.min(strip.frames - 1, Math.floor(seconds / strip.every)));
}

/** Shape check for filmstrip metadata received over the API or read from disk. */
export function isFilmstrip(x: unknown): x is Filmstrip {
  const f = x as Filmstrip;
  return (
    typeof f === 'object' &&
    f !== null &&
    [f.frames, f.every, f.width, f.height].every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0) &&
    f.frames <= FILMSTRIP.maxFrames &&
    f.width <= 1000 &&
    f.height <= 1000
  );
}

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  /** Gain applied to every clip on the track. */
  volume?: number;
  /** Track colour in the editor (hex); defaults to the retro palette. */
  color?: string;
  muted?: boolean;
  hidden?: boolean;
  locked?: boolean;
  /** Row height in the editor; normal when unset. Preview and export ignore it. */
  height?: TrackHeight;
}

export type TrackHeight = 'small' | 'normal' | 'large';

export const TRACK_LIMITS = { video: 10, audio: 8 } as const;

/** Retro, muted track colours. Video and audio tracks walk the list from different starts. */
export const TRACK_PALETTE = [
  { name: 'rust', hex: '#b0583a' },
  { name: 'faded turquoise', hex: '#5e9c97' },
  { name: 'mustard', hex: '#c49a3c' },
  { name: 'slate blue', hex: '#66789a' },
  { name: 'dusty rose', hex: '#b97a7c' },
  { name: 'sage', hex: '#879a6b' },
  { name: 'plum', hex: '#866079' },
  { name: 'terracotta', hex: '#c27a5a' },
  { name: 'olive', hex: '#8a8150' },
  { name: 'deep teal', hex: '#4d7f7c' },
] as const;

/** A track's colour: its own, or a palette entry chosen by its number (V1, V2… / A1, A2…). */
export function trackColor(track: Track, indexInKind = 0): string {
  if (track.color) return track.color;
  const n = Number(track.name.match(/\d+/)?.[0] ?? indexInKind + 1) - 1;
  const offset = track.kind === 'audio' ? 5 : 0;
  return TRACK_PALETTE[(Math.max(0, n) + offset) % TRACK_PALETTE.length].hex;
}

export interface TextStyle {
  text: string;
  fontSize: number;
  color: string;
  background: string;
  fontWeight: number;
  /** Position of the text box centre, 0..1 of the frame. */
  x: number;
  y: number;
  /** Theme preset this style started from. */
  preset?: TextPreset;
  /** Entrance animation; defaults to the theme's. */
  animation?: TextAnimation;
  /** Overrides the theme font. */
  fontFamily?: string;
  /** Caption clips: colour of the word being spoken; defaults to the theme's. */
  highlight?: string;
  /** Caption clips: how the words animate (see shared/captionLooks.ts); defaults to classic. */
  captionLook?: CaptionLook;
  /** Caption clips: most words on a line, 1–6 (default 4). */
  wordsPerLine?: number;
}

/** One caption word, in frames relative to its clip's start. */
export interface CaptionWord {
  text: string;
  start: number;
  end: number;
}

export interface Clip {
  id: string;
  kind: ClipKind;
  trackId: string;
  /** Timeline position. */
  start: number;
  duration: number;
  assetId?: string;
  /** Offset into the source media. */
  in?: number;
  volume?: number;
  /** Video clips: the clip's own sound is off, e.g. after Detach audio moved it to an audio clip. */
  muted?: boolean;
  /** Turned off: kept on the timeline but skipped in preview and export. */
  disabled?: boolean;
  opacity?: number;
  fadeIn?: number;
  fadeOut?: number;
  /** How visual media fills the frame: letterbox (default) or crop to fill. */
  fit?: 'contain' | 'cover';
  /** Uniform scale and offset (fraction of frame) for visual clips; offsets reframe cropped clips. */
  scale?: number;
  /** Degrees clockwise. */
  rotation?: number;
  offsetX?: number;
  offsetY?: number;
  /** Text and caption clips: the look. Caption clips ignore `text.text`. */
  text?: TextStyle;
  /** Caption clips: the words, grouped into lines when drawn. */
  words?: CaptionWord[];
  /** Slide clips: a designed card (title, bullets, image, stat or quote) drawn by Remotion. */
  slide?: SlideSpec;
  /** Look and motion effects, applied in order (see shared/effects.ts). */
  effects?: Effect[];
  /** How this clip enters from the clip just before it on the same track. */
  transition?: Transition;
  /**
   * Video and audio clips: playback speed, SPEED_LIMITS.min to max (default 1).
   * The clip plays `duration × speed` frames of its source from `in`.
   */
  speed?: number;
  /** Video clips: a still of the source frame at `in`, held for the clip's whole length, without sound. */
  freeze?: boolean;
  /**
   * Animation: per property, keys in frames relative to the clip's start
   * (see shared/keyframes.ts). A property with keys ignores its static value.
   */
  keyframes?: Keyframes;
}

/** Clip properties that can be animated with keyframes. */
export type KeyframeProp = 'opacity' | 'scale' | 'offsetX' | 'offsetY' | 'rotation' | 'volume';

/** How the value travels from a key to the next one. `hold` keeps it until the next key. */
export type KeyframeEase = 'linear' | 'hold' | 'easeIn' | 'easeOut' | 'easeInOut';

export interface Keyframe {
  /** Frames from the clip's start, 0 to duration − 1. */
  frame: number;
  value: number;
  /** The shape of the span after this key; linear when unset. */
  ease?: KeyframeEase;
  /** Set on volume keys written by Duck under speech, so Remove ducking can find them. */
  duck?: true;
}

export type Keyframes = Partial<Record<KeyframeProp, Keyframe[]>>;

export const SPEED_LIMITS = { min: 0.25, max: 4 } as const;
export const SPEED_PRESETS = [0.25, 0.5, 1, 1.5, 2, 4] as const;

/**
 * Source frames a clip plays per timeline frame: its speed for video and
 * audio, 0 for a freeze frame (the source never advances), and 1 otherwise.
 */
export function clipSpeed(clip: Clip): number {
  if (clip.freeze) return 0;
  return (clip.kind === 'video' || clip.kind === 'audio') && clip.speed ? clip.speed : 1;
}

/** "2×", "0.5×", "1.25×" */
export function speedLabel(speed: number): string {
  return `${Number(speed.toFixed(2))}×`;
}

export type SlideLayout = 'title' | 'bullets' | 'image' | 'split' | 'stat' | 'quote';
export type SlidePalette = 'paper' | 'ink' | 'rust' | 'turquoise' | 'mustard';

export interface SlideSpec {
  layout: SlideLayout;
  /** Small label above the title, e.g. "01 · Edit". */
  kicker?: string;
  title: string;
  body?: string;
  bullets?: string[];
  /** Big number or short phrase for the `stat` layout. */
  stat?: string;
  /** Image for `image` and `split` layouts. */
  imageAssetId?: string;
  palette?: SlidePalette;
}

export type EffectType = 'autoColor' | 'grade' | 'grain' | 'vignette' | 'lightLeak' | 'glitch' | 'kenBurns' | 'zoomPunch' | 'blur';
export type GradePreset = 'warm' | 'cool' | 'tealOrange' | 'mono' | 'noir' | 'vintage' | 'faded' | 'punchy';

export interface Effect {
  type: EffectType;
  /** Strength, 0..1 (default 1; zoomPunch: extra zoom, default 0.15). */
  amount?: number;
  /** Grade look. */
  preset?: GradePreset;
  /** Varies grain, light leaks and glitch bursts; deterministic per frame. */
  seed?: number;
  /** Ken Burns: start and end zoom (default 1 → 1.15) and pan as a fraction of the frame. */
  from?: number;
  to?: number;
  panX?: number;
  panY?: number;
  /** autoColor: per-channel correction solved from the footage (see shared/autocolor.ts). */
  gains?: [number, number, number];
  offsets?: [number, number, number];
}

export type TransitionType = 'fade' | 'dipBlack' | 'dipWhite' | 'slide' | 'whip' | 'wipe' | 'zoom';

export interface Transition {
  type: TransitionType;
  /** Frames; the previous clip continues underneath for this long. */
  duration: number;
}

export interface Marker {
  id: string;
  frame: number;
  label: string;
}

export interface Timeline {
  id: string;
  name: string;
  fps: number;
  width: number;
  height: number;
  background: string;
  /** Display order, top to bottom. Higher video tracks draw over lower ones. */
  tracks: Track[];
  clips: Clip[];
  markers: Marker[];
}

export interface ProjectDoc {
  schema: 1;
  title: string;
  /** Theme ID from shared/themes.ts; styles text clips. */
  theme?: string;
  timelines: Timeline[];
}

/** Server capabilities, from GET /api/health. */
export interface ServerInfo {
  ok: true;
  mode: 'local' | 'cloud';
  /** Local mode: the linked cloud project, if this folder has been pushed. */
  remote?: { serverUrl: string; projectId: string; editUrl: string | null; viewUrl: string } | null;
  /** Local mode: whether `videdit deploy` has configured a cloud server. */
  cloudConfigured?: boolean;
  /** Whether POST /api/p/:id/generate (AI stills via OpenRouter) is available. */
  imageGeneration?: boolean;
}

/** One saved version of a project, from GET /api/p/:id/history. */
export interface HistoryEntry {
  version: number;
  source: 'editor' | 'push' | 'pull' | 'cut' | 'restore' | 'external' | 'import';
  createdAt: number;
  updatedAt: number;
  title: string;
  timelines: number;
  clips: number;
}

export const HISTORY = { coalesceMs: 30_000, keep: 300 } as const;

export function summariseDoc(doc: ProjectDoc): Pick<HistoryEntry, 'title' | 'timelines' | 'clips'> {
  return { title: doc.title, timelines: doc.timelines.length, clips: doc.timelines.reduce((n, t) => n + t.clips.length, 0) };
}

export interface ProjectRecord {
  id: string;
  title: string;
  version: number;
  doc: ProjectDoc;
  updatedAt: number;
}

export type RenderStatus = 'queued' | 'rendering' | 'uploading' | 'done' | 'failed';

export interface RenderRecord {
  id: string;
  projectId: string;
  timelineId: string;
  timelineName: string;
  preset: RenderPresetId;
  docVersion: number;
  status: RenderStatus;
  progress: number;
  worker: string | null;
  outputSize: number | null;
  error: string | null;
  /** Publish automatically when the render finishes. */
  autoPublish: boolean;
  publishedAt: number | null;
  publishTitle: string | null;
  publishDescription: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Public data for a published render's watch page. */
export interface PublishedVideo {
  renderId: string;
  projectId: string;
  timelineName: string;
  title: string;
  description: string;
  preset: RenderPresetId;
  outputSize: number | null;
  publishedAt: number;
  durationFrames: number;
  fps: number;
  width: number;
  height: number;
  sourceCount: number;
  /** Every published version of the project (latest per timeline), longest first; includes this one. */
  versions?: PublishedVersion[];
}

/** One entry in a watch page's version switcher. */
export interface PublishedVersion {
  renderId: string;
  /** "Full" for the main cut, otherwise the timeline name. */
  label: string;
  /** Aspect such as "16:9" or "9:16". */
  aspect: string;
  durationFrames: number;
  fps: number;
}

export function aspectLabel(width: number, height: number): string {
  const known: [number, string][] = [
    [16 / 9, '16:9'],
    [9 / 16, '9:16'],
    [1, '1:1'],
    [4 / 3, '4:3'],
    [3 / 4, '3:4'],
    [4 / 5, '4:5'],
  ];
  const r = width / height;
  const hit = known.find(([k]) => Math.abs(k - r) < 0.02);
  return hit ? hit[1] : `${width}×${height}`;
}

/**
 * Watch-page versions from a project's published videos: the latest video
 * per timeline, longest first, skipping audio-only renders.
 */
export function pickVersions(videos: (PublishedVideo & { timelineId: string })[]): PublishedVersion[] {
  const latest = new Map<string, PublishedVideo & { timelineId: string }>();
  for (const v of videos) {
    if (v.preset === 'audio-mp3') continue;
    const seen = latest.get(v.timelineId);
    if (!seen || v.publishedAt > seen.publishedAt) latest.set(v.timelineId, v);
  }
  return [...latest.values()]
    .sort((a, b) => b.durationFrames / b.fps - a.durationFrames / a.fps)
    .map((v) => ({
      renderId: v.renderId,
      label: v.timelineName.toLowerCase() === 'main' ? 'Full' : v.timelineName,
      aspect: aspectLabel(v.width, v.height),
      durationFrames: v.durationFrames,
      fps: v.fps,
    }));
}

export interface Comment {
  id: string;
  frame: number;
  author: string;
  body: string;
  resolved: boolean;
  createdAt: number;
}

export const RENDER_PRESETS = {
  'mp4-1080p': { label: 'MP4 · project size', scale: 1, audioOnly: false },
  'mp4-720p': { label: 'MP4 · 720p draft', scale: 720 / 1080, audioOnly: false },
  'audio-mp3': { label: 'Audio only · MP3', scale: 1, audioOnly: true },
} as const;
export type RenderPresetId = keyof typeof RENDER_PRESETS;

/** Shape of IDs that clients may choose themselves (asset IDs on push). */
export const CLIENT_ID_PATTERN = /^[A-Za-z0-9]{8,32}$/;

export function newId(len = 12): string {
  const alphabet = '0123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export const FORMATS = {
  landscape: { label: '16:9 · 1920×1080', width: 1920, height: 1080 },
  vertical: { label: '9:16 · 1080×1920 (Shorts, Reels, TikTok)', width: 1080, height: 1920 },
  square: { label: '1:1 · 1080×1080', width: 1080, height: 1080 },
} as const;
export type FormatId = keyof typeof FORMATS;

export function emptyTimeline(name = 'Main', format: FormatId = 'landscape'): Timeline {
  return {
    id: newId(8),
    name,
    fps: 30,
    width: FORMATS[format].width,
    height: FORMATS[format].height,
    background: '#000000',
    tracks: [
      { id: 'v3', kind: 'video', name: 'V3' },
      { id: 'v2', kind: 'video', name: 'V2' },
      { id: 'v1', kind: 'video', name: 'V1' },
      { id: 'a1', kind: 'audio', name: 'A1' },
      { id: 'a2', kind: 'audio', name: 'A2' },
      { id: 'a3', kind: 'audio', name: 'A3' },
      { id: 'a4', kind: 'audio', name: 'A4' },
    ],
    clips: [],
    markers: [],
  };
}

export function emptyDoc(title = 'Untitled project'): ProjectDoc {
  return { schema: 1, title, theme: 'clean', timelines: [emptyTimeline()] };
}

export function timelineDuration(t: Timeline): number {
  return t.clips.reduce((max, c) => Math.max(max, c.start + c.duration), 0);
}

export function findTimeline(doc: ProjectDoc, id?: string | null): Timeline | undefined {
  return id ? doc.timelines.find((t) => t.id === id || t.name.toLowerCase() === id.toLowerCase()) : doc.timelines[0];
}

/** Asset IDs referenced by any timeline. */
export function usedAssetIds(doc: ProjectDoc): Set<string> {
  return new Set(doc.timelines.flatMap((t) => t.clips.map((c) => c.assetId).filter((id): id is string => Boolean(id))));
}

export function clipEnd(c: Clip): number {
  return c.start + c.duration;
}

/** Fade-in/out envelope, 0..1 at a frame relative to the clip's start. Scales opacity for visuals and gain for sound. */
export function fadeEnvelope(clip: Clip, frame: number): number {
  let k = 1;
  if (clip.fadeIn && clip.fadeIn > 0) k = Math.min(k, frame / clip.fadeIn);
  if (clip.fadeOut && clip.fadeOut > 0) k = Math.min(k, (clip.duration - frame) / clip.fadeOut);
  return Math.max(0, Math.min(1, k));
}

/**
 * The timeline as heard while some tracks are soloed: every other track is
 * muted (a video track keeps its picture). Solo is for listening in the
 * editor; the saved timeline and the export never see it.
 */
export function withSolo(timeline: Timeline, solo: string[]): Timeline {
  if (!timeline.tracks.some((t) => solo.includes(t.id))) return timeline;
  return { ...timeline, tracks: timeline.tracks.map((t) => (solo.includes(t.id) ? t : { ...t, muted: true })) };
}

/** Visual clips go on video tracks; audio clips on audio tracks. */
export function trackAccepts(track: Track, kind: ClipKind): boolean {
  return kind === 'audio' ? track.kind === 'audio' : track.kind === 'video';
}

/**
 * How a visual clip sits in the frame. A cropped (`cover`) clip pans inside its
 * crop: offsetX -0.5 shows the left edge of the source, 0.5 the right. A
 * letterboxed clip moves as a whole by that fraction of the frame.
 */
export function framing(clip: Clip): { transform: string; objectPosition?: string } {
  const x = clip.offsetX ?? 0;
  const y = clip.offsetY ?? 0;
  const rest = `scale(${clip.scale ?? 1}) rotate(${clip.rotation ?? 0}deg)`;
  if (clip.fit === 'cover') {
    const pct = (v: number) => `${Math.round(Math.max(0, Math.min(1, 0.5 + v)) * 1000) / 10}%`;
    return { transform: rest, objectPosition: `${pct(x)} ${pct(y)}` };
  }
  return { transform: `translate(${x * 100}%, ${y * 100}%) ${rest}` };
}

/**
 * Read a time typed by a person: seconds ("12", "12.5"), m:ss ("1:05"), or
 * the editor's own timecode (mm:ss:ff or hh:mm:ss:ff). A leading + or - is
 * relative to `from`. Returns a frame, or null when the text is not a time.
 */
export function parseTimecode(text: string, fps: number, from = 0): number | null {
  const m = text.trim().match(/^([+-]?)\s*([\d.:]+)$/);
  if (!m) return null;
  const n = m[2].split(':').map((p) => (p === '' ? NaN : Number(p)));
  if (n.some((x) => !Number.isFinite(x)) || n.length > 4) return null;
  let frames: number;
  if (n.length === 1) frames = n[0] * fps;
  else if (n.length === 2) frames = (n[0] * 60 + n[1]) * fps;
  else {
    const [h, min, s, f] = n.length === 3 ? [0, ...n] : n;
    frames = ((h * 60 + min) * 60 + s) * fps + f;
  }
  const at = m[1] === '+' ? from + frames : m[1] === '-' ? from - frames : frames;
  return Math.max(0, Math.round(at));
}

export function formatTimecode(frame: number, fps: number): string {
  const f = Math.max(0, Math.round(frame));
  const totalSec = Math.floor(f / fps);
  const ff = f % fps;
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${h > 0 ? pad(h) + ':' : ''}${pad(m)}:${pad(s)}:${pad(ff)}`;
}
