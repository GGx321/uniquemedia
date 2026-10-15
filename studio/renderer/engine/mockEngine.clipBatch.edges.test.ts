import { describe, expect, test } from "bun:test";
import { DEFAULT_TRAITS } from "../lib/traits";
import { AVATAR, endOf, makeBatchMock, phasesOf, refusal, runUntilEnds, startBatch, stepUntil, unwrap, type BatchMock } from "./mockEngine.clipBatch.testkit";

// Stage 5, 5b.2, S5.WB3 round 2: the edges of a batch's money. The engine counts the month as spent + open + HELD for every paid command (engine.ts `#checkMonthlyRoom`, budget.ts `tryReserve`), and the
// autopilot's room also subtracts the unspent rest of every live cap (autopilot/room.ts, `monthRoom`): a clip's cap is its accepted worst case (a batch member's, its share). The mock's other paid
// commands and its autopilot room must see both.

interface LaunchRoom {
  launchMonthRoom(): { budgetMicros: number; committedMicros: number };
}
const roomOf = (m: BatchMock): { budgetMicros: number; committedMicros: number } => (m.engine as unknown as LaunchRoom).launchMonthRoom();

async function draftWorst(m: BatchMock): Promise<number> {
  return (await unwrap(m.client.request("avatars.estimate", { traits: DEFAULT_TRAITS }))).worstMicros;
}

describe("a batch's month holds are seen by every other paid command", () => {
  test("a draft whose worst case fits the month without the holds and not with them is BUDGET_EXCEEDED while the batch runs, and goes through once it ended", async () => {
    const probe = makeBatchMock(1);
    const worst = await draftWorst(probe);
    // Room for the three held shares (3 x 850 000) and, beyond them, one micro-dollar less than the draft needs.
    const m = makeBatchMock(4, { money: { monthlyBudgetMicros: 3 * 850_000 + worst - 1 } });
    expect(worst).toBeGreaterThan(0);
    const { jobIds } = await startBatch(m, m.photoIds.slice(0, 3));
    expect(await refusal(m.client.request("avatars.createDraft", { traits: DEFAULT_TRAITS, acceptedWorstMicros: worst }))).toMatchObject({ code: "BUDGET_EXCEEDED" });
    runUntilEnds(m, jobIds);
    // The batch settled 3 x 420 000 and held nothing: the same draft fits now.
    expect((await m.client.request("avatars.createDraft", { traits: DEFAULT_TRAITS, acceptedWorstMicros: worst })).ok).toBe(true);
  });

  test("the same draft fits when the holds leave it room (the boundary: exactly the worst case is accepted)", async () => {
    const worst = await draftWorst(makeBatchMock(1));
    const m = makeBatchMock(4, { money: { monthlyBudgetMicros: 3 * 850_000 + worst } });
    const { jobIds } = await startBatch(m, m.photoIds.slice(0, 3));
    expect((await m.client.request("avatars.createDraft", { traits: DEFAULT_TRAITS, acceptedWorstMicros: worst })).ok).toBe(true);
    runUntilEnds(m, jobIds);
  });
});

describe("the autopilot's month room minus the holds and the live caps", () => {
  test("a batch's room is spent + open + held + the unspent rest of every member's cap", async () => {
    const m = makeBatchMock(3, { money: { monthlyBudgetMicros: 10_000_000 } });
    const { jobIds } = await startBatch(m, m.photoIds);
    // Queued: 3 x 850 000 held; each cap equals its hold, so nothing is unspent beyond it.
    expect(roomOf(m)).toEqual({ budgetMicros: 10_000_000, committedMicros: 3 * 850_000 });
    stepUntil(m, () => phasesOf(m.events, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    // Member 1 reserved Kling's 504 000 (its hold went); its cap leaves 850 000 - 504 000 unspent; the other two hold 850 000 each.
    expect(roomOf(m).committedMicros).toBe(504_000 + (850_000 - 504_000) + 2 * 850_000);
    runUntilEnds(m, jobIds);
    expect(roomOf(m).committedMicros).toBe(3 * 420_000);
  });

  test("a cancelled member gives its hold and its cap back", async () => {
    const m = makeBatchMock(3, { money: { monthlyBudgetMicros: 10_000_000 } });
    const { jobIds } = await startBatch(m, m.photoIds);
    stepUntil(m, () => phasesOf(m.events, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    await m.client.request("avatars.cancel", { jobId: jobIds[1] ?? "" });
    expect(roomOf(m).committedMicros).toBe(850_000 + 850_000);
    runUntilEnds(m, jobIds);
  });

  test("a single clip counts the same way: its open reserve and the unspent rest of its cap", async () => {
    const m = makeBatchMock(1, { money: { monthlyBudgetMicros: 10_000_000 } });
    const { jobId } = await unwrap(m.client.request("clips.create", { avatarId: AVATAR, photoId: m.photoIds[0] ?? "", motionId: "g-blink", model: "kling", quality: "std", seconds: 5, fallback: "auto", acceptedWorstMicros: 850_000 }));
    stepUntil(m, () => phasesOf(m.events, jobId).includes("rendering"), "the clip rendering");
    expect(roomOf(m).committedMicros).toBe(850_000);
    stepUntil(m, () => endOf(m.events, jobId) !== undefined, "the clip's end");
    expect(roomOf(m).committedMicros).toBe(420_000);
  });
});

describe("one price cache for every clip command", () => {
  const RATES_200K = { std: { perSecondMicros: 200_000, perInputImageMicros: 0 }, pro: { perSecondMicros: 112_000, perInputImageMicros: 0 }, grok: { perSecondMicros: 140_000, perInputImageMicros: 10_000 } };
  const createSingle = (m: BatchMock) =>
    m.client.request("clips.create", { avatarId: AVATAR, photoId: m.photoIds[0] ?? "", motionId: "g-blink", model: "kling", quality: "std", seconds: 5, fallback: "auto", acceptedWorstMicros: 850_000 });

  test("P1: options, the listing moves, create at the old accepted worst within 10 minutes: the cache answers, the clip is made; after the cache ran out it is PRICE_CHANGED", async () => {
    const m = makeBatchMock(1);
    await unwrap(m.client.request("clips.options", { avatarId: AVATAR, photoId: m.photoIds[0] ?? "" }));
    m.engine.setClipRates(RATES_200K);
    const { jobId } = await unwrap(createSingle(m));
    stepUntil(m, () => endOf(m.events, jobId) !== undefined, "the clip's end");
    m.engine.passClipTime(11 * 60_000);
    expect(await refusal(createSingle(m))).toMatchObject({ code: "PRICE_CHANGED" });
  });

  test("P2: options, the listing moves, batchOptions within 10 minutes: the same book, the same sums", async () => {
    const m = makeBatchMock(1);
    await unwrap(m.client.request("clips.options", { avatarId: AVATAR, photoId: m.photoIds[0] ?? "" }));
    m.engine.setClipRates(RATES_200K);
    expect((await unwrap(m.client.request("clips.batchOptions", { avatarId: AVATAR, photoIds: [m.photoIds[0] ?? ""] }))).sums.std5.worst).toBe(850_000);
    m.engine.passClipTime(11 * 60_000);
    expect((await unwrap(m.client.request("clips.batchOptions", { avatarId: AVATAR, photoIds: [m.photoIds[0] ?? ""] }))).sums.std5.worst).toBe(1_200_000);
  });

  test("the book keeps where its prices came from and the day, not the listing's mode now", async () => {
    const m = makeBatchMock(1);
    const first = await unwrap(m.client.request("clips.options", { avatarId: AVATAR, photoId: m.photoIds[0] ?? "" }));
    m.engine.setVideoPrices("fallback");
    const second = await unwrap(m.client.request("clips.options", { avatarId: AVATAR, photoId: m.photoIds[0] ?? "" }));
    if (!first.suitable || !second.suitable) throw new Error("expected suitable photos");
    expect(second.prices.std5).toEqual(first.prices.std5);
    m.engine.passClipTime(61 * 60_000);
    const third = await unwrap(m.client.request("clips.options", { avatarId: AVATAR, photoId: m.photoIds[0] ?? "" }));
    if (!third.suitable) throw new Error("expected a suitable photo");
    expect(third.prices.std5).toMatchObject({ prices: "fallback", pricesAsOf: "2026-10-10" });
  });
});

describe("scripts and the sheet's edges", () => {
  test("what a batch left of its scripts never reaches the next batch", async () => {
    const m = makeBatchMock(2);
    m.engine.scriptNextBatch(["ok", "uncertain", "uncertain"]);
    const first = await startBatch(m, m.photoIds.slice(0, 1));
    runUntilEnds(m, first.jobIds);
    const second = await startBatch(m, m.photoIds.slice(1));
    runUntilEnds(m, second.jobIds);
    expect(endOf(m.events, second.jobIds[0] ?? "")?.type).toBe("job.done");
    expect(m.engine.peekClips().attempts.find((a) => a.clipId === second.jobIds[0])?.state).toBe("settled");
  });

  test("a restart drops the scripts armed for a batch", async () => {
    const m = makeBatchMock(1);
    m.engine.scriptNextBatch(["uncertain"]);
    m.engine.restart();
    const { jobIds } = await startBatch(m, m.photoIds);
    runUntilEnds(m, jobIds);
    expect(m.engine.peekClips().attempts.find((a) => a.clipId === jobIds[0])?.state).toBe("settled");
  });

  test("a ledger that cannot be read leaves the sheet no room and nothing fits, as the engine's missing budget does", async () => {
    const m = makeBatchMock(2, { money: { unavailable: { cause: "LEDGER_UNREADABLE", detail: "the ledger cannot be read" } } });
    const answer = await unwrap(m.client.request("clips.batchOptions", { avatarId: AVATAR, photoIds: m.photoIds }));
    expect(answer.monthRoomMicros).toBe(0);
    expect(answer.monthFits).toEqual({ std5: "none", pro5: "none", std10: "none", pro10: "none" });
    expect(answer.items.every((item) => item.suitable && item.monthFits.std5 === "none")).toBe(true);
  });
});

describe("a member requeued after a 429 takes no month hold", () => {
  test("its reserve checks the month itself: the room another job took meanwhile makes it a free BUDGET_EXCEEDED, and the unit comes back", async () => {
    const m = makeBatchMock(1, { money: { monthlyBudgetMicros: 1_500_000 } });
    m.engine.scriptNextBatch(["rate-limited", "ok"]);
    const { jobIds } = await startBatch(m, m.photoIds);
    stepUntil(m, () => endOf(m.events, jobIds[0] ?? "") !== undefined, "the first member's end");
    // The 429 gave its room back; another kind of job takes almost all of it before the retry's reserve.
    m.engine.openForeignReserve("photo-run-0009:slot-1#1", 1_400_000);
    const retry = m.events.flatMap((e) => (e.type === "job.progress" && e.payload.kind === "clip" && !jobIds.includes(e.payload.jobId) ? [e.payload.jobId] : []))[0] ?? "";
    expect(retry).not.toBe("");
    stepUntil(m, () => endOf(m.events, retry) !== undefined, "the retry's end");
    expect(endOf(m.events, retry)).toMatchObject({ type: "job.failed", payload: { error: { code: "BUDGET_EXCEEDED" } } });
    expect(m.engine.peekClips().posts).toHaveLength(1);
    expect(m.engine.peekClips().unit).toBeNull();
    expect([...m.engine.peekClips().monthHolds]).toEqual([]);
  });
});
