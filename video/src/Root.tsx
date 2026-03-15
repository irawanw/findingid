import React from "react";
import { Composition, getInputProps } from "remotion";
import { ShortVideo } from "./ShortVideo";
import defaultScript from "../../scripts/short_86558.json";
import defaultTiming from "../../scripts/short_86558_timing.json";

export const RemotionRoot: React.FC = () => {
  const inputProps = getInputProps() as {
    script?: typeof defaultScript;
    timing?: typeof defaultTiming;
  };

  const script = inputProps.script ?? defaultScript;
  const timing = inputProps.timing ?? defaultTiming;

  return (
    <Composition
      id="ShortVideo"
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      component={ShortVideo as any}
      durationInFrames={Math.ceil((timing.total_ms / 1000) * 30) + 30}
      fps={30}
      width={1080}
      height={1920}
      defaultProps={{
        script,
        timing,
      }}
    />
  );
};
