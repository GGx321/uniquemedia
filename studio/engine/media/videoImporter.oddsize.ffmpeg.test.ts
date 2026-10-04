import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { tempDirFor } from "../../testing/tempDir";
import { ffmpegPath } from "../../node/ffmpegBinary";
import { runFfmpegOk } from "../render/ffmpeg.testkit";
import { requestFor, stage } from "./video/testing/importKit";
import { FIXTURES } from "./video/testing/fixtures/index";
import { withClaimedSize } from "./video/testing/mp4Patch";
import { createVideoImporter } from "./videoImporter";
import { checkVideoStreams, DISPLAY_CROP_SLACK_PX } from "./video/videoStreams";
useNativeGlobals();
setDefaultTimeout(120_000);

// 3f.6 review, round 3 (MEDIUM). Layer 2 compared ffmpeg's size with the walker's EXACTLY, and refused real Apple files: HEVC 4:2:0 can only crop to even sizes, so Apple writes the
// DISPLAY size (306 x 627, 459 x 940) in `stsd` and `tkhd` while the bitstream, and ffmpeg's stream line, say the coded size rounded up (306 x 628, 460 x 940). A coded size from the
// walker's up to 15 pixels a side more is the alignment of a codec; anything else is a bitstream that does not match its boxes (the L5 lie, 4224 x 2176 under 1920 x 1080).

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-oddsize-");
const signal = (): AbortSignal => new AbortController().signal;

/** H.264 of exactly `size`, two seconds. */
async function encoded(size: string): Promise<Uint8Array> {
  const out = join(tmp(), `clip-${size}.mp4`);
  await runFfmpegOk(["-hide_banner", "-y", "-nostdin", "-v", "error", "-f", "lavfi", "-i", `testsrc=size=${size}:rate=30:duration=2`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", out]);
  return new Uint8Array(await Bun.file(out).arrayBuffer());
}

describe("an odd display size over an even coded one: what Apple writes (real HEVC)", () => {
  const coded = async (): Promise<Uint8Array> => new Uint8Array(await Bun.file(FIXTURES["hevc-sdr-460x940.mp4"].file).arrayBuffer());
  const importer = (): ReturnType<typeof createVideoImporter> => createVideoImporter({ minDurationMs: 0 });

  test("ffmpeg's own stream line says the CODED size, not the boxes' (the premise of the whole round)", async () => {
    const path = join(tmp(), "odd.mp4");
    await Bun.write(path, withClaimedSize(await coded(), 459, 940));
    const dump = Bun.spawnSync([ffmpegPath(), "-hide_banner", "-codec_whitelist", "hevc", "-f", "mov", "-i", path], { stderr: "pipe" }).stderr.toString();
    expect(dump).toMatch(/Video: hevc .*, 460x940[ ,]/);
  });

  test("a clip coded 460 x 940 whose boxes say 459 x 940 is imported", async () => {
    const odd = withClaimedSize(await coded(), 459, 940);
    expect((await importer()(requestFor(tmp(), await stage(tmp(), odd)).request)).ok).toBe(true);
  });

  test("so is one whose boxes say an odd HEIGHT (460 x 939)", async () => {
    const odd = withClaimedSize(await coded(), 460, 939);
    expect((await importer()(requestFor(tmp(), await stage(tmp(), odd)).request)).ok).toBe(true);
  });

  test("a clip whose boxes claim 16 pixels less than its bitstream (460 x 940 said as 444 x 940) is still refused, and nothing is encoded", async () => {
    const lie = withClaimedSize(await coded(), 460 - (DISPLAY_CROP_SLACK_PX + 1), 940);
    const rig = requestFor(tmp(), await stage(tmp(), lie));
    expect(await importer()(rig.request)).toEqual({ ok: false, reason: "failed" });
    expect(rig.workFiles).toEqual([]);
  });

  test("and the L5 lie (a 4224 x 2176 bitstream under 1920 x 1080) is still refused by the check, far past the slack", async () => {
    const lie = new Uint8Array(await Bun.file(FIXTURES["h264-sps-4224x2176-claims-1080p.mp4"].file).arrayBuffer());
    expect(await importer()(requestFor(tmp(), await stage(tmp(), lie)).request)).toEqual({ ok: false, reason: "failed" });
  });
});

describe("the tolerance, asked of the check itself", () => {
  const file = async (): Promise<string> => {
    const path = join(tmp(), "subject.mp4");
    await Bun.write(path, await encoded("128x64"));
    return path;
  };
  const verdict = async (width: number, height: number) => checkVideoStreams({ path: await file(), expected: { codec: "h264", width, height }, signal: signal() });

  test("is 15 pixels a side: the dumped size may exceed the judged one by up to that, and not by one more", async () => {
    expect(DISPLAY_CROP_SLACK_PX).toBe(15);
    expect(await verdict(128 - 15, 64 - 15)).toBe("ok");
    expect(await verdict(128 - 16, 64)).toBe("mismatch");
    expect(await verdict(128, 64 - 16)).toBe("mismatch");
  });

  test("is one-sided: a stream SMALLER than the clip the walker judged is a mismatch (a crop only ever removes)", async () => {
    expect(await verdict(129, 64)).toBe("mismatch");
    expect(await verdict(128, 65)).toBe("mismatch");
  });

  test("the exact size is still ok", async () => {
    expect(await verdict(128, 64)).toBe("ok");
  });
});
