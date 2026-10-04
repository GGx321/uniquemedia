import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Clip } from "../../shared/engine/montage";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { bandFrames, frameNumbersOf, mezzanineOf, type Mezzanine } from "../videos/testing/mezzanineKit";
import { buildPass1 } from "./pass1";
import { makeWorkDir, removeDir, runPass1 } from "./render.testkit";
useNativeGlobals();
setDefaultTimeout(180_000);

// EVERY trim position an own video clip may have, on real ffmpeg (3f.3b review, probe-trim2): a mezzanine of 255 frames (a real importer encode, with B-frames, over busy noise, its
// frame number in a strip across the middle) and a clip of 15 frames from every start the 100 ms grid allows (0, 3, 6, ... 240), each read back frame by frame. The default tier
// runs it, so Windows' ffmpeg 6.1.1 proves the seek of `-ss` half a frame early at every offset inside every group of pictures, not only at the few the other tests pick.

const FRAMES = 255;
const CLIP_FRAMES = 15;
let dir = "";
let mezzanine: Mezzanine | undefined;

beforeAll(async () => {
  dir = makeWorkDir("own-video-trim");
  mezzanine = await mezzanineOf(dir, "media-trim", bandFrames(96, 192, FRAMES));
});
afterAll(() => removeDir(dir));

describe("an own video clip on real ffmpeg: every trim position", () => {
  test("the mezzanine itself reads back as its frame numbers (the strip survives the encode)", () => {
    expect(frameNumbersOf((mezzanine as Mezzanine).path, true)).toEqual(Array.from({ length: FRAMES }, (_, i) => i));
  });

  test(`a clip of ${CLIP_FRAMES} frames from every start on the 100 ms grid plays exactly the frames asked for`, async () => {
    const m = mezzanine as Mezzanine;
    const wrong: string[] = [];
    let runs = 0;
    for (let start = 0; start + CLIP_FRAMES <= FRAMES; start += 3) {
      const clipDir = join(dir, `job-${++runs}`);
      mkdirSync(clipDir, { recursive: true });
      const copy = join(clipDir, "own.mp4");
      copyFileSync(m.path, copy);
      const clip: Clip = { clipId: "v", durationMs: (CLIP_FRAMES * 100) / 3, transitionIn: "cut", kind: "video", mediaId: m.mediaId, trimStartMs: (start * 100) / 3, focus: null };
      const jobs = buildPass1({ seed: 1, clips: [clip], resolvePhoto: () => undefined, resolveVideo: () => ({ path: copy, width: m.width, height: m.height }), clipDir });
      await runPass1(jobs);
      const got = frameNumbersOf(jobs[0]?.output ?? "", true);
      const want = Array.from({ length: CLIP_FRAMES }, (_, i) => start + i);
      if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push(`${start}: ${JSON.stringify(got)}`);
    }
    expect(runs).toBe((FRAMES - CLIP_FRAMES) / 3 + 1);
    expect(wrong).toEqual([]);
  });
});
