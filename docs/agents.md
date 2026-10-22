# Making videos with an agent

Video bitEdit is built so that an AI agent can do the first assembly and a person can
finish the cut in the editor. The steps below are the loop an agent follows.
The same instructions are packaged as an installable skill in
[skills/videdit/SKILL.md](../skills/videdit/SKILL.md).

## 1. Look at the footage

```bash
videdit info <folder>          # human-readable
videdit info <folder> --json   # full project + assets + transcripts, for programs
videdit transcribe <folder>    # word-timed transcripts of the speech, made locally
```

`info` scans the folder up to three levels deep and registers every video,
audio and image file it finds. It skips `exports/`, `.videdit/` and dot
folders. Each asset gets an ID, a kind, a duration in seconds and dimensions.
Thumbnails and waveforms (for audio files and the sound of video files) are generated with FFmpeg.

### Transcripts

`videdit transcribe <folder>` transcribes every audio and video asset that has
no transcript yet. It runs on this machine with whichever engine is installed:

- **whisper.cpp** (`whisper-cli`, from `brew install whisper-cpp`) is preferred.
  It needs a ggml model file, given by `--model <file.bin>` or
  `VIDEDIT_WHISPER_MODEL`, or found in `~/.cache/whisper.cpp`.
- **OpenAI Whisper** (`whisper`, from `pip install openai-whisper`). It uses
  the largest model already in `~/.cache/whisper`, otherwise `base`, which it
  downloads on first use. `--model small` trades speed for accuracy.

The options are `--asset <name>` (one asset, redone even if it already has a
transcript), `--force` (redo all), `--engine whisper-cpp|whisper` and
`--language en`. Transcripts are saved as
`.videdit/transcripts/<assetId>.json`:
`{ assetId, engine, model, language, createdAt, words: [{ text, start, end }] }`,
with times in source seconds. `info --json` adds them under `transcripts`,
keyed by asset ID, each with a plain `text` field. Read the text to choose what
to keep, then use the word times as `in`/`out` points. Push and pull carry
transcripts to and from the cloud.

## 2. Write a cut list

A cut list is JSON in seconds. `videdit cut <folder> plan.json` converts it to
frames, resolves names to assets, places clips on tracks, and writes
`videdit.json`. Running it again replaces the timelines, but the media bin is
kept.

```json
{
  "title": "Project title",
  "theme": "clean | bold | cinematic",
  "trackVolume": { "A2": 0.5 },
  "timelines": [
    {
      "name": "Main",
      "format": "original | landscape | vertical | square",
      "tracks": { "video": 3, "audio": 4 },
      "clips": [
        { "asset": "interview.mp4", "in": 12.4, "out": 31.0 },
        { "asset": "broll_city", "track": "V2", "at": 4, "duration": 3, "fadeIn": 0.3, "fadeOut": 0.3 },
        { "text": "Jane Doe · Founder", "track": "V3", "at": 1, "duration": 4, "style": { "preset": "lowerThird" } },
        { "asset": "music.mp3", "track": "A2", "at": 0, "duration": 45, "volume": 0.35, "fadeOut": 3 }
      ]
    },
    {
      "name": "Short", "from": "Main", "format": "vertical", "range": [12, 52], "offsetX": 0.1,
      "captions": { "track": "V3" }
    }
  ]
}
```

### Clip fields

| Field | Meaning |
|---|---|
| `asset` | Asset ID, file name, relative path, or file name without its extension |
| `text` | A text clip, instead of `asset` |
| `track` | `V1`–`V10` or `A1`–`A8`. Defaults to `V1` for visuals and `A1` for audio. Higher V tracks draw on top. A video asset on an `A` track plays only its sound |
| `at` | Timeline position in seconds. If omitted, the clip goes after the previous clip on that track |
| `in` / `out` | Source in and out points in seconds (default: the whole file) |
| `duration` | Length in seconds, as an alternative to `out`. Required for images and text unless the default of 5 s or 3 s is fine |
| `speed` | Video and audio: 0.25–4 (default 1). The clip plays `in`→`out` at that speed, so it lasts (out − in) / speed on the timeline; `duration` is then the timeline length. Sound keeps its pitch |
| `volume` | 0–2, where 1 = 100% |
| `muted` | `true` turns off a video clip's own sound. To fade or trim a video's sound separately, mute the video and place the same asset, with the same `in`/`out`, on an `A` track |
| `fadeIn` / `fadeOut` | Seconds. Visuals fade their picture, audio fades its volume, and a video clip fades both |
| `opacity`, `scale` | Visual adjustments |
| `offsetX` / `offsetY` | Reframe. On a cropped clip (any clip on a vertical timeline), -0.5 shows the left (or top) edge of the source and 0.5 the right (or bottom). On a letterboxed clip, it moves the picture by that fraction of the frame |
| `generate` | Instead of `asset`: a prompt for an AI still (OpenRouter `meta/muse-image`, about $0.01 each). `cut` generates it into `generated/` and reuses it on later runs with the same prompt. `aspect` (`"16:9"`, `"9:16"`, …) defaults to the timeline's shape; generated stills default to `fit: "cover"` |
| `fit` | `contain` (letterbox) or `cover` (crop to fill) |
| `effects` | List, applied in order. Each is `{ type, amount? }` plus type-specific fields; see "Effects" below |
| `transition` | `{ type, duration }`, where duration is in seconds (default 0.5). It enters from the clip that ends where this one starts on the same track, and that clip keeps playing underneath. A clip with no neighbour fades or slides in over the tracks below it. Types: `fade`, `dipBlack`, `dipWhite`, `slide`, `whip`, `wipe`, `zoom` |
| `style` | For text: `preset` (`title`, `caption`, `lowerThird`), `fontSize`, `color`, `background`, `x`, `y` (0–1), and `animation` (`none`, `fade`, `rise`, `pop`, `slam`, `typewriter`) |
| `snap` | `true` or `false`: move `in`/`out` into nearby silence (see below). Overrides the timeline and file setting |

**Placement overwrites.** A clip placed over an existing clip on the same
track carves out that range. Put overlays on higher tracks instead of on top
of each other.

**Frame size.** A timeline built from clips defaults to `original`: the size
of the footage that fills most of its running time (rotation taken into
account, so phone video shot upright is portrait), scaled down to fit 1080p.
The full cut keeps the footage's own shape; ask for `landscape`, `vertical`
or `square` to force one. Clips with a different shape are letterboxed in a
landscape frame and cropped to fill in a portrait one.

**Deriving a short.** A timeline with `from` copies an earlier timeline into a
new frame format, `vertical` (9:16) unless `format` says otherwise. Video and
images are cropped to fill. `range` keeps only
that span of the source in seconds and shifts it to start at 0. `offsetX`
reframes horizontally: -0.5 shows the left part of the frame, 0.5 the right.
On a vertical timeline, text clips default to the caption preset.

**Captions.** `"captions": "auto"` on a timeline (or at the top level, next
to `clips`) adds caption clips for the speech in that timeline. They are made
from the transcripts of the clips it uses, so run `videdit transcribe` first.
`"captions": { "track": "V3", "style": { … } }` chooses the video track
(default: the top one) and overrides the look. The style takes the text
`style` fields plus `highlight`, the colour of the word being spoken. Each
audible video or audio clip that has a transcript gets one caption clip
covering the same range. Clips with volume 0, or on muted or hidden tracks,
are skipped. On a derived short, `captions` regenerates them for the new
range at a vertical size and position (larger, at y = 0.7). Without it, the
short keeps cropped copies of the main cut's captions. The words appear as
lines of 3–4 words. A new line starts after punctuation or at a pause of
140 ms or more, and the word being spoken takes the theme's highlight colour.

**Snapping cuts to silence.** With `"snap": true` (on the file, a timeline or
a clip), each `in` and `out` point moves to the frame boundary that lands in
the quietest 10 ms of audio within ±80 ms. This avoids clipping a word or a
breath. Points at the very start or end of the source stay where they are.

If you omit `timelines`, the top-level `clips` build a single "Main" timeline.
`videdit init <folder> --auto` makes a first rough assembly: videos and images
in name order on V1, and audio on A1.

### Effects

Every effect is computed from the frame number, so the preview and the render
match exactly.

| Type | What it does | Fields |
|---|---|---|
| `autoColor` | Automatic levels plus gentle white balance. `cut` solves it once per source file from sampled frames; in the editor, adding it analyses the clip in the browser | `amount` |
| `grade` | A colour look | `preset`: `warm`, `cool`, `tealOrange`, `mono`, `noir`, `vintage`, `faded`, `punchy`; `amount` |
| `grain` | Animated film grain | `amount`, `seed` |
| `vignette` | Darkened edges | `amount` |
| `lightLeak` | Drifting warm light leak | `amount`, `seed` |
| `glitch` | Occasional RGB/jitter bursts | `amount`, `seed` |
| `kenBurns` | Slow zoom and pan across the clip | `from`, `to` (zoom), `panX`, `panY` |
| `zoomPunch` | Quick punch-in at the clip's start | `amount` (extra zoom, default 0.15) |
| `blur` | Gaussian blur | `amount` |

A typical talking-head look:
`[{ "type": "autoColor" }, { "type": "grade", "preset": "warm", "amount": 0.3 }, { "type": "grain", "amount": 0.2 }, { "type": "vignette", "amount": 0.35 }]`.
Alternate `scale` between 1 and about 1.08 on consecutive cuts of the same
shot. That hides jump cuts.

### Slides and HyperFrames (explainers)

- **Remotion slide.** `{ "slide": { "layout": "bullets", "kicker": "01 · Start", "title": "…", "bullets": ["…"], "palette": "paper" }, "duration": 6 }`
  - Layouts: `title`, `bullets`, `image`, `split`, `stat` (with `stat`), `quote`.
  - Palettes: `paper`, `ink`, `rust`, `turquoise`, `mustard`.
  - `image` names an asset; `generate` makes one with Muse Image (`aspect` optional).
  - Slides enter with the clip's `transition`.
- **HyperFrames clip.** `{ "hyperframes": "motion/intro.html", "duration": 7 }`
  renders an HTML/GSAP composition inside the project folder. The output goes
  to `generated/` and is cached by content and `variables`. The composition
  follows the HyperFrames contract: timed elements with `class="clip"`,
  `data-start`/`data-duration`, and a paused GSAP timeline registered on
  `window.__timelines`. To render one directly, use `videdit hyperframes <folder> <file.html>`.
- **Narration.** Put one audio file per scene on `A1` and time each scene's
  visuals to that file's length. That keeps slides exactly in sync with the
  voice.

### AI images

To use AI images, set `OPENROUTER_API_KEY`, or run `videdit config openrouter-key` once.

- `videdit generate <folder> "<prompt>" --aspect 9:16` adds a single still to
  the bin.
- In a cut list, `{ "generate": "…", "track": "V2", "at": 12, "duration": 2.5 }`
  places a cutaway above the speaker while their audio continues.
- Keep the prompts in one shared style (palette, medium) so the cutaways feel
  like a set.

## 3. Show it to the person

```bash
videdit open <folder>
```

This opens the editor at `http://127.0.0.1:4848`. Agents may also edit
`videdit.json` directly while the editor is open. The server notices the
change, bumps the version, and the editor reloads within a few seconds. The
file format is `{ videdit: 1, id, version, doc, assets }`, where `doc` is
`ProjectDoc` in [src/shared/project.ts](../src/shared/project.ts). Inside
`doc`, all times are integer frames at the timeline's `fps`. A caption clip is
`{ kind: "caption", words: [{ text, start, end }], text: <style> }`. Its word
times are frames relative to the clip's start. The editor's split, trim and
overwrite operations keep the words aligned.

## Saving and history

- Every edit autosaves.
- History keeps a snapshot about every 30 s of active editing, plus one for
  every cut-list run, push, pull, agent edit on disk and restore. The last 300
  are kept: locally in `.videdit/history/`, and in the cloud in D1.
- The **History** panel restores any version as a new version, so nothing is
  overwritten.
- Unsaved edits are mirrored in the browser and come back after a crash.
- Removed media and trashed projects are hidden, not destroyed.

## 4. Render, share, publish

```bash
videdit render <folder> --timeline Short --preset mp4-1080p   # → <folder>/exports/
videdit push <folder>                                         # edit + view links
videdit publish <folder> --timeline Main --title "…"          # render locally + public watch page
```

- **Workspace key.** `videdit key` shows the key and copies it. It also
  prints an unlock link (`…/#ws=KEY`) that unlocks any browser in one click,
  and the one-line render-machine command
  (`npx videdit login '<unlock link>' && npx videdit worker`).
  - `videdit key rotate` replaces the key.
  - The editor shows all of this in **Share** and next to
    **Render & publish**.

Publishing makes the video public at `/w/<id>`. Ask the person before
publishing unless they already asked for it. Publish the full cut and the
short both: each watch page has a switcher listing every published timeline of
the project (the latest render of each, longest first, with `Main` shown as
"Full"), so viewers can move between the full movie and the short.

## Quality checklist before publishing

- The first 3 seconds give a reason to keep watching.
- No shot lingers without purpose. B-roll changes roughly every 2–4 seconds.
- Music sits under the dialogue (around 0.25–0.4 volume) and fades out at the end.
- Text stays out of the speaker's face and inside the safe area. On vertical
  timelines, keep captions at y ≈ 0.65–0.8 so the platform's buttons and
  description do not cover them.
- Speech is captioned. Spot-check the transcript for misheard names before
  publishing; fix words by editing the caption clip's `words` in
  `videdit.json`.
- The short is a self-contained moment, not just the first minute of the main cut.
- Each timeline has been watched once in the editor before it is published.
