// Fuzzy matching for search boxes such as the command palette.

/**
 * How well `query` matches `text`, or null when it does not: every query
 * character must appear in order. The whole query appearing as one run scores
 * highest, then matches at word starts and runs of consecutive characters;
 * shorter texts win ties.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    const wordStart = found === 0 || /[\s:·/(\-]/.test(t[found - 1]);
    score += 1 + (wordStart ? 3 : 0) + (found === prev + 1 ? 2 : 0);
    prev = found;
    ti = found + 1;
  }
  // The query as one run (ignoring spaces) beats letters scattered through the text,
  // most of all at the start of a word.
  const at = t.replace(/\s+/g, ' ').indexOf(query.toLowerCase().trim());
  if (at >= 0) score += 20 + (at === 0 || /[\s:·/(\-]/.test(t[at - 1]) ? 10 : 0);
  return score - t.length * 0.01;
}
