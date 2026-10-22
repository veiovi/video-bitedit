---
name: videdit
description: Turn a folder of video clips into an edited main video and/or a social short with Video bitEdit — write a seconds-based cut list, open the timeline editor for review, render locally, push a shareable edit link to Cloudflare, and publish a watch page. Use when asked to "make a video from these clips", cut a short/reel/TikTok from footage, assemble a rough cut, or share/publish a video project.
---

# Video bitEdit

Video bitEdit is a CLI plus a browser timeline editor. You build the cut as JSON and
a person reviews and tweaks it in the editor. The rendered output matches the
preview exactly.

## Workflow

1. **Inventory.** Run `videdit info <folder>`. Note each asset's name, kind
   and duration. Do not guess durations. If the footage has speech, run
   `videdit transcribe <folder>` (local Whisper), then read the words with
   their times in `videdit info <folder> --json` under `transcripts`.
2. **Plan.** Write a short plan in chat: for each timeline, the story beats
   with source in/out points in seconds, plus music and titles. With a
   transcript, cut between sentences, using the word times. If the person
   wants a short as well, choose the strongest self-contained 15–60 s moment.
3. **Cut.** Write `plan.json` and run `videdit cut <folder> plan.json`. The
   cut list format is in `docs/agents.md` in the Video bitEdit repository. The
   essentials:
   - `timelines: [{ name, format?, clips: [...] }]` (format defaults to the
     footage's own shape), and for a short
     `{ name: "Short", from: "Main", format: "vertical", range: [start, end] }`.
   - Each clip is `{ asset | text, track?, at?, in?, out? | duration?, volume?, fadeIn?, fadeOut?, style? }`.
   - Placement on a track overwrites what is already there, so put overlays
     on V2 and above.
   - `"captions": "auto"` (or `{ "track": "V3" }`) on a timeline adds
     word-highlighted captions from the transcripts. Add it to shorts.
   - `"snap": true` moves cut points into the nearest silence (±80 ms).
   - Errors name the clip number. Fix it and run the command again.
   - **Make it look good.**
     - Add `"effects": [{ "type": "autoColor" }, { "type": "grade", "preset": "warm", "amount": 0.3 }, { "type": "grain", "amount": 0.2 }, { "type": "vignette", "amount": 0.35 }]` to the speaker clips.
     - Alternate `scale` 1 / 1.08 across jump cuts.
     - Add `transition`s (`fade`, `whip`, `zoom`, `dipBlack`) on cutaways.
     - With an OpenRouter key, add AI cutaways with `{ "generate": "<prompt in one shared style>", "track": "V2", "at": …, "duration": 2.5 }` over the speaker while their audio continues.
     - Add `"captions": { "track": "V3" }` per timeline after `videdit transcribe`. For shorts, an animated look reads better: `"captions": { "track": "V3", "position": "bottom", "style": { "captionLook": "karaoke", "wordsPerLine": 3 } }` (looks: classic, karaoke, pop, bounce, typewriter, highlight, oneWord).
   - **Explainers.** Combine:
     - `{ "slide": { "layout": "bullets" | "split" | "stat" | "image" | "title" | "quote", … } }` (Remotion slides);
     - `{ "hyperframes": "motion/x.html" }` (HTML/GSAP motion rendered by HyperFrames);
     - Muse Image stills;
     - one narration file per scene on A1, with each scene timed to its audio.
4. **Review.** Run `videdit open <folder>` and give the person the URL. If
   they ask for changes, edit `plan.json` (or `videdit.json`) and run the cut
   again. The open editor reloads automatically.
5. **Deliver.**
   - Local file: `videdit render <folder> --timeline <name>`. Output goes to
     `<folder>/exports/`.
   - Shareable editing link: `videdit push <folder>`. This needs `videdit
     deploy` to have been run once with `CLOUDFLARE_API_TOKEN`.
   - Public watch page: `videdit publish <folder> --timeline <name> --title "…"`.
     Publish only when the person asked for it. Publish both the full cut and
     the short; the watch pages link them with a Full / Short switcher.

## Rules

- Never delete or move the person's source files. Video bitEdit only reads them.
- Keep times inside each source's duration. `cut` clamps them, but plan
  inside the real range anyway.
- Music volume should be about 0.25–0.4 under speech, with a fade out at the
  end.
- Before reporting done, render at least a draft (`--preset mp4-720p`) and
  check that it exists.
