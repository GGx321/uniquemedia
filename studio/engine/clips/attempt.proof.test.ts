import { afterEach, describe, expect, test } from "bun:test";
import { completed, failed, GROK_BILLED, GROK_RESERVE, KLING_BILLED, KLING_RESERVE, at as indexOf } from "./testing/attemptAsserts";
import { createRig, genFromAfter, GROK, KLING, MINUTE, REFUSED_BY_RISK_CONTROL, SECOND, T0, type JobScript, type Rig, type RigOptions } from "./testing/attemptRig";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5b.1, S5.V3b (plan s5b1 I5.47, §5.7, §9.2a): the free-refusal proof. Probe P-V found that `/generation` answers 404 RIGHT AFTER `completed` on jobs that WERE billed $0.42 and 200 only from +15 s, and that
// `/credits` shows the charge about 38 s after the POST. So one 404 proves nothing: «free» takes two reads (≥ 15 s and ≥ 2 min after the terminal status) and, where the table says so, a clean net-usage check
// (a baseline BEFORE the POST, a second read together with the second `/generation` read, skipped when any other reserve or settle happened between them).

let rig: Rig;
afterEach(async () => rig?.dispose());
async function make(options: RigOptions = {}): Promise<Rig> {
  rig = await createRig(options);
  return rig;
}

const refused: JobScript = { terminal: REFUSED_BY_RISK_CONTROL };
const TERMINAL = T0 + 60 * SECOND;
const grokOk: JobScript = { terminal: { status: "completed", usageCostMicros: GROK_BILLED } };

describe("a 404 proves nothing early", () => {
  test("a 404 right after the terminal status is not counted: no /generation read happens before +15 s, so the record that appears at +15 s is the bill", async () => {
    await make({ mode: "auto", kling: { ...refused, generation: genFromAfter(15 * SECOND, KLING_BILLED) } });
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-paid", cost: "billed" });
    expect(Math.min(...rig.generationReads().map((r) => r.sinceTerminal))).toBeGreaterThanOrEqual(15 * SECOND);
    expect(rig.settles(KLING)).toMatchObject([{ costMicros: KLING_BILLED, estimated: false }]);
  });

  test("one 404 is not enough: the second read waits at least 2 min after the terminal status", async () => {
    await make({ mode: "offer", kling: refused });
    await rig.run();
    const reads = rig.generationReads("kling");
    expect(reads).toHaveLength(2);
    expect(reads[0]?.sinceTerminal).toBeGreaterThanOrEqual(15 * SECOND);
    expect(reads[1]?.sinceTerminal).toBeGreaterThanOrEqual(2 * MINUTE);
  });

  test("a bill that appears between the two reads is caught by the second", async () => {
    await make({ mode: "auto", kling: { ...refused, generation: genFromAfter(100 * SECOND, KLING_BILLED) } });
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-paid" });
    expect(rig.generationReads()).toHaveLength(2);
  });

  test("a /generation record that appears only after the second read is a late bill: the proof stood, and the reconcile will show it", async () => {
    // The guarantee is in the bound, not in the read: Kling settled 0, Grok ≤ accepted, so the clip cannot exceed its accepted worst (see the property test).
    await make({ mode: "auto", kling: { ...refused, generation: genFromAfter(10 * MINUTE, KLING_BILLED) }, grok: grokOk });
    const result = completed(await rig.run());
    expect(result.model).toBe("grok");
    expect(rig.settles(KLING)[0]?.costMicros).toBe(0);
  });
});

describe("the net-usage check", () => {
  /** P0: the charge showed at +38 s after the POST and was refunded by 25 s after the failure. */
  const p0Usage = (t: number, posts: Readonly<Record<"kling" | "grok", number | undefined>>): number => {
    const post = posts.kling;
    return 5_000_000 + (post !== undefined && t >= post + 38 * SECOND && t < TERMINAL + 25 * SECOND ? KLING_BILLED : 0);
  };

  test("P0's sequence (+$0.42, refunded within 25 s) passes: net zero at the second read, so it is free and Grok runs", async () => {
    await make({ mode: "offer", kling: refused, usage: p0Usage });
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-free", cost: "free", grokOffer: true });
    expect(rig.settles(KLING)).toMatchObject([{ costMicros: 0, estimated: false }]);
  });

  test("P0's sequence in mode auto lets Grok run", async () => {
    await make({ mode: "auto", kling: refused, grok: grokOk, usage: p0Usage });
    expect(completed(await rig.run()).model).toBe("grok");
  });

  test("the baseline is read BEFORE the POST: a charge that is already present at the terminal status (and still there at 2 min) is a net increase", async () => {
    await make({ mode: "auto", kling: refused, usage: (t, posts) => 5_000_000 + (posts.kling !== undefined && t >= posts.kling + 38 * SECOND ? KLING_BILLED : 0) });
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-unknown", cost: "worst", unknownWhy: "net-increase" });
    const credits = rig.calls.filter((c) => c.type === "credits");
    expect(credits[0]?.t).toBe(T0);
    expect(indexOf(rig, "credits")).toBeLessThan(indexOf(rig, "post:kling"));
  });

  test("a charge that appears 90 s after the terminal status is caught by the read at 2 min", async () => {
    await make({ mode: "auto", kling: refused, usage: (t) => 5_000_000 + (t >= TERMINAL + 90 * SECOND ? KLING_BILLED : 0) });
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-unknown", cost: "worst", unknownWhy: "net-increase" });
    expect(rig.settles(KLING)).toMatchObject([{ costMicros: KLING_RESERVE, estimated: true }]);
  });

  test("the second /credits read comes with the second /generation read, not with the first", async () => {
    await make({ mode: "auto", kling: refused, grok: grokOk });
    await rig.run();
    const second = rig.generationReads("kling")[1];
    const creditsReads = rig.calls.filter((c) => c.type === "credits");
    expect(creditsReads.some((c) => c.t === second?.t)).toBe(true);
    expect(creditsReads.some((c) => c.t === T0 + 60 * SECOND + 15 * SECOND)).toBe(false);
  });

  test("the baseline is read after the reserve and before the POST", async () => {
    await make({ mode: "auto", kling: refused });
    await rig.run();
    expect(indexOf(rig, "journal:requested")).toBeLessThan(indexOf(rig, `ledger:reserve:${KLING}:ok`));
    expect(indexOf(rig, `ledger:reserve:${KLING}:ok`)).toBeLessThan(indexOf(rig, "credits"));
    expect(indexOf(rig, "credits")).toBeLessThan(indexOf(rig, "post:kling"));
  });

  test("a photo run that settled between the two reads: the check does not count, so mode auto settles the worst too", async () => {
    await make({ mode: "auto", kling: refused, grok: grokOk, usage: (t) => 5_000_000 + (t >= TERMINAL + 30 * SECOND ? 90_000 : 0) });
    rig.at(TERMINAL + 60 * SECOND, () => rig.photoRun("run-0001", 90_000));
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-unknown", unknownWhy: "net-uncounted", cost: "worst" });
    expect(rig.posts("grok")).toHaveLength(0);
  });

  test("an INVISIBLE Kling charge with an uncountable check never leads to Grok (the clip's real spend stays under its accepted worst)", async () => {
    // Kling was billed $0.42 but nothing shows: /generation is 404 and /credits cannot be read. Grok would add $0.71 and the clip would cost $1.13 against $0.85 accepted.
    await make({ mode: "auto", kling: refused, grok: grokOk, usage: () => "throw" });
    await rig.run();
    expect(rig.posts("grok")).toHaveLength(0);
    expect(rig.settles().reduce((sum, s) => sum + s.costMicros, 0)).toBeLessThanOrEqual(GROK_RESERVE);
  });

  test("a poll whose generation_id is not the job id never proves free: worst in both modes, no Grok", async () => {
    for (const mode of ["auto", "offer"] as const) {
      await make({ mode, kling: { ...refused, generationId: "job-someone-else" }, grok: grokOk });
      expect(failed(await rig.run())).toMatchObject({ reason: "refused-unknown", cost: "worst", unknownWhy: "id-mismatch" });
      expect(rig.posts("grok")).toHaveLength(0);
      expect(rig.generationReads()).toHaveLength(0);
      await rig.dispose();
    }
  });

  test("a poll with no generation_id at all cannot be verified, so it never proves free either", async () => {
    await make({ mode: "auto", kling: { ...refused, generationId: null }, grok: grokOk });
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-unknown", unknownWhy: "id-mismatch" });
  });

  test("a completed job without usage whose generation_id is not the job id settles the worst, never another job's record", async () => {
    await make({ kling: { terminal: { status: "completed", usageCostMicros: null }, generationId: "job-someone-else", generation: genFromAfter(15 * SECOND, 100_000) } });
    const result = completed(await rig.run());
    expect(result).toMatchObject({ costSource: "worst", providerCostMicros: null });
    expect(rig.generationReads()).toHaveLength(0);
  });

  test("a completed job WITH usage keeps its usage even when the generation_id differs", async () => {
    await make({ kling: { generationId: "job-someone-else" } });
    expect(completed(await rig.run())).toMatchObject({ costSource: "usage", providerCostMicros: KLING_BILLED });
  });

  test("a photo run that settled between the two reads: the check does not count, so mode offer settles the worst", async () => {
    await make({ mode: "offer", kling: refused, usage: (t) => 5_000_000 + (t >= TERMINAL + 30 * SECOND ? 90_000 : 0) });
    rig.at(TERMINAL + 60 * SECOND, () => rig.photoRun("run-0001", 90_000));
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-unknown", unknownWhy: "net-uncounted", cost: "worst" });
  });

  test("a photo run that only RESERVED between the two reads does not count either", async () => {
    await make({ mode: "offer", kling: refused });
    rig.at(TERMINAL + 60 * SECOND, async () => {
      const reserved = await rig.budget.tryReserve({ attemptId: "run-0001:img#1", jobId: "run-0001", scope: { runId: "run-0001" }, model: "x-ai/grok-imagine-image", worstMicros: 90_000 });
      expect(reserved.ok).toBe(true);
    });
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-unknown", unknownWhy: "net-uncounted" });
  });

  test("a photo run that finished BEFORE the baseline does not spoil the check", async () => {
    await make({ mode: "offer", kling: refused });
    await rig.photoRun("run-0001", 90_000);
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-free", cost: "free" });
  });

  test("a reconcile line between the reads does not count either", async () => {
    await make({ mode: "offer", kling: refused });
    rig.at(TERMINAL + 60 * SECOND, async () => {
      await rig.ledger.append({ type: "reconcile", creditsUsageMicros: 5_000_000, ledgerTotalMicros: 0, aboveWorstAttempts: [], at: new Date(rig.t).toISOString() });
    });
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-unknown", unknownWhy: "net-uncounted" });
  });

  test("a usage that went DOWN is no increase (an account-wide counter can fall)", async () => {
    await make({ mode: "offer", kling: refused, usage: (t) => (t >= TERMINAL ? 4_000_000 : 5_000_000) });
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-free", cost: "free" });
  });

  test("an unreadable /credits at the second read is read three times before the check gives up", async () => {
    await make({ mode: "offer", kling: refused, usage: (t) => (t >= TERMINAL + 100 * SECOND ? "throw" : 5_000_000) });
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-unknown", unknownWhy: "net-uncounted" });
    expect(rig.calls.filter((c) => c.type === "credits")).toHaveLength(1 + 3);
  });
});

describe("the net-usage check counts only while no other money is open (VR item 1)", () => {
  const FOREIGN = "clip-00009#1";
  /** Clip A's temporary charge: on the account before B's baseline, refunded inside B's window, while B's own refusal is billed. */
  const chargeAndRefund = (t: number, posts: Readonly<Record<"kling" | "grok", number | undefined>>): number =>
    5_000_000 + 420_000 + (posts.kling !== undefined && t >= posts.kling + 38 * SECOND ? KLING_BILLED : 0) - (t >= TERMINAL + 30 * SECOND ? 420_000 : 0);
  const openForeignReserve = async (): Promise<void> => {
    const reserved = await rig.budget.tryReserve({ attemptId: "run-0007:img#1", jobId: "run-0007", scope: { runId: "run-0007" }, model: "x-ai/grok-imagine-image", worstMicros: 90_000 });
    if (!reserved.ok) throw new Error(`the foreign reserve was refused: ${reserved.reason}`);
    await rig.budget.abandon(reserved.handle);
  };

  test("another clip's refunded charge inside the window leaves the check uncounted: worst, and no Grok", async () => {
    await make({ mode: "auto", kling: refused, grok: grokOk, usage: chargeAndRefund });
    rig.holds.hold(FOREIGN, T0 + 20 * MINUTE);
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-unknown", cost: "worst", unknownWhy: "net-uncounted" });
    expect(rig.posts("grok")).toHaveLength(0);
    expect(rig.settles(KLING)).toMatchObject([{ costMicros: KLING_RESERVE, estimated: true }]);
  });

  test("a foreign hold at the baseline read leaves the check uncounted, in mode offer too", async () => {
    await make({ mode: "offer", kling: refused });
    rig.holds.hold(FOREIGN, T0 + 20 * MINUTE);
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-unknown", cost: "worst", unknownWhy: "net-uncounted", grokOffer: false });
  });

  test("a foreign hold that expired before the second read still spoils the check: it was there at the baseline", async () => {
    await make({ mode: "offer", kling: refused });
    rig.holds.hold(FOREIGN, T0 + 30 * SECOND);
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-unknown", unknownWhy: "net-uncounted" });
  });

  test("a foreign hold that appears only before the second read spoils the check", async () => {
    await make({ mode: "offer", kling: refused });
    rig.at(TERMINAL + 60 * SECOND, () => rig.holds.hold(FOREIGN, TERMINAL + 10 * MINUTE));
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-unknown", unknownWhy: "net-uncounted" });
  });

  test("a foreign reserve left open at the baseline read leaves the check uncounted", async () => {
    await make({ mode: "offer", kling: refused });
    await openForeignReserve();
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-unknown", cost: "worst", unknownWhy: "net-uncounted" });
  });

  /** A previous attempt of another job, settled in the ledger (exactly, or as an estimate) and still held for the reconcile. */
  const settledAndHeld = async (attemptId: string, bill: { costMicros: number; estimated: boolean }, heldUntil: number): Promise<void> => {
    const jobId = attemptId.split(":")[0] ?? attemptId;
    const reserved = await rig.budget.tryReserve({ attemptId, jobId, scope: { runId: jobId }, model: "x-ai/grok-imagine-image", worstMicros: 500_000 });
    if (!reserved.ok) throw new Error(`the reserve was refused: ${reserved.reason}`);
    await rig.budget.settle(reserved.handle, bill);
    rig.holds.hold(attemptId, heldUntil);
  };

  test("a previous attempt that COMPLETED and was settled exactly, its `terminal + 2 min` hold still live, does not spoil the check: proven free, Grok runs", async () => {
    await make({ mode: "auto", kling: refused, grok: grokOk });
    await settledAndHeld("run-0007:img#1", { costMicros: 90_000, estimated: false }, T0 + 2 * MINUTE);
    rig.holds.markCompleted("run-0007:img#1");
    expect(completed(await rig.run()).model).toBe("grok");
    expect(rig.settles(KLING)).toMatchObject([{ costMicros: 0, estimated: false }]);
  });

  test("a previous REFUSAL settled exactly (billed, refused-paid) with its hold live leaves the check uncounted: its temporary charge could be refunded inside the window", async () => {
    await make({ mode: "auto", kling: refused, grok: grokOk });
    await settledAndHeld("run-0007:img#1", { costMicros: 420_000, estimated: false }, T0 + 2 * MINUTE);
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-unknown", cost: "worst", unknownWhy: "net-uncounted" });
    expect(rig.posts("grok")).toHaveLength(0);
  });

  test("a completed attempt settled as an ESTIMATE is not exempt either, even marked completed", async () => {
    await make({ mode: "offer", kling: refused });
    await settledAndHeld("run-0007:img#1", { costMicros: 90_000, estimated: true }, T0 + 2 * MINUTE);
    rig.holds.markCompleted("run-0007:img#1");
    expect(failed(await rig.run())).toMatchObject({ unknownWhy: "net-uncounted" });
  });

  test("a clip that completes marks its own hold completed; a refusal that was billed does not", async () => {
    await make({ mode: "offer" });
    completed(await rig.run());
    expect(rig.holds.isCompleted(KLING)).toBe(true);
    await rig.dispose();
    await make({ mode: "offer", kling: { ...refused, generation: genFromAfter(15 * SECOND, KLING_BILLED) } });
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-paid" });
    expect(rig.holds.isCompleted(KLING)).toBe(false);
  });

  test("the check is also uncounted when the foreign hold is there BEFORE the baseline read and gone after it (VR LOW 3)", async () => {
    let first = true;
    await make({
      mode: "offer",
      kling: refused,
      usage: () => {
        if (first) {
          first = false;
          rig.holds.release(FOREIGN);
        }
        return 5_000_000;
      },
    });
    rig.holds.hold(FOREIGN, T0 + 20 * MINUTE);
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-unknown", unknownWhy: "net-uncounted" });
  });

  test("a previous attempt settled as an ESTIMATE (an unreadable cost) with its hold live leaves the check uncounted", async () => {
    await make({ mode: "auto", kling: refused, grok: grokOk });
    await settledAndHeld("run-0007:img#1", { costMicros: 90_000, estimated: true }, T0 + 2 * MINUTE);
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-unknown", cost: "worst", unknownWhy: "net-uncounted" });
    expect(rig.posts("grok")).toHaveLength(0);
  });

  test("an abandoned uncertain submit (open at worst) refunding inside the window still leaves the check uncounted", async () => {
    await make({ mode: "auto", kling: refused, grok: grokOk, usage: chargeAndRefund });
    await openForeignReserve();
    rig.holds.hold("run-0007:img#1", T0 + 20 * MINUTE);
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-unknown", unknownWhy: "net-uncounted" });
    expect(rig.posts("grok")).toHaveLength(0);
  });

  test("a foreign reserve that was closed before the baseline and holds nothing does not spoil the check", async () => {
    await make({ mode: "offer", kling: refused });
    await rig.photoRun("run-0007", 90_000);
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-free", cost: "free", grokOffer: true });
  });

  test("the clean case: only this attempt is open and held, and P0's refunded charge is proven free so Grok runs", async () => {
    await make({ mode: "auto", kling: refused, grok: grokOk, usage: (t) => 5_000_000 + (t >= 38 * SECOND + T0 && t < TERMINAL + 25 * SECOND ? KLING_BILLED : 0) });
    expect(completed(await rig.run()).model).toBe("grok");
    expect(rig.settles(KLING)).toMatchObject([{ costMicros: 0, estimated: false }]);
  });
});

describe("Kling's reserve stays open for the whole window", () => {
  test("it is in flight at worst at every /generation read, and Grok is reserved only after Kling settled 0", async () => {
    await make({ mode: "auto", kling: refused, grok: grokOk });
    await rig.run();
    for (const read of rig.generationReads("kling")) expect(read.klingClosed).toBe(false);
    expect(indexOf(rig, `ledger:settle:${KLING}:0:exact`)).toBeLessThan(indexOf(rig, `ledger:reserve:${GROK}:ok`));
    expect(indexOf(rig, "generation:kling@+" + String(rig.generationReads("kling")[1]?.sinceTerminal))).toBeLessThan(indexOf(rig, `ledger:settle:${KLING}:0:exact`));
  });

  test("no Grok reserve exists while the proof is still reading", async () => {
    await make({ mode: "auto", kling: refused, grok: grokOk });
    let reservesAtSecondRead = -1;
    rig.at(TERMINAL + 119 * SECOND, () => void (reservesAtSecondRead = rig.reserves().length));
    await rig.run();
    expect(reservesAtSecondRead).toBe(1);
  });

  test("the cap never refuses Grok's reserve: Kling's freed room is exactly Grok's", async () => {
    await make({ mode: "auto", kling: refused, grok: grokOk });
    await rig.run();
    expect(rig.reserves().map((r) => [r.attemptId, r.worstMicros])).toEqual([
      [KLING, KLING_RESERVE],
      [GROK, GROK_RESERVE],
    ]);
    expect(rig.trace.some((e) => e.includes("RUN_CAP_EXCEEDED"))).toBe(false);
  });
});

describe("the proof on the short set", () => {
  test("«proof 2 min → Grok» runs in milliseconds of fake time, in the same order", async () => {
    const { SHORT_CLIP_TIMINGS } = await import("./timings");
    await make({
      mode: "auto",
      timings: SHORT_CLIP_TIMINGS,
      kling: { ...refused, terminalAfterMs: 60 },
      grok: { ...grokOk, terminalAfterMs: 60 },
    });
    const result = completed(await rig.run());
    expect(result.model).toBe("grok");
    const [first, second] = rig.generationReads("kling");
    expect(first?.sinceTerminal).toBeGreaterThanOrEqual(15);
    expect(second?.sinceTerminal).toBeGreaterThanOrEqual(120);
    expect(rig.t - T0).toBeLessThan(2 * SECOND);
  });
});

describe("the bill is never above the clip's accepted worst", () => {
  test("Kling settled 0 and Grok billed: the clip's money is Grok's bill", async () => {
    await make({ mode: "auto", kling: refused, grok: grokOk });
    await rig.run();
    expect(rig.settles().reduce((sum, s) => sum + s.costMicros, 0)).toBe(GROK_BILLED);
    expect(rig.settles().reduce((sum, s) => sum + s.costMicros, 0)).toBeLessThanOrEqual(GROK_RESERVE);
  });
});
