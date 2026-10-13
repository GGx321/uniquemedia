import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClipCost, ClipSummary } from "../../shared/engine";
import { Ledger, type LedgerLine } from "../money/ledger";
import { clipAttemptId } from "./journal";
import { clipCostOf, clipCostsOf, clipRewriteOf, clipSummaryOf } from "./records";
import type { ClipRecord } from "./schemas";
import { CLIP, exportLine, failedRecord, readyRecord, release, reserve, settle } from "./testing/recordsRig";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.1, S5.V4a2 (plan s5b1 §5.2, §5.3, I5.49, I5.53): the pure parts of the clip records. The cost of a clip is read from the LEDGER, never from the record; the summary is the record as the
// windows see it; and the record is rewritten only for the four reasons I5.53 lists.

const K = clipAttemptId(CLIP, 1);
const G = clipAttemptId(CLIP, 2);

/** The ledger view over lines, without a file: what `jobSpentMicros` needs. */
function ledgerOf(lines: LedgerLine[]): Pick<Ledger, "lines" | "closeOf"> {
  return {
    lines,
    closeOf: (attemptId: string) => {
      for (const line of lines) if ((line.type === "settle" || line.type === "release") && line.attemptId === attemptId) return line;
      return undefined;
    },
  };
}

describe("clipCostOf", () => {
  test("is free and zero when the clip never reserved anything", () => {
    expect(clipCostOf(ledgerOf([]), CLIP)).toEqual({ micros: 0, kind: "free" });
  });

  test("is free when the only reserve was released (nothing left)", () => {
    expect(clipCostOf(ledgerOf([reserve(K, CLIP, 504_000), release(K)]), CLIP)).toEqual({ micros: 0, kind: "free" });
  });

  test("is free when the one attempt settled at 0 after a proven free refusal", () => {
    expect(clipCostOf(ledgerOf([reserve(K, CLIP, 504_000), settle(K, 0, false)]), CLIP)).toEqual({ micros: 0, kind: "free" });
  });

  test("is billed at the settled cost when every attempt settled exact", () => {
    expect(clipCostOf(ledgerOf([reserve(K, CLIP, 504_000), settle(K, 420_000, false)]), CLIP)).toEqual({ micros: 420_000, kind: "billed" });
  });

  test("is estimated at the worst when an attempt settled at worst", () => {
    expect(clipCostOf(ledgerOf([reserve(K, CLIP, 504_000), settle(K, 504_000, true)]), CLIP)).toEqual({ micros: 504_000, kind: "estimated" });
  });

  test("is open at the worst while a reserve waits for the reconcile", () => {
    expect(clipCostOf(ledgerOf([reserve(K, CLIP, 504_000)]), CLIP)).toEqual({ micros: 504_000, kind: "open" });
  });

  test("adds a free Kling and a billed Grok", () => {
    const lines = [reserve(K, CLIP, 504_000), settle(K, 0, false), reserve(G, CLIP, 850_000), settle(G, 640_000, false)];
    expect(clipCostOf(ledgerOf(lines), CLIP)).toEqual({ micros: 640_000, kind: "billed" });
  });

  test("is open when Kling settled free and Grok's reserve is still open", () => {
    const lines = [reserve(K, CLIP, 504_000), settle(K, 0, false), reserve(G, CLIP, 850_000)];
    expect(clipCostOf(ledgerOf(lines), CLIP)).toEqual({ micros: 850_000, kind: "open" });
  });

  test("is open, not estimated, when one attempt settled at worst and another is open", () => {
    const lines = [reserve(K, CLIP, 504_000), settle(K, 504_000, true), reserve(G, CLIP, 850_000)];
    expect(clipCostOf(ledgerOf(lines), CLIP)).toEqual({ micros: 1_354_000, kind: "open" });
  });

  test("is estimated when a billed attempt and a worst-settled one add up", () => {
    const lines = [reserve(K, CLIP, 504_000), settle(K, 100_000, false), reserve(G, CLIP, 850_000), settle(G, 850_000, true)];
    expect(clipCostOf(ledgerOf(lines), CLIP)).toEqual({ micros: 950_000, kind: "estimated" });
  });

  test("is free when the only settle is an estimate of 0", () => {
    expect(clipCostOf(ledgerOf([reserve(K, CLIP, 504_000), settle(K, 0, true)]), CLIP)).toEqual({ micros: 0, kind: "free" });
  });

  test("counts the lines of this clip only", () => {
    const other = "clip-0000002";
    const lines = [reserve(clipAttemptId(other, 1), other, 700_000), settle(clipAttemptId(other, 1), 700_000, false), reserve(K, CLIP, 504_000), settle(K, 420_000, false)];
    expect(clipCostOf(ledgerOf(lines), CLIP)).toEqual({ micros: 420_000, kind: "billed" });
  });

  test("never yields a figure the contract's ClipCost refuses (integer micros)", () => {
    const cases: LedgerLine[][] = [[], [reserve(K, CLIP, 504_000)], [reserve(K, CLIP, 504_000), settle(K, 504_000, true)], [reserve(K, CLIP, 504_000), settle(K, 0, false)], [reserve(K, CLIP, 504_000), settle(K, 1, false)]];
    for (const lines of cases) expect(ClipCost.safeParse(clipCostOf(ledgerOf(lines), CLIP)).success).toBe(true);
  });

  test("reads the real ledger class the same way", async () => {
    const dir = await mkdtemp(join(tmpdir(), "studio-clip-cost-"));
    try {
      const lines = [reserve(K, CLIP, 504_000), settle(K, 504_000, true)];
      await writeFile(join(dir, "ledger.jsonl"), lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
      const ledger = await Ledger.open(join(dir, "ledger.jsonl"));
      expect(clipCostOf(ledger, CLIP)).toEqual({ micros: 504_000, kind: "estimated" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("clipCostsOf (the list's one pass over the ledger)", () => {
  test("gives every clip the cost clipCostOf gives it, reading the ledger's lines once", () => {
    const ids = ["clip-0000001", "clip-0000002", "clip-0000003"];
    const lines: LedgerLine[] = [
      reserve(clipAttemptId(ids[0] ?? "", 1), ids[0] ?? "", 504_000),
      settle(clipAttemptId(ids[0] ?? "", 1), 420_000, false),
      reserve(clipAttemptId(ids[1] ?? "", 1), ids[1] ?? "", 504_000),
    ];
    let reads = 0;
    const base = ledgerOf(lines);
    const counting: Pick<Ledger, "lines" | "closeOf"> = {
      get lines() {
        reads++;
        return base.lines;
      },
      closeOf: base.closeOf,
    };
    const costs = clipCostsOf(counting);
    expect(reads).toBe(1);
    for (const id of ids) expect(costs.get(id) ?? { micros: 0, kind: "free" }).toEqual(clipCostOf(base, id));
  });
});

const free: ClipCost = { micros: 0, kind: "free" };

describe("clipSummaryOf", () => {
  test("shows a ready record as a ready summary the contract accepts", () => {
    const summary = clipSummaryOf(readyRecord(), { micros: 420_000, kind: "billed" });
    expect(ClipSummary.safeParse(summary).success).toBe(true);
    expect(summary).toMatchObject({ clipId: CLIP, avatarId: "avatar-aaaa-0001", photoId: "photo-0001", status: "ready", width: 720, height: 1280, durationMs: 5_040, model: "kling-std", seen: false, recovered: false });
    expect(summary.cost).toEqual({ micros: 420_000, kind: "billed" });
  });

  test("keeps the cost it is given and never reads one from the record", () => {
    const summary = clipSummaryOf(readyRecord(), { micros: 7, kind: "estimated" });
    expect(summary.cost).toEqual({ micros: 7, kind: "estimated" });
  });

  test("shows a failed record with its reason and the retry window", () => {
    const until = "2026-10-13T13:00:00.000Z";
    const summary = clipSummaryOf(failedRecord("download-failed", until), { micros: 420_000, kind: "billed" });
    expect(ClipSummary.safeParse(summary).success).toBe(true);
    expect(summary).toMatchObject({ status: "failed", failure: { reason: "download-failed" }, retryDownloadUntil: until });
    expect("width" in summary).toBe(false);
  });

  test("has no retry window for a failure that cannot be retried", () => {
    const summary = clipSummaryOf(failedRecord("refused-free", undefined), free);
    expect("retryDownloadUntil" in summary).toBe(false);
  });

  test("shows a ready record whose poster may be missing as plain ready (the contract has no hasPoster)", () => {
    const summary = clipSummaryOf(readyRecord(), free);
    expect(summary.status).toBe("ready");
    expect("hasPoster" in summary).toBe(false);
    expect("posterFile" in summary).toBe(false);
  });

  test("says Grok ran as the fallback only when the record holds Grok's second attempt", () => {
    const base = readyRecord();
    const withGrok: ClipRecord = { ...base, provider: { model: "grok", attempts: [{ attemptId: K, outcome: "refused", providerCostMicros: 0, costSource: "proof" }, { attemptId: G, providerJobId: "gen-grok1", outcome: "completed", costSource: "usage" }] } };
    expect(clipSummaryOf(withGrok, free).fallback).toBe(true);
    expect(clipSummaryOf(base, free).fallback).toBe(false);
  });

  test("does not call an owner-chosen Grok clip a fallback", () => {
    const chosen: ClipRecord = { ...readyRecord(), request: { model: "grok", quality: "std", seconds: 5, fallback: "none" }, provider: { model: "grok", attempts: [{ attemptId: K, providerJobId: "gen-grok1", outcome: "completed", costSource: "usage" }] } };
    expect(clipSummaryOf(chosen, free).fallback).toBe(false);
  });

  test("adds the attempts' own figures into providerCostMicros as integers, and omits it when there are none", () => {
    const two: ClipRecord = { ...readyRecord(), provider: { model: "grok", attempts: [{ attemptId: K, outcome: "refused", providerCostMicros: 0, costSource: "proof" }, { attemptId: G, providerJobId: "gen-grok1", outcome: "completed", providerCostMicros: 640_001, costSource: "usage" }] } };
    expect(clipSummaryOf(two, free).providerCostMicros).toBe(640_001);
    const none: ClipRecord = { ...readyRecord(), provider: { model: "kling-std", attempts: [{ attemptId: K, providerJobId: "gen-abc123", outcome: "completed", costSource: "none" }] } };
    expect("providerCostMicros" in clipSummaryOf(none, free)).toBe(false);
  });

  test("shows the exports it is given, and the record's lines by default", () => {
    const record = readyRecord({ exports: [exportLine(1)] });
    expect(clipSummaryOf(record, free).exports).toEqual([exportLine(1)]);
    expect(clipSummaryOf(record, free, [{ ...exportLine(1), fileState: "present" }]).exports).toEqual([{ ...exportLine(1), fileState: "present" }]);
  });

  const offer = { expectedMicros: 710_000, worstMicros: 850_000, prices: "live" as const, pricesAsOf: "2026-10-13" };

  test("puts the Grok offer it is given into a failed clip's failure, as the contract has it", () => {
    const summary = clipSummaryOf(failedRecord("refused-free", undefined), free, undefined, offer);
    expect(ClipSummary.safeParse(summary).success).toBe(true);
    expect(summary).toMatchObject({ status: "failed", failure: { reason: "refused-free", grokOffer: offer } });
  });

  test("has no Grok offer unless it is given one", () => {
    const summary = clipSummaryOf(failedRecord("refused-free", undefined), free);
    expect(summary.status === "failed" ? summary.failure : null).toEqual({ reason: "refused-free" });
  });

  test("never puts a Grok offer on a ready clip", () => {
    const summary = clipSummaryOf(readyRecord(), free, undefined, offer);
    expect(ClipSummary.safeParse(summary).success).toBe(true);
    expect(JSON.stringify(summary)).not.toContain("grokOffer");
  });
});

describe("clipRewriteOf (I5.53: the only four rewrites of a committed record)", () => {
  const until = "2026-10-13T13:00:00.000Z";

  test("allows the seen flag going from false to true", () => {
    expect(clipRewriteOf(readyRecord(), readyRecord({ seen: true }))).toBe("seen");
  });

  test("refuses the seen flag going back to false", () => {
    expect(clipRewriteOf(readyRecord({ seen: true }), readyRecord({ seen: false }))).toBeNull();
  });

  test("allows an appended export", () => {
    expect(clipRewriteOf(readyRecord({ exports: [exportLine(1)] }), readyRecord({ exports: [exportLine(1), exportLine(2)] }))).toBe("export");
  });

  test("refuses an export that is removed, changed or reordered", () => {
    const two = readyRecord({ exports: [exportLine(1), exportLine(2)] });
    expect(clipRewriteOf(two, readyRecord({ exports: [exportLine(1)] }))).toBeNull();
    expect(clipRewriteOf(two, readyRecord({ exports: [exportLine(1), exportLine(2, { bytes: 3 })] }))).toBeNull();
    expect(clipRewriteOf(two, readyRecord({ exports: [exportLine(2), exportLine(1)] }))).toBeNull();
  });

  test("refuses two reasons in one rewrite", () => {
    expect(clipRewriteOf(readyRecord(), readyRecord({ seen: true, exports: [exportLine(1)] }))).toBeNull();
  });

  for (const reason of ["download-failed", "invalid-file", "disk-full"] as const) {
    test(`allows ${reason} becoming ready`, () => {
      expect(clipRewriteOf(failedRecord(reason, until), readyRecord())).toBe("retried");
    });

    test(`allows ${reason} becoming download-expired, without the retry window`, () => {
      expect(clipRewriteOf(failedRecord(reason, until), failedRecord("download-expired", undefined))).toBe("expired");
    });
  }

  test("refuses a failure that is not a download becoming ready", () => {
    for (const reason of ["refused-free", "refused-paid", "lost", "late", "provider-error", "download-expired"] as const) {
      expect(clipRewriteOf(failedRecord(reason, undefined), readyRecord())).toBeNull();
    }
  });

  test("refuses a ready clip becoming failed, and a download failure becoming another failure", () => {
    expect(clipRewriteOf(readyRecord(), failedRecord("download-failed", until))).toBeNull();
    expect(clipRewriteOf(failedRecord("download-failed", until), failedRecord("invalid-file", until))).toBeNull();
    expect(clipRewriteOf(failedRecord("download-failed", until), failedRecord("refused-free", undefined))).toBeNull();
  });

  test("refuses a ready clip whose file facts change", () => {
    const before = readyRecord();
    if (before.outcome.status !== "ready") throw new Error("fixture");
    const { outcome } = before;
    expect(clipRewriteOf(before, { ...before, outcome: { ...outcome, sha256: "c".repeat(64) } })).toBeNull();
    expect(clipRewriteOf(before, { ...before, outcome: { ...outcome, width: 1080, height: 1920 } })).toBeNull();
    expect(clipRewriteOf(before, { ...before, outcome: { ...outcome, face: { verdict: "skipped", frames: 0, why: "worker" } } })).toBeNull();
  });

  test("refuses a change to anything else, even beside an allowed one", () => {
    const before = failedRecord("download-failed", until);
    const after = readyRecord();
    const other: Partial<ClipRecord>[] = [
      { id: "clip-0000009" },
      { avatarId: "avatar-bbbb-0002" },
      { sourcePhotoId: "photo-0002" },
      { createdAt: "2026-10-13T10:00:01.000Z" },
      { motion: { source: "code", label: "x", text: "she smiles" } },
      { request: { model: "kling", quality: "pro", seconds: 5, fallback: "auto" } },
      { recovered: true },
      { provider: { model: "grok", attempts: [] } },
    ];
    for (const change of other) expect(clipRewriteOf(before, { ...after, ...change })).toBeNull();
    expect(clipRewriteOf(readyRecord(), readyRecord({ createdAt: "2026-10-13T10:00:01.000Z", seen: true }))).toBeNull();
    expect(clipRewriteOf(readyRecord(), readyRecord({ motion: { source: "code", label: "x", text: "she smiles" } }))).toBeNull();
  });

  test("answers null for a record that did not change", () => {
    expect(clipRewriteOf(readyRecord(), readyRecord())).toBeNull();
  });
});
