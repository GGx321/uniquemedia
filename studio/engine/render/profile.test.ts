import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { assertSafeFilterGraph } from "./filterString";
import {
  COLOUR_TAG_ARGS,
  CONTAINER_ARGS,
  FILTER_THREAD_ARGS,
  FINAL_AUDIO_ARGS,
  FINAL_VIDEO_ARGS,
  FRAME_TAGS,
  INTERMEDIATE_VIDEO_ARGS,
  METADATA_ARGS,
  OVERLAY_COLOUR_CHAIN,
  PHOTO_COLOUR_CHAIN,
} from "./profile";
useNativeGlobals();

/** The value after a flag, or undefined. */
function after(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i < 0 ? undefined : args[i + 1];
}

describe("the colour chains (plan: Output format, SP1)", () => {
  test("a photo goes from full-range BT.601 to limited-range BT.709 through swscale, then 4:2:0", () => {
    expect(PHOTO_COLOUR_CHAIN.startsWith("scale=in_range=pc:in_color_matrix=bt601:out_range=tv:out_color_matrix=bt709:")).toBe(true);
    expect(PHOTO_COLOUR_CHAIN).toContain(",format=yuv420p,");
  });

  test("the photo conversion asks for accurate rounding, so the x86 builds (Windows, Linux) match the arm64 one within 2 code values", () => {
    // Measured: without it, x86 ffmpeg 6.1.1 is up to 2.16 code values off in Y on the chart; with it, every build is within 0.9.
    expect(PHOTO_COLOUR_CHAIN).toContain(":flags=accurate_rnd+full_chroma_int,");
  });

  test("the frames are tagged after the swscale conversion", () => {
    expect(PHOTO_COLOUR_CHAIN.endsWith(FRAME_TAGS)).toBe(true);
    expect(PHOTO_COLOUR_CHAIN.indexOf("scale=in_range=pc")).toBeLessThan(PHOTO_COLOUR_CHAIN.indexOf("setparams="));
  });

  test("the tag is BT.709 in every field and limited range", () => {
    expect(FRAME_TAGS).toBe("setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv");
  });

  test("the photo chain does not use zscale, which needs tagged input first", () => {
    expect(PHOTO_COLOUR_CHAIN).not.toContain("zscale");
  });

  test("an overlay is converted to BT.709 limited range explicitly, never left to the auto scaler", () => {
    expect(OVERLAY_COLOUR_CHAIN).toBe("format=rgba,scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuva420p");
  });

  test("both chains fit the strict graph charset", () => {
    expect(() => assertSafeFilterGraph(PHOTO_COLOUR_CHAIN)).not.toThrow();
    expect(() => assertSafeFilterGraph(OVERLAY_COLOUR_CHAIN)).not.toThrow();
  });
});

describe("encoder profiles", () => {
  test("every ffmpeg call is capped at 2 filter threads", () => {
    expect(FILTER_THREAD_ARGS).toEqual(["-filter_threads", "2", "-filter_complex_threads", "2"]);
  });

  test("the encoder tags say BT.709 limited range", () => {
    expect(COLOUR_TAG_ARGS).toEqual(["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"]);
  });

  test("the intermediate is x264 ultrafast CRF 8 in yuv420p", () => {
    expect(after(INTERMEDIATE_VIDEO_ARGS, "-c:v")).toBe("libx264");
    expect(after(INTERMEDIATE_VIDEO_ARGS, "-preset")).toBe("ultrafast");
    expect(after(INTERMEDIATE_VIDEO_ARGS, "-crf")).toBe("8");
    expect(after(INTERMEDIATE_VIDEO_ARGS, "-pix_fmt")).toBe("yuv420p");
  });

  test.each([
    ["the intermediate", INTERMEDIATE_VIDEO_ARGS],
    ["the final", FINAL_VIDEO_ARGS],
  ])("%s is 30 fps constant frame rate, so the image demuxer's 25 fps can never drop frames", (_name, args) => {
    expect(after(args, "-r")).toBe("30");
    expect(after(args, "-fps_mode")).toBe("cfr");
  });

  test.each([
    ["the intermediate", INTERMEDIATE_VIDEO_ARGS],
    ["the final", FINAL_VIDEO_ARGS],
  ])("%s carries the BT.709 tags", (_name, args) => {
    for (let i = 0; i < COLOUR_TAG_ARGS.length; i += 2) expect(after(args, COLOUR_TAG_ARGS[i] ?? "")).toBe(COLOUR_TAG_ARGS[i + 1]);
  });

  test("the final video is x264 High, medium, CRF 20 under the 3500k cap with a 2 s window", () => {
    expect(after(FINAL_VIDEO_ARGS, "-c:v")).toBe("libx264");
    expect(after(FINAL_VIDEO_ARGS, "-profile:v")).toBe("high");
    expect(after(FINAL_VIDEO_ARGS, "-preset")).toBe("medium");
    expect(after(FINAL_VIDEO_ARGS, "-crf")).toBe("20");
    expect(after(FINAL_VIDEO_ARGS, "-maxrate")).toBe("3500k");
    expect(after(FINAL_VIDEO_ARGS, "-bufsize")).toBe("7000k");
    expect(after(FINAL_VIDEO_ARGS, "-pix_fmt")).toBe("yuv420p");
  });

  test("the final video has a 2 s keyframe interval at most, and a 1 s minimum", () => {
    expect(after(FINAL_VIDEO_ARGS, "-g")).toBe("60");
    expect(after(FINAL_VIDEO_ARGS, "-keyint_min")).toBe("30");
  });

  test.each([
    ["the intermediate", INTERMEDIATE_VIDEO_ARGS],
    ["the final", FINAL_VIDEO_ARGS],
  ])("%s runs the encoder on 2 threads", (_name, args) => {
    expect(after(args, "-threads")).toBe("2");
  });

  test("the audio is AAC-LC at 48 kHz stereo, 192 kbit/s", () => {
    expect(FINAL_AUDIO_ARGS).toEqual(["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"]);
  });

  test("the MP4 is faststart", () => {
    expect(CONTAINER_ARGS).toEqual(["-movflags", "+faststart"]);
  });

  test("metadata and chapters are stripped and nothing asks for bitexact or a creation time", () => {
    expect(METADATA_ARGS).toEqual(["-map_metadata", "-1", "-map_chapters", "-1"]);
    const all = [...FINAL_VIDEO_ARGS, ...FINAL_AUDIO_ARGS, ...CONTAINER_ARGS, ...METADATA_ARGS].join(" ");
    expect(all).not.toContain("bitexact");
    expect(all).not.toContain("creation_time");
  });

  test("no profile terminates the output by frames, time or shortest (invariant 20)", () => {
    for (const args of [INTERMEDIATE_VIDEO_ARGS, FINAL_VIDEO_ARGS, FINAL_AUDIO_ARGS, CONTAINER_ARGS, METADATA_ARGS]) {
      for (const bad of ["-frames:v", "-frames", "-t", "-to", "-shortest"]) expect(args).not.toContain(bad);
    }
  });
});
