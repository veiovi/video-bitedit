// Pure timeline operations. Each returns a new timeline and never mutates its
// input, so the editor can keep them on an undo stack.
//
// Placement uses overwrite semantics: a clip dropped onto a track carves its
// range out of whatever was already there.

import { retimeWords } from './captions';
import { type DuckingOptions, type SpeechRange, duckingKeys } from './ducking';
import {
  PROP_LIMITS,
  animatableProps,
  cropKeys,
  hasKeys,
  keyframesFor,
  normalizeKeys,
  retimeKeyframes,
  scaleKeyframes,
  tidyKeyframes,
  valueAt,
} from './keyframes';
import {
  type Clip,
  type Effect,
  FORMATS,
  type Keyframe,
  type KeyframeEase,
  type KeyframeProp,
  type Keyframes,
  type FormatId,
  MARKER_COLORS,
  type Marker,
  type ProjectDoc,
  SPEED_LIMITS,
  TRACK_LIMITS,
  type Timeline,
  type Track,
  type TrackKind,
  clipEnd,
  clipSpeed,
  newId,
  timelineDuration,
  trackAccepts,
  trackColor,
} from './project';

/** Frames available in a clip's source, or Infinity for images and text. */
export type SourceLength = (clip: Clip) => number;

const unlimited: SourceLength = () => Infinity;

/**
 * A clip whose content now begins `delta` timeline frames later (head trimmed)
 * and lasts `duration` frames. Moves the source `in` point by `delta × speed`
 * source frames and retimes caption words and keyframes.
 */
function reframe(c: Clip, delta: number, duration: number): Clip {
  const out: Clip = {
    ...c,
    duration,
    in: c.in === undefined ? undefined : Math.max(0, c.in + Math.round(delta * clipSpeed(c))),
    words: retimeWords(c.words, delta, duration),
  };
  if (c.keyframes) out.keyframes = retimeKeyframes(c.keyframes, delta, duration);
  return out;
}

/** Timeline frames a clip can last from its `in` point before its source runs out. */
function maxLength(c: Clip, sourceLength: SourceLength): number {
  const speed = clipSpeed(c);
  const left = sourceLength(c) - (c.in ?? 0);
  if (speed === 0 || left === Infinity) return Infinity;
  return Math.max(1, Math.floor(left / speed + 1e-9));
}

/** Timeline frames of earlier source a clip can reveal at its head. */
function maxReveal(c: Clip): number {
  const speed = clipSpeed(c);
  if (c.in === undefined || speed === 0) return Infinity;
  return Math.floor(c.in / speed + 1e-9);
}

function carve(clips: Clip[], trackId: string, start: number, end: number, exceptId?: string): Clip[] {
  const out: Clip[] = [];
  for (const c of clips) {
    if (c.trackId !== trackId || c.id === exceptId || clipEnd(c) <= start || c.start >= end) {
      out.push(c);
      continue;
    }
    if (c.start < start) {
      out.push(reframe(c, 0, start - c.start));
    }
    if (clipEnd(c) > end) {
      out.push({ ...reframe(c, end - c.start, clipEnd(c) - end), id: c.start < start ? newId() : c.id, start: end });
    }
  }
  return out;
}

function sortClips(clips: Clip[]): Clip[] {
  return [...clips].sort((a, b) => a.start - b.start || a.trackId.localeCompare(b.trackId));
}

function findTrack(doc: Timeline, id: string): Track | undefined {
  return doc.tracks.find((t) => t.id === id);
}

export function addClip(doc: Timeline, clip: Clip): Timeline {
  const track = findTrack(doc, clip.trackId);
  if (!track || track.locked || !trackAccepts(track, clip.kind)) return doc;
  const placed = { ...clip, start: Math.max(0, Math.round(clip.start)), duration: Math.max(1, Math.round(clip.duration)) };
  const clips = carve(doc.clips, placed.trackId, placed.start, clipEnd(placed));
  return { ...doc, clips: sortClips([...clips, placed]) };
}

export function moveClip(doc: Timeline, id: string, start: number, trackId?: string): Timeline {
  const clip = doc.clips.find((c) => c.id === id);
  if (!clip) return doc;
  const target = findTrack(doc, trackId ?? clip.trackId);
  const source = findTrack(doc, clip.trackId);
  if (!target || target.locked || source?.locked || !trackAccepts(target, clip.kind)) return doc;
  const moved = { ...clip, start: Math.max(0, Math.round(start)), trackId: target.id };
  const others = carve(doc.clips.filter((c) => c.id !== id), moved.trackId, moved.start, clipEnd(moved));
  return { ...doc, clips: sortClips([...others, moved]) };
}

/** Move one edge of a clip to `frame`, respecting source length and a 1-frame minimum. */
export function trimClip(
  doc: Timeline,
  id: string,
  edge: 'start' | 'end',
  frame: number,
  sourceLength: SourceLength = unlimited,
): Timeline {
  const clip = doc.clips.find((c) => c.id === id);
  if (!clip || findTrack(doc, clip.trackId)?.locked) return doc;
  const f = Math.round(frame);
  let next: Clip;
  if (edge === 'start') {
    const earliest = Math.max(0, clip.start - maxReveal(clip));
    const s = Math.min(Math.max(f, earliest), clipEnd(clip) - 1);
    const delta = s - clip.start;
    next = { ...reframe(clip, delta, clip.duration - delta), start: s };
  } else {
    const maxDuration = maxLength(clip, sourceLength);
    const e = Math.max(f, clip.start + 1);
    const duration = Math.min(e - clip.start, maxDuration);
    // Shortening drops caption words past the new end.
    next = duration < clip.duration ? reframe(clip, 0, duration) : { ...clip, duration };
  }
  const others = carve(doc.clips.filter((c) => c.id !== id), next.trackId, next.start, clipEnd(next));
  return { ...doc, clips: sortClips([...others, next]) };
}

/** Split clips that span `frame`. Limits to `ids` when given, otherwise every unlocked track. */
export function splitAt(doc: Timeline, frame: number, ids?: string[]): Timeline {
  const f = Math.round(frame);
  const clips: Clip[] = [];
  let changed = false;
  for (const c of doc.clips) {
    const eligible = (!ids || ids.includes(c.id)) && !findTrack(doc, c.trackId)?.locked;
    if (!eligible || f <= c.start || f >= clipEnd(c)) {
      clips.push(c);
      continue;
    }
    changed = true;
    const left = f - c.start;
    clips.push({ ...reframe(c, 0, left), fadeOut: 0 });
    clips.push({
      ...reframe(c, left, c.duration - left),
      id: newId(),
      start: f,
      fadeIn: 0,
      // The second half continues the text; don't replay its entrance animation.
      text: c.text ? { ...c.text, animation: 'none' } : undefined,
    });
  }
  return changed ? { ...doc, clips: sortClips(clips) } : doc;
}

/**
 * Remove clips. With `ripple`, later clips on the same track shift left to
 * close each removed clip's gap.
 */
export function deleteClips(doc: Timeline, ids: string[], ripple = false): Timeline {
  const removed = doc.clips.filter((c) => ids.includes(c.id) && !findTrack(doc, c.trackId)?.locked);
  if (removed.length === 0) return doc;
  const removedIds = new Set(removed.map((c) => c.id));
  let clips = doc.clips.filter((c) => !removedIds.has(c.id));
  if (ripple) {
    clips = clips.map((c) => {
      const shift = removed
        .filter((r) => r.trackId === c.trackId && clipEnd(r) <= c.start)
        .reduce((sum, r) => sum + r.duration, 0);
      return shift ? { ...c, start: c.start - shift } : c;
    });
  }
  return { ...doc, clips: sortClips(clips) };
}

export function updateClip(doc: Timeline, id: string, patch: Partial<Clip>): Timeline {
  return { ...doc, clips: doc.clips.map((c) => (c.id === id ? { ...c, ...patch, id: c.id } : c)) };
}

export function addTrack(doc: Timeline, kind: TrackKind): Timeline {
  const count = doc.tracks.filter((t) => t.kind === kind).length + 1;
  if (count > TRACK_LIMITS[kind]) return doc;
  const prefix = kind === 'video' ? 'V' : 'A';
  const track: Track = { id: newId(6), kind, name: `${prefix}${count}` };
  // New video tracks go on top; new audio tracks at the bottom.
  const tracks = kind === 'video' ? [track, ...doc.tracks] : [...doc.tracks, track];
  return { ...doc, tracks };
}

export function removeTrack(doc: Timeline, trackId: string): Timeline {
  return {
    ...doc,
    tracks: doc.tracks.filter((t) => t.id !== trackId),
    clips: doc.clips.filter((c) => c.trackId !== trackId),
  };
}

export function updateTrack(doc: Timeline, trackId: string, patch: Partial<Track>): Timeline {
  return { ...doc, tracks: doc.tracks.map((t) => (t.id === trackId ? { ...t, ...patch, id: t.id, kind: t.kind } : t)) };
}

// ---- Sound and fades ----

/** Set a clip's fade in or out, kept within the clip and clear of the other fade. */
export function setFade(doc: Timeline, id: string, edge: 'in' | 'out', frames: number): Timeline {
  const clip = doc.clips.find((c) => c.id === id);
  if (!clip) return doc;
  const other = edge === 'in' ? (clip.fadeOut ?? 0) : (clip.fadeIn ?? 0);
  const value = Math.max(0, Math.min(Math.round(frames), clip.duration - other));
  return updateClip(doc, id, edge === 'in' ? { fadeIn: value } : { fadeOut: value });
}

/** Clip and track volume run from silent to double (2 = 200%). */
export const MAX_VOLUME = 2;

/** Set a clip's volume, kept between silent and MAX_VOLUME and rounded to whole percent. */
export function setVolume(doc: Timeline, id: string, volume: number): Timeline {
  const value = Math.round(Math.max(0, Math.min(MAX_VOLUME, volume)) * 100) / 100;
  return updateClip(doc, id, { volume: value });
}

/**
 * Detach the sound of video clips: each gets an audio clip playing the same
 * part of its source (with its volume and fades) on the first audio track
 * that is free there, or on a new audio track, and the video clip is muted.
 * Muted clips, and clips with no free audio track left, stay as they are.
 */
export function detachAudio(doc: Timeline, ids: string[]): Timeline {
  let out = doc;
  for (const id of ids) {
    const clip = out.clips.find((c) => c.id === id);
    if (!clip || clip.kind !== 'video' || clip.muted || !clip.assetId) continue;
    const isFree = (t: Timeline, trackId: string) =>
      !t.clips.some((c) => c.trackId === trackId && c.start < clipEnd(clip) && clipEnd(c) > clip.start);
    let track = out.tracks.find((t) => t.kind === 'audio' && !t.locked && isFree(out, t.id));
    if (!track) {
      const grown = addTrack(out, 'audio');
      if (grown === out) continue;
      out = grown;
      track = out.tracks[out.tracks.length - 1];
    }
    const sound: Clip = {
      id: newId(),
      kind: 'audio',
      trackId: track.id,
      start: clip.start,
      duration: clip.duration,
      assetId: clip.assetId,
      in: clip.in ?? 0,
      ...(clip.speed !== undefined && clip.speed !== 1 && { speed: clip.speed }),
      ...(clip.volume !== undefined && { volume: clip.volume }),
      ...(clip.fadeIn && { fadeIn: clip.fadeIn }),
      ...(clip.fadeOut && { fadeOut: clip.fadeOut }),
      // Volume keys follow the sound; the picture keeps its own animation.
      ...(clip.keyframes?.volume?.length && { keyframes: { volume: clip.keyframes.volume.map((k) => ({ ...k })) } }),
    };
    const muted = (c: Clip): Clip => {
      if (!c.keyframes?.volume) return { ...c, muted: true };
      const { volume: _moved, ...rest } = c.keyframes;
      return { ...c, muted: true, keyframes: tidyKeyframes(rest) };
    };
    out = { ...out, clips: sortClips([...out.clips.map((c) => (c.id === id ? muted(c) : c)), sound]) };
  }
  return out;
}

// ---- Clipboard, enable/disable and navigation ----

/**
 * Place copies of clips (already given fresh IDs) with the earliest one at
 * `at`, keeping their offsets and tracks; a clip whose track is gone, locked
 * or of the wrong kind goes to the first unlocked track that takes it.
 * Placement overwrites, unless `insert` is given: then room for the whole
 * span opens at `at` first (on every unlocked track, or just `onlyTrack`).
 */
export function pasteClips(doc: Timeline, clips: Clip[], at: number, insert?: { onlyTrack?: string }): Timeline {
  if (clips.length === 0) return doc;
  const first = Math.min(...clips.map((c) => c.start));
  const span = Math.max(...clips.map(clipEnd)) - first;
  const a = Math.max(0, Math.round(at));
  let out = insert ? openAt(doc, a, span, insert.onlyTrack) : doc;
  for (const c of clips) {
    const own = findTrack(out, c.trackId);
    const track = own && !own.locked && trackAccepts(own, c.kind) ? own : out.tracks.find((t) => !t.locked && trackAccepts(t, c.kind));
    if (track) out = addClip(out, { ...c, trackId: track.id, start: a + c.start - first });
  }
  return out;
}

/** Turn clips off (they stay on the timeline but are skipped in preview and export), or back on when all of them are off. */
export function toggleClipsEnabled(doc: Timeline, ids: string[]): Timeline {
  const picked = doc.clips.filter((c) => ids.includes(c.id) && !findTrack(doc, c.trackId)?.locked);
  if (picked.length === 0) return doc;
  const off = picked.some((c) => !c.disabled);
  const pickedIds = new Set(picked.map((c) => c.id));
  return { ...doc, clips: doc.clips.map((c) => (pickedIds.has(c.id) ? { ...c, disabled: off || undefined } : c)) };
}

/** The nearest clip edge or marker before (`dir` -1) or after (1) `frame`; null when there is none. */
export function adjacentEditPoint(doc: Timeline, frame: number, dir: -1 | 1): number | null {
  const pts = snapPoints(doc).filter((p) => (dir > 0 ? p > frame : p < frame));
  if (pts.length === 0) return null;
  return dir > 0 ? Math.min(...pts) : Math.max(...pts);
}

// ---- Ripple (magnetic) editing ----
// Ripple edits add or remove time on every unlocked track at once, so the
// tracks stay in sync: cutting a moment out of the main video also cuts the
// captions and cutaways above it. Locked tracks (a music bed, say) keep their
// timing.

function unlockedTracks(doc: Timeline): Set<string> {
  return new Set(doc.tracks.filter((t) => !t.locked).map((t) => t.id));
}

/**
 * Remove frames [start, end) from every unlocked track (or just `onlyTrack`)
 * and pull everything after it left.
 */
export function closeRange(doc: Timeline, start: number, end: number, onlyTrack?: string): Timeline {
  const s = Math.max(0, Math.round(start));
  const e = Math.round(end);
  if (e <= s) return doc;
  const len = e - s;
  const open = new Set([...unlockedTracks(doc)].filter((id) => !onlyTrack || id === onlyTrack));
  if (open.size === 0) return doc;
  let clips = doc.clips;
  for (const id of open) clips = carve(clips, id, s, e);
  clips = clips.map((c) => (open.has(c.trackId) && c.start >= e ? { ...c, start: c.start - len } : c));
  return { ...doc, clips: sortClips(clips), markers: markersFollow(doc, onlyTrack) ? closeMarkers(doc.markers, s, e) : doc.markers };
}

/**
 * Markers belong to the whole timeline. They follow a ripple through every
 * unlocked track or through the main track alone, and stay put when a single
 * other track closes or opens up.
 */
function markersFollow(doc: Timeline, onlyTrack?: string): boolean {
  return !onlyTrack || onlyTrack === mainTrackId(doc);
}

/** Markers after frames [s, e) are removed: later ones move left, ones inside go, and range markers lose the overlap. */
function closeMarkers(markers: Marker[], s: number, e: number): Marker[] {
  const len = e - s;
  const map = (x: number) => (x < s ? x : x < e ? s : x - len);
  const out: Marker[] = [];
  for (const m of markers) {
    if (!m.duration) {
      if (m.frame < s || m.frame >= e) out.push(m.frame >= e ? { ...m, frame: m.frame - len } : m);
      continue;
    }
    const start = map(m.frame);
    const duration = map(m.frame + m.duration) - start;
    if (duration > 0) out.push(start === m.frame && duration === m.duration ? m : { ...m, frame: start, duration });
  }
  return out;
}

/** Room opens at `a`: later markers move right, and a range marker spanning `a` grows. */
function openMarkers(markers: Marker[], a: number, len: number): Marker[] {
  return markers.map((m) =>
    m.frame >= a ? { ...m, frame: m.frame + len } : m.duration && m.frame + m.duration > a ? { ...m, duration: m.duration + len } : m,
  );
}

/**
 * Push everything that starts at or after `at` right by `length` frames on
 * every unlocked track (or just `onlyTrack`).
 */
export function openRange(doc: Timeline, at: number, length: number, exceptId?: string, onlyTrack?: string): Timeline {
  const a = Math.round(at);
  const len = Math.round(length);
  if (len <= 0) return doc;
  const open = new Set([...unlockedTracks(doc)].filter((id) => !onlyTrack || id === onlyTrack));
  return {
    ...doc,
    clips: sortClips(doc.clips.map((c) => (open.has(c.trackId) && c.id !== exceptId && c.start >= a ? { ...c, start: c.start + len } : c))),
    markers: markersFollow(doc, onlyTrack) ? openMarkers(doc.markers, a, len) : doc.markers,
  };
}

/** Split clips under `at` and open `length` frames there, on every unlocked track (or just `onlyTrack`). */
function openAt(doc: Timeline, at: number, length: number, onlyTrack?: string): Timeline {
  const under = doc.clips.filter((c) => (!onlyTrack || c.trackId === onlyTrack) && c.start < at && at < clipEnd(c)).map((c) => c.id);
  return openRange(under.length ? splitAt(doc, at, under) : doc, at, length, undefined, onlyTrack);
}

/**
 * Trim one edge of a clip and ripple the rest of the timeline: the clip keeps
 * its start, and everything after it moves to follow its new end. Shortening
 * removes that stretch of time from every unlocked track.
 */
export function rippleTrim(
  doc: Timeline,
  id: string,
  edge: 'start' | 'end',
  frame: number,
  sourceLength: SourceLength = unlimited,
  onlyTrack?: string,
): Timeline {
  const clip = doc.clips.find((c) => c.id === id);
  if (!clip || findTrack(doc, clip.trackId)?.locked) return doc;
  const f = Math.round(frame);
  const withClip = (t: Timeline, fn: (c: Clip) => Clip): Timeline => ({ ...t, clips: t.clips.map((c) => (c.id === id ? fn(c) : c)) });
  if (edge === 'end') {
    const oldEnd = clipEnd(clip);
    const newEnd = Math.min(Math.max(f, clip.start + 1), clip.start + maxLength(clip, sourceLength));
    if (newEnd < oldEnd) return closeRange(withClip(doc, (c) => reframe(c, 0, newEnd - c.start)), newEnd, oldEnd, onlyTrack);
    if (newEnd > oldEnd) return withClip(openRange(doc, oldEnd, newEnd - oldEnd, id, onlyTrack), (c) => ({ ...c, duration: newEnd - c.start }));
    return doc;
  }
  const delta = f - clip.start;
  if (delta > 0) {
    // Skip the first `d` frames of the clip's content, then close that time.
    const d = Math.min(delta, clip.duration - 1);
    return closeRange(withClip(doc, (c) => ({ ...reframe(c, d, c.duration - d), start: c.start + d })), clip.start, clip.start + d, onlyTrack);
  }
  if (delta < 0) {
    // Reveal earlier content: the clip grows to the right and pushes the rest along.
    const d = Math.min(-delta, maxReveal(clip));
    if (d <= 0) return doc;
    return withClip(openRange(doc, clip.start, d, id, onlyTrack), (c) => reframe(c, -d, c.duration + d));
  }
  return doc;
}

/** Remove the selected clips' time from every unlocked track (or just `onlyTrack`), closing the gaps. */
export function rippleDeleteClips(doc: Timeline, ids: string[], onlyTrack?: string): Timeline {
  const spans = doc.clips
    .filter((c) => ids.includes(c.id) && !findTrack(doc, c.trackId)?.locked)
    .map((c) => [c.start, clipEnd(c)] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  if (spans.length === 0) return doc;
  const merged: [number, number][] = [];
  for (const [s, e] of spans) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  // Close from the right so earlier spans keep their positions.
  return merged.reverse().reduce((t, [s, e]) => closeRange(t, s, e, onlyTrack), doc);
}

/** Move several clips by the same offset, each on its own track; they overwrite what they land on. */
export function moveClips(doc: Timeline, ids: string[], delta: number): Timeline {
  const moving = doc.clips.filter((c) => ids.includes(c.id) && !findTrack(doc, c.trackId)?.locked);
  if (moving.length === 0) return doc;
  const d = Math.max(Math.round(delta), -Math.min(...moving.map((c) => c.start)));
  if (d === 0) return doc;
  const movingIds = new Set(moving.map((c) => c.id));
  let clips = doc.clips.filter((c) => !movingIds.has(c.id));
  for (const m of moving) clips = carve(clips, m.trackId, m.start + d, clipEnd(m) + d);
  return { ...doc, clips: sortClips([...clips, ...moving.map((m) => ({ ...m, start: m.start + d }))]) };
}

/** Clips that start at or after `frame` (on one track, or all), for selecting everything to the right. */
export function clipsFrom(doc: Timeline, frame: number, trackId?: string): string[] {
  return doc.clips.filter((c) => c.start >= frame && (!trackId || c.trackId === trackId)).map((c) => c.id);
}

/** The empty stretch of a track around `frame`, between two clips (or from 0 to the first). */
export function gapAt(doc: Timeline, trackId: string, frame: number): { start: number; end: number } | null {
  const onTrack = doc.clips.filter((c) => c.trackId === trackId);
  if (onTrack.some((c) => c.start <= frame && frame < clipEnd(c))) return null;
  const next = onTrack.filter((c) => c.start > frame).sort((a, b) => a.start - b.start)[0];
  if (!next) return null;
  const start = onTrack.filter((c) => clipEnd(c) <= frame).reduce((end, c) => Math.max(end, clipEnd(c)), 0);
  return start < next.start ? { start, end: next.start } : null;
}

// ---- Drop operations ----

/** What a replacement needs to know about the new media. */
export interface ReplacementMedia {
  id: string;
  kind: 'video' | 'audio' | 'image';
  /** Source length in frames; Infinity for images. */
  frames: number;
}

/** Whether a clip's media can be swapped for this kind (visual for visual, audio for audio). */
export function canReplace(clip: Clip, kind: ReplacementMedia['kind']): boolean {
  const visual = (k: string) => k === 'video' || k === 'image';
  return (visual(clip.kind) && visual(kind)) || (clip.kind === 'audio' && kind === 'audio');
}

/** Why a replacement cannot happen, or null when it can. */
export function replaceProblem(clip: Clip, media: ReplacementMedia, inPoint = 0): string | null {
  if (!canReplace(clip, media.kind)) return clip.kind === 'audio' ? 'Audio clips can only be replaced with audio.' : 'Video clips can be replaced with video or an image.';
  if (media.kind !== 'image' && media.frames - inPoint < clip.duration) return 'The new media is shorter than the clip. Use a longer one, or an image.';
  return null;
}

/**
 * Swap a media clip's source, keeping its slot: same start, same length.
 * Video and audio play from `inPoint` (the part chosen in the replace
 * dialog) and must be at least as long as the clip; images always fit.
 * Effects carry over unless `keepEffects` is false; framing, fades, volume
 * and transitions always do.
 */
export function replaceClipMedia(
  doc: Timeline,
  id: string,
  media: ReplacementMedia,
  opts: { inPoint?: number; keepEffects?: boolean } = {},
): Timeline {
  const clip = doc.clips.find((c) => c.id === id);
  const inPoint = Math.max(0, Math.round(opts.inPoint ?? 0));
  if (!clip || findTrack(doc, clip.trackId)?.locked || replaceProblem(clip, media, inPoint)) return doc;
  const next: Clip = {
    ...clip,
    kind: media.kind,
    assetId: media.id,
    in: media.kind === 'image' ? undefined : inPoint,
    effects: opts.keepEffects === false ? undefined : clip.effects,
  };
  return { ...doc, clips: doc.clips.map((c) => (c.id === id ? next : c)) };
}

/**
 * Insert a clip at its start, pushing everything from there onwards right on
 * every unlocked track (or just `onlyTrack`); clips under the insert point
 * are split first.
 */
export function insertClip(doc: Timeline, clip: Clip, onlyTrack?: string): Timeline {
  const track = findTrack(doc, clip.trackId);
  if (!track || track.locked || !trackAccepts(track, clip.kind)) return doc;
  const at = Math.max(0, Math.round(clip.start));
  return addClip(openAt(doc, at, Math.max(1, Math.round(clip.duration)), onlyTrack), { ...clip, start: at });
}

// ---- Main track (magnet) ----
// With the magnet on, the main track (the bottom video track, V1) has no
// gaps: drops insert at clip edges, moves reorder, trims and deletes ripple.
// With linkage on, the other tracks follow the main track's changes.

/** The main track: the bottom video track. */
export function mainTrackId(doc: Timeline): string | undefined {
  return doc.tracks.filter((t) => t.kind === 'video').at(-1)?.id;
}

/** Close every gap on a track, including any before its first clip. */
export function closeGaps(doc: Timeline, trackId: string, onlyTrack?: string): Timeline {
  let t = doc;
  for (;;) {
    const onTrack = t.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start);
    let end = 0;
    let gap: [number, number] | null = null;
    for (const c of onTrack) {
      if (c.start > end) {
        gap = [end, c.start];
        break;
      }
      end = Math.max(end, clipEnd(c));
    }
    if (!gap) return t;
    const next = closeRange(t, gap[0], gap[1], onlyTrack);
    if (next === t) return t;
    t = next;
  }
}

/** The clip edge on a track nearest to `frame` (0 and the track's end count). */
export function boundaryNear(doc: Timeline, trackId: string, frame: number): number {
  const onTrack = doc.clips.filter((c) => c.trackId === trackId);
  const end = onTrack.reduce((e, c) => Math.max(e, clipEnd(c)), 0);
  if (frame >= end) return end;
  const points = [0, ...onTrack.flatMap((c) => [c.start, clipEnd(c)])];
  return points.reduce((best, p) => (Math.abs(p - frame) < Math.abs(best - frame) ? p : best), 0);
}

/**
 * Move a main-track clip to the clip edge nearest `frame`, closing the hole it
 * leaves and opening room where it lands. With `linked`, clips on the other
 * tracks that start during it travel with it, and the other tracks ripple too.
 */
export function moveMainClip(doc: Timeline, id: string, frame: number, linked = true): Timeline {
  const clip = doc.clips.find((c) => c.id === id);
  if (!clip || findTrack(doc, clip.trackId)?.locked) return doc;
  const s0 = clip.start;
  const e0 = clipEnd(clip);
  const len = clip.duration;
  const scope = linked ? undefined : clip.trackId;
  const open = unlockedTracks(doc);
  const carried = [
    clip,
    ...(linked ? doc.clips.filter((c) => c.id !== id && c.trackId !== clip.trackId && open.has(c.trackId) && c.start >= s0 && c.start < e0) : []),
  ];
  const carriedIds = new Set(carried.map((c) => c.id));
  let t = closeRange({ ...doc, clips: doc.clips.filter((c) => !carriedIds.has(c.id)) }, s0, e0, scope);
  // Positions after the hole moved left by its length.
  const f = frame >= e0 ? frame - len : frame > s0 ? s0 : frame;
  const at = boundaryNear(t, clip.trackId, f);
  if (at === s0) return doc;
  t = openAt(t, at, len, scope);
  for (const c of carried) t = addClip(t, { ...c, start: c.start - s0 + at });
  return t;
}

/**
 * Delete the part of each clip before (`left`) or after (`right`) the
 * playhead. With `ripple`, the timeline closes up behind it (on `onlyTrack`
 * alone, or on every unlocked track).
 */
export function deleteSide(
  doc: Timeline,
  ids: string[],
  frame: number,
  side: 'left' | 'right',
  ripple = false,
  onlyTrack?: string,
): Timeline {
  let t = doc;
  for (const id of ids) {
    const c = t.clips.find((x) => x.id === id);
    if (!c || frame <= c.start || frame >= clipEnd(c)) continue;
    const edge = side === 'left' ? 'start' : 'end';
    t = ripple ? rippleTrim(t, id, edge, frame, unlimited, onlyTrack) : trimClip(t, id, edge, frame);
  }
  return t;
}

/**
 * Move the start or end of each clip to `frame`, shortening or (as far as its
 * source allows) lengthening it. Main-track clips ripple when `rippleMain` is
 * given (on its `onlyTrack` alone, or every unlocked track); other clips trim
 * in place and overwrite what a longer clip reaches.
 */
export function trimToFrame(
  doc: Timeline,
  ids: string[],
  edge: 'start' | 'end',
  frame: number,
  sourceLength: SourceLength = unlimited,
  rippleMain?: { onlyTrack?: string },
): Timeline {
  const main = mainTrackId(doc);
  let t = doc;
  for (const id of ids) {
    const c = t.clips.find((x) => x.id === id);
    if (!c || (edge === 'start' ? frame >= clipEnd(c) : frame <= c.start)) continue;
    t = rippleMain && c.trackId === main ? rippleTrim(t, id, edge, frame, sourceLength, rippleMain.onlyTrack) : trimClip(t, id, edge, frame, sourceLength);
  }
  return t;
}

// ---- Speed, freeze frames, roll and slip ----

/**
 * Set a video or audio clip's speed, kept within SPEED_LIMITS and rounded to
 * hundredths. The clip keeps its start and `in` point and plays the same
 * stretch of source, so its length scales by old speed / new speed, limited
 * by the end of the source. Like trimming its end: with `ripple`, the rest of
 * the timeline follows (on `ripple.onlyTrack` alone, or every unlocked
 * track); without it, a longer clip overwrites what follows on its track.
 */
export function setSpeed(
  doc: Timeline,
  id: string,
  speed: number,
  sourceLength: SourceLength = unlimited,
  ripple?: { onlyTrack?: string },
): Timeline {
  const clip = doc.clips.find((c) => c.id === id);
  if (!clip || (clip.kind !== 'video' && clip.kind !== 'audio') || clip.freeze || !Number.isFinite(speed)) return doc;
  if (findTrack(doc, clip.trackId)?.locked) return doc;
  const s = Math.round(Math.min(SPEED_LIMITS.max, Math.max(SPEED_LIMITS.min, speed)) * 100) / 100;
  const old = clipSpeed(clip);
  if (s === old) return doc;
  // Keys stretch with the clip, so the animation spans the same footage.
  const stretched = Math.max(1, Math.round((clip.duration * old) / s));
  const retimed: Clip = { ...clip, speed: s === 1 ? undefined : s };
  const duration = Math.max(1, Math.min(stretched, maxLength(retimed, sourceLength)));
  if (clip.keyframes) retimed.keyframes = scaleKeyframes(clip.keyframes, old / s, duration);
  const base = { ...doc, clips: doc.clips.map((c) => (c.id === id ? retimed : c)) };
  const end = clip.start + duration;
  const out = ripple ? rippleTrim(base, id, 'end', end, sourceLength, ripple.onlyTrack) : trimClip(base, id, 'end', end, sourceLength);
  // Keep the fades inside the new length.
  const c = out.clips.find((x) => x.id === id)!;
  const fadeIn = Math.min(c.fadeIn ?? 0, c.duration);
  const fadeOut = Math.min(c.fadeOut ?? 0, c.duration - fadeIn);
  return fadeIn === (c.fadeIn ?? 0) && fadeOut === (c.fadeOut ?? 0) ? out : updateClip(out, id, { fadeIn, fadeOut });
}

/**
 * Hold one frame of a video clip: the source frame showing at timeline
 * `frame` becomes a still (a silent `freeze` clip) `length` frames long that
 * starts there, keeping the clip's framing and effects (animated ones as they
 * stand at that frame: the still holds them). With `insert`, the
 * clip is split there and everything after it moves right (on
 * `insert.onlyTrack` alone, or every unlocked track); otherwise the still
 * overwrites what follows on the track.
 */
export function freezeFrame(doc: Timeline, id: string, frame: number, length: number, insert?: { onlyTrack?: string }): Timeline {
  const clip = doc.clips.find((c) => c.id === id);
  const f = Math.round(frame);
  if (!clip || clip.kind !== 'video' || !clip.assetId || findTrack(doc, clip.trackId)?.locked) return doc;
  if (f < clip.start || f >= clipEnd(clip)) return doc;
  const look = (prop: 'opacity' | 'scale' | 'rotation' | 'offsetX' | 'offsetY') =>
    hasKeys(clip, prop) ? { [prop]: valueAt(clip, prop, f - clip.start) } : clip[prop] !== undefined ? { [prop]: clip[prop] } : {};
  const still: Clip = {
    id: newId(),
    kind: 'video',
    trackId: clip.trackId,
    start: f,
    duration: Math.max(1, Math.round(length)),
    assetId: clip.assetId,
    in: (clip.in ?? 0) + Math.round((f - clip.start) * clipSpeed(clip)),
    freeze: true,
    muted: true,
    ...(clip.fit && { fit: clip.fit }),
    ...look('scale'),
    ...look('rotation'),
    ...look('offsetX'),
    ...look('offsetY'),
    ...look('opacity'),
    ...(clip.effects?.length && { effects: clip.effects }),
  };
  return insert ? insertClip(doc, still, insert.onlyTrack) : addClip(doc, still);
}

/**
 * Roll the cut between two touching clips on one track to `frame`: one gets
 * longer and the other shorter by the same amount, so nothing else moves.
 * The left clip cannot run past the end of its source, nor the right clip
 * start before the beginning of its source, and each keeps at least a frame.
 */
export function rollEdit(doc: Timeline, leftId: string, rightId: string, frame: number, sourceLength: SourceLength = unlimited): Timeline {
  const left = doc.clips.find((c) => c.id === leftId);
  const right = doc.clips.find((c) => c.id === rightId);
  if (!left || !right || left.trackId !== right.trackId || clipEnd(left) !== right.start) return doc;
  if (findTrack(doc, left.trackId)?.locked) return doc;
  const cut = right.start;
  const lo = Math.max(left.start + 1, cut - maxReveal(right));
  const hi = Math.min(clipEnd(right) - 1, left.start + maxLength(left, sourceLength));
  if (lo > hi) return doc;
  const f = Math.min(Math.max(Math.round(frame), lo), hi);
  if (f === cut) return doc;
  const nextLeft = f < cut ? reframe(left, 0, f - left.start) : { ...left, duration: f - left.start };
  const nextRight = { ...reframe(right, f - cut, clipEnd(right) - f), start: f };
  return { ...doc, clips: sortClips(doc.clips.map((c) => (c.id === leftId ? nextLeft : c.id === rightId ? nextRight : c))) };
}

/**
 * Slip a video or audio clip: play a different part of its source in the same
 * place and length. `delta` moves the `in` point, in source frames, kept
 * between the start of the source and the last point that still fills the clip.
 */
export function slipClip(doc: Timeline, id: string, delta: number, sourceLength: SourceLength = unlimited): Timeline {
  const clip = doc.clips.find((c) => c.id === id);
  if (!clip || clip.in === undefined || (clip.kind !== 'video' && clip.kind !== 'audio')) return doc;
  if (findTrack(doc, clip.trackId)?.locked) return doc;
  const span = Math.max(1, Math.round(clip.duration * clipSpeed(clip)));
  const latest = Math.max(0, sourceLength(clip) - span);
  const next = Math.min(Math.max(0, clip.in + Math.round(delta)), latest);
  return next === clip.in ? doc : updateClip(doc, id, { in: next });
}

// ---- Copying a clip's look ----

/** A clip's look, as Copy attributes takes it: effects, transition, opacity, transform, speed, volume and their keyframes. */
export interface ClipAttributes {
  effects?: Effect[];
  transition?: Clip['transition'];
  opacity?: number;
  scale?: number;
  rotation?: number;
  offsetX?: number;
  offsetY?: number;
  fit?: 'contain' | 'cover';
  speed?: number;
  volume?: number;
  /** Animation of the properties above, in frames from the clip's start. */
  keyframes?: Keyframes;
}

/** What Copy attributes takes from a clip. Settings the clip's kind has are copied with their defaults filled in. */
export function clipAttributes(c: Clip): ClipAttributes {
  const a: ClipAttributes = {};
  if (c.effects?.length) a.effects = c.effects.map((fx) => ({ ...fx }));
  if (c.transition) a.transition = { ...c.transition };
  if (c.kind !== 'audio') Object.assign(a, { opacity: c.opacity ?? 1, scale: c.scale ?? 1, rotation: c.rotation ?? 0 });
  if (c.kind === 'video' || c.kind === 'image') Object.assign(a, { offsetX: c.offsetX ?? 0, offsetY: c.offsetY ?? 0, fit: c.fit ?? 'contain' });
  if ((c.kind === 'video' || c.kind === 'audio') && !c.freeze) Object.assign(a, { speed: c.speed ?? 1, volume: c.volume ?? 1 });
  const keys = keyframesFor(c, c.keyframes);
  if (keys) a.keyframes = keys;
  return a;
}

/**
 * Give clips a copied look. Each clip takes the attributes that apply to its
 * kind. A pasted effect replaces an effect of the same type instead of
 * stacking a second one; other effects stay. Speed changes length as
 * `setSpeed` does, rippling main-track clips when `rippleMain` is given.
 * Keyframes are part of the look: each pasted property takes the copied
 * keys (cut to the clip's length), or loses its own when the copy had none.
 * Clips on locked tracks are left alone.
 */
export function pasteAttributes(
  doc: Timeline,
  ids: string[],
  attrs: ClipAttributes,
  sourceLength: SourceLength = unlimited,
  rippleMain?: { onlyTrack?: string },
): Timeline {
  const main = mainTrackId(doc);
  let t = doc;
  for (const id of ids) {
    const c = t.clips.find((x) => x.id === id);
    if (!c || findTrack(t, c.trackId)?.locked) continue;
    const media = c.kind === 'video' || c.kind === 'audio';
    const framed = c.kind === 'video' || c.kind === 'image';
    const patch: Partial<Clip> = {};
    if (c.kind !== 'audio') {
      if (attrs.opacity !== undefined) patch.opacity = attrs.opacity;
      if (attrs.scale !== undefined) patch.scale = attrs.scale;
      if (attrs.rotation !== undefined) patch.rotation = attrs.rotation;
      if (attrs.transition) patch.transition = { ...attrs.transition };
    }
    if (framed) {
      if (attrs.offsetX !== undefined) patch.offsetX = attrs.offsetX;
      if (attrs.offsetY !== undefined) patch.offsetY = attrs.offsetY;
      if (attrs.fit) patch.fit = attrs.fit;
      if (attrs.effects?.length) {
        const effects = [...(c.effects ?? [])];
        for (const fx of attrs.effects) {
          const i = effects.findIndex((e) => e.type === fx.type);
          if (i >= 0) effects[i] = { ...fx };
          else effects.push({ ...fx });
        }
        patch.effects = effects;
      }
    }
    if (media && !c.freeze && attrs.volume !== undefined) patch.volume = attrs.volume;
    t = updateClip(t, id, patch);
    if (media && attrs.speed !== undefined) t = setSpeed(t, id, attrs.speed, sourceLength, rippleMain && c.trackId === main ? rippleMain : undefined);
    // Keys go on after the speed change, so they keep the timing they were copied with.
    const now = t.clips.find((x) => x.id === id)!;
    const pasted = (Object.keys(patch) as (keyof Clip)[]).filter((k): k is KeyframeProp => (animatableProps(now) as string[]).includes(k));
    if (pasted.length) {
      const kf: Keyframes = { ...now.keyframes };
      for (const prop of pasted) {
        const keys = attrs.keyframes?.[prop];
        if (keys?.length) kf[prop] = cropKeys(keys, now.duration);
        else delete kf[prop];
      }
      t = updateClip(t, id, { keyframes: tidyKeyframes(kf) });
    }
  }
  return t;
}

// ---- Keyframes ----
// Keys sit in frames from the clip's start (0 to duration − 1) and are kept
// sorted, one per frame. Values are kept in each property's range.

function withKeys(doc: Timeline, id: string, prop: KeyframeProp, fn: (keys: Keyframe[], clip: Clip) => Keyframe[]): Timeline {
  const clip = doc.clips.find((c) => c.id === id);
  if (!clip || findTrack(doc, clip.trackId)?.locked || !animatableProps(clip).includes(prop)) return doc;
  const before = clip.keyframes?.[prop] ?? [];
  const after = normalizeKeys(fn(before, clip));
  if (after.length === before.length && after.every((k, i) => sameKey(k, before[i]))) return doc;
  const kf: Keyframes = { ...clip.keyframes, [prop]: after };
  return updateClip(doc, id, { keyframes: tidyKeyframes(kf) });
}

const sameKey = (a: Keyframe, b: Keyframe) => a.frame === b.frame && a.value === b.value && (a.ease ?? 'linear') === (b.ease ?? 'linear') && a.duck === b.duck;

const clampValue = (prop: KeyframeProp, v: number) => Math.min(PROP_LIMITS[prop].max, Math.max(PROP_LIMITS[prop].min, v));

/**
 * Add a key, or replace the one at that frame. The frame is kept inside the
 * clip and the value in the property's range. Without `ease`, a replaced key
 * keeps its ease. A key set by hand is no longer a ducking key.
 */
export function setKeyframe(doc: Timeline, id: string, prop: KeyframeProp, frame: number, value: number, ease?: KeyframeEase): Timeline {
  if (!Number.isFinite(frame) || !Number.isFinite(value)) return doc;
  return withKeys(doc, id, prop, (keys, clip) => {
    const f = Math.min(Math.max(0, Math.round(frame)), clip.duration - 1);
    const old = keys.find((k) => k.frame === f);
    const e = ease ?? old?.ease;
    const key: Keyframe = { frame: f, value: clampValue(prop, value), ...(e && e !== 'linear' && { ease: e }) };
    return [...keys.filter((k) => k.frame !== f), key];
  });
}

/** Remove the key at `frame`, if there is one. */
export function removeKeyframe(doc: Timeline, id: string, prop: KeyframeProp, frame: number): Timeline {
  return withKeys(doc, id, prop, (keys) => keys.filter((k) => k.frame !== Math.round(frame)));
}

/** Move the key at `from` to `to` (kept inside the clip); a key already at `to` is replaced. */
export function moveKeyframe(doc: Timeline, id: string, prop: KeyframeProp, from: number, to: number): Timeline {
  return withKeys(doc, id, prop, (keys, clip) => {
    const key = keys.find((k) => k.frame === Math.round(from));
    if (!key) return keys;
    const f = Math.min(Math.max(0, Math.round(to)), clip.duration - 1);
    return [...keys.filter((k) => k !== key && k.frame !== f), { ...key, frame: f }];
  });
}

/**
 * Remove a property's keys (every property's without `prop`). The property
 * keeps the value it had at `frame` (relative to the clip) as its static value,
 * so clearing does not make the clip jump.
 */
export function clearKeyframes(doc: Timeline, id: string, prop?: KeyframeProp, frame = 0): Timeline {
  const clip = doc.clips.find((c) => c.id === id);
  if (!clip?.keyframes || findTrack(doc, clip.trackId)?.locked) return doc;
  const props = prop ? [prop] : (Object.keys(clip.keyframes) as KeyframeProp[]);
  const patch: Partial<Clip> = {};
  const kf: Keyframes = { ...clip.keyframes };
  for (const p of props) {
    if (!kf[p]?.length) continue;
    patch[p] = valueAt(clip, p, frame);
    delete kf[p];
  }
  if (Object.keys(patch).length === 0) return doc;
  return updateClip(doc, id, { ...patch, keyframes: tidyKeyframes(kf) });
}

// ---- Ducking and gain ----

/**
 * Duck clips under speech: write volume keys (tagged as ducking keys) that dip
 * by `opts.depth` dB around each speech range. The keys replace each clip's
 * volume keys and stay editable. Clips the speech never reaches keep theirs.
 */
export function duckClips(doc: Timeline, ids: string[], speech: SpeechRange[], opts: Partial<DuckingOptions> = {}): Timeline {
  const music = doc.clips.filter((c) => ids.includes(c.id) && !findTrack(doc, c.trackId)?.locked && animatableProps(c).includes('volume'));
  const keys = duckingKeys(music, speech, opts);
  let t = doc;
  for (const c of music) {
    const k = keys[c.id];
    if (k?.length) t = updateClip(t, c.id, { keyframes: tidyKeyframes({ ...c.keyframes, volume: k }) });
  }
  return t;
}

/** Take out the volume keys Duck under speech wrote; keys set by hand stay. */
export function removeDucking(doc: Timeline, ids: string[]): Timeline {
  let t = doc;
  for (const id of ids) t = withKeys(t, id, 'volume', (keys) => keys.filter((k) => !k.duck));
  return t;
}

/**
 * Set a clip's gain, kept between silent and MAX_VOLUME. Volume keys scale by
 * the same factor (each kept in range), so a ducked or animated clip keeps its
 * shape around the new level.
 */
export function setClipGain(doc: Timeline, id: string, gain: number): Timeline {
  const clip = doc.clips.find((c) => c.id === id);
  if (!clip || !Number.isFinite(gain) || findTrack(doc, clip.trackId)?.locked) return doc;
  const value = Math.round(Math.max(0, Math.min(MAX_VOLUME, gain)) * 1000) / 1000;
  const old = clip.volume ?? 1;
  const keys = clip.keyframes?.volume;
  const factor = old > 0 ? value / old : 1;
  const patch: Partial<Clip> = { volume: value };
  if (keys?.length && factor !== 1) {
    patch.keyframes = { ...clip.keyframes, volume: keys.map((k) => ({ ...k, value: Math.round(clampValue('volume', k.value * factor) * 1000) / 1000 })) };
  }
  return updateClip(doc, id, patch);
}

// ---- Tracks ----

/**
 * Rename a track (trimmed, up to 24 characters). A track without its own
 * colour keeps the one it had, since the default colour follows the number
 * in the name.
 */
export function renameTrack(doc: Timeline, trackId: string, name: string): Timeline {
  const track = findTrack(doc, trackId);
  const n = name.trim().slice(0, 24);
  if (!track || !n || n === track.name) return doc;
  const color = track.color ?? trackColor(track, doc.tracks.filter((t) => t.kind === track.kind).indexOf(track));
  return updateTrack(doc, trackId, { name: n, color });
}

/**
 * Move a track to position `toIndex` (0 = top) among the tracks of its kind.
 * The bottom video track is always the main track, so moving a track there
 * makes it main. Locked tracks stay where they are.
 */
export function reorderTrack(doc: Timeline, trackId: string, toIndex: number): Timeline {
  const track = findTrack(doc, trackId);
  if (!track || track.locked) return doc;
  const same = doc.tracks.filter((t) => t.kind === track.kind);
  const from = same.indexOf(track);
  const to = Math.min(Math.max(0, Math.round(toIndex)), same.length - 1);
  if (from === to) return doc;
  const order = same.filter((t) => t !== track);
  order.splice(to, 0, track);
  let i = 0;
  return { ...doc, tracks: doc.tracks.map((t) => (t.kind === track.kind ? order[i++] : t)) };
}

/** Clip edges and markers near `frame`, for snapping during drags. */
export function snapPoints(doc: Timeline, excludeIds: string[] = []): number[] {
  const pts = new Set<number>([0]);
  for (const c of doc.clips) {
    if (excludeIds.includes(c.id)) continue;
    pts.add(c.start);
    pts.add(clipEnd(c));
  }
  for (const m of doc.markers) {
    pts.add(m.frame);
    if (m.duration) pts.add(m.frame + m.duration);
  }
  return [...pts];
}

export function snap(frame: number, points: number[], threshold: number): number {
  let best = frame;
  let bestDist = threshold + 1;
  for (const p of points) {
    const d = Math.abs(p - frame);
    if (d <= threshold && d < bestDist) {
      best = p;
      bestDist = d;
    }
  }
  return best;
}

/** First frame at or after `from` where a clip of `duration` fits on the track without overwriting. */
export function nextFreeFrame(doc: Timeline, trackId: string, from = 0): number {
  const onTrack = doc.clips.filter((c) => c.trackId === trackId);
  return onTrack.reduce((end, c) => Math.max(end, clipEnd(c)), from);
}

// ---- Project-level operations ----

export function updateTimeline(doc: ProjectDoc, id: string, fn: (t: Timeline) => Timeline): ProjectDoc {
  let changed = false;
  const timelines = doc.timelines.map((t) => {
    if (t.id !== id) return t;
    const next = fn(t);
    if (next !== t) changed = true;
    return next;
  });
  return changed ? { ...doc, timelines } : doc;
}

/**
 * Copy a timeline into another frame format, e.g. a 9:16 short from the main
 * cut. Visual media is cropped to fill the new frame; reframe clips with offsetX.
 */
export function deriveTimeline(source: Timeline, name: string, format: FormatId): Timeline {
  const { width, height } = FORMATS[format];
  const textScale = Math.min(width / source.width, height / source.height) * 1.6;
  return {
    ...source,
    id: newId(8),
    name,
    width,
    height,
    clips: source.clips.map((c) => ({
      ...c,
      id: newId(),
      fit: c.kind === 'video' || c.kind === 'image' ? 'cover' : c.fit,
      text: c.text ? { ...c.text, fontSize: Math.round(c.text.fontSize * Math.min(1, textScale)) } : undefined,
    })),
    markers: source.markers.map((m) => ({ ...m, id: newId() })),
  };
}

export function addTimeline(doc: ProjectDoc, timeline: Timeline): ProjectDoc {
  return { ...doc, timelines: [...doc.timelines, timeline] };
}

export function removeTimeline(doc: ProjectDoc, id: string): ProjectDoc {
  if (doc.timelines.length <= 1) return doc;
  return { ...doc, timelines: doc.timelines.filter((t) => t.id !== id) };
}

/** Keep only frames [start, end) of a timeline, shifted to begin at 0 — e.g. a short's highlight range. */
export function cropRange(t: Timeline, start: number, end: number): Timeline {
  const s = Math.max(0, Math.round(start));
  const e = Math.round(end);
  const clips: Clip[] = [];
  for (const c of t.clips) {
    if (clipEnd(c) <= s || c.start >= e) continue;
    const head = Math.max(0, s - c.start);
    const tail = Math.max(0, clipEnd(c) - e);
    clips.push({
      ...reframe(c, head, c.duration - head - tail),
      start: Math.max(c.start, s) - s,
      fadeIn: head ? 0 : c.fadeIn,
      fadeOut: tail ? 0 : c.fadeOut,
    });
  }
  return {
    ...t,
    clips,
    markers: t.markers
      .filter((m) => (m.duration ? m.frame < e && m.frame + m.duration > s : m.frame >= s && m.frame < e))
      .map((m) => {
        if (!m.duration) return { ...m, frame: m.frame - s };
        const start = Math.max(m.frame, s);
        return { ...m, frame: start - s, duration: Math.min(m.frame + m.duration, e) - start };
      }),
  };
}

// ---- In/out ranges ----
// A range is frames [start, end) of the timeline, marked with I and O in the
// editor. Both operations act on every unlocked track; locked tracks keep
// their clips and timing.

/**
 * Lift a range: remove what every unlocked track holds in frames
 * [start, end) and leave a gap. Clips crossing an edge are split there
 * (hard cuts, caption words kept in sync); markers stay where they are.
 */
export function liftRange(doc: Timeline, start: number, end: number): Timeline {
  const s = Math.max(0, Math.round(start));
  const e = Math.round(end);
  if (e <= s) return doc;
  const open = unlockedTracks(doc);
  const cut = splitAt(splitAt(doc, s), e);
  const clips = cut.clips.filter((c) => !(open.has(c.trackId) && c.start >= s && clipEnd(c) <= e));
  return clips.length === doc.clips.length && cut === doc ? doc : { ...cut, clips };
}

/**
 * Extract a range: lift it, then close the gap on every unlocked track so
 * everything after it moves left. Markers inside the range go and later
 * ones move with the clips.
 */
export function extractRange(doc: Timeline, start: number, end: number): Timeline {
  const s = Math.max(0, Math.round(start));
  const e = Math.round(end);
  if (e <= s || unlockedTracks(doc).size === 0) return doc;
  return closeRange(liftRange(doc, s, e), s, e);
}

// ---- Markers ----

const MARKER_LABEL_MAX = 80;
const markerColor = (c: string | undefined | null) => (c && MARKER_COLORS.some((m) => m.hex === c) ? c : undefined);
const sortMarkers = (markers: Marker[]) => [...markers].sort((a, b) => a.frame - b.frame);

/**
 * Add a marker: a point marker, or a range marker when `duration` is given.
 * The label defaults to "Marker N"; an unknown colour is dropped.
 */
export function addMarker(doc: Timeline, marker: { frame: number; label?: string; color?: string; duration?: number; id?: string }): Timeline {
  const frame = Math.max(0, Math.round(marker.frame));
  if (!Number.isFinite(frame)) return doc;
  const duration = marker.duration !== undefined ? Math.round(marker.duration) : 0;
  const label = (marker.label ?? '').trim().slice(0, MARKER_LABEL_MAX) || `Marker ${doc.markers.length + 1}`;
  const m: Marker = { id: marker.id ?? newId(), frame, label };
  const color = markerColor(marker.color);
  if (color) m.color = color;
  if (duration > 0) m.duration = duration;
  return { ...doc, markers: sortMarkers([...doc.markers, m]) };
}

/**
 * Rename, recolour or resize a marker. An empty label is ignored, a null
 * colour clears it, and a duration below one frame makes it a point marker.
 */
export function updateMarker(doc: Timeline, id: string, patch: { label?: string; color?: string | null; duration?: number | null }): Timeline {
  const m = doc.markers.find((x) => x.id === id);
  if (!m) return doc;
  const next: Marker = { ...m };
  if (patch.label !== undefined) {
    const label = patch.label.trim().slice(0, MARKER_LABEL_MAX);
    if (label) next.label = label;
  }
  if (patch.color !== undefined) {
    const color = markerColor(patch.color);
    if (color) next.color = color;
    else if (patch.color === null) delete next.color;
  }
  if (patch.duration !== undefined) {
    const d = patch.duration === null ? 0 : Math.round(patch.duration);
    if (d >= 1) next.duration = d;
    else delete next.duration;
  }
  const same = next.label === m.label && next.color === m.color && next.duration === m.duration;
  return same ? doc : { ...doc, markers: doc.markers.map((x) => (x.id === id ? next : x)) };
}

/** Move a marker so it starts at `frame` (not before 0); a range marker keeps its length. */
export function moveMarker(doc: Timeline, id: string, frame: number): Timeline {
  const m = doc.markers.find((x) => x.id === id);
  const f = Math.max(0, Math.round(frame));
  if (!m || !Number.isFinite(f) || f === m.frame) return doc;
  return { ...doc, markers: sortMarkers(doc.markers.map((x) => (x.id === id ? { ...x, frame: f } : x))) };
}

export function removeMarker(doc: Timeline, id: string): Timeline {
  return doc.markers.some((m) => m.id === id) ? { ...doc, markers: doc.markers.filter((m) => m.id !== id) } : doc;
}

/** Shortest chapter YouTube accepts, in seconds. */
export const CHAPTER_MIN_SECONDS = 10;

export interface Chapters {
  /** One "0:00 Title" line per chapter, ready to paste into a video description. */
  text: string;
  chapters: { frame: number; label: string }[];
  /** Point markers left out because they were closer than CHAPTER_MIN_SECONDS to the chapter before (or to the end). */
  skipped: { frame: number; label: string }[];
  /** YouTube shows chapters only when there are at least three. */
  tooFew: boolean;
}

/** "0:05", "12:30", "1:02:03" (whole seconds, rounded down). */
export function chapterTime(frame: number, fps: number): string {
  const t = Math.floor(frame / fps);
  const h = Math.floor(t / 3600);
  const m = Math.floor(t / 60) % 60;
  const sec = String(t % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/**
 * Video chapters from a timeline's point markers, in time order. The first
 * chapter always starts at 0:00: a marker in the first CHAPTER_MIN_SECONDS
 * moves there, otherwise an "Intro" chapter is added. A marker closer than
 * that to the chapter before it, or to the end of the timeline, is skipped
 * and listed in `skipped`. Range markers are not chapters.
 */
export function chaptersFromMarkers(doc: Timeline): Chapters {
  const fps = doc.fps;
  const min = CHAPTER_MIN_SECONDS * fps;
  const end = timelineDuration(doc);
  const points = sortMarkers(doc.markers.filter((m) => !m.duration));
  const chapters: { frame: number; label: string }[] = [];
  const skipped: { frame: number; label: string }[] = [];
  for (const m of points) {
    if (chapters.length === 0) {
      chapters.push(m.frame < min ? { frame: 0, label: m.label } : { frame: 0, label: 'Intro' });
      if (m.frame < min) continue;
    }
    const last = chapters[chapters.length - 1];
    if (m.frame - last.frame < min || (end > 0 && end - m.frame < min)) skipped.push({ frame: m.frame, label: m.label });
    else chapters.push({ frame: m.frame, label: m.label });
  }
  return {
    text: chapters.map((c) => `${chapterTime(c.frame, fps)} ${c.label}`).join('\n'),
    chapters,
    skipped,
    tooFew: chapters.length < 3,
  };
}

// ---- Text-based cuts ----

/**
 * Cut frame ranges out of the timeline: each range is removed from every
 * unlocked track and the gaps close, in one edit. Overlapping or touching
 * ranges merge; they are closed from the right so earlier ones keep their
 * positions.
 */
export function cutRanges(doc: Timeline, ranges: [number, number][]): Timeline {
  const sorted = ranges
    .map(([s, e]) => [Math.max(0, Math.round(s)), Math.round(e)] as [number, number])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [s, e] of sorted) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged.reverse().reduce((t, [s, e]) => closeRange(t, s, e), doc);
}

/** Cut frames [start, end) out of every unlocked track and close the gap. */
export function cutRange(doc: Timeline, start: number, end: number): Timeline {
  return cutRanges(doc, [[start, end]]);
}

/**
 * Put back `frames` of source that a cut removed at `at`: everything from
 * `at` on moves right on every unlocked track, and the clips in `ids` (which
 * end at `at`) play on into the source they had skipped.
 */
export function restoreSourceGap(doc: Timeline, at: number, frames: number, ids: string[]): Timeline {
  const a = Math.round(at);
  const len = Math.round(frames);
  const grow = doc.clips.filter((c) => ids.includes(c.id) && clipEnd(c) === a && !findTrack(doc, c.trackId)?.locked);
  if (len <= 0 || grow.length === 0) return doc;
  const growIds = new Set(grow.map((c) => c.id));
  const opened = openRange(doc, a, len);
  return { ...opened, clips: opened.clips.map((c) => (growIds.has(c.id) ? { ...c, duration: c.duration + len } : c)) };
}
