import { afterEach, describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { runClip, type ClipRunDeps } from "./attempt";
import { expectNoGrok, failed, GROK_BILLED, journalOf } from "./testing/attemptAsserts";
import { createRig, GROK, KLING, MINUTE, REFUSED_BY_RISK_CONTROL, SECOND, T0, type JobScript, type Rig, type RigOptions } from "./testing/attemptRig";
useNativeGlobals();

// 5b.1, S5.V3b round 2 (opus money review): what the first round let through. The reconcile hold has one base, a refused Grok reserve says why, only a failed job with a moderation finish is a
// content refusal, and a clip stopped before its POST leaves nothing open at worst.

let rig: Rig;
afterEach(async () => rig?.dispose());
async function make(options: RigOptions = {}): Promise<Rig> {
  rig = await createRig(options);
  return rig;
}

const refused: JobScript = { terminal: REFUSED_BY_RISK_CONTROL };
const grokOk: JobScript = { terminal: { status: "completed", usageCostMicros: GROK_BILLED } };

describe("the hold of an uncertain submit has one base: the reserve line's `at`, in this process and after a restart", () => {
  test("a baseline that needed two retries delays the POST, and the hold still starts at the reserve", async () => {
    let reads = 0;
    await make({ kling: { submit: { kind: "uncertain", cause: "timeout", httpStatus: null, detail: "no answer" } }, usage: () => (++reads <= 2 ? "throw" : 5_000_000) });
    failed(await rig.run());
    expect(rig.posts("kling")[0]?.t).toBeGreaterThan(T0);
    expect(rig.holds.untilOf(KLING)).toBe(T0 + 20 * MINUTE);
  });
});

describe("a Grok reserve that is refused says why", () => {
  /** The same run, with the budget answering `refusal` to Grok's reserve only. */
  function refusingGrok(refusal: Awaited<ReturnType<ClipRunDeps["budget"]["tryReserve"]>>): ClipRunDeps {
    const budget = rig.deps.budget;
    return { ...rig.deps, budget: { ledger: budget.ledger, settle: budget.settle, abandon: budget.abandon, release: budget.release, tryReserve: (req) => (req.attemptId === GROK ? Promise.resolve(refusal) : budget.tryReserve(req)) } };
  }

  test.each([
    ["RECONCILE_REQUIRED", { ok: false, reason: "RECONCILE_REQUIRED", openAttempts: 1, torn: false }],
    ["HALTED", { ok: false, reason: "HALTED", cause: "LEDGER_WRITE_FAILED", detail: "a ledger write failed" }],
  ] as const)("%s is its own refusal, not «не хватило месячного бюджета»; Kling stays settled 0 and nothing is sent", async (reason, refusal) => {
    await make({ mode: "auto", kling: refused, grok: grokOk });
    const result = await runClip(refusingGrok(refusal), rig.input(), rig.signal);
    expect(result).toMatchObject({ kind: "not-reserved", refusal: { reason }, afterFreeRefusal: true });
    expect(rig.settles(KLING)).toMatchObject([{ costMicros: 0, estimated: false }]);
    expectNoGrok(rig, GROK);
  });

  test.each([
    ["BUDGET_EXCEEDED", { ok: false, reason: "BUDGET_EXCEEDED", limitMicros: 1, committedMicros: 0, worstMicros: 2 }],
    ["RUN_CAP_EXCEEDED", { ok: false, reason: "RUN_CAP_EXCEEDED", limitMicros: 1, committedMicros: 0, worstMicros: 2 }],
  ] as const)("%s is the month or the cap: grok-no-room", async (_reason, refusal) => {
    await make({ mode: "auto", kling: refused, grok: grokOk });
    expect(failed(await runClip(refusingGrok(refusal), rig.input(), rig.signal))).toMatchObject({ reason: "grok-no-room", cost: "free" });
  });

  test("the first attempt's refusal is not marked as following a free Kling", async () => {
    await make({ monthlyBudgetMicros: 100_000 });
    expect(await rig.run()).toMatchObject({ kind: "not-reserved", afterFreeRefusal: false });
  });
});

describe("only a failed job with a moderation finish is a content refusal", () => {
  const moderationFinish = () => ({ kind: "found", totalCostMicros: 0, finishReason: "content_filter" }) as const;

  test.each(["cancelled", "expired"] as const)("a %s job whose /generation says content_filter is a provider error: no automatic Grok", async (status) => {
    await make({ mode: "auto", kling: { terminal: { status, error: null, contentFailure: false }, generation: moderationFinish }, grok: grokOk });
    expect(failed(await rig.run())).toMatchObject({ reason: "provider-error", cost: "free" });
    expectNoGrok(rig, GROK);
  });

  test("a failed job with a non-moderation text and a moderation finish is a content refusal", async () => {
    await make({ mode: "offer", kling: { terminal: { status: "failed", error: "internal error", contentFailure: false }, generation: moderationFinish } });
    expect(failed(await rig.run())).toMatchObject({ reason: "refused-free", grokOffer: true });
  });
});

describe("a clip stopped before its POST leaves nothing at worst", () => {
  test("stopped while the baseline is being read: the reserve is released, nothing is sent, the hold is gone", async () => {
    await make({ usage: () => "throw" });
    rig.at(T0 + 2 * SECOND, () => rig.abort());
    const result = await rig.run();
    expect(result.kind).toBe("cancelled");
    expect(rig.posts()).toHaveLength(0);
    expect(rig.trace).toContain(`ledger:release:${KLING}`);
    expect(rig.trace).not.toContain(`ledger:abandon:${KLING}`);
    expect(rig.ledger.openReserves()).toHaveLength(0);
    expect(rig.holds.untilOf(KLING)).toBeUndefined();
    expect(journalOf(rig)).toEqual(["requested"]);
  });

  test("a signal that fired before the attempt began reserves, writes and sends nothing", async () => {
    await make();
    rig.abort();
    expect((await rig.run()).kind).toBe("cancelled");
    expect(rig.ledger.lines).toHaveLength(0);
    expect(rig.posts()).toHaveLength(0);
    expect(journalOf(rig)).toEqual([]);
  });

  test("a baseline read that is answered but stopped the clip while it ran: nothing is sent, the reserve is released", async () => {
    await make({ usage: () => 5_000_000 });
    const answering = rig.deps.client.fetchCredits;
    rig.deps.client.fetchCredits = async () => {
      rig.abort();
      return answering();
    };
    expect((await rig.run()).kind).toBe("cancelled");
    expect(rig.posts()).toHaveLength(0);
    expect(rig.trace).toContain(`ledger:release:${KLING}`);
    expect(rig.ledger.openReserves()).toHaveLength(0);
    expect(rig.holds.untilOf(KLING)).toBeUndefined();
  });
});
