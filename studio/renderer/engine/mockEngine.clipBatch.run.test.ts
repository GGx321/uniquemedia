import { describe, expect, test } from "bun:test";
import { ClipSummary } from "../../shared/engine";
import { summarizeJournal } from "../../engine/clips/journal";
import { planRecovery } from "../../engine/clips/recover";
import { ClipJournalLine } from "../../engine/clips/schemas";
import { REAL_CLIP_TIMINGS } from "../../engine/clips/timings";
import { MOCK_CLIP_TIMINGS } from "./mockClips";
import { BOLD_FRAME, cancelBatch, createBatch, detailOf, endOf, endsOf, jobState, makeBatchMock, money, mostOpenReserves, phasesOf, refusal, runUntilEnds, script, startBatch, stepUntil, unwrap, AVATAR, clipProgress } from "./mockEngine.clipBatch.testkit";

// Stage 5, 5b.2, S5.WB3 (plan s5b2 §5.2.2, I5.61-I5.63): a batch in the mock, one member at a time. The reference is the engine (engine.clipBatch.run.test.ts); every number is one of its numbers.

const MIN = 60_000;
const types = (m: ReturnType<typeof makeBatchMock>, ids: readonly string[]): (string | undefined)[] => endsOf(m, ids).map((e) => e?.type);

describe("a batch's money, one member at a time", () => {
  test("writes one reserve and one settle per member in the pick order, never two members between their reserve and their settle", async () => {
    const m = makeBatchMock(3);
    const { jobIds } = await startBatch(m, m.photoIds);
    runUntilEnds(m, jobIds);
    expect(types(m, jobIds)).toEqual(["job.done", "job.done", "job.done"]);

    const lines = m.engine.peekClips().attempts;
    expect(lines.map((l) => [l.attemptId, l.state, l.worstMicros, l.costMicros])).toEqual(jobIds.map((id) => [`${id}:video#1`, "settled", 504_000, 420_000]));
    expect(lines.map((l) => l.reserveAtMs)).toEqual([...lines.map((l) => l.reserveAtMs)].sort((a, b) => a - b));
    expect(mostOpenReserves(m.events)).toBe(1);
    expect(m.engine.peekClips().posts).toEqual(["kling", "kling", "kling"]);
    expect([...m.engine.peekClips().monthHolds]).toEqual([]);
  });

  test("a member's record carries the batch trio, and the clips list tells it", async () => {
    const m = makeBatchMock(3);
    const { batchId, jobIds } = await startBatch(m, m.photoIds);
    runUntilEnds(m, jobIds);
    const listed = (await unwrap(m.client.request("clips.list", { avatarId: AVATAR }))).clips;
    expect(listed.every((clip) => ClipSummary.safeParse(clip).success)).toBe(true);
    expect(listed.map((clip) => [clip.batchId, clip.batchIndex, clip.batchSize, clip.photoId]).sort()).toEqual(jobIds.map((_, i) => [batchId, i + 1, 3, m.photoIds[i]]).sort());
    // `use` belongs to the montage's copy of a clip (5b.2 part A): a batch changes nothing of it.
    expect(listed.every((clip) => !("use" in clip))).toBe(true);
  });

  test("a single clip's summary and job tell no batch at all", async () => {
    const m = makeBatchMock(1);
    const { jobId } = await unwrap(m.client.request("clips.create", { avatarId: AVATAR, photoId: m.photoIds[0] ?? "", motionId: "g-blink", model: "kling", quality: "std", seconds: 5, fallback: "auto", acceptedWorstMicros: 850_000 }));
    stepUntil(m, () => endOf(m.events, jobId) !== undefined, "the end of the clip");
    const [clip] = (await unwrap(m.client.request("clips.list", { avatarId: AVATAR }))).clips;
    expect(clip && "batchId" in clip).toBe(false);
    expect(clipProgress(m.events, jobId).every((p) => p.batchId === undefined && p.waitReason === undefined)).toBe(true);
  });

  test("a member refused for free runs Grok inline, before the next member's turn", async () => {
    const m = makeBatchMock(2);
    script(m, [{ first: "refused-free" }, "ok"]);
    const { jobIds } = await startBatch(m, m.photoIds);
    runUntilEnds(m, jobIds);
    expect(types(m, jobIds)).toEqual(["job.done", "job.done"]);

    const lines = m.engine.peekClips().attempts.sort((a, b) => a.reserveAtMs - b.reserveAtMs);
    expect(lines.map((l) => [l.attemptId, l.worstMicros, l.costMicros])).toEqual([
      [`${jobIds[0]}:video#1`, 504_000, 0],
      [`${jobIds[0]}:video#2`, 850_000, 710_000],
      [`${jobIds[1]}:video#1`, 504_000, 420_000],
    ]);
    expect(m.engine.peekClips().posts).toEqual(["kling", "grok", "kling"]);
    expect(mostOpenReserves(m.events)).toBe(1);
    expect([...m.engine.peekClips().monthHolds]).toEqual([]);
  });

  test("a frame of «Смелая» is never sent to Grok: its refusal ends the member free", async () => {
    const m = makeBatchMock(1, {}, [BOLD_FRAME]);
    const [plain, bold] = m.photoIds;
    script(m, [{ first: "refused-free" }, "ok"]);
    const { jobIds } = await startBatch(m, [bold ?? "", plain ?? ""], { acceptedWorstMicros: 504_000 + 850_000 });
    runUntilEnds(m, jobIds);
    expect(m.engine.peekClips().posts).toEqual(["kling", "kling"]);
    const clips = (await unwrap(m.client.request("clips.list", { avatarId: AVATAR }))).clips;
    expect(clips.find((c) => c.clipId === jobIds[0])).toMatchObject({ status: "failed", failure: { reason: "refused-free" }, cost: { micros: 0, kind: "free" } });
  });

  test("the paid count holds the reconcile at IN_FLIGHT while members are queued, and lets it go when the batch ends", async () => {
    const m = makeBatchMock(2);
    const { jobIds } = await startBatch(m, m.photoIds);
    stepUntil(m, () => phasesOf(m.events, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    expect(await m.client.request("money.reconcile", {})).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });
    runUntilEnds(m, jobIds);
    const after = await m.client.request("money.reconcile", {});
    expect(after.ok === false && after.error.code === "IN_FLIGHT").toBe(false);
  });

  test("a proving member tells the strict proof it waits for; a queued one tells what it waits for; no other phase says", async () => {
    const m = makeBatchMock(2);
    script(m, [{ first: "provider-error" }, "ok"]);
    const { jobIds } = await startBatch(m, m.photoIds);
    runUntilEnds(m, jobIds);
    const first = clipProgress(m.events, jobIds[0] ?? "");
    expect(first.filter((p) => p.phase === "proving").every((p) => p.waitReason === "proof")).toBe(true);
    expect(first.some((p) => p.phase === "proving")).toBe(true);
    for (const p of m.events.flatMap((e) => (e.type === "job.progress" && e.payload.kind === "clip" ? [e.payload] : []))) {
      if (p.waitReason !== undefined) expect(["queued", "proving"]).toContain(p.phase);
      expect(p.batchId).toBeDefined();
    }
  });
});

describe("the wait for the money to be alone (I5.62)", () => {
  const told = (m: ReturnType<typeof makeBatchMock>, jobId: string): boolean => clipProgress(m.events, jobId).some((p) => p.waitReason === "alone");

  test("there is none after a completed clip settled exactly: the next member goes at once, and no `alone` is told", async () => {
    const m = makeBatchMock(3, { clips: { timings: "real" } });
    const { jobIds } = await startBatch(m, m.photoIds);
    runUntilEnds(m, jobIds);
    for (const id of jobIds) expect(told(m, id)).toBe(false);
    expect(m.engine.peekClips().posts).toHaveLength(3);
  });

  test("after a failed sibling whose hold is still live the next member waits for the money to be alone, up to the hold's end, then submits; the reconcile stays held meanwhile", async () => {
    const m = makeBatchMock(2, { clips: { timings: "real" } });
    // A provider error billed by /generation: the proof ends at the first read (15 s) while the terminal hold lasts 2 minutes.
    script(m, ["provider-error-paid", "ok"]);
    const { jobIds } = await startBatch(m, m.photoIds, { fallback: "none", acceptedWorstMicros: 2 * 504_000 });
    stepUntil(m, () => told(m, jobIds[1] ?? ""), "member 2 waiting for the money to be alone");
    const startedWaiting = m.engine.peekClips().nowMs;
    expect(m.engine.peekClips().posts).toHaveLength(1);
    expect(await m.client.request("money.reconcile", {})).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });
    expect(await jobState(m, jobIds[1] ?? "")).toMatchObject({ phase: "queued", waitReason: "alone", batchIndex: 2 });

    stepUntil(m, () => m.engine.peekClips().posts.length === 2, "member 2's POST");
    // The hold ends 2 minutes after the first member's terminal status, less than the bound of 2 min 10 s.
    expect(m.engine.peekClips().nowMs - startedWaiting).toBeLessThan(MOCK_CLIP_TIMINGS.real.aloneWaitMs);
    runUntilEnds(m, jobIds);
    expect(types(m, jobIds)).toEqual(["job.done", "job.done"]);
  });

  test("foreign money that never closes is waited for only up to the bound: then the member submits anyway", async () => {
    const m = makeBatchMock(1, { clips: { timings: "real" } });
    m.engine.openForeignReserve("photo-run-0001:slot-1#1", 60_000);
    const { jobIds } = await startBatch(m, m.photoIds);
    const created = m.engine.peekClips().nowMs;
    stepUntil(m, () => told(m, jobIds[0] ?? ""), "the member waiting");
    expect(m.engine.peekClips().posts).toHaveLength(0);
    stepUntil(m, () => m.engine.peekClips().posts.length === 1, "the member's POST");
    expect(m.engine.peekClips().nowMs - created).toBeGreaterThanOrEqual(MOCK_CLIP_TIMINGS.real.aloneWaitMs);
    expect(MOCK_CLIP_TIMINGS.real.aloneWaitMs).toBe(2 * MIN + 10_000);
  });
});

describe("one clip money unit across the whole engine (I5.61)", () => {
  const create = (m: ReturnType<typeof makeBatchMock>, photoId: string) =>
    m.client.request("clips.create", { avatarId: AVATAR, photoId, motionId: "g-blink", model: "kling", quality: "std", seconds: 5, fallback: "auto", acceptedWorstMicros: 850_000 });

  test("a single clip is refused `batch-running` while a batch holds the unit, and a batch is refused `one-at-a-time` during a single clip", async () => {
    const m = makeBatchMock(3);
    const { jobIds } = await startBatch(m, m.photoIds.slice(0, 2));
    stepUntil(m, () => phasesOf(m.events, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    expect(await create(m, m.photoIds[2] ?? "")).toMatchObject({ ok: false, error: { code: "IN_FLIGHT", clipReason: "batch-running" } });
    expect(await createBatch(m, m.photoIds.slice(2))).toMatchObject({ ok: false, error: { code: "IN_FLIGHT", clipReason: "batch-running" } });
    runUntilEnds(m, jobIds);

    const { jobId } = await unwrap(create(m, m.photoIds[2] ?? ""));
    expect(await createBatch(m, m.photoIds.slice(0, 1))).toMatchObject({ ok: false, error: { code: "IN_FLIGHT", clipReason: "one-at-a-time" } });
    stepUntil(m, () => endOf(m.events, jobId) !== undefined, "the single clip's end");
  });

  test("the unit is held through the whole queue and given back when the last member's money closes, while its file is still being fetched", async () => {
    const m = makeBatchMock(2);
    const { jobIds } = await startBatch(m, m.photoIds.slice(0, 1));
    stepUntil(m, () => phasesOf(m.events, jobIds[0] ?? "").includes("downloading"), "the member's download");
    expect(m.engine.peekClips().unit).toBeNull();
    const { jobId } = await unwrap(create(m, m.photoIds[1] ?? ""));
    runUntilEnds(m, [...jobIds, jobId]);
  });

  test("two creates with no await between them make one unit: the other is refused, free, whichever kind it is", async () => {
    const m = makeBatchMock(4);
    const [a, b] = await Promise.all([createBatch(m, m.photoIds.slice(0, 2)), createBatch(m, m.photoIds.slice(2))]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    const winner = a.ok ? a.result : b.ok ? b.result : null;
    if (winner === null) throw new Error("no batch");
    runUntilEnds(m, winner.jobIds);
    const [c, d] = await Promise.all([create(m, m.photoIds[0] ?? ""), createBatch(m, m.photoIds.slice(1, 3))]);
    expect([c.ok, d.ok].sort()).toEqual([false, true]);
    expect(mostOpenReserves(m.events)).toBe(1);
  });

  test("a library switch and an avatar delete wait for a batch, queued members included", async () => {
    const m = makeBatchMock(2);
    const { jobIds } = await startBatch(m, m.photoIds);
    stepUntil(m, () => phasesOf(m.events, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    expect(m.engine.peekClips().busy).toBe(true);
    expect(m.engine.peekClips().liveAvatars).toEqual([AVATAR]);
    runUntilEnds(m, jobIds);
    expect(m.engine.peekClips().busy).toBe(false);
  });

  test("a clip that has not started has no clip to delete: its id is no clip's, as the engine's active set says", async () => {
    const m = makeBatchMock(2);
    const { jobIds } = await startBatch(m, m.photoIds);
    stepUntil(m, () => phasesOf(m.events, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    expect(await m.client.request("clips.delete", { avatarId: AVATAR, clipId: jobIds[1] ?? "" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await m.client.request("clips.delete", { avatarId: AVATAR, clipId: jobIds[0] ?? "" })).toMatchObject({ ok: false, error: { code: "IN_FLIGHT", clipReason: "job-running" } });
    runUntilEnds(m, jobIds);
  });
});

describe("the turn: the photo", () => {
  test("a photo removed from the gallery before its turn ends its member `photo-gone`, free; the batch goes on and no hold is left", async () => {
    const m = makeBatchMock(3);
    const { jobIds } = await startBatch(m, m.photoIds);
    stepUntil(m, () => phasesOf(m.events, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    m.engine.removeClipPhoto(m.photoIds[1] ?? "");
    runUntilEnds(m, jobIds);

    expect(types(m, jobIds)).toEqual(["job.done", "job.cancelled", "job.done"]);
    expect(detailOf(endOf(m.events, jobIds[1] ?? ""))).toBe("photo-gone");
    expect(m.engine.peekClips().attempts.some((a) => a.clipId === jobIds[1])).toBe(false);
    expect(m.engine.peekClips().posts).toHaveLength(2);
    expect([...m.engine.peekClips().monthHolds]).toEqual([]);
  });

  test("a photo whose file is damaged before its turn ends its member `photo-unreadable`, free; the batch goes on", async () => {
    const m = makeBatchMock(3);
    const { jobIds } = await startBatch(m, m.photoIds);
    stepUntil(m, () => phasesOf(m.events, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    m.engine.setClipPhotoPixels(m.photoIds[1] ?? "", "unreadable");
    runUntilEnds(m, jobIds);
    expect(types(m, jobIds)).toEqual(["job.done", "job.cancelled", "job.done"]);
    expect(detailOf(endOf(m.events, jobIds[1] ?? ""))).toBe("photo-unreadable");
    expect(m.engine.peekClips().posts).toHaveLength(2);
    expect([...m.engine.peekClips().monthHolds]).toEqual([]);
  });

  test("a photo the first frame cannot use (not vertical) is unreadable at the turn too", async () => {
    const m = makeBatchMock(2);
    const { jobIds } = await startBatch(m, m.photoIds);
    stepUntil(m, () => phasesOf(m.events, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    m.engine.setClipPhotoPixels(m.photoIds[1] ?? "", "not-vertical");
    runUntilEnds(m, jobIds);
    expect(detailOf(endOf(m.events, jobIds[1] ?? ""))).toBe("photo-unreadable");
  });
});

describe("the turn: the price, read again", () => {
  const RATES = (std: number, withGrok = true) => ({ std: { perSecondMicros: std, perInputImageMicros: 0 }, pro: { perSecondMicros: 112_000, perInputImageMicros: 0 }, grok: { perSecondMicros: withGrok ? 140_000 : 140_000, perInputImageMicros: 10_000 } });

  test("a price whose worst case is above a member's share ends it and the queue `price-changed`, free; the member before it is untouched; no hold is left", async () => {
    const m = makeBatchMock(3);
    const { jobIds } = await startBatch(m, m.photoIds);
    stepUntil(m, () => phasesOf(m.events, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    m.engine.setClipRates(RATES(200_000));
    m.engine.passClipTime(11 * MIN);
    runUntilEnds(m, jobIds);

    expect(types(m, jobIds)).toEqual(["job.done", "job.cancelled", "job.cancelled"]);
    expect([detailOf(endOf(m.events, jobIds[1] ?? "")), detailOf(endOf(m.events, jobIds[2] ?? ""))]).toEqual(["price-changed", "price-changed"]);
    expect(m.engine.peekClips().posts).toHaveLength(1);
    expect(m.engine.peekClips().attempts).toHaveLength(1);
    expect([...m.engine.peekClips().monthHolds]).toEqual([]);
    expect(m.engine.peekClips().unit).toBeNull();
  });

  test("a price that moved less than 10 minutes ago is not seen at the turn: the cache holds the book the batch was priced by", async () => {
    const m = makeBatchMock(2);
    const { jobIds } = await startBatch(m, m.photoIds);
    stepUntil(m, () => phasesOf(m.events, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    m.engine.setClipRates(RATES(200_000));
    runUntilEnds(m, jobIds);
    expect(types(m, jobIds)).toEqual(["job.done", "job.done"]);
    expect(m.engine.peekClips().attempts.map((a) => a.worstMicros)).toEqual([504_000, 504_000]);
  });

  test("a price that fell goes ahead, and the member reserves at the lower price (its share is only the cap)", async () => {
    const m = makeBatchMock(2);
    const { jobIds } = await startBatch(m, m.photoIds);
    stepUntil(m, () => phasesOf(m.events, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    m.engine.setClipRates(RATES(50_000));
    m.engine.passClipTime(11 * MIN);
    runUntilEnds(m, jobIds);
    expect(types(m, jobIds)).toEqual(["job.done", "job.done"]);
    expect(m.engine.peekClips().attempts.map((a) => a.worstMicros)).toEqual([504_000, 300_000]);
    expect([...m.engine.peekClips().monthHolds]).toEqual([]);
  });

  test("a price that cannot be read ends the queue `price-unavailable`, free, with no hold left", async () => {
    const m = makeBatchMock(3);
    const { jobIds } = await startBatch(m, m.photoIds);
    stepUntil(m, () => phasesOf(m.events, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    m.engine.setVideoPrices("missing");
    m.engine.passClipTime(11 * MIN);
    runUntilEnds(m, jobIds);
    expect(types(m, jobIds)).toEqual(["job.done", "job.cancelled", "job.cancelled"]);
    expect([detailOf(endOf(m.events, jobIds[1] ?? "")), detailOf(endOf(m.events, jobIds[2] ?? ""))]).toEqual(["price-unavailable", "price-unavailable"]);
    expect(m.engine.peekClips().posts).toHaveLength(1);
    expect([...m.engine.peekClips().monthHolds]).toEqual([]);
  });

  test("an unreadable listing is not an unavailable price: the dated table stands in and the batch goes on", async () => {
    const m = makeBatchMock(2);
    const { jobIds } = await startBatch(m, m.photoIds);
    stepUntil(m, () => phasesOf(m.events, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    m.engine.setVideoPrices("fallback");
    m.engine.passClipTime(11 * MIN);
    runUntilEnds(m, jobIds);
    expect(types(m, jobIds)).toEqual(["job.done", "job.done"]);
  });
});

describe("the stops (I5.62): the rest is cancelled for free, every hold released", () => {
  const rest = (m: ReturnType<typeof makeBatchMock>, jobIds: readonly string[]) => jobIds.slice(1).map((id) => detailOf(endOf(m.events, id)));

  test("a bill above a member's reserve halts the ledger: the member is delivered, the queue ends `ledger-stopped`", async () => {
    const m = makeBatchMock(3);
    script(m, ["ok-above-worst"]);
    const { jobIds } = await startBatch(m, m.photoIds);
    runUntilEnds(m, jobIds);
    expect(types(m, jobIds)).toEqual(["job.done", "job.cancelled", "job.cancelled"]);
    expect(rest(m, jobIds)).toEqual(["ledger-stopped", "ledger-stopped"]);
    const clips = (await unwrap(m.client.request("clips.list", { avatarId: AVATAR }))).clips;
    expect(clips.find((c) => c.clipId === jobIds[0])?.status).toBe("ready");
    expect(m.engine.peekClips().posts).toHaveLength(1);
    expect((await money(m)).halt).toMatchObject({ cause: "SETTLE_ABOVE_WORST" });
    expect([...m.engine.peekClips().monthHolds]).toEqual([]);
  });

  test("a defect inside the money machine stops the queue `ledger-stopped` too: whether a reserve is open is not known", async () => {
    const m = makeBatchMock(3);
    script(m, ["fault"]);
    const { jobIds } = await startBatch(m, m.photoIds);
    runUntilEnds(m, jobIds);
    expect(types(m, jobIds)).toEqual(["job.failed", "job.cancelled", "job.cancelled"]);
    expect(endOf(m.events, jobIds[0] ?? "")).toMatchObject({ payload: { error: { code: "INTERNAL" } } });
    expect(rest(m, jobIds)).toEqual(["ledger-stopped", "ledger-stopped"]);
    expect(m.engine.peekClips().posts).toHaveLength(0);
    expect([...m.engine.peekClips().monthHolds]).toEqual([]);
  });

  test("a defect before any reserve stops the queue `cancelled`, not `ledger-stopped`: nothing is open, so no reconcile is asked for (WB2d, L1)", async () => {
    const m = makeBatchMock(3);
    script(m, ["fault-early"]);
    const { jobIds } = await startBatch(m, m.photoIds);
    runUntilEnds(m, jobIds);
    expect(types(m, jobIds)).toEqual(["job.failed", "job.cancelled", "job.cancelled"]);
    expect(endOf(m.events, jobIds[0] ?? "")).toMatchObject({ payload: { error: { code: "INTERNAL" } } });
    expect(rest(m, jobIds)).toEqual(["cancelled", "cancelled"]);
    expect(m.engine.peekClips().posts).toHaveLength(0);
    expect([...m.engine.peekClips().monthHolds]).toEqual([]);
    expect((await money(m)).openReserveMicros ?? 0).toBe(0);
  });

  test("a reserve the ledger refuses (halted, or a reconcile to do) fails that member and stops the rest `ledger-stopped`", async () => {
    const m = makeBatchMock(3);
    const { jobIds } = await startBatch(m, m.photoIds);
    stepUntil(m, () => phasesOf(m.events, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    m.engine.haltAboveWorst();
    runUntilEnds(m, jobIds);
    expect(types(m, jobIds)).toEqual(["job.done", "job.failed", "job.cancelled"]);
    expect(endOf(m.events, jobIds[1] ?? "")).toMatchObject({ payload: { error: { code: "SETTLE_ABOVE_WORST" } } });
    expect(detailOf(endOf(m.events, jobIds[2] ?? ""))).toBe("ledger-stopped");
    expect([...m.engine.peekClips().monthHolds]).toEqual([]);
  });

  // A member's month is held at the batch's create, so no other job can take its room afterwards (every paid command counts the holds: mockEngine.clipBatch.edges.test.ts). The one reserve that can meet a
  // month with no room is a member requeued after a 429, which takes no hold: that path is pinned there.

  test("an uncertain submit ends the queue `money-uncertain`: the member's reserve stays open at worst, nothing else is spent", async () => {
    const m = makeBatchMock(3);
    script(m, ["uncertain"]);
    const { jobIds } = await startBatch(m, m.photoIds);
    runUntilEnds(m, jobIds);
    expect(types(m, jobIds)).toEqual(["job.done", "job.cancelled", "job.cancelled"]);
    expect(rest(m, jobIds)).toEqual(["money-uncertain", "money-uncertain"]);
    const [clip] = (await unwrap(m.client.request("clips.list", { avatarId: AVATAR }))).clips;
    expect(clip).toMatchObject({ status: "failed", failure: { reason: "submit-uncertain" }, cost: { micros: 504_000, kind: "open" } });
    expect(m.engine.peekClips().posts).toHaveLength(1);
    expect((await money(m)).unsettledMicros).toBe(504_000);
    expect([...m.engine.peekClips().monthHolds]).toEqual([]);
  });

  test("after an uncertain submit a new batch is refused `one-at-a-time`, free, while the clip's reserve is open (WB2d, L2)", async () => {
    const m = makeBatchMock(3);
    script(m, ["uncertain"]);
    const { jobIds } = await startBatch(m, m.photoIds.slice(0, 1));
    runUntilEnds(m, jobIds);
    const posts = m.engine.peekClips().posts.length;

    expect(await refusal(createBatch(m, m.photoIds.slice(1)))).toMatchObject({ code: "IN_FLIGHT", clipReason: "one-at-a-time" });
    expect(m.engine.peekClips().posts).toHaveLength(posts);
    expect([...m.engine.peekClips().monthHolds]).toEqual([]);
    expect((await money(m)).unsettledMicros).toBe(504_000);
  });

  test("a clip that outlives its lifetime goes `late` and ends the queue `money-uncertain` before the later members are spent", async () => {
    const m = makeBatchMock(3);
    script(m, ["late"]);
    const { jobIds } = await startBatch(m, m.photoIds);
    stepUntil(m, () => jobIds.slice(1).every((id) => endOf(m.events, id) !== undefined), "the queue's end");
    expect(rest(m, jobIds)).toEqual(["money-uncertain", "money-uncertain"]);
    expect(phasesOf(m.events, jobIds[0] ?? "")).toContain("late");
    expect(m.engine.peekClips().posts).toHaveLength(1);
    expect(m.engine.peekClips().attempts).toHaveLength(1);
    expect(m.engine.peekClips().unit).toBeNull();
  });

  test("a failed member whose money is not uncertain (a refusal, a bad request) does not stop the queue", async () => {
    const m = makeBatchMock(3);
    script(m, ["bad-request", "refused-submit"]);
    const { jobIds } = await startBatch(m, m.photoIds, { fallback: "none", acceptedWorstMicros: 3 * 504_000 });
    runUntilEnds(m, jobIds);
    expect(types(m, jobIds)).toEqual(["job.done", "job.done", "job.done"]);
    expect(m.engine.peekClips().posts).toEqual(["kling", "kling", "kling"]);
  });
});

describe("a 429 at the submit (L11)", () => {
  test("requeues the member once at the tail as a new job: the first keeps its free `rate-limited` record, the new one is made", async () => {
    const m = makeBatchMock(3);
    script(m, ["ok", "rate-limited", "ok", "ok"]);
    const { batchId, jobIds } = await startBatch(m, m.photoIds);
    stepUntil(m, () => m.events.some((e) => e.type === "job.progress" && e.payload.kind === "clip" && e.payload.batchIndex === 2 && !jobIds.includes(e.payload.jobId) && e.payload.phase === "queued"), "the retry's announcement");
    const retry = m.events.flatMap((e) => (e.type === "job.progress" && e.payload.kind === "clip" && e.payload.batchIndex === 2 && !jobIds.includes(e.payload.jobId) ? [e.payload.jobId] : []))[0] ?? "";
    runUntilEnds(m, [...jobIds, retry]);

    const clips = (await unwrap(m.client.request("clips.list", { avatarId: AVATAR }))).clips;
    expect(clips.find((c) => c.clipId === jobIds[1])).toMatchObject({ batchId, batchIndex: 2, batchSize: 3, status: "failed", failure: { reason: "rate-limited" }, cost: { micros: 0, kind: "free" } });
    expect(clips.find((c) => c.clipId === retry)).toMatchObject({ batchId, batchIndex: 2, batchSize: 3, photoId: m.photoIds[1], status: "ready" });
    // m1, m2 (429, free), m3, then m2's retry: four POSTs, the retry last, one reserve open at a time.
    const lines = m.engine.peekClips().attempts.sort((a, b) => a.reserveAtMs - b.reserveAtMs);
    expect(lines.map((l) => l.attemptId)).toEqual([`${jobIds[0]}:video#1`, `${jobIds[1]}:video#1`, `${jobIds[2]}:video#1`, `${retry}:video#1`]);
    expect(lines[1]?.costMicros).toBe(0);
    expect(mostOpenReserves(m.events)).toBe(1);
    expect([...m.engine.peekClips().monthHolds]).toEqual([]);
  });

  test("the retry takes no month hold: its reserve checks the month itself", async () => {
    const m = makeBatchMock(1);
    script(m, ["rate-limited", "ok"]);
    const { jobIds } = await startBatch(m, m.photoIds);
    stepUntil(m, () => m.events.some((e) => e.type === "job.progress" && e.payload.kind === "clip" && !jobIds.includes(e.payload.jobId)), "the retry's announcement");
    expect([...m.engine.peekClips().monthHolds]).toEqual([]);
    stepUntil(m, () => m.engine.peekClips().unit === null, "the end of the batch");
  });

  test("a job with its place exists before the first member's job ends, and tells it waits for its turn (`turn`); its own turn, inside the pause, then tells the pause (`rate-limit`)", async () => {
    const m = makeBatchMock(1);
    script(m, ["rate-limited", "ok"]);
    const { jobIds } = await startBatch(m, m.photoIds);
    stepUntil(m, () => endOf(m.events, jobIds[0] ?? "") !== undefined, "the first member's end");
    const doneAt = m.events.findIndex((e) => e.type === "job.done" && e.payload.jobId === jobIds[0]);
    const queuedAt = m.events.findIndex((e) => e.type === "job.progress" && e.payload.kind === "clip" && e.payload.phase === "queued" && e.payload.batchIndex === 1 && e.payload.jobId !== jobIds[0] && e.payload.waitReason === "turn");
    expect(queuedAt).toBeGreaterThan(-1);
    expect(queuedAt).toBeLessThan(doneAt);
    stepUntil(m, () => m.engine.peekClips().unit === null, "the end of the batch");
    const retry = m.events.flatMap((e) => (e.type === "job.progress" && e.payload.kind === "clip" && e.payload.batchIndex === 1 && e.payload.jobId !== jobIds[0] && e.payload.phase === "queued" ? [e.payload.waitReason] : []));
    expect(retry).toEqual(["turn", "rate-limit"]);
  });

  test("a requeued member waits for its turn at the tail: the pause is told by the member whose turn falls inside it, not by the requeued one whose turn comes after it", async () => {
    const m = makeBatchMock(3);
    script(m, ["ok", "rate-limited", "ok", "ok"]);
    const { jobIds } = await startBatch(m, m.photoIds);
    stepUntil(m, () => m.engine.peekClips().unit === null, "the end of the batch");
    const reasonsOf = (match: (jobId: string) => boolean, index: number): (string | undefined)[] =>
      m.events.flatMap((e) => (e.type === "job.progress" && e.payload.kind === "clip" && e.payload.batchIndex === index && match(e.payload.jobId) && e.payload.phase === "queued" ? [e.payload.waitReason] : []));
    expect(reasonsOf((id) => id === jobIds[2], 3)).toEqual(["turn", "rate-limit"]);
    expect(reasonsOf((id) => !jobIds.includes(id), 2)).toEqual(["turn"]);
  });

  test("a second 429 for the same photo is final: two POSTs for it, and the batch ends", async () => {
    const m = makeBatchMock(2);
    script(m, ["ok", "rate-limited", "rate-limited"]);
    const { jobIds } = await startBatch(m, m.photoIds);
    stepUntil(m, () => m.engine.peekClips().unit === null && m.engine.peekClips().posts.length === 3, "the end of the batch");
    expect(m.engine.peekClips().posts).toEqual(["kling", "kling", "kling"]);
    const clips = (await unwrap(m.client.request("clips.list", { avatarId: AVATAR }))).clips;
    expect(clips.filter((c) => c.status === "failed" && c.failure.reason === "rate-limited")).toHaveLength(2);
    expect(clips.filter((c) => c.photoId === m.photoIds[1])).toHaveLength(2);
    expect(jobIds).toHaveLength(2);
    expect([...m.engine.peekClips().monthHolds]).toEqual([]);
  });

  test("waits out the pause: the retry's POST comes no sooner than the pause after the 429", async () => {
    const m = makeBatchMock(1);
    script(m, ["rate-limited", "ok"]);
    const { jobIds } = await startBatch(m, m.photoIds);
    stepUntil(m, () => endOf(m.events, jobIds[0] ?? "") !== undefined, "the first member's end");
    const limited = m.at[m.events.findIndex((e) => e.type === "job.done" && e.payload.jobId === jobIds[0])] ?? 0;
    const submitting = (): number => m.events.findIndex((e) => e.type === "job.progress" && e.payload.kind === "clip" && e.payload.phase === "submitting" && e.payload.jobId !== jobIds[0]);
    stepUntil(m, () => submitting() > -1, "the retry's reserve");
    expect((m.at[submitting()] ?? 0) - limited).toBeGreaterThanOrEqual(MOCK_CLIP_TIMINGS.short.rateLimitPauseMs - 1);
    stepUntil(m, () => m.engine.peekClips().unit === null, "the end of the batch");
  });

  test("on the short set the pause is the real 60 s divided by a thousand, and the real set's is 60 s", () => {
    expect(MOCK_CLIP_TIMINGS.real.rateLimitPauseMs).toBe(60_000);
    expect(MOCK_CLIP_TIMINGS.short.rateLimitPauseMs).toBe(60);
  });

  test("a 429 on the Grok attempt behind a free Kling requeues the whole member, which starts again from Kling (the engine's present rule; backlog)", async () => {
    const m = makeBatchMock(1);
    script(m, [{ first: "refused-free", then: "rate-limited" }, "ok"]);
    const { jobIds } = await startBatch(m, m.photoIds);
    stepUntil(m, () => m.engine.peekClips().unit === null && endOf(m.events, jobIds[0] ?? "") !== undefined, "the end of the batch");
    expect(m.engine.peekClips().posts).toEqual(["kling", "grok", "kling"]);
  });
});

describe("cancel (I5.63)", () => {
  test("`clips.cancelBatch` cancels the queued members, free, and says how many; the member in flight is never cancelled", async () => {
    const m = makeBatchMock(4);
    const { batchId, jobIds } = await startBatch(m, m.photoIds);
    stepUntil(m, () => phasesOf(m.events, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    expect(await cancelBatch(m, batchId)).toMatchObject({ ok: true, result: { cancelled: 3 } });
    expect(endsOf(m, jobIds.slice(1)).map((e) => e?.type)).toEqual(["job.cancelled", "job.cancelled", "job.cancelled"]);
    expect(endsOf(m, jobIds.slice(1)).map(detailOf)).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(await cancelBatch(m, batchId)).toMatchObject({ ok: true, result: { cancelled: 0 } });
    runUntilEnds(m, jobIds);
    expect(endOf(m.events, jobIds[0] ?? "")?.type).toBe("job.done");
    expect(m.engine.peekClips().posts).toHaveLength(1);
    expect([...m.engine.peekClips().monthHolds]).toEqual([]);
    // The unit came back with the last money.
    stepUntil(m, () => m.engine.peekClips().unit === null, "the unit back");
    const next = await startBatch(m, m.photoIds.slice(0, 1));
    runUntilEnds(m, next.jobIds);
  });

  test("`clips.cancelBatch` after the batch ended answers 0; an unknown batch is NOT_FOUND", async () => {
    const m = makeBatchMock(1);
    const { batchId, jobIds } = await startBatch(m, m.photoIds);
    runUntilEnds(m, jobIds);
    expect(await cancelBatch(m, batchId)).toMatchObject({ ok: true, result: { cancelled: 0 } });
    expect(await cancelBatch(m, "batch-nope-0001")).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await cancelBatch(m, batchId, "avatar-nope-0001")).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  test("`avatars.cancel` on one queued member cancels it alone, free; the member in flight is IN_FLIGHT `submitted` and the others go on", async () => {
    const m = makeBatchMock(3);
    const { jobIds } = await startBatch(m, m.photoIds);
    stepUntil(m, () => phasesOf(m.events, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    expect(await m.client.request("avatars.cancel", { jobId: jobIds[0] ?? "" })).toMatchObject({ ok: false, error: { code: "IN_FLIGHT", clipReason: "submitted" } });
    expect(await m.client.request("avatars.cancel", { jobId: jobIds[1] ?? "" })).toMatchObject({ ok: true, result: { jobId: jobIds[1] } });
    runUntilEnds(m, jobIds);
    expect(types(m, jobIds)).toEqual(["job.done", "job.cancelled", "job.done"]);
    expect(detailOf(endOf(m.events, jobIds[1] ?? ""))).toBe("cancelled");
    expect(m.engine.peekClips().posts).toHaveLength(2);
    expect([...m.engine.peekClips().monthHolds]).toEqual([]);
  });

  test("a member cancelled in its `preparing` ends `cancelled` and the batch goes on with the next one", async () => {
    const m = makeBatchMock(3);
    const { jobIds } = await startBatch(m, m.photoIds);
    // Member 2's turn begins when member 1's money has closed, while member 1's file is still being fetched.
    stepUntil(m, () => phasesOf(m.events, jobIds[1] ?? "").includes("preparing"), "member 2 preparing");
    expect(await m.client.request("avatars.cancel", { jobId: jobIds[1] ?? "" })).toMatchObject({ ok: true });
    runUntilEnds(m, jobIds);
    expect(types(m, jobIds)).toEqual(["job.done", "job.cancelled", "job.done"]);
    expect(detailOf(endOf(m.events, jobIds[1] ?? ""))).toBe("cancelled");
    expect(m.engine.peekClips().attempts.some((a) => a.clipId === jobIds[1])).toBe(false);
    expect([...m.engine.peekClips().monthHolds]).toEqual([]);
  });

  test("a cancelled member's job is listed cancelled with its reason, and its hold is back in the month", async () => {
    const m = makeBatchMock(2);
    const { batchId, jobIds } = await startBatch(m, m.photoIds);
    stepUntil(m, () => phasesOf(m.events, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    expect([...m.engine.peekClips().monthHolds].map(([, v]) => v)).toEqual([850_000]);
    await cancelBatch(m, batchId);
    expect([...m.engine.peekClips().monthHolds]).toEqual([]);
    expect(await jobState(m, jobIds[1] ?? "")).toMatchObject({ status: "cancelled", detail: "cancelled", batchIndex: 2 });
    runUntilEnds(m, jobIds);
  });

  test("a cancel is final: the 429 of the member being submitted, after the cancel, requeues nothing", async () => {
    const m = makeBatchMock(3);
    script(m, ["rate-limited", "ok", "ok"]);
    const { batchId, jobIds } = await startBatch(m, m.photoIds);
    stepUntil(m, () => phasesOf(m.events, jobIds[0] ?? "").includes("submitting"), "member 1 submitting");
    expect(await cancelBatch(m, batchId)).toMatchObject({ ok: true, result: { cancelled: 2 } });
    stepUntil(m, () => endOf(m.events, jobIds[0] ?? "") !== undefined && m.engine.peekClips().unit === null, "the end of the batch");
    m.scheduler.runAll();
    expect(m.engine.peekClips().posts).toEqual(["kling"]);
    expect(m.events.some((e) => e.type === "job.progress" && e.payload.kind === "clip" && !jobIds.includes(e.payload.jobId))).toBe(false);
    expect([...m.engine.peekClips().monthHolds]).toEqual([]);
  });
});

describe("the key at each turn", () => {
  test("a rejected key (401 on a member) fails the later members fast and free: no POST for them, nothing held", async () => {
    const m = makeBatchMock(3);
    script(m, ["key-invalid"]);
    const { jobIds } = await startBatch(m, m.photoIds);
    runUntilEnds(m, jobIds);
    expect(types(m, jobIds)).toEqual(["job.done", "job.failed", "job.failed"]);
    for (const id of jobIds.slice(1)) expect(endOf(m.events, id)).toMatchObject({ payload: { error: { code: "AUTH_INVALID" } } });
    expect(m.engine.peekClips().posts).toHaveLength(1);
    expect([...m.engine.peekClips().monthHolds]).toEqual([]);
    expect(m.engine.peekClips().unit).toBeNull();
  });

  test("a key removed meanwhile is met at the next turn the same way", async () => {
    const m = makeBatchMock(3);
    const { jobIds } = await startBatch(m, m.photoIds);
    stepUntil(m, () => phasesOf(m.events, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    await m.client.request("settings.clearApiKey", {});
    runUntilEnds(m, jobIds);
    expect(types(m, jobIds)).toEqual(["job.done", "job.failed", "job.failed"]);
    expect(await refusal(createBatch(m, m.photoIds.slice(0, 1)))).toMatchObject({ code: "AUTH_INVALID" });
  });
});

describe("a restart in the middle of a batch (I5.63)", () => {
  test("drops the queued members for free: no job, no reserve, no record, and no hold is left; the unit is free", async () => {
    const m = makeBatchMock(3);
    const { jobIds } = await startBatch(m, m.photoIds);
    stepUntil(m, () => phasesOf(m.events, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    m.engine.restart();
    m.scheduler.runAll();
    const clips = (await unwrap(m.client.request("clips.list", { avatarId: AVATAR }))).clips;
    expect(clips.map((c) => c.clipId)).toEqual([jobIds[0]]);
    expect(m.engine.peekClips().attempts.map((a) => a.clipId)).toEqual([jobIds[0]]);
    expect([...m.engine.peekClips().monthHolds]).toEqual([]);
    expect(m.engine.peekClips().unit).toBeNull();
    expect(m.engine.peekClips().posts).toHaveLength(1);
  });

  test("the sent member is recovered as a single clip is, and its record carries the batch trio; nothing is spent", async () => {
    const m = makeBatchMock(3);
    const { batchId, jobIds } = await startBatch(m, m.photoIds);
    stepUntil(m, () => phasesOf(m.events, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    m.engine.restart();
    const snapshot = await unwrap(m.client.request("engine.snapshot", {}));
    const jobs = snapshot.jobs.filter((j) => j.kind === "clip");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ phase: "recovering", clipId: jobIds[0], batchId, batchIndex: 1, batchSize: 3 });
    m.scheduler.runAll();
    const clips = (await unwrap(m.client.request("clips.list", { avatarId: AVATAR }))).clips;
    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({ clipId: jobIds[0], recovered: true, batchId, batchIndex: 1, batchSize: 3 });
    expect(m.engine.peekClips().posts).toHaveLength(1);
  });

  test("the journal a member leaves is the engine's own: its strict schema reads the batch trio, and the engine's recovery plan is the mock's", async () => {
    const m = makeBatchMock(2);
    const { batchId, jobIds } = await startBatch(m, m.photoIds);
    stepUntil(m, () => phasesOf(m.events, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    const lines = m.engine.peekClips().journals[jobIds[0] ?? ""] ?? [];
    const parsed = lines.map((line) => ClipJournalLine.parse(line));
    expect(parsed[0]).toMatchObject({ type: "requested", batch: { batchId, batchIndex: 1, batchSize: 2 } });
    const summary = summarizeJournal(parsed);
    expect(summary.requested?.batch).toEqual({ batchId, batchIndex: 1, batchSize: 2 });
    const reserved = new Set(m.engine.peekClips().attempts.filter((a) => a.clipId === jobIds[0]).map((a) => a.attemptId));
    const plan = planRecovery({ summary, recordExists: false, reservedAttempts: reserved, nowMs: m.engine.peekClips().nowMs, timings: REAL_CLIP_TIMINGS });
    expect(plan.kind).toBe("poll");
    m.engine.restart();
    const [recovery] = (await unwrap(m.client.request("engine.snapshot", {}))).jobs.filter((j) => j.kind === "clip");
    expect(recovery).toMatchObject({ phase: "recovering", batchId, batchIndex: 1, batchSize: 2 });
  });

  test("no batch resumes after a restart without a new acceptance, and a new batch is taken", async () => {
    const m = makeBatchMock(3);
    const { jobIds } = await startBatch(m, m.photoIds);
    stepUntil(m, () => phasesOf(m.events, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    m.engine.restart();
    m.scheduler.runAll();
    expect(m.engine.peekClips().posts).toHaveLength(1);
    // The earlier process's reserve (or its settle) waits for the owner's reconcile; the unit itself is free.
    expect(m.engine.peekClips().unit).toBeNull();
  });
});

describe("the quit (45b)", () => {
  test("counts the clips in flight and the queued members as the engine's host does", async () => {
    const m = makeBatchMock(4);
    const { jobIds } = await startBatch(m, m.photoIds);
    expect(m.engine.peekClips().quit).toEqual({ inFlight: 0, queued: 4 });
    stepUntil(m, () => phasesOf(m.events, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    expect(m.engine.peekClips().quit).toEqual({ inFlight: 1, queued: 3 });
    runUntilEnds(m, jobIds);
    expect(m.engine.peekClips().quit).toEqual({ inFlight: 0, queued: 0 });
  });
});
