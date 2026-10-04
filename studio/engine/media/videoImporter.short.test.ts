import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { MIN_CLIP_MS } from "../../shared/engine";
import type { runFfmpegArgv } from "../../node/runFfmpeg";
import { tempDirFor } from "../../testing/tempDir";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import type { MediaImportRequest } from "./imports";
import { requestFor, stage } from "./video/testing/importKit";
import { buildMp4, type ColrSpec } from "./video/testing/mp4VideoBuilder";
import { createVideoImporter } from "./videoImporter";
useNativeGlobals();

// 3f.6: a video shorter than the shortest clip (0.5 s, 15 frames at 30 fps) can never be put in a montage, so it is refused at import as `too-short`.
// It is judged from what the importer plans and then from what it MADE (the walker's reading of the output's samples), never from a header field alone.
// ffmpeg is a fake here; the real boundary is in videoImporter.short.ffmpeg.test.ts.

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-video-short-");
type Run = typeof runFfmpegArgv;

const BT709: ColrSpec = { type: "nclx", primaries: 1, transfer: 1, matrix: 1 };
const source = (frames: number, ticks = 1000): Uint8Array =>
  buildMp4({ tracks: [{ handler: "vide", entry: { fourcc: "avc1", width: 192, height: 96, colr: BT709 }, mdhdTimescale: 30000, stts: [[frames, ticks]] }] });

interface Rig {
  readonly calls: number;
  readonly released: string[];
  readonly begins: number;
  outcome: Awaited<ReturnType<ReturnType<typeof createVideoImporter>>>;
}

/** Imports `input` with a fake ffmpeg that writes `made`; how often ffmpeg was asked, how often the stage began, what was released. */
async function importWith(input: Uint8Array, made: Uint8Array, options: Parameters<typeof createVideoImporter>[0] = {}): Promise<Rig> {
  let calls = 0;
  let begins = 0;
  const run: Run = async (o) => {
    calls++;
    await writeFile(o.output, made);
  };
  const rig = requestFor(tmp(), await stage(tmp(), input));
  const prepare: MediaImportRequest["prepare"] = { begin: () => void begins++, report: () => undefined };
  const outcome = await createVideoImporter({ run, ...options })({ ...rig.request, prepare });
  return { calls, released: rig.released, begins, outcome };
}

describe("a video shorter than the shortest clip", () => {
  test("the shortest clip is 0.5 s: the importer's bound is the contract's", () => {
    expect(MIN_CLIP_MS).toBe(500);
  });

  test("14 frames (0.467 s) made by the encode are refused too-short, and the work file is released", async () => {
    // The plan allows 12 to 16 frames of a 14-frame source, so ffmpeg runs; its output of 14 frames is what is judged.
    const done = await importWith(source(14), source(14));
    expect(done.outcome).toEqual({ ok: false, reason: "too-short" });
    expect(done.calls).toBe(1);
    expect(done.released).toHaveLength(1);
  });

  test("15 frames (exactly 0.5 s) are taken: the shortest clip itself is a clip", async () => {
    const done = await importWith(source(15), source(15));
    expect(done.outcome).toMatchObject({ ok: true, facts: { durationMs: 500 } });
  });

  test("16 frames are taken", async () => {
    expect((await importWith(source(16), source(16))).outcome.ok).toBe(true);
  });

  test("a source that is clearly too short by its own samples never reaches ffmpeg: nothing is encoded, nothing is announced, no work file is made", async () => {
    // 5 frames (0.167 s): even with the two frames of slack it is under 15.
    const done = await importWith(source(5), source(5));
    expect(done.outcome).toEqual({ ok: false, reason: "too-short" });
    expect(done.calls).toBe(0);
    expect(done.begins).toBe(0);
    expect(done.released).toEqual([]);
  });

  test("a source close to the bound is the encode's to decide, since the plan allows two frames of slack either way: 10 frames are refused before it, 14 are not", async () => {
    // The walker's range for N samples is N - 2 to N + 2 frames: 10 + 2 is under 15, 14 + 2 is over it.
    expect((await importWith(source(10), source(10))).calls).toBe(0);
    expect((await importWith(source(14), source(14))).calls).toBe(1);
  });

  test("is judged from the output's own samples, whatever the source's header claims: a source of 40 frames whose encode made 10 is refused as failed by the plan's range, never taken", async () => {
    const done = await importWith(source(40), source(10));
    expect(done.outcome.ok).toBe(false);
  });

  test("a clip at 60 fps of 0.4 s (24 source frames) is 12 frames at 30 fps: refused before the encode, since the output is what is judged", async () => {
    const done = await importWith(source(24, 500), source(12));
    expect(done.outcome).toEqual({ ok: false, reason: "too-short" });
    expect(done.calls).toBe(0);
  });

  test("a clip at 60 fps of 0.5 s (30 source frames) makes 15 output frames and is taken", async () => {
    expect((await importWith(source(30, 500), source(15))).outcome).toMatchObject({ ok: true, facts: { durationMs: 500 } });
  });

  test("the bound is the importer's own knob: 0 takes any length, and the contract's value is what it defaults to", async () => {
    expect((await importWith(source(5), source(5), { minDurationMs: 0 })).outcome.ok).toBe(true);
    expect((await importWith(source(5), source(5))).outcome).toEqual({ ok: false, reason: "too-short" });
    expect((await importWith(source(14), source(14), { minDurationMs: 400 })).outcome.ok).toBe(true);
  });
});
