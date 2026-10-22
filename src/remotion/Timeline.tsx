// The Remotion composition for one timeline. The browser preview
// (@remotion/player) and the render worker (@remotion/renderer) both use this
// component, so the export matches the preview frame for frame.

import '@fontsource-variable/inter';
import '@fontsource/anton';
import '@fontsource/space-mono/400.css';
import '@fontsource/space-mono/700.css';
import '@fontsource/playfair-display/400.css';
import '@fontsource/playfair-display/500.css';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import {
  AbsoluteFill,
  Freeze,
  Html5Audio,
  Img,
  OffthreadVideo,
  Sequence,
  continueRender,
  delayRender,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { captionLines } from '../shared/captionLooks';
import { CaptionLineView } from './CaptionLine';
import { type Clip, type Timeline, type Transition, clipSpeed, fadeEnvelope, framing } from '../shared/project';
import { applyEffects, enterTransition, exitTransition } from './effects';
import { SlideClip } from './Slide';
import { TITLE_FONT_FACES, getTheme, textMotion } from '../shared/themes';

/** Hold rendering until the title fonts are loaded, so text never renders in a fallback face. */
function useTitleFonts(needed: boolean) {
  const [handle] = useState(() => (needed ? delayRender('Loading title fonts') : null));
  useEffect(() => {
    if (handle === null) return;
    Promise.all(TITLE_FONT_FACES.map((f) => document.fonts.load(f)))
      .catch(() => undefined)
      .finally(() => continueRender(handle));
  }, [handle]);
}

export interface TimelineProps {
  timeline: Timeline;
  /** Theme ID from the project. */
  theme?: string;
  /** assetId → absolute media URL. */
  sources: Record<string, string>;
  // Remotion requires inputProps to be an index-signature-compatible record.
  [key: string]: unknown;
}

const TextClip: React.FC<{ clip: Clip; themeId?: string }> = ({ clip, themeId }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = clip.text!;
  const theme = getTheme(themeId);
  const motion = textMotion(t.animation ?? theme.animation, frame / fps, t.text.length);
  const opacity = (clip.opacity ?? 1) * fadeEnvelope(clip, frame) * motion.opacity;
  const scale = (clip.scale ?? 1) * motion.scale;
  const text = Number.isFinite(motion.chars) ? t.text.slice(0, motion.chars) : t.text;
  return (
    <AbsoluteFill style={{ opacity }}>
      <div
        style={{
          position: 'absolute',
          left: `${t.x * 100}%`,
          top: `${t.y * 100}%`,
          transform: `translate(-50%, ${-50 + motion.translateY * 100}%) scale(${scale}) rotate(${clip.rotation ?? 0}deg)`,
          fontSize: t.fontSize,
          fontWeight: t.fontWeight,
          color: t.color,
          background: t.background,
          padding: t.background === 'transparent' ? 0 : '0.2em 0.5em',
          borderRadius: '0.12em',
          fontFamily: t.fontFamily ?? theme.fontFamily,
          textShadow: t.background === 'transparent' ? '0 0.04em 0.25em rgba(0,0,0,0.45)' : undefined,
          whiteSpace: 'pre-wrap',
          textAlign: 'center',
          lineHeight: 1.15,
          width: 'max-content',
          maxWidth: '90%',
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
};

/** Caption words as short lines, animated in the clip's caption look (see shared/captionLooks.ts). */
const CaptionClip: React.FC<{ clip: Clip; themeId?: string }> = ({ clip, themeId }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = clip.text;
  const lines = useMemo(
    () => captionLines(clip.words ?? [], fps, { captionLook: t?.captionLook, wordsPerLine: t?.wordsPerLine }),
    [clip.words, fps, t?.captionLook, t?.wordsPerLine],
  );
  const line = lines.find((l) => frame >= l.start && frame < l.end);
  if (!line || !t) return null;
  const theme = getTheme(themeId);
  const accent = t.highlight ?? theme.presets.caption.highlight ?? '#ffd84d';
  const opacity = (clip.opacity ?? 1) * fadeEnvelope(clip, frame) * Math.min(1, (frame - line.start + 1) / 3);
  return (
    <AbsoluteFill style={{ opacity }}>
      <CaptionLineView line={line} frame={frame} fps={fps} style={t} fontFamily={theme.fontFamily} accent={accent} scale={clip.scale ?? 1} rotation={clip.rotation ?? 0} />
    </AbsoluteFill>
  );
};

const VisualClip: React.FC<{ clip: Clip; src?: string; muted: boolean; gain: number; exit?: Transition }> = ({
  clip,
  src,
  muted,
  gain,
  exit,
}) => {
  const frame = useCurrentFrame();
  const { width } = useVideoConfig();
  if (!src) return null;
  const enter = exit ? null : enterTransition(clip.transition, frame);
  const leave = exit ? exitTransition(exit, frame) : null;
  const fx = applyEffects(clip, exit ? frame + clip.in! : frame, width);
  const opacity = (clip.opacity ?? 1) * fadeEnvelope(clip, frame) * (enter?.opacity ?? 1);
  const { transform, objectPosition } = framing(clip);
  const mediaStyle: React.CSSProperties = { width: '100%', height: '100%', objectFit: clip.fit ?? 'contain', objectPosition };
  const outer = [enter?.transform, leave?.transform, transform].filter(Boolean).join(' ');
  const motionGain = enter?.gain ?? leave?.gain ?? 1;
  return (
    <AbsoluteFill style={{ opacity, transform: outer, clipPath: enter?.clipPath, filter: enter?.filter || leave?.filter || undefined }}>
      {fx.defs}
      <AbsoluteFill style={{ transform: fx.transform || undefined, filter: fx.filter || undefined }}>
        {clip.kind === 'image' ? (
          <Img src={src} style={mediaStyle} />
        ) : clip.freeze ? (
          // A freeze frame holds the source frame at `in`: the video is frozen at its first frame, silent.
          <Freeze frame={0}>
            <OffthreadVideo src={src} trimBefore={clip.in ?? 0} muted style={mediaStyle} />
          </Freeze>
        ) : (
          // Speed plays the source faster or slower (playbackRate); `in` is in source frames. Pitch is kept.
          <OffthreadVideo
            src={src}
            trimBefore={clip.in ?? 0}
            playbackRate={clipSpeed(clip)}
            muted={muted || Boolean(clip.muted)}
            volume={(f) => gain * motionGain * (clip.volume ?? 1) * fadeEnvelope(clip, f)}
            pauseWhenBuffering
            style={mediaStyle}
          />
        )}
      </AbsoluteFill>
      {fx.overlays}
      {enter?.flash && <AbsoluteFill style={{ background: enter.flash.color, opacity: enter.flash.opacity }} />}
    </AbsoluteFill>
  );
};

/** Text and captions enter with the same transitions, without a tail underneath. */
const Entering: React.FC<{ clip: Clip; children: React.ReactNode }> = ({ clip, children }) => {
  const frame = useCurrentFrame();
  const t = enterTransition(clip.transition, frame);
  if (!clip.transition) return <>{children}</>;
  return <AbsoluteFill style={{ opacity: t.opacity, transform: t.transform || undefined, clipPath: t.clipPath }}>{children}</AbsoluteFill>;
};

/**
 * For a clip with a transition, the clip before it on the same track keeps
 * playing underneath for the transition's length (its "tail"), so crossfades
 * and slides have something to reveal.
 */
function transitionTails(clips: Clip[]): { tail: Clip; exit: Transition }[] {
  const out: { tail: Clip; exit: Transition }[] = [];
  for (const b of clips) {
    if (!b.transition || b.kind === 'text' || b.kind === 'caption' || b.kind === 'audio') continue;
    const a = clips.find((c) => c.id !== b.id && c.start + c.duration === b.start && (c.kind === 'video' || c.kind === 'image'));
    if (!a) continue;
    const duration = Math.min(b.transition.duration, b.duration);
    out.push({
      tail: {
        ...a,
        id: `${a.id}-tail`,
        start: b.start,
        duration,
        in: (a.in ?? 0) + Math.round(a.duration * clipSpeed(a)),
        fadeIn: 0,
        fadeOut: 0,
        transition: undefined,
      },
      exit: { ...b.transition, duration },
    });
  }
  return out;
}

/**
 * Media clips mount this long before they start, hidden and already seeked to
 * their in-point, so playback does not hitch at every cut while a new video
 * element loads. Rendering ignores it.
 */
const PREMOUNT_SECONDS = 1;

export const TimelineComposition: React.FC<TimelineProps> = ({ timeline, theme, sources }) => {
  useTitleFonts(timeline.clips.some((c) => c.kind === 'text' || c.kind === 'caption' || c.kind === 'slide'));
  const premountFor = Math.round(PREMOUNT_SECONDS * timeline.fps);
  // Tracks are listed top to bottom, so draw the bottom video track first.
  const videoTracks = timeline.tracks.filter((t) => t.kind === 'video').reverse();
  const audioTracks = timeline.tracks.filter((t) => t.kind === 'audio' && !t.muted);
  return (
    <AbsoluteFill style={{ background: timeline.background }}>
      {videoTracks.map((track) => (
        <AbsoluteFill key={track.id} style={{ visibility: track.hidden ? 'hidden' : 'visible' }}>
          {transitionTails(timeline.clips.filter((c) => c.trackId === track.id && c.duration > 0 && !c.disabled)).map(({ tail, exit }) => (
            <Sequence key={tail.id} from={tail.start} durationInFrames={tail.duration} name="transition" premountFor={premountFor}>
              <VisualClip
                clip={tail}
                src={tail.assetId ? sources[tail.assetId] : undefined}
                muted={Boolean(track.muted || track.hidden)}
                gain={track.volume ?? 1}
                exit={exit}
              />
            </Sequence>
          ))}
          {timeline.clips
            .filter((c) => c.trackId === track.id && c.duration > 0 && !c.disabled)
            .map((clip) => (
              <Sequence
                key={clip.id}
                from={clip.start}
                durationInFrames={clip.duration}
                name={clip.kind}
                premountFor={clip.kind === 'video' || clip.kind === 'image' || clip.kind === 'slide' ? premountFor : undefined}
              >
                {clip.kind === 'slide' && clip.slide ? (
                  <Entering clip={clip}>
                    <SlideClip clip={clip} src={clip.slide.imageAssetId ? sources[clip.slide.imageAssetId] : undefined} />
                  </Entering>
                ) : clip.kind === 'caption' ? (
                  <Entering clip={clip}>
                    <CaptionClip clip={clip} themeId={theme} />
                  </Entering>
                ) : clip.kind === 'text' && clip.text ? (
                  <Entering clip={clip}>
                    <TextClip clip={clip} themeId={theme} />
                  </Entering>
                ) : (
                  <VisualClip
                    clip={clip}
                    src={clip.assetId ? sources[clip.assetId] : undefined}
                    muted={Boolean(track.muted || track.hidden)}
                    gain={track.volume ?? 1}
                  />
                )}
              </Sequence>
            ))}
        </AbsoluteFill>
      ))}
      {audioTracks.flatMap((track) =>
        timeline.clips
          .filter((c) => c.trackId === track.id && c.assetId && sources[c.assetId] && c.duration > 0 && !c.disabled)
          .map((clip) => (
            // A full-frame (but empty) layout, because premounting does not support layout="none".
            <Sequence key={clip.id} from={clip.start} durationInFrames={clip.duration} name="audio" premountFor={premountFor}>
              <Html5Audio
                src={sources[clip.assetId!]}
                trimBefore={clip.in ?? 0}
                playbackRate={clipSpeed(clip)}
                volume={(f) => (track.volume ?? 1) * (clip.volume ?? 1) * fadeEnvelope(clip, f)}
                pauseWhenBuffering
              />
            </Sequence>
          )),
      )}
    </AbsoluteFill>
  );
};
