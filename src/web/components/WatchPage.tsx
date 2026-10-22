import { useEffect, useState } from 'react';
import type { PublishedVideo } from '../../shared/project';
import { api, renderUrl } from '../api';

function formatLength(seconds: number): string {
  const s = Math.round(seconds);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function WatchPage({ renderId }: { renderId: string }) {
  const [video, setVideo] = useState<PublishedVideo | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .getPublished(renderId)
      .then((v) => {
        setVideo(v);
        document.title = `${v.title} · Video bitEdit`;
      })
      .catch((err) => setError((err as Error).message));
  }, [renderId]);

  if (error) {
    return (
      <div className="center-page">
        <h1>Video not found</h1>
        <p>{error}</p>
      </div>
    );
  }
  if (!video) return <div className="center-page">Loading…</div>;
  const vertical = video.height > video.width;
  const audioOnly = video.preset === 'audio-mp3';

  return (
    <div className={`watch ${vertical ? 'vertical' : ''}`}>
      <div className="watch-player">
        {audioOnly ? (
          <audio src={renderUrl(video.projectId, video.renderId)} controls autoPlay />
        ) : (
          <video src={renderUrl(video.projectId, video.renderId)} controls autoPlay playsInline style={{ aspectRatio: `${video.width} / ${video.height}` }} />
        )}
      </div>
      <div className="watch-info">
        {video.versions && video.versions.length > 1 && (
          <nav className="versions" aria-label="Versions">
            {video.versions.map((v) => (
              <a key={v.renderId} href={`/w/${v.renderId}`} className={v.renderId === video.renderId ? 'on' : ''} aria-current={v.renderId === video.renderId ? 'page' : undefined}>
                <span className="version-label">{v.label}</span>
                <span className="version-meta">
                  {v.aspect} · {formatLength(v.durationFrames / v.fps)}
                </span>
              </a>
            ))}
          </nav>
        )}
        <h1>{video.title}</h1>
        <div className="muted">
          {video.timelineName} · {video.width}×{video.height} · {Math.round(video.durationFrames / video.fps)}s · published{' '}
          {new Date(video.publishedAt).toLocaleDateString()}
        </div>
        {video.description && <p className="description">{video.description}</p>}
        <div className="button-row">
          <a className="button" href={renderUrl(video.projectId, video.renderId, true)}>
            Download
          </a>
          <button
            onClick={() => {
              void navigator.clipboard.writeText(location.href);
            }}
          >
            Copy link
          </button>
          <a className="button primary" href={`/p/${video.projectId}`}>
            Open timeline &amp; {video.sourceCount} source{video.sourceCount === 1 ? '' : 's'}
          </a>
        </div>
        <p className="made-with">
          Made with <a href="/">Video bitEdit</a>
        </p>
      </div>
    </div>
  );
}
