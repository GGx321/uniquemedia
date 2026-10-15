import { describe, expect, test } from "bun:test";
import { batchClipProblems, batchLedgerProblems, clipPostProblems, exportedCopyProblems, refusedJobProblems, type BatchClip, type VideoCall } from "./clipSmoke";
import { useNativeGlobals } from "../testing/nativeGlobals";

useNativeGlobals();

// Stage 5, 5b.1, S5.V7: what the packaged smoke checks of a clip, as functions with no Electron in them. The smoke only has to call them with what its mock OpenRouter and the app reported; the engine
// itself is held against the same mock by clipSmoke.engine.test.ts.

const KLING = "kwaivgi/kling-v3.0-std";
const GROK = "x-ai/grok-imagine-video-1.5";

describe("clipPostProblems: one POST per attempt id, never resent", () => {
  test("is empty when every attempt id has exactly one POST, of the model it was made for, in order", () => {
    const ids = ["job-1:video#1", "job-2:video#1", "job-2:video#2"];
    expect(clipPostProblems([{ model: KLING }, { model: KLING }, { model: GROK }], ids, [KLING, KLING, GROK])).toEqual([]);
  });

  test("names a POST sent twice for one attempt: more requests than attempt ids", () => {
    const problems = clipPostProblems([{ model: KLING }, { model: KLING }], ["job-1:video#1"], [KLING]);
    expect(problems).toEqual(["2 POST /videos left for 1 attempt ids: a POST is sent once per attempt"]);
  });

  test("names an attempt that sent nothing, and an id that is not a clip attempt's or appears twice", () => {
    expect(clipPostProblems([], ["job-1:video#1"], [])).toEqual(["0 POST /videos left for 1 attempt ids: a POST is sent once per attempt"]);
    expect(clipPostProblems([{ model: KLING }, { model: KLING }], ["job-1:video#1", "job-1:video#1"], [KLING, KLING])).toEqual(["attempt id job-1:video#1 was reserved twice"]);
    expect(clipPostProblems([{ model: KLING }], ["img-1"], [KLING])).toEqual(["img-1 is not a clip attempt's id"]);
  });

  test("names the model of a POST that is not the one expected, with its place", () => {
    expect(clipPostProblems([{ model: KLING }, { model: KLING }], ["job-1:video#1", "job-1:video#2"], [KLING, GROK])).toEqual([`POST 2 named ${KLING}, not ${GROK}`]);
    expect(clipPostProblems([{ model: null }], ["job-1:video#1"], [KLING])).toEqual([`POST 1 named null, not ${KLING}`]);
  });
});

describe("refusedJobProblems: a refused job is free and ends there", () => {
  const call = (kind: string, jobId: string | null, status: number): VideoCall => ({ kind, jobId, status });

  test("is empty when it was polled, read on /generation more than once with the API's 404 every time, and its file was never fetched", () => {
    const calls = [call("submit", "j1", 202), call("poll", "j1", 200), call("generation", "j1", 404), call("generation", "j1", 404), call("submit", "j2", 202), call("content", "j2", 200)];
    expect(refusedJobProblems(calls, "j1")).toEqual([]);
  });

  test("names a /generation that answered anything but 404, a single reading, a fetched file and a job never polled", () => {
    expect(refusedJobProblems([call("poll", "j1", 200), call("generation", "j1", 404), call("generation", "j1", 200)], "j1")).toEqual(["the refused job had a /generation answer of 200, not 404"]);
    expect(refusedJobProblems([call("poll", "j1", 200), call("generation", "j1", 404)], "j1")).toEqual(["the refused job was read on /generation once: the proof needs two readings"]);
    expect(refusedJobProblems([call("poll", "j1", 200), call("generation", "j1", 404), call("generation", "j1", 404), call("content", "j1", 404)], "j1")).toEqual(["the file of the refused job was asked for"]);
    expect(refusedJobProblems([call("poll", "j1", 200)], "j1")).toEqual(["the refused job was read on /generation 0 times: the proof needs two readings"]);
    expect(refusedJobProblems([call("generation", "j1", 404), call("generation", "j1", 404)], "j1")).toEqual(["the refused job was never polled"]);
  });
});

describe("exportedCopyProblems: «Сохранить в папку» saved a clean copy under the clip name", () => {
  test("is empty for `<avatar>/<date>_clip_<NNN>.mp4` whose file passes the export's verifier", () => {
    expect(exportedCopyProblems("Bea/2026-10-14_clip_001.mp4", { ok: true, reasons: [] })).toEqual([]);
  });

  test("names a copy with another name, no name at all, and a file the verifier refuses (with its reasons)", () => {
    expect(exportedCopyProblems("Bea/2026-10-14_collage2_001.mp4", { ok: true, reasons: [] })).toEqual(["the copy's name Bea/2026-10-14_collage2_001.mp4 is not <avatar>/<date>_clip_<NNN>.mp4"]);
    expect(exportedCopyProblems(undefined, { ok: true, reasons: [] })).toEqual(["the export job named no copy"]);
    expect(exportedCopyProblems("Bea/2026-10-14_clip_001.mp4", { ok: false, reasons: [{ code: "METADATA_FORBIDDEN", path: "moov/udta" }] })).toEqual(["the copy fails I5.58: METADATA_FORBIDDEN at moov/udta"]);
  });
});

// Stage 5, 5b.2, S5.WB3: what the packaged smoke checks of a batch of three, one member refused for free and made on Grok. The same functions are called by clipBatchSmoke.engine.test.ts against the real engine.

describe("batchLedgerProblems: one reserve open at a time, the attempts in the batch's order", () => {
  const ids = ["job-1:video#1", "job-2:video#1", "job-2:video#2", "job-3:video#1"];
  const line = (type: string, attemptId: string) => ({ type, attemptId });
  const clean = [
    line("reserve", "job-1:video#1"),
    line("settle", "job-1:video#1"),
    line("reserve", "job-2:video#1"),
    line("settle", "job-2:video#1"),
    line("reserve", "job-2:video#2"),
    line("settle", "job-2:video#2"),
    line("reserve", "job-3:video#1"),
    line("settle", "job-3:video#1"),
  ];

  test("is empty when the attempts were reserved in the expected order and each was settled before the next was reserved", () => {
    expect(batchLedgerProblems(clean, ids)).toEqual([]);
  });

  test("names a reserve made while another was still open", () => {
    const overlapped = [line("reserve", "job-1:video#1"), line("reserve", "job-2:video#1"), line("settle", "job-1:video#1"), line("settle", "job-2:video#1"), ...clean.slice(4)];
    expect(batchLedgerProblems(overlapped, ids)).toEqual(["job-2:video#1 was reserved while job-1:video#1 was still open: a batch runs one clip money unit at a time"]);
  });

  test("names attempts reserved in another order, and a reserve that is missing", () => {
    const swapped = [...clean.slice(4, 6), ...clean.slice(2, 4), ...clean.slice(0, 2), ...clean.slice(6)];
    expect(batchLedgerProblems(swapped, ids)).toEqual(["the reserves are job-2:video#2, job-2:video#1, job-1:video#1, job-3:video#1, not job-1:video#1, job-2:video#1, job-2:video#2, job-3:video#1"]);
    expect(batchLedgerProblems(clean.slice(0, 2), ids)).toEqual(["the reserves are job-1:video#1, not job-1:video#1, job-2:video#1, job-2:video#2, job-3:video#1"]);
  });
});

describe("batchClipProblems: every member of the batch tells its place", () => {
  const member = (clipId: string, batchIndex: number): BatchClip => ({ clipId, batchId: "batch-1", batchIndex, batchSize: 3 });

  test("is empty when the clips tell one batch, the places 1 to 3 once each, and its size", () => {
    expect(batchClipProblems([member("c3", 3), member("c1", 1), member("c2", 2)], "batch-1", 3)).toEqual([]);
  });

  test("names a clip with no place, another batch's clip, a place told twice, and a wrong size", () => {
    expect(batchClipProblems([member("c1", 1), { clipId: "c2" }, member("c3", 3)], "batch-1", 3)).toEqual(["clip c2 tells no place in the batch", "the places told are 1, 3, not 1 to 3"]);
    expect(batchClipProblems([member("c1", 1), { ...member("c2", 2), batchId: "batch-9" }, member("c3", 3)], "batch-1", 3)).toEqual(["clip c2 belongs to batch batch-9, not batch-1", "the places told are 1, 3, not 1 to 3"]);
    expect(batchClipProblems([member("c1", 1), member("c2", 1), member("c3", 3)], "batch-1", 3)).toEqual(["the places told are 1, 1, 3, not 1 to 3"]);
    expect(batchClipProblems([member("c1", 1), { ...member("c2", 2), batchSize: 4 }, member("c3", 3)], "batch-1", 3)).toEqual(["clip c2 says the batch has 4 clips, not 3"]);
  });
});
