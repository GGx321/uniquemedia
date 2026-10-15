import { describe, expect, test } from "bun:test";
import type { ClipSummary, EngineError, MediaOrigin, MediaSummary } from "../../../shared/engine";
import { appendVideoClip, type OriginOf } from "./clipOps";
import { ClipPlacements, copyFactsOf, importAnswerOf, MAX_EARLY_ENDS, placeBoundary, readyCopyFacts } from "./clipImport";
import { draftSpec, photoClip } from "./testkit";

// 5b.2 part A (S5.WA4; plan §5.1.1): a click (or a drop) on a clip asks `media.importClip`. A live copy answers its media id: the copy is placed at once,
// by the own video's placement (from its start, up to 2 s). Otherwise the answer names an import job, and the copy is placed where it was asked for when
// that job's `job.done` brings its record (`result.media`). A job may end before the answer that names it reaches the window: its copy is kept a while,
// and the answer finds it. A failed or cancelled job places nothing.

const AVATAR = "avatar-mia-0001";
const ORIGIN: MediaOrigin = { kind: "clip", avatarId: AVATAR, clipId: "clip-0000004", photoId: "photo-mia-0002" };
const COPY: MediaSummary = {
  mediaId: "media-copy-0001",
  kind: "video",
  name: "Клип 2026-10-14 12-00.mp4",
  bytes: 4_500_000,
  createdAt: "2026-10-14T10:00:00.000Z",
  width: 720,
  height: 1280,
  durationMs: 4_967,
  sourceFps: 24,
  hdrToSdr: false,
  loopFrames: null,
  delayFrames: null,
  origin: ORIGIN,
};
const FAILED: EngineError = { code: "INTERNAL", detail: "encode failed" };

describe("what the answer means", () => {
  test("a live copy is placed now; a job is waited for; a refusal is said", () => {
    expect(importAnswerOf({ ok: true, result: { mediaId: "media-copy-0001" } })).toEqual({ kind: "place", mediaId: "media-copy-0001" });
    expect(importAnswerOf({ ok: true, result: { jobId: "job-0000009" } })).toEqual({ kind: "wait", jobId: "job-0000009" });
    expect(importAnswerOf({ ok: false, error: FAILED })).toEqual({ kind: "refused", error: FAILED });
  });

  test("a live copy is placed from what the clip says (its length, its frame); a job's copy from its record", () => {
    const clip = {
      clipId: "clip-0000004",
      avatarId: AVATAR,
      photoId: "photo-mia-0002",
      durationMs: 5_000,
    } satisfies Pick<Extract<ClipSummary, { status: "ready" }>, "clipId" | "avatarId" | "photoId" | "durationMs">;
    expect(readyCopyFacts(clip, "media-copy-0001")).toEqual({ mediaId: "media-copy-0001", durationMs: 5_000, origin: ORIGIN });
    expect(copyFactsOf(COPY)).toEqual({ mediaId: "media-copy-0001", durationMs: 4_967, origin: ORIGIN });
  });
});

describe("the copies on their way", () => {
  test("the answer's job waits; its done brings the copy to where it was asked for", () => {
    const placements = new ClipPlacements();
    expect(placements.wait("job-0000001", { clipId: "clip-0000004", boundary: 1 })).toEqual({ kind: "waiting" });
    expect(placements.pending).toEqual([{ jobId: "job-0000001", clipId: "clip-0000004", boundary: 1 }]);
    expect(placements.done("job-0000001", COPY)).toEqual({ placement: { clipId: "clip-0000004", boundary: 1 }, media: COPY });
    expect(placements.pending).toEqual([]);
    // Heard once: a repeated event places nothing again.
    expect(placements.done("job-0000001", COPY)).toBeNull();
  });

  test("a job that ended done before its answer came: the answer finds its copy and it is placed at once", () => {
    const placements = new ClipPlacements();
    expect(placements.done("job-0000002", COPY)).toBeNull();
    expect(placements.wait("job-0000002", { clipId: "clip-0000004", boundary: null })).toEqual({ kind: "place", media: COPY });
    expect(placements.pending).toEqual([]);
  });

  test("a failed or cancelled job places nothing; one that ended before its answer is told to the answer", () => {
    const placements = new ClipPlacements();
    placements.wait("job-0000003", { clipId: "clip-0000004", boundary: null });
    expect(placements.failed("job-0000003", FAILED)).toEqual({ clipId: "clip-0000004", boundary: null });
    expect(placements.done("job-0000003", COPY)).toBeNull();
    placements.wait("job-0000004", { clipId: "clip-0000005", boundary: 2 });
    expect(placements.cancelled("job-0000004")).toEqual({ clipId: "clip-0000005", boundary: 2 });
    expect(placements.pending).toEqual([]);
    expect(placements.failed("job-0000005", FAILED)).toBeNull();
    expect(placements.wait("job-0000005", { clipId: "clip-0000006", boundary: null })).toEqual({ kind: "failed", error: FAILED });
    expect(placements.cancelled("job-0000006")).toBeNull();
    expect(placements.wait("job-0000006", { clipId: "clip-0000007", boundary: null })).toEqual({ kind: "cancelled" });
  });

  test("another window's import ending is remembered only a while: at most MAX_EARLY_ENDS, the oldest forgotten first", () => {
    const placements = new ClipPlacements();
    for (let i = 0; i <= MAX_EARLY_ENDS; i++) placements.done(`job-early-${i}`, COPY);
    expect(placements.wait("job-early-0", { clipId: "clip-0000004", boundary: null })).toEqual({ kind: "waiting" });
    expect(placements.wait(`job-early-${MAX_EARLY_ENDS}`, { clipId: "clip-0000004", boundary: null })).toEqual({ kind: "place", media: COPY });
  });

  test("forgetting the waits (a library switch, a new engine) drops the drop marks", () => {
    const placements = new ClipPlacements();
    placements.wait("job-0000001", { clipId: "clip-0000004", boundary: 1 });
    placements.clear();
    expect(placements.pending).toEqual([]);
    expect(placements.done("job-0000001", COPY)).toBeNull();
  });
});

describe("where the copy goes", () => {
  test("the end, or the boundary it was dropped at, held to the montage as it is when the copy is ready", () => {
    const spec = draftSpec([photoClip(0, "photo-mia-0001"), photoClip(1, "photo-mia-0003")]);
    expect(placeBoundary(spec, null)).toBeUndefined();
    expect(placeBoundary(spec, 1)).toBe(1);
    expect(placeBoundary(draftSpec([photoClip(0, "photo-mia-0001")]), 2)).toBe(1);
    expect(placeBoundary(spec, -1)).toBe(0);
  });

  test("a copy is placed by the own video's rule: from its start, up to 2 s; the frame rule holds", () => {
    const originOf: OriginOf = () => undefined;
    const spec = draftSpec([photoClip(0, "photo-mia-0001")]);
    const placed = appendVideoClip(spec, copyFactsOf(COPY), originOf);
    expect(placed.ok && placed.spec.clips[1]).toEqual({ clipId: "clip-002", durationMs: 2_000, transitionIn: "cut", kind: "video", mediaId: COPY.mediaId, trimStartMs: 0, focus: null });
    expect(appendVideoClip(draftSpec([photoClip(0, ORIGIN.photoId)]), copyFactsOf(COPY), originOf)).toEqual({ ok: false, reason: "photo-in-draft" });
  });
});
