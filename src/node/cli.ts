// videdit command line. See docs/agents.md for the agent workflow.

import { exec, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { type FrameRange, RENDER_PRESETS, type RenderPresetId, type Timeline, findTimeline, formatTimecode, parseTimecode, renderExt, renderRange, timelineDuration } from '../shared/project';
import { THEMES } from '../shared/themes';
import { editUrl, publishRender, replaceRenderOutput, pullProject, pushProject, runWorker, viewUrl } from './cloud';
import { configPath, loadConfig, saveConfig, updateConfigFile, type CloudConfig } from './config';
import { renderHyperframes } from './hyperframes';
import { generateIntoProject } from './imagegen';
import { solveAutoColor } from '../shared/autocolor';
import { transcriptText } from '../shared/captions';
import { LEVELS_PER_SECOND, assetsToSnap, autoAssemble, buildFromCutList, type CutContext, type CutListFile, cutListClips, findAsset } from './cut';
import { deploy, rotateWorkspaceKey } from './deploy';
import { LocalProject } from './local-project';
import { startLocalServer } from './local-server';
import { computePeaks, sampleFrames } from './media';
import { renderTimeline } from './render';
import { type EngineId, findEngine, transcribeFile } from './transcribe';

const HELP = `videdit — edit videos locally, share and publish them on Cloudflare

Local editing
  videdit open [folder]            Open the timeline editor for a folder of clips
  videdit init [folder] [--auto]   Create videdit.json; --auto lays clips end to end
  videdit info [folder] [--json]   List assets, timelines and durations (--json adds transcripts)
  videdit transcribe [folder]      Word-timed transcripts of speech, with local Whisper
      --asset <name>  --engine whisper-cpp|whisper  --model <m>  --language <code>  --force
  videdit cut <folder> <plan.json> Build timelines from a cut list in seconds
  videdit generate <folder> "<prompt>" [--aspect 16:9] [--name n]
                                   Make an AI still (OpenRouter, meta/muse-image) and add it to the bin
  videdit config openrouter-key    Save an OpenRouter key for image generation
  videdit hyperframes <folder> <file.html>
                                   Render a HyperFrames (HTML/GSAP) composition into a clip in the bin
  videdit render [folder]          Render a timeline to <folder>/exports
      --timeline <name>  --preset ${Object.keys(RENDER_PRESETS).join('|')}  --out <file>
      --from <time>  --to <time>   render only part (times as 12.5, 1:05 or 00:01:05:12)
      --still <time>               save the frame at that time as a PNG

Cloud
  videdit deploy [--name videdit] [--with-openrouter]
                                   Create D1/R2, deploy the Worker (needs CLOUDFLARE_API_TOKEN);
                                   --with-openrouter lets cloud editors generate AI images
  videdit login <url | unlock link>
                                   Use an existing deployment (an unlock link carries the key)
  videdit key [set <key> | rotate] Show/copy the workspace key and unlock link, change it, or rotate it
  videdit push [folder] [--force]  Upload the folder; prints the edit and view links
  videdit pull [folder]            Bring cloud edits back into the folder
  videdit publish [folder]         Push, render locally and publish a watch page
      --timeline <name>  --title <t>  --description <d>  --preset <p>  --from <time>  --to <time>
      --replace <watch URL or id>  re-render into an existing watch page (same link)
  videdit worker [--once]          Render jobs queued from the cloud editor
  videdit doctor                   Check FFmpeg, the build and the cloud connection
`;

function parse(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
      else flags[k] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

/** Show the workspace key with ready-to-use links and copy the key to the clipboard. */
function printWorkspace(serverUrl: string, workspaceKey: string) {
  const unlock = `${serverUrl}/#ws=${workspaceKey}`;
  console.log(`
Workspace key   ${workspaceKey}
Unlock link     ${unlock}
                (opening it in a browser unlocks project creation and publishing there)
Render machine  npx videdit login '${unlock}' && npx videdit worker`);
  if (process.platform === 'darwin') {
    try {
      execFileSync('pbcopy', { input: workspaceKey });
      console.log('\nThe key is on your clipboard.');
    } catch {
      // No clipboard; the key is printed above.
    }
  }
}

function requireConfig(): CloudConfig {
  const config = loadConfig();
  if (!config) throw new Error('No cloud configured. Run `videdit deploy` (or `videdit login <url>`) first.');
  return config;
}

function openBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
  exec(`${cmd} "${url}"`);
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function loadProject(folder: string | undefined, scan = true): Promise<LocalProject> {
  const project = new LocalProject(folder ?? '.');
  if (scan) {
    const added = await project.scan();
    if (added.length) console.log(`Added ${added.length} media file(s) to the bin.`);
  }
  return project;
}

/** The frames --from/--to (or --still) pick out of a timeline; null for all of it. */
function rangeFlags(timeline: Timeline, from: string | undefined, to: string | undefined, still?: string): FrameRange | null {
  const at = (flag: string, text: string | undefined) => {
    if (text === undefined) return undefined;
    const f = parseTimecode(text, timeline.fps);
    if (f === null) throw new Error(`--${flag}: not a time: "${text}" (try 12.5, 1:05 or 00:01:05:12)`);
    return f;
  };
  const duration = timelineDuration(timeline);
  if (still !== undefined) return renderRange({ start: at('still', still) }, duration, true);
  return renderRange({ start: at('from', from), end: at('to', to) }, duration);
}

function describe(project: LocalProject) {
  const { doc, assets } = project.state;
  console.log(`${doc.title}  (theme: ${doc.theme ?? 'clean'}; themes: ${THEMES.map((t) => t.id).join(', ')})`);
  console.log(`\nAssets (${assets.length}):`);
  for (const a of assets) {
    const dur = a.duration !== null ? `${a.duration.toFixed(2)}s` : '—';
    const dims = a.width ? ` ${a.width}x${a.height}` : '';
    const words = project.transcript(a.id)?.words.length;
    console.log(`  ${a.id}  ${a.kind.padEnd(5)} ${dur.padStart(9)}${dims}  ${a.path}${words !== undefined ? `  (transcript: ${words} words)` : ''}`);
  }
  console.log('\nTimelines:');
  for (const t of doc.timelines) {
    const tracks = t.tracks.map((x) => x.name).join(' ');
    console.log(`  ${t.name}  ${t.width}x${t.height} @${t.fps}  ${formatTimecode(timelineDuration(t), t.fps)}  ${t.clips.length} clips  [${tracks}]`);
  }
}

async function main() {
  const [command = 'help', ...rest] = process.argv.slice(2);
  const { positional, flags } = parse(rest);
  const str = (k: string) => (typeof flags[k] === 'string' ? (flags[k] as string) : undefined);

  switch (command) {
    case 'open': {
      const project = await loadProject(positional[0]);
      const server = await startLocalServer(project, { port: str('port') ? Number(str('port')) : undefined });
      const url = `${server.url}/p/${project.state.id}`;
      console.log(`Editing ${project.dir}\n  ${url}\nPress Ctrl+C to stop.`);
      if (!flags['no-browser']) openBrowser(url);
      return new Promise(() => undefined);
    }
    case 'init': {
      const project = await loadProject(positional[0]);
      if (flags.auto) {
        const list = autoAssemble(project.state.assets, project.state.doc.title);
        project.replaceDoc(buildFromCutList(list, project.state.assets, project.state.doc));
      }
      describe(project);
      return;
    }
    case 'info': {
      const project = await loadProject(positional[0]);
      if (flags.json) {
        const { doc, assets } = project.state;
        const transcripts = Object.fromEntries(
          Object.entries(project.transcripts).map(([id, t]) => [id, { ...t, text: transcriptText(t) }]),
        );
        console.log(JSON.stringify({ doc, assets, transcripts }, null, 2));
      } else describe(project);
      return;
    }
    case 'cut': {
      const [folder, planFile] = positional;
      if (!folder || !planFile) throw new Error('Usage: videdit cut <folder> <plan.json>');
      const project = await loadProject(folder);
      const list = JSON.parse(readFileSync(planFile, 'utf8')) as CutListFile;
      // AI stills first: each `generate` becomes an image asset (cached per prompt).
      for (const { clip, vertical } of cutListClips(list)) {
        if (!clip.generate) continue;
        process.stdout.write(`Generating image: ${clip.generate.slice(0, 70)}…\n`);
        const asset = await generateIntoProject(project, { prompt: clip.generate, aspect: clip.aspect ?? (vertical ? '9:16' : '16:9') });
        clip.asset = asset.id;
        clip.fit ??= 'cover';
        delete clip.generate;
      }
      // Slide images to generate, and HyperFrames compositions to render into clips.
      for (const { clip, vertical } of cutListClips(list)) {
        if (clip.slide?.generate) {
          process.stdout.write(`Generating slide image: ${clip.slide.generate.slice(0, 64)}…\n`);
          const asset = await generateIntoProject(project, {
            prompt: clip.slide.generate,
            aspect: clip.slide.aspect ?? (clip.slide.layout === 'split' ? (vertical ? '16:9' : '3:4') : vertical ? '9:16' : '16:9'),
          });
          clip.slide.image = asset.id;
          delete clip.slide.generate;
        }
        if (clip.hyperframes) {
          process.stdout.write(`Rendering HyperFrames composition ${clip.hyperframes}…\n`);
          const asset = await renderHyperframes(project, clip.hyperframes, { variables: clip.variables });
          clip.asset = asset.id;
          delete clip.hyperframes;
        }
      }
      // The "original" format reads footage sizes, so make sure they reflect rotation.
      const used = [...(list.timelines ?? [{ clips: list.clips }])].flatMap((t) => t.clips ?? []);
      await project.refreshDimensions(used.map((c) => (c.asset ? findAsset(project.state.assets, c.asset)?.id : undefined)).filter((id): id is string => Boolean(id)));
      // Auto colour: solve one correction per source file (sampled across the whole
      // file), so every cut from the same take matches.
      const corrections = new Map<string, ReturnType<typeof solveAutoColor>>();
      for (const { clip } of cutListClips(list)) {
        const fx = clip.effects?.find((e) => e.type === 'autoColor' && !e.gains);
        const asset = fx && clip.asset ? findAsset(project.state.assets, clip.asset) : undefined;
        if (!fx || !asset || asset.kind === 'audio') continue;
        if (!corrections.has(asset.id)) {
          const pixels = await sampleFrames(project.assetFile(asset), 0, asset.duration ?? 0.1, asset.duration ? 12 : 1);
          corrections.set(asset.id, solveAutoColor(pixels, 3));
        }
        Object.assign(fx, corrections.get(asset.id));
      }
      const ctx: CutContext = { transcripts: project.transcripts, levels: {} };
      for (const asset of assetsToSnap(list, project.state.assets)) {
        const levels = await computePeaks(project.assetFile(asset), LEVELS_PER_SECOND);
        if (levels) ctx.levels![asset.id] = levels;
      }
      project.replaceDoc(buildFromCutList(list, project.state.assets, project.state.doc, ctx));
      describe(project);
      return;
    }
    case 'transcribe': {
      const project = await loadProject(positional[0]);
      const engineId = str('engine');
      if (engineId && engineId !== 'whisper-cpp' && engineId !== 'whisper') throw new Error('--engine must be whisper-cpp or whisper');
      const opts = { engine: engineId as EngineId | undefined, model: str('model'), language: str('language') };
      const engine = findEngine(opts);
      const wanted = str('asset');
      const match = wanted ? findAsset(project.state.assets, wanted) : undefined;
      if (wanted && (!match || match.kind === 'image')) throw new Error(`No audio or video asset matches "${wanted}"`);
      const targets = match ? [match] : project.state.assets.filter((a) => a.kind !== 'image' && (flags.force || !project.transcript(a.id)));
      if (targets.length === 0) console.log('Every audio and video asset already has a transcript (use --force to redo).');
      for (const asset of targets) {
        process.stdout.write(`Transcribing ${asset.path} with ${engine.id} (${path.basename(engine.model)})… `);
        const started = Date.now();
        const t = await transcribeFile(project.assetFile(asset), asset.id, opts);
        project.saveTranscript(t);
        console.log(`${t.words.length} words in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      }
      return;
    }
    case 'hyperframes': {
      const [folder, composition] = positional;
      if (!folder || !composition) throw new Error('Usage: videdit hyperframes <folder> <composition.html> [--variables JSON]');
      const project = await loadProject(folder, false);
      const variables = str('variables') ? (JSON.parse(str('variables')!) as Record<string, unknown>) : undefined;
      const asset = await renderHyperframes(project, composition, { variables });
      console.log(`${asset.id}  ${asset.path}  ${asset.duration?.toFixed(2)}s`);
      return;
    }
    case 'generate': {
      const [folder, prompt] = positional;
      if (!folder || !prompt) throw new Error('Usage: videdit generate <folder> "<prompt>" [--aspect 16:9] [--name title-card]');
      const project = await loadProject(folder, false);
      const asset = await generateIntoProject(project, { prompt, aspect: str('aspect'), name: str('name'), model: str('model') });
      console.log(`${asset.id}  ${asset.path}  ${asset.width}x${asset.height}`);
      return;
    }
    case 'config': {
      if (positional[0] !== 'openrouter-key') throw new Error('Usage: videdit config openrouter-key');
      const key = process.env.OPENROUTER_API_KEY ?? (await prompt('OpenRouter API key: '));
      updateConfigFile({ openrouterKey: key.trim() });
      console.log(`Saved to ${configPath()}`);
      return;
    }
    case 'render': {
      const project = await loadProject(positional[0]);
      const still = str('still');
      const preset = (still !== undefined ? 'still-png' : (str('preset') ?? 'mp4-1080p')) as RenderPresetId;
      if (!(preset in RENDER_PRESETS)) throw new Error(`Unknown preset ${preset}`);
      const { doc } = project.state;
      const timeline = findTimeline(doc, str('timeline'));
      if (!timeline) throw new Error(`No timeline "${str('timeline')}"`);
      const range = rangeFlags(timeline, str('from'), str('to'), still ?? (RENDER_PRESETS[preset].still ? '0' : undefined));
      const server = await startLocalServer(project, { port: 0 });
      const sources = Object.fromEntries(project.state.assets.map((a) => [a.id, `${server.url}/m/${project.state.id}/a/${a.id}`]));
      const part = range ? ` ${formatTimecode(range.start, timeline.fps).replace(/:/g, '.')}` : '';
      const output = path.resolve(
        str('out') ?? path.join(project.exportsDir(), `${doc.title} - ${timeline.name}${part}.${renderExt(preset)}`.replace(/[/\\]/g, '_')),
      );
      try {
        await renderTimeline({
          doc,
          timelineId: timeline.id,
          sources,
          preset,
          output,
          range,
          onProgress: (p) => process.stdout.write(`\rRendering ${timeline.name}: ${Math.round(p * 100)}%`),
        });
      } finally {
        await server.close();
      }
      console.log(`\n${output}`);
      return;
    }
    case 'deploy': {
      if (!process.env.CLOUDFLARE_API_TOKEN) process.env.CLOUDFLARE_API_TOKEN = await prompt('Cloudflare API token: ');
      const url = await deploy({ name: str('name'), withOpenRouter: Boolean(flags['with-openrouter']) });
      console.log(`\nVideo bitEdit is live at ${url}\nSettings saved to ${configPath()}`);
      printWorkspace(url, requireConfig().workspaceKey);
      return;
    }
    case 'login': {
      // Accepts a plain server URL or a full unlock link (https://…/#ws=KEY).
      const arg = positional[0];
      if (!arg) throw new Error('Usage: videdit login <serverUrl | unlock link>');
      const fromLink = arg.match(/#ws=([\w-]+)/)?.[1];
      const serverUrl = arg.replace(/#.*$/, '').replace(/\/+$/, '');
      const workspaceKey = fromLink ?? process.env.VIDEDIT_WORKSPACE_KEY ?? (await prompt('Workspace key: '));
      saveConfig({ serverUrl, workspaceKey: workspaceKey.trim() });
      console.log(`Saved to ${configPath()}`);
      return;
    }
    case 'key': {
      const sub = positional[0] ?? 'show';
      if (sub === 'set') {
        const key = positional[1] ?? (await prompt('New workspace key: '));
        const config = requireConfig();
        saveConfig({ serverUrl: config.serverUrl, workspaceKey: key.trim() });
        console.log(`Saved to ${configPath()}`);
        return;
      }
      if (sub === 'rotate') {
        const key = await rotateWorkspaceKey();
        printWorkspace(requireConfig().serverUrl, key);
        console.log('\nThe old key no longer works. Unlock your browsers and render machines with the new link.');
        return;
      }
      const config = requireConfig();
      printWorkspace(config.serverUrl, config.workspaceKey);
      return;
    }
    case 'push': {
      const project = await loadProject(positional[0]);
      const link = await pushProject(project, requireConfig(), { force: Boolean(flags.force), log: console.log });
      console.log(`\nEdit link (anyone with it can edit): ${editUrl(link)}\nView link (watch and comment):    ${viewUrl(link)}`);
      return;
    }
    case 'pull': {
      const project = await loadProject(positional[0], false);
      await pullProject(project, requireConfig(), console.log);
      describe(project);
      return;
    }
    case 'publish': {
      const config = requireConfig();
      const project = await loadProject(positional[0]);
      const preset = (str('preset') ?? 'mp4-1080p') as RenderPresetId;
      const timeline = findTimeline(project.state.doc, str('timeline'));
      if (!timeline) throw new Error(`No timeline "${str('timeline')}"`);
      if (RENDER_PRESETS[preset]?.still) throw new Error('Stills cannot be published; use `videdit render --still <time>`');
      const range = rangeFlags(timeline, str('from'), str('to'));
      await pushProject(project, config, { force: Boolean(flags.force), log: console.log });
      const server = await startLocalServer(project, { port: 0 });
      const output = path.join(project.exportsDir(), `${timeline.name}-${Date.now()}.${renderExt(preset)}`);
      try {
        await renderTimeline({
          doc: project.state.doc,
          timelineId: timeline.id,
          sources: Object.fromEntries(project.state.assets.map((a) => [a.id, `${server.url}/m/${project.state.id}/a/${a.id}`])),
          preset,
          output,
          range,
          onProgress: (p) => process.stdout.write(`\rRendering ${timeline.name}: ${Math.round(p * 100)}%`),
        });
      } finally {
        await server.close();
      }
      console.log('\nUploading…');
      const replace = str('replace')?.match(/([A-Za-z0-9]{8,32})\/?$/)?.[1];
      if (replace) {
        console.log(`Updated in place: ${await replaceRenderOutput(config, replace, output)}`);
        return;
      }
      const watch = await publishRender(project, config, output, preset, timeline.id, {
        title: str('title') ?? `${project.state.doc.title}${project.state.doc.timelines.length > 1 ? ` · ${timeline.name}` : ''}`,
        description: str('description') ?? '',
        range,
      });
      console.log(`Published: ${watch}\nEdit link: ${editUrl(project.remote!)}`);
      return;
    }
    case 'worker': {
      await runWorker(requireConfig(), { once: Boolean(flags.once) });
      return;
    }
    case 'doctor': {
      const { toolPath } = await import('./media');
      console.log(`FFmpeg: ${toolPath('ffmpeg')}\nFFprobe: ${toolPath('ffprobe')}`);
      const built = existsSync(path.join(path.dirname(new URL(import.meta.url).pathname), '../../dist/client/index.html'));
      console.log(`Web app build: ${built ? 'ok' : 'missing — run npm run build'}`);
      const config = loadConfig();
      console.log(`Config: ${config ? `${config.serverUrl} (${configPath()})` : 'not deployed yet'}`);
      if (config) {
        const res = await fetch(`${config.serverUrl}/api/workspace`, { headers: { 'x-workspace-key': config.workspaceKey } });
        console.log(`Cloud workspace key: ${res.ok && ((await res.json()) as { ok: boolean }).ok ? 'ok' : 'rejected'}`);
      }
      return;
    }
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;
    default:
      console.error(`Unknown command "${command}"\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\nError: ${(err as Error).message}`);
  process.exit(1);
});
