// Audio actions that need the waveform peaks: Duck under speech and Normalize.
// Both load what they need first, then make one undoable edit.

import { create } from 'zustand';
import { duckClips, removeDucking, setClipGain } from '../shared/edits';
import { DUCKING_DEFAULTS, type DuckingOptions, mergeRanges, speechRanges } from '../shared/ducking';
import { audible, clipPeak, dbLabel, normalizeGain } from '../shared/levels';
import { activeTimeline, useEditor } from './store';
import { loadPeaks, peaksNow } from './peaks';
import { loadTranscripts, useTranscripts } from './transcripts';

const SETTINGS_KEY = 'videdit.ducking';

function readSettings(): DuckingOptions {
  try {
    return { ...DUCKING_DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
  } catch {
    return DUCKING_DEFAULTS;
  }
}

/** Ducking settings (depth, attack, release), remembered in this browser. */
export const useDucking = create<DuckingOptions>(() => readSettings());

export function setDucking(patch: Partial<DuckingOptions>) {
  useDucking.setState(patch);
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(useDucking.getState()));
  } catch {
    // Blocked storage: the settings last for this tab.
  }
}

/**
 * Duck every clip on an audio track under the speech on the other tracks:
 * transcript words where an asset has a transcript, loud peaks otherwise.
 * Writes volume keys in one undo step, replacing the clips' volume keys.
 */
export async function duckTrack(trackId: string) {
  const s = useEditor.getState();
  const t = activeTimeline(s);
  const track = t.tracks.find((x) => x.id === trackId);
  if (!track || track.kind !== 'audio') return;
  if (track.locked) return s.setToast(`${track.name} is locked: unlock it to duck it`);
  const music = t.clips.filter((c) => c.trackId === trackId && c.kind === 'audio');
  if (music.length === 0) return s.setToast(`${track.name} has no audio clips to duck`);
  const handKeys = music.some((c) => c.keyframes?.volume?.some((k) => !k.duck));
  if (handKeys && !confirm(`Ducking replaces the volume keyframes on ${track.name}, including ones set by hand. Continue?`)) return;
  const sources = t.clips.filter((c) => c.trackId !== trackId && audible(c)).map((c) => c.assetId!);
  const ids = [...new Set(sources)];
  s.setToast('Finding speech…');
  await Promise.all([...ids.map((id) => loadPeaks(s.projectId, id)), loadTranscripts(s.projectId, ids)]);
  const transcripts = useTranscripts.getState().byAsset;
  const now = useEditor.getState();
  const latest = activeTimeline(now);
  const speech = speechRanges(latest, trackId, { peaks: (id) => peaksNow(now.projectId, id), transcripts });
  if (speech.length === 0) return now.setToast('No speech found on the other tracks');
  const opts = useDucking.getState();
  now.applyTimeline((tl) => duckClips(tl, music.map((c) => c.id), speech, opts));
  const ducked = activeTimeline(useEditor.getState()).clips.filter((c) => c.trackId === trackId && c.keyframes?.volume?.some((k) => k.duck)).length;
  const dips = mergeRanges(speech, Math.max(opts.minGap, opts.attack + opts.release)).length;
  now.setToast(ducked ? `Ducked ${ducked} clip${ducked === 1 ? '' : 's'} by ${Math.abs(opts.depth)} dB under ${dips} stretch${dips === 1 ? '' : 'es'} of speech` : 'The speech does not overlap this track');
}

/** Take the ducking keys off every clip on a track; volume keys set by hand stay. */
export function unduckTrack(trackId: string) {
  const s = useEditor.getState();
  const ids = activeTimeline(s).clips.filter((c) => c.trackId === trackId).map((c) => c.id);
  s.applyTimeline((t) => removeDucking(t, ids));
}

/** Whether a track has ducking keys. */
export const isDucked = (clips: { trackId: string; keyframes?: { volume?: { duck?: true }[] } }[], trackId: string) =>
  clips.some((c) => c.trackId === trackId && c.keyframes?.volume?.some((k) => k.duck));

/**
 * Normalize: set each clip's gain so its loudest sample (from its peaks)
 * reaches −1 dBFS, up to the maximum gain. One undo step for all of them.
 */
export async function normalizeClips(ids: string[]) {
  const s = useEditor.getState();
  const clips = activeTimeline(s).clips.filter((c) => ids.includes(c.id) && audible(c));
  if (clips.length === 0) return s.setToast('Select a clip with sound to normalize it');
  await Promise.all(clips.map((c) => loadPeaks(s.projectId, c.assetId!)));
  const fps = activeTimeline(s).fps;
  const gains = new Map<string, number>();
  for (const c of clips) {
    const peaks = peaksNow(s.projectId, c.assetId!);
    const g = peaks ? normalizeGain(clipPeak(c, peaks, fps)) : null;
    if (g !== null) gains.set(c.id, g);
  }
  if (gains.size === 0) return s.setToast('No waveform for this clip yet, or it is silent');
  useEditor.getState().applyTimeline((t) => [...gains].reduce((tl, [id, g]) => setClipGain(tl, id, g), t));
  const [only] = gains.values();
  s.setToast(gains.size === 1 ? `Normalized: gain ${Math.round(only * 100)}% (${dbLabel(only)})${only >= 2 ? ', the most it can go' : ''}` : `Normalized ${gains.size} clips`);
}
