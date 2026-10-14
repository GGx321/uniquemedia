import { describe, expect, test } from "bun:test";
import { ClipSummary, MAX_LISTED_CLIPS } from "../../shared/engine";
import { MIA, SOFIA } from "./mockEngine.testkit";
import { AVATAR, CLIP_PHOTOS, create, endOf, listClips, makeClipMock, onlyClip, phasesOf, refusal, runClip, unwrap, type ClipMock } from "./mockEngine.clips.testkit";

// Stage 5, 5b.1, S5.V7 (plan §5.2, §5.3, I5.49, I5.53): the clip records in the mock, as the engine's clips.list/get/markSeen/delete/retryDownload answer them
// (engine.clips.records.test.ts is the reference): the cost is built from the ledger at list time, a committed record is rewritten for a few things only, a delete removes the
// journal first and then the record, and a failed download is fetched again for free within its window.

describe("clips.list", () => {
  test("is empty for an avatar with no clips, and NOT_FOUND for an avatar the library does not have", async () => {
    const m = makeClipMock();
    expect(await unwrap(m.client.request("clips.list", { avatarId: AVATAR }))).toEqual({ clips: [] });
    expect((await refusal(m.client.request("clips.list", { avatarId: "avatar-nope-0001" }))).code).toBe("NOT_FOUND");
  });

  test("lists newest first, every entry a valid summary", async () => {
    const m = makeClipMock();
    const first = await runClip(m);
    const second = await runClip(m);
    const third = await runClip(m);
    const clips = await listClips(m);
    expect(clips.map((c) => c.clipId)).toEqual([third, second, first]);
    for (const clip of clips) expect(ClipSummary.safeParse(clip).success).toBe(true);
  });

  test("a clip of another avatar is not listed", async () => {
    const m = makeClipMock({ avatars: [MIA, SOFIA] });
    await runClip(m);
    expect(await listClips(m, SOFIA.avatarId)).toEqual([]);
    expect(await listClips(m)).toHaveLength(1);
  });

  test("a clip's cost is built from the ledger: billed, free, open, and estimated after the reconcile", async () => {
    const m = makeClipMock();
    const billed = await runClip(m);
    m.engine.scriptNextClip("rate-limited");
    const free = await runClip(m);
    m.engine.scriptNextClip("uncertain");
    const open = await runClip(m);
    const byId = new Map((await listClips(m)).map((c) => [c.clipId, c.cost]));
    expect(byId.get(billed)).toEqual({ micros: 420_000, kind: "billed" });
    expect(byId.get(free)).toEqual({ micros: 0, kind: "free" });
    expect(byId.get(open)).toEqual({ micros: 504_000, kind: "open" });
    m.engine.passClipTime(3_600_000);
    m.scheduler.runAll();
    await m.client.request("money.reconcile", {});
    const after = new Map((await listClips(m)).map((c) => [c.clipId, c.cost]));
    expect(after.get(billed)).toEqual({ micros: 420_000, kind: "billed" });
    expect(after.get(open)).toEqual({ micros: 504_000, kind: "estimated" });
  });

  test("a clip made of two attempts adds them up: Kling free, Grok billed", async () => {
    const m = makeClipMock();
    m.engine.scriptNextClip("refused-free");
    await runClip(m);
    expect((await onlyClip(m)).cost).toEqual({ micros: 710_000, kind: "billed" });
  });

  test("at most MAX_LISTED_CLIPS, newest first, and `notListedTotal` says how many were left out", async () => {
    const m = makeClipMock();
    m.engine.seedClips(AVATAR, MAX_LISTED_CLIPS + 3);
    const { clips, notListedTotal } = await unwrap(m.client.request("clips.list", { avatarId: AVATAR }));
    expect(clips).toHaveLength(MAX_LISTED_CLIPS);
    expect(notListedTotal).toBe(3);
    const stamps = clips.map((c) => c.createdAt);
    expect([...stamps].sort().reverse()).toEqual(stamps);
  });

  test("a list within the cap carries no `notListedTotal` at all", async () => {
    const m = makeClipMock();
    await runClip(m);
    expect(await unwrap(m.client.request("clips.list", { avatarId: AVATAR }))).not.toHaveProperty("notListedTotal");
  });
});

describe("clips.get", () => {
  test("answers the same summary the list gives, each export with the state of its file", async () => {
    const m = makeClipMock();
    const jobId = await runClip(m);
    const { clip } = await unwrap(m.client.request("clips.get", { avatarId: AVATAR, clipId: jobId }));
    expect(clip).toEqual(await onlyClip(m));
    expect(ClipSummary.safeParse(clip).success).toBe(true);
  });

  test("NOT_FOUND for a clip, or an avatar, the library does not have", async () => {
    const m = makeClipMock();
    expect((await refusal(m.client.request("clips.get", { avatarId: AVATAR, clipId: "job-nope-0001" }))).code).toBe("NOT_FOUND");
    expect((await refusal(m.client.request("clips.get", { avatarId: "avatar-nope-0001", clipId: "job-nope-0001" }))).code).toBe("NOT_FOUND");
  });

  test("a failed clip carries the Grok offer in mode offer, as the list does", async () => {
    const m = makeClipMock({ clips: { mode: "offer" } });
    m.engine.scriptNextClip("refused-free");
    const jobId = await runClip(m, { acceptedWorstMicros: 504_000 });
    const { clip } = await unwrap(m.client.request("clips.get", { avatarId: AVATAR, clipId: jobId }));
    expect(clip.status === "failed" ? clip.failure.grokOffer : null).toMatchObject({ expectedMicros: 710_000, worstMicros: 850_000 });
  });
});

describe("clips.markSeen", () => {
  test("sets the flag, is idempotent, and changes nothing else", async () => {
    const m = makeClipMock();
    const jobId = await runClip(m);
    const before = await onlyClip(m);
    expect(before.seen).toBe(false);
    expect(await unwrap(m.client.request("clips.markSeen", { avatarId: AVATAR, clipId: jobId }))).toEqual({ clipId: jobId });
    expect(await unwrap(m.client.request("clips.markSeen", { avatarId: AVATAR, clipId: jobId }))).toEqual({ clipId: jobId });
    expect(await onlyClip(m)).toEqual({ ...before, seen: true });
  });

  test("NOT_FOUND for a clip the avatar does not have", async () => {
    const m = makeClipMock();
    expect((await refusal(m.client.request("clips.markSeen", { avatarId: AVATAR, clipId: "job-nope-0001" }))).code).toBe("NOT_FOUND");
  });
});

describe("clips.delete", () => {
  test("removes the clip: the list is empty, a second delete is NOT_FOUND, and the money it cost stays spent", async () => {
    const m = makeClipMock();
    const jobId = await runClip(m);
    expect(await unwrap(m.client.request("clips.delete", { avatarId: AVATAR, clipId: jobId }))).toEqual({ clipId: jobId });
    expect(await listClips(m)).toEqual([]);
    expect((await refusal(m.client.request("clips.delete", { avatarId: AVATAR, clipId: jobId }))).code).toBe("NOT_FOUND");
    const status = await unwrap(m.client.request("money.status", {}));
    expect(status.ledger === "open" ? status.spentMicros : -1).toBe(420_000);
  });

  test("removes the journal first, then the record, then the media (I5.53)", async () => {
    const m = makeClipMock();
    const jobId = await runClip(m);
    m.engine.leaveStaleClipJournal(jobId);
    expect(m.engine.peekClips().files[jobId]).toEqual({ journal: true, record: true, media: true });
    m.engine.failNextClipDelete("record");
    expect((await refusal(m.client.request("clips.delete", { avatarId: AVATAR, clipId: jobId }))).code).toBe("INTERNAL");
    // The record stands and the journal is gone: nothing is resurrected as a live clip by a restart.
    expect(m.engine.peekClips().files[jobId]).toEqual({ journal: false, record: true, media: true });
    expect(await listClips(m)).toHaveLength(1);
    expect(await unwrap(m.client.request("clips.delete", { avatarId: AVATAR, clipId: jobId }))).toEqual({ clipId: jobId });
    expect(m.engine.peekClips().files[jobId]).toBeUndefined();
  });

  test("a delete that fails at the journal leaves everything as it was", async () => {
    const m = makeClipMock();
    const jobId = await runClip(m);
    m.engine.leaveStaleClipJournal(jobId);
    m.engine.failNextClipDelete("journal");
    expect((await refusal(m.client.request("clips.delete", { avatarId: AVATAR, clipId: jobId }))).code).toBe("INTERNAL");
    expect(m.engine.peekClips().files[jobId]).toEqual({ journal: true, record: true, media: true });
  });

  test("IN_FLIGHT `job-running` while a job works on the clip", async () => {
    const m = makeClipMock();
    m.engine.scriptNextClip("download-failed");
    const jobId = await runClip(m);
    const { jobId: retry } = await unwrap(m.client.request("clips.retryDownload", { avatarId: AVATAR, clipId: jobId }));
    expect(await refusal(m.client.request("clips.delete", { avatarId: AVATAR, clipId: jobId }))).toMatchObject({ code: "IN_FLIGHT", clipReason: "job-running" });
    m.scheduler.runAll();
    expect(endOf(m.events, retry)?.type).toBe("job.done");
    expect(await unwrap(m.client.request("clips.delete", { avatarId: AVATAR, clipId: jobId }))).toEqual({ clipId: jobId });
  });

  test("an avatar delete takes its clips with it, and waits for a clip that is being made", async () => {
    const m = makeClipMock();
    await unwrap(create(m));
    expect((await refusal(m.client.request("avatars.delete", { avatarId: AVATAR }))).code).toBe("IN_FLIGHT");
    m.scheduler.runAll();
    await runClip(m);
    expect((await m.client.request("avatars.delete", { avatarId: AVATAR })).ok).toBe(true);
    expect(m.engine.peekClips().files).toEqual({});
  });
});

describe("clips.retryDownload", () => {
  async function failed(m: ClipMock, script: "download-failed" | "invalid-file" | "disk-full" = "download-failed"): Promise<string> {
    m.engine.scriptNextClip(script);
    return runClip(m);
  }

  test("fetches the file of a paid clip again for free: a job in phase `downloading`, then the same record ready, the money untouched", async () => {
    const m = makeClipMock();
    const clipId = await failed(m);
    const before = await onlyClip(m);
    const { jobId } = await unwrap(m.client.request("clips.retryDownload", { avatarId: AVATAR, clipId }));
    expect(phasesOf(m.events, jobId)[0]).toBe("downloading");
    m.scheduler.runAll();
    expect(endOf(m.events, jobId)).toMatchObject({ type: "job.done", payload: { jobId, result: { kind: "clip", avatarId: AVATAR, clipId } } });
    const after = await onlyClip(m);
    expect(after).toMatchObject({ clipId, status: "ready", width: 720, height: 1280, durationMs: 5_000, cost: before.cost, recovered: false, seen: false, motion: before.motion, request: before.request });
    expect(after.status === "ready" ? after.face : null).toMatchObject({ verdict: "match" });
    expect(m.engine.peekClips().attempts).toHaveLength(1);
  });

  test("works for each of the three paid failures of a download", async () => {
    for (const script of ["download-failed", "invalid-file", "disk-full"] as const) {
      const m = makeClipMock();
      const clipId = await failed(m, script);
      await unwrap(m.client.request("clips.retryDownload", { avatarId: AVATAR, clipId }));
      m.scheduler.runAll();
      expect((await onlyClip(m)).status).toBe("ready");
    }
  });

  test("a retry that fails again leaves the record as it was", async () => {
    const m = makeClipMock();
    const clipId = await failed(m);
    const before = await onlyClip(m);
    m.engine.nextClipRetry("failed");
    const { jobId } = await unwrap(m.client.request("clips.retryDownload", { avatarId: AVATAR, clipId }));
    m.scheduler.runAll();
    expect(endOf(m.events, jobId)).toMatchObject({ type: "job.failed", payload: { kind: "clip", jobId, clipId, error: { code: "NETWORK" } } });
    expect(await onlyClip(m)).toEqual(before);
    // The window is still open: a third try is allowed.
    expect((await m.client.request("clips.retryDownload", { avatarId: AVATAR, clipId })).ok).toBe(true);
    m.scheduler.runAll();
    expect((await onlyClip(m)).status).toBe("ready");
  });

  test("a file the provider no longer has (410) turns the record `download-expired` and drops its window", async () => {
    const m = makeClipMock();
    const clipId = await failed(m);
    m.engine.nextClipRetry("gone");
    const { jobId } = await unwrap(m.client.request("clips.retryDownload", { avatarId: AVATAR, clipId }));
    m.scheduler.runAll();
    expect(endOf(m.events, jobId)?.type).toBe("job.done");
    const clip = await onlyClip(m);
    expect(clip).toMatchObject({ status: "failed", failure: { reason: "download-expired" }, cost: { micros: 420_000, kind: "billed" } });
    expect(clip.status === "failed" ? clip.retryDownloadUntil : "ready").toBeUndefined();
  });

  test("past the window: VALIDATION `download-expired`, and the record turns expired", async () => {
    const m = makeClipMock();
    const clipId = await failed(m);
    m.engine.passClipTime(3_600_001);
    expect(await refusal(m.client.request("clips.retryDownload", { avatarId: AVATAR, clipId }))).toMatchObject({ code: "VALIDATION", clipReason: "download-expired" });
    expect(await onlyClip(m)).toMatchObject({ status: "failed", failure: { reason: "download-expired" } });
    expect(await refusal(m.client.request("clips.retryDownload", { avatarId: AVATAR, clipId }))).toMatchObject({ code: "VALIDATION", clipReason: "download-expired" });
  });

  test("a clip that is ready, or that failed some other way, has no file to fetch: VALIDATION", async () => {
    const m = makeClipMock();
    const ready = await runClip(m);
    m.engine.scriptNextClip("refused-free");
    const refused = await runClip(m, { fallback: "none", acceptedWorstMicros: 504_000 });
    for (const clipId of [ready, refused]) expect((await refusal(m.client.request("clips.retryDownload", { avatarId: AVATAR, clipId }))).code).toBe("VALIDATION");
  });

  test("NOT_FOUND for a clip the avatar does not have; IN_FLIGHT `job-running` for a second retry", async () => {
    const m = makeClipMock();
    expect((await refusal(m.client.request("clips.retryDownload", { avatarId: AVATAR, clipId: "job-nope-0001" }))).code).toBe("NOT_FOUND");
    const clipId = await failed(m);
    await unwrap(m.client.request("clips.retryDownload", { avatarId: AVATAR, clipId }));
    expect(await refusal(m.client.request("clips.retryDownload", { avatarId: AVATAR, clipId }))).toMatchObject({ code: "IN_FLIGHT", clipReason: "job-running" });
    m.scheduler.runAll();
  });

  test("the retry holds neither the paid slot nor the reconcile: a new clip can be made meanwhile", async () => {
    const m = makeClipMock();
    const clipId = await failed(m);
    await unwrap(m.client.request("clips.retryDownload", { avatarId: AVATAR, clipId }));
    expect((await create(m, { photoId: CLIP_PHOTOS.plain.photoId })).ok).toBe(true);
    m.scheduler.runAll();
  });
});
