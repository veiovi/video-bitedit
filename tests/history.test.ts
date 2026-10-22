import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalProject } from '../src/node/local-project';
import { emptyDoc } from '../src/shared/project';

const dirs: string[] = [];
function project(): LocalProject {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'videdit-history-'));
  dirs.push(dir);
  return new LocalProject(dir);
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('local version history', () => {
  it('coalesces rapid editor saves into one snapshot', () => {
    const p = project();
    let v = p.state.version;
    for (const title of ['a', 'b', 'c']) v = p.save({ ...p.state.doc, title }, v)!;
    const editor = p.history().filter((h) => h.source === 'editor');
    expect(editor).toHaveLength(1);
    expect(editor[0]).toMatchObject({ version: v, title: 'c' });
  });

  it('keeps cut-list and restore versions separate and restores without losing anything', () => {
    const p = project();
    p.replaceDoc({ ...emptyDoc('First cut') }, 'cut');
    const first = p.state.version;
    p.save({ ...p.state.doc, title: 'Second cut' }, first);
    const restored = p.restore(first);
    expect(p.state.doc.title).toBe('First cut');
    expect(restored).toBeGreaterThan(first + 1);
    const titles = p.history().map((h) => `${h.source}:${h.title}`);
    expect(titles).toEqual(expect.arrayContaining(['restore:First cut', 'editor:Second cut', 'cut:First cut']));
  });

  it('snapshots edits made on disk by an agent', () => {
    const p = project();
    const file = path.join(p.dir, 'videdit.json');
    const data = { ...p.state, doc: { ...p.state.doc, title: 'Agent edit' } };
    writeFileSync(file, JSON.stringify(data));
    // Make sure the mtime differs from the editor's last write.
    const later = new Date(Date.now() + 2000);
    utimesSync(file, later, later);
    expect(p.state.doc.title).toBe('Agent edit');
    expect(p.history()[0]).toMatchObject({ source: 'external', title: 'Agent edit' });
  });

  it('hides removed assets but keeps their entries', () => {
    const p = project();
    p.state.assets.push({
      id: 'asset0001', kind: 'image', name: 'x.png', mime: 'image/png', size: 1, duration: null, width: 1, height: 1,
      hasThumb: false, status: 'ready', createdAt: 0, path: 'x.png',
    });
    p.removeAsset('asset0001');
    expect(p.asset('asset0001')?.status).toBe('deleted');
  });
});
