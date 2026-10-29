import { describe, expect, test } from "bun:test";
import { createBatch, detailOf, endOf, endsOf, makeBatchMock, money, mostOpenReserves, phasesOf, runUntilEnds, script, startBatch, stepUntil, unwrap, AVATAR } from "./mockEngine.clipBatch.testkit";

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

  // A member's month is held at the batch's create, so no other job can take its room afterwards (every paid command counts the holds: mockEngine.clipBatch.edges.test.ts). The one reserve that can meet a
  // month with no room is a member requeued after a 429, which takes no hold: that path is pinned there.

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

});

