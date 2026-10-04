import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ffmpegPath } from "../../node/ffmpegBinary";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { tempDirFor } from "../../testing/tempDir";
import { requestFor, stage } from "./video/testing/importKit";
import { createVideoImporter } from "./videoImporter";
useNativeGlobals();
setDefaultTimeout(120_000);

// The `-fs` bound of the mezzanine's encode on REAL ffmpeg (3f.3b, M-A). When the limit fires ffmpeg does not finish: it says "Error muxing a packet" and exits non-zero (187 on 6.0;
// another way on another build), so the importer must read the size of what it wrote BEFORE it takes the exit for a failure. The limit's headroom is a parameter so that the test
// is fast (the product's is 64 MiB); the caps are tiny, against a clip of noise that cannot fit them.

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-video-fs-");

/** Three seconds of busy noise, 540 x 960, as an MP4 the importer takes: far more than a few hundred KB once it is encoded at CRF 16. */
async function noisySource(): Promise<Uint8Array> {
  const path = join(tmp(), "noisy.mp4");
  const run = spawnSync(
    ffmpegPath(),
    [
      "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=540x960:r=30:d=3,noise=alls=40:allf=t+u",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv", path,
    ],
    { maxBuffer: 1 << 26 },
  );
  if (run.status !== 0) throw new Error(`ffmpeg could not make the source: ${run.stderr.toString()}`);
  return new Uint8Array(await readFile(path));
}

describe("the mezzanine's -fs bound, on real ffmpeg", () => {
  test("a clip whose mezzanine cannot fit the cap is refused too-large (not failed), its work file is released, and the file ffmpeg stopped is small", async () => {
    const rig = requestFor(tmp(), await stage(tmp(), await noisySource()));

    const outcome = await createVideoImporter({ maxStoredBytes: 150_000, stopSlackBytes: 150_000 })(rig.request);

    expect(outcome).toEqual({ ok: false, reason: "too-large" });
    expect(rig.released).toHaveLength(1);
    // The write bound held: ffmpeg stopped near the limit, nowhere near what the whole clip would have taken.
    const written = await stat(rig.workFiles[0]?.path ?? "").then((s) => s.size, () => 0);
    expect(written).toBeLessThan(300_000 + 2 * 1024 * 1024);
  });

  test("the same clip under a cap it fits is stored, so the refusal above is the cap's and not the source's", async () => {
    const rig = requestFor(tmp(), await stage(tmp(), await noisySource()));

    const outcome = await createVideoImporter({ maxStoredBytes: 200 * 1024 * 1024 })(rig.request);

    expect(outcome.ok).toBe(true);
    expect((await readdir(tmp())).length).toBeGreaterThan(0);
  });
});
