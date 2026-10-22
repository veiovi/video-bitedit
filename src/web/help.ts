// The words behind the ? buttons and the Help panel. Each tip is a sentence
// or two; each section of the Help panel breaks one area down in full.

export interface HelpSection {
  id: string;
  title: string;
  intro: string;
  items: [string, string][];
}

export const SECTIONS: HelpSection[] = [
  {
    id: 'start',
    title: 'How it fits together',
    intro:
      'A project is a timeline plus the media it uses. It can live on your computer, in your own Cloudflare account, or both. People and AI agents edit the same project.',
    items: [
      ['Local', '`videdit open <folder>` turns a folder of clips into a project and opens this editor at 127.0.0.1:4848. The timeline is saved as videdit.json next to your media. Nothing leaves your computer until you share it.'],
      ['Cloud', '`videdit deploy` (with a Cloudflare API token) sets up a Worker, a D1 database and an R2 bucket on your own account. Projects there open in any browser through an edit link.'],
      ['Agents', 'An agent such as Claude Code or Codex uses the `videdit` CLI: it transcribes the speech, writes a cut list in seconds, and the open editor reloads while it works. You finish the cut by hand.'],
      ['Timelines', 'One project can hold several timelines, for example the full movie and a 9:16 short made from it. Switch between them with the menu above the preview.'],
      ['Saving', 'Every change saves on its own. The label in the top bar says Saved, Saving… or Not saved.'],
    ],
  },
  {
    id: 'media',
    title: 'Media bin',
    intro: 'Every video, audio file and image in the project. Drag them onto the timeline, or double-click to add one at the end.',
    items: [
      ['Import', 'Use + or drop files from your desktop onto the bin. In the cloud they upload to your R2 bucket; locally they stay in the folder.'],
      ['Tabs and filter', 'All, Video, Audio and Images narrow the list; the filter box searches by name.'],
      ['Text presets', 'Title, Caption and Lower third drag onto a video track as text clips.'],
      ['Thumbnails', 'Videos get a thumbnail and a filmstrip, and audio a waveform, so you can see what you are cutting.'],
      ['Removing', 'Removed media is hidden, not destroyed, and comes back when a restored version uses it.'],
    ],
  },
  {
    id: 'preview',
    title: 'Preview and timelines',
    intro: 'The preview plays the timeline exactly as the export will look: both come from the same Remotion composition.',
    items: [
      ['Play', 'Space or K plays and pauses; J and L shuttle backward and forward, faster each press.'],
      ['Loop (⇧L)', 'The loop button under the preview repeats the in/out range, or else the selected clips, or else the whole timeline. The ruler shades what repeats.'],
      ['Play range (⇧Space)', 'Plays from the in point to the out point once and stops on the out point.'],
      ['Timeline menu', 'Switch timelines, make a 9:16 short from the current one (optionally only a range in seconds), start an empty 16:9, 9:16 or 1:1 timeline, duplicate, rename or delete.'],
      ['Shorts', 'A short crops each shot to fill the vertical frame. Reframe a shot with Transform → Position in the inspector.'],
      ['Original size', 'Timelines an agent builds from footage keep the footage\'s own shape (phone video shot upright stays portrait).'],
    ],
  },
  {
    id: 'timeline',
    title: 'Timeline editing',
    intro:
      'Video tracks (V1 at the bottom, higher tracks draw on top) and audio tracks. V1 is the main track, marked MAIN: it holds the story, and everything else sits above or below it.',
    items: [
      ['Select tool (V / A)', 'Click a clip to select it, ⇧-click to add, drag on empty space to box-select. Drag clips to move them; drag their edges to trim.'],
      ['Blade tool (C / B)', 'Click a clip to cut it there. S or ⌘B splits the selection (or every track) at the playhead; ⇧⌘B splits every track.'],
      ['Select forward / backward (] / [)', 'Click to select everything to the right (or left) of that point, then drag it all at once. ⇧-click picks one track only.'],
      ['Magnet (P)', 'Keeps the main track gapless, like CapCut. Trims and deletes close up, drops insert between clips and push the rest right, and moving a clip reorders it. Turning it on closes existing gaps.'],
      ['Linkage (`)', 'When on, captions, overlays and audio above and below follow the main-track edits, so they stay in sync. When off, only the main track moves.'],
      ['Snapping (N)', 'Clips and the playhead snap to cuts, markers and the playhead. Hold ⌘ while dragging to ignore snapping for one drag.'],
      ['Delete', '⌫ deletes (main-track clips ripple while the magnet is on). X is ripple delete: close the gap. Z is lift: leave the gap. Q and W delete everything left or right of the playhead in the clip under it.'],
      ['Gaps', 'Click a gap on the main track and press ⌫ (or double-click it) to close it.'],
      ['Clipboard', '⌘C, ⌘X and ⌘V copy, cut and paste at the playhead; ⌘D duplicates; ⌥⇧-drag drags a copy (⌥-drag also does, for anything that cannot slip).'],
      ['Speed', 'Inspector → Timing → Speed plays a video or audio clip from 0.25× to 4×. The clip keeps its in-point and plays the same footage, so it gets shorter or longer; on the main track with the magnet on, the rest follows. Sound keeps its pitch. The clip shows its speed, such as 2×.'],
      ['Freeze frame (⇧F)', 'Holds the frame under the playhead for two seconds: the clip splits there and a silent still of that exact frame goes in. On the main track with the magnet on, everything after it moves right; elsewhere the still covers what follows.'],
      ['Roll (⌥-drag a cut)', 'Hold ⌥ and drag the edge between two touching clips to move the cut: one clip gets longer and the other shorter, so nothing else moves. Each side stops at the end of its footage.'],
      ['Slip (⌥-drag a clip)', 'Hold ⌥ and drag a video or audio clip to play a different part of its footage in the same place and length. Drag right for earlier footage, left for later. The preview shows the clip\'s first frame while you drag.'],
      ['Trim to playhead (⌥[ ⌥])', 'Moves the selected clip\'s start or end to the playhead, shortening it or, if there is footage left, lengthening it. ⇧[ and ⇧] do the same. Main-track clips ripple while the magnet is on.'],
      ['Copy attributes (⌥⌘C, ⌥⌘V)', 'Copies a clip\'s look (effects, transition, opacity, transform, speed and volume) and pastes it onto every selected clip. A pasted effect replaces one of the same type instead of adding a second.'],
      ['Nudge', ', and . (or ⌥← ⌥→) move the selected clips a frame; add ⇧ for a second.'],
      ['Turn off', '⇧E turns clips off without deleting them; they are skipped in the preview and the export.'],
      ['Fades', 'Drag the small knobs at a clip\'s top corners to fade it in or out.'],
      ['Volume line', 'Drag the line across an audio clip up or down to set its volume (⇧ for fine steps). 100% sits a third of the way down and is sticky; double-click the line to go back to 100%.'],
      ['Tracks', 'Each track header can hide, mute, solo, lock or remove its track and has a volume slider. + Video and + Audio add tracks (up to 10 and 8).'],
      ['Track headers', 'Double-click a track\'s name to rename it. The coloured stripe on the left picks its colour, which its clips take on. The arrow button switches the row between small, normal and large. Drag a header up or down to reorder tracks of the same kind; the bottom video track is always the main track.'],
      ['Solo (S)', 'Plays only the soloed tracks in the preview, so you can listen to one voice or the music alone. Solo more than one to hear them together. It never changes the export.'],
      ['In and out (I, O)', 'I marks the in point and O the out point at the playhead; the range includes the playhead frame at O. The ruler shades the range and shows its length in its corner. Drag either end to move it; it snaps to cuts and markers. ⌥X clears both. The range is remembered for each timeline in this browser and is not part of the project.'],
      ['Lift and extract a range (⇧Z, ⇧X)', '⇧Z lifts the in/out range: what every unlocked track holds there is removed and a gap stays. ⇧X extracts it: the gap closes and everything after moves left, markers included. Locked tracks keep their clips. Without a range, ⇧Z fits the timeline to the window and ⇧X is ripple delete. Both are also in the right-click menu.'],
      ['Markers', 'M adds a marker at the playhead; ⌥M adds a range marker over the in/out range (or the selected clips). Click a marker to jump to it, drag it to move it (it snaps), and drag a range marker\'s right end to change its length. Double-click a marker to rename it, give it a colour, make it a point or delete it (Delete). Markers move with ripple edits on the main track. ↑ and ↓ jump between cuts and markers.'],
      ['Marker list and chapters', 'The Markers button in the ruler\'s corner lists every marker with its time; click one to jump there. Copy as YouTube chapters copies the point markers as "0:00 Title" lines. The first chapter starts at 0:00 (an Intro is added, or a marker in the first 10 s moves there), and markers closer than 10 s to the chapter before or to the end are skipped and named.'],
      ['Zoom', '= and − zoom, 0 (or ⇧Z, when no in/out range is set) fits the whole timeline, ⌘-scroll or pinch zooms around the pointer. Zoomed in far enough, the ruler marks every frame. Dragging near the left or right edge scrolls the timeline.'],
      ['Right-click', 'Opens a menu for the clip or the empty spot under the pointer: split, delete, copy, paste, add a marker, mark in or out there, and the in/out range actions.'],
    ],
  },
  {
    id: 'drops',
    title: 'Drag, drop and replace',
    intro: 'Drop media from the bin or from your desktop. Where you let go decides what happens; a hint shows it before you drop.',
    items: [
      ['Onto empty space', 'Places the clip there, overwriting whatever is underneath on that track.'],
      ['Onto the main track with the magnet on', 'Inserts at the nearest cut and pushes everything after it to the right.'],
      ['Onto the middle of a clip', 'Replaces it. The new media takes the clip\'s place at exactly the same length, and a dialog lets you choose which part of a longer clip plays. Media shorter than the clip is refused; images always fit.'],
      ['Onto the edge of a clip', 'The outer fifth of a clip inserts before or after it instead of replacing it.'],
      ['Keep effects', 'The replace dialog keeps the old clip\'s effects, fades and framing unless you untick it.'],
      ['From the inspector', 'Media → Replace swaps a selected clip\'s media without dragging.'],
    ],
  },
  {
    id: 'inspector',
    title: 'Inspector',
    intro: 'Shows the selected clip. With nothing selected it shows the timeline: its size, the title style for text, the name and the background colour.',
    items: [
      ['Transform', 'Scale, position, rotation and opacity, and Fit: contain (letterbox) or cover (crop to fill).'],
      ['Media', 'Which file the clip plays, with Replace to swap it.'],
      ['Timing', 'Start, length, the source in-point, fade in and out, in seconds, and speed (presets from 0.25× to 4×, or type one).'],
      ['Transition in', 'Fade, dip to black or white, slide, whip, wipe or zoom from the clip before it.'],
      ['Audio', 'Volume and Detach audio, which moves a video clip\'s sound to its own audio clip so you can trim and fade it separately.'],
      ['Effects', 'Auto colour, colour grades (warm, cool, teal-orange, mono, noir, vintage, faded, punchy), film grain, vignette, light leak, glitch, Ken Burns, zoom punch and blur. They stack in order.'],
      ['Text', 'Words, style preset, animation (fade, rise, pop, slam, typewriter), size and colour.'],
      ['Title style', 'Clean, Bold or Cinematic: the default look for every title and caption in the project.'],
    ],
  },
  {
    id: 'captions',
    title: 'Captions and transcripts',
    intro: 'Captions come from word-timed transcripts made on your own computer with Whisper.',
    items: [
      ['Transcribe', '`videdit transcribe <folder>` transcribes every clip with speech and stores the word timings next to it.'],
      ['Caption clips', 'Show 3–4 words at a time, start a new line after punctuation or a pause, and light up the word being spoken.'],
      ['Editing', 'Trim, split or move a caption clip and its words stay in sync. Change the size, colour and spoken-word colour in the inspector.'],
      ['Shorts', 'A derived short gets its own larger captions placed for vertical video.'],
    ],
  },
  {
    id: 'ai',
    title: 'AI images, slides and motion',
    intro: 'Extras for explainers. Images need an OpenRouter key; slides and motion clips are drawn locally.',
    items: [
      ['AI stills', 'Set `OPENROUTER_API_KEY` (or run `videdit config openrouter-key`) and `videdit generate` makes images in one shared style. A cut list can ask for them by prompt.'],
      ['Slides', 'Remotion slides in title, bullets, stat, quote, image and split layouts with five palettes.'],
      ['HyperFrames', 'HTML and GSAP motion clips rendered to video inside the project.'],
    ],
  },
  {
    id: 'comments',
    title: 'Comments',
    intro: 'Notes pinned to a moment in the timeline. Anyone with a view or edit link can leave one.',
    items: [
      ['Add', 'Move the playhead, write the note and post it. It shows as a pin above the timeline.'],
      ['Jump', 'Click a comment\'s timecode to go to that moment, or click its pin on the ruler: the playhead jumps there and the comment lights up in this panel.'],
      ['Resolve', 'Resolved comments leave the timeline but stay in the list, and can be reopened.'],
    ],
  },
  {
    id: 'history',
    title: 'History and saving',
    intro: 'Every edit autosaves, and History keeps earlier versions so nothing is lost.',
    items: [
      ['Snapshots', 'One about every 30 seconds of editing, plus one for each agent edit, cut-list run, push, pull and restore. The last 300 are kept.'],
      ['Restore', 'Restoring makes the old version the newest one; the version you left stays in the list, so you can go back.'],
      ['Crash safety', 'Unsaved edits are mirrored in this browser and come back if the tab closes.'],
      ['Undo', '⌘Z and ⇧⌘Z undo and redo edits in this session.'],
    ],
  },
  {
    id: 'export',
    title: 'Export and publish',
    intro: 'Renders the current timeline to MP4 (or MP3) with the same composition the preview uses, with loudness normalised to −14 LUFS.',
    items: [
      ['Formats', 'MP4 at project size, a quicker 720p draft, or audio only.'],
      ['Range', 'Export the whole timeline, the in/out range, or the span of a range marker. Watch pages show the exported part\'s length.'],
      ['Still', 'Export still (PNG) saves the frame under the playhead as an image. It renders like any other export: on this computer, or on a render worker in the cloud. Stills are not published.'],
      ['Render', 'Makes a file without publishing. Locally it renders on this computer into the folder\'s exports/.'],
      ['Render & publish', 'Also makes a public watch page. Ask before publishing someone else\'s footage.'],
      ['Render worker', 'In the cloud, renders run on any computer running `npx videdit worker`, logged in with the workspace key. Queued renders wait until one is running.'],
      ['Watch pages', 'Show the latest render of each published timeline, with a switcher between the full movie and the short, and a download link.'],
    ],
  },
  {
    id: 'share',
    title: 'Sharing and keys',
    intro: 'Three kinds of access, each its own link or key. Treat the edit link and the workspace key like passwords.',
    items: [
      ['Edit link', 'Opens this project with full editing, including every source clip. Reset it in Share to cut off everyone who has the old one.'],
      ['View link', 'Watch, scrub and comment, but not edit.'],
      ['Watch page', 'A public page for one published video. It links to the view-only timeline, so anyone with it can also watch and download the source clips.'],
      ['Location', 'Uploads blank out where a phone recorded the clip or photo (GPS in the video or EXIF), so shared clips do not reveal where they were shot. The original on your computer keeps it.'],
      ['Workspace key', 'Creates projects, publishes and runs render workers. `videdit key` shows it; `videdit key rotate` replaces it everywhere. Never post it.'],
      ['Local projects', 'Share → Share to cloud uploads the timeline and its clips to your own Cloudflare account and returns the links.'],
    ],
  },
  {
    id: 'skins',
    title: 'Skins',
    intro: 'Click the name at the top left to change how the editor looks. Five skins, each with its own colours and type; the video itself is not affected.',
    items: [],
  },
];

export type TipId =
  | 'media'
  | 'preview'
  | 'timelines'
  | 'side'
  | 'timeline'
  | 'tools'
  | 'inspector-clip'
  | 'inspector-timeline'
  | 'title-style'
  | 'transform'
  | 'replace'
  | 'timing'
  | 'transition'
  | 'audio'
  | 'effects'
  | 'captions'
  | 'text'
  | 'comments'
  | 'history'
  | 'export'
  | 'worker'
  | 'share'
  | 'edit-link'
  | 'view-link'
  | 'workspace'
  | 'replace-dialog'
  | 'projects'
  | 'published'
  | 'save';

export const TIPS: Record<TipId, { text: string; section: string }> = {
  media: { text: 'Your clips, audio and images. Drag onto the timeline, double-click to append, or drop files here to import.', section: 'media' },
  preview: { text: 'Plays the timeline exactly as it will export. Space plays and pauses.', section: 'preview' },
  timelines: { text: 'A project can hold several timelines, like the full movie and a 9:16 short. Make a short from this menu.', section: 'preview' },
  side: { text: 'Inspector edits the selection, Comments holds notes, History restores earlier versions, Export renders and publishes.', section: 'inspector' },
  timeline: { text: 'V1 is the main track; higher video tracks draw on top. Drag to move, drag edges to trim, S to split.', section: 'timeline' },
  tools: { text: 'Select, blade, select backward and forward. Then three switches: the magnet keeps the main track gapless, linkage makes captions and overlays follow it, and snapping lines clips up. Hover a button for its key.', section: 'timeline' },
  'inspector-clip': { text: 'Everything about the selected clip: framing, timing, transition, sound and effects.', section: 'inspector' },
  'inspector-timeline': { text: 'Nothing is selected, so this shows the timeline. Select a clip to edit it.', section: 'inspector' },
  'title-style': { text: 'The default look for every title and caption in this project.', section: 'inspector' },
  transform: { text: 'Size, position, rotation and opacity. On a vertical short, Position chooses which part of a wide shot shows.', section: 'inspector' },
  replace: { text: 'Swap the clip\'s media, keeping its place and length. You can also drop new media on the middle of a clip.', section: 'drops' },
  timing: { text: 'Where the clip sits, how long it runs, where in the source it starts, and its fades.', section: 'inspector' },
  transition: { text: 'How this clip enters from the one before it on the same track.', section: 'inspector' },
  audio: { text: 'Volume. Detach audio moves a video\'s sound to its own clip.', section: 'inspector' },
  effects: { text: 'Colour, grain, light and motion effects, applied top to bottom. Same in preview and export.', section: 'inspector' },
  captions: { text: 'Words come from the transcript and light up as they are spoken. Edit the look here.', section: 'captions' },
  text: { text: 'The words on screen, their style preset, animation and colour.', section: 'inspector' },
  comments: { text: 'Notes pinned to a moment. Click a timecode to jump there.', section: 'comments' },
  history: { text: 'Earlier versions of this project. Restoring never overwrites anything.', section: 'history' },
  export: { text: 'Render a file, or render and publish a public watch page.', section: 'export' },
  worker: { text: 'Cloud renders run on a computer running the render worker. Start one with the command below.', section: 'export' },
  share: { text: 'Edit links give full access including source clips; view links only watch and comment.', section: 'share' },
  'edit-link': { text: 'Anyone with this link can edit the project and download its clips. Reset it if it leaks.', section: 'share' },
  'view-link': { text: 'Watch, scrub and comment. No editing.', section: 'share' },
  workspace: { text: 'Creates projects, publishes and runs render workers. Keep it private; `videdit key rotate` replaces it.', section: 'share' },
  'replace-dialog': { text: 'The new media keeps this clip\'s place and length. Drag the window to choose which part plays.', section: 'drops' },
  projects: { text: 'Projects in your cloud workspace. Trashed ones can be restored.', section: 'start' },
  published: { text: 'Public watch pages. Anyone with the link can watch.', section: 'export' },
  save: { text: 'Every change saves on its own. History keeps earlier versions.', section: 'history' },
};

export const SHORTCUTS: [string, string][] = [
  ['Space / K', 'Play / pause'],
  ['J · L', 'Shuttle back · forward'],
  ['⇧L', 'Loop the in/out range (or the selection, or everything) on · off'],
  ['I · O · ⌥X', 'Mark in · mark out at the playhead · clear both'],
  ['⇧Space', 'Play the in/out range once'],
  ['⇧Z · ⇧X', 'Lift · extract the in/out range (without one: fit · ripple delete)'],
  ['← →', 'Frame step (⇧ = 1 s)'],
  ['↑ ↓', 'Previous · next cut or marker'],
  ['Click the timecode', 'Type a time to jump to (12.5, 1:05, +2)'],
  ['⌘B / S · ⇧⌘B', 'Split selection · all tracks'],
  ['Q · W', 'Delete left · right of playhead'],
  ['⌥[ · ⌥] (or ⇧[ · ⇧])', 'Trim selected clip start · end to playhead'],
  ['⇧F', 'Freeze frame: hold the frame under the playhead for 2 s'],
  ['⌫ · X · Z', 'Delete (ripples on main track) · ripple delete · lift'],
  ['Click a main-track gap, ⌫', 'Close that gap'],
  ['[ · ]', 'Select backward · forward, then drag'],
  ['Drag on empty space', 'Box select (⇧ adds)'],
  ['P · N · `', 'Magnet · snapping · linkage'],
  ['Hold ⌘ while dragging', 'Ignore snapping'],
  ['A / V · B / C', 'Select tool · blade tool'],
  ['⌘A', 'Select all'],
  ['⌘C · ⌘X · ⌘V · ⌘D', 'Copy · cut · paste at playhead · duplicate'],
  ['⌥-drag a video or audio clip', 'Slip: play a different part of its footage in place'],
  ['⌥-drag the cut between two clips', 'Roll the cut: one clip longer, the other shorter'],
  ['⌥⇧-drag a clip', 'Drag a copy, leaving the original'],
  ['⌥⌘C · ⌥⌘V', 'Copy a clip\'s look · paste it onto the selection'],
  [', . · ⌥← ⌥→', 'Nudge selected clips a frame (⇧ = 1 s)'],
  ['⇧E', 'Turn selected clips off · on'],
  ['Drag an audio clip\'s line', 'Volume (⇧ fine, double-click for 100%)'],
  ['S in a track header', 'Solo: hear only that track in the preview'],
  ['Double-click a track name', 'Rename it; drag the header to reorder'],
  ['Right-click', 'Clip menu · paste, markers, in/out'],
  ['⌘Z · ⇧⌘Z', 'Undo · redo'],
  ['= − · 0', 'Zoom in · out · fit (⇧Z fits too when no in/out range is set)'],
  ['⌘-scroll / pinch', 'Zoom around the pointer'],
  ['M · ⌥M', 'Add a marker · a range marker over the in/out range or selection'],
  ['Drag · double-click a marker', 'Move it (drag a range marker\'s end to resize) · rename, colour or delete'],
  ['Click a comment pin', 'Jump there and show the comment'],
  ['?', 'Open this help'],
];
