import { describe, expect, test } from "bun:test";
import type { EngineError } from "../../shared/engine";
import type { ReleaseLine, ReserveLine, SettleLine } from "../money/ledger";
import { plan, type PlanSlot } from "../scenes";
import { foldRun, paidAttempts, type RunEvent, type SlotState } from "./journal";
import { BOLD_IMAGE_MODEL, buildRunPlan, FALLBACK_IMAGE_MODEL, type RunPlan } from "./plan";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.3 (S5.9d, plan s5a3 §8.2, H1): the resume of a slot drawn on the Seedream route. Seedream is the bold route AND the 1K moderation fallback of every other slot, so
// a bold slot's attempts on it must never read as «the fallback was used» (which closes a slot for good). A bold slot's state comes from its own last attempt, the
// journal first: only a journaled refusal or a journaled empty answer ends it; a free ledger zero reads as a refusal only when the attempt has no journal line.

const RUN_ID = "run-00000001";
const AT = "2026-10-12T12:00:00.000Z";
const GROK = "x-ai/grok-imagine-image-2.0";
const SEEDREAM = BOLD_IMAGE_MODEL;

/** A run of two slots: slot 1 on the Seedream route, slot 2 an ordinary Grok slot. */
function mixedRun(): RunPlan {
  const slots: PlanSlot[] = plan({ seed: 5, count: 2, categories: ["nightwear"] }).slots.map((slot, i) => (i === 0 ? { ...slot, route: "seedream" as const } : slot));
  return buildRunPlan({
    runId: RUN_ID,
    avatarId: "avatar-0001",
    createdAt: AT,
    request: { avatarId: "avatar-0001", count: 2, categories: ["nightwear"] },
    imageAgeCheck: "off",
    models: { imageModel: GROK, textModel: "x-ai/grok-4.3" },
    capMicros: 9_000_000,
    plannedWorstMicros: 9_000_000,
    scenes: { version: 1, seed: 5, slots },
  });
}

/** The same run on a settings model that already is Seedream: the plan's fallback is null, the bold model is still named. */
function seedreamSettingsRun(): RunPlan {
  const slots: PlanSlot[] = plan({ seed: 5, count: 1, categories: ["nightwear"] }).slots.map((slot) => ({ ...slot, route: "seedream" as const }));
  return buildRunPlan({
    runId: RUN_ID,
    avatarId: "avatar-0001",
    createdAt: AT,
    request: { avatarId: "avatar-0001", count: 1, categories: ["nightwear"] },
    imageAgeCheck: "off",
    models: { imageModel: FALLBACK_IMAGE_MODEL, textModel: "x-ai/grok-4.3" },
    capMicros: 9_000_000,
    plannedWorstMicros: 9_000_000,
    scenes: { version: 1, seed: 5, slots },
  });
}

const idsOf = (run: RunPlan, slotIndex: number): string[] => run.slotAttempts.find((s) => s.slotIndex === slotIndex)?.attemptIds ?? [];

type AttemptEvent = Extract<RunEvent, { type: "attempt" }>;
function attempt(slotIndex: number, attemptId: string, outcome: AttemptEvent["outcome"], model = SEEDREAM, error?: EngineError): RunEvent {
  return { type: "attempt", slotIndex, attemptId, model, outcome, ...(error === undefined ? {} : { error }), at: AT };
}
function reserve(attemptId: string, model = SEEDREAM): ReserveLine {
  return { type: "reserve", attemptId, jobId: "job-00000001", scope: { runId: RUN_ID }, model, worstMicros: 93_000, at: AT };
}
const settle = (attemptId: string, costMicros: number, estimated = false): SettleLine => ({ type: "settle", attemptId, costMicros, estimated, at: AT });
const release = (attemptId: string): ReleaseLine => ({ type: "release", attemptId, reason: "not sent", at: AT });

const REFUSED: EngineError = { code: "MODERATION_REFUSED", sceneReason: "model-refused", detail: "Seedream blocked this request through content moderation." };
const EMPTY: EngineError = { code: "INTERNAL", sceneReason: "model-empty", detail: "data[0].b64_json is missing or empty" };
const QA_MISS: EngineError = { code: "QA_REJECTED", detail: "the QA gate \"face\" asked for another attempt: similarity 0.41" };

interface Record_ {
  events?: RunEvent[];
  reserves?: ReserveLine[];
  closes?: (SettleLine | ReleaseLine)[];
}
function fold(run: RunPlan, record: Record_ = {}): { slot: SlotState; other: SlotState; paid: number } {
  const reserves = new Map((record.reserves ?? []).map((r) => [r.attemptId, r]));
  const closes = new Map((record.closes ?? []).map((c) => [c.attemptId, c]));
  const ledger = { reserveOf: (id: string) => reserves.get(id), closeOf: (id: string) => closes.get(id) };
  const state = foldRun(run, { events: record.events ?? [], photos: [], ...ledger });
  const slot = state.slots[0]!;
  return { slot, other: state.slots[1] ?? slot, paid: paidAttempts(slot, ledger) };
}

describe("a fresh Seedream slot", () => {
  test("is open on the bold route with nothing used", () => {
    const { slot } = fold(mixedRun());
    expect({ end: slot.end, fallbackUsed: slot.fallbackUsed, useFallbackNext: slot.useFallbackNext, boldEnded: slot.boldEnded }).toEqual({ end: null, fallbackUsed: false, useFallbackNext: false, boldEnded: null });
  });
});

describe("resume after a paid mismatch", () => {
  const run = mixedRun();
  const [a1] = idsOf(run, 1);
  const record: Record_ = { events: [attempt(1, a1!, "qa-retry", SEEDREAM, QA_MISS)], reserves: [reserve(a1!)], closes: [settle(a1!, 45_000)] };

  test("does not read the Seedream attempt as the fallback used", () => {
    const { slot } = fold(run, record);
    expect({ fallbackUsed: slot.fallbackUsed, useFallbackNext: slot.useFallbackNext }).toEqual({ fallbackUsed: false, useFallbackNext: false });
  });

  test("keeps the slot open on the bold route with two paid attempts left", () => {
    const { slot, paid } = fold(run, record);
    expect({ boldEnded: slot.boldEnded, paid, left: 3 - paid }).toEqual({ boldEnded: null, paid: 1, left: 2 });
  });
});

describe("resume after a free refusal", () => {
  const run = mixedRun();
  const [a1] = idsOf(run, 1);

  test("ends the slot as refused when the journal says so", () => {
    const { slot } = fold(run, { events: [attempt(1, a1!, "refused", SEEDREAM, REFUSED)], reserves: [reserve(a1!)], closes: [settle(a1!, 0)] });
    expect([slot.boldEnded, slot.boldEndError]).toEqual(["refused", REFUSED]);
  });

  test("ends the slot as refused from the ledger alone when the journal line was lost (a free non-2xx close)", () => {
    const { slot } = fold(run, { reserves: [reserve(a1!)], closes: [settle(a1!, 0)] });
    expect(slot.boldEnded).toBe("refused");
  });

  test("does not count the free refusal among the paid attempts", () => {
    const { paid } = fold(run, { events: [attempt(1, a1!, "refused", SEEDREAM, REFUSED)], reserves: [reserve(a1!)], closes: [settle(a1!, 0)] });
    expect(paid).toBe(0);
  });

  test("never sends the fallback after it", () => {
    const { slot } = fold(run, { events: [attempt(1, a1!, "refused", SEEDREAM, REFUSED)], reserves: [reserve(a1!)], closes: [settle(a1!, 0)] });
    expect({ fallbackUsed: slot.fallbackUsed, useFallbackNext: slot.useFallbackNext }).toEqual({ fallbackUsed: false, useFallbackNext: false });
  });
});

describe("resume after a 2xx without an image", () => {
  const run = mixedRun();
  const [a1] = idsOf(run, 1);
  const record: Record_ = { events: [attempt(1, a1!, "failed", SEEDREAM, EMPTY)], reserves: [reserve(a1!)], closes: [settle(a1!, 45_000)] };

  test("ends the slot as empty with the journaled error", () => {
    const { slot } = fold(run, record);
    expect([slot.boldEnded, slot.boldEndError]).toEqual(["empty", EMPTY]);
  });

  test("counts the paid answer among the paid attempts", () => {
    expect(fold(run, record).paid).toBe(1);
  });
});

describe("resume after an attempt that got no answer", () => {
  const run = mixedRun();
  const [a1, a2] = idsOf(run, 1);

  test("a 429 settled at zero keeps the slot open on the bold route", () => {
    const { slot } = fold(run, { events: [attempt(1, a1!, "failed", SEEDREAM, { code: "RATE_LIMITED" })], reserves: [reserve(a1!)], closes: [settle(a1!, 0)] });
    expect([slot.boldEnded, slot.fallbackUsed]).toEqual([null, false]);
  });

  test("a 5xx settled at zero keeps the slot open", () => {
    const { slot } = fold(run, { events: [attempt(1, a1!, "failed", SEEDREAM, { code: "NETWORK", detail: "HTTP 503" })], reserves: [reserve(a1!)], closes: [settle(a1!, 0)] });
    expect(slot.boldEnded).toBeNull();
  });

  test("a network error with its reserve still open keeps the slot open", () => {
    const { slot } = fold(run, { events: [attempt(1, a1!, "failed", SEEDREAM, { code: "NETWORK" })], reserves: [reserve(a1!)] });
    expect(slot.boldEnded).toBeNull();
  });

  test("an abort between transport retries closed by a free settle keeps the slot open", () => {
    const { slot } = fold(run, { events: [attempt(1, a1!, "aborted")], reserves: [reserve(a1!)], closes: [settle(a1!, 0)] });
    expect(slot.boldEnded).toBeNull();
  });

  test("a timeout leaves the reserve open and the slot open", () => {
    const { slot } = fold(run, { events: [attempt(1, a1!, "failed", SEEDREAM, { code: "TIMEOUT" })], reserves: [reserve(a1!)] });
    expect(slot.boldEnded).toBeNull();
  });

  test("a ledger zero reads as a refusal ONLY without a journal line: a journaled 429 is not one", () => {
    const withLine = fold(run, { events: [attempt(1, a1!, "failed", SEEDREAM, { code: "RATE_LIMITED" })], reserves: [reserve(a1!)], closes: [settle(a1!, 0)] });
    const withoutLine = fold(run, { reserves: [reserve(a1!)], closes: [settle(a1!, 0)] });
    expect([withLine.slot.boldEnded, withoutLine.slot.boldEnded]).toEqual([null, "refused"]);
  });

  test("a lost journal line over a paid close leaves the slot open and counts the attempt", () => {
    const { slot, paid } = fold(run, { reserves: [reserve(a1!)], closes: [settle(a1!, 45_000)] });
    expect([slot.boldEnded, paid]).toEqual([null, 1]);
  });

  test("a lost journal line over an open reserve leaves the slot open", () => {
    const { slot } = fold(run, { reserves: [reserve(a1!)] });
    expect(slot.boldEnded).toBeNull();
  });

  test("a failure after a 429 is judged by the LAST attempt that left, not the first", () => {
    const { slot } = fold(run, {
      events: [attempt(1, a1!, "failed", SEEDREAM, { code: "RATE_LIMITED" }), attempt(1, a2!, "refused", SEEDREAM, REFUSED)],
      reserves: [reserve(a1!), reserve(a2!)],
      closes: [settle(a1!, 0), settle(a2!, 0)],
    });
    expect(slot.boldEnded).toBe("refused");
  });

  test("an attempt released unsent never decides the slot", () => {
    const { slot } = fold(run, {
      events: [attempt(1, a1!, "refused", SEEDREAM, REFUSED)],
      reserves: [reserve(a1!), reserve(a2!)],
      closes: [settle(a1!, 0), release(a2!)],
    });
    expect(slot.boldEnded).toBe("refused");
  });
});

describe("the route, whichever way the plan names its models", () => {
  test("on a settings model that already is Seedream (no fallback in the plan) a bold slot still reads its refusal", () => {
    const run = seedreamSettingsRun();
    const [a1] = idsOf(run, 1);
    const { slot } = fold(run, { events: [attempt(1, a1!, "refused", SEEDREAM, REFUSED)], reserves: [reserve(a1!)], closes: [settle(a1!, 0)] });
    expect(slot.boldEnded).toBe("refused");
  });

  test("a bold slot's attempt on the plan's fallback model is not a fallback use even though the ids match", () => {
    const run = mixedRun();
    expect(run.models.fallback).toBe(SEEDREAM);
    const [a1] = idsOf(run, 1);
    const { slot } = fold(run, { events: [attempt(1, a1!, "qa-retry", SEEDREAM, QA_MISS)], reserves: [reserve(a1!)], closes: [settle(a1!, 45_000)] });
    expect(slot.fallbackUsed).toBe(false);
  });
});

describe("a slot that is not on the Seedream route", () => {
  const run = mixedRun();
  const [b1, b2] = idsOf(run, 2);

  test("still reads its fallback use exactly as before", () => {
    const { other } = fold(run, {
      events: [attempt(2, b1!, "refused", GROK, REFUSED), attempt(2, b2!, "qa-retry", SEEDREAM, QA_MISS)],
      reserves: [reserve(b1!, GROK), reserve(b2!, SEEDREAM)],
      closes: [settle(b1!, 0), settle(b2!, 45_000)],
    });
    expect({ fallbackUsed: other.fallbackUsed, boldEnded: other.boldEnded }).toEqual({ fallbackUsed: true, boldEnded: null });
  });

  test("still moves to the fallback after a refusal on the settings' model", () => {
    const { other } = fold(run, { events: [attempt(2, b1!, "refused", GROK, REFUSED)], reserves: [reserve(b1!, GROK)], closes: [settle(b1!, 0)] });
    expect(other.useFallbackNext).toBe(true);
  });
});
