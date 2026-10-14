import { describe, expect, test } from "bun:test";
import { clipPostProblems, exportedCopyProblems, refusedJobProblems, type VideoCall } from "./clipSmoke";
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
