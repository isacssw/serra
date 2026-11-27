// Two cuts of one timeline: 16:9 for the launch post, 1:1 for X. `music` and `sfx` make the silent and SFX-only versions.
import { Composition } from 'remotion';
import { Launch, type LaunchProps } from './Launch.tsx';
import { FPS, TOTAL_FRAMES } from './timing.ts';

const defaults: LaunchProps = { music: true, sfx: true };

export const Root = () => (
  <>
    <Composition id="Launch" component={Launch} width={1920} height={1080} fps={FPS} durationInFrames={TOTAL_FRAMES} defaultProps={defaults} />
    <Composition id="LaunchSquare" component={Launch} width={1080} height={1080} fps={FPS} durationInFrames={TOTAL_FRAMES} defaultProps={defaults} />
  </>
);
