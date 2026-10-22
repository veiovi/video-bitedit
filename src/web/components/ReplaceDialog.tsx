// Replace a clip's media, the way CapCut does it: the clip keeps its slot
// (start and length), and for longer media you drag a fixed-length window to
// choose which part plays. Media shorter than the clip is refused; images
// always fit.

import { useEffect, useRef, useState } from 'react';
import { replaceClipMedia, replaceProblem } from '../../shared/edits';
import { formatTimecode } from '../../shared/project';
import { mediaUrl } from '../api';
import { activeTimeline, useEditor } from '../store';
import { HelpTip } from './Help';

export function ReplaceDialog() {
  const replacing = useEditor((s) => s.replacing);
  const doc = useEditor((s) => s.doc);
  const timelineId = useEditor((s) => s.timelineId);
  const assets = useEditor((s) => s.assets);
  const projectId = useEditor((s) => s.projectId);
  const [inPoint, setInPoint] = useState(0);
  const [keepEffects, setKeepEffects] = useState(true);
  const player = useRef<HTMLMediaElement | null>(null);
  const bar = useRef<HTMLDivElement>(null);

  const timeline = activeTimeline({ doc, timelineId });
  const clip = replacing ? timeline.clips.find((c) => c.id === replacing.clipId) : undefined;
  const asset = replacing ? assets.find((a) => a.id === replacing.assetId) : undefined;
  const fps = timeline.fps;
  const frames = !asset || asset.kind === 'image' || asset.duration === null ? Infinity : Math.floor(asset.duration * fps);

  useEffect(() => {
    setInPoint(0);
    setKeepEffects(true);
  }, [replacing?.clipId, replacing?.assetId]);

  // Show the first frame of the chosen part.
  useEffect(() => {
    if (player.current) player.current.currentTime = inPoint / fps;
  }, [inPoint, fps]);

  if (!replacing || !clip || !asset) return null;
  const close = () => useEditor.setState({ replacing: null });
  const media = { id: asset.id, kind: asset.kind, frames };
  const problem = replaceProblem(clip, media, inPoint);
  const pickable = Number.isFinite(frames) && frames > clip.duration;
  const maxIn = Number.isFinite(frames) ? Math.max(0, frames - clip.duration) : 0;

  const pick = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect();
    const centre = ((clientX - r.left) / r.width) * frames;
    setInPoint(Math.round(Math.min(maxIn, Math.max(0, centre - clip.duration / 2))));
  };

  const playPart = () => {
    const v = player.current;
    if (!v) return;
    v.currentTime = inPoint / fps;
    void v.play();
    const stop = () => {
      if (v.currentTime >= (inPoint + clip.duration) / fps) {
        v.pause();
        v.removeEventListener('timeupdate', stop);
      }
    };
    v.addEventListener('timeupdate', stop);
  };

  const apply = () => {
    useEditor.getState().applyTimeline((t) => replaceClipMedia(t, clip.id, media, { inPoint, keepEffects }));
    useEditor.getState().select([clip.id]);
    close();
  };

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal replace-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h2>Replace clip</h2>
          <HelpTip id="replace-dialog" />
          <div className="grow" />
          <button className="ghost" onClick={close}>
            ×
          </button>
        </div>
        <div className="modal-body">
          <p className="muted">
            {asset.name} takes this clip's place at the same length ({formatTimecode(clip.duration, fps)}).
          </p>
          <div className="replace-preview">
            {asset.kind === 'image' ? (
              <img src={mediaUrl(projectId, asset.id)} alt="" />
            ) : asset.kind === 'video' ? (
              <video ref={(el) => void (player.current = el)} src={mediaUrl(projectId, asset.id)} muted playsInline preload="auto" />
            ) : (
              <audio ref={(el) => void (player.current = el)} src={mediaUrl(projectId, asset.id)} controls preload="auto" />
            )}
          </div>
          {pickable && !problem && (
            <>
              <div
                className="replace-bar"
                ref={bar}
                onPointerDown={(e) => {
                  (e.target as HTMLElement).setPointerCapture(e.pointerId);
                  pick(e.clientX);
                }}
                onPointerMove={(e) => e.buttons === 1 && pick(e.clientX)}
                title="Drag to choose which part of the new media plays"
              >
                <div className="replace-window" style={{ left: `${(inPoint / frames) * 100}%`, width: `${(clip.duration / frames) * 100}%` }} />
              </div>
              <div className="facts">
                <span>
                  Uses {formatTimecode(inPoint, fps)} → {formatTimecode(inPoint + clip.duration, fps)} of {formatTimecode(frames, fps)}
                </span>
                <button className="small" onClick={playPart}>
                  Play this part
                </button>
              </div>
            </>
          )}
          {problem && <p className="error">{problem}</p>}
          <label className="check">
            <input type="checkbox" checked={keepEffects} onChange={(e) => setKeepEffects(e.target.checked)} />
            Keep the clip's effects
          </label>
          <div className="button-row">
            <button onClick={close}>Cancel</button>
            <button className="primary" disabled={Boolean(problem)} onClick={apply}>
              Replace clip
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
