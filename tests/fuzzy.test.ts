import { describe, expect, it } from 'vitest';
import { fuzzyScore } from '../src/shared/fuzzy';

describe('fuzzy search', () => {
  it('matches characters in order and rejects the rest', () => {
    expect(fuzzyScore('zf', 'Zoom to fit')).not.toBeNull();
    expect(fuzzyScore('fz', 'Zoom to fit')).toBeNull();
    expect(fuzzyScore('', 'anything')).toBe(0);
  });

  it('prefers word starts and runs of characters', () => {
    const titles = ['Split at playhead', 'Snapping on / off', 'Select all clips'];
    const best = (q: string) => [...titles].sort((a, b) => (fuzzyScore(q, b) ?? -1) - (fuzzyScore(q, a) ?? -1))[0];
    expect(best('split')).toBe('Split at playhead');
    expect(best('snap')).toBe('Snapping on / off');
    expect(best('sa')).toBe('Select all clips');
  });
});
