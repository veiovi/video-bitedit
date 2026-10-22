import { describe, expect, it } from 'vitest';
import { correctionMatrix, solveAutoColor } from '../src/shared/autocolor';
import { gradeMatrix, hash01 } from '../src/shared/effects';
import { enterTransition, exitTransition } from '../src/remotion/effects';
import { buildFromCutList } from '../src/node/cut';
import type { LocalAsset } from '../src/node/local-project';

describe('auto colour', () => {
  it('lifts dim, blue-tinted footage and warms it back toward neutral', () => {
    const px: number[] = [];
    for (let i = 0; i < 2000; i++) px.push(20 + (i % 90), 25 + (i % 95), 60 + (i % 110));
    const c = solveAutoColor(px, 3, 1);
    expect(c.gains.every((g) => g > 1)).toBe(true);
    expect(c.gains[0]).toBeGreaterThan(c.gains[2]);
    expect(correctionMatrix(c).split(' ')).toHaveLength(20);
  });

  it('leaves well-exposed neutral footage nearly alone', () => {
    const px: number[] = [];
    for (let v = 0; v < 256; v++) px.push(v, v, v);
    const c = solveAutoColor(px, 3);
    for (const g of c.gains) expect(Math.abs(g - 1)).toBeLessThan(0.05);
  });
});

describe('effects and transitions', () => {
  it('blends grades toward identity', () => {
    expect(gradeMatrix('mono', 0)).toBe('1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0');
    expect(gradeMatrix('mono', 1)).not.toBe(gradeMatrix('mono', 0));
  });

  it('is deterministic per seed and frame', () => {
    expect(hash01(3, 10)).toBe(hash01(3, 10));
    expect(hash01(3, 10)).not.toBe(hash01(3, 11));
  });

  it('crossfades in and the tail fades out', () => {
    const t = { type: 'fade' as const, duration: 10 };
    expect(enterTransition(t, 0).opacity).toBe(0);
    expect(enterTransition(t, 10).opacity).toBe(1);
    expect(exitTransition(t, 10).gain).toBe(0);
  });

  it('dips: hides the incoming clip until halfway, peaking the colour in the middle', () => {
    const t = { type: 'dipBlack' as const, duration: 10 };
    expect(enterTransition(t, 2).opacity).toBe(0);
    expect(enterTransition(t, 5).flash?.opacity).toBe(1);
    expect(enterTransition(t, 8).opacity).toBe(1);
  });

  it('cut lists convert transition seconds to frames and keep effects', () => {
    const asset: LocalAsset = {
      id: 'aaaaaaaa', path: 'a.mp4', name: 'a.mp4', kind: 'video', mime: '', size: 1, duration: 10,
      width: 1920, height: 1080, hasThumb: false, status: 'ready', createdAt: 0,
    };
    const doc = buildFromCutList(
      { clips: [{ asset: 'a', out: 2 }, { asset: 'a', in: 2, out: 4, transition: { type: 'whip', duration: 0.4 }, effects: [{ type: 'grain', amount: 0.3 }] }] },
      [asset],
    );
    const second = doc.timelines[0].clips[1];
    expect(second.transition).toEqual({ type: 'whip', duration: 12 });
    expect(second.effects).toEqual([{ type: 'grain', amount: 0.3 }]);
  });
});
