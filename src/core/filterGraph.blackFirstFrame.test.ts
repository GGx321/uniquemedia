import { test, expect } from "bun:test";
import { buildArgs } from "./filterGraph";
import type { MediaInfo, Recipe } from "./types";

/**
 * The black first frame is applied to the concat OUTPUT, after every segment
 * has been re-timed, so it is the first frame of the file whatever speed the
 * first segment runs at. It is not part of the spatial chain: that runs before
 * split/trim, and a frame blacked out there could be trimmed away or land in
 * the middle of the output after setpts.
 *
 * The `fps=` in front of the drawbox is the whole point of the pair. The encode
 * applies `-r <fps> -fps_mode cfr` AFTER the graph; on a source slower than the
 * target ffmpeg duplicates frames to reach CFR, and a single black frame from
 * the graph would be duplicated with the rest into two or three. Converting to
 * the target rate inside the graph first means `n` in `eq(n,0)` counts output
 * frames, and the `-r` that follows has nothing left to duplicate.
 */

const info: MediaInfo = { kind: "video", durationSec: 5, width: 1280, height: 720, hasAudio: true };

const off: Recipe = {
  seed: 1,
  intensity: 1,
  exportFormat: "reels",
  keepTrendAudio: false,
  spoof: false,
  blackFirstFrame: false,
  segments: [
    { fraction: 0.5, speed: 1.03 },
    { fraction: 0.5, speed: 0.97 },
  ],
  video: [
    { id: "eq", params: { brightness: 0.01, contrast: 1.02, saturation: 0.99, gamma: 1 } },
    { id: "encode", params: { crf: 21, fps: 30, gop: 60, keyintMin: 30, preset: "faster", audioKbps: 128 } },
  ],
  audio: [{ id: "aeq", params: { gain: 1.5 } }],
};

const on: Recipe = { ...off, blackFirstFrame: true };

const complexOf = (args: string[]) => args[args.indexOf("-filter_complex") + 1];

const DRAWBOX = "drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='eq(n,0)'";

/** The graph exactly as it ships today with the toggle off. A characterisation
 *  pin: the toggle must be invisible in the graph until it is switched on. */
const BASELINE_OFF =
  "[0:v]eq=brightness=0.01:contrast=1.02:saturation=0.99:gamma=1," +
  "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,split=2[v0][v1];" +
  "[v0]trim=start=0.000:end=2.500,setpts=(PTS-STARTPTS)/1.03[s0];" +
  "[v1]trim=start=2.500:end=5.000,setpts=(PTS-STARTPTS)/0.97[s1];" +
  "[s0][s1]concat=n=2:v=1:a=0[outv];" +
  "[0:a]equalizer=f=3000:t=q:w=1:g=1.5,asplit=2[a0][a1];" +
  "[a0]atrim=start=0.000:end=2.500,asetpts=PTS-STARTPTS,atempo=1.03[b0];" +
  "[a1]atrim=start=2.500:end=5.000,asetpts=PTS-STARTPTS,atempo=0.97[b1];" +
  "[b0][b1]concat=n=2:v=0:a=1[outa]";

test("with the toggle off the graph is byte-identical to the shipped one", () => {
  expect(complexOf(buildArgs(off, info))).toBe(BASELINE_OFF);
});

test("with the toggle on, fps then drawbox sit between the video concat and [outv]", () => {
  const fc = complexOf(buildArgs(on, info));
  expect(fc).toContain(`[s0][s1]concat=n=2:v=1:a=0,fps=30,${DRAWBOX}[outv]`);
});

test("with the toggle on, nothing but that pair changes anywhere in the args", () => {
  // Same args, same order, same audio branch, same encode flags: the pair is
  // the whole difference, so removing it must give back the off graph.
  const onArgs = buildArgs(on, info);
  const offArgs = buildArgs(off, info);
  expect(onArgs.length).toBe(offArgs.length);
  const stripped = onArgs.map((a) => a.replace(`,fps=30,${DRAWBOX}`, ""));
  expect(stripped).toEqual(offArgs);
});

test("the pair is not in the spatial chain, which runs before the split", () => {
  const fc = complexOf(buildArgs(on, info));
  const spatial = fc.slice(0, fc.indexOf("split=2"));
  expect(spatial).not.toContain("drawbox");
  expect(spatial).not.toContain("fps=");
});

test("the fps in front of the drawbox follows the recipe's encode fps", () => {
  // The graph rate must equal the `-r` that follows, or the duplication the
  // filter exists to pre-empt happens anyway.
  const at24: Recipe = {
    ...on,
    video: on.video.map((o) =>
      o.id === "encode" ? { ...o, params: { ...o.params, fps: 24, gop: 48, keyintMin: 24 } } : o
    ),
  };
  const args = buildArgs(at24, info);
  expect(complexOf(args)).toContain(`concat=n=2:v=1:a=0,fps=24,${DRAWBOX}[outv]`);
  expect(args[args.indexOf("-r") + 1]).toBe("24");
});

test("the pair is emitted for a silent source too, on the only branch there is", () => {
  const fc = complexOf(buildArgs(on, { ...info, hasAudio: false }));
  expect(fc).toContain(`concat=n=2:v=1:a=0,fps=30,${DRAWBOX}[outv]`);
  expect(fc).not.toContain("[outa]");
});

test("the pair follows the concat whatever the segment count", () => {
  const five: Recipe = {
    ...on,
    segments: [
      { fraction: 0.2, speed: 1.0 },
      { fraction: 0.2, speed: 1.05 },
      { fraction: 0.2, speed: 0.95 },
      { fraction: 0.2, speed: 1.02 },
      { fraction: 0.2, speed: 0.98 },
    ],
  };
  const fc = complexOf(buildArgs(five, info));
  expect(fc).toContain(`[s0][s1][s2][s3][s4]concat=n=5:v=1:a=0,fps=30,${DRAWBOX}[outv]`);
});
