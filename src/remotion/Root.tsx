import { Composition } from 'remotion';
import { emptyTimeline, timelineDuration } from '../shared/project';
import { TimelineComposition, type TimelineProps } from './Timeline';

// Always composed at timeline size; draft presets downscale with renderMedia's `scale`.
export const Root: React.FC = () => (
  <Composition
    id="Timeline"
    component={TimelineComposition}
    defaultProps={{ timeline: emptyTimeline(), sources: {} } as TimelineProps}
    durationInFrames={1}
    fps={30}
    width={1920}
    height={1080}
    calculateMetadata={({ props }) => ({
      durationInFrames: Math.max(1, timelineDuration(props.timeline)),
      fps: props.timeline.fps,
      width: props.timeline.width,
      height: props.timeline.height,
    })}
  />
);
