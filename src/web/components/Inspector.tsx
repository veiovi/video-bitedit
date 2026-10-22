import { Fragment, useEffect, useState } from 'react';
import { canReplace, clearKeyframes, setKeyframe, updateClip, updateTimeline } from '../../shared/edits';
import { KEYFRAME_EASES, PROP_LABELS, adjacentKey, animatableProps, hasKeys, staticValue, valueAt } from '../../shared/keyframes';
import { dbLabel } from '../../shared/levels';
import { EFFECTS, GRADES, TRANSITIONS } from '../../shared/effects';
import {
  type Clip,
  type Effect,
  type EffectType,
  type GradePreset,
  type KeyframeEase,
  type KeyframeProp,
  type ProjectDoc,
  SPEED_LIMITS,
  SPEED_PRESETS,
  type TextStyle,
  type Timeline,
  type TransitionType,
  clipSpeed,
  formatTimecode,
  speedLabel,
} from '../../shared/project';
import { THEMES, type TextAnimation, type TextPreset, defaultTextStyle, getTheme } from '../../shared/themes';
import { mediaUrl } from '../api';
import { analyseClipColor } from '../autocolor';
import { activeTimeline, detachSelection, replaceWithAsset, setClipSpeed, useEditor } from '../store';
import { HelpTip } from './Help';
import { CaptionLookPicker } from './CaptionLookPicker';
import { WORDS_PER_LINE, wordsPerLine } from '../../shared/captionLooks';
import { SHORTCUTS, type TipId } from '../help';
import { clipFrame, noteKeyProp, playheadIn, toggleKeyframe } from '../keyframing';
import { isDucked, normalizeClips } from '../audio';
import { DuckingControls } from './Ducking';

// Continuous controls (sliders, typing) preview every change and record one
// undo step when the gesture ends.
let gestureBase: ProjectDoc | null = null;

function liveTimeline(fn: (t: Timeline) => Timeline) {
  const s = useEditor.getState();
  gestureBase ??= s.doc;
  s.preview(updateTimeline(s.doc, s.timelineId, fn));
}

function endGesture() {
  if (gestureBase) useEditor.getState().commitFrom(gestureBase);
  gestureBase = null;
}

const liveClip = (id: string, patch: Partial<Clip>) => liveTimeline((t) => updateClip(t, id, patch));

function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  disabled?: boolean;
  onChange: (v: number) => void;
  /** Controls after the readout (the keyframe buttons). */
  extra?: React.ReactNode;
}) {
  return (
    <label className={`field slider ${props.extra ? 'keyable' : ''}`}>
      <span>{props.label}</span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(Number(e.target.value))}
        onPointerUp={endGesture}
        onKeyUp={endGesture}
        onBlur={endGesture}
      />
      <output>{props.format ? props.format(props.value) : props.value}</output>
      {props.extra}
    </label>
  );
}

/**
 * A slider for a property that can be animated. With keys, it shows the
 * value at the playhead and moving it sets a key there (auto-key); ◆ adds or
 * removes the key at the playhead, ‹ and › jump between keys, and the ease
 * menu shapes the span after the key under the playhead.
 */
function AnimSlider(props: {
  clip: Clip;
  prop: KeyframeProp;
  label: string;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  disabled?: boolean;
}) {
  const { clip, prop } = props;
  const keyed = hasKeys(clip, prop);
  const inside = useEditor((s) => playheadIn(clip, s.playhead));
  // Only animated properties follow the playhead, so static ones do not redraw while playing.
  const rel = useEditor((s) => (keyed ? clipFrame(clip, s.playhead) : 0));
  const keys = clip.keyframes?.[prop] ?? [];
  const here = keyed && inside ? keys.find((k) => k.frame === rel) : undefined;
  const value = keyed ? valueAt(clip, prop, rel) : staticValue(clip, prop);
  const prev = keyed ? adjacentKey(clip, [prop], useEditor.getState().playhead - clip.start, -1) : null;
  const next = keyed ? adjacentKey(clip, [prop], useEditor.getState().playhead - clip.start, 1) : null;
  const seekKey = (f: number | null) => f !== null && useEditor.getState().seek(clip.start + f);
  const onChange = (v: number) => {
    noteKeyProp(prop);
    if (keyed) {
      const f = clipFrame(clip, useEditor.getState().playhead);
      liveTimeline((t) => setKeyframe(t, clip.id, prop, f, v));
    } else liveClip(clip.id, { [prop]: v });
  };
  const name = PROP_LABELS[prop].toLowerCase();
  return (
    <>
      <Slider
        {...props}
        value={value}
        onChange={onChange}
        extra={
          <span className="key-tools">
            <button type="button" className="small ghost" disabled={prev === null} title={`Previous ${name} keyframe`} onClick={() => seekKey(prev)}>
              ‹
            </button>
            <button
              type="button"
              className={`small ghost key-toggle ${here ? 'on' : keyed ? 'keyed' : ''}`}
              disabled={props.disabled || !inside}
              aria-pressed={Boolean(here)}
              title={here ? `Remove the ${name} keyframe at the playhead` : `Add a ${name} keyframe at the playhead (;)`}
              onClick={() => toggleKeyframe(clip.id, prop)}
            >
              ◆
            </button>
            <button type="button" className="small ghost" disabled={next === null} title={`Next ${name} keyframe`} onClick={() => seekKey(next)}>
              ›
            </button>
          </span>
        }
      />
      {here && (
        <label className="field key-ease">
          <span>Then</span>
          <select
            value={here.ease ?? 'linear'}
            disabled={props.disabled}
            title="How the value moves from this keyframe to the next"
            onChange={(e) => useEditor.getState().applyTimeline((t) => setKeyframe(t, clip.id, prop, here.frame, here.value, e.target.value as KeyframeEase))}
          >
            {KEYFRAME_EASES.map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="small ghost"
            disabled={props.disabled}
            title={`Remove every ${name} keyframe, keeping the value at the playhead`}
            onClick={() => useEditor.getState().applyTimeline((t) => clearKeyframes(t, clip.id, prop, rel))}
          >
            Clear
          </button>
        </label>
      )}
    </>
  );
}


function SecondsField({ label, frames, fps, disabled, onChange }: { label: string; frames: number; fps: number; disabled?: boolean; onChange: (f: number) => void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        min={0}
        step={0.1}
        value={Number((frames / fps).toFixed(2))}
        disabled={disabled}
        onChange={(e) => onChange(Math.max(0, Math.round(Number(e.target.value) * fps)))}
        onBlur={endGesture}
      />
      <output>s</output>
    </label>
  );
}

function TextFields({ clip, disabled }: { clip: Clip; disabled: boolean }) {
  const theme = useEditor((s) => s.doc.theme);
  const t = clip.text!;
  const set = (patch: Partial<TextStyle>) => liveClip(clip.id, { text: { ...t, ...patch } });
  if (clip.kind === 'caption') return <CaptionFields clip={clip} disabled={disabled} />;
  return (
    <>
      <label className="field stacked">
        <span>Text</span>
        <textarea rows={3} value={t.text} disabled={disabled} onChange={(e) => set({ text: e.target.value })} onBlur={endGesture} />
      </label>
      <label className="field">
        <span>Style</span>
        <select
          value={t.preset ?? 'title'}
          disabled={disabled}
          onChange={(e) => {
            const preset = e.target.value as TextPreset;
            set({ ...defaultTextStyle({ theme }, preset), text: t.text });
            endGesture();
          }}
        >
          <option value="title">Title</option>
          <option value="caption">Caption</option>
          <option value="lowerThird">Lower third</option>
        </select>
      </label>
      <label className="field">
        <span>Animation</span>
        <select
          value={t.animation ?? getTheme(theme).animation}
          disabled={disabled}
          onChange={(e) => {
            set({ animation: e.target.value as TextAnimation });
            endGesture();
          }}
        >
          {(['none', 'fade', 'rise', 'pop', 'slam', 'typewriter'] as TextAnimation[]).map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </label>
      <Slider label="Size" value={t.fontSize} min={16} max={300} step={1} disabled={disabled} onChange={(v) => set({ fontSize: v })} />
      <Slider label="Weight" value={t.fontWeight} min={300} max={900} step={100} disabled={disabled} onChange={(v) => set({ fontWeight: v })} />
      <label className="field">
        <span>Color</span>
        <input type="color" value={t.color} disabled={disabled} onChange={(e) => set({ color: e.target.value })} onBlur={endGesture} />
        <button
          className="small"
          disabled={disabled}
          onClick={() => {
            set({ background: t.background === 'transparent' ? 'rgba(0,0,0,0.6)' : 'transparent' });
            endGesture();
          }}
        >
          {t.background === 'transparent' ? 'Add box' : 'No box'}
        </button>
      </label>
      <Slider label="X" value={t.x} min={0} max={1} step={0.01} disabled={disabled} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ x: v })} />
      <Slider label="Y" value={t.y} min={0} max={1} step={0.01} disabled={disabled} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ y: v })} />
    </>
  );
}

function Section({ title, children, open = true, help }: { title: string; children: React.ReactNode; open?: boolean; help?: TipId }) {
  return (
    <details className="section" open={open}>
      <summary>
        {title}
        {help && <HelpTip id={help} />}
      </summary>
      <div className="section-body">{children}</div>
    </details>
  );
}

/** Caption clips: the words come from the transcript; only the look is edited here. */
function CaptionFields({ clip, disabled }: { clip: Clip; disabled: boolean }) {
  const theme = useEditor((s) => s.doc.theme);
  const frameSize = useEditor((s) => {
    const t = activeTimeline(s);
    return `${t.width}x${t.height}`;
  });
  const [width, height] = frameSize.split('x').map(Number);
  const t = clip.text!;
  const set = (patch: Partial<TextStyle>) => liveClip(clip.id, { text: { ...t, ...patch } });
  const words = clip.words ?? [];
  const oneWord = t.captionLook === 'oneWord';
  return (
    <>
      <p className="caption-words">
        {words.length} words: {words.map((w) => w.text).join(' ')}
      </p>
      <CaptionLookPicker
        style={t}
        themeId={theme}
        frameSize={{ width, height }}
        disabled={disabled}
        onChange={(patch) => {
          set(patch);
          endGesture();
        }}
      />
      <Slider
        label="Words / line"
        value={oneWord ? 1 : wordsPerLine(t)}
        min={WORDS_PER_LINE.min}
        max={WORDS_PER_LINE.max}
        step={1}
        disabled={disabled || oneWord}
        onChange={(v) => set({ wordsPerLine: v })}
      />
      <Slider label="Size" value={t.fontSize} min={16} max={300} step={1} disabled={disabled} onChange={(v) => set({ fontSize: v })} />
      <Slider label="Weight" value={t.fontWeight} min={300} max={900} step={100} disabled={disabled} onChange={(v) => set({ fontWeight: v })} />
      <label className="field">
        <span>Color</span>
        <input type="color" value={t.color} disabled={disabled} onChange={(e) => set({ color: e.target.value })} onBlur={endGesture} />
        <button
          className="small"
          disabled={disabled}
          onClick={() => {
            set({ background: t.background === 'transparent' ? 'rgba(0,0,0,0.6)' : 'transparent' });
            endGesture();
          }}
        >
          {t.background === 'transparent' ? 'Add box' : 'No box'}
        </button>
      </label>
      <label className="field">
        <span>Accent</span>
        <input
          type="color"
          value={t.highlight ?? getTheme(theme).presets.caption.highlight ?? '#ffd84d'}
          disabled={disabled}
          title="The spoken word, the karaoke fill and the highlight box"
          onChange={(e) => set({ highlight: e.target.value })}
          onBlur={endGesture}
        />
      </label>
      <Slider label="X" value={t.x} min={0} max={1} step={0.01} disabled={disabled} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ x: v })} />
      <Slider label="Y" value={t.y} min={0} max={1} step={0.01} disabled={disabled} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ y: v })} />
    </>
  );
}

async function addAutoColor(clip: Clip, effects: Effect[]) {
  const s = useEditor.getState();
  const asset = s.assets.find((a) => a.id === clip.assetId);
  if (!asset || (asset.kind !== 'video' && asset.kind !== 'image')) return;
  const fps = activeTimeline(s).fps;
  const from = (clip.in ?? 0) / fps;
  s.setToast('Analysing colour…');
  try {
    const correction = await analyseClipColor(mediaUrl(s.projectId, asset.id), asset.kind, from, from + (clip.duration * clipSpeed(clip)) / fps);
    s.applyTimeline((t) => updateClip(t, clip.id, { effects: [...effects, { type: 'autoColor', amount: 1, ...correction }] }));
    s.setToast('Auto colour applied');
  } catch (err) {
    s.setToast((err as Error).message);
  }
}

function EffectsSection({ clip, disabled }: { clip: Clip; disabled: boolean }) {
  const effects = clip.effects ?? [];
  const set = (next: Effect[]) => liveClip(clip.id, { effects: next.length ? next : undefined });
  const update = (i: number, patch: Partial<Effect>) => set(effects.map((fx, j) => (j === i ? { ...fx, ...patch } : fx)));
  return (
    <Section title={`Effects${effects.length ? ` (${effects.length})` : ''}`} open={effects.length > 0} help="effects">
      {effects.map((fx, i) => (
        <div key={i} className="effect-row">
          <div className="effect-head">
            <strong>{EFFECTS[fx.type]?.label ?? fx.type}</strong>
            <button
              className="small ghost"
              disabled={disabled}
              title="Remove effect"
              onClick={() => {
                set(effects.filter((_, j) => j !== i));
                endGesture();
              }}
            >
              ×
            </button>
          </div>
          {fx.type === 'grade' && (
            <label className="field">
              <span>Look</span>
              <select
                value={fx.preset ?? 'tealOrange'}
                disabled={disabled}
                onChange={(e) => {
                  update(i, { preset: e.target.value as GradePreset });
                  endGesture();
                }}
              >
                {Object.entries(GRADES).map(([id, g]) => (
                  <option key={id} value={id}>
                    {g.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {fx.type === 'kenBurns' ? (
            <>
              <Slider label="From zoom" value={fx.from ?? 1} min={1} max={2} step={0.01} disabled={disabled} onChange={(v) => update(i, { from: v })} />
              <Slider label="To zoom" value={fx.to ?? 1.15} min={1} max={2} step={0.01} disabled={disabled} onChange={(v) => update(i, { to: v })} />
              <Slider label="Pan X" value={fx.panX ?? 0} min={-0.3} max={0.3} step={0.01} disabled={disabled} onChange={(v) => update(i, { panX: v })} />
            </>
          ) : (
            <Slider
              label={fx.type === 'zoomPunch' ? 'Zoom' : 'Amount'}
              value={fx.amount ?? (fx.type === 'zoomPunch' ? 0.15 : 1)}
              min={0}
              max={fx.type === 'zoomPunch' ? 0.6 : 1}
              step={0.01}
              disabled={disabled}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(v) => update(i, { amount: v })}
            />
          )}
        </div>
      ))}
      <label className="field">
        <span>Add</span>
        <select
          value=""
          disabled={disabled}
          onChange={(e) => {
            const type = e.target.value as EffectType;
            if (!type) return;
            if (type === 'autoColor') {
              void addAutoColor(clip, effects);
              return;
            }
            set([...effects, { ...EFFECTS[type].defaults }]);
            endGesture();
          }}
        >
          <option value="">Choose an effect…</option>
          {Object.entries(EFFECTS).map(([id, fx]) => (
            <option key={id} value={id}>
              {fx.label}
            </option>
          ))}
        </select>
      </label>
    </Section>
  );
}

/**
 * Speed presets and a typed speed. Each change is one undo step; the clip's
 * length follows (see setSpeed), rippling on the main track with the magnet on.
 */
function SpeedField({ clip, disabled }: { clip: Clip; disabled: boolean }) {
  const speed = clipSpeed(clip);
  const [text, setText] = useState(String(speed));
  useEffect(() => setText(String(speed)), [speed]);
  const commit = () => {
    const v = Number(text);
    if (Number.isFinite(v) && v > 0) setClipSpeed([clip.id], v);
    else setText(String(speed));
  };
  return (
    <>
      <div className="field speed-field">
        <span>Speed</span>
        <div className="speed-presets" role="group" aria-label="Speed presets">
          {SPEED_PRESETS.map((p) => (
            <button key={p} className={`small ${p === speed ? 'on' : ''}`} disabled={disabled} aria-pressed={p === speed} onClick={() => setClipSpeed([clip.id], p)}>
              {speedLabel(p)}
            </button>
          ))}
        </div>
      </div>
      <label className="field">
        <span>Custom</span>
        <input
          type="number"
          min={SPEED_LIMITS.min}
          max={SPEED_LIMITS.max}
          step={0.05}
          value={text}
          disabled={disabled}
          aria-label="Speed"
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
        />
        <output>×</output>
      </label>
    </>
  );
}

/** Swap the clip's media for another file in the bin; drag-free, so it works on phones. */
function ReplaceMedia({ clip, disabled }: { clip: Clip; disabled: boolean }) {
  const assets = useEditor((s) => s.assets);
  const options = assets.filter((a) => a.status === 'ready' && a.id !== clip.assetId && canReplace(clip, a.kind));
  return (
    <label className="field">
      <span>Replace</span>
      <select
        value=""
        disabled={disabled || options.length === 0}
        onChange={(e) => {
          const asset = assets.find((a) => a.id === e.target.value);
          if (asset) replaceWithAsset(clip.id, asset);
        }}
      >
        <option value="">{options.length ? 'Replace with…' : 'Nothing to swap in'}</option>
        {options.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function ClipInspector({ clip, timeline }: { clip: Clip; timeline: Timeline }) {
  const canEdit = useEditor((s) => s.canEdit);
  const asset = useEditor((s) => s.assets.find((a) => a.id === clip.assetId));
  const fps = timeline.fps;
  const disabled = !canEdit;
  const hasAudio = (clip.kind === 'video' || clip.kind === 'audio') && !clip.freeze;
  const visual = clip.kind !== 'audio';
  const generated = clip.kind === 'text' || clip.kind === 'caption';
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const animatable = animatableProps(clip);
  return (
    <div className="inspector">
      <div className="inspector-title">
        <span className={`kind-dot ${clip.kind}`} />
        <span className="clip-name">
          Clip:{' '}
          {clip.kind === 'text'
            ? clip.text?.text.slice(0, 24) || 'Text'
            : clip.kind === 'caption'
              ? 'Captions'
              : (asset?.name ?? 'Missing media')}
        </span>
        <HelpTip id="inspector-clip" />
      </div>
      {generated && clip.text && (
        <Section title={clip.kind === 'caption' ? 'Captions' : 'Text'} help={clip.kind === 'caption' ? 'captions' : 'text'}>
          <TextFields clip={clip} disabled={disabled} />
        </Section>
      )}
      {visual && (
        <Section title="Transform" help="transform">
          {/* Properties the clip can animate get keyframe buttons (◆); slides draw without them. */}
          {animatable.includes('scale') ? (
            <AnimSlider clip={clip} prop="scale" label="Scale" min={0.1} max={4} step={0.01} disabled={disabled} format={pct} />
          ) : (
            <Slider label="Scale" value={clip.scale ?? 1} min={0.1} max={4} step={0.01} disabled={disabled} format={pct} onChange={(v) => liveClip(clip.id, { scale: v })} />
          )}
          {!generated && (
            <>
              {/* Cropped clips pan inside their crop (-50%..50%); letterboxed ones move across the frame. */}
              {animatable.includes('offsetX') ? (
                <>
                  <AnimSlider clip={clip} prop="offsetX" label="Position X" min={clip.fit === 'cover' ? -0.5 : -1} max={clip.fit === 'cover' ? 0.5 : 1} step={0.01} disabled={disabled} format={pct} />
                  <AnimSlider clip={clip} prop="offsetY" label="Position Y" min={clip.fit === 'cover' ? -0.5 : -1} max={clip.fit === 'cover' ? 0.5 : 1} step={0.01} disabled={disabled} format={pct} />
                </>
              ) : (
                <>
                  <Slider label="Position X" value={clip.offsetX ?? 0} min={clip.fit === 'cover' ? -0.5 : -1} max={clip.fit === 'cover' ? 0.5 : 1} step={0.01} disabled={disabled} format={pct} onChange={(v) => liveClip(clip.id, { offsetX: v })} />
                  <Slider label="Position Y" value={clip.offsetY ?? 0} min={clip.fit === 'cover' ? -0.5 : -1} max={clip.fit === 'cover' ? 0.5 : 1} step={0.01} disabled={disabled} format={pct} onChange={(v) => liveClip(clip.id, { offsetY: v })} />
                </>
              )}
            </>
          )}
          {animatable.includes('rotation') ? (
            <AnimSlider clip={clip} prop="rotation" label="Rotation" min={-180} max={180} step={1} disabled={disabled} format={(v) => `${Math.round(v)}°`} />
          ) : (
            <Slider label="Rotation" value={clip.rotation ?? 0} min={-180} max={180} step={1} disabled={disabled} format={(v) => `${v}°`} onChange={(v) => liveClip(clip.id, { rotation: v })} />
          )}
          {animatable.includes('opacity') ? (
            <AnimSlider clip={clip} prop="opacity" label="Opacity" min={0} max={1} step={0.01} disabled={disabled} format={pct} />
          ) : (
            <Slider label="Opacity" value={clip.opacity ?? 1} min={0} max={1} step={0.01} disabled={disabled} format={pct} onChange={(v) => liveClip(clip.id, { opacity: v })} />
          )}
          {!generated && (
            <label className="field">
              <span>Fit</span>
              <select
                value={clip.fit ?? 'contain'}
                disabled={disabled}
                onChange={(e) => {
                  liveClip(clip.id, { fit: e.target.value as Clip['fit'] });
                  endGesture();
                }}
              >
                <option value="contain">Fit (letterbox)</option>
                <option value="cover">Fill (crop)</option>
              </select>
            </label>
          )}
        </Section>
      )}
      {(clip.kind === 'video' || clip.kind === 'image' || clip.kind === 'audio') && (
        <Section title="Media" help="replace">
          <ReplaceMedia clip={clip} disabled={disabled} />
        </Section>
      )}
      <Section title="Timing" help="timing">
        <div className="facts">
          <span>Start {formatTimecode(clip.start, fps)}</span>
          <span>End {formatTimecode(clip.start + clip.duration, fps)}</span>
        </div>
        <SecondsField label="Start" frames={clip.start} fps={fps} disabled={disabled} onChange={(f) => liveClip(clip.id, { start: f })} />
        <SecondsField label="Length" frames={clip.duration} fps={fps} disabled={disabled} onChange={(f) => liveClip(clip.id, { duration: Math.max(1, f) })} />
        {clip.in !== undefined && (
          <SecondsField label={clip.freeze ? 'Held frame' : 'Source in'} frames={clip.in} fps={fps} disabled={disabled} onChange={(f) => liveClip(clip.id, { in: f })} />
        )}
        {clip.freeze && <p className="hint">Freeze frame: holds this source frame, without sound. ⌥-drag the clip to pick another frame.</p>}
        {(clip.kind === 'video' || clip.kind === 'audio') && !clip.freeze && <SpeedField clip={clip} disabled={disabled} />}
        <SecondsField label="Fade in" frames={clip.fadeIn ?? 0} fps={fps} disabled={disabled} onChange={(f) => liveClip(clip.id, { fadeIn: f })} />
        <SecondsField label="Fade out" frames={clip.fadeOut ?? 0} fps={fps} disabled={disabled} onChange={(f) => liveClip(clip.id, { fadeOut: f })} />
      </Section>
      {(visual || clip.kind === 'text' || clip.kind === 'caption') && (
        <Section title="Transition in" open={Boolean(clip.transition)} help="transition">
          <label className="field">
            <span>Type</span>
            <select
              value={clip.transition?.type ?? ''}
              disabled={disabled}
              onChange={(e) => {
                const type = e.target.value as TransitionType | '';
                liveClip(clip.id, { transition: type ? { type, duration: clip.transition?.duration ?? Math.round(fps / 2) } : undefined });
                endGesture();
              }}
            >
              <option value="">None (cut)</option>
              {Object.entries(TRANSITIONS).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {clip.transition && (
            <SecondsField
              label="Duration"
              frames={clip.transition.duration}
              fps={fps}
              disabled={disabled}
              onChange={(f) => liveClip(clip.id, { transition: { ...clip.transition!, duration: Math.max(1, f) } })}
            />
          )}
        </Section>
      )}
      {(clip.kind === 'video' || clip.kind === 'image') && <EffectsSection clip={clip} disabled={disabled} />}
      {hasAudio && (
        <Section title="Audio" help="audio">
          {clip.muted ? (
            <>
              <p className="hint">This clip's own sound is off: its audio was detached to an audio track, or muted.</p>
              <button
                className="small"
                disabled={disabled}
                onClick={() => useEditor.getState().applyTimeline((t) => updateClip(t, clip.id, { muted: undefined }))}
              >
                Turn clip sound back on
              </button>
            </>
          ) : (
            <>
              <AnimSlider clip={clip} prop="volume" label="Volume" min={0} max={2} step={0.01} disabled={disabled} format={(v) => `${pct(v)} ${dbLabel(v)}`} />
              <div className="button-row">
                <button
                  className="small"
                  disabled={disabled}
                  title="Set the clip's gain so its loudest moment reaches −1 dBFS (up to 200%)"
                  onClick={() => void normalizeClips([clip.id])}
                >
                  Normalize
                </button>
              </div>
              {clip.kind === 'video' && clip.assetId && (
                <button
                  className="small"
                  disabled={disabled}
                  title="Move the sound to its own clip on an audio track, to trim and fade it separately"
                  onClick={() => {
                    useEditor.getState().select([clip.id]);
                    detachSelection();
                  }}
                >
                  Detach audio
                </button>
              )}
            </>
          )}
        </Section>
      )}
      {clip.kind === 'audio' && (
        <Section title="Ducking" open={isDucked([clip], clip.trackId)} help="ducking">
          <p className="hint">Lowers this track wherever someone speaks on the other tracks, as volume keyframes you can adjust.</p>
          <DuckingControls trackId={clip.trackId} disabled={disabled} />
        </Section>
      )}
    </div>
  );
}

function ProjectInspector({ timeline }: { timeline: Timeline }) {
  const doc = useEditor((s) => s.doc);
  const canEdit = useEditor((s) => s.canEdit);
  return (
    <div className="inspector">
      <div className="inspector-title">
        {timeline.name}
        <HelpTip id="inspector-timeline" />
      </div>
      <div className="facts">
        <span>
          {timeline.width}×{timeline.height}
        </span>
        <span>{timeline.fps} fps</span>
        <span>{timeline.clips.length} clips</span>
      </div>
      <h3>
        Title style <HelpTip id="title-style" />
      </h3>
      <div className="theme-grid">
        {THEMES.map((t) => (
          <button
            key={t.id}
            className={`theme-card ${(doc.theme ?? 'clean') === t.id ? 'on' : ''}`}
            disabled={!canEdit}
            onClick={() => useEditor.getState().apply((d) => ({ ...d, theme: t.id }))}
          >
            <span className="theme-sample" style={{ fontFamily: t.fontFamily, color: t.presets.title.color, background: t.background }}>
              Aa
            </span>
            <span className="theme-name">{t.name}</span>
            <span className="theme-desc">{t.description}</span>
          </button>
        ))}
      </div>
      <h3>Timeline</h3>
      <label className="field">
        <span>Name</span>
        <input
          value={timeline.name}
          disabled={!canEdit}
          onChange={(e) => liveTimeline((t) => ({ ...t, name: e.target.value }))}
          onBlur={endGesture}
        />
      </label>
      <label className="field">
        <span>Background</span>
        <input
          type="color"
          value={timeline.background}
          disabled={!canEdit}
          onChange={(e) => liveTimeline((t) => ({ ...t, background: e.target.value }))}
          onBlur={endGesture}
        />
      </label>
      <p className="hint">Select a clip to edit its timing, volume and framing.</p>
      <div className="shortcuts">
        <h3>
          Shortcuts <HelpTip id="tools" />
        </h3>
        <dl>
          {SHORTCUTS.map(([keys, what]) => (
            <Fragment key={keys}>
              <dt>{keys}</dt>
              <dd>{what}</dd>
            </Fragment>
          ))}
        </dl>
      </div>
    </div>
  );
}

export function InspectorPanel() {
  const doc = useEditor((s) => s.doc);
  const timelineId = useEditor((s) => s.timelineId);
  const selection = useEditor((s) => s.selection);
  const timeline = activeTimeline({ doc, timelineId });
  const clip = selection.length === 1 ? timeline.clips.find((c) => c.id === selection[0]) : undefined;
  return clip ? <ClipInspector clip={clip} timeline={timeline} /> : <ProjectInspector timeline={timeline} />;
}
