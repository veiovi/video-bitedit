// Pure timeline operations. Each returns a new timeline and never mutates its
// input, so the editor can keep them on an undo stack.
//
// Placement uses overwrite semantics: a clip dropped onto a track carves its
// range out of whatever was already there.

import { retimeWords } from './captions';
import { type Clip, FORMATS, type FormatId, type ProjectDoc, TRACK_LIMITS, type Timeline, type Track, type TrackKind, clipEnd, newId, trackAccepts } from './project';

/** Frames available in a clip's source, or Infinity for images and text. */
export type SourceLength = (clip: Clip) => number;

const unlimited: SourceLength = () => Infinity;

/**
 * A clip whose content now begins `delta` frames later (head trimmed) and lasts
 * `duration` frames. Moves the source `in` point and retimes caption words.
 */
function reframe(c: Clip, delta: number, duration: number): Clip {
  return {
    ...c,
    duration,
    in: c.in === undefined ? undefined : c.in + delta,
    words: retimeWords(c.words, delta, duration),
  };
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
  const srcIn = clip.in ?? 0;
  let next: Clip;
  if (edge === 'start') {
    const earliest = clip.in === undefined ? 0 : Math.max(0, clip.start - srcIn);
    const s = Math.min(Math.max(f, earliest), clipEnd(clip) - 1);
    const delta = s - clip.start;
    next = { ...reframe(clip, delta, clip.duration - delta), start: s };
  } else {
    const maxDuration = sourceLength(clip) - srcIn;
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
      ...(clip.volume !== undefined && { volume: clip.volume }),
      ...(clip.fadeIn && { fadeIn: clip.fadeIn }),
      ...(clip.fadeOut && { fadeOut: clip.fadeOut }),
    };
    out = { ...out, clips: sortClips([...out.clips.map((c) => (c.id === id ? { ...c, muted: true } : c)), sound]) };
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
  // Markers belong to the whole timeline, so a single-track close leaves them alone.
  const markers = onlyTrack
    ? doc.markers
    : doc.markers.filter((m) => m.frame < s || m.frame >= e).map((m) => (m.frame >= e ? { ...m, frame: m.frame - len } : m));
  return { ...doc, clips: sortClips(clips), markers };
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
    markers: onlyTrack ? doc.markers : doc.markers.map((m) => (m.frame >= a ? { ...m, frame: m.frame + len } : m)),
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
  const srcIn = clip.in ?? 0;
  const withClip = (t: Timeline, fn: (c: Clip) => Clip): Timeline => ({ ...t, clips: t.clips.map((c) => (c.id === id ? fn(c) : c)) });
  if (edge === 'end') {
    const oldEnd = clipEnd(clip);
    const newEnd = Math.min(Math.max(f, clip.start + 1), clip.start + sourceLength(clip) - srcIn);
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
    const d = clip.in === undefined ? -delta : Math.min(-delta, srcIn);
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

/** Clip edges and markers near `frame`, for snapping during drags. */
export function snapPoints(doc: Timeline, excludeIds: string[] = []): number[] {
  const pts = new Set<number>([0]);
  for (const c of doc.clips) {
    if (excludeIds.includes(c.id)) continue;
    pts.add(c.start);
    pts.add(clipEnd(c));
  }
  for (const m of doc.markers) pts.add(m.frame);
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
    markers: t.markers.filter((m) => m.frame >= s && m.frame < e).map((m) => ({ ...m, frame: m.frame - s })),
  };
}
