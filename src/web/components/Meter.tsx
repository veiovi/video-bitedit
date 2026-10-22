// Level meters: one per audio track header and a master meter by the preview
// transport. Levels come from the stored waveform peaks at the playhead,
// shaped by the same gain the composition applies (see shared/levels.ts), so
// no audio is tapped and the meters agree with the export. The preview's solo
// applies, as it does to what you hear.
//
// Meters redraw through refs from one shared subscription to the playhead,
// never through React renders. While playing they fall back at 24 dB/s; when
// stopped they show the level at the playhead. A line holds the peak for one
// second and turns red above 0 dBFS.

import { useEffect, useRef } from 'react';
import { type MixLevels, audible, mixLevels, toDb } from '../../shared/levels';
import { withSolo } from '../../shared/project';
import { ensurePeaks, peaksNow, usePeakStore } from '../peaks';
import { activeTimeline, useEditor } from '../store';

const FLOOR_DB = -60;
const CEIL_DB = 6;
const HOLD_MS = 1000;
const FALL_DB_PER_S = 24;

/** Position on the meter, 0..1, for a level in dBFS. */
const meterPos = (db: number) => Math.max(0, Math.min(1, (db - FLOOR_DB) / (CEIL_DB - FLOOR_DB)));
/** Where 0 dBFS sits on the meter. */
export const ZERO_POS = meterPos(0);

type Listener = (mix: MixLevels, playing: boolean) => void;
const listeners = new Set<Listener>();
let stop: (() => void) | null = null;
let lastAssets = '';

function compute() {
  const s = useEditor.getState();
  if (!s.doc) return;
  const t = activeTimeline(s);
  const assets = [...new Set(t.clips.filter(audible).map((c) => c.assetId!))];
  const key = `${s.projectId}:${assets.join(',')}`;
  if (key !== lastAssets) {
    lastAssets = key;
    ensurePeaks(s.projectId, assets);
  }
  const mix = mixLevels(withSolo(t, s.solo), s.playhead, (id) => peaksNow(s.projectId, id));
  for (const l of listeners) l(mix, s.playing);
}

/** Start the shared subscription with the first meter, and end it with the last. */
function subscribe(l: Listener): () => void {
  listeners.add(l);
  if (!stop) {
    const a = useEditor.subscribe((s, prev) => {
      if (s.playhead !== prev.playhead || s.doc !== prev.doc || s.solo !== prev.solo || s.timelineId !== prev.timelineId || s.playing !== prev.playing) compute();
    });
    const b = usePeakStore.subscribe(compute);
    stop = () => {
      a();
      b();
    };
  }
  compute();
  return () => {
    listeners.delete(l);
    if (listeners.size === 0 && stop) {
      stop();
      stop = null;
    }
  };
}

/** A level meter for one track (or the master), vertical or horizontal. */
export function LevelMeter({ source, orientation = 'vertical' }: { source: string | 'master'; orientation?: 'vertical' | 'horizontal' }) {
  const bar = useRef<HTMLDivElement>(null);
  const hold = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let shown = -Infinity;
    let shownAt = performance.now();
    let held = -Infinity;
    let heldAt = 0;
    let release: ReturnType<typeof setTimeout> | null = null;
    const side = orientation === 'vertical' ? 'bottom' : 'left';
    const draw = (level: number, playing: boolean) => {
      const now = performance.now();
      const db = toDb(level);
      shown = playing ? Math.max(db, shown - (FALL_DB_PER_S * (now - shownAt)) / 1000) : db;
      shownAt = now;
      if (db >= held || now - heldAt > HOLD_MS) {
        held = db;
        heldAt = now;
      }
      // The bar is the whole scale (green, amber, red above 0 dBFS), cut off at the level.
      const rest = `${(1 - meterPos(shown)) * 100}%`;
      if (bar.current) bar.current.style.clipPath = orientation === 'vertical' ? `inset(${rest} 0 0 0)` : `inset(0 ${rest} 0 0)`;
      if (hold.current) {
        hold.current.style[side] = `${meterPos(held) * 100}%`;
        hold.current.style.visibility = held > FLOOR_DB ? 'visible' : 'hidden';
        hold.current.classList.toggle('over', held > 0);
      }
      if (root.current) root.current.title = `${source === 'master' ? 'Master' : 'Track'} level ${db === -Infinity ? '−∞' : db.toFixed(1)} dBFS, peak ${held === -Infinity ? '−∞' : held.toFixed(1)} dBFS`;
      // Let the held peak fall back once its second is up, even when nothing else changes.
      if (release) clearTimeout(release);
      if (held > db) release = setTimeout(() => draw(level, false), HOLD_MS + 20);
    };
    const off = subscribe((mix, playing) => draw(source === 'master' ? mix.master : (mix.tracks[source] ?? 0), playing));
    return () => {
      off();
      if (release) clearTimeout(release);
    };
  }, [source, orientation]);
  return (
    <div ref={root} className={`level-meter ${orientation} ${source === 'master' ? 'master' : ''}`} aria-hidden>
      <div ref={bar} className="level-bar" />
      <div ref={hold} className="level-hold" />
      <div className="level-zero" style={{ [orientation === 'vertical' ? 'bottom' : 'left']: `${ZERO_POS * 100}%` }} />
    </div>
  );
}
