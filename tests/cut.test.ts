import { describe, expect, it } from 'vitest';
import { LEVELS_PER_SECOND, assetsToSnap, autoAssemble, buildFromCutList, originalFrame, snapToQuiet } from '../src/node/cut';
import type { LocalAsset } from '../src/node/local-project';

function asset(id: string, path: string, kind: LocalAsset['kind'], duration: number | null): LocalAsset {
  return {
    id,
    path,
    kind,
    name: path.split('/').pop()!,
    mime: '',
    size: 1,
    duration,
    width: kind === 'audio' ? null : 1920,
    height: kind === 'audio' ? null : 1080,
    hasThumb: false,
    status: 'ready',
    createdAt: 0,
  };
}

const assets = [
  asset('aaaaaaaa', 'clips/intro.mp4', 'video', 10),
  asset('bbbbbbbb', 'clips/b-roll.mov', 'video', 20),
  asset('cccccccc', 'music.mp3', 'audio', 60),
  asset('dddddddd', 'logo.png', 'image', null),
];

describe('cut lists', () => {
  it('converts seconds to frames and resolves assets by name', () => {
    const doc = buildFromCutList(
      {
        title: 'Trip',
        clips: [
          { asset: 'intro', in: 2, out: 6 },
          { asset: 'b-roll.mov', in: 1, duration: 3, volume: 0.5 },
          { asset: 'music.mp3', track: 'A2', at: 0, volume: 0.3, fadeOut: 1 },
          { text: 'Hello', track: 'V2', at: 0.5, duration: 2 },
        ],
      },
      assets,
    );
    const main = doc.timelines[0];
    expect(main.name).toBe('Main');
    const v1 = main.clips.filter((c) => c.trackId === main.tracks.find((t) => t.name === 'V1')!.id);
    expect(v1.map((c) => [c.start, c.duration, c.in])).toEqual([
      [0, 120, 60],
      [120, 90, 30],
    ]);
    const music = main.clips.find((c) => c.kind === 'audio')!;
    expect([music.duration, music.volume, music.fadeOut]).toEqual([1800, 0.3, 30]);
    expect(main.clips.find((c) => c.kind === 'text')!.start).toBe(15);
  });

  it('splits a video\'s sound onto an audio track and mutes the picture', () => {
    const doc = buildFromCutList(
      {
        clips: [
          { asset: 'intro', in: 2, out: 6, muted: true },
          { asset: 'intro', track: 'A1', at: 0, in: 2, out: 6, fadeOut: 1 },
        ],
      },
      assets,
    );
    const [picture, sound] = ['video', 'audio'].map((k) => doc.timelines[0].clips.find((c) => c.kind === k)!);
    expect([picture.muted, picture.in, picture.duration]).toEqual([true, 60, 120]);
    expect([sound.assetId, sound.in, sound.duration, sound.fadeOut, sound.muted]).toEqual(['aaaaaaaa', 60, 120, 30, undefined]);
  });

  it('plays clips at a speed, keeping in and out in source seconds', () => {
    const doc = buildFromCutList(
      {
        clips: [
          { asset: 'intro', in: 2, out: 6, speed: 2 },
          { asset: 'b-roll.mov', in: 1, duration: 3, speed: 0.5 },
          { asset: 'logo.png', duration: 2, speed: 2 },
        ],
      },
      assets,
    );
    const clips = doc.timelines[0].clips;
    expect(clips.map((c) => [c.start, c.duration, c.in, c.speed])).toEqual([
      [0, 60, 60, 2],
      [60, 90, 30, 0.5],
      [150, 60, undefined, undefined],
    ]);
  });

  it('clamps to the source length', () => {
    const doc = buildFromCutList({ clips: [{ asset: 'intro', in: 8, duration: 30 }] }, assets);
    expect(doc.timelines[0].clips[0].duration).toBe(60);
  });

  it('builds a main cut and a short from a range of it', () => {
    const doc = buildFromCutList(
      {
        timelines: [
          { name: 'Main', clips: [{ asset: 'intro' }, { asset: 'b-roll' }] },
          { name: 'Short', from: 'Main', format: 'vertical', range: [5, 20], offsetX: 0.1 },
        ],
      },
      assets,
    );
    const short = doc.timelines[1];
    expect([short.width, short.height]).toEqual([1080, 1920]);
    expect(short.clips.map((c) => [c.start, c.duration, c.fit, c.offsetX])).toEqual([
      [0, 150, 'cover', 0.1],
      [150, 300, 'cover', 0.1],
    ]);
  });

  it('reports unknown assets and tracks clearly', () => {
    expect(() => buildFromCutList({ clips: [{ asset: 'nope' }] }, assets)).toThrow(/clip 1: no asset matches "nope"/);
    expect(() => buildFromCutList({ clips: [{ asset: 'intro', track: 'V9' }] }, assets)).toThrow(/no track "V9"/);
  });

  it('auto-assembles videos and images on V1 and audio on A1', () => {
    const doc = buildFromCutList(autoAssemble(assets, 'Auto'), assets);
    const main = doc.timelines[0];
    const onTrack = (name: string) => main.clips.filter((c) => c.trackId === main.tracks.find((t) => t.name === name)!.id);
    expect(onTrack('V1').map((c) => [c.kind, c.start])).toEqual([
      ['video', 0],
      ['video', 600],
      ['image', 900],
    ]);
    expect(onTrack('A1').map((c) => c.kind)).toEqual(['audio']);
  });
});

describe('cut list captions', () => {
  const transcripts = {
    aaaaaaaa: {
      words: [
        { text: 'Welcome', start: 2.1, end: 2.5 },
        { text: 'to', start: 2.55, end: 2.7 },
        { text: 'the', start: 2.75, end: 2.9 },
        { text: 'trip.', start: 2.95, end: 3.4 },
        { text: 'Cut', start: 7, end: 7.4 },
      ],
    },
  };
  const captionsOf = (t: { clips: { kind: string; trackId: string; start: number; duration: number; words?: { text: string; start: number }[] }[] }) =>
    t.clips.filter((c) => c.kind === 'caption').map((c) => [c.trackId, c.start, c.duration, c.words!.map((w) => [w.text, w.start])]);

  it('captions the clips used, on the requested track, in clip-relative frames', () => {
    const doc = buildFromCutList(
      { theme: 'bold', timelines: [{ name: 'Main', clips: [{ asset: 'intro', in: 2, out: 6 }], captions: { track: 'V2' } }] },
      assets,
      undefined,
      { transcripts },
    );
    const main = doc.timelines[0];
    const v2 = main.tracks.find((t) => t.name === 'V2')!.id;
    expect(captionsOf(main)).toEqual([[v2, 0, 120, [['Welcome', 3], ['to', 17], ['the', 23], ['trip.', 29]]]]);
    const style = main.clips.find((c) => c.kind === 'caption')!.text!;
    expect([style.fontFamily, style.color, style.highlight, style.preset]).toEqual([undefined, '#111111', '#e8261c', 'caption']);
  });

  it('defaults to the top video track and regenerates captions for a derived short', () => {
    const doc = buildFromCutList(
      {
        timelines: [
          { name: 'Main', clips: [{ asset: 'intro' }], captions: 'auto' },
          { name: 'Short', from: 'Main', format: 'vertical', range: [2.5, 8], captions: 'auto' },
        ],
      },
      assets,
      undefined,
      { transcripts },
    );
    const [main, short] = doc.timelines;
    expect(captionsOf(main)).toEqual([[main.tracks[0].id, 0, 300, [['Welcome', 63], ['to', 77], ['the', 83], ['trip.', 89], ['Cut', 210]]]]);
    // The short starts at 2.5 s: "Welcome" (centred before the range) is dropped and the rest shift.
    expect(captionsOf(short)).toEqual([[short.tracks[0].id, 0, 165, [['to', 2], ['the', 8], ['trip.', 14], ['Cut', 135]]]]);
    const style = short.clips.find((c) => c.kind === 'caption')!.text!;
    expect([style.y, style.fontSize]).toEqual([0.7, 78]);
  });

  it('asks for transcripts when there are none', () => {
    expect(() => buildFromCutList({ clips: [{ asset: 'intro' }], captions: 'auto' }, assets)).toThrow(/videdit transcribe/);
  });
});

describe('snapping cuts to silence', () => {
  // Loud everywhere except two quiet 10 ms buckets, at 2.03 s and 5.93 s.
  const levels = Array.from({ length: 10 * LEVELS_PER_SECOND }, (_, i) => (i === 203 || i === 593 ? 3 : 200));

  it('moves a cut to the frame boundary in the quietest 10 ms within 80 ms', () => {
    expect(snapToQuiet(2, levels, 30)).toBe(61);
    expect(snapToQuiet(6, levels, 30)).toBe(178);
    // Nothing quieter nearby: the cut stays put.
    expect(snapToQuiet(4, levels, 30)).toBe(120);
    expect(snapToQuiet(4, undefined, 30)).toBe(120);
  });

  it('snaps in and out points of clips that ask for it', () => {
    const list = { snap: true, clips: [{ asset: 'intro', in: 2, out: 6 }, { asset: 'b-roll', in: 1, out: 2, snap: false }] };
    expect(assetsToSnap(list, assets).map((a) => a.id)).toEqual(['aaaaaaaa']);
    const doc = buildFromCutList(list, assets, undefined, { levels: { aaaaaaaa: levels } });
    expect(doc.timelines[0].clips.map((c) => [c.start, c.duration, c.in])).toEqual([
      [0, 117, 61],
      [117, 30, 30],
    ]);
  });
});

describe('original dimensions', () => {
  const phone = (id: string, w: number, h: number, duration: number) => ({ ...asset(id, `${id}.mov`, 'video', duration), width: w, height: h });
  const footage = [phone('portrait1', 1080, 1920, 8), phone('portrait2', 1080, 1920, 8), phone('wide', 3840, 2160, 12)];

  it('uses the frame size that fills the most time, scaled to fit 1080p', () => {
    expect(originalFrame([{ asset: 'portrait1' }, { asset: 'portrait2' }, { asset: 'wide' }], footage)).toEqual({ width: 1080, height: 1920 });
    expect(originalFrame([{ asset: 'portrait1', duration: 2 }, { asset: 'wide' }], footage)).toEqual({ width: 1920, height: 1080 });
    expect(originalFrame([{ text: 'Hi' }], footage)).toEqual({ width: 1920, height: 1080 });
    expect(originalFrame([{ asset: 'photo' }], [{ ...asset('photo', 'photo.jpg', 'image', null), width: 4032, height: 3024 }])).toEqual({ width: 1440, height: 1080 });
  });

  it('builds a timeline without a format at the footage size, and its short in portrait', () => {
    const doc = buildFromCutList(
      { timelines: [{ name: 'Main', clips: [{ asset: 'portrait1' }, { asset: 'wide', duration: 3 }] }, { name: 'Short', from: 'Main' }] },
      footage,
    );
    const [main, short] = doc.timelines;
    expect([main.width, main.height]).toEqual([1080, 1920]);
    // In a portrait frame, the landscape clip is cropped to fill.
    expect(main.clips.map((c) => c.fit)).toEqual(['cover', 'cover']);
    expect([short.width, short.height]).toEqual([1080, 1920]);
  });
});

describe('slides in cut lists', () => {
  it('builds slide clips and resolves their image', () => {
    const doc = buildFromCutList(
      { clips: [{ slide: { layout: 'split', title: 'Hello', bullets: ['a'], image: 'logo' }, duration: 4 }] },
      assets,
    );
    const c = doc.timelines[0].clips[0];
    expect(c.kind).toBe('slide');
    expect(c.duration).toBe(120);
    expect(c.slide).toMatchObject({ layout: 'split', title: 'Hello', imageAssetId: 'dddddddd' });
  });
});
