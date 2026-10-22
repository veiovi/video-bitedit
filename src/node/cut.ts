// Build a timeline from a cut list written in seconds. This is the main
// interface for agents: list the pieces, and Video bitEdit converts them to frames,
// resolves file names to asset IDs, and places them on tracks.

import { type Transcript, captionClipsFor } from '../shared/captions';
import { CAPTION_LOOKS, type CaptionPosition, captionY } from '../shared/captionLooks';
import { addClip, addTrack, cropRange, deriveTimeline } from '../shared/edits';
import {
  type Clip,
  type Effect,
  type SlideSpec,
  type TransitionType,
  FORMATS,
  type FormatId,
  type ProjectDoc,
  SPEED_LIMITS,
  TRACK_LIMITS,
  type TextStyle,
  type Timeline,
  clipEnd,
  emptyTimeline,
  newId,
} from '../shared/project';
import { captionStyle, defaultTextStyle } from '../shared/themes';
import type { LocalAsset } from './local-project';

export interface CutListClip {
  /** Asset ID, file name, relative path, or file name without extension. Omit for text. */
  asset?: string;
  /** Text clip content (instead of `asset`). */
  text?: string;
  /** Track name such as "V1", "V2", "A1". Defaults to V1 for visuals and A1 for audio. A video on an audio track plays just its sound. */
  track?: string;
  /** Timeline position in seconds. Omit to append after the previous clip on that track. */
  at?: number;
  /** Source in/out points in seconds. */
  in?: number;
  out?: number;
  /** Length in seconds (alternative to `out`; required for images and text without `out`). On the timeline, so with `speed` it plays `duration × speed` seconds of source. */
  duration?: number;
  /** Video and audio: playback speed, 0.25–4 (default 1). The clip plays `in`→`out` and lasts (out − in) / speed. */
  speed?: number;
  volume?: number;
  /** Video: turn off the clip's own sound (e.g. when its sound is placed on an audio track separately). */
  muted?: boolean;
  opacity?: number;
  fadeIn?: number;
  fadeOut?: number;
  scale?: number;
  /** Reframe: on a cropped (vertical) timeline, -0.5 shows the left of the source and 0.5 the right. */
  offsetX?: number;
  offsetY?: number;
  style?: Partial<TextStyle>;
  /** Visual fit: "contain" letterboxes, "cover" crops to fill (default for generated stills and vertical timelines). */
  fit?: 'contain' | 'cover';
  /** A Remotion slide instead of media. `image` names an asset; `generate` makes one with AI. */
  slide?: Omit<SlideSpec, 'imageAssetId'> & { image?: string; generate?: string; aspect?: string };
  /** An HTML/GSAP composition (path inside the project folder) rendered with HyperFrames into a video clip. */
  hyperframes?: string;
  /** Variables passed to the HyperFrames composition. */
  variables?: Record<string, unknown>;
  /** Generate a still with AI (OpenRouter) and use it as this clip's image. Resolved by `videdit cut`. */
  generate?: string;
  /** Aspect ratio for `generate`, e.g. "16:9" (defaults to the timeline's). */
  aspect?: string;
  /** Look and motion effects, e.g. [{ "type": "grade", "preset": "warm" }, { "type": "grain", "amount": 0.4 }]. */
  effects?: Effect[];
  /** How this clip enters from the clip before it on the same track; duration in seconds. */
  transition?: { type: TransitionType; duration?: number };
  /** Snap `in`/`out` to the quietest moment nearby (overrides the timeline and file setting). */
  snap?: boolean;
}

/** Captions generated from the transcripts of the clips a timeline uses. */
export type CaptionsSpec =
  | 'auto'
  | {
      /** Video track for the caption clips; defaults to the top video track. */
      track?: string;
      /**
       * Overrides for the theme's caption look, e.g. { "captionLook": "karaoke",
       * "wordsPerLine": 3, "highlight": "#00e5ff" } (see shared/captionLooks.ts).
       */
      style?: Partial<TextStyle>;
      /** Where the lines sit, inside the platform safe area for the frame shape; overrides style.y. */
      position?: CaptionPosition;
    };

export interface CutList {
  title?: string;
  fps?: number;
  width?: number;
  height?: number;
  theme?: string;
  /** Number of video and audio tracks to create (defaults 3 and 4). */
  tracks?: { video?: number; audio?: number };
  /** Per-track gain, e.g. { "A1": 0.4 }. */
  trackVolume?: Record<string, number>;
  clips?: CutListClip[];
  captions?: CaptionsSpec;
  /** Snap every clip's `in`/`out` to the quietest 10 ms within ±80 ms. */
  snap?: boolean;
}

export interface CutListTimeline {
  name: string;
  /**
   * Frame format: landscape (16:9), vertical (9:16), square, or original (the
   * size of the footage it uses). Timelines built from clips default to
   * original; derived timelines default to vertical.
   */
  format?: FormatId | 'original';
  fps?: number;
  tracks?: { video?: number; audio?: number };
  trackVolume?: Record<string, number>;
  /** Build from these clips... */
  clips?: CutListClip[];
  /** ...or derive from another timeline in this list (cropped to fill the new format). */
  from?: string;
  /** With `from`: keep only this [start, end] range in seconds of the source timeline. */
  range?: [number, number];
  /** With `from`: horizontal reframe for every cropped visual clip, -0.5..0.5. */
  offsetX?: number;
  /** Caption the speech in this timeline from asset transcripts (`videdit transcribe`). */
  captions?: CaptionsSpec;
  /** Snap every clip's `in`/`out` to the quietest 10 ms within ±80 ms. */
  snap?: boolean;
}

/** Data the cut list may draw on beyond the asset list. */
export interface CutContext {
  /** assetId → transcript, for `captions`. */
  transcripts?: Record<string, Pick<Transcript, 'words'>>;
  /** assetId → loudness levels at LEVELS_PER_SECOND, for `snap`. */
  levels?: Record<string, number[]>;
}

/** Resolution of the levels used for snapping: 10 ms buckets. */
export const LEVELS_PER_SECOND = 100;
/** How far a snapped cut may move. */
export const SNAP_WINDOW_SECONDS = 0.08;

/**
 * The frame boundary within ±80 ms of `seconds` that falls in the quietest
 * 10 ms of the source, preferring the nearest on ties. Returns a frame count.
 */
export function snapToQuiet(seconds: number, levels: number[] | undefined, fps: number): number {
  const target = Math.round(seconds * fps);
  if (!levels?.length) return target;
  const reach = Math.floor(SNAP_WINDOW_SECONDS * fps + 1e-9);
  let best = target;
  let bestLevel = Infinity;
  for (let d = 0; d <= reach; d++) {
    for (const f of d === 0 ? [target] : [target - d, target + d]) {
      if (f < 0 || Math.abs(f / fps - seconds) > SNAP_WINDOW_SECONDS + 1e-9) continue;
      const bucket = Math.min(levels.length - 1, Math.floor((f / fps) * LEVELS_PER_SECOND + 1e-9));
      if (levels[bucket] < bestLevel) {
        best = f;
        bestLevel = levels[bucket];
      }
    }
  }
  return best;
}

/** Assets whose clips ask for snapping, so the caller can load their levels. */
export function assetsToSnap(list: CutListFile, assets: LocalAsset[]): LocalAsset[] {
  const specs: CutListTimeline[] = list.timelines ?? [{ name: 'Main', clips: list.clips }];
  const out = new Map<string, LocalAsset>();
  for (const spec of specs) {
    for (const item of spec.clips ?? []) {
      if (!(item.snap ?? spec.snap ?? list.snap) || !item.asset) continue;
      const asset = findAsset(assets, item.asset);
      if (asset && asset.kind !== 'image') out.set(asset.id, asset);
    }
  }
  return [...out.values()];
}

export interface CutListFile extends CutList {
  /** Several timelines sharing the same media, e.g. a main cut and a short. */
  timelines?: CutListTimeline[];
}

export function findAsset(assets: LocalAsset[], ref: string): LocalAsset | undefined {
  const lower = ref.toLowerCase();
  const stem = (s: string) => s.replace(/\.[^.]+$/, '').toLowerCase();
  return (
    assets.find((a) => a.id === ref) ??
    assets.find((a) => a.path.toLowerCase() === lower) ??
    assets.find((a) => a.name.toLowerCase() === lower) ??
    assets.find((a) => stem(a.name) === lower || stem(a.path) === lower)
  );
}

/**
 * Frame size of the footage a list of clips uses: the size that fills the most
 * time, scaled down to fit within 1920×1080 (or 1080×1920). 1920×1080 when
 * there is no footage.
 */
export function originalFrame(clips: CutListClip[], assets: LocalAsset[]): { width: number; height: number } {
  const seconds = new Map<string, number>();
  for (const item of clips) {
    const a = item.asset ? findAsset(assets, item.asset) : undefined;
    if (!a || (a.kind !== 'video' && a.kind !== 'image') || !a.width || !a.height) continue;
    const length = item.duration ?? (item.out ?? a.duration ?? 5) - (item.in ?? 0);
    const size = `${a.width}x${a.height}`;
    seconds.set(size, (seconds.get(size) ?? 0) + Math.max(0, length));
  }
  const top = [...seconds.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
  if (!top) return { width: 1920, height: 1080 };
  const [w, h] = top.split('x').map(Number);
  const k = Math.min(1, 1920 / Math.max(w, h), 1080 / Math.min(w, h));
  const even = (n: number) => Math.max(2, Math.round((n * k) / 2) * 2);
  return { width: even(w), height: even(h) };
}

function withTracks(t: Timeline, video: number, audio: number): Timeline {
  let d: Timeline = { ...t, tracks: [] };
  for (let i = 0; i < Math.min(video, TRACK_LIMITS.video); i++) d = addTrack(d, 'video');
  for (let i = 0; i < Math.min(audio, TRACK_LIMITS.audio); i++) d = addTrack(d, 'audio');
  return d;
}

function buildTimeline(
  spec: CutListTimeline & { width?: number; height?: number },
  assets: LocalAsset[],
  project: Pick<ProjectDoc, 'theme'>,
  ctx: CutContext,
  snapDefault: boolean,
): Timeline {
  const fps = spec.fps ?? 30;
  const format = spec.format && spec.format !== 'original' ? FORMATS[spec.format] : originalFrame(spec.clips ?? [], assets);
  let doc: Timeline = {
    ...emptyTimeline(spec.name),
    fps,
    width: spec.width ?? format?.width ?? 1920,
    height: spec.height ?? format?.height ?? 1080,
  };
  const list = spec;
  doc = withTracks(doc, list.tracks?.video ?? 3, list.tracks?.audio ?? 4);
  for (const [name, volume] of Object.entries(list.trackVolume ?? {})) {
    doc.tracks = doc.tracks.map((t) => (t.name.toLowerCase() === name.toLowerCase() ? { ...t, volume } : t));
  }
  const f = (sec: number) => Math.round(sec * fps);

  (list.clips ?? []).forEach((item, i) => {
    const where = `clip ${i + 1}`;
    const asset = item.asset ? findAsset(assets, item.asset) : undefined;
    if (item.asset && !asset) throw new Error(`${where}: no asset matches "${item.asset}"`);
    if (!asset && item.text === undefined && !item.slide) throw new Error(`${where}: needs "asset", "text" or "slide"`);
    const slideImage = item.slide?.image ? findAsset(assets, item.slide.image) : undefined;
    if (item.slide?.image && !slideImage) throw new Error(`${where}: no asset matches slide image "${item.slide.image}"`);
    const trackName = item.track ?? (asset?.kind === 'audio' ? 'A1' : 'V1');
    const track = doc.tracks.find((t) => t.name.toLowerCase() === trackName.toLowerCase() || t.id === trackName);
    if (!track) throw new Error(`${where}: no track "${trackName}"`);
    // A video placed on an audio track becomes an audio clip of its sound.
    const kind: Clip['kind'] = asset ? (asset.kind === 'video' && track.kind === 'audio' ? 'audio' : asset.kind) : item.slide ? 'slide' : 'text';

    const speed = (kind === 'video' || kind === 'audio') && item.speed ? Math.min(SPEED_LIMITS.max, Math.max(SPEED_LIMITS.min, item.speed)) : 1;
    let srcIn = item.in ?? 0;
    const sourceLen = asset?.duration ?? null;
    // Seconds of source the clip plays.
    let seconds: number;
    if (item.duration !== undefined) seconds = item.duration * speed;
    else if (item.out !== undefined) seconds = item.out - srcIn;
    else if (sourceLen !== null) seconds = sourceLen - srcIn;
    else seconds = kind === 'text' ? 3 : kind === 'slide' ? 5 : 5;
    if (sourceLen !== null && srcIn + seconds > sourceLen + 1e-6) seconds = sourceLen - srcIn;
    if (!(seconds > 0)) throw new Error(`${where}: duration must be positive`);
    if (asset && asset.kind !== 'image' && (item.snap ?? spec.snap ?? snapDefault)) {
      // Move both cut points into nearby silence; whole frames keep the result exact.
      const levels = ctx.levels?.[asset.id];
      const inFrame = srcIn > 0 ? snapToQuiet(srcIn, levels, fps) : 0;
      const atEnd = sourceLen !== null && srcIn + seconds >= sourceLen - 1e-6;
      const lastFrame = sourceLen !== null ? Math.floor(sourceLen * fps + 1e-6) : Infinity;
      const outFrame = atEnd ? f(srcIn + seconds) : Math.min(lastFrame, snapToQuiet(srcIn + seconds, levels, fps));
      srcIn = inFrame / fps;
      seconds = Math.max(1, outFrame - inFrame) / fps;
    }

    const start =
      item.at !== undefined ? f(item.at) : doc.clips.filter((c) => c.trackId === track.id).reduce((end, c) => Math.max(end, clipEnd(c)), 0);
    const clip: Clip = {
      id: newId(),
      kind,
      trackId: track.id,
      start,
      duration: Math.max(1, f(seconds / speed)),
      assetId: asset?.id,
      in: asset && asset.kind !== 'image' ? f(srcIn) : undefined,
      speed: speed !== 1 ? speed : undefined,
      volume: item.volume,
      muted: kind === 'video' && item.muted ? true : undefined,
      opacity: item.opacity,
      fadeIn: item.fadeIn !== undefined ? f(item.fadeIn) : undefined,
      fadeOut: item.fadeOut !== undefined ? f(item.fadeOut) : undefined,
      scale: item.scale,
      effects: item.effects?.length ? item.effects : undefined,
      transition: item.transition ? { type: item.transition.type, duration: Math.max(1, f(item.transition.duration ?? 0.5)) } : undefined,
      offsetX: item.offsetX,
      offsetY: item.offsetY,
      fit: kind === 'video' || kind === 'image' ? (item.fit ?? (doc.height > doc.width ? 'cover' : undefined)) : undefined,
      text:
        kind === 'text'
          ? { ...defaultTextStyle(project, doc.height > doc.width ? 'caption' : 'title'), ...item.style, text: item.text ?? '' }
          : undefined,
      slide: item.slide
        ? {
            layout: item.slide.layout,
            kicker: item.slide.kicker,
            title: item.slide.title,
            body: item.slide.body,
            bullets: item.slide.bullets,
            stat: item.slide.stat,
            palette: item.slide.palette,
            imageAssetId: slideImage?.id,
          }
        : undefined,
    };
    const before = doc;
    doc = addClip(doc, clip);
    if (doc === before) throw new Error(`${where}: track ${track.name} cannot hold a ${kind} clip`);
  });
  return spec.captions ? addCaptions(doc, spec.captions, project, ctx, spec.name) : doc;
}

/** Replace a timeline's caption clips with ones generated from transcripts. */
export function addCaptions(t: Timeline, spec: CaptionsSpec, project: Pick<ProjectDoc, 'theme'>, ctx: CutContext, name = t.name): Timeline {
  const opts = spec === 'auto' ? {} : spec;
  const videoTracks = t.tracks.filter((x) => x.kind === 'video');
  const track = opts.track
    ? videoTracks.find((x) => x.name.toLowerCase() === opts.track!.toLowerCase() || x.id === opts.track)
    : videoTracks[0];
  if (!track) throw new Error(`timeline "${name}": captions need a video track${opts.track ? ` named "${opts.track}"` : ''}`);
  const look = opts.style?.captionLook;
  if (look && !CAPTION_LOOKS.some((l) => l.id === look)) {
    throw new Error(`timeline "${name}": unknown caption look "${look}" (use ${CAPTION_LOOKS.map((l) => l.id).join(', ')})`);
  }
  if (opts.position && !['top', 'middle', 'bottom'].includes(opts.position)) {
    throw new Error(`timeline "${name}": caption position must be top, middle or bottom`);
  }
  const style: TextStyle = {
    ...captionStyle(project, t),
    ...opts.style,
    ...(opts.position && { y: captionY(opts.position, t) }),
    text: '',
  };
  let doc: Timeline = { ...t, clips: t.clips.filter((c) => c.kind !== 'caption') };
  const captions = captionClipsFor(doc, ctx.transcripts ?? {}, (range, words) => ({
    id: newId(),
    kind: 'caption',
    trackId: track.id,
    ...range,
    words,
    text: style,
  }));
  if (captions.length === 0) {
    throw new Error(`timeline "${name}": no transcripts for its clips. Run \`videdit transcribe <folder>\` first.`);
  }
  for (const c of captions) doc = addClip(doc, c);
  return doc;
}

/** Build a whole project document from a cut list file. */
export function buildFromCutList(list: CutListFile, assets: LocalAsset[], base?: ProjectDoc, ctx: CutContext = {}): ProjectDoc {
  const project: ProjectDoc = {
    schema: 1,
    title: list.title ?? base?.title ?? 'Untitled project',
    theme: list.theme ?? base?.theme ?? 'clean',
    timelines: [],
  };
  const specs: CutListTimeline[] = list.timelines ?? [
    {
      name: 'Main',
      clips: list.clips ?? [],
      fps: list.fps,
      tracks: list.tracks,
      trackVolume: list.trackVolume,
      captions: list.captions,
      ...dims(list),
    },
  ];
  for (const spec of specs) {
    if (spec.from) {
      const source = project.timelines.find((t) => t.name.toLowerCase() === spec.from!.toLowerCase());
      if (!source) throw new Error(`timeline "${spec.name}": "from" must name an earlier timeline, got "${spec.from}"`);
      const target = !spec.format || spec.format === 'original' ? 'vertical' : spec.format;
      let derived = deriveTimeline(source, spec.name, target);
      if (spec.range) derived = cropRange(derived, spec.range[0] * source.fps, spec.range[1] * source.fps);
      if (spec.offsetX !== undefined) {
        derived = { ...derived, clips: derived.clips.map((c) => (c.fit === 'cover' ? { ...c, offsetX: spec.offsetX } : c)) };
      }
      if (spec.captions) derived = addCaptions(derived, spec.captions, project, ctx, spec.name);
      project.timelines.push(derived);
    } else {
      project.timelines.push(buildTimeline(spec, assets, project, ctx, Boolean(list.snap)));
    }
  }
  if (project.timelines.length === 0) throw new Error('The cut list has no timelines');
  return project;
}

function dims(list: CutList): { width?: number; height?: number } {
  return { ...(list.width ? { width: list.width } : {}), ...(list.height ? { height: list.height } : {}) };
}

/** A first rough assembly: videos and images in name order on V1, audio files on A1. */
export function autoAssemble(assets: LocalAsset[], title: string): CutListFile {
  const sorted = [...assets].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  const clips: CutListClip[] = [];
  for (const a of sorted) {
    if (a.kind === 'video') clips.push({ asset: a.id, track: 'V1' });
    else if (a.kind === 'image') clips.push({ asset: a.id, track: 'V1', duration: 4 });
  }
  for (const a of sorted.filter((x) => x.kind === 'audio')) clips.push({ asset: a.id, track: 'A1' });
  return { title, clips };
}

/** Every clip in a cut list, with the frame format of the timeline it belongs to. */
export function cutListClips(list: CutListFile): { clip: CutListClip; vertical: boolean }[] {
  const timelines = list.timelines ?? [{ name: 'Main', clips: list.clips ?? [] }];
  return timelines.flatMap((t) =>
    (t.clips ?? []).map((clip) => ({ clip, vertical: t.format === 'vertical' || (list.height ?? 0) > (list.width ?? 1) })),
  );
}
