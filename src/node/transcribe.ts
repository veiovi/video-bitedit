// Local speech-to-text with word timings. Uses whichever engine is installed:
//
//   whisper-cpp  `whisper-cli` from whisper.cpp (brew install whisper-cpp) and a
//                ggml model file (--model or VIDEDIT_WHISPER_MODEL)
//   whisper      OpenAI's `whisper` CLI (pip/brew openai-whisper); models are
//                fetched into ~/.cache/whisper on first use
//
// Audio is first extracted to 16 kHz mono WAV with FFmpeg, which both engines
// expect. Nothing leaves the machine.

import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Transcript, TranscriptWord } from '../shared/captions';
import { extractSpeechAudio } from './media';

const run = promisify(execFile);

export type EngineId = 'whisper-cpp' | 'whisper';

export interface Engine {
  id: EngineId;
  bin: string;
  model: string;
}

export interface TranscribeOptions {
  engine?: EngineId;
  /** whisper-cpp: path to a ggml model; whisper: a model name such as "base" or "small". */
  model?: string;
  /** Spoken language code such as "en"; detected when omitted. */
  language?: string;
}

function which(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, name);
    if (dir && existsSync(candidate)) return candidate;
  }
  return null;
}

const home = os.homedir();
const GGML_DIRS = [
  path.join(home, '.cache', 'whisper.cpp'),
  path.join(home, '.cache', 'whisper-cpp'),
  path.join(home, '.local', 'share', 'whisper.cpp'),
  '/opt/homebrew/share/whisper-cpp',
  '/usr/local/share/whisper-cpp',
];
// Preferred first. English-only models are used only when the language is English.
const MODEL_ORDER = ['large-v3-turbo', 'large-v3', 'medium', 'small', 'base', 'tiny'];

function ggmlModel(language?: string): string | null {
  const files = GGML_DIRS.filter((d) => existsSync(d)).flatMap((d) =>
    readdirSync(d)
      .filter((f) => /^ggml-.+\.bin$/.test(f) && !f.includes('silero'))
      .map((f) => path.join(d, f)),
  );
  const english = !language || language === 'en';
  for (const name of MODEL_ORDER) {
    for (const variant of english ? [`${name}.en`, name] : [name]) {
      const hit = files.find((f) => path.basename(f) === `ggml-${variant}.bin`);
      if (hit) return hit;
    }
  }
  return files[0] ?? null;
}

function whisperModel(language?: string): string {
  const cache = path.join(home, '.cache', 'whisper');
  const have = existsSync(cache) ? new Set(readdirSync(cache)) : new Set<string>();
  const english = language === 'en';
  for (const name of MODEL_ORDER) {
    for (const variant of english ? [`${name}.en`, name] : [name]) {
      if (have.has(`${variant}.pt`)) return variant === 'large-v3-turbo' ? 'turbo' : variant;
    }
  }
  return 'base';
}

/** The engine `transcribe` will use, or an error explaining how to install one. */
export function findEngine(opts: TranscribeOptions = {}): Engine {
  const wanted = opts.engine;
  if (!wanted || wanted === 'whisper-cpp') {
    const bin = which('whisper-cli') ?? which('whisper-cpp');
    const model = opts.model ?? process.env.VIDEDIT_WHISPER_MODEL ?? ggmlModel(opts.language);
    if (bin && model) return { id: 'whisper-cpp', bin, model };
    if (wanted) {
      throw new Error(
        bin
          ? 'whisper.cpp needs a ggml model: pass --model <file.bin> or set VIDEDIT_WHISPER_MODEL.'
          : 'whisper-cli not found. Install whisper.cpp (brew install whisper-cpp).',
      );
    }
  }
  if (!wanted || wanted === 'whisper') {
    const bin = which('whisper');
    if (bin) return { id: 'whisper', bin, model: opts.model ?? whisperModel(opts.language) };
  }
  throw new Error(
    'No local speech-to-text engine found. Install whisper.cpp (brew install whisper-cpp, plus a ggml model) ' +
      'or OpenAI Whisper (pip install openai-whisper).',
  );
}

const PUNCTUATION_ONLY = /^[^\p{L}\p{N}]+$/u;

/** Trim words, fold stray punctuation into the word before it, and drop empty or reversed timings. */
export function cleanWords(raw: TranscriptWord[]): TranscriptWord[] {
  const out: TranscriptWord[] = [];
  for (const w of raw) {
    const text = w.text.trim();
    if (!text) continue;
    if (PUNCTUATION_ONLY.test(text) && out.length) {
      const prev = out[out.length - 1];
      out[out.length - 1] = { ...prev, text: prev.text + text, end: Math.max(prev.end, w.end) };
      continue;
    }
    const start = Math.max(0, w.start);
    out.push({ text, start, end: Math.max(start + 0.01, w.end) });
  }
  return out;
}

/** OpenAI whisper's JSON output (`--word_timestamps True`). */
export function parseWhisperJson(json: string): { words: TranscriptWord[]; language?: string } {
  const data = JSON.parse(json) as { language?: string; segments?: { words?: { word: string; start: number; end: number }[] }[] };
  const words = (data.segments ?? []).flatMap((s) => (s.words ?? []).map((w) => ({ text: w.word, start: w.start, end: w.end })));
  return { words: cleanWords(words), language: data.language };
}

/** whisper.cpp's JSON output with one word per segment (`-oj -ml 1 -sow`). */
export function parseWhisperCppJson(json: string): { words: TranscriptWord[]; language?: string } {
  const data = JSON.parse(json) as {
    result?: { language?: string };
    transcription?: { text: string; offsets: { from: number; to: number } }[];
  };
  const words = (data.transcription ?? [])
    .filter((s) => !/^\s*\[.*\]\s*$/.test(s.text)) // [BLANK_AUDIO], [MUSIC] and similar
    .map((s) => ({ text: s.text, start: s.offsets.from / 1000, end: s.offsets.to / 1000 }));
  return { words: cleanWords(words), language: data.result?.language };
}

/** Transcribe one media file. */
export async function transcribeFile(file: string, assetId: string, opts: TranscribeOptions = {}): Promise<Transcript> {
  const engine = findEngine(opts);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'videdit-stt-'));
  try {
    const wav = path.join(dir, 'speech.wav');
    await extractSpeechAudio(file, wav);
    let parsed: { words: TranscriptWord[]; language?: string };
    const big = { maxBuffer: 200_000_000 };
    if (engine.id === 'whisper-cpp') {
      const lang = ['-l', opts.language ?? 'auto'];
      await run(engine.bin, ['-m', engine.model, '-f', wav, ...lang, '-ml', '1', '-sow', '-oj', '-of', path.join(dir, 'out'), '-np'], big);
      parsed = parseWhisperCppJson(readFileSync(path.join(dir, 'out.json'), 'utf8'));
    } else {
      const lang = opts.language ? ['--language', opts.language] : [];
      await run(
        engine.bin,
        [wav, '--model', engine.model, '--word_timestamps', 'True', '--output_format', 'json', '--output_dir', dir, '--fp16', 'False', '--verbose', 'False', ...lang],
        big,
      );
      parsed = parseWhisperJson(readFileSync(path.join(dir, 'speech.json'), 'utf8'));
    }
    return {
      assetId,
      engine: engine.id,
      model: path.basename(engine.model).replace(/^ggml-|\.bin$/g, ''),
      language: parsed.language ?? opts.language,
      createdAt: Date.now(),
      words: parsed.words,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
