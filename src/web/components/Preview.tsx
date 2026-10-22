import { Player, type PlayerRef } from '@remotion/player';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { formatTimecode, timelineDuration } from '../../shared/project';
import { TimelineComposition } from '../../remotion/Timeline';
import { mediaUrl } from '../api';
import { Icon } from './Icon';
import { activeTimeline, useEditor } from '../store';

export function Preview() {
  const doc = useEditor((s) => s.doc);
  const timelineId = useEditor((s) => s.timelineId);
  const assets = useEditor((s) => s.assets);
  const projectId = useEditor((s) => s.projectId);
  const playing = useEditor((s) => s.playing);
  const playbackRate = useEditor((s) => s.playbackRate);
  const timeline = activeTimeline({ doc, timelineId });
  const ref = useRef<PlayerRef>(null);

  const sources = useMemo(
    () => Object.fromEntries(assets.filter((a) => a.status === 'ready').map((a) => [a.id, mediaUrl(projectId, a.id)])),
    [assets, projectId],
  );
  const inputProps = useMemo(() => ({ timeline, theme: doc.theme, sources }), [timeline, doc.theme, sources]);
  const duration = Math.max(1, timelineDuration(timeline));

  const attach = useCallback((player: PlayerRef | null) => {
    (ref as React.MutableRefObject<PlayerRef | null>).current = player;
    useEditor.setState({ player });
  }, []);

  useEffect(() => {
    const player = ref.current;
    if (!player) return;
    const onFrame = (e: { detail: { frame: number } }) => useEditor.setState({ playhead: e.detail.frame });
    const onPlay = () => useEditor.setState({ playing: true });
    const onPause = () => useEditor.setState({ playing: false });
    player.addEventListener('frameupdate', onFrame);
    player.addEventListener('play', onPlay);
    player.addEventListener('pause', onPause);
    player.seekTo(Math.min(useEditor.getState().playhead, duration - 1));
    return () => {
      player.removeEventListener('frameupdate', onFrame);
      player.removeEventListener('play', onPlay);
      player.removeEventListener('pause', onPause);
    };
  }, [timeline.id, duration]);

  const seek = useEditor((s) => s.seek);
  const playhead = useEditor((s) => s.playhead);

  return (
    <section className="preview">
      <div className="player-wrap">
        <Player
          ref={attach}
          component={TimelineComposition}
          inputProps={inputProps}
          durationInFrames={duration}
          fps={timeline.fps}
          compositionWidth={timeline.width}
          compositionHeight={timeline.height}
          style={{ width: '100%', height: '100%' }}
          clickToPlay
          doubleClickToFullscreen
          spaceKeyToPlayOrPause={false}
          acknowledgeRemotionLicense
          numberOfSharedAudioTags={8}
          playbackRate={playbackRate}
        />
      </div>
      <div className="transport">
        <span className="timecode lcd">
          {formatTimecode(playhead, timeline.fps)}
          <span className="tc-total"> / {formatTimecode(duration, timeline.fps)}</span>
        </span>
        <div className="transport-buttons">
          <button title="Start (Home)" onClick={() => seek(0)}>
            <Icon name="skip-back" />
          </button>
          <button title="Previous frame (←)" onClick={() => seek(playhead - 1)}>
            <Icon name="step-back" />
          </button>
          <button className="play" title="Play / pause (Space)" onClick={() => ref.current?.toggle()}>
            <Icon name={playing ? 'pause' : 'play'} size={20} />
          </button>
          <button title="Next frame (→)" onClick={() => seek(playhead + 1)}>
            <Icon name="step-fwd" />
          </button>
          <button title="End (End)" onClick={() => seek(duration - 1)}>
            <Icon name="skip-fwd" />
          </button>
        </div>
        <label className="volume" title="Preview volume">
          <Icon name="speaker" />
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            defaultValue={1}
            onChange={(e) => ref.current?.setVolume(Number(e.target.value))}
            aria-label="Preview volume"
          />
        </label>
        <button className="fullscreen" title="Fullscreen" onClick={() => ref.current?.requestFullscreen()}>
          <Icon name="grid" />
        </button>
      </div>
    </section>
  );
}
