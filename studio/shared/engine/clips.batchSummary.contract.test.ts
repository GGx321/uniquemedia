import { describe, expect, test } from "bun:test";
import { ClipBatchSummary, CLIP_BATCH_OUTCOMES, MAX_LISTED_BATCHES, clipBatchCostOf } from "./clips";
import { OkResponse } from "./commands";
import { PROTOCOL_VERSION } from "./envelope";

// Stage 5, 5b.2, S5.WB2c (plan s5b2 §5.2, I5.61-I5.63, I5.70): the batch's own summary, written by the engine and carried by `clips.list`, so the «Клипы» header never derives a money sentence from the records
// (a clip the owner deleted is not a member that was dropped unshot). Additive in protocol 5: every shape is tried in its old form first.

const AVATAR = "avatar-aaaa-0001";
const BATCH = "batch-00000001";
const clip = (i: number): string => `clip-${String(i).padStart(7, "0")}`;
const AT = "2026-10-15T10:00:00.000Z";

const member = (i: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({ batchIndex: i, outcome: "ready", costMicros: 420_000, costKind: "billed", clipIds: [clip(i)], ...over });

/** A batch of three made whole: 3 x $0.42, billed. */
const summary = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  batchId: BATCH,
  avatarId: AVATAR,
  size: 3,
  createdAt: AT,
  members: [member(1), member(2), member(3)],
  endedAt: "2026-10-15T10:06:00.000Z",
  cost: { micros: 1_260_000, kind: "billed" },
  ...over,
});

const answers = (result: unknown): boolean => OkResponse.safeParse({ v: PROTOCOL_VERSION, id: "msg-00000001", kind: "response", type: "clips.list", ok: true, result }).success;
const listed = (...batches: unknown[]): Record<string, unknown> => ({ clips: [], batches });

describe("clips.list carries the avatar's batch summaries", () => {
  test("an answer without batches parses as before (an avatar that made no batch, and every older engine)", () => {
    expect(answers({ clips: [] })).toBe(true);
  });

  test("an answer with a batch summary parses", () => {
    expect(answers(listed(summary()))).toBe(true);
  });

  test("an empty list of batches is not sent: the field is absent instead", () => {
    expect(answers(listed(summary()))).toBe(true);
    expect(answers(summary())).toBe(false);
    expect(answers({ clips: [], batches: [] })).toBe(false);
  });

  test("at most MAX_LISTED_BATCHES summaries, each batch once, newest first", () => {
    expect(MAX_LISTED_BATCHES).toBe(20);
    const nth = (i: number) => summary({ batchId: `batch-${String(i).padStart(8, "0")}`, createdAt: new Date(Date.parse(AT) - i * 60_000).toISOString() });
    expect(answers(listed(...Array.from({ length: 20 }, (_, i) => nth(i))))).toBe(true);
    expect(answers(listed(...Array.from({ length: 21 }, (_, i) => nth(i))))).toBe(false);
    expect(answers(listed(nth(1), nth(1)))).toBe(false);
    expect(answers(listed(nth(1), nth(2)))).toBe(true);
    expect(answers(listed(nth(2), nth(1)))).toBe(false);
  });

  test("a summary is strict: no key the contract does not name, and every required key present", () => {
    expect(answers(listed(summary()))).toBe(true);
    expect(answers(listed(summary({ total: 3 })))).toBe(false);
    for (const key of ["batchId", "avatarId", "size", "createdAt", "members", "cost"]) {
      const { [key]: _gone, ...rest } = summary();
      expect(answers(listed(rest))).toBe(false);
    }
    expect(answers(listed(summary({ members: [member(1, { photoId: "photo-0001" }), member(2), member(3)] })))).toBe(false);
  });
});

describe("ClipBatchSummary's members", () => {
  test("are the batch's places, one each, in order from 1 to its size", () => {
    expect(answers(listed(summary({ members: [member(1), member(2)] })))).toBe(false);
    expect(answers(listed(summary({ members: [member(1), member(3), member(2)] })))).toBe(false);
    expect(answers(listed(summary({ members: [member(1), member(2), member(2)] })))).toBe(false);
    expect(answers(listed(summary({ size: 1, members: [member(1)], cost: { micros: 420_000, kind: "billed" } })))).toBe(true);
  });

  test("each ends in one of the seven outcomes", () => {
    expect(CLIP_BATCH_OUTCOMES).toEqual(["queued", "running", "ready", "refused", "failed", "cancelled", "dropped"]);
    expect(answers(listed(summary({ members: [member(1), member(2), member(3, { outcome: "made" })] })))).toBe(false);
  });

  test("a cancelled member says why, and only a cancelled one does", () => {
    const free = { costMicros: 0, costKind: "free" };
    const cancelled = (detail?: string) => summary({ members: [member(1), member(2), member(3, { outcome: "cancelled", ...free, ...(detail === undefined ? {} : { detail }) })], cost: { micros: 840_000, kind: "billed" } });
    expect(answers(listed(cancelled("price-changed")))).toBe(true);
    expect(answers(listed(cancelled()))).toBe(false);
    expect(answers(listed(cancelled("not-a-detail")))).toBe(false);
    expect(answers(listed(summary({ members: [member(1), member(2), member(3, { detail: "cancelled" })] })))).toBe(false);
    const dropped = summary({ members: [member(1), member(2), member(3, { outcome: "dropped", ...free, detail: "cancelled" })], cost: { micros: 840_000, kind: "billed" } });
    expect(answers(listed(dropped))).toBe(false);
  });

  test("a cost is whole micro-dollars and its kind, and a free one is zero", () => {
    expect(answers(listed(summary()))).toBe(true);
    expect(answers(listed(summary({ members: [member(1), member(2), member(3, { costMicros: 420_000.5 })] })))).toBe(false);
    expect(answers(listed(summary({ members: [member(1), member(2), member(3, { costMicros: -1 })] })))).toBe(false);
    expect(answers(listed(summary({ members: [member(1), member(2), member(3, { costKind: "guessed" })] })))).toBe(false);
    expect(answers(listed(summary({ members: [member(1), member(2), member(3, { costKind: "free" })] })))).toBe(false);
  });

  test("a member names its clips: one, or two after a 429 requeued it, never the same twice, never a clip of another member", () => {
    const twice = summary({ members: [member(1), member(2, { clipIds: [clip(2), clip(4)] }), member(3)] });
    expect(answers(listed(twice))).toBe(true);
    expect(answers(listed(summary({ members: [member(1), member(2, { clipIds: [] }), member(3)] })))).toBe(false);
    expect(answers(listed(summary({ members: [member(1), member(2, { clipIds: [clip(2), clip(4), clip(5)] }), member(3)] })))).toBe(false);
    expect(answers(listed(summary({ members: [member(1), member(2, { clipIds: [clip(2), clip(2)] }), member(3)] })))).toBe(false);
    expect(answers(listed(summary({ members: [member(1), member(2, { clipIds: [clip(1)] }), member(3)] })))).toBe(false);
    expect(answers(listed(summary({ members: [member(1), member(2, { clipIds: ["../x"] }), member(3)] })))).toBe(false);
  });
});

describe("ClipBatchSummary's end, stop and total", () => {
  const free = { costMicros: 0, costKind: "free" };

  test("a batch that ended has nothing queued; one still running has no end yet", () => {
    const queued = { members: [member(1), member(2, { outcome: "running", costMicros: 504_000, costKind: "open" }), member(3, { outcome: "queued", ...free })], cost: { micros: 924_000, kind: "open" } };
    expect(answers(listed(summary(queued)))).toBe(false);
    const { endedAt: _ended, ...running } = summary(queued);
    expect(answers(listed(running))).toBe(true);
  });

  test("a stop is one of the five that end the queue, and names the detail its cancelled members carry", () => {
    const stopped = (stop: string, detail: string) => summary({ stop, members: [member(1), member(2, { outcome: "cancelled", detail, ...free }), member(3, { outcome: "cancelled", detail, ...free })], cost: { micros: 420_000, kind: "billed" } });
    for (const stop of ["price-changed", "price-unavailable", "ledger-stopped", "money-uncertain", "cancelled"]) expect(answers(listed(stopped(stop, stop)))).toBe(true);
    expect(answers(listed(stopped("photo-gone", "photo-gone")))).toBe(false);
    expect(answers(listed(stopped("price-changed", "cancelled")))).toBe(false);
  });

  test("the total is the sum of the members' costs, the engine's one figure: the window adds nothing", () => {
    expect(answers(listed(summary()))).toBe(true);
    expect(answers(listed(summary({ cost: { micros: 1_260_001, kind: "billed" } })))).toBe(false);
    expect(answers(listed(summary({ cost: { micros: 1_260_000, kind: "estimated" } })))).toBe(false);
  });

  test("the total's kind: open if any member's money is open, free at zero, estimated if any member was settled at a figure not proven, else billed", () => {
    const of = (...costs: [number, string][]) => clipBatchCostOf(costs.map(([costMicros, costKind]) => ({ costMicros, costKind: costKind as "free" })));
    expect(of([420_000, "billed"], [0, "free"])).toEqual({ micros: 420_000, kind: "billed" });
    expect(of([0, "free"], [0, "free"])).toEqual({ micros: 0, kind: "free" });
    expect(of([420_000, "billed"], [504_000, "estimated"])).toEqual({ micros: 924_000, kind: "estimated" });
    expect(of([420_000, "billed"], [504_000, "estimated"], [504_000, "open"])).toEqual({ micros: 1_428_000, kind: "open" });
  });

  test("a deleted clip's member keeps its cost: a ready member with a billed cost is a fact of the batch, not of the record", () => {
    // The summary carries no record field: nothing in it can say whether a clip's record still exists.
    expect(Object.keys(ClipBatchSummary.parse(summary()).members[0] ?? {}).sort()).toEqual(["batchIndex", "clipIds", "costKind", "costMicros", "outcome"]);
  });
});
