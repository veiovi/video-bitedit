// The command palette: ⌘K (Ctrl+K) opens a search over every editor command,
// the timeline's markers, the media bin and the Help topics. Arrow keys move,
// Enter runs, Esc closes.

import { useEffect, useMemo, useRef, useState } from 'react';
import { addTrack, splitAt } from '../../shared/edits';
import { formatTimecode, newId, timelineDuration } from '../../shared/project';
import { fuzzyScore } from '../../shared/fuzzy';
import { COMMANDS, type CommandId, PALETTE_KEYS } from '../commands';
import { SECTIONS } from '../help';
import {
  activeTimeline,
  copySelection,
  cutSelection,
  deleteSelection,
  detachSelection,
  duplicateSelection,
  freezeAtPlayhead,
  pasteClipboard,
  seekEdit,
  setClipSpeed,
  toggleEnabledSelection,
  toggleLoop,
  useEditor,
  zoomToFit,
} from '../store';
import { openHelp } from './Help';
import { toggleKeyAtPlayhead } from '../keyframing';
import { duckTrack, normalizeClips } from '../audio';
import { appendToTimeline } from './MediaBin';

const OPEN_EVENT = 'videdit:palette';

/** Open the command palette. */
export function openPalette() {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT));
}

const state = () => useEditor.getState();
const panel = (p: ReturnType<typeof state>['panel']) => () => useEditor.setState({ panel: p });

/** What each command does, using the same store actions as the keyboard and menus. */
const RUN: Record<CommandId, () => void> = {
  play: () => state().player?.toggle(),
  start: () => state().seek(0),
  end: () => state().seek(Math.max(0, timelineDuration(activeTimeline(state())) - 1)),
  'prev-edit': () => seekEdit(-1),
  'next-edit': () => seekEdit(1),
  loop: () => toggleLoop(),
  undo: () => state().undo(),
  redo: () => state().redo(),
  split: () => {
    const s = state();
    s.applyTimeline((t) => splitAt(t, s.playhead, s.selection.length ? s.selection : undefined));
  },
  'split-all': () => {
    const s = state();
    s.applyTimeline((t) => splitAt(t, s.playhead));
  },
  delete: () => deleteSelection('auto'),
  'ripple-delete': () => deleteSelection('ripple'),
  lift: () => deleteSelection('lift'),
  copy: () => {
    if (copySelection()) state().setToast('Copied');
  },
  'cut-clips': () => cutSelection(),
  paste: () => pasteClipboard(),
  duplicate: () => duplicateSelection(),
  'select-all': () => state().select(activeTimeline(state()).clips.map((c) => c.id)),
  deselect: () => state().select([]),
  'toggle-enabled': () => toggleEnabledSelection(),
  'detach-audio': () => detachSelection(),
  'freeze-frame': () => freezeAtPlayhead(),
  'speed-half': () => setClipSpeed(useEditor.getState().selection, 0.5),
  'speed-normal': () => setClipSpeed(useEditor.getState().selection, 1),
  'speed-double': () => setClipSpeed(useEditor.getState().selection, 2),
  keyframe: () => toggleKeyAtPlayhead(),
  normalize: () => void normalizeClips(state().selection),
  duck: () => {
    const s = state();
    const clip = activeTimeline(s).clips.find((c) => s.selection.includes(c.id) && c.kind === 'audio');
    if (clip) void duckTrack(clip.trackId);
    else s.setToast('Select an audio clip on the track to duck');
  },
  'add-marker': () => {
    const s = state();
    s.applyTimeline((t) => ({ ...t, markers: [...t.markers, { id: newId(), frame: s.playhead, label: `Marker ${t.markers.length + 1}` }] }));
  },
  magnet: () => state().setRipple(!state().ripple),
  snapping: () => useEditor.setState({ snapping: !state().snapping }),
  linkage: () => state().setLinkage(!state().linkage),
  'zoom-in': () => state().setZoom(state().pxPerFrame * 1.5),
  'zoom-out': () => state().setZoom(state().pxPerFrame / 1.5),
  'zoom-fit': () => zoomToFit(),
  'select-tool': () => useEditor.setState({ tool: 'select' }),
  'blade-tool': () => useEditor.setState({ tool: 'razor' }),
  'add-video-track': () => state().applyTimeline((t) => addTrack(t, 'video')),
  'add-audio-track': () => state().applyTimeline((t) => addTrack(t, 'audio')),
  inspector: panel('inspector'),
  transcript: panel('transcript'),
  comments: panel('comments'),
  history: panel('history'),
  export: panel('export'),
  help: () => openHelp(),
};

/** Commands that change the project; hidden for view-only links. */
const EDITS = new Set<CommandId>(['undo', 'redo', 'split', 'split-all', 'delete', 'ripple-delete', 'lift', 'cut-clips', 'paste', 'duplicate', 'toggle-enabled', 'detach-audio', 'freeze-frame', 'speed-half', 'speed-normal', 'speed-double', 'add-marker', 'magnet', 'add-video-track', 'add-audio-track', 'export']);

interface Item {
  key: string;
  title: string;
  /** Right-hand hint: a shortcut, a timecode or a kind. */
  hint?: string;
  kind: string;
  search: string;
  run: () => void;
}

function buildItems(): Item[] {
  const s = state();
  const t = activeTimeline(s);
  const items: Item[] = COMMANDS.filter((c) => s.canEdit || !EDITS.has(c.id)).map((c) => ({
    key: `cmd:${c.id}`,
    title: c.title,
    hint: 'keys' in c ? c.keys : undefined,
    kind: c.group,
    search: `${c.title} ${'aliases' in c ? c.aliases : ''}`,
    run: RUN[c.id],
  }));
  for (const m of [...t.markers].sort((a, b) => a.frame - b.frame)) {
    items.push({ key: `marker:${m.id}`, title: `Go to marker: ${m.label}`, hint: formatTimecode(m.frame, t.fps), kind: 'Marker', search: `marker ${m.label}`, run: () => s.seek(m.frame) });
  }
  if (s.canEdit) {
    for (const a of s.assets.filter((x) => x.status === 'ready')) {
      items.push({ key: `asset:${a.id}`, title: `Add to timeline: ${a.name}`, kind: 'Media', search: `add ${a.name} ${a.kind}`, run: () => appendToTimeline(a) });
    }
  }
  for (const h of SECTIONS) {
    items.push({ key: `help:${h.id}`, title: `Help: ${h.title}`, kind: 'Help', search: `help ${h.title} ${h.items.map((i) => i[0]).join(' ')}`, run: () => openHelp(h.id) });
  }
  items.push({ key: 'help:keys', title: 'Help: Keyboard shortcuts', kind: 'Help', search: 'help keyboard shortcuts keys', run: () => openHelp('keys') });
  return items;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const [items, setItems] = useState<Item[]>([]);

  useEffect(() => {
    const show = () => {
      setItems(buildItems());
      setQuery('');
      setActive(0);
      setOpen(true);
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (open) setOpen(false);
        else show();
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_EVENT, show);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_EVENT, show);
    };
  }, [open]);

  const shown = useMemo(() => {
    if (!query.trim()) return items;
    return items
      .map((item) => {
        const title = fuzzyScore(query, item.title);
        const extra = fuzzyScore(query, item.search);
        const score = title !== null ? title + 1 : extra;
        return { item, score };
      })
      .filter((x): x is { item: Item; score: number } => x.score !== null)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.item);
  }, [items, query]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const run = (item: Item | undefined) => {
    if (!item) return;
    setOpen(false);
    // After the palette closes, so focus and keys go back to the editor first.
    requestAnimationFrame(() => item.run());
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(shown.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(shown[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div className="modal-backdrop palette-backdrop" onPointerDown={() => setOpen(false)}>
      <div className="palette" role="dialog" aria-label="Command palette" onPointerDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          className="palette-input"
          placeholder="Type a command, marker, clip or help topic…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Search commands"
          aria-activedescendant={shown[active] ? `palette-${active}` : undefined}
        />
        <div className="palette-list" ref={list} role="listbox">
          {shown.map((item, i) => (
            <div
              key={item.key}
              id={`palette-${i}`}
              data-i={i}
              role="option"
              aria-selected={i === active}
              className={`palette-item ${i === active ? 'on' : ''}`}
              onPointerMove={() => i !== active && setActive(i)}
              onClick={() => run(item)}
            >
              <span className="palette-title">{item.title}</span>
              <span className="palette-kind">{item.kind}</span>
              {item.hint && <kbd>{item.hint}</kbd>}
            </div>
          ))}
          {shown.length === 0 && <div className="palette-empty">Nothing matches “{query}”.</div>}
        </div>
        <div className="palette-foot">
          ↑↓ to move · Enter to run · Esc to close · {PALETTE_KEYS} to open
        </div>
      </div>
    </div>
  );
}
