import { afterEach, describe, expect, test } from "bun:test";
import { completed, failed, GROK_BILLED, GROK_RESERVE, KLING_BILLED, KLING_RESERVE, at as indexOf } from "./testing/attemptAsserts";
import { createRig, genFromAfter, GROK, KLING, MINUTE, REFUSED_BY_RISK_CONTROL, SECOND, T0, type JobScript, type Rig, type RigOptions } from "./testing/attemptRig";

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

  test("a photo run that settled between the two reads: the check does not count, so mode auto skips it", async () => {
    await make({ mode: "auto", kling: refused, grok: grokOk, usage: (t) => 5_000_000 + (t >= TERMINAL + 30 * SECOND ? 90_000 : 0) });
    rig.at(TERMINAL + 60 * SECOND, () => rig.photoRun("run-0001", 90_000));
    expect(completed(await rig.run()).model).toBe("grok");
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
