import { describe, expect, it } from 'vitest';
import { addClip, addTrack, adjacentEditPoint, cutRange, cutRanges, restoreSourceGap, updateTrack, boundaryNear, canReplace, clipsFrom, closeGaps, closeRange, cropRange, deleteClips, deleteSide, deriveTimeline, detachAudio, gapAt, insertClip, mainTrackId, moveClip, moveClips, moveMainClip, pasteClips, replaceClipMedia, replaceProblem, rippleDeleteClips, rippleTrim, setFade, setVolume, MAX_VOLUME, splitAt, toggleClipsEnabled, trimClip } from '../src/shared/edits';
import { type Clip, type PublishedVideo, TRACK_LIMITS, type Timeline, aspectLabel, emptyTimeline, framing, parseTimecode, pickVersions, withSolo } from '../src/shared/project';

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

describe('replacing media (CapCut rules)', () => {
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
