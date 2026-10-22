// AI image generation through OpenRouter's Images API (default model:
// meta/muse-image). Generated stills are saved into <folder>/generated/ and
// registered as ordinary image assets, so they behave like any other media.
//
// Key lookup: VIDEDIT_OPENROUTER_API_KEY, then OPENROUTER_API_KEY, then
// `openrouterKey` in ~/.config/videdit/config.json (`videdit config openrouter-key`).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readConfigFile } from './config';
import type { LocalAsset, LocalProject } from './local-project';

export const DEFAULT_IMAGE_MODEL = process.env.VIDEDIT_IMAGE_MODEL ?? 'meta/muse-image';

export function openRouterKey(): string | null {
  return process.env.VIDEDIT_OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY ?? readConfigFile().openrouterKey ?? null;
}

export interface GenerateOptions {
  prompt: string;
  /** e.g. "16:9", "9:16", "1:1". Passed to the API and written into the prompt (some models ignore the parameter). */
  aspect?: string;
  model?: string;
}

const EXT: Record<string, string> = { 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg' };

export async function generateImage({ prompt, aspect = '16:9', model = DEFAULT_IMAGE_MODEL }: GenerateOptions): Promise<{ bytes: Buffer; ext: string; cost?: number }> {
  const key = openRouterKey();
  if (!key) throw new Error('No OpenRouter key. Set OPENROUTER_API_KEY or run `videdit config openrouter-key`.');
  const res = await fetch('https://openrouter.ai/api/v1/images', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'Video bitEdit' },
    body: JSON.stringify({ model, prompt: `${prompt}\n\nAspect ratio ${aspect}.`, aspect_ratio: aspect }),
  });
  const text = await res.text();
  let data: { data?: { b64_json?: string; url?: string; media_type?: string }[]; usage?: { cost?: number }; error?: { message?: string } };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Image generation failed (${res.status})`);
  }
  if (!res.ok) throw new Error(`Image generation failed (${res.status}): ${data.error?.message ?? 'unknown error'}`);
  const item = data.data?.[0];
  if (item?.b64_json) return { bytes: Buffer.from(item.b64_json, 'base64'), ext: EXT[item.media_type ?? ''] ?? 'png', cost: data.usage?.cost };
  if (item?.url) {
    const img = await fetch(item.url);
    if (!img.ok) throw new Error(`Could not download the generated image (${img.status})`);
    return { bytes: Buffer.from(await img.arrayBuffer()), ext: EXT[img.headers.get('content-type') ?? ''] ?? 'png', cost: data.usage?.cost };
  }
  throw new Error('The image model returned no image');
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'image';

/**
 * Generate an image into the project, or reuse an earlier one for the same
 * prompt/aspect/model (cached in .videdit/generated.json, so re-running a cut
 * list never pays twice).
 */
export async function generateIntoProject(project: LocalProject, opts: GenerateOptions & { name?: string }): Promise<LocalAsset> {
  const model = opts.model ?? DEFAULT_IMAGE_MODEL;
  const aspect = opts.aspect ?? '16:9';
  const hash = createHash('sha256').update(`${model}\n${aspect}\n${opts.prompt}`).digest('hex').slice(0, 12);
  const cacheFile = path.join(project.dir, '.videdit', 'generated.json');
  const cache = existsSync(cacheFile) ? (JSON.parse(readFileSync(cacheFile, 'utf8')) as Record<string, string>) : {};
  const cached = cache[hash] ? project.asset(cache[hash]) : undefined;
  if (cached && existsSync(project.assetFile(cached))) return cached;

  const { bytes, ext } = await generateImage({ prompt: opts.prompt, aspect, model });
  const dir = path.join(project.dir, 'generated');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${slug(opts.name ?? opts.prompt)}-${hash}.${ext}`);
  writeFileSync(file, bytes);
  const asset = await project.addFile(file, { name: opts.name ? `${opts.name}.${ext}` : undefined });
  if (!asset) throw new Error(`Could not read the generated image ${file}`);
  writeFileSync(cacheFile, JSON.stringify({ ...cache, [hash]: asset.id }, null, 2));
  return asset;
}
