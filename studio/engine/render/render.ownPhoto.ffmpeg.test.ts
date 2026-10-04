import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Clip } from "../../shared/engine/montage";
import { heavyTest } from "../../testing/bunTiers";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { quadrantPicture } from "../media/photoFixtures.testkit";
import { probeVideo } from "./ffmpeg.testkit";
import { buildPass1 } from "./pass1";
import { makeWorkDir, removeDir, runPass1 } from "./render.testkit";
useNativeGlobals();

// REAL ffmpeg, pass 1, the largest own photo the library keeps (3f.2): 4096 by 4096. SP1's rule is that the `zp4` canvas is capped at about
// 2880 by 5120, so a big photo is never blown up to 4x its crop (16384 px tall here), which would not fit in memory. SLOW: it decodes a
// 16-megapixel JPEG and renders a clip from it, so it runs in the scheduled heavy tier.

let dir = "";
let photoPath = "";
beforeAll(async () => {
  dir = makeWorkDir("own-photo-pass1");
  const bytes = await quadrantPicture(dir, "big", 4096, 4096, "jpeg");
  photoPath = join(dir, "own-media-big.jpg");
  writeFileSync(photoPath, bytes);
}, 120_000);
afterAll(() => removeDir(dir));

const clip = (clipId: string, motion: "kenburns" | "pan" | "static"): Clip => ({
  clipId,
  durationMs: 1000,
  transitionIn: "cut",
  kind: "photo",
  cell: { photo: { source: "own", mediaId: "media-big" }, focus: { x: 0.5, y: 0.4 } },
  motion,
});

describe("pass 1 on real ffmpeg: a 4096 by 4096 own photo", () => {
  for (const motion of ["kenburns", "pan", "static"] as const) {
    heavyTest(
      `${motion}: renders one second at 1080x1920, 30 fps, from the capped canvas`,
      async () => {
        const jobs = buildPass1({ seed: 3, clips: [clip(`big-${motion}`, motion)], resolvePhoto: () => ({ path: photoPath, width: 4096, height: 4096 }), clipDir: dir });
        await runPass1(jobs);
        const probed = await probeVideo(jobs[0]?.output ?? "");
        const video = probed.streams.find((s) => s.codec_type === "video");
        expect({ w: video?.width, h: video?.height, fps: video?.r_frame_rate, frames: Number(video?.nb_read_frames) }).toEqual({ w: 1080, h: 1920, fps: "30/1", frames: 30 });
      },
      180_000,
    );
  }

  test("a clip of it builds a graph whose canvas is the cap, so the memory rule holds before ffmpeg is started", () => {
    const [job] = buildPass1({ seed: 3, clips: [clip("graph", "kenburns")], resolvePhoto: () => ({ path: photoPath, width: 4096, height: 4096 }), clipDir: dir });
    expect(job?.argv.join(" ")).toContain("scale=2880:5120:flags=lanczos");
  });
});
