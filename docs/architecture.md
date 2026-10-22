# Architecture

## Data model

The model lives in `src/shared/project.ts`.

- **ProjectDoc**: `{ schema: 1, title, theme, timelines[] }`. The project's
  media (assets) is stored next to it, not inside it. Locally that is
  `videdit.json` `assets`; in the cloud it is the D1 `assets` table. Every
  timeline in a project shares that one bin.
- **Timeline**: `{ id, name, fps, width, height, background, tracks[], clips[], markers[] }`.
  Tracks are listed top to bottom, and higher video tracks draw over lower
  ones. There can be up to 10 video tracks and 8 audio tracks.
- **Clip**: `{ id, kind, trackId, start, duration, assetId?, in?, volume?, muted?, disabled?, fadeIn?, fadeOut?, opacity?, scale?, rotation?, offsetX?, offsetY?, fit?, text?, words?, speed?, freeze?, keyframes? }`.
  All times are integer frames. `in` is the offset into the source, in
  source frames. `speed` (video and audio, 0.25–4, default 1) plays
  `duration × speed` source frames from `in`; `clipSpeed` gives it, and the
  edit ops move `in` by timeline frames × speed. A `freeze` clip is a silent
  video clip that holds the source frame at `in` for its whole length
  (`clipSpeed` 0). Tracks may carry `color` and a row `height` (small or
  large) for the editor. Kinds
  are `video`, `audio`, `image`, `text` and `caption`. An audio clip may play
  a video asset's sound: Detach audio (`detachAudio`) adds one on a free audio
  track and sets `muted` on the video clip. A `disabled` clip stays on the
  timeline but is skipped in preview and export. Fades scale opacity for visuals and
  gain for sound.
- **Keyframes** (`src/shared/keyframes.ts`): `keyframes` maps a property
  (`opacity`, `scale`, `offsetX`, `offsetY`, `rotation`, `volume`) to keys
  `{ frame, value, ease?, duck? }`, in frames from the clip's start (0 to
  duration − 1), sorted, one per frame. A property with keys ignores its
  static value. `valueAt(clip, prop, frame)` is the curve: it holds the first
  key's value before it and the last key's after it, and between two keys
  follows the first key's `ease` (`linear` by default, `hold`, or cubic
  `easeIn`, `easeOut`, `easeInOut`). `animatableProps` lists what each kind
  draws: video and images the transform and opacity (video also volume,
  unless frozen), text and captions opacity, scale and rotation, audio
  volume. `duck` marks volume keys that ducking wrote.
- **Caption clip**: `kind: 'caption'` with `words: [{ text, start, end }]` in
  frames relative to the clip's start, and `text` for the look (the theme's
  caption preset plus `highlight`, the accent colour, `captionLook` and
  `wordsPerLine`; see Preview and render). Edits that move a clip's head (trim,
  split, overwrite, `cropRange`) shift and clip its words, just as they move
  `in` for media.
- **Transcript** (`src/shared/captions.ts`): an asset sidecar,
  `{ assetId, engine, model, language, createdAt, words: [{ text, start, end }] }`
  in source seconds. `src/node/transcribe.ts` runs whisper.cpp or OpenAI
  Whisper locally on a 16 kHz mono extract. `captionClipsFor` maps
  transcript words into the media clips of a timeline, which is how cut lists
  generate captions.
- **Asset filmstrip**: videos carry `filmstrip: { frames, every, width, height }`,
  describing a JPEG sprite of `frames` frames side by side, frame i showing
  the source at i × `every` seconds, each `width` × `height` pixels
  (`filmstripPlan`: a frame every 2 s, at most 60, 160 px wide). Locally,
  FFmpeg makes it at import (`fps` and `tile` filters), and videos imported
  earlier get one in the background when the editor opens the project. Cloud
  uploads draw it in the browser by seeking a `<video>` into a canvas. The
  timeline draws, along each video clip, the frames for the part of the
  source it shows at the current zoom (falling back to the tiled thumbnail),
  and the media bin uses the same sprite when the mouse skims across a card
  (a muted `<video>` when there is no sprite; nothing on touch).
- **Edits** are pure functions in `src/shared/edits.ts`. Placement overwrites:
  a placed clip carves out the range it lands on. Split, trim, ripple delete,
  `deriveTimeline` (format conversion with crop to fill) and `cropRange`
  (highlight range) live there too.
- **Edits keep keyframes on the footage.** `reframe`, which every head or
  tail trim goes through (trims, splits, overwrites, ripple trims, rolls,
  `cropRange`), shifts keys by the head trim and cuts them to the new length
  with `cropKeys`: where the curve crosses an edge, a key goes on the edge
  with the value the curve had there, then keys outside are dropped. Linear
  and hold spans stay exact; an eased span cut part-way keeps its ends and
  its ease. A split therefore gives each half its own keys plus one at the
  cut, so values run on. `setSpeed` stretches keys with the clip's length.
  `freezeFrame` gives the still the animated values at its frame as static
  ones. `detachAudio` moves volume keys to the new audio clip, and
  `clipAttributes`/`pasteAttributes` treat keys as part of the look: each
  pasted property takes the copied keys (cut to the target's length, after
  any speed change) or loses its own. The key ops are `setKeyframe` (add,
  or replace at that frame, keeping its ease unless given), `removeKeyframe`,
  `moveKeyframe` (kept inside the clip) and `clearKeyframes` (the value at a
  frame becomes the static value). `duckClips`, `removeDucking` and
  `setClipGain` (volume and volume keys scale together) are the audio ops.
- **Timeline editing follows CapCut.**
  - **Main-track magnet** (P, on by default; the setting is kept per browser).
    The main track is the bottom video track (V1, `mainTrackId`), and it stays
    gapless. A drop on it inserts at the nearest clip edge and pushes
    everything after it right (`boundaryNear`, `insertClip`). Dragging a V1
    clip reorders it, carrying the clips on other tracks that start during it
    (`moveMainClip`). Trims ripple (`rippleTrim`), and Delete closes the gap
    (`rippleDeleteClips`). Turning the magnet on closes the existing gaps
    (`closeGaps`). Overlay and audio tracks never ripple on their own.
  - **Linkage** (`` ` ``, on by default). The other unlocked tracks follow the
    main track's ripples, so captions and cutaways stay in sync. With linkage
    off, the same operations act on V1 alone (their `onlyTrack` argument).
    Locked tracks never move. `closeRange` and `openRange` remove or open a
    stretch of time on those tracks.
  - **Replace.** Drop media on the middle of a clip (its outer fifth means
    "insert at this edge"), or use the inspector's Replace menu. The replace
    dialog keeps the clip's start and length: for longer media you drag a
    fixed-length window to choose the part that plays. Media shorter than the
    clip is refused (`replaceProblem`), and images always fit. "Keep the
    clip's effects" is on by default (`replaceClipMedia`).
  - **Selection.** Box select by dragging on empty space (Shift adds).
    The select-backward and select-forward tools ([ and ], `clipsFrom`) pick
    everything left or right of a click (Shift: one track). Dragging a
    multi-selection moves it as a group (`moveClips`).
  - **Keys.** Q and W delete left or right of the playhead (`deleteSide`),
    acting on the main-track clip under it when nothing is selected. ⌘B
    splits. N toggles snapping, and holding ⌘ while dragging ignores it.
    A move snaps by whichever edge finds a snap point, measured against the
    timeline as it was when the drag began, and a dashed line shows where.
  - **Clipboard.** ⌘C/⌘X/⌘V/⌘D copy, cut, paste at the playhead and duplicate
    after the selection (`pasteClips`), and ⌥⇧-drag drags copies. The
    clipboard lives in the tab. Copies keep their tracks and offsets; with the
    magnet on, copies that land on the main track insert instead of
    overwriting. A right-click menu offers the same actions, and "Paste here"
    on empty track space pastes onto that track.
  - **Nudge, navigate, turn off.** , and . (or ⌥←/→) nudge the selection a
    frame, ⇧ a second; main-track clips stay put while the magnet is on.
    ↑/↓ jump to the previous or next clip edge or marker
    (`adjacentEditPoint`). The timecode takes a typed time (`parseTimecode`).
    ⇧E turns clips off and on (`toggleClipsEnabled`).
  - **Listening.** Audio clips carry a volume line: dragging it sets the
    clip's volume (`setVolume`, 0–200%) on a square-root scale that puts 100%
    a third of the way down; ⇧ drags in fine steps, 100% is sticky, and a
    double-click resets it. The S button solos a track. Solo lives in the tab
    (`solo` in the store), and the preview plays `withSolo(timeline, solo)`,
    which mutes every other track, so the saved timeline and the export never
    see it. Loop playback (⇧L, `loop`) repeats the selected clips
    (`loopRange`) or the whole timeline: the player loops the timeline, and
    leaving the selection while playing seeks back to its start (its end when
    playing backwards). The ruler shades the looped stretch.
  - **Timing.** Speed (`setSpeed`, from the inspector) keeps a clip's `in`
    and the footage it plays, so its length scales; on the main track with
    the magnet on, the rest ripples like an end trim, and elsewhere a longer
    clip overwrites what follows. ⇧F (`freezeFrame`) splits a video clip at
    the playhead and puts a two-second still of that exact source frame
    there: an insert that ripples on the main track with the magnet on, an
    overwrite elsewhere. The composition draws a still with `<Freeze>`
    around the video, and plays sped-up or slowed clips with `playbackRate`.
    Pitch is kept: the browser's media elements preserve it in the preview,
    and the export time-stretches the audio. ⌥-dragging the cut between two
    touching clips rolls it (`rollEdit`): one side longer, the other
    shorter, each limited by its source. ⌥-dragging a video or audio clip
    slips it (`slipClip`): the footage follows the pointer while the clip
    stays put, and the preview seeks to the clip's first frame. ⌥⇧-drag
    (or ⌥-drag of a clip that cannot slip, or of a multi-selection) drags a
    copy. ⌥[ and ⌥] (also ⇧[ and ⇧]) trim the selection's start or end to
    the playhead (`trimToFrame`), lengthening clips when the playhead is
    outside them and the source allows; main-track clips ripple with the
    magnet on.
  - **Copy attributes.** ⌥⌘C takes the selected clip's look
    (`clipAttributes`: effects, transition, opacity, transform, speed,
    volume and their keyframes) and ⌥⌘V pastes it onto every selected clip
    (`pasteAttributes`). Each clip takes what applies to its kind, and a
    pasted effect replaces one of the same type.
  - **Track headers.** Double-click a name to rename it (`renameTrack`; the
    track keeps its colour). The stripe on the header's left opens eight
    colour swatches, and clips take the track's colour with a stripe on
    their left edge. The arrow button cycles the row height. Dragging a
    header reorders tracks of its kind (`reorderTrack`); the bottom video
    track is always the main track, so moving another there makes it main.
  - **Timeline view.** Seeking stops at the last frame. Zoomed in past six
    pixels per frame, the ruler marks every frame. Dragging a clip, an edge
    or a selection box near the left or right edge scrolls the timeline.
  - **Text-based editing.** The Transcript tab shows the timeline's speech
    as paragraphs (a new one after a pause of more than 1 s). `timelineTranscript`
    (`src/shared/transcript.ts`) maps each audible media clip's transcript
    words through its start and in-point, and uses caption clips' words where
    no transcribed media plays. Clicking a word seeks; the word under the
    playhead is underlined. Dragging or ⇧-clicking selects a run, shaded on
    the ruler, and ⌫ (or Cut) removes those frames from every unlocked track
    in one undo step (`cutRange`, built on `closeRange`). Speech a cut removed
    shows struck through at the cut: wherever two neighbouring clips of one
    file skip part of the source, its words are listed there. Clicking a
    struck run undoes the cut when it was the last edit; otherwise it reopens
    the source (`restoreSourceGap`: everything after moves right on every
    unlocked track and the clips before the cut play on). Caption clips over
    a restored stretch are not regenerated.
  - **Keyframing.** Each property a clip can animate gets ◆ in the
    inspector: it adds a key at the playhead with the value showing there,
    or removes the key that is there (`toggleKeyframe` in
    `src/web/keyframing.ts`); ‹ and › seek to the previous and next key
    (`adjacentKey`). Once a property has keys, its slider shows the value at
    the playhead and moving it sets a key there (auto-key, one undo step per
    gesture). With a key under the playhead, Then picks its ease and Clear
    removes the property's keys. `;` toggles a key on the selected clip for
    the property last used in the inspector (opacity, or volume on audio, by
    default). The selected clip shows one diamond per keyed frame along its
    bottom edge: dragging moves every key on that frame (snapped to frames,
    inside the clip, one undo step through `preview`/`commitFrom`),
    ⌥-click deletes them, a click seeks to them. An audio clip with volume
    keys draws its curve, on the volume line's scale, instead of the line,
    and waveforms follow the keyed gain.
  - **Ducking.** Duck under speech (an audio clip's inspector, or
    right-click an audio track header) works on that whole track.
    `speechRanges` (`src/shared/ducking.ts`) finds speech on the other
    unmuted tracks: transcript words for assets that have a transcript,
    otherwise frames whose peak, after the clip's gain, rises above −26 dBFS.
    `duckingKeys` merges phrases closer than `minGap` (15 frames) or than the
    ramps need, and keys each music clip from its own volume down by `depth`
    (−12 dB; −6 to −24) from `attack` frames (6) before each phrase until
    `release` frames (12) after it. The keys are tagged `duck` and written in
    one undo step (`duckClips`); they replace the clip's volume keys, after a
    confirm when some were set by hand. Remove ducking (`removeDucking`)
    takes out only tagged keys. Depth, attack and release are remembered in
    the browser.
  - **Levels and Normalize.** `src/shared/levels.ts` reads levels from the
    stored peaks with the composition's gain: source peak under the frame
    (following `in` and speed) × `valueAt(volume)` × fades × track volume,
    with muted tracks, hidden video tracks and disabled clips silent
    (`mixLevels`). Each audio track header has a meter and the transport a
    master meter (`components/Meter.tsx`). They redraw through refs from one
    subscription to the playhead, the document and solo (the preview's solo
    applies), fall back at 24 dB/s while playing, hold the peak for a second
    (red above 0 dBFS), and show the level at the playhead when stopped. The
    master combines tracks by power; measured against exports it lands within
    a dB or two of the mix's sample peak. Normalize (`clipPeak`,
    `normalizeGain`, `setClipGain`) sets a clip's gain so its loudest sample
    reaches −1 dBFS, at most 200%; its volume keys scale with it. The
    inspector shows volume in dB beside the percentage.
  - **Command palette.** ⌘K (Ctrl+K) searches every editor command, the
    timeline's markers, the media bin ("Add to timeline") and the Help topics
    with a fuzzy match (`src/shared/fuzzy.ts`). The commands come from one
    registry, `src/web/commands.ts`, which the Help panel also lists with
    their shortcuts; `components/CommandPalette.tsx` maps each command ID to
    the store action it runs.
  - **Gaps and files.** Clicking an empty stretch of the main track
    (when the magnet is off) selects it (`gapAt`), and Delete closes it.
    Overlay and audio tracks are free placement, so their gaps are never
    selected. Files dragged in from the desktop upload
    first, then land where they were dropped.

## Preview and render

`src/remotion/Timeline.tsx` is one Remotion composition. The editor plays it
with `@remotion/player`. In the editor, each video, image and audio clip
mounts one second before it starts (Remotion's `premountFor`), hidden and
already seeked to its in-point, so playback does not hitch at cuts while a new
media element loads. Rendering ignores premounting. `src/node/render.ts` bundles it once per process and
renders with `@remotion/renderer` (headless Chrome + FFmpeg). Draft presets
downscale through `renderMedia({ scale })`, so the layout is identical at
every size. Caption clips are drawn by `chunkCaptions`. It groups words into
lines of up to `wordsPerLine` (default four, one for the one-word look),
balancing longer phrases (5 → 3 + 2). A line breaks after
punctuation and at pauses of 140 ms or more, rounded to whole frames. It
stays up until the next line starts, or 0.6 s after its last word. The word
being spoken is the last one whose start has passed. Each line is drawn in
the clip's caption look (`src/shared/captionLooks.ts`: classic, karaoke, pop,
bounce, typewriter, highlight box, one word): `wordLooks` gives every word's
opacity, scale, lift, accent, fill and box as a pure function of the frame,
and `src/remotion/CaptionLine.tsx` draws it. The inspector's look picker
previews each look with that same component. Title fonts are bundled through `@fontsource`, and the
composition holds rendering until they have loaded.

## Effects, transitions and AI images

- **Effects** (`clip.effects`, catalogue in `src/shared/effects.ts`, rendered
  by `src/remotion/effects.tsx`) are built from CSS filters, SVG
  `feColorMatrix`/`feTurbulence` and overlay layers. They are pure functions
  of the frame and seed. There are no WebGL or HTML-in-canvas paths, so the
  Player in any browser matches the headless render.
- **`autoColor`** stores a per-channel gain and offset solved by
  `src/shared/autocolor.ts`. The CLI samples frames with FFmpeg; the editor
  samples through a canvas.
- **Transitions** (`clip.transition`) animate the incoming clip. If a clip
  ends exactly where this one starts on the same track, it continues past its
  out-point as a "tail" underneath for the transition's length. Its audio
  ramps out while the incoming clip's ramps in.
- **AI stills** come from OpenRouter's Images API (default `meta/muse-image`).
  - Local (`src/node/imagegen.ts`): saved to `<folder>/generated/` and cached
    per prompt in `.videdit/generated.json`.
  - Cloud: `POST /api/p/:id/generate` stores the image in R2. It is enabled
    when the Worker has an `OPENROUTER_API_KEY` secret
    (`videdit deploy --with-openrouter`).
- **Track colours** come from the retro `TRACK_PALETTE` in
  `src/shared/project.ts`, assigned by track number, or from `track.color`.
  In CSS they are a single `--tc` variable, which each skin blends with its
  own panel and ink colours.

## Servers

Both servers expose the same REST shape, so the web app does not care which
one it is talking to. `GET /api/health` reports `mode: 'local' | 'cloud'`.

| Route | Purpose |
|---|---|
| `GET/PUT /api/p/:id` | Project doc. A PUT includes `baseVersion`, and a version mismatch returns `409` with the current doc |
| `GET /api/p/:id/version` | Cheap polling, so other editors reload |
| `POST /api/p/:id/assets` → `PUT …/parts/:n` → `POST …/complete` | Chunked upload in 16 MB parts, under the Worker's 100 MB request limit |
| `PUT …/assets/:aid/thumb`, `…/peaks` | Thumbnail JPEG and waveform peaks (50 values per second, 0–255) |
| `PUT …/assets/:aid/transcript` | Word-timed transcript JSON (edit access) |
| `PUT …/assets/:aid/filmstrip?frames=&every=&width=&height=` | Filmstrip sprite JPEG for a video; returns the asset with `filmstrip` set. The local server makes its own with FFmpeg and ignores it |
| `GET /m/:id/a/:aid[/thumb\|/peaks\|/transcript\|/filmstrip]` | Media with Range support, and its side files |
| `GET/POST/PATCH/DELETE /api/p/:id/comments` | Timecoded comments. Anyone with the link may post |
| `POST /api/p/:id/renders` | Queue a render `{ preset, timelineId, publish?, title?, description? }` |
| `POST /api/p/:id/renders/:rid/publish` | Publish a finished render |
| `GET /api/w/:rid`, `GET /w/:rid` | Public watch data, plus `versions`: the project's other published timelines for the watch page's switcher (`pickVersions`). The Worker adds `og:` tags to the HTML |
| `POST /api/worker/claim`, `…/progress`, `…/upload`, `…/complete`, `…/fail` | Render worker protocol |
| `POST /api/p/:id/push` | Local only: upload the folder to the configured cloud |

**Cloud** (`src/worker/index.ts`): D1 tables `projects`, `assets`, `renders`
and `comments` (`migrations/`). R2 keys are `p/<project>/a/<asset>/source`,
`thumb.jpg`, `filmstrip.jpg`, `peaks.json`, `transcript.json` and
`p/<project>/r/<render>/output.mp4`. The filmstrip's layout is JSON in
`assets.filmstrip` (migration 0003). Static
assets are served by Workers Assets. `/api/*`, `/m/*` and `/w/*` run the
Worker first.

**Local** (`src/node/local-server.ts`): one project folder.
- `videdit.json` holds the doc and assets.
- `.videdit/` holds thumbnails, filmstrips (`thumbs/<assetId>.filmstrip.jpg`), peaks (for every audio and video file; `[]`
  when a video has no sound, and made on first request for older imports;
  each value is the loudest sample of any channel in its 20 ms, decoded at
  48 kHz, so meters and Normalize read true sample peaks),
  transcripts (`transcripts/<assetId>.json`),
  comments, renders and the cloud link (`remote.json`, which includes the
  edit key).
- `exports/` holds rendered files and `imports/` holds uploaded or pulled
  media.
- Renders run in-process, one at a time.
- When `videdit.json` changes on disk without going through the server, the
  version is bumped so open editors reload.

## Access control

| Credential | What it grants |
|---|---|
| Project ID (view link `/p/<id>`) | Watching, scrubbing, downloading sources, commenting |
| Edit key (edit link `/p/<id>#k=<key>`) | Editing, uploading, rendering, publishing. The key is kept in the URL fragment, so it never reaches server logs. Only its SHA-256 is stored, and it can be rotated from the Share dialog |
| Workspace key (Worker secret `WORKSPACE_KEY`) | Everything above, plus creating and deleting projects, listing them, and claiming render jobs. `videdit deploy` generates it and stores it in `~/.config/videdit/config.json` with mode 600 |

A published watch page names its project, so its view link, and with it the
source clips, is public too.

Before any upload (the editor's and `videdit push`), `src/shared/location.ts`
blanks where the clip or photo was shot: the QuickTime `©xyz` atom, the
`com.apple.quicktime.location.*` metadata keys, location samples in timed
metadata (`mebx`) tracks, spare `meta` copies an iPhone leaves in unused
parts of `mdat`, and the JPEG EXIF GPS block.
Each patch has the length of the bytes it replaces, so nothing else in the
file moves, and the local original is untouched. Render workers report a
random name, never the computer's hostname.

## Sync

Editors save with a debounce of about 700 ms, using optimistic concurrency.
They poll the version every 4 s while the tab is visible and nothing is
unsaved. On a conflict, the editor loads the newer document and shows a
notice. Real-time co-editing (a Durable Object per project) is on the roadmap.

## Push and pull

`pushProject` creates the cloud project on the first push. It uploads only the
assets the cloud is missing, keeping their IDs so the doc needs no rewriting,
along with thumbnails. Peaks go up for any audio or video asset whose cloud
copy has none (checked with a `HEAD` request), so older uploads gain video
waveforms on the next push. Transcripts are sent on every push, because
they are small and are often made after the media was uploaded. It then saves the doc against the last synced
cloud version. If the cloud has edits that have not been pulled, push stops
unless `--force` is given. `pullProject` downloads assets that were added in
the cloud into `imports/`, fetches transcripts the folder lacks, and replaces
the local doc.

## Updating a published video

`videdit publish <folder> --replace <watch URL>` re-renders and uploads into
the existing render, using the worker upload endpoints. The watch page keeps
its URL and link previews but serves the corrected video.

## Rendering on Cloudflare

Workers cannot run Chrome. Renders go to a queue and are processed by any
machine running `videdit worker`, which has the workspace key. Moving the same
render code into a Cloudflare Container (4 vCPU, 20 GB disk) is a planned
phase.
