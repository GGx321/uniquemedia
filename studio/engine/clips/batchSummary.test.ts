import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClipBatchSummary, type ClipCost } from "../../shared/engine";
import {
  BATCHES_DIR,
  BatchSummaryStore,
  ClipBatchFile,
  afterRestart,
  applyBatchChange,
  batchSummaryPath,
  clipIdsToLook,
  memberEndOf,
  moneyOpen,
  outcomeOfRecord,
  startBatchFile,
  summaryOf,
  toForget,
  withCosts,
  type MemberLook,
} from "./batchSummary";
import { failedRecord, readyRecord } from "./testing/recordsRig";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.2, S5.WB2c (plan s5b2 I5.62, I5.63): the batch's own summary, written by the engine at every member transition. The pure rules (how a change, the ledger's costs and a restart move a member) and the
// store (one file per batch, written atomically, one change at a time) are pinned here; engine.clipBatch.summary.test.ts pins the engine around them.

const AVATAR = "avatar-aaaa-0001";
const BATCH = "batch-00000001";
const AT = "2026-10-15T10:00:00.000Z";
const LATER = "2026-10-15T10:09:00.000Z";
const clip = (i: number): string => `clip-${String(i).padStart(7, "0")}`;

const fresh = (n = 3): ClipBatchFile => startBatchFile({ batchId: BATCH, avatarId: AVATAR, createdAt: AT, clipIds: Array.from({ length: n }, (_, i) => clip(i + 1)) });
const billed = (micros = 420_000): ClipCost => ({ micros, kind: "billed" });
const costs = (entries: Record<string, ClipCost>): ReadonlyMap<string, ClipCost> => new Map(Object.entries(entries));
const outcomes = (file: ClipBatchFile): string[] => file.members.map((m) => m.outcome);

describe("a batch's summary starts with every member queued, free, under its first clip", () => {
  test("one member per place, in the pick order, nothing ended and nothing stopped", () => {
    const file = fresh(3);
    expect(ClipBatchFile.parse(file)).toEqual(file);
    expect(file).toMatchObject({ schemaVersion: 1, batchId: BATCH, avatarId: AVATAR, size: 3, createdAt: AT });
    expect(file.members).toEqual([1, 2, 3].map((i) => ({ batchIndex: i, outcome: "queued", costMicros: 0, costKind: "free", clipIds: [clip(i)] })));
    expect(file.endedAt).toBeUndefined();
    expect(file.stop).toBeUndefined();
  });

  test("lives at clips/batches/<batchId>.json", () => {
    expect(BATCHES_DIR).toBe("batches");
    expect(batchSummaryPath("/lib/avatars/a/clips", BATCH)).toBe(join("/lib/avatars/a/clips", "batches", `${BATCH}.json`));
  });
});

describe("applyBatchChange: a member moves only from where it stands, and only under its newest clip", () => {
  test("queued → running → ready", () => {
    let file = applyBatchChange(fresh(), { kind: "running", index: 1, clipId: clip(1) });
    expect(outcomes(file)).toEqual(["running", "queued", "queued"]);
    file = applyBatchChange(file, { kind: "ended", index: 1, clipId: clip(1), outcome: "ready" });
    expect(outcomes(file)).toEqual(["ready", "queued", "queued"]);
  });

  test("a 429 requeues the member under a second clip; the first clip's own end does not move it", () => {
    let file = applyBatchChange(fresh(), { kind: "running", index: 2, clipId: clip(2) });
    file = applyBatchChange(file, { kind: "requeued", index: 2, clipId: clip(4) });
    expect(file.members[1]).toMatchObject({ outcome: "queued", clipIds: [clip(2), clip(4)] });
    file = applyBatchChange(file, { kind: "ended", index: 2, clipId: clip(2), outcome: "failed" });
    expect(file.members[1]?.outcome).toBe("queued");
    file = applyBatchChange(applyBatchChange(file, { kind: "running", index: 2, clipId: clip(4) }), { kind: "ended", index: 2, clipId: clip(4), outcome: "ready" });
    expect(file.members[1]).toMatchObject({ outcome: "ready", clipIds: [clip(2), clip(4)] });
  });

  test("a cancelled member keeps why; a member dropped by a stopping engine has no why", () => {
    let file = applyBatchChange(fresh(), { kind: "cancelled", index: 2, clipId: clip(2), detail: "photo-gone" });
    file = applyBatchChange(file, { kind: "dropped", index: 3, clipId: clip(3) });
    expect(file.members[1]).toMatchObject({ outcome: "cancelled", detail: "photo-gone" });
    expect(file.members[2]?.outcome).toBe("dropped");
    expect(file.members[2]?.detail).toBeUndefined();
  });

  test("a made, refused or cancelled member never moves again: a late word about it is ignored", () => {
    let file = applyBatchChange(applyBatchChange(fresh(), { kind: "running", index: 1, clipId: clip(1) }), { kind: "ended", index: 1, clipId: clip(1), outcome: "ready" });
    file = applyBatchChange(file, { kind: "dropped", index: 1, clipId: clip(1) });
    file = applyBatchChange(file, { kind: "cancelled", index: 1, clipId: clip(1), detail: "cancelled" });
    file = applyBatchChange(file, { kind: "ended", index: 1, clipId: clip(1), outcome: "failed" });
    expect(file.members[0]?.outcome).toBe("ready");
    const cancelled = applyBatchChange(fresh(), { kind: "cancelled", index: 3, clipId: clip(3), detail: "price-changed" });
    expect(applyBatchChange(cancelled, { kind: "running", index: 3, clipId: clip(3) }).members[2]?.outcome).toBe("cancelled");
  });

  test("a dropped member whose clip is recorded after all (a recovery after the restart) ends as its record says (round 2)", () => {
    const dropped = applyBatchChange(fresh(1), { kind: "dropped", index: 1, clipId: clip(1) });
    expect(applyBatchChange(dropped, { kind: "ended", index: 1, clipId: clip(1), outcome: "ready" }).members[0]?.outcome).toBe("ready");
  });

  test("a failed member whose clip is made after all (a download fetched again, a recovery) becomes ready", () => {
    let file = applyBatchChange(applyBatchChange(fresh(), { kind: "running", index: 1, clipId: clip(1) }), { kind: "ended", index: 1, clipId: clip(1), outcome: "failed" });
    file = applyBatchChange(file, { kind: "ended", index: 1, clipId: clip(1), outcome: "ready" });
    expect(file.members[0]?.outcome).toBe("ready");
  });

  test("a record of a clip the member does not list yet (its requeue write was lost to a crash) joins the member and ends it (WB2d, L3)", () => {
    // The first clip was 429'd (a free failed end), the crash took the write that told the retry; the retry's recovered record names the batch and the place.
    let file = applyBatchChange(applyBatchChange(fresh(2), { kind: "running", index: 2, clipId: clip(2) }), { kind: "ended", index: 2, clipId: clip(2), outcome: "failed" });
    file = applyBatchChange(file, { kind: "ended", index: 2, clipId: clip(9), outcome: "ready" });
    expect(file.members[1]).toMatchObject({ outcome: "ready", clipIds: [clip(2), clip(9)] });
    const withMoney = withCosts(file, costs({ [clip(2)]: { micros: 0, kind: "free" }, [clip(9)]: billed() }));
    expect(withMoney.members[1]).toMatchObject({ costMicros: 420_000, costKind: "billed" });
  });

  test("the same holds for a member the restart called dropped, and the clip is listed once", () => {
    let file = applyBatchChange(fresh(1), { kind: "dropped", index: 1, clipId: clip(1) });
    file = applyBatchChange(file, { kind: "ended", index: 1, clipId: clip(9), outcome: "failed" });
    file = applyBatchChange(file, { kind: "ended", index: 1, clipId: clip(9), outcome: "ready" });
    expect(file.members[0]).toMatchObject({ outcome: "ready", clipIds: [clip(1), clip(9)] });
  });

  test("a made member does not take a clip it does not list: a made, refused or cancelled member never moves again", () => {
    const made = applyBatchChange(applyBatchChange(fresh(1), { kind: "running", index: 1, clipId: clip(1) }), { kind: "ended", index: 1, clipId: clip(1), outcome: "ready" });
    expect(applyBatchChange(made, { kind: "ended", index: 1, clipId: clip(9), outcome: "failed" }).members[0]).toMatchObject({ outcome: "ready", clipIds: [clip(1)] });
  });

  test("the end of an older clip the member lists is still ignored once a newer one stands (a 429's first clip)", () => {
    const requeued = applyBatchChange(fresh(1), { kind: "requeued", index: 1, clipId: clip(2) });
    expect(applyBatchChange(requeued, { kind: "ended", index: 1, clipId: clip(1), outcome: "failed" }).members[0]).toMatchObject({ outcome: "queued", clipIds: [clip(1), clip(2)] });
  });

  test("a stop is told once, and only when it cancelled a member", () => {
    let file = applyBatchChange(fresh(), { kind: "cancelled", index: 2, clipId: clip(2), detail: "price-changed" });
    file = applyBatchChange(applyBatchChange(file, { kind: "cancelled", index: 3, clipId: clip(3), detail: "price-changed" }), { kind: "stop", detail: "price-changed" });
    expect(file.stop).toBe("price-changed");
    expect(applyBatchChange(file, { kind: "stop", detail: "cancelled" }).stop).toBe("price-changed");
  });

  test("the end of the queue is told once; a member still queued then will never run and is dropped", () => {
    const file = applyBatchChange(fresh(), { kind: "over", at: LATER });
    expect(file.endedAt).toBe(LATER);
    expect(outcomes(file)).toEqual(["dropped", "dropped", "dropped"]);
    expect(applyBatchChange(file, { kind: "over", at: "2026-10-15T11:00:00.000Z" }).endedAt).toBe(LATER);
  });

  test("a change for a place the batch does not have changes nothing", () => {
    expect(applyBatchChange(fresh(), { kind: "running", index: 9, clipId: clip(9) })).toEqual(fresh());
  });
});

describe("the money of a member is the ledger's, for its clip ids", () => {
  test("a clip that reserved nothing is free; a billed clip is its bill", () => {
    const file = withCosts(fresh(2), costs({ [clip(1)]: billed() }));
    expect(file.members.map((m) => [m.costMicros, m.costKind])).toEqual([
      [420_000, "billed"],
      [0, "free"],
    ]);
  });

  test("a requeued member adds its two clips: the 429'd one free, the second billed", () => {
    const file = withCosts(applyBatchChange(fresh(2), { kind: "requeued", index: 2, clipId: clip(3) }), costs({ [clip(2)]: { micros: 0, kind: "free" }, [clip(3)]: billed() }));
    expect(file.members[1]).toMatchObject({ costMicros: 420_000, costKind: "billed" });
  });

  test("open wins over everything; estimated over billed", () => {
    const requeued = applyBatchChange(fresh(1), { kind: "requeued", index: 1, clipId: clip(2) });
    expect(withCosts(requeued, costs({ [clip(1)]: { micros: 504_000, kind: "estimated" }, [clip(2)]: billed() })).members[0]).toMatchObject({ costMicros: 924_000, costKind: "estimated" });
    expect(withCosts(requeued, costs({ [clip(1)]: { micros: 504_000, kind: "open" }, [clip(2)]: billed() })).members[0]).toMatchObject({ costMicros: 924_000, costKind: "open" });
  });

  test("the summary on the wire: each member's cost from the ledger now, and the batch's one total", () => {
    let file = fresh(3);
    for (const i of [1, 2, 3]) file = applyBatchChange(applyBatchChange(file, { kind: "running", index: i, clipId: clip(i) }), { kind: "ended", index: i, clipId: clip(i), outcome: "ready" });
    file = applyBatchChange(file, { kind: "over", at: LATER });
    const summary = summaryOf(file, costs({ [clip(1)]: billed(), [clip(2)]: billed(), [clip(3)]: billed() }));
    expect(ClipBatchSummary.parse(summary)).toEqual(summary);
    expect(summary.cost).toEqual({ micros: 1_260_000, kind: "billed" });
    expect(summary).not.toHaveProperty("schemaVersion");
  });

  test("a figure the file kept that the ledger has since moved (an open reserve the reconcile settled) is the ledger's", () => {
    const file = withCosts(applyBatchChange(fresh(1), { kind: "running", index: 1, clipId: clip(1) }), costs({ [clip(1)]: { micros: 504_000, kind: "open" } }));
    expect(file.members[0]?.costKind).toBe("open");
    expect(summaryOf(file, costs({ [clip(1)]: { micros: 504_000, kind: "estimated" } })).members[0]).toMatchObject({ costMicros: 504_000, costKind: "estimated" });
  });
});

describe("outcomeOfRecord", () => {
  test("a ready record is ready", () => {
    expect(outcomeOfRecord(readyRecord())).toBe("ready");
  });

  test("a content refusal (and Grok with no room behind a free one) is refused", () => {
    for (const reason of ["refused-free", "refused-both", "refused-paid", "refused-unknown", "grok-no-room"] as const) expect(outcomeOfRecord(failedRecord(reason, undefined))).toBe("refused");
  });

  test("every other end is failed", () => {
    for (const reason of ["provider-error", "bad-request", "submit-uncertain", "late", "lost", "download-failed", "invalid-file", "disk-full", "no-credits", "key-invalid", "rate-limited", "download-expired"] as const) {
      expect(outcomeOfRecord(failedRecord(reason, undefined))).toBe("failed");
    }
  });
});

describe("memberEndOf: how a member's clip job ended, for its summary", () => {
  test("as its record says; failed with no record; the owner's cancel before its POST", () => {
    expect(memberEndOf({ kind: "recorded", record: readyRecord() }, false)).toEqual({ kind: "ended", outcome: "ready" });
    expect(memberEndOf({ kind: "recorded", record: failedRecord("refused-free", undefined) }, false)).toEqual({ kind: "ended", outcome: "refused" });
    expect(memberEndOf({ kind: "refused", error: { code: "BUDGET_EXCEEDED" } }, false)).toEqual({ kind: "ended", outcome: "failed" });
    expect(memberEndOf({ kind: "cancelled" }, false)).toEqual({ kind: "cancelled", detail: "cancelled" });
  });

  test("a stop of the engine tells nothing, even in `preparing` where the job ends `cancelled` (round 2): the restart decides, and nobody cancelled it", () => {
    expect(memberEndOf({ kind: "cancelled" }, true)).toBeNull();
    expect(memberEndOf({ kind: "interrupted" }, false)).toBeNull();
    expect(memberEndOf({ kind: "interrupted" }, true)).toBeNull();
  });
});

describe("afterRestart: no batch resumes after a restart (I5.63)", () => {
  const look = (entries: Record<string, MemberLook>): ReadonlyMap<string, MemberLook> => new Map(Object.entries(entries));
  const midBatch = (): ClipBatchFile => applyBatchChange(fresh(3), { kind: "running", index: 1, clipId: clip(1) });

  test("the queued members whose clips left nothing anywhere are dropped, and the queue is over", () => {
    const file = afterRestart(midBatch(), look({ [clip(1)]: { kind: "journal" }, [clip(2)]: { kind: "nothing" } }), LATER);
    expect(outcomes(file)).toEqual(["running", "dropped", "dropped"]);
    expect(file.endedAt).toBe(LATER);
  });

  describe("a member with two clips (a 429's retry) is judged by its NEWEST clip, never its first", () => {
    // clip(1) was 429'd (free), clip(9) is the retry; the other clip's look is a decoy that would give a different answer.
    const requeued = (): ClipBatchFile => applyBatchChange(fresh(1), { kind: "requeued", index: 1, clipId: clip(9) });
    const decoy = { kind: "record", outcome: "refused" } as const;
    const judged = (newest: MemberLook): string | undefined => afterRestart(requeued(), look({ [clip(1)]: decoy, [clip(9)]: newest }), LATER).members[0]?.outcome;

    test("only the newest is looked up", () => {
      expect(clipIdsToLook(requeued())).toEqual([clip(9)]);
    });

    test("only the newest has a journal: running", () => expect(judged({ kind: "journal" })).toBe("running"));
    test("only the newest has a record: its outcome", () => expect(judged({ kind: "record", outcome: "ready" })).toBe("ready"));
    test("only the newest has a reserve: failed", () => expect(judged({ kind: "reserved" })).toBe("failed"));
    test("nothing for the newest, the first was the free 429: dropped", () => expect(judged({ kind: "nothing" })).toBe("dropped"));
  });

  test("a member the summary still had queued is looked at like one at work (round 2: its turn's write can be lost after its POST left)", () => {
    expect(clipIdsToLook(midBatch())).toEqual([clip(1), clip(2), clip(3)]);
    const queued = fresh(1);
    expect(afterRestart(queued, look({ [clip(1)]: { kind: "journal" } }), LATER).members[0]?.outcome).toBe("running");
    expect(afterRestart(queued, look({ [clip(1)]: { kind: "record", outcome: "ready" } }), LATER).members[0]?.outcome).toBe("ready");
    expect(afterRestart(queued, look({ [clip(1)]: { kind: "reserved" } }), LATER).members[0]?.outcome).toBe("failed");
    expect(afterRestart(queued, look({ [clip(1)]: { kind: "nothing" } }), LATER).members[0]?.outcome).toBe("dropped");
  });

  test("the member that was sent and has a journal stays at work: its recovery will tell its end", () => {
    expect(afterRestart(midBatch(), look({ [clip(1)]: { kind: "journal" } }), LATER).members[0]?.outcome).toBe("running");
  });

  test("a member whose record stands ends as its record says (the process stopped before the summary heard of it)", () => {
    expect(afterRestart(midBatch(), look({ [clip(1)]: { kind: "record", outcome: "ready" } }), LATER).members[0]?.outcome).toBe("ready");
    expect(afterRestart(midBatch(), look({ [clip(1)]: { kind: "record", outcome: "refused" } }), LATER).members[0]?.outcome).toBe("refused");
  });

  test("a member with neither, whose clip moved money, failed; one whose clip moved none was dropped", () => {
    expect(afterRestart(midBatch(), look({ [clip(1)]: { kind: "reserved" } }), LATER).members[0]?.outcome).toBe("failed");
    expect(afterRestart(midBatch(), look({ [clip(1)]: { kind: "nothing" } }), LATER).members[0]?.outcome).toBe("dropped");
  });

  test("a batch that ended before the restart keeps its end and every member", () => {
    const over = applyBatchChange(applyBatchChange(applyBatchChange(fresh(1), { kind: "running", index: 1, clipId: clip(1) }), { kind: "ended", index: 1, clipId: clip(1), outcome: "ready" }), { kind: "over", at: AT });
    expect(afterRestart(over, look({}), LATER)).toEqual(over);
  });
});

describe("toForget: the newest 20 of an avatar are kept, and any whose money is open or whose queue has not ended", () => {
  const nth = (i: number, ended = true): ClipBatchFile => {
    const file = startBatchFile({ batchId: `batch-${String(i).padStart(8, "0")}`, avatarId: AVATAR, createdAt: new Date(Date.parse(AT) + i * 60_000).toISOString(), clipIds: [clip(i)] });
    return ended ? applyBatchChange(file, { kind: "over", at: LATER }) : file;
  };

  test("twenty-one ended batches with their money closed: the oldest goes", () => {
    const files = Array.from({ length: 21 }, (_, i) => nth(i + 1));
    expect(toForget(files, () => false)).toEqual([nth(1).batchId]);
  });

  test("twenty or fewer: nothing goes", () => {
    expect(toForget(Array.from({ length: 20 }, (_, i) => nth(i + 1)), () => false)).toEqual([]);
  });

  test("a batch's money is open when any member's clip has a reserve the ledger still holds open, whatever the file kept", () => {
    const file = applyBatchChange(fresh(2), { kind: "requeued", index: 2, clipId: clip(3) });
    expect(moneyOpen(file, costs({ [clip(1)]: billed(), [clip(3)]: { micros: 504_000, kind: "open" } }))).toBe(true);
    expect(moneyOpen(withCosts(file, costs({ [clip(1)]: { micros: 504_000, kind: "open" } })), costs({ [clip(1)]: { micros: 504_000, kind: "estimated" } }))).toBe(false);
    expect(moneyOpen(file, costs({}))).toBe(false);
  });

  test("an old batch whose money is still open, or whose queue has not ended, is kept", () => {
    const files = [nth(1), nth(2, false), ...Array.from({ length: 20 }, (_, i) => nth(i + 3))];
    expect(toForget(files, (file) => file.batchId === nth(1).batchId)).toEqual([]);
    expect(toForget(files, () => false)).toEqual([nth(1).batchId]);
  });
});

describe("BatchSummaryStore", () => {
  async function folder(): Promise<{ clipsDir: string; done: () => Promise<void> }> {
    const root = await mkdtemp(join(tmpdir(), "studio-batch-summary-"));
    return { clipsDir: join(root, "clips"), done: () => rm(root, { recursive: true, force: true }) };
  }
  const logs: string[] = [];
  const store = (): BatchSummaryStore => new BatchSummaryStore({ log: (line) => void logs.push(line) });

  test("writes a batch's file under clips/batches, strict and atomic, making the folders it needs", async () => {
    const { clipsDir, done } = await folder();
    try {
      const summaries = store();
      await summaries.change(clipsDir, BATCH, () => fresh(2));
      const written = JSON.parse(await readFile(batchSummaryPath(clipsDir, BATCH), "utf8"));
      expect(ClipBatchFile.parse(written)).toEqual(fresh(2));
      expect(await readdir(join(clipsDir, BATCHES_DIR))).toEqual([`${BATCH}.json`]);
    } finally {
      await done();
    }
  });

  test("a write that fails loses no transition (round 2, money): the next change builds on the state the store meant to write, and writes it whole", async () => {
    const { clipsDir, done } = await folder();
    try {
      let failNext = false;
      const summaries = new BatchSummaryStore({
        log: (line) => void logs.push(line),
        beforeWrite: () => {
          if (!failNext) return;
          failNext = false;
          throw Object.assign(new Error("i/o error"), { code: "EIO" });
        },
      });
      // Clip 2 met a 429 (its attempt closed at 0); clip 3 is its retry, shot and billed.
      const priced = costs({ [clip(1)]: billed(), [clip(2)]: { micros: 0, kind: "free" }, [clip(3)]: billed() });
      const step = (change: Parameters<typeof applyBatchChange>[1]): Promise<void> =>
        summaries.change(clipsDir, BATCH, (current) => (current === null ? null : withCosts(applyBatchChange(current, change), priced)));
      await summaries.change(clipsDir, BATCH, () => fresh(2));
      await step({ kind: "running", index: 1, clipId: clip(1) });
      await step({ kind: "ended", index: 1, clipId: clip(1), outcome: "ready" });
      await step({ kind: "running", index: 2, clipId: clip(2) });
      failNext = true;
      await step({ kind: "requeued", index: 2, clipId: clip(3) });
      await step({ kind: "ended", index: 2, clipId: clip(2), outcome: "failed" });
      await step({ kind: "running", index: 2, clipId: clip(3) });
      await step({ kind: "ended", index: 2, clipId: clip(3), outcome: "ready" });
      await step({ kind: "over", at: LATER });

      const onDisk = ClipBatchFile.parse(JSON.parse(await readFile(batchSummaryPath(clipsDir, BATCH), "utf8")));
      expect(onDisk.members[1]).toEqual({ batchIndex: 2, outcome: "ready", costMicros: 420_000, costKind: "billed", clipIds: [clip(2), clip(3)] });
      expect(summaryOf(onDisk, priced).cost).toEqual({ micros: 840_000, kind: "billed" });
      expect(logs.some((line) => line.includes(BATCH) && line.includes("could not be written"))).toBe(true);
    } finally {
      await done();
    }
  });

  test("while the disk lags behind a failed write, a read is the state the store meant to write", async () => {
    const { clipsDir, done } = await folder();
    try {
      let fail = false;
      const summaries = new BatchSummaryStore({
        log: () => undefined,
        beforeWrite: () => {
          if (fail) throw Object.assign(new Error("no space"), { code: "ENOSPC" });
        },
      });
      await summaries.change(clipsDir, BATCH, () => fresh(1));
      fail = true;
      await summaries.change(clipsDir, BATCH, (current) => (current === null ? null : applyBatchChange(current, { kind: "running", index: 1, clipId: clip(1) })));
      expect(outcomes((await summaries.read(clipsDir))[0] ?? fresh())).toEqual(["running"]);
      const other = "batch-00000002";
      await summaries.change(clipsDir, other, () => startBatchFile({ batchId: other, avatarId: AVATAR, createdAt: AT, clipIds: [clip(9)] }));
      expect((await summaries.read(clipsDir)).map((file) => file.batchId).sort()).toEqual([BATCH, other]);
    } finally {
      await done();
    }
  });

  test("never brings back the folder of an avatar that is gone (round 2): the write fails, is logged, and creates nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "studio-batch-summary-"));
    try {
      const gone = join(root, "avatar-gone", "clips");
      await store().change(gone, BATCH, () => fresh(1));
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("changes of one batch run one after another, each on the file the one before it wrote", async () => {
    const { clipsDir, done } = await folder();
    try {
      const summaries = store();
      void summaries.change(clipsDir, BATCH, () => fresh(3));
      for (const i of [1, 2, 3]) void summaries.change(clipsDir, BATCH, (current) => (current === null ? null : applyBatchChange(current, { kind: "running", index: i, clipId: clip(i) })));
      await summaries.settled();
      expect(outcomes((await summaries.read(clipsDir))[0] ?? fresh())).toEqual(["running", "running", "running"]);
    } finally {
      await done();
    }
  });

  test("a change that would break the schema writes nothing and is logged; the file stays as it was", async () => {
    const { clipsDir, done } = await folder();
    try {
      const summaries = store();
      await summaries.change(clipsDir, BATCH, () => fresh(1));
      await summaries.change(clipsDir, BATCH, (current) => (current === null ? null : { ...current, size: 2 }));
      expect(await summaries.read(clipsDir)).toEqual([fresh(1)]);
      expect(logs.some((line) => line.includes(BATCH))).toBe(true);
    } finally {
      await done();
    }
  });

  test("reads every valid summary of the folder and leaves out a damaged one, a temp file and a name that is not a batch id", async () => {
    const { clipsDir, done } = await folder();
    try {
      const summaries = store();
      await summaries.change(clipsDir, BATCH, () => fresh(1));
      await writeFile(join(clipsDir, BATCHES_DIR, "batch-00000002.json"), "{ not json");
      await writeFile(join(clipsDir, BATCHES_DIR, ".batch-00000003.json.1.tmp"), JSON.stringify(fresh(1)));
      await writeFile(join(clipsDir, BATCHES_DIR, "NOT A BATCH.json"), JSON.stringify(fresh(1)));
      await mkdir(join(clipsDir, BATCHES_DIR, "batch-00000004.json"));
      expect(await summaries.read(clipsDir)).toEqual([fresh(1)]);
    } finally {
      await done();
    }
  });

  test("an avatar with no batches folder has no summaries", async () => {
    const { clipsDir, done } = await folder();
    try {
      expect(await store().read(clipsDir)).toEqual([]);
    } finally {
      await done();
    }
  });

  test("forgets a batch: its file goes", async () => {
    const { clipsDir, done } = await folder();
    try {
      const summaries = store();
      await summaries.change(clipsDir, BATCH, () => fresh(1));
      await summaries.forget(clipsDir, BATCH);
      expect(await summaries.read(clipsDir)).toEqual([]);
    } finally {
      await done();
    }
  });

  test("settled() waits for a tracked piece of work too (the restart's pass over the summaries)", async () => {
    const summaries = store();
    let finished = false;
    summaries.track(new Promise<void>((resolve) => setTimeout(() => ((finished = true), resolve()), 20)));
    await summaries.settled();
    expect(finished).toBe(true);
  });
});

describe("BatchSummaryStore on Windows (CI 38713903237): a rename refused while another handle holds the file", () => {
  async function folder(): Promise<{ clipsDir: string; done: () => Promise<void> }> {
    const root = await mkdtemp(join(tmpdir(), "studio-batch-summary-win-"));
    return { clipsDir: join(root, "clips"), done: () => rm(root, { recursive: true, force: true }) };
  }
  const eperm = (): Error => Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
  /** Windows' rename of the shared atomic write: refused with EPERM `refusals` times (or while `blocked`), then the real rename; no real sleep. */
  function windows(state: { refusals: number; blocked: boolean }) {
    return {
      platform: "win32",
      sleep: async () => undefined,
      rename: async (from: string, to: string) => {
        if (state.blocked || state.refusals > 0) {
          state.refusals--;
          throw eperm();
        }
        await rename(from, to);
      },
    };
  }
  const tempsIn = async (clipsDir: string): Promise<string[]> => (await readdir(join(clipsDir, BATCHES_DIR))).filter((name) => name.endsWith(".tmp"));

  test("a rename refused a few times is retried by the shared atomic write and lands: the file is whole and no temp file is left", async () => {
    const { clipsDir, done } = await folder();
    try {
      const logs: string[] = [];
      const state = { refusals: 0, blocked: false };
      const summaries = new BatchSummaryStore({ log: (line) => void logs.push(line), retry: windows(state) });
      await summaries.change(clipsDir, BATCH, () => fresh(2));
      state.refusals = 3;
      await summaries.change(clipsDir, BATCH, (current) => (current === null ? null : applyBatchChange(current, { kind: "running", index: 1, clipId: clip(1) })));

      const onDisk = ClipBatchFile.parse(JSON.parse(await readFile(batchSummaryPath(clipsDir, BATCH), "utf8")));
      expect(outcomes(onDisk)).toEqual(["running", "queued"]);
      expect(await readdir(join(clipsDir, BATCHES_DIR))).toEqual([`${BATCH}.json`]);
      expect(logs).toEqual([]);
    } finally {
      await done();
    }
  });

  test("a rename refused for good fails the write once: its temp file is removed, the state it meant is kept, and the next write lands it whole", async () => {
    const { clipsDir, done } = await folder();
    try {
      const logs: string[] = [];
      const state = { refusals: 0, blocked: false };
      const summaries = new BatchSummaryStore({ log: (line) => void logs.push(line), retry: windows(state) });
      await summaries.change(clipsDir, BATCH, () => fresh(2));
      state.blocked = true;
      await summaries.change(clipsDir, BATCH, (current) => (current === null ? null : applyBatchChange(current, { kind: "running", index: 1, clipId: clip(1) })));

      expect(await tempsIn(clipsDir)).toEqual([]);
      expect(logs.filter((line) => line.includes(BATCH))).toHaveLength(1);
      expect(outcomes((await summaries.read(clipsDir))[0] ?? fresh())).toEqual(["running", "queued"]);
      expect(outcomes(ClipBatchFile.parse(JSON.parse(await readFile(batchSummaryPath(clipsDir, BATCH), "utf8"))))).toEqual(["queued", "queued"]);

      state.blocked = false;
      state.refusals = 0;
      await summaries.change(clipsDir, BATCH, (current) => (current === null ? null : applyBatchChange(current, { kind: "ended", index: 1, clipId: clip(1), outcome: "ready" })));
      expect(outcomes(ClipBatchFile.parse(JSON.parse(await readFile(batchSummaryPath(clipsDir, BATCH), "utf8"))))).toEqual(["ready", "queued"]);
      expect(await readdir(join(clipsDir, BATCHES_DIR))).toEqual([`${BATCH}.json`]);
    } finally {
      await done();
    }
  });

  test("a temp file a crash left beside the summaries is swept, and a batch forgotten takes its temp files with it; a summary is never touched", async () => {
    const { clipsDir, done } = await folder();
    try {
      const summaries = new BatchSummaryStore({ log: () => undefined });
      const other = "batch-00000002";
      await summaries.change(clipsDir, BATCH, () => fresh(1));
      await summaries.change(clipsDir, other, () => startBatchFile({ batchId: other, avatarId: AVATAR, createdAt: AT, clipIds: [clip(9)] }));
      await writeFile(join(clipsDir, BATCHES_DIR, `.${BATCH}.json.4161ce0f2144.tmp`), "{");
      await writeFile(join(clipsDir, BATCHES_DIR, `.${other}.json.0123456789ab.tmp`), "{");

      await summaries.sweepTemps(clipsDir);
      expect((await readdir(join(clipsDir, BATCHES_DIR))).sort()).toEqual([`${BATCH}.json`, `${other}.json`]);

      await writeFile(join(clipsDir, BATCHES_DIR, `.${other}.json.ba9876543210.tmp`), "{");
      await summaries.forget(clipsDir, other);
      expect(await readdir(join(clipsDir, BATCHES_DIR))).toEqual([`${BATCH}.json`]);
    } finally {
      await done();
    }
  });
});
