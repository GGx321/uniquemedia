import { afterEach, describe, expect, test } from "bun:test";
import type { ClipPrices } from "../../shared/engine/clips";
import { MoneyError } from "../money/errors";
import { runClip, settleOnce, type AttemptPlan } from "./attempt";
import { at as indexOf, completed, expectNoGrok, failed, GROK_BILLED, GROK_RESERVE, journalOf, KLING_BILLED, KLING_RESERVE, late } from "./testing/attemptAsserts";
import { CLIP_ID, createRig, genFromAfter, GROK, iso, KLING, MINUTE, PRICES, REFUSED_BY_RISK_CONTROL, SECOND, T0, type JobScript, type Rig, type RigOptions } from "./testing/attemptRig";

// 5b.1, S5.V3b (plan s5b1 I5.44-I5.46, I5.48, §8 V3b): what the settle table does not say by itself. The order of the journal and the ledger against the POST, a refused reserve, an attempt id that is never
// sent twice, a settle above the reserve, an interrupted attempt, one price book per clip, the month taking Grok's room, the holds an attempt leaves behind, and the phases the job shows.

let rig: Rig;
afterEach(async () => rig?.dispose());
async function make(options: RigOptions = {}): Promise<Rig> {
  rig = await createRig(options);
  return rig;
}

const refused: JobScript = { terminal: REFUSED_BY_RISK_CONTROL };
const grokOk: JobScript = { terminal: { status: "completed", usageCostMicros: GROK_BILLED } };
const TERMINAL = T0 + 60 * SECOND;

describe("the journal before anything (I5.45)", () => {
  test("`requested` is written before the reserve, the reserve before the POST, and `submitted` before the first poll", async () => {
    await make();
    await rig.run();
    expect(indexOf(rig, "journal:requested")).toBeLessThan(indexOf(rig, `ledger:reserve:${KLING}:ok`));
    expect(indexOf(rig, `ledger:reserve:${KLING}:ok`)).toBeLessThan(indexOf(rig, "post:kling"));
    expect(indexOf(rig, "post:kling")).toBeLessThan(indexOf(rig, `journal:submitted:${KLING}`));
    expect(indexOf(rig, `journal:submitted:${KLING}`)).toBeLessThan(indexOf(rig, "poll:kling"));
  });

  test("`requested` carries the photo, the request, the motion and the worst the owner accepted", async () => {
    await make({ mode: "auto" });
    await rig.run();
    expect(rig.journalLines[0]).toMatchObject({
      type: "requested",
      clipId: CLIP_ID,
      photoId: "photo-00001",
      request: { model: "kling", quality: "std", seconds: 5, fallback: "auto" },
      motion: { source: "code", label: "Улыбка" },
      acceptedWorstMicros: GROK_RESERVE,
    });
  });

  test("`requested` is written once for a clip with two attempts", async () => {
    await make({ mode: "auto", kling: refused, grok: grokOk });
    await rig.run();
    expect(rig.journalLines.filter((l) => l.type === "requested")).toHaveLength(1);
  });

  test("`submitted` names the provider's job id and the attempt's model", async () => {
    await make();
    await rig.run();
    expect(rig.journalLines.find((l) => l.type === "submitted")).toMatchObject({ attemptId: KLING, model: "kling", providerJobId: "job-kling", at: iso(T0) });
  });
});

describe("a reserve that is refused sends nothing and records free (I5.44)", () => {
  test("the month: nothing is sent, nothing is written to the ledger, the journal holds `requested` only", async () => {
    await make({ monthlyBudgetMicros: 100_000 });
    const result = await rig.run();
    expect(result).toMatchObject({ kind: "not-reserved", refusal: { ok: false, reason: "BUDGET_EXCEEDED" } });
    expect(rig.posts()).toHaveLength(0);
    expect(rig.ledger.lines).toHaveLength(0);
    expect(journalOf(rig)).toEqual(["requested"]);
    expect(rig.holds.entries().size).toBe(0);
    expect(rig.calls.filter((c) => c.type === "credits")).toHaveLength(0);
  });

  test("the clip's cap: nothing is sent", async () => {
    await make();
    const result = await rig.run({ acceptedWorstMicros: 100_000 });
    expect(result).toMatchObject({ kind: "not-reserved", refusal: { reason: "RUN_CAP_EXCEEDED" } });
    expect(rig.posts()).toHaveLength(0);
    expect(rig.ledger.lines).toHaveLength(0);
  });

  test("an open reserve of an earlier process (RECONCILE_REQUIRED): nothing is sent", async () => {
    await make({
      ledgerLines: [{ type: "reserve", attemptId: "run-9:img#1", jobId: "run-9", scope: { runId: "run-9" }, model: "x-ai/grok-imagine-image", worstMicros: 1_000, at: iso(T0 - 5 * MINUTE) }],
    });
    const result = await rig.run();
    expect(result).toMatchObject({ kind: "not-reserved", refusal: { reason: "RECONCILE_REQUIRED" } });
    expect(rig.posts()).toHaveLength(0);
    expect(rig.ledger.lines).toHaveLength(1);
  });
});

describe("an attempt id is never sent twice (I5.44)", () => {
  test("running the same clip again is refused by the ledger before any request leaves", async () => {
    await make();
    completed(await rig.run());
    await expect(rig.run()).rejects.toMatchObject({ name: "MoneyError", code: "ATTEMPT_ID_REUSED" });
    expect(rig.posts()).toHaveLength(1);
    expect(rig.settles()).toHaveLength(1);
  });

  test("a clip that was abandoned as uncertain cannot be run again either: the reserve is still its own", async () => {
    await make({ kling: { submit: { kind: "uncertain", cause: "timeout", httpStatus: null, detail: "no answer" } } });
    failed(await rig.run());
    await expect(rig.run()).rejects.toMatchObject({ code: "ATTEMPT_ID_REUSED" });
    expect(rig.posts()).toHaveLength(1);
  });

  test("settling an attempt twice moves money once", async () => {
    await make();
    rig.input(); // sets the clip's cap
    const reserved = await rig.budget.tryReserve({ attemptId: KLING, jobId: CLIP_ID, scope: { avatarJobId: CLIP_ID }, model: "kwaivgi/kling-v3.0-std", worstMicros: KLING_RESERVE });
    if (!reserved.ok) throw new Error("the reserve was refused");
    expect(await settleOnce(rig.budget, reserved.handle, { costMicros: 420_000, estimated: false })).toBeNull();
    expect(await settleOnce(rig.budget, reserved.handle, { costMicros: 420_000, estimated: false })).toBeNull();
    expect(rig.settles()).toHaveLength(1);
  });

  test("a settle above the reserve is recorded once and handed back, not thrown", async () => {
    await make();
    rig.input(); // sets the clip's cap
    const reserved = await rig.budget.tryReserve({ attemptId: KLING, jobId: CLIP_ID, scope: { avatarJobId: CLIP_ID }, model: "kwaivgi/kling-v3.0-std", worstMicros: 100_000 });
    if (!reserved.ok) throw new Error("the reserve was refused");
    const halt = await settleOnce(rig.budget, reserved.handle, { costMicros: 120_000, estimated: false });
    expect(halt).toBeInstanceOf(MoneyError);
    expect(halt?.code).toBe("SETTLE_ABOVE_WORST");
    expect(await settleOnce(rig.budget, reserved.handle, { costMicros: 120_000, estimated: false })).toBeNull();
    expect(rig.settles()).toHaveLength(1);
  });
});

describe("what a clip is billed against its reserve", () => {
  test("a billed second on a 5 s request settles within the reserve (6 s x price)", async () => {
    await make({ kling: { terminal: { status: "completed", usageCostMicros: KLING_RESERVE } } });
    const result = completed(await rig.run());
    expect(result.aboveWorst).toBeNull();
    expect(rig.settles(KLING)).toMatchObject([{ costMicros: KLING_RESERVE, estimated: false }]);
  });

  test("a bill above the reserve is recorded, handed back as the halt, and stops every later reserve; the clip is still delivered", async () => {
    await make({ kling: { terminal: { status: "completed", usageCostMicros: KLING_RESERVE + 1 } } });
    const result = completed(await rig.run());
    expect(result.aboveWorst).toBeInstanceOf(MoneyError);
    expect(result.aboveWorst?.code).toBe("SETTLE_ABOVE_WORST");
    expect(rig.settles(KLING)).toMatchObject([{ costMicros: KLING_RESERVE + 1 }]);
    expect(journalOf(rig).at(-1)).toBe(`ended:${KLING}:completed:usage`);
    const next = await rig.budget.tryReserve({ attemptId: "other-0001:img#1", jobId: "other-0001", scope: { runId: "other-0001" }, model: "x", worstMicros: 1 });
    expect(next).toMatchObject({ ok: false, reason: "HALTED", cause: "SETTLE_ABOVE_WORST" });
  });

  test("the reserve is (requested seconds + 1) x the price: std 5 s 504 000, pro 5 s 672 000, std 10 s 924 000, pro 10 s 1 232 000", async () => {
    const cases = [
      ["std", 5, 504_000],
      ["pro", 5, 672_000],
      ["std", 10, 924_000],
      ["pro", 10, 1_232_000],
    ] as const;
    for (const [quality, seconds, reserve] of cases) {
      await make();
      await rig.run({ request: { model: "kling", quality, seconds, fallback: "none" } });
      expect(rig.reserves()[0]?.worstMicros).toBe(reserve);
      await rig.dispose();
    }
  });

  test("Grok's reserve adds the input image: 5 s 850 000, 10 s 1 550 000", async () => {
    for (const [seconds, reserve] of [
      [5, 850_000],
      [10, 1_550_000],
    ] as const) {
      await make({ mode: "offer" });
      await rig.run({ request: { model: "grok", quality: "std", seconds, fallback: "none" } });
      expect(rig.reserves()[0]?.worstMicros).toBe(reserve);
      await rig.dispose();
    }
  });

  test("each attempt is told its model, tier and reserve when its request body is built", async () => {
    await make({ mode: "auto", kling: refused, grok: grokOk });
    const plans: AttemptPlan[] = [];
    await rig.run({
      buildRequest: (plan) => {
        plans.push(plan);
        return { model: plan.modelId, prompt: "p", duration: plan.seconds, resolution: plan.resolution, aspect_ratio: "9:16", generate_audio: false, frame_images: [] };
      },
    });
    expect(plans.map((p) => [p.n, p.attemptId, p.model, p.tier, p.modelId, p.resolution, p.reserveMicros])).toEqual([
      [1, KLING, "kling", "std", "kwaivgi/kling-v3.0-std", "720p", KLING_RESERVE],
      [2, GROK, "grok", "grok", "x-ai/grok-imagine-video-1.5", "720p", GROK_RESERVE],
    ]);
  });

  test("a request body that cannot be built reserves nothing and sends nothing", async () => {
    await make();
    await expect(
      rig.run({
        buildRequest: () => {
          throw new Error("the first frame is gone");
        },
      }),
    ).rejects.toThrow("the first frame is gone");
    expect(rig.ledger.lines).toHaveLength(0);
    expect(rig.posts()).toHaveLength(0);
  });

  test("the clip's reserves live in the avatar-job scope named after the clip, in no run", async () => {
    await make({ mode: "auto", kling: refused, grok: grokOk });
    await rig.run();
    for (const reserve of rig.reserves()) {
      expect(reserve.scope).toEqual({ avatarJobId: CLIP_ID });
      expect(reserve.jobId).toBe(CLIP_ID);
    }
  });
});

describe("one price book per clip (I5.46)", () => {
  test("a price that changes after the clip started does not change Grok's reserve", async () => {
    const grokRates = { perSecondMicros: 140_000, perInputImageMicros: 10_000 };
    const prices: ClipPrices = { ...PRICES, grok: grokRates };
    await make({ mode: "auto", kling: refused, grok: grokOk });
    rig.at(T0 + 10 * SECOND, () => {
      grokRates.perSecondMicros = 999_999;
    });
    const input = rig.input({ prices });
    const accepted = input.acceptedWorstMicros;
    completed(await rig.run({ prices, acceptedWorstMicros: accepted }));
    expect(rig.reserves().find((r) => r.attemptId === GROK)?.worstMicros).toBe(GROK_RESERVE);
  });
});

describe("the month can take Grok's room while Kling is being proven", () => {
  test("Grok's reserve refused by the month: the clip ends grok-no-room, free, and nothing is sent to Grok", async () => {
    await make({ mode: "auto", kling: refused, grok: grokOk });
    rig.at(TERMINAL + 60 * SECOND, () => rig.budget.setMonthlyBudget(600_000));
    expect(failed(await rig.run())).toMatchObject({ reason: "grok-no-room", cost: "free", model: "grok", grokOffer: false });
    expect(rig.settles(KLING)).toMatchObject([{ costMicros: 0 }]);
    expect(rig.reserves().map((r) => r.attemptId)).toEqual([KLING]);
    expectNoGrok(rig, GROK);
  });
});

describe("Grok behind Kling follows the same rules", () => {
  test("a 401 at Grok's submit ends key-invalid; Kling stays settled 0", async () => {
    await make({ mode: "auto", kling: refused, grok: { submit: { kind: "refused", httpStatus: 401, errorKind: "AUTH_INVALID", moderation: false, detail: "HTTP 401" } } });
    expect(failed(await rig.run())).toMatchObject({ reason: "key-invalid", model: "grok", cost: "free" });
    expect(rig.settles().map((s) => [s.attemptId, s.costMicros])).toEqual([
      [KLING, 0],
      [GROK, 0],
    ]);
  });

  test("an uncertain submit to Grok leaves Grok's reserve open, held 20 min from the POST, and sends nothing again", async () => {
    await make({ mode: "auto", kling: refused, grok: { submit: { kind: "uncertain", cause: "network", httpStatus: null, detail: "reset" } } });
    expect(failed(await rig.run())).toMatchObject({ reason: "submit-uncertain", model: "grok", cost: "worst" });
    expect(rig.ledger.openReserves().map((r) => r.attemptId)).toEqual([GROK]);
    expect(rig.holds.untilOf(GROK)).toBe(rig.posts("grok")[0]!.t + 20 * MINUTE);
    expect(rig.posts("grok")).toHaveLength(1);
  });

  test("a Grok attempt that outlives its 20 min goes late like Kling's", async () => {
    await make({ mode: "auto", kling: refused, grok: { terminalAfterMs: "never" } });
    const result = late(await rig.run());
    expect(result.late).toMatchObject({ attemptId: GROK, model: "grok" });
    expect(result.attempts.map((a) => [a.attemptId, a.outcome])).toEqual([
      [KLING, "refused"],
      [GROK, "late"],
    ]);
  });

  test("a Grok that fails after a Kling that was proven free is not tried again", async () => {
    await make({ mode: "auto", kling: refused, grok: { terminal: { status: "failed", error: "internal error", contentFailure: false } } });
    expect(failed(await rig.run())).toMatchObject({ reason: "provider-error", model: "grok" });
    expect(rig.posts()).toHaveLength(2);
  });
});

describe("an attempt that is interrupted (the engine shuts down)", () => {
  test("while it renders: the reserve is abandoned open, no money moves, the hold stays at submit + 60 min", async () => {
    await make({ kling: { terminalAfterMs: 5 * MINUTE } });
    rig.at(T0 + 30 * SECOND, () => rig.abort());
    expect((await rig.run()).kind).toBe("interrupted");
    expect(rig.clipLedger()).toEqual([["reserve", KLING, KLING_RESERVE]]);
    expect(rig.trace).toContain(`ledger:abandon:${KLING}`);
    expect(rig.holds.untilOf(KLING)).toBe(T0 + 60 * MINUTE);
    expect(journalOf(rig)).toEqual(["requested", `submitted:${KLING}`]);
    expect(rig.posts()).toHaveLength(1);
  });

  test("while it proves a refusal: the reserve stays open at worst and nothing is settled by a guess", async () => {
    await make({ mode: "auto", kling: refused, grok: grokOk });
    rig.at(TERMINAL + 30 * SECOND, () => rig.abort());
    expect((await rig.run()).kind).toBe("interrupted");
    expect(rig.settles()).toHaveLength(0);
    expect(rig.ledger.openReserves().map((r) => r.attemptId)).toEqual([KLING]);
    expectNoGrok(rig, GROK);
  });
});

describe("the holds an attempt leaves (I5.48), per attempt", () => {
  test("while it renders: submit + 60 min; after the terminal status: terminal + 2 min", async () => {
    await make({ mode: "auto", kling: refused, grok: grokOk });
    let rendering: number | undefined;
    let proving: number | undefined;
    rig.at(T0 + 30 * SECOND, () => void (rendering = rig.holds.untilOf(KLING)));
    rig.at(TERMINAL + 30 * SECOND, () => void (proving = rig.holds.untilOf(KLING)));
    await rig.run();
    expect(rendering).toBe(T0 + 60 * MINUTE);
    expect(proving).toBe(TERMINAL + 2 * MINUTE);
  });

  test("a clip with two attempts holds each its own way: Kling to terminal + 2 min, Grok to its own terminal + 2 min", async () => {
    await make({ mode: "auto", kling: refused, grok: grokOk });
    await rig.run();
    const grokTerminal = rig.posts("grok")[0]!.t + 60 * SECOND;
    expect(rig.holds.untilOf(GROK)).toBe(grokTerminal + 2 * MINUTE);
    expect(rig.holdChanges()).toBeGreaterThan(0);
  });

  test("«the job ended, the hold is still on»: a refusal found billed at the first read ends the clip at +15 s, and the hold lasts until 2 min after the terminal status", async () => {
    await make({ mode: "auto", kling: { ...refused, generation: genFromAfter(15 * SECOND, KLING_BILLED) } });
    failed(await rig.run());
    expect(rig.t).toBe(TERMINAL + 15 * SECOND);
    expect(rig.holds.untilOf(KLING)).toBe(TERMINAL + 2 * MINUTE);
    expect(rig.holds.waitMs()).toBe(105 * SECOND);
  });

  test("«the job ended, the hold is still on»: a completed clip's job ends at the status, and the reconcile waits 2 min from it", async () => {
    await make();
    completed(await rig.run());
    expect(rig.holds.untilOf(KLING)).toBe(TERMINAL + 2 * MINUTE);
    expect(rig.holds.waitMs()).toBe(2 * MINUTE);
  });

  test("«the job ended, the hold is still on»: an uncertain submit ends the clip at once, and the hold lasts 20 min", async () => {
    await make({ kling: { submit: { kind: "uncertain", cause: "timeout", httpStatus: null, detail: "no answer" } } });
    failed(await rig.run());
    expect(rig.t).toBe(T0);
    expect(rig.holds.waitMs()).toBe(20 * MINUTE);
  });
});

describe("the phases a job shows", () => {
  test("a refusal that falls back to Grok: submitting, rendering, proving (with the end of the window), then Grok's submitting and rendering", async () => {
    await make({ mode: "auto", kling: refused, grok: grokOk });
    await rig.run();
    expect(rig.phases.map((p) => `${p.phase}:${p.model}`)).toEqual(["submitting:kling", "rendering:kling", "proving:kling", "submitting:grok", "rendering:grok"]);
    expect(rig.phases[1]).toMatchObject({ submittedAt: iso(T0) });
    expect(rig.phases[2]).toMatchObject({ content: true, proveUntil: iso(TERMINAL + 2 * MINUTE) });
  });

  test("a clip that goes late says so", async () => {
    await make({ kling: { terminalAfterMs: "never" } });
    await rig.run();
    expect(rig.phases.at(-1)).toMatchObject({ phase: "late", model: "kling" });
  });
});

describe("what the caller must not ask for", () => {
  test("a frame of «Смелая» while BOLD_CLIPS is `off`: nothing is written or sent", async () => {
    await make({ boldClips: "off" });
    await expect(rig.run({ bold: true })).rejects.toThrow(RangeError);
    expect(rig.journalLines).toHaveLength(0);
    expect(rig.ledger.lines).toHaveLength(0);
    expect(rig.posts()).toHaveLength(0);
  });

  test("a Grok clip in mode `auto`: nothing is written or sent", async () => {
    await make({ mode: "auto" });
    await expect(rig.run({ request: { model: "grok", quality: "std", seconds: 5, fallback: "none" } })).rejects.toThrow(RangeError);
    expect(rig.journalLines).toHaveLength(0);
    expect(rig.posts()).toHaveLength(0);
  });
});

describe("the defaults", () => {
  test("the mode is the engine's GROK_FALLBACK and the bold switch is BOLD_CLIPS when the input names neither", async () => {
    await make();
    const input = rig.input({ mode: undefined, boldClips: undefined });
    await runClip(rig.deps, input, rig.signal);
    // GROK_FALLBACK is `auto` and a normal frame is not «Смелая»: the clip ran on Kling with a Grok reserve behind it in the accepted worst.
    expect(input.acceptedWorstMicros).toBe(GROK_RESERVE);
    expect(rig.settles(KLING)[0]?.costMicros).toBe(KLING_BILLED);
  });
});
