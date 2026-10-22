// Render a HyperFrames composition (HTML + GSAP, heygen-com/hyperframes) into a
// video file inside the project, so motion graphics written as HTML can sit on
// the timeline next to footage and Remotion slides. Results are cached by the
// composition's content and variables.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { LocalAsset, LocalProject } from './local-project';

const run = promisify(execFile);
export const HYPERFRAMES_VERSION = process.env.VIDEDIT_HYPERFRAMES_VERSION ?? '0.8.185';

export async function renderHyperframes(
  project: LocalProject,
  composition: string,
  opts: { variables?: Record<string, unknown>; quality?: 'draft' | 'looks' | 'delivery' } = {},
): Promise<LocalAsset> {
  const file = path.resolve(project.dir, composition);
  if (!file.startsWith(project.dir + path.sep) || !existsSync(file)) {
    throw new Error(`HyperFrames composition not found inside the project: ${composition}`);
  }
  const html = readFileSync(file, 'utf8');
  const hash = createHash('sha256')
    .update(`${HYPERFRAMES_VERSION}\n${JSON.stringify(opts.variables ?? {})}\n${html}`)
    .digest('hex')
    .slice(0, 12);
  const cacheFile = path.join(project.dir, '.videdit', 'hyperframes.json');
  const cache = existsSync(cacheFile) ? (JSON.parse(readFileSync(cacheFile, 'utf8')) as Record<string, string>) : {};
  const cached = cache[hash] ? project.asset(cache[hash]) : undefined;
  if (cached && existsSync(project.assetFile(cached))) return cached;

  const outDir = path.join(project.dir, 'generated');
  mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `hf-${path.basename(file, '.html')}-${hash}.mp4`);
  // HyperFrames renders a project folder whose root is index.html: stage the
  // composition as one, with the assets/ folder beside it linked in.
  const stage = path.join(project.dir, '.videdit', 'hyperframes', hash);
  mkdirSync(stage, { recursive: true });
  writeFileSync(path.join(stage, 'index.html'), html);
  const assets = path.join(path.dirname(file), 'assets');
  if (existsSync(assets) && !existsSync(path.join(stage, 'assets'))) symlinkSync(assets, path.join(stage, 'assets'));
  const args = ['-y', `hyperframes@${HYPERFRAMES_VERSION}`, 'render', stage, '-o', out, '-q', opts.quality ?? 'looks', '--quiet'];
  if (opts.variables) args.push('--variables', JSON.stringify(opts.variables));
  try {
    await run('npx', args, { cwd: stage, maxBuffer: 50_000_000, env: { ...process.env, HYPERFRAMES_TELEMETRY: '0' } });
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message: string };
    throw new Error(`HyperFrames render failed for ${composition}: ${(e.stderr || e.stdout || e.message).slice(-1500)}`);
  }
  const asset = await project.addFile(out, { name: `${path.basename(file, '.html')} (HyperFrames).mp4` });
  if (!asset) throw new Error(`HyperFrames produced no readable video for ${composition}`);
  writeFileSync(cacheFile, JSON.stringify({ ...cache, [hash]: asset.id }, null, 2));
  return asset;
}
