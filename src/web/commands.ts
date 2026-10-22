// The editor's commands: one list that the command palette (⌘K) searches and
// runs, and the Help panel lists with their shortcuts. What each command does
// lives with the palette (components/CommandPalette.tsx), keyed by these IDs.

export type CommandGroup = 'Playback' | 'Edit' | 'Timeline' | 'Panels';

export interface CommandSpec {
  id: string;
  title: string;
  group: CommandGroup;
  /** Shortcut as shown to people (⌘ is Ctrl on Windows and Linux). */
  keys?: string;
  /** Extra words that should find it. */
  aliases?: string;
}

export const COMMANDS = [
  { id: 'play', title: 'Play / pause', group: 'Playback', keys: 'Space', aliases: 'stop start' },
  { id: 'start', title: 'Go to start', group: 'Playback', keys: 'Home', aliases: 'beginning' },
  { id: 'end', title: 'Go to end', group: 'Playback', keys: 'End' },
  { id: 'prev-edit', title: 'Previous cut or marker', group: 'Playback', keys: '↑' },
  { id: 'next-edit', title: 'Next cut or marker', group: 'Playback', keys: '↓' },
  { id: 'loop', title: 'Loop playback on / off', group: 'Playback', keys: '⇧L', aliases: 'repeat' },

  { id: 'undo', title: 'Undo', group: 'Edit', keys: '⌘Z' },
  { id: 'redo', title: 'Redo', group: 'Edit', keys: '⇧⌘Z' },
  { id: 'split', title: 'Split at playhead', group: 'Edit', keys: 'S · ⌘B', aliases: 'cut blade razor' },
  { id: 'split-all', title: 'Split every track at playhead', group: 'Edit', keys: '⇧⌘B', aliases: 'cut blade razor' },
  { id: 'delete', title: 'Delete selection', group: 'Edit', keys: '⌫', aliases: 'remove' },
  { id: 'ripple-delete', title: 'Ripple delete selection', group: 'Edit', keys: 'X', aliases: 'close gap remove' },
  { id: 'lift', title: 'Lift selection (leave the gap)', group: 'Edit', keys: 'Z', aliases: 'remove delete' },
  { id: 'copy', title: 'Copy', group: 'Edit', keys: '⌘C' },
  { id: 'cut-clips', title: 'Cut clips', group: 'Edit', keys: '⌘X' },
  { id: 'paste', title: 'Paste at playhead', group: 'Edit', keys: '⌘V' },
  { id: 'duplicate', title: 'Duplicate selection', group: 'Edit', keys: '⌘D', aliases: 'copy' },
  { id: 'select-all', title: 'Select all clips', group: 'Edit', keys: '⌘A' },
  { id: 'deselect', title: 'Deselect', group: 'Edit', keys: 'Esc', aliases: 'clear selection' },
  { id: 'toggle-enabled', title: 'Turn selected clips off / on', group: 'Edit', keys: '⇧E', aliases: 'disable enable' },
  { id: 'detach-audio', title: 'Detach audio from selected video', group: 'Edit', aliases: 'separate sound' },
  { id: 'freeze-frame', title: 'Freeze frame at playhead', group: 'Edit', keys: '⇧F', aliases: 'hold still' },
  { id: 'speed-half', title: 'Speed: half (0.5×)', group: 'Edit', aliases: 'slow motion retime' },
  { id: 'speed-normal', title: 'Speed: normal (1×)', group: 'Edit', aliases: 'reset retime' },
  { id: 'speed-double', title: 'Speed: double (2×)', group: 'Edit', aliases: 'fast retime' },
  { id: 'add-marker', title: 'Add marker at playhead', group: 'Edit', keys: 'M' },
  { id: 'keyframe', title: 'Add / remove keyframe at playhead', group: 'Edit', keys: ';', aliases: 'animate key diamond' },
  { id: 'normalize', title: 'Normalize selected clips to −1 dBFS', group: 'Edit', aliases: 'gain loudness level peak' },
  { id: 'duck', title: 'Duck the selected audio clip\'s track under speech', group: 'Edit', aliases: 'music voice lower volume ducking' },

  { id: 'magnet', title: 'Magnet (gapless main track) on / off', group: 'Timeline', keys: 'P', aliases: 'ripple' },
  { id: 'snapping', title: 'Snapping on / off', group: 'Timeline', keys: 'N', aliases: 'snap' },
  { id: 'linkage', title: 'Linkage on / off', group: 'Timeline', keys: '`', aliases: 'link sync' },
  { id: 'zoom-in', title: 'Zoom in', group: 'Timeline', keys: '=' },
  { id: 'zoom-out', title: 'Zoom out', group: 'Timeline', keys: '−' },
  { id: 'zoom-fit', title: 'Zoom to fit', group: 'Timeline', keys: '0 · ⇧Z', aliases: 'whole timeline' },
  { id: 'select-tool', title: 'Select tool', group: 'Timeline', keys: 'V · A', aliases: 'pointer' },
  { id: 'blade-tool', title: 'Blade tool', group: 'Timeline', keys: 'C · B', aliases: 'razor cut' },
  { id: 'add-video-track', title: 'Add video track', group: 'Timeline' },
  { id: 'add-audio-track', title: 'Add audio track', group: 'Timeline' },

  { id: 'inspector', title: 'Open Inspector', group: 'Panels' },
  { id: 'transcript', title: 'Open Transcript (edit by text)', group: 'Panels', aliases: 'text words captions' },
  { id: 'comments', title: 'Open Comments', group: 'Panels', aliases: 'notes' },
  { id: 'history', title: 'Open History', group: 'Panels', aliases: 'versions restore' },
  { id: 'export', title: 'Export / render', group: 'Panels', aliases: 'publish mp4 render' },
  { id: 'help', title: 'Open Help', group: 'Panels', keys: '?' },
] as const satisfies readonly CommandSpec[];

export type CommandId = (typeof COMMANDS)[number]['id'];

/** The shortcut that opens the command palette. */
export const PALETTE_KEYS = '⌘K';
