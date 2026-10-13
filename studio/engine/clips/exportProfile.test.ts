import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { COLOUR_TAG_ARGS } from "../render/profile";
import { clipExportArgv, EXPORT_PROFILE_OF, EXPORT_RATE_OF, expectedExportBytes, expectedExportFrames, type ClipExportArgvInput, type ExportFpsMode } from "./exportProfile";
useNativeGlobals();

// Stage 5, 5b.1, S5.V4c (plan s5b1 §5.13, I5.55, I5.58; owner Q-C): the ffmpeg argv of «Сохранить в папку». It re-encodes the library's mp4 (never touched) into H.264 High 1080 x 1920,
// 30 fps (or 24), faststart, BT.709 tags, no audio, with every tag stripped except the real `creation_time`. These tests pin the argv itself; the file it makes is judged by
// exportVerify.ffmpeg.test.ts.

const EXPORTED_AT = new Date("2026-10-14T09:30:15.000Z");
const INPUT = join("library", "avatars", "avatar-0001", "clips", "clip-0001.mp4");
const OUTPUT = join("export", "Nini", ".studio-part-job-0001.mp4");

function argvOf(mode: ExportFpsMode, patch: Partial<ClipExportArgvInput> = {}): string[] {
  return clipExportArgv({ input: INPUT, output: OUTPUT, mode, colour: { matrix: 1, fullRange: false, dynamicRange: "sdr" }, exportedAt: EXPORTED_AT, ...patch });
}

/** The value after `flag` (its first occurrence), or undefined. */
function after(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at < 0 ? undefined : argv[at + 1];
}

/** Every value of a repeated `flag`. */
function valuesOf(argv: readonly string[], flag: string): string[] {
  return argv.flatMap((token, i) => (token === flag ? [argv[i + 1] ?? ""] : []));
}

describe("the three EXPORT_FPS modes", () => {
  test("each mode names the profile the record keeps and the rate the file plays at", () => {
    expect(EXPORT_PROFILE_OF).toEqual({ interpolate: "1080p30-interp", duplicate: "1080p30-dup", native24: "1080p24" });
    expect(EXPORT_RATE_OF).toEqual({ interpolate: 30, duplicate: 30, native24: 24 });
  });

  test("interpolate motion-interpolates to 30 fps at the SOURCE size, before the scale", () => {
    const filter = after(argvOf("interpolate"), "-vf") ?? "";
    expect(filter.startsWith("minterpolate=fps=30:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1,")).toBe(true);
    expect(filter.indexOf("minterpolate")).toBeLessThan(filter.indexOf("scale="));
    expect(after(argvOf("interpolate"), "-r")).toBe("30");
  });

  test("duplicate repeats frames up to 30 fps and never interpolates", () => {
    const filter = after(argvOf("duplicate"), "-vf") ?? "";
    expect(filter.startsWith("fps=30,")).toBe(true);
    expect(filter.includes("minterpolate")).toBe(false);
    expect(after(argvOf("duplicate"), "-r")).toBe("30");
  });

  test("native24 keeps the providers' 24 fps and never interpolates", () => {
    const filter = after(argvOf("native24"), "-vf") ?? "";
    expect(filter.startsWith("fps=24,")).toBe(true);
    expect(filter.includes("minterpolate")).toBe(false);
    expect(after(argvOf("native24"), "-r")).toBe("24");
  });
});

describe("the picture", () => {
  test("is scaled to 1080 x 1920 with lanczos, from the clip's own matrix and range to BT.709 limited, as 4:2:0", () => {
    expect(after(argvOf("duplicate"), "-vf")).toBe("fps=30,scale=1080:1920:flags=lanczos:in_color_matrix=bt709:in_range=tv:out_color_matrix=bt709:out_range=tv,format=yuv420p");
  });

  test("a BT.601 full-range source is read as what it is, never assumed BT.709", () => {
    const filter = after(argvOf("duplicate", { colour: { matrix: 6, fullRange: true, dynamicRange: "sdr" } }), "-vf") ?? "";
    expect(filter.includes("in_color_matrix=smpte170m:in_range=pc")).toBe(true);
  });

  test("a matrix code the scaler has no name for is a defect, never a guess written into the graph", () => {
    expect(() => argvOf("duplicate", { colour: { matrix: 4, fullRange: false, dynamicRange: "sdr" } })).toThrow();
  });

  test("H.264 High, preset medium, CRF 18 under the 12 Mbit/s cap with a 24 Mbit buffer, a 2 s GOP, constant frame rate, BT.709 tags", () => {
    const argv = argvOf("interpolate");
    expect(after(argv, "-c:v")).toBe("libx264");
    expect(after(argv, "-profile:v")).toBe("high");
    expect(after(argv, "-preset")).toBe("medium");
    expect(after(argv, "-crf")).toBe("18");
    expect(after(argv, "-maxrate")).toBe("12M");
    expect(after(argv, "-bufsize")).toBe("24M");
    expect(after(argv, "-g")).toBe("60");
    expect(after(argv, "-fps_mode")).toBe("cfr");
    expect(after(argv, "-pix_fmt")).toBe("yuv420p");
    const at = argv.indexOf(COLOUR_TAG_ARGS[0] ?? "");
    expect(argv.slice(at, at + COLOUR_TAG_ARGS.length)).toEqual([...COLOUR_TAG_ARGS]);
  });
});

describe("what is read", () => {
  test("the input is read under the hardened head: no stdin, file protocol only, the mov demuxer forced, before -i", () => {
    const argv = argvOf("duplicate");
    const input = argv.indexOf("-i");
    expect(argv[input + 1]).toBe(INPUT);
    expect(argv.includes("-nostdin")).toBe(true);
    expect(after(argv, "-protocol_whitelist")).toBe("file");
    expect(argv.indexOf("-protocol_whitelist")).toBeLessThan(input);
    expect(after(argv, "-f")).toBe("mov");
    expect(argv.indexOf("-f")).toBeLessThan(input);
  });

  test("only the first video stream is mapped (no audio, subtitle or data track, so Grok's stray sound never leaves)", () => {
    const argv = argvOf("duplicate");
    expect(valuesOf(argv, "-map")).toEqual(["0:V:0"]);
    for (const flag of ["-an", "-sn", "-dn"]) expect(argv.includes(flag)).toBe(true);
  });
});

describe("what the file says about itself (I5.58)", () => {
  test("every container, stream and chapter tag is dropped, and the muxer and encoder write no signature", () => {
    const argv = argvOf("interpolate");
    expect(valuesOf(argv, "-map_metadata")).toEqual(["-1"]);
    expect(after(argv, "-map_metadata:s:v:0")).toBe("-1");
    expect(after(argv, "-map_chapters")).toBe("-1");
    expect(after(argv, "-fflags")).toBe("+bitexact");
    expect(after(argv, "-flags:v")).toBe("+bitexact");
    expect(after(argv, "-bsf:v")).toBe("filter_units=remove_types=6");
  });

  test("the handler names are empty and the compressor name is ONE space (an empty value lets ffmpeg 6.0 write «Lavc libx264» again)", () => {
    const argv = argvOf("interpolate");
    expect(after(argv, "-empty_hdlr_name")).toBe("1");
    expect(after(argv, "-metadata:s:v:0")).toBe("encoder= ");
  });

  test("the only container tag written is creation_time, the real export time", () => {
    expect(valuesOf(argvOf("native24"), "-metadata")).toEqual(["creation_time=2026-10-14T09:30:15.000Z"]);
  });

  test("no argv of any mode names a device, a place, a camera or an «AI» claim", () => {
    for (const mode of ["interpolate", "duplicate", "native24"] as const) {
      const text = argvOf(mode).join(" ").toLowerCase();
      for (const word of ["make", "model", "location", "gps", "©xyz", "com.apple", "shot on", "camera", "lens", "ai-generated", "not ai"]) expect(text.includes(word)).toBe(false);
    }
  });
});

describe("the container", () => {
  test("is an MP4 with the index up front, written over the empty temp the job made, the output last", () => {
    const argv = argvOf("duplicate");
    expect(after(argv, "-movflags")).toBe("+faststart");
    expect(argv.at(-1)).toBe(OUTPUT);
    expect(argv.at(-2)).toBe("mp4");
    expect(argv.at(-3)).toBe("-f");
    expect(argv.includes("-y")).toBe(true);
  });
});

describe("the estimates", () => {
  test("the size a clip may take is its length at the 12 Mbit/s cap, with a quarter more", () => {
    expect(expectedExportBytes(10_000)).toBe(18_750_000);
    expect(expectedExportBytes(5_040)).toBe(9_450_000);
  });

  test("the frames the progress counts are the length at the profile's rate", () => {
    expect(expectedExportFrames(5_040, "interpolate")).toBe(151);
    expect(expectedExportFrames(5_040, "duplicate")).toBe(151);
    expect(expectedExportFrames(5_040, "native24")).toBe(121);
    expect(expectedExportFrames(10, "native24")).toBe(1);
  });
});
