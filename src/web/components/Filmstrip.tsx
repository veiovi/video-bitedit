// Frames from a video's filmstrip sprite: along a timeline clip (the frames
// its visible source range shows), and under the pointer when skimming a
// media bin card.

import { useEffect, useRef, useState } from 'react';
import { type Asset, type Clip, type Filmstrip, clipSpeed, filmstripFrame } from '../../shared/project';
import { filmstripUrl, mediaUrl } from '../api';

/** Height of the picture strip inside a video clip on the timeline. */
const STRIP_H = 38;
/** At most this many frames per clip; beyond it they spread out with gaps. */
const MAX_TILES = 400;

/** CSS that shows frame `index` of a sprite filling the element (stretched to it). */
function spriteFrame(url: string, strip: Filmstrip, index: number): React.CSSProperties {
  return {
    backgroundImage: `url(${url})`,
    backgroundSize: `${strip.frames * 100}% 100%`,
    backgroundPositionX: strip.frames > 1 ? `${(index / (strip.frames - 1)) * 100}%` : '0%',
  };
}

/**
 * The picture along a video clip: the sprite frames for the part of the source
 * the clip plays, at the current zoom. Falls back to the tiled thumbnail.
 */
export function ClipFrames({ clip, asset, projectId, px, fps, thumb }: { clip: Clip; asset?: Asset; projectId: string; px: number; fps: number; thumb?: string }) {
  const strip = clip.kind === 'video' ? asset?.filmstrip : null;
  if (!strip) {
    return thumb && (clip.kind === 'video' || clip.kind === 'image') ? <div className="clip-thumb" style={{ backgroundImage: `url(${thumb})` }} /> : null;
  }
  const url = filmstripUrl(projectId, asset!.id);
  const width = Math.max(2, clip.duration * px);
  const tileW = Math.max(8, (STRIP_H * strip.width) / strip.height);
  const count = Math.min(MAX_TILES, Math.ceil(width / tileW));
  const spacing = Math.max(tileW, width / MAX_TILES);
  const tiles = [];
  for (let i = 0; i < count; i++) {
    // Each tile shows the source under its centre.
    const frameInClip = Math.min(clip.duration, (i * spacing + tileW / 2) / px);
    // Source frames run at the clip's speed; a still shows its one frame throughout.
    const seconds = ((clip.in ?? 0) + (clip.freeze ? 0 : frameInClip * clipSpeed(clip))) / fps;
    tiles.push(<div key={i} className="clip-frame" style={{ left: i * spacing, width: tileW, ...spriteFrame(url, strip, filmstripFrame(strip, seconds)) }} />);
  }
  return <div className="clip-thumb clip-frames">{tiles}</div>;
}

/**
 * A media bin card's picture. Moving a mouse across a video scrubs through
 * it (from the filmstrip, or a muted video element when there is none) with
 * a line showing where; leaving puts the thumbnail back. Touch does nothing.
 */
export function SkimThumb({ asset, projectId, thumb, children }: { asset: Asset; projectId: string; thumb?: string; children?: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const seeking = useRef(false);
  const pending = useRef<number | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const [useVideo, setUseVideo] = useState(false);
  const skimmable = asset.kind === 'video' && asset.status === 'ready' && (asset.duration ?? 0) > 0;
  const strip = asset.filmstrip;

  const seekVideo = (t: number) => {
    const v = video.current;
    if (!v) return;
    if (seeking.current) {
      pending.current = t;
      return;
    }
    seeking.current = true;
    v.currentTime = t;
  };

  useEffect(() => {
    if (at !== null && useVideo) seekVideo(at * (asset.duration ?? 0));
  }, [at, useVideo, asset.duration]);

  const onMove = (e: React.PointerEvent) => {
    if (!skimmable || e.pointerType !== 'mouse' || !box.current) return;
    const r = box.current.getBoundingClientRect();
    setAt(Math.max(0, Math.min(0.999, (e.clientX - r.left) / r.width)));
    if (!strip) setUseVideo(true);
  };

  let frameStyle: React.CSSProperties | undefined;
  if (at !== null && strip && box.current) {
    // Cover the card with one frame, centred, like the thumbnail.
    const { width: bw, height: bh } = box.current.getBoundingClientRect();
    const aspect = strip.width / strip.height;
    const [fw, fh] = bw / bh > aspect ? [bw, bw / aspect] : [bh * aspect, bh];
    const index = filmstripFrame(strip, at * (asset.duration ?? 0));
    frameStyle = {
      backgroundImage: `url(${filmstripUrl(projectId, asset.id)})`,
      backgroundSize: `${strip.frames * fw}px ${fh}px`,
      backgroundPosition: `${(bw - fw) / 2 - index * fw}px ${(bh - fh) / 2}px`,
    };
  }

  return (
    <div
      ref={box}
      className={`asset-thumb ${at !== null ? 'skimming' : ''}`}
      style={thumb ? { backgroundImage: `url(${thumb})` } : undefined}
      onPointerMove={onMove}
      onPointerLeave={() => setAt(null)}
    >
      {frameStyle && <div className="skim-frame" style={frameStyle} />}
      {useVideo && (
        <video
          ref={video}
          className="skim-video"
          style={{ visibility: at !== null ? 'visible' : 'hidden' }}
          src={mediaUrl(projectId, asset.id)}
          muted
          playsInline
          preload="auto"
          onSeeked={() => {
            seeking.current = false;
            if (pending.current !== null) {
              const t = pending.current;
              pending.current = null;
              seekVideo(t);
            }
          }}
        />
      )}
      {at !== null && <div className="skim-line" style={{ left: `${at * 100}%` }} />}
      {children}
    </div>
  );
}
