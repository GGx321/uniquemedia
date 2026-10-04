import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { MIN_TOTAL_MS } from "../../shared/engine";
import { tempDirFor } from "../../testing/tempDir";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import type { MediaImportOutcome, MediaImportRequest } from "./imports";
import { flacClaiming, flacOfSeconds, wavOf } from "./musicFixtures.testkit";
import { createMusicImporter, MIN_TRACK_MS, type MusicImporterDeps } from "./musicImporter";
import { handoff } from "./photoFixtures.testkit";
useNativeGlobals();
setDefaultTimeout(60_000);

// 3f.6 on REAL ffmpeg: a track's import tells the job how far the encode has got (the output's time against the length the probe verified), and a track
// shorter than the shortest montage is refused `too-short`, judged from the DECODED output. The boundary is found by import, not assumed: a track is made, its
// decoded length is read, and the bound is set to that length and one more.

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-music-progress-");

/** `seconds` of a quiet square wave at 8 kHz, mono 8-bit, as a WAV (the container states its length exactly). */
const wav = (seconds: number): Uint8Array => wavOf(Math.round(seconds * 8000), 8000);

async function run(bytes: Uint8Array, deps: MusicImporterDeps = {}, prepare?: MediaImportRequest["prepare"], format: "wav" | "flac" = "wav"): Promise<MediaImportOutcome> {
  const hand = await handoff(tmp(), bytes, { format, kind: "audio" });
  return createMusicImporter(deps)({ ...hand.request, prepare });
}

const decodedMsOf = (outcome: MediaImportOutcome): number => {
  if (!outcome.ok) throw new Error(`refused: ${outcome.reason}`);
  return outcome.facts.durationMs ?? -1;
};

describe("the shortest track", () => {
  test("is the shortest montage: the contract's 4 s, and no shorter track can cover any montage", () => {
    expect(MIN_TRACK_MS).toBe(MIN_TOTAL_MS);
    expect(MIN_TRACK_MS).toBe(4000);
  });

  test("a track of 3.5 s is refused too-short", async () => {
    expect(await run(wav(3.5))).toEqual({ ok: false, reason: "too-short" });
  });

  test("a track of 4.5 s is imported", async () => {
    expect((await run(wav(4.5))).ok).toBe(true);
  });

  test("the bound is on the DECODED length, equal passes: a bound set to what a track decodes to takes it, one more refuses it", async () => {
    const decoded = decodedMsOf(await run(wav(4.5), { minDurationMs: 0 }));
    expect((await run(wav(4.5), { minDurationMs: decoded })).ok).toBe(true);
    expect(await run(wav(4.5), { minDurationMs: decoded + 1 })).toEqual({ ok: false, reason: "too-short" });
  });

  test("the bound is the importer's own knob: 0 takes any length", async () => {
    expect((await run(wav(0.3), { minDurationMs: 0 })).ok).toBe(true);
    expect(await run(wav(0.3))).toEqual({ ok: false, reason: "too-short" });
  });

  test("a header that claims a short length does not make a long track short: the decode disagrees with a container that states its length exactly, and that is `format`", async () => {
    const forged = flacClaiming(await flacOfSeconds(tmp(), 6), 8000 * 1.9);
    expect(await run(forged, {}, undefined, "flac")).toEqual({ ok: false, reason: "format" });
  });

  test("a header that claims a long length does not make a short track long enough: a cut file is `format` too, never taken", async () => {
    const forged = flacClaiming(await flacOfSeconds(tmp(), 2), 8000 * 30);
    expect(await run(forged, {}, undefined, "flac")).toEqual({ ok: false, reason: "format" });
  });

  test("a track too long is still too-long, not too-short", async () => {
    expect(await run(wav(9), { maxDurationMs: 6000 })).toEqual({ ok: false, reason: "too-long" });
  });
});

describe("the progress of a track's encode", () => {
  test("begins once with the verified length as the total, and reports the output's time: increasing, never past the length", async () => {
    const begins: number[] = [];
    const reports: number[] = [];
    const outcome = await run(wav(8), {}, { begin: (total) => void begins.push(total), report: (done) => void reports.push(done) });
    expect(outcome.ok).toBe(true);
    // The container states 8 s exactly; the total is that length in ms.
    expect(begins).toEqual([8000]);
    expect(reports.length).toBeGreaterThan(0);
    expect(reports.every((done, i) => i === 0 || done > (reports[i - 1] ?? 0))).toBe(true);
    expect(reports.at(-1)).toBeGreaterThan(7000);
    expect(Math.max(...reports)).toBeLessThanOrEqual(8200);
  });

  test("says nothing of what the probe judged: only a video has it", async () => {
    const judgedSeen: unknown[] = [];
    await run(wav(5), {}, { begin: (_total, judged) => void judgedSeen.push(judged), report: () => undefined });
    expect(judgedSeen).toEqual([undefined]);
  });

  test("begins before the encode, after the verdict: a file that is refused never begins", async () => {
    const begins: number[] = [];
    const outcome = await run(new Uint8Array([1, 2, 3, 4]), {}, { begin: (total) => void begins.push(total), report: () => undefined });
    expect(outcome.ok).toBe(false);
    expect(begins).toEqual([]);
  });

  test("works with no reporter, and a reporter that throws does not fail the import", async () => {
    expect((await run(wav(5))).ok).toBe(true);
    const throwing: NonNullable<MediaImportRequest["prepare"]> = {
      begin: () => {
        throw new Error("begin broke");
      },
      report: () => {
        throw new Error("report broke");
      },
    };
    expect((await run(wav(5), {}, throwing)).ok).toBe(true);
  });

  test("the total is never more than the encode is cut at: a header that claims a day does not make a bar that never moves", async () => {
    // A FLAC whose STREAMINFO claims 10 hours of samples (and holds 5 s): the container states its length exactly, so the probe reports the claim, and the plan's total is
    // clamped to the limit plus the margin the encode is cut at. (A WAV's claim would not do: its demuxer clips the size to the file.)
    const begins: number[] = [];
    const claimed = flacClaiming(await flacOfSeconds(tmp(), 5), 8000 * 3600 * 10);
    await run(claimed, { maxDurationMs: 6000 }, { begin: (total) => void begins.push(total), report: () => undefined }, "flac");
    expect(begins).toHaveLength(1);
    expect(begins[0]).toBe(6000 + 2000);
  });
});
