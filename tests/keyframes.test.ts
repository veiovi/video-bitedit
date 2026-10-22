import { describe, expect, it } from 'vitest';
import { adjacentKey, animatableProps, clipAt, cropKeys, curveAt, easeProgress, retimeKeyframes, shiftKeyframes, validKeyframes, valueAt } from '../src/shared/keyframes';
import type { Clip } from '../src/shared/project';

const clip = (extra: Partial<Clip> = {}): Clip => ({ id: 'a', kind: 'video', trackId: 'v1', start: 0, duration: 100, assetId: 'x', in: 0, ...extra });

describe('valueAt', () => {
  it('returns the static value, or the default, without keys', () => {
    expect(valueAt(clip({ opacity: 0.4 }), 'opacity', 10)).toBe(0.4);
    expect(valueAt(clip(), 'scale', 10)).toBe(1);
    expect(valueAt(clip(), 'offsetX', 10)).toBe(0);
  });

  it('holds the first value before the first key and the last after the last', () => {
    const c = clip({ opacity: 0.1, keyframes: { opacity: [{ frame: 20, value: 0.2 }, { frame: 40, value: 0.8 }] } });
    expect(valueAt(c, 'opacity', 0)).toBe(0.2);
    expect(valueAt(c, 'opacity', 99)).toBe(0.8);
  });

  it('interpolates linearly by default and ignores the static value', () => {
    const c = clip({ scale: 3, keyframes: { scale: [{ frame: 0, value: 1 }, { frame: 10, value: 2 }] } });
    expect(valueAt(c, 'scale', 5)).toBe(1.5);
    expect(valueAt(c, 'scale', 2.5)).toBe(1.25);
  });

  it('follows the ease of the key that starts each span', () => {
    const keys = (ease: 'hold' | 'easeIn' | 'easeOut' | 'easeInOut') => [
      { frame: 0, value: 0, ease },
      { frame: 10, value: 1 },
      { frame: 20, value: 0 },
    ];
    expect(curveAt(keys('hold'), 9, 5)).toBe(0);
    expect(curveAt(keys('hold'), 10, 5)).toBe(1);
    expect(curveAt(keys('easeIn'), 5, 5)).toBeCloseTo(0.125);
    expect(curveAt(keys('easeOut'), 5, 5)).toBeCloseTo(0.875);
    expect(curveAt(keys('easeInOut'), 5, 5)).toBeCloseTo(0.5);
    expect(curveAt(keys('easeInOut'), 2, 5)).toBeCloseTo(0.032);
    // The second span is linear: its key has no ease.
    expect(curveAt(keys('easeIn'), 15, 5)).toBe(0.5);
  });

  it('eases run from 0 to 1', () => {
    for (const e of ['linear', 'easeIn', 'easeOut', 'easeInOut'] as const) {
      expect(easeProgress(e, 0)).toBe(0);
      expect(easeProgress(e, 1)).toBe(1);
    }
  });

  it('clipAt replaces animated properties with their values at a frame', () => {
    const c = clip({ opacity: 0.5, keyframes: { rotation: [{ frame: 0, value: 0 }, { frame: 100, value: 90 }] } });
    const at = clipAt(c, 50);
    expect(at.rotation).toBe(45);
    expect(at.opacity).toBe(0.5);
    expect(clipAt(clip(), 3)).toEqual(clip());
  });
});

describe('keyframe helpers', () => {
  it('cropKeys adds edge keys with the curve value and drops the rest', () => {
    const keys = [
      { frame: -10, value: 0 },
      { frame: 10, value: 1 },
      { frame: 30, value: 0 },
    ];
    expect(cropKeys(keys, 20)).toEqual([
      { frame: 0, value: 0.5 },
      { frame: 10, value: 1 },
      { frame: 19, value: 0.55 },
    ]);
  });

  it('retimeKeyframes shifts by the head trim and removes properties left empty', () => {
    expect(retimeKeyframes({ opacity: [{ frame: 50, value: 1 }] }, 20, 40)).toEqual({ opacity: [{ frame: 30, value: 1 }] });
    expect(retimeKeyframes({ opacity: [] }, 0, 10)).toBeUndefined();
  });

  it('shiftKeyframes moves keys without cutting them', () => {
    expect(shiftKeyframes({ scale: [{ frame: 5, value: 2 }] }, -100)).toEqual({ scale: [{ frame: -95, value: 2 }] });
  });

  it('animatableProps follows what each kind draws', () => {
    expect(animatableProps({ kind: 'audio' })).toEqual(['volume']);
    expect(animatableProps({ kind: 'video', freeze: true })).not.toContain('volume');
    expect(animatableProps({ kind: 'text' })).toEqual(['opacity', 'scale', 'rotation']);
    expect(animatableProps({ kind: 'slide' })).toEqual([]);
  });

  it('adjacentKey finds the previous and next key across properties', () => {
    const c = clip({ keyframes: { opacity: [{ frame: 10, value: 0 }], scale: [{ frame: 40, value: 1 }] } });
    expect(adjacentKey(c, ['opacity', 'scale'], 20, 1)).toBe(40);
    expect(adjacentKey(c, ['opacity', 'scale'], 20, -1)).toBe(10);
    expect(adjacentKey(c, ['opacity'], 20, 1)).toBeNull();
  });

  it('validKeyframes accepts whole frames and known eases only', () => {
    expect(validKeyframes({ opacity: [{ frame: 0, value: 1, ease: 'easeIn' }] })).toBe(true);
    expect(validKeyframes({ opacity: [{ frame: 0.5, value: 1 }] })).toBe(false);
    expect(validKeyframes({ blur: [{ frame: 0, value: 1 }] })).toBe(false);
    expect(validKeyframes({ opacity: [{ frame: 0, value: 1, ease: 'bounce' }] })).toBe(false);
    expect(validKeyframes([])).toBe(false);
  });
});
