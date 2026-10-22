import { describe, expect, it } from 'vitest';
import { addClip, addMarker, addTrack, adjacentEditPoint, boundaryNear, canReplace, chaptersFromMarkers, chapterTime, clipAttributes, clipsFrom, closeGaps, closeRange, cropRange, cutRange, cutRanges, deleteClips, deleteSide, deriveTimeline, detachAudio, extractRange, freezeFrame, gapAt, insertClip, liftRange, mainTrackId, MAX_VOLUME, moveClip, moveClips, moveMainClip, moveMarker, openRange, pasteAttributes, pasteClips, removeMarker, renameTrack, reorderTrack, replaceClipMedia, replaceProblem, restoreSourceGap, rippleDeleteClips, rippleTrim, rollEdit, setFade, setSpeed, setVolume, slipClip, snapPoints, splitAt, toggleClipsEnabled, trimClip, trimToFrame, updateMarker, updateTrack } from '../src/shared/edits';
import { clipWords } from '../src/shared/captions';
import { type Marker, renderExt, renderMime, renderRange } from '../src/shared/project';
import { type Clip, type PublishedVideo, TRACK_LIMITS, type Timeline, aspectLabel, emptyTimeline, framing, parseTimecode, pickVersions, trackColor, withSolo } from '../src/shared/project';

function clip(id: string, start: number, duration: number, extra: Partial<Clip> = {}): Clip {
  return { id, kind: 'video', trackId: 'v1', start, duration, assetId: 'a', in: 0, ...extra };
}

function withClips(...clips: Clip[]): Timeline {
  return clips.reduce((t, c) => addClip(t, c), emptyTimeline());
}

const spans = (t: Timeline, track = 'v1') =>
  t.clips.filter((c) => c.trackId === track).map((c) => [c.start, c.start + c.duration, c.in]);

describe('placement', () => {
  it('overwrites the range it lands on, splitting a clip it falls inside', () => {
    const t = addClip(withClips(clip('a', 0, 100)), clip('b', 40, 20, { in: 500 }));
    expect(spans(t)).toEqual([
      [0, 40, 0],
      [40, 60, 500],
      [60, 100, 60],
    ]);
  });

  it('rejects clips on the wrong kind of track', () => {
    const t = emptyTimeline();
    expect(addClip(t, clip('x', 0, 10, { kind: 'audio', trackId: 'v1' }))).toBe(t);
  });

  it('moves clips across tracks and carves the destination', () => {
    let t = withClips(clip('a', 0, 50), clip('b', 0, 30, { trackId: 'v2' }));
    t = moveClip(t, 'b', 40, 'v1');
    expect(spans(t)).toEqual([
      [0, 40, 0],
      [40, 70, 0],
    ]);
    expect(spans(t, 'v2')).toEqual([]);
  });
});

describe('trimming', () => {
  it('trims the start and advances the source in-point', () => {
    const t = trimClip(withClips(clip('a', 10, 100, { in: 5 })), 'a', 'start', 30);
    expect(spans(t)).toEqual([[30, 110, 25]]);
  });

  it('cannot extend past the start of the source', () => {
    const t = trimClip(withClips(clip('a', 10, 100, { in: 5 })), 'a', 'start', 0);
    expect(spans(t)).toEqual([[5, 110, 0]]);
  });

  it('cannot extend past the end of the source', () => {
    const t = trimClip(withClips(clip('a', 0, 50, { in: 10 })), 'a', 'end', 500, () => 100);
    expect(spans(t)).toEqual([[0, 90, 10]]);
  });
});

describe('split and delete', () => {
  it('splits every clip under the playhead', () => {
    const t = splitAt(withClips(clip('a', 0, 100), clip('b', 0, 100, { trackId: 'v2' })), 30);
    expect(t.clips).toHaveLength(4);
    expect(spans(t)).toEqual([
      [0, 30, 0],
      [30, 100, 30],
    ]);
  });

  it('ripple delete closes the gap on that track only', () => {
    let t = withClips(clip('a', 0, 30), clip('b', 30, 30), clip('c', 60, 30), clip('d', 60, 30, { trackId: 'v2' }));
    t = deleteClips(t, ['b'], true);
    expect(spans(t)).toEqual([
      [0, 30, 0],
      [30, 60, 0],
    ]);
    expect(spans(t, 'v2')).toEqual([[60, 90, 0]]);
  });

  it('lift leaves the gap', () => {
    const t = deleteClips(withClips(clip('a', 0, 30), clip('b', 30, 30)), ['a']);
    expect(spans(t)).toEqual([[30, 60, 0]]);
  });

  it('leaves locked tracks alone', () => {
    let t = withClips(clip('a', 0, 30));
    t = { ...t, tracks: t.tracks.map((x) => (x.id === 'v1' ? { ...x, locked: true } : x)) };
    expect(deleteClips(t, ['a'])).toBe(t);
    expect(splitAt(t, 10)).toBe(t);
  });
});

describe('tracks and timelines', () => {
  it('caps the number of tracks', () => {
    let t = emptyTimeline();
    for (let i = 0; i < 20; i++) t = addTrack(addTrack(t, 'video'), 'audio');
    expect(t.tracks.filter((x) => x.kind === 'video')).toHaveLength(TRACK_LIMITS.video);
    expect(t.tracks.filter((x) => x.kind === 'audio')).toHaveLength(TRACK_LIMITS.audio);
  });

  it('derives a vertical short that crops video to fill', () => {
    const main = withClips(clip('a', 0, 300));
    const short = deriveTimeline(main, 'Short', 'vertical');
    expect([short.width, short.height]).toEqual([1080, 1920]);
    expect(short.clips[0].fit).toBe('cover');
    expect(short.clips[0].id).not.toBe('a');
  });

  it('crops a range and shifts it to zero', () => {
    const t = cropRange(withClips(clip('a', 0, 100), clip('b', 100, 100)), 50, 150);
    expect(spans(t)).toEqual([
      [0, 50, 50],
      [50, 100, 0],
    ]);
  });
});

describe('text clips', () => {
  it('does not replay the entrance animation after a split', () => {
    const text = { text: 'Hi', fontSize: 80, color: '#fff', background: 'transparent', fontWeight: 700, x: 0.5, y: 0.5, animation: 'rise' as const };
    const t = splitAt(withClips(clip('t', 0, 90, { kind: 'text', trackId: 'v2', assetId: undefined, in: undefined, text })), 30);
    expect(t.clips.map((c) => c.text?.animation)).toEqual(['rise', 'none']);
  });
});

describe('caption clips', () => {
  const caption = (id: string, start: number, duration: number): Clip => ({
    id,
    kind: 'caption',
    trackId: 'v3',
    start,
    duration,
    words: [
      { text: 'one', start: 0, end: 10 },
      { text: 'two', start: 12, end: 20 },
      { text: 'three', start: 25, end: 40 },
    ],
  });
  const wordsOf = (t: Timeline) => t.clips.filter((c) => c.kind === 'caption').map((c) => [c.start, c.words!.map((w) => [w.text, w.start, w.end])]);

  it('split keeps each word with the half that shows it', () => {
    const t = splitAt(withClips(caption('c', 100, 40)), 115);
    expect(wordsOf(t)).toEqual([
      [100, [['one', 0, 10], ['two', 12, 15]]],
      [115, [['two', 0, 5], ['three', 10, 25]]],
    ]);
  });

  it('trimming the start shifts words; trimming the end drops them', () => {
    let t = trimClip(withClips(caption('c', 0, 40)), 'c', 'start', 12);
    expect(wordsOf(t)).toEqual([[12, [['two', 0, 8], ['three', 13, 28]]]]);
    t = trimClip(t, 'c', 'end', 30);
    expect(wordsOf(t)).toEqual([[12, [['two', 0, 8], ['three', 13, 18]]]]);
  });

  it('overwriting the middle of a caption clip retimes the tail', () => {
    const t = addClip(withClips(caption('c', 0, 40)), { id: 'x', kind: 'text', trackId: 'v3', start: 5, duration: 15 });
    expect(wordsOf(t)).toEqual([
      [0, [['one', 0, 5]]],
      [20, [['three', 5, 20]]],
    ]);
  });

  it('cropping a range carries captions into a short', () => {
    const t = cropRange(withClips(caption('c', 0, 40)), 12, 30);
    expect(wordsOf(t)).toEqual([[0, [['two', 0, 8], ['three', 13, 18]]]]);
  });
});

describe('framing', () => {
  it('pans a cropped clip inside its crop, clamped to the source edges', () => {
    expect(framing(clip('a', 0, 10, { fit: 'cover', offsetX: -0.29 }))).toEqual({ transform: 'scale(1) rotate(0deg)', objectPosition: '21% 50%' });
    expect(framing(clip('a', 0, 10, { fit: 'cover', offsetX: 0.9, offsetY: -1 })).objectPosition).toBe('100% 0%');
  });

  it('moves a letterboxed clip across the frame', () => {
    expect(framing(clip('a', 0, 10, { offsetX: 0.25, scale: 2 }))).toEqual({ transform: 'translate(25%, 0%) scale(2) rotate(0deg)' });
  });
});

describe('watch page versions', () => {
  const video = (renderId: string, timelineId: string, timelineName: string, seconds: number, publishedAt: number, size = [1920, 1080]): PublishedVideo & { timelineId: string } => ({
    renderId,
    timelineId,
    timelineName,
    projectId: 'p',
    title: 't',
    description: '',
    preset: 'mp4-1080p',
    outputSize: 1,
    publishedAt,
    durationFrames: seconds * 30,
    fps: 30,
    width: size[0],
    height: size[1],
    sourceCount: 1,
  });

  it('lists the latest render per timeline, longest first, with Full for the main cut', () => {
    const versions = pickVersions([
      video('s1', 'short', 'Short', 20, 1, [1080, 1920]),
      video('m1', 'main', 'Main', 47, 1),
      video('m2', 'main', 'Main', 48, 5),
      { ...video('a1', 'main', 'Main', 47, 9), preset: 'audio-mp3' },
    ]);
    expect(versions.map((v) => [v.renderId, v.label, v.aspect])).toEqual([
      ['m2', 'Full', '16:9'],
      ['s1', 'Short', '9:16'],
    ]);
  });

  it('names common aspect ratios', () => {
    expect([aspectLabel(1080, 1080), aspectLabel(1440, 1080), aspectLabel(1000, 300)]).toEqual(['1:1', '4:3', '1000×300']);
  });
});

describe('ripple editing', () => {
  // A talking-head cut on V1 with a caption above it on V3 and a cutaway on V2.
  const base = () => {
    let t = withClips(clip('a', 0, 100, { in: 0 }), clip('b', 100, 100, { in: 300 }), clip('cut', 120, 30, { trackId: 'v2', kind: 'image', in: undefined }));
    t = addClip(t, {
      id: 'cap',
      kind: 'caption',
      trackId: 'v3',
      start: 50,
      duration: 100,
      words: [
        { text: 'kept', start: 0, end: 20 },
        { text: 'cut', start: 40, end: 60 },
        { text: 'after', start: 70, end: 90 },
      ],
    });
    return { ...t, markers: [{ id: 'm1', frame: 95, label: 'gone' }, { id: 'm2', frame: 150, label: 'moves' }] };
  };
  const at = (t: Timeline, id: string) => {
    const c = t.clips.find((x) => x.id === id)!;
    return [c.start, c.duration, c.in];
  };

  it('closing a range cuts every unlocked track and pulls the rest left', () => {
    const t = closeRange(base(), 80, 110);
    expect(spans(t)).toEqual([
      [0, 80, 0],
      [80, 170, 310],
    ]);
    expect(at(t, 'cut')).toEqual([90, 30, undefined]);
    const cap = t.clips.filter((c) => c.kind === 'caption').map((c) => [c.start, c.duration, c.words!.map((w) => w.text)]);
    expect(cap).toEqual([
      // "cut" was spoken entirely inside the removed range.
      [50, 30, ['kept']],
      [80, 40, ['after']],
    ]);
    expect(t.markers.map((m) => m.frame)).toEqual([120]);
  });

  it('can close a gap on one track only', () => {
    const t = closeRange(withClips(clip('a', 0, 50), clip('b', 80, 20), clip('c', 90, 10, { trackId: 'v2' })), 50, 80, 'v1');
    expect(spans(t)).toEqual([
      [0, 50, 0],
      [50, 70, 0],
    ]);
    expect(spans(t, 'v2')).toEqual([[90, 100, 0]]);
  });

  it('leaves locked tracks where they are', () => {
    let t = base();
    t = { ...t, tracks: t.tracks.map((x) => (x.id === 'v2' ? { ...x, locked: true } : x)) };
    expect(at(closeRange(t, 80, 110), 'cut')).toEqual([120, 30, undefined]);
  });

  it('ripple-trimming an end removes or adds time after the clip', () => {
    let t = rippleTrim(base(), 'a', 'end', 90);
    expect(spans(t)).toEqual([
      [0, 90, 0],
      [90, 190, 300],
    ]);
    expect(at(t, 'cut')).toEqual([110, 30, undefined]);
    t = rippleTrim(base(), 'a', 'end', 130, () => 1000);
    expect(spans(t)).toEqual([
      [0, 130, 0],
      [130, 230, 300],
    ]);
    expect(at(t, 'cut')).toEqual([150, 30, undefined]);
  });

  it('ripple-trimming a start keeps the clip in place and shifts its content', () => {
    let t = rippleTrim(base(), 'b', 'start', 110);
    expect(spans(t)).toEqual([
      [0, 100, 0],
      [100, 190, 310],
    ]);
    t = rippleTrim(base(), 'b', 'start', 90);
    expect(spans(t)).toEqual([
      [0, 100, 0],
      [100, 210, 290],
    ]);
    expect(at(t, 'cut')).toEqual([130, 30, undefined]);
  });

  it('ripple delete removes the selected clips\' time from the whole timeline', () => {
    let t = splitAt(splitAt(base(), 110), 130, undefined);
    const piece = t.clips.find((c) => c.trackId === 'v1' && c.start === 110)!;
    t = rippleDeleteClips(t, [piece.id]);
    expect(spans(t)).toEqual([
      [0, 100, 0],
      [100, 110, 300],
      [110, 180, 330],
    ]);
    // The cutaway (120–150) loses the 10 frames that fell inside the removed 110–130.
    expect(t.clips.filter((c) => c.trackId === 'v2').map((c) => [c.start, c.duration])).toEqual([[110, 20]]);
  });

  it('moves a group of clips together and selects everything to the right', () => {
    const t = base();
    expect(clipsFrom(t, 100).sort()).toEqual(['b', 'cut']);
    expect(clipsFrom(t, 100, 'v1')).toEqual(['b']);
    const moved = moveClips(t, ['b', 'cut'], -10);
    expect(spans(moved)).toEqual([
      [0, 90, 0],
      [90, 190, 300],
    ]);
    expect(at(moved, 'cut')).toEqual([110, 30, undefined]);
    expect(moveClips(t, ['a', 'b'], -10)).toBe(t);
  });

  it('finds the gap around a frame', () => {
    const t = withClips(clip('a', 0, 50), clip('b', 80, 20));
    expect(gapAt(t, 'v1', 60)).toEqual({ start: 50, end: 80 });
    expect(gapAt(t, 'v1', 10)).toBeNull();
    expect(gapAt(t, 'v1', 120)).toBeNull();
    expect(gapAt(withClips(clip('a', 30, 10)), 'v1', 5)).toEqual({ start: 0, end: 30 });
  });
});

describe('detaching audio and fades', () => {
  it('moves a video clip\'s sound to the first free audio track and mutes the video', () => {
    const t = withClips(clip('a', 30, 60, { in: 12, volume: 0.8, fadeOut: 10 }), clip('m', 0, 50, { kind: 'audio', trackId: 'a1', assetId: 'music' }));
    const out = detachAudio(t, ['a']);
    const video = out.clips.find((c) => c.id === 'a')!;
    const sound = out.clips.find((c) => c.kind === 'audio' && c.assetId === 'a')!;
    expect(video.muted).toBe(true);
    // A1 is busy under the clip, so the sound goes on A2, playing the same part of the source.
    expect([sound.trackId, sound.start, sound.duration, sound.in, sound.volume, sound.fadeOut, sound.fadeIn]).toEqual(['a2', 30, 60, 12, 0.8, 10, undefined]);
  });

  it('adds an audio track when every one is busy, and skips muted or non-video clips', () => {
    let t = withClips(clip('a', 0, 40), clip('t', 0, 40, { kind: 'text', assetId: undefined, trackId: 'v2' }));
    for (const id of ['a1', 'a2', 'a3', 'a4']) t = addClip(t, clip(`m-${id}`, 0, 100, { kind: 'audio', trackId: id }));
    const out = detachAudio(t, ['a', 't']);
    expect(out.tracks.filter((x) => x.kind === 'audio')).toHaveLength(5);
    expect(out.clips.filter((c) => c.trackId === out.tracks.at(-1)!.id).map((c) => c.assetId)).toEqual(['a']);
    expect(out.clips.find((c) => c.id === 't')!.muted).toBeUndefined();
    expect(detachAudio(out, ['a'])).toBe(out);
  });

  it('leaves the clip alone when no audio track can be added', () => {
    let t = withClips(clip('a', 0, 40));
    while (t.tracks.filter((x) => x.kind === 'audio').length < TRACK_LIMITS.audio) t = addTrack(t, 'audio');
    for (const tr of t.tracks.filter((x) => x.kind === 'audio')) t = addClip(t, clip(`m-${tr.id}`, 0, 100, { kind: 'audio', trackId: tr.id }));
    expect(detachAudio(t, ['a'])).toEqual(t);
  });

  it('keeps fades inside the clip and clear of each other', () => {
    const t = withClips(clip('a', 0, 100, { fadeOut: 30 }));
    expect(setFade(t, 'a', 'in', 90).clips[0].fadeIn).toBe(70);
    expect(setFade(t, 'a', 'in', -5).clips[0].fadeIn).toBe(0);
    expect(setFade(t, 'a', 'out', 12.4).clips[0].fadeOut).toBe(12);
  });

  it('keeps volume between silent and double, in whole percent', () => {
    const t = withClips(clip('a', 0, 100));
    expect(setVolume(t, 'a', 0.734).clips[0].volume).toBe(0.73);
    expect(setVolume(t, 'a', 3).clips[0].volume).toBe(MAX_VOLUME);
    expect(setVolume(t, 'a', -1).clips[0].volume).toBe(0);
  });

  it('solo mutes every other track for listening, and only when a soloed track is in this timeline', () => {
    const t = emptyTimeline();
    const heard = withSolo(t, ['a2']);
    expect(heard.tracks.filter((x) => x.muted).map((x) => x.id)).toEqual(t.tracks.filter((x) => x.id !== 'a2').map((x) => x.id));
    expect(heard.tracks.some((x) => x.hidden)).toBe(false);
    expect(withSolo(t, ['a1', 'a2']).tracks.filter((x) => !x.muted).map((x) => x.id)).toEqual(['a1', 'a2']);
    expect(withSolo(t, ['elsewhere'])).toBe(t);
    expect(withSolo(t, [])).toBe(t);
  });
});

describe('clipboard, enable/disable and navigation', () => {
  it('pastes copies at a frame, keeping their offsets and tracks, overwriting what is there', () => {
    const t = withClips(clip('a', 0, 100), clip('t', 10, 20, { kind: 'text', trackId: 'v2', assetId: undefined }));
    const copies = [{ ...t.clips.find((c) => c.id === 'a')!, id: 'a2', duration: 30 }, { ...t.clips.find((c) => c.id === 't')!, id: 't2' }];
    const out = pasteClips(t, copies, 50);
    expect(spans(out)).toEqual([
      [0, 50, 0],
      [50, 80, 0],
      [80, 100, 80],
    ]);
    expect(out.clips.find((c) => c.id === 't2')!.start).toBe(60);
  });

  it('inserts when asked, pushing later clips right by the pasted span', () => {
    const t = withClips(clip('a', 0, 40), clip('b', 40, 40));
    const out = pasteClips(t, [{ ...t.clips[0], id: 'a2' }], 40, { onlyTrack: 'v1' });
    expect(out.clips.map((c) => [c.id, c.start])).toEqual([
      ['a', 0],
      ['a2', 40],
      ['b', 80],
    ]);
  });

  it('moves pasted clips off a locked or missing track to one that takes them', () => {
    let t = withClips(clip('a', 0, 40));
    t = { ...t, tracks: t.tracks.map((x) => (x.id === 'v1' ? { ...x, locked: true } : x)) };
    const out = pasteClips(t, [{ ...clip('x', 0, 10), trackId: 'gone' }], 5);
    expect(out.clips.find((c) => c.id === 'x')!.trackId).toBe('v3');
  });

  it('turns clips off, and back on only when all of them are off', () => {
    const t = withClips(clip('a', 0, 40), clip('b', 40, 40, { disabled: true }));
    const off = toggleClipsEnabled(t, ['a', 'b']);
    expect(off.clips.map((c) => c.disabled)).toEqual([true, true]);
    expect(toggleClipsEnabled(off, ['a', 'b']).clips.map((c) => c.disabled)).toEqual([undefined, undefined]);
  });

  it('finds the previous and next clip edge or marker', () => {
    const t = { ...withClips(clip('a', 0, 40), clip('b', 60, 40, { trackId: 'v2' })), markers: [{ id: 'm', frame: 75, label: 'M' }] };
    expect(adjacentEditPoint(t, 40, 1)).toBe(60);
    expect(adjacentEditPoint(t, 61, 1)).toBe(75);
    expect(adjacentEditPoint(t, 61, -1)).toBe(60);
    expect(adjacentEditPoint(t, 100, 1)).toBeNull();
    expect(adjacentEditPoint(t, 0, -1)).toBeNull();
  });

  it('reads typed times: seconds, m:ss, the editor timecode, and relative jumps', () => {
    expect(parseTimecode('12.5', 30)).toBe(375);
    expect(parseTimecode('1:05', 30)).toBe(1950);
    expect(parseTimecode('00:12:15', 30)).toBe(375);
    expect(parseTimecode('01:00:00:00', 30)).toBe(108000);
    expect(parseTimecode('+2', 30, 100)).toBe(160);
    expect(parseTimecode('-1', 30, 10)).toBe(0);
    expect(parseTimecode('abc', 30)).toBeNull();
    expect(parseTimecode('1::2', 30)).toBeNull();
  });
});

describe('replacing media', () => {
  it('keeps the slot and the look, and plays the chosen part of the new media', () => {
    const t = withClips(clip('a', 0, 60), clip('b', 60, 90, { in: 40, fadeIn: 5, volume: 0.5, scale: 1.1, effects: [{ type: 'grain' }] } as Partial<Clip>));
    const b = replaceClipMedia(t, 'b', { id: 'new', kind: 'video', frames: 300 }, { inPoint: 120 }).clips.find((c) => c.id === 'b')!;
    expect([b.assetId, b.start, b.duration, b.in, b.fadeIn, b.volume, b.scale]).toEqual(['new', 60, 90, 120, 5, 0.5, 1.1]);
    expect(b.effects).toEqual([{ type: 'grain' }]);
    const plain = replaceClipMedia(t, 'b', { id: 'new', kind: 'video', frames: 300 }, { keepEffects: false }).clips.find((c) => c.id === 'b')!;
    expect(plain.effects).toBeUndefined();
  });

  it('refuses media shorter than the clip, but always takes an image', () => {
    const t = withClips(clip('a', 0, 60, { in: 10 }));
    expect(replaceProblem(t.clips[0], { id: 's', kind: 'video', frames: 45 })).toMatch(/shorter/);
    expect(replaceClipMedia(t, 'a', { id: 's', kind: 'video', frames: 45 })).toBe(t);
    expect(replaceClipMedia(t, 'a', { id: 's', kind: 'video', frames: 100 }, { inPoint: 50 })).toBe(t);
    const img = replaceClipMedia(t, 'a', { id: 'pic', kind: 'image', frames: Infinity }).clips[0];
    expect([img.kind, img.in, img.duration]).toEqual(['image', undefined, 60]);
    expect(canReplace(img, 'video')).toBe(true);
    expect(canReplace(img, 'audio')).toBe(false);
    expect(replaceClipMedia(t, 'a', { id: 'snd', kind: 'audio', frames: 100 })).toBe(t);
  });
});

describe('main-track magnet', () => {
  const caption = (id: string, start: number, duration: number): Clip => ({ id, kind: 'caption', trackId: 'v3', start, duration, words: [] });
  const base = () => {
    let t = emptyTimeline();
    for (const c of [clip('a', 0, 50), clip('b', 50, 30, { in: 100 }), clip('c', 80, 20, { in: 200 }), caption('ca', 0, 50), caption('cb', 50, 30), caption('cc', 80, 20)]) t = addClip(t, c);
    return t;
  };
  const order = (t: Timeline, track = 'v1') => t.clips.filter((c) => c.trackId === track).map((c) => `${c.id}@${c.start}`);

  it('finds the main track and the nearest clip edge', () => {
    const t = base();
    expect(mainTrackId(t)).toBe('v1');
    expect([boundaryNear(t, 'v1', 12), boundaryNear(t, 'v1', 70), boundaryNear(t, 'v1', 500)]).toEqual([0, 80, 100]);
  });

  it('inserts at an edge on the main track and pushes linked tracks', () => {
    const t = insertClip(base(), clip('n', 50, 10));
    expect(order(t)).toEqual(['a@0', 'n@50', 'b@60', 'c@90']);
    expect(order(t, 'v3')).toEqual(['ca@0', 'cb@60', 'cc@90']);
    // Linkage off: only the main track moves.
    expect(order(insertClip(base(), clip('n', 50, 10), 'v1'), 'v3')).toEqual(['ca@0', 'cb@50', 'cc@80']);
  });

  it('reorders a main-track clip, carrying its linked caption', () => {
    const t = moveMainClip(base(), 'a', 95);
    expect(order(t)).toEqual(['b@0', 'c@30', 'a@50']);
    expect(order(t, 'v3')).toEqual(['cb@0', 'cc@30', 'ca@50']);
    expect(t.clips.find((c) => c.id === 'a')!.in).toBe(0);
    const back = moveMainClip(base(), 'c', 3);
    expect(order(back)).toEqual(['c@0', 'a@20', 'b@70']);
    const same = base();
    expect(moveMainClip(same, 'b', 52)).toBe(same);
  });

  it('closes every gap on the main track when the magnet turns on', () => {
    let t = withClips(clip('a', 10, 20), clip('b', 50, 10));
    t = addClip(t, caption('cb', 50, 10));
    const closed = closeGaps(t, 'v1');
    expect(order(closed)).toEqual(['a@0', 'b@20']);
    expect(order(closed, 'v3')).toEqual(['cb@20']);
  });

  it('deletes left or right of the playhead, rippling when asked', () => {
    const t = base();
    expect(order(deleteSide(t, ['b'], 60, 'left', true))).toEqual(['a@0', 'b@50', 'c@70']);
    expect(deleteSide(t, ['b'], 60, 'left', true).clips.find((c) => c.id === 'b')!.in).toBe(110);
    expect(order(deleteSide(t, ['b'], 60, 'right', true))).toEqual(['a@0', 'b@50', 'c@60']);
    expect(order(deleteSide(t, ['b'], 60, 'right'))).toEqual(['a@0', 'b@50', 'c@80']);
    expect(deleteSide(t, ['b'], 50, 'left', true)).toBe(t);
  });
});

describe('speed', () => {
  const len = (n: number) => () => n;
  const one = (t: Timeline, id: string) => {
    const c = t.clips.find((x) => x.id === id)!;
    return [c.start, c.duration, c.in, c.speed];
  };

  it('moves the in-point by source frames when trimming, splitting and overwriting a fast clip', () => {
    const fast = withClips(clip('a', 0, 100, { in: 10, speed: 2 }));
    expect(spans(trimClip(fast, 'a', 'start', 20))).toEqual([[20, 100, 50]]);
    expect(spans(splitAt(fast, 30))).toEqual([
      [0, 30, 10],
      [30, 100, 70],
    ]);
    expect(spans(addClip(fast, clip('b', 40, 10, { in: 900 })))).toEqual([
      [0, 40, 10],
      [40, 50, 900],
      [50, 100, 110],
    ]);
  });

  it('clamps trims to the source at the clip speed', () => {
    // 2× from in 10 of a 210-frame source: at most 100 timeline frames.
    const fast = withClips(clip('a', 50, 40, { in: 10, speed: 2 }));
    expect(spans(trimClip(fast, 'a', 'end', 500, len(210)))).toEqual([[50, 150, 10]]);
    // Revealing earlier footage stops at the start of the source: 10 source frames = 5 timeline frames.
    expect(spans(trimClip(fast, 'a', 'start', 0))).toEqual([[45, 90, 0]]);
    expect(one(rippleTrim(fast, 'a', 'end', 500, len(210)), 'a')).toEqual([50, 100, 10, 2]);
    expect(one(rippleTrim(fast, 'a', 'start', 0), 'a')).toEqual([50, 45, 0, 2]);
    // Half speed: 10 source frames reveal 20 timeline frames.
    const slow = withClips(clip('s', 50, 40, { in: 10, speed: 0.5 }));
    expect(spans(trimClip(slow, 's', 'start', 0))).toEqual([[30, 90, 0]]);
  });

  it('scales the length and keeps the in-point', () => {
    const t = withClips(clip('a', 0, 100, { in: 30 }));
    expect(one(setSpeed(t, 'a', 2), 'a')).toEqual([0, 50, 30, 2]);
    expect(one(setSpeed(setSpeed(t, 'a', 2), 'a', 1), 'a')).toEqual([0, 100, 30, undefined]);
    expect(one(setSpeed(t, 'a', 0.5, len(1000)), 'a')).toEqual([0, 200, 30, 0.5]);
  });

  it('clamps speed to its limits and the length to the source', () => {
    const t = withClips(clip('a', 0, 100, { in: 30 }));
    expect(one(setSpeed(t, 'a', 10), 'a')).toEqual([0, 25, 30, 4]);
    expect(one(setSpeed(t, 'a', 0.01, len(10_000)), 'a')).toEqual([0, 400, 30, 0.25]);
    // The clip plays the same source frames at any speed, so a clip that already ran past
    // the end of its source (100 frames from in 30 of a 100-frame file) is cut back to fit.
    expect(one(setSpeed(t, 'a', 2, len(100)), 'a')).toEqual([0, 35, 30, 2]);
  });

  it('keeps fades inside the new length', () => {
    const t = withClips(clip('a', 0, 100, { fadeIn: 30, fadeOut: 30 }));
    const c = setSpeed(t, 'a', 4).clips[0];
    expect([c.duration, c.fadeIn, c.fadeOut]).toEqual([25, 25, 0]);
  });

  it('leaves locked tracks, stills and text alone', () => {
    const locked = updateTrack(withClips(clip('a', 0, 100)), 'v1', { locked: true });
    expect(setSpeed(locked, 'a', 2)).toBe(locked);
    const img = withClips(clip('i', 0, 100, { kind: 'image', in: undefined }));
    expect(setSpeed(img, 'i', 2)).toBe(img);
    const still = withClips(clip('f', 0, 60, { freeze: true }));
    expect(setSpeed(still, 'f', 2)).toBe(still);
  });

  it('overwrites what follows without ripple, and ripples with it', () => {
    const t = withClips(clip('a', 0, 100), clip('b', 100, 50, { in: 500 }), clip('c', 120, 20, { trackId: 'v2' }));
    // Slower without ripple: the longer clip carves into b.
    const over = setSpeed(t, 'a', 0.5);
    expect(spans(over)).toEqual([
      [0, 200, 0],
    ]);
    // With ripple (the magnet on the main track): b and the linked cutaway move right.
    const rip = setSpeed(t, 'a', 0.5, undefined, {});
    expect(spans(rip)).toEqual([
      [0, 200, 0],
      [200, 250, 500],
    ]);
    expect(spans(rip, 'v2')).toEqual([[220, 240, 0]]);
    // Faster with ripple on V1 only: b closes up, the cutaway stays.
    const fast = setSpeed(t, 'a', 2, undefined, { onlyTrack: 'v1' });
    expect(spans(fast)).toEqual([
      [0, 50, 0],
      [50, 100, 500],
    ]);
    expect(spans(fast, 'v2')).toEqual([[120, 140, 0]]);
  });

  it('maps transcript words through the clip speed', () => {
    const words = [{ text: 'hi', start: 2, end: 3 }];
    // At 30 fps, word at source frames 60–90; clip from in 30 at 2× plays them at 15–30.
    expect(clipWords(clip('a', 0, 100, { in: 30, speed: 2 }), { words }, 30)).toEqual([{ text: 'hi', start: 15, end: 30 }]);
    expect(clipWords(clip('f', 0, 100, { in: 60, freeze: true }), { words }, 30)).toEqual([]);
  });

  it('carries speed to detached sound', () => {
    const t = detachAudio(withClips(clip('a', 0, 50, { speed: 2 })), ['a']);
    expect(t.clips.find((c) => c.kind === 'audio')!.speed).toBe(2);
  });
});

describe('freeze frame', () => {
  const caption = (id: string, start: number, duration: number): Clip => ({ id, kind: 'caption', trackId: 'v3', start, duration, words: [] });
  const still = (t: Timeline) => t.clips.find((c) => c.freeze)!;

  it('inserts a still of the frame under the playhead and ripples', () => {
    const t = addClip(withClips(clip('a', 0, 100, { in: 20, scale: 1.2 }), clip('b', 100, 50)), caption('cap', 80, 20));
    const out = freezeFrame(t, 'a', 40, 60, {});
    expect(spans(out)).toEqual([
      [0, 40, 20],
      [40, 100, 60],
      [100, 160, 60],
      [160, 210, 0],
    ]);
    expect(still(out)).toMatchObject({ kind: 'video', freeze: true, muted: true, scale: 1.2, in: 60, assetId: 'a' });
    expect(spans(out, 'v3').map((x) => x[0])).toEqual([140]);
    // Linkage off: only the main track opens.
    expect(spans(freezeFrame(t, 'a', 40, 60, { onlyTrack: 'v1' }), 'v3').map((x) => x[0])).toEqual([80]);
  });

  it('takes the source frame at the clip speed', () => {
    const out = freezeFrame(withClips(clip('a', 0, 100, { in: 10, speed: 2 })), 'a', 30, 60, {});
    expect(still(out).in).toBe(70);
  });

  it('overwrites without insert', () => {
    const out = freezeFrame(withClips(clip('a', 0, 100), clip('b', 100, 50)), 'a', 70, 60);
    expect(spans(out)).toEqual([
      [0, 70, 0],
      [70, 130, 70],
      [130, 150, 30],
    ]);
  });

  it('ignores locked tracks, other kinds and a playhead outside the clip', () => {
    const t = withClips(clip('a', 0, 100), clip('i', 0, 50, { trackId: 'v2', kind: 'image', in: undefined }));
    expect(freezeFrame(t, 'a', 100, 60)).toBe(t);
    expect(freezeFrame(t, 'i', 10, 60)).toBe(t);
    const locked = updateTrack(t, 'v1', { locked: true });
    expect(freezeFrame(locked, 'a', 10, 60)).toBe(locked);
  });

  it('holds its frame through trims, splits and slips', () => {
    const t = withClips(clip('f', 0, 60, { in: 70, freeze: true, muted: true }));
    expect(spans(trimClip(t, 'f', 'start', 20))).toEqual([[20, 60, 70]]);
    expect(spans(splitAt(t, 30))).toEqual([
      [0, 30, 70],
      [30, 60, 70],
    ]);
    // A still can grow without running out of source.
    expect(spans(trimClip(t, 'f', 'end', 500, () => 100))).toEqual([[0, 500, 70]]);
    expect(spans(trimClip(t, 'f', 'start', -50))).toEqual([[0, 60, 70]]);
    expect(spans(slipClip(t, 'f', 50, () => 100))).toEqual([[0, 60, 99]]);
  });
});

describe('roll and slip', () => {
  const len = (n: number) => () => n;

  it('rolls the cut between touching clips without changing the total', () => {
    const t = withClips(clip('a', 0, 50, { in: 0 }), clip('b', 50, 50, { in: 100 }));
    const later = rollEdit(t, 'a', 'b', 60);
    expect(spans(later)).toEqual([
      [0, 60, 0],
      [60, 100, 110],
    ]);
    const earlier = rollEdit(t, 'a', 'b', 30);
    expect(spans(earlier)).toEqual([
      [0, 30, 0],
      [30, 100, 80],
    ]);
  });

  it('clamps a roll to both sources and keeps a frame on each side', () => {
    const t = withClips(clip('a', 0, 50, { in: 0 }), clip('b', 50, 50, { in: 10 }));
    // a's source ends at 55; b can reveal only 10 frames before its in-point.
    expect(spans(rollEdit(t, 'a', 'b', 90, len(55)))).toEqual([
      [0, 55, 0],
      [55, 100, 15],
    ]);
    expect(spans(rollEdit(t, 'a', 'b', 0))).toEqual([
      [0, 40, 0],
      [40, 100, 0],
    ]);
    expect(spans(rollEdit(t, 'a', 'b', 500))).toEqual([
      [0, 99, 0],
      [99, 100, 59],
    ]);
  });

  it('rolls fast clips by source frames', () => {
    const t = withClips(clip('a', 0, 50, { in: 0, speed: 2 }), clip('b', 50, 50, { in: 100, speed: 2 }));
    expect(spans(rollEdit(t, 'a', 'b', 60))).toEqual([
      [0, 60, 0],
      [60, 100, 120],
    ]);
    // a at 2× uses 2 source frames per frame: a 110-frame source holds 55 frames.
    expect(spans(rollEdit(t, 'a', 'b', 80, len(110)))[0]).toEqual([0, 55, 0]);
  });

  it('only rolls touching clips on an unlocked track', () => {
    const apart = withClips(clip('a', 0, 40), clip('b', 50, 50));
    expect(rollEdit(apart, 'a', 'b', 45)).toBe(apart);
    const locked = updateTrack(withClips(clip('a', 0, 50), clip('b', 50, 50)), 'v1', { locked: true });
    expect(rollEdit(locked, 'a', 'b', 60)).toBe(locked);
  });

  it('slips the in-point in place, clamped to the source', () => {
    const t = withClips(clip('a', 20, 50, { in: 100 }));
    expect(spans(slipClip(t, 'a', 30, len(500)))).toEqual([[20, 70, 130]]);
    expect(spans(slipClip(t, 'a', -500, len(500)))).toEqual([[20, 70, 0]]);
    expect(spans(slipClip(t, 'a', 500, len(500)))).toEqual([[20, 70, 450]]);
    // At 2× the clip uses 100 source frames, so the latest in-point is 400.
    const fast = withClips(clip('f', 20, 50, { in: 100, speed: 2 }));
    expect(spans(slipClip(fast, 'f', 500, len(500)))).toEqual([[20, 70, 400]]);
  });

  it('does not slip stills, text or locked clips', () => {
    const t = withClips(clip('i', 0, 50, { kind: 'image', in: undefined }));
    expect(slipClip(t, 'i', 10)).toBe(t);
    const locked = updateTrack(withClips(clip('a', 0, 50)), 'v1', { locked: true });
    expect(slipClip(locked, 'a', 10)).toBe(locked);
  });
});

describe('trim to the playhead', () => {
  const caption = (id: string, start: number, duration: number): Clip => ({ id, kind: 'caption', trackId: 'v3', start, duration, words: [] });
  const base = () => addClip(withClips(clip('a', 0, 50), clip('b', 50, 50, { in: 100 }), clip('o', 10, 20, { trackId: 'v2' })), caption('cb', 70, 20));

  it('trims in place without the magnet', () => {
    const t = trimToFrame(base(), ['b'], 'start', 60);
    expect(spans(t)).toEqual([
      [0, 50, 0],
      [60, 100, 110],
    ]);
    expect(spans(trimToFrame(base(), ['b'], 'end', 80))).toEqual([
      [0, 50, 0],
      [50, 80, 100],
    ]);
  });

  it('lengthens a clip to a playhead past its edge, as far as the source goes', () => {
    expect(spans(trimToFrame(base(), ['o'], 'end', 60, () => 45), 'v2')).toEqual([[10, 55, 0]]);
    expect(spans(trimToFrame(base(), ['b'], 'end', 40))).toEqual(spans(base()));
  });

  it('ripples main-track clips with the magnet, others stay in place', () => {
    const t = trimToFrame(base(), ['b', 'o'], 'start', 20, undefined, {});
    expect(spans(t, 'v2')).toEqual([[20, 30, 10]]);
    const r = trimToFrame(base(), ['b'], 'start', 60, undefined, {});
    expect(spans(r)).toEqual([
      [0, 50, 0],
      [50, 90, 110],
    ]);
    // Linked: the caption pulled left with the closed range.
    expect(spans(r, 'v3').map((x) => x[0])).toEqual([60]);
    const locked = updateTrack(base(), 'v1', { locked: true });
    expect(trimToFrame(locked, ['b'], 'start', 60, undefined, {})).toBe(locked);
  });
});

describe('copy and paste attributes', () => {
  const look = clip('src', 0, 50, {
    speed: 2,
    volume: 0.5,
    scale: 1.3,
    opacity: 0.8,
    fit: 'cover',
    transition: { type: 'fade', duration: 10 },
    effects: [
      { type: 'grade', preset: 'warm' },
      { type: 'grain', amount: 0.3 },
    ],
  });

  it('copies the look with defaults filled in', () => {
    expect(clipAttributes(look)).toMatchObject({ speed: 2, volume: 0.5, scale: 1.3, opacity: 0.8, rotation: 0, offsetX: 0, fit: 'cover' });
    expect(clipAttributes(clip('s', 0, 10, { kind: 'audio', trackId: 'a1' }))).toEqual({ speed: 1, volume: 1 });
  });

  it('pastes onto every selected clip, replacing effects of the same type', () => {
    let t = withClips(look, clip('a', 100, 100, { effects: [{ type: 'grade', preset: 'cool' }, { type: 'blur', amount: 0.2 }] }), clip('s', 0, 60, { kind: 'audio', trackId: 'a1' }));
    t = addClip(t, { id: 'txt', kind: 'text', trackId: 'v2', start: 0, duration: 30, text: { text: 'x', fontSize: 50, color: '#fff', background: 'transparent', fontWeight: 700, x: 0.5, y: 0.5 } });
    const out = pasteAttributes(t, ['a', 's', 'txt'], clipAttributes(look));
    const a = out.clips.find((c) => c.id === 'a')!;
    expect(a.effects).toEqual([{ type: 'grade', preset: 'warm' }, { type: 'blur', amount: 0.2 }, { type: 'grain', amount: 0.3 }]);
    expect([a.speed, a.duration, a.volume, a.scale, a.fit, a.transition?.type]).toEqual([2, 50, 0.5, 1.3, 'cover', 'fade']);
    const s = out.clips.find((c) => c.id === 's')!;
    expect([s.speed, s.duration, s.volume, s.scale, s.effects]).toEqual([2, 30, 0.5, undefined, undefined]);
    const txt = out.clips.find((c) => c.id === 'txt')!;
    expect([txt.scale, txt.opacity, txt.speed, txt.effects, txt.fit]).toEqual([1.3, 0.8, undefined, undefined, undefined]);
  });

  it('ripples a main-track speed change with the magnet and skips locked tracks', () => {
    const t = withClips(clip('a', 0, 100), clip('b', 100, 50), clip('o', 0, 40, { trackId: 'v2' }));
    const out = pasteAttributes(t, ['a'], { speed: 2 }, undefined, {});
    expect(spans(out)).toEqual([
      [0, 50, 0],
      [50, 100, 0],
    ]);
    // Off the main track a speed change never ripples.
    expect(spans(pasteAttributes(t, ['o'], { speed: 2 }, undefined, {}), 'v2')).toEqual([[0, 20, 0]]);
    const locked = updateTrack(t, 'v1', { locked: true });
    expect(pasteAttributes(locked, ['a'], { speed: 2 })).toEqual(locked);
  });
});

describe('track headers', () => {
  it('renames a track and keeps its colour', () => {
    const t = renameTrack(emptyTimeline(), 'v2', '  B-roll  ');
    const v2 = t.tracks.find((x) => x.id === 'v2')!;
    expect(v2.name).toBe('B-roll');
    expect(v2.color).toBe(trackColor({ id: 'v2', kind: 'video', name: 'V2' }));
    const same = emptyTimeline();
    expect(renameTrack(same, 'v2', '   ')).toBe(same);
  });

  it('reorders tracks within their kind; the bottom video track is main', () => {
    const t = reorderTrack(emptyTimeline(), 'v3', 2);
    expect(t.tracks.map((x) => x.id)).toEqual(['v2', 'v1', 'v3', 'a1', 'a2', 'a3', 'a4']);
    expect(mainTrackId(t)).toBe('v3');
    expect(reorderTrack(emptyTimeline(), 'a4', 0).tracks.map((x) => x.id)).toEqual(['v3', 'v2', 'v1', 'a4', 'a1', 'a2', 'a3']);
    // Indexes clamp within the kind: audio never moves above video.
    expect(reorderTrack(emptyTimeline(), 'a2', -5).tracks.map((x) => x.id)).toEqual(['v3', 'v2', 'v1', 'a2', 'a1', 'a3', 'a4']);
    const locked = updateTrack(emptyTimeline(), 'v1', { locked: true });
    expect(reorderTrack(locked, 'v1', 0)).toBe(locked);
  });
});

describe('text-based cuts', () => {
  const twoTracks = () => {
    let t = withClips(clip('a', 0, 300));
    t = addClip(t, { id: 'cap', kind: 'caption', trackId: 'v2', start: 0, duration: 300, words: [{ text: 'hi', start: 10, end: 20 }, { text: 'there', start: 120, end: 140 }] });
    return t;
  };

  it('cutRange removes the frames from every unlocked track and closes the gap', () => {
    const t = cutRange(twoTracks(), 100, 150);
    expect(spans(t)).toEqual([
      [0, 100, 0],
      [100, 250, 150],
    ]);
    const caps = t.clips.filter((c) => c.trackId === 'v2');
    expect(caps.map((c) => [c.start, c.duration])).toEqual([
      [0, 100],
      [100, 150],
    ]);
    // "there" (120–140) was inside the cut, so it is gone.
    expect(caps.flatMap((c) => c.words?.map((w) => w.text) ?? [])).toEqual(['hi']);
  });

  it('cutRange leaves locked tracks alone', () => {
    const base = updateTrack(twoTracks(), 'v2', { locked: true });
    const t = cutRange(base, 100, 150);
    expect(t.clips.filter((c) => c.trackId === 'v2').map((c) => [c.start, c.duration])).toEqual([[0, 300]]);
  });

  it('cutRanges merges overlapping ranges and cuts them in one edit', () => {
    const t = cutRanges(withClips(clip('a', 0, 300)), [
      [200, 250],
      [10, 20],
      [15, 30],
    ]);
    expect(spans(t)).toEqual([
      [0, 10, 0],
      [10, 180, 30],
      [180, 230, 250],
    ]);
  });

  it('cutRanges ignores empty ranges', () => {
    const t = withClips(clip('a', 0, 100));
    expect(cutRanges(t, [[50, 50]])).toBe(t);
  });

  it('restoreSourceGap undoes a cut on the media, even after later edits', () => {
    let t = cutRange(withClips(clip('a', 0, 300), clip('b', 300, 100, { in: 1000 })), 100, 150);
    t = cutRange(t, 300, 320);
    const left = t.clips.find((c) => c.start === 0)!;
    t = restoreSourceGap(t, 100, 50, [left.id]);
    expect(spans(t)).toEqual([
      [0, 150, 0],
      [150, 300, 150],
      [300, 350, 1000],
      [350, 380, 1070],
    ]);
  });

  it('restoreSourceGap needs a clip ending at the cut', () => {
    const t = withClips(clip('a', 0, 100));
    expect(restoreSourceGap(t, 50, 10, ['a'])).toBe(t);
  });
});

describe('in/out ranges', () => {
  // V1: a [0,100) and b [100,200); V2: an overlay o [50,150); A1: music [0,200); a caption on V3.
  const base = () => {
    let t = withClips(
      clip('a', 0, 100, { fadeOut: 10 }),
      clip('b', 100, 100, { in: 300, fadeIn: 10 }),
      clip('o', 50, 100, { trackId: 'v2', kind: 'image', in: undefined }),
      clip('music', 0, 200, { trackId: 'a1', kind: 'audio' }),
    );
    t = addClip(t, {
      id: 'cap',
      kind: 'caption',
      trackId: 'v3',
      start: 60,
      duration: 80,
      words: [
        { text: 'before', start: 0, end: 20 },
        { text: 'inside', start: 30, end: 50 },
        { text: 'after', start: 60, end: 80 },
      ],
    });
    return { ...t, markers: [{ id: 'm1', frame: 95, label: 'inside' }, { id: 'm2', frame: 160, label: 'after' }] };
  };
  const words = (t: Timeline) => t.clips.filter((c) => c.kind === 'caption').map((c) => [c.start, c.duration, c.words!.map((w) => [w.text, w.start, w.end])]);

  it('lift removes the range from every unlocked track and leaves a gap', () => {
    const t = liftRange(base(), 80, 120);
    expect(spans(t)).toEqual([
      [0, 80, 0],
      [120, 200, 320],
    ]);
    expect(spans(t, 'v2').map(([s, e]) => [s, e])).toEqual([
      [50, 80],
      [120, 150],
    ]);
    expect(spans(t, 'a1')).toEqual([
      [0, 80, 0],
      [120, 200, 120],
    ]);
    // Cut edges become hard cuts: no fade into or out of the gap.
    expect(t.clips.find((c) => c.id === 'a')!.fadeOut).toBe(0);
    // Markers keep their place.
    expect(t.markers.map((m) => m.frame)).toEqual([95, 160]);
  });

  it('keeps caption words in step when lifting and extracting', () => {
    // Caption [60,140): "inside" is spoken at 90–110, entirely in the range.
    expect(words(liftRange(base(), 80, 120))).toEqual([
      [60, 20, [['before', 0, 20]]],
      [120, 20, [['after', 0, 20]]],
    ]);
    expect(words(extractRange(base(), 80, 120))).toEqual([
      [60, 20, [['before', 0, 20]]],
      [80, 20, [['after', 0, 20]]],
    ]);
  });

  it('extract closes the gap and ripples clips and markers', () => {
    const t = extractRange(base(), 80, 120);
    expect(spans(t)).toEqual([
      [0, 80, 0],
      [80, 160, 320],
    ]);
    expect(spans(t, 'a1')).toEqual([
      [0, 80, 0],
      [80, 160, 120],
    ]);
    expect(t.markers).toEqual([{ id: 'm2', frame: 120, label: 'after' }]);
  });

  it('leaves locked tracks alone', () => {
    const locked = updateTrack(base(), 'a1', { locked: true });
    const lifted = liftRange(locked, 80, 120);
    expect(spans(lifted, 'a1')).toEqual([[0, 200, 0]]);
    const extracted = extractRange(locked, 80, 120);
    expect(spans(extracted, 'a1')).toEqual([[0, 200, 0]]);
    expect(spans(extracted)).toEqual([
      [0, 80, 0],
      [80, 160, 320],
    ]);
    const allLocked = { ...base(), tracks: base().tracks.map((x) => ({ ...x, locked: true })) };
    expect(liftRange(allLocked, 80, 120)).toEqual(allLocked);
    expect(extractRange(allLocked, 80, 120)).toBe(allLocked);
  });

  it('ignores empty ranges and clamps before zero', () => {
    const t = base();
    expect(liftRange(t, 50, 50)).toBe(t);
    expect(extractRange(t, 60, 40)).toBe(t);
    expect(spans(extractRange(t, -20, 10))).toEqual([
      [0, 90, 10],
      [90, 190, 300],
    ]);
  });
});

describe('markers', () => {
  const t0 = () => withClips(clip('a', 0, 3000));

  it('adds point and range markers in time order with default labels', () => {
    let t = addMarker(t0(), { frame: 90, id: 'b' });
    t = addMarker(t, { frame: 30.4, id: 'a', label: '  Hook  ', color: '#5a7fc0', duration: 60 });
    expect(t.markers).toEqual([
      { id: 'a', frame: 30, label: 'Hook', color: '#5a7fc0', duration: 60 },
      { id: 'b', frame: 90, label: 'Marker 1' },
    ]);
    // Unknown colours and empty lengths are dropped; frames clamp at zero.
    expect(addMarker(t0(), { frame: -5, id: 'c', color: 'hotpink', duration: 0 }).markers).toEqual([{ id: 'c', frame: 0, label: 'Marker 1' }]);
  });

  it('renames, recolours, resizes and removes', () => {
    const t = addMarker(t0(), { frame: 10, id: 'm', label: 'One' });
    let u = updateMarker(t, 'm', { label: 'Two', color: '#d0533f', duration: 45 });
    expect(u.markers[0]).toEqual({ id: 'm', frame: 10, label: 'Two', color: '#d0533f', duration: 45 });
    // An empty label is ignored; null clears the colour; a zero duration makes it a point again.
    u = updateMarker(u, 'm', { label: '   ', color: null, duration: 0 });
    expect(u.markers[0]).toEqual({ id: 'm', frame: 10, label: 'Two' });
    expect(updateMarker(t, 'm', { label: 'One' })).toBe(t);
    expect(updateMarker(t, 'nope', { label: 'x' })).toBe(t);
    expect(removeMarker(u, 'm').markers).toEqual([]);
    expect(removeMarker(u, 'nope')).toBe(u);
  });

  it('moves a marker, keeping order and a range marker\'s length', () => {
    let t = addMarker(addMarker(t0(), { frame: 10, id: 'a' }), { frame: 50, id: 'b', duration: 20 });
    t = moveMarker(t, 'b', 5.6);
    expect(t.markers.map((m) => [m.id, m.frame, m.duration])).toEqual([
      ['b', 6, 20],
      ['a', 10, undefined],
    ]);
    expect(moveMarker(t, 'a', -40).markers.find((m) => m.id === 'a')!.frame).toBe(0);
    expect(moveMarker(t, 'a', 10)).toBe(t);
  });

  it('ripple: markers follow main-track ripples but not single-track ones elsewhere', () => {
    let t = withClips(clip('a', 0, 100), clip('b', 100, 100), clip('o', 0, 200, { trackId: 'v2' }));
    t = { ...t, markers: [{ id: 'p', frame: 150, label: 'P' }, { id: 'r', frame: 50, label: 'R', duration: 100 }] };
    // Closing [80,120) on the main track alone (magnet on, linkage off) still moves markers.
    const main = closeRange(t, 80, 120, 'v1');
    expect(main.markers.map((m) => [m.id, m.frame, m.duration])).toEqual([
      ['p', 110, undefined],
      ['r', 50, 60],
    ]);
    // A range marker that starts inside the removed span begins where it was cut.
    expect(closeRange(t, 40, 60).markers.find((m) => m.id === 'r')).toMatchObject({ frame: 40, duration: 90 });
    // Closing on another track leaves markers alone.
    expect(closeRange(t, 80, 120, 'v2').markers).toEqual(t.markers);
    // Opening room before a marker pushes it; a range marker spanning the point grows.
    const opened = openRange(t, 100, 30, undefined, 'v1');
    expect(opened.markers.map((m) => [m.id, m.frame, m.duration])).toEqual([
      ['p', 180, undefined],
      ['r', 50, 130],
    ]);
    expect(openRange(t, 100, 30, undefined, 'v2').markers).toEqual(t.markers);
    // Ripple trimming on the main track moves markers the same way as the clips after it.
    const trimmed = rippleTrim(t, 'a', 'end', 90, undefined, 'v1');
    expect(trimmed.clips.find((c) => c.id === 'b')!.start).toBe(90);
    expect(trimmed.markers.find((m) => m.id === 'p')!.frame).toBe(140);
  });

  it('snaps to range marker ends', () => {
    const t = { ...t0(), markers: [{ id: 'r', frame: 100, label: 'R', duration: 50 }] };
    expect(snapPoints(t)).toEqual(expect.arrayContaining([100, 150]));
  });

  it('crops range markers to a kept range', () => {
    const t = { ...t0(), markers: [{ id: 'r', frame: 100, label: 'R', duration: 100 }, { id: 'p', frame: 10, label: 'P' }] };
    expect(cropRange(t, 150, 400).markers).toEqual([{ id: 'r', frame: 0, label: 'R', duration: 50 }]);
  });
});

describe('chapters from markers', () => {
  const fps = 30;
  const at = (sec: number, label: string, extra: Partial<Marker> = {}): Marker => ({ id: label, frame: sec * fps, label, ...extra });
  const tl = (markers: Marker[], seconds = 600) => ({ ...withClips(clip('a', 0, seconds * fps)), markers });

  it('lists point markers as 0:00 lines and adds an intro at 0:00', () => {
    const c = chaptersFromMarkers(tl([at(75, 'Setup'), at(30, 'Hook'), at(3725, 'Late')], 4000));
    expect(c.text).toBe('0:00 Intro\n0:30 Hook\n1:15 Setup\n1:02:05 Late');
    expect(c.skipped).toEqual([]);
    expect(c.tooFew).toBe(false);
  });

  it('moves an early marker to 0:00 instead of adding an intro', () => {
    const c = chaptersFromMarkers(tl([at(4, 'Cold open'), at(40, 'Main')]));
    expect(c.text).toBe('0:00 Cold open\n0:40 Main');
    expect(c.tooFew).toBe(true);
  });

  it('skips markers closer than 10 s to the chapter before or to the end, and ignores range markers', () => {
    const c = chaptersFromMarkers(
      tl([at(20, 'A'), at(25, 'Too soon'), at(30, 'B'), at(45, 'Range', { duration: 300 }), at(595, 'Tail')]),
    );
    expect(c.chapters.map((x) => x.label)).toEqual(['Intro', 'A', 'B']);
    expect(c.skipped.map((x) => x.label)).toEqual(['Too soon', 'Tail']);
  });

  it('gives nothing without point markers', () => {
    expect(chaptersFromMarkers(tl([])).text).toBe('');
    expect(chapterTime(59 * fps + 29, fps)).toBe('0:59');
  });
});

describe('render ranges', () => {
  it('checks a range against the timeline', () => {
    expect(renderRange(undefined, 300)).toBeNull();
    expect(renderRange({ start: 0, end: 300 }, 300)).toBeNull();
    expect(renderRange({ start: 30.2, end: 90.7 }, 300)).toEqual({ start: 30, end: 91 });
    expect(renderRange({ start: -10, end: 900 }, 300)).toBeNull();
    expect(renderRange({ start: 100 }, 300)).toEqual({ start: 100, end: 300 });
    expect(() => renderRange({ start: 200, end: 100 }, 300)).toThrow(/empty/);
    expect(() => renderRange({ start: 'x' }, 300)).toThrow();
    expect(() => renderRange('0-10', 300)).toThrow();
  });

  it('makes a still one frame long', () => {
    expect(renderRange({ start: 42 }, 300, true)).toEqual({ start: 42, end: 43 });
    expect(renderRange(null, 300, true)).toEqual({ start: 0, end: 1 });
    expect(() => renderRange({ start: 300 }, 300, true)).toThrow(/past the end/);
  });

  it('names outputs by preset and keeps stills off watch pages', () => {
    expect([renderExt('mp4-720p'), renderExt('audio-mp3'), renderExt('still-png')]).toEqual(['mp4', 'mp3', 'png']);
    expect(renderMime('still-png')).toBe('image/png');
  });
});
