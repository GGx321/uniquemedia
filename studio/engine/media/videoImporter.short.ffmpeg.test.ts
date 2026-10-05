import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { tempDirFor } from "../../testing/tempDir";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { rampFrames, sourceFromRaw } from "../videos/testing/mezzanineKit";
import type { MediaImportOutcome, MediaImportRequest } from "./imports";
import { requestFor, stage } from "./video/testing/importKit";
import { createVideoImporter } from "./videoImporter";
useNativeGlobals();
setDefaultTimeout(60_000);

// 3f.6 on REAL ffmpeg: the shortest clip (3 frames, 0.1 s) at the real boundary, from clips ffmpeg made, and the real `-progress` frames the importer passes on. A fake
// ffmpeg (videoImporter.short.test.ts, videoImporter.progress.test.ts) proves the decisions; only the real one proves that the frame count the encode makes is the one
// the bound is judged on, and that `-progress` reports reach the job.

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-video-short-ffmpeg-");

async function importFrames(frames: number, prepare?: MediaImportRequest["prepare"]): Promise<MediaImportOutcome> {
  const source = await sourceFromRaw(tmp(), `clip-${frames}`, rampFrames(64, 64, frames));
  const rig = requestFor(tmp(), await stage(tmp(), source));
  return createVideoImporter()({ ...rig.request, prepare });
}

describe("the shortest clip, on real ffmpeg", () => {
  test("a clip of 2 frames (0.067 s) is refused too-short", async () => {
    expect(await importFrames(2)).toEqual({ ok: false, reason: "too-short" });
  });

  test("a clip of 3 frames (exactly 0.1 s) is imported, and its record says 100 ms", async () => {
    const outcome = await importFrames(3);
    expect(outcome).toMatchObject({ ok: true, facts: { durationMs: 100 } });
  });

  test("a clip of one frame is refused too-short", async () => {
    expect(await importFrames(1)).toEqual({ ok: false, reason: "too-short" });
  });

  test("a clip of 4 frames is imported", async () => {
    expect((await importFrames(4)).ok).toBe(true);
  });

  test("a clip of 15 frames (0.5 s, the old shortest) is imported, and its record says 500 ms", async () => {
    expect(await importFrames(15)).toMatchObject({ ok: true, facts: { durationMs: 500 } });
  });
});

describe("the progress of a real encode", () => {
  test("is the planned frames as the total, and ffmpeg's own frames as the steps: increasing and never past the plan's range", async () => {
    const begins: number[] = [];
    const reports: number[] = [];
    const outcome = await importFrames(60, { begin: (total) => void begins.push(total), report: (done) => void reports.push(done) });
    expect(outcome.ok).toBe(true);
    expect(begins).toEqual([60]);
    // `-progress` always ends with the final report, which says the frames written.
    expect(reports.length).toBeGreaterThan(0);
    expect(reports.every((done, i) => i === 0 || done > (reports[i - 1] ?? 0))).toBe(true);
    expect(Math.max(...reports)).toBeLessThanOrEqual(62);
    expect(reports.at(-1)).toBe(60);
  });
});
