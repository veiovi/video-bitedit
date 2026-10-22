import { useRef, useState } from 'react';
import { addClip, nextFreeFrame } from '../../shared/edits';
import { type Asset, trackAccepts } from '../../shared/project';
import type { TextPreset } from '../../shared/themes';
import { api, mediaUrl, thumbUrl } from '../api';
import { activeTimeline, useEditor } from '../store';
import { uploadFile } from '../upload';
import { Icon } from './Icon';
import { ASSET_MIME, TEXT_MIME, assetKindMime, clipFor } from './TimelineView';
import { HelpTip } from './Help';

function fmtDuration(sec: number | null) {
  if (sec === null) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Append to the first suitable track at the end of its clips. */
function appendToTimeline(asset: Asset | null, preset?: TextPreset) {
  const state = useEditor.getState();
  const t = activeTimeline(state);
  const kind = asset ? asset.kind : 'text';
  const track = t.tracks.filter((x) => trackAccepts(x, kind) && !x.locked).at(kind === 'audio' ? 0 : -1);
  if (!track) return;
  const start = asset ? nextFreeFrame(t, track.id) : state.playhead;
  const textTrack = asset ? track : (t.tracks.find((x) => x.kind === 'video' && !x.locked) ?? track);
  const clip = clipFor(asset, asset ? track : textTrack, start, t, state.doc.theme, preset);
  if (!clip) return;
  state.applyTimeline((tl) => addClip(tl, clip));
  state.select([clip.id]);
}

/** AI stills via OpenRouter (meta/muse-image); the result lands in the bin like any image. */
function GeneratePanel({ projectId, vertical }: { projectId: string; vertical: boolean }) {
  const [prompt, setPrompt] = useState('');
  const [aspect, setAspect] = useState(vertical ? '9:16' : '16:9');
  const [busy, setBusy] = useState(false);
  async function go(e: React.FormEvent) {
    e.preventDefault();
    if (!prompt.trim()) return;
    setBusy(true);
    try {
      const { asset } = await api.generateImage(projectId, prompt, aspect);
      useEditor.setState((s) => ({ assets: [...s.assets, asset] }));
      setPrompt('');
    } catch (err) {
      useEditor.getState().setToast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="generate" onSubmit={go}>
      <h3>Generate image</h3>
      <textarea
        rows={2}
        placeholder="Retro title card, rust and turquoise film texture…"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        disabled={busy}
      />
      <div className="preset-row">
        <select value={aspect} onChange={(e) => setAspect(e.target.value)} disabled={busy} aria-label="Aspect ratio">
          <option value="16:9">16:9</option>
          <option value="9:16">9:16</option>
          <option value="1:1">1:1</option>
          <option value="4:3">4:3</option>
        </select>
        <button className="primary" disabled={busy || !prompt.trim()}>
          {busy ? 'Generating…' : 'Generate'}
        </button>
      </div>
    </form>
  );
}

export function MediaBin() {
  const assets = useEditor((s) => s.assets);
  const uploads = useEditor((s) => s.uploads);
  const canEdit = useEditor((s) => s.canEdit);
  const server = useEditor((s) => s.server);
  const vertical = useEditor((s) => {
    const t = activeTimeline(s);
    return t.height > t.width;
  });
  const projectId = useEditor((s) => s.projectId);
  const [dragging, setDragging] = useState(false);
  const [filter, setFilter] = useState('');
  const [kind, setKind] = useState<'all' | Asset['kind']>('all');
  const input = useRef<HTMLInputElement>(null);

  const upload = (files: FileList | File[]) => {
    for (const f of Array.from(files)) void uploadFile(projectId, f);
  };
  const shown = assets.filter((a) => (kind === 'all' || a.kind === kind) && a.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <aside
      className={`bin ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => {
        if (canEdit && e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (canEdit && e.dataTransfer.files.length) upload(e.dataTransfer.files);
      }}
    >
      <div className="panel-head">
        <span className="panel-num">01</span>
        <h2>Media</h2>
        <HelpTip id="media" />
        <span className="panel-count">[{assets.length} items]</span>
        <div className="grow" />
        {canEdit && (
          <button className="icon-btn" title="Import media" onClick={() => input.current?.click()}>
            <Icon name="plus" />
          </button>
        )}
        <input ref={input} type="file" multiple accept="video/*,audio/*,image/*" hidden onChange={(e) => e.target.files && upload(e.target.files)} />
      </div>
      <div className="bin-tabs">
        {(['all', 'video', 'audio', 'image'] as const).map((k) => (
          <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
            {k === 'all' ? 'All' : k === 'video' ? 'Video' : k === 'audio' ? 'Audio' : 'Images'}
          </button>
        ))}
      </div>
      {assets.length > 8 && <input className="search" placeholder="Filter media" value={filter} onChange={(e) => setFilter(e.target.value)} />}
      <div className="bin-list">
        {Object.entries(uploads).map(([key, u]) => (
          <div key={key} className="asset uploading">
            <div className="asset-thumb">
              <div className="progress" style={{ height: `${Math.round(u.progress * 100)}%` }} />
            </div>
            <div className="asset-meta">
              <div className="asset-name">{u.name}</div>
              <div className={`asset-sub ${u.error ? 'error' : ''}`}>{u.error ?? `Uploading ${Math.round(u.progress * 100)}%`}</div>
            </div>
          </div>
        ))}
        {shown.map((a) => (
          <div
            key={a.id}
            className={`asset ${a.kind} ${a.status !== 'ready' ? 'pending' : ''}`}
            draggable={canEdit && a.status === 'ready'}
            onDragStart={(e) => {
              e.dataTransfer.setData(ASSET_MIME, a.id);
              // Drag data is unreadable until the drop, but its types are visible while hovering.
              e.dataTransfer.setData(assetKindMime(a.kind), '');
              e.dataTransfer.effectAllowed = 'copy';
            }}
            onDoubleClick={() => canEdit && a.status === 'ready' && appendToTimeline(a)}
            title={canEdit ? 'Drag onto the timeline, or double-click to append' : a.name}
          >
            <div className="asset-thumb" style={a.hasThumb ? { backgroundImage: `url(${thumbUrl(projectId, a.id)})` } : undefined}>
              {!a.hasThumb && <Icon name={a.kind === 'audio' ? 'music' : a.kind === 'image' ? 'image' : 'film'} size={28} />}
              {a.duration !== null && <span className="duration">{fmtDuration(a.duration)}</span>}
            </div>
            <div className="asset-meta">
              <div className="asset-name">{a.name}</div>
              <div className="asset-sub">
                {a.status !== 'ready' ? 'Uploading…' : a.width ? `${a.width}×${a.height}` : a.kind === 'audio' ? 'Audio' : ''}
                <span className="size">{(a.size / 1e6).toFixed(1)} MB</span>
              </div>
            </div>
            <div className="asset-actions">
              <a href={mediaUrl(projectId, a.id)} download={a.name} title="Download source" onClick={(e) => e.stopPropagation()}>
                ↓
              </a>
              {canEdit && (
                <button
                  title="Remove from project"
                  onClick={async () => {
                    const used = useEditor.getState().doc.timelines.some((t) => t.clips.some((c) => c.assetId === a.id));
                    if (!confirm(used ? `${a.name} is used on a timeline. Remove it anyway?` : `Remove ${a.name}?`)) return;
                    await api.deleteAsset(projectId, a.id);
                    useEditor.setState((s) => ({ assets: s.assets.filter((x) => x.id !== a.id) }));
                  }}
                >
                  ×
                </button>
              )}
            </div>
          </div>
        ))}
        {assets.length === 0 && Object.keys(uploads).length === 0 && (
          <div className="empty">{canEdit ? 'Drop video, audio or images here' : 'No media yet'}</div>
        )}
      </div>
      {canEdit && server?.imageGeneration && <GeneratePanel projectId={projectId} vertical={vertical} />}
      {canEdit && (
        <div className="text-presets">
          <h3>Text</h3>
          <div className="preset-row">
            {(['title', 'caption', 'lowerThird'] as TextPreset[]).map((p) => (
              <button
                key={p}
                draggable
                onDragStart={(e) => e.dataTransfer.setData(TEXT_MIME, p)}
                onClick={() => appendToTimeline(null, p)}
                title="Click to add at the playhead, or drag onto a video track"
              >
                {p === 'title' ? 'Title' : p === 'caption' ? 'Caption' : 'Lower third'}
              </button>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}
