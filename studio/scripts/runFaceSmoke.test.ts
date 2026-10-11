import { describe, expect, test } from "bun:test";
import type { RunEvent } from "../engine/runs/journal";
import type { PlanSlot } from "../engine/scenes";
import { endedSlots, faceRetryProblems, faceScoreProblems, isFaceJudged, latestPrompts, pickMismatchTarget, slotIndexByPhoto } from "./runFaceSmoke";
import { useNativeGlobals } from "../testing/nativeGlobals";

useNativeGlobals();

const BASE = {
  category: "home",
  location: "kitchen",
  timeOfDay: "morning",
  activity: "making coffee",
  outfit: "robe",
  shot: "candid",
  pose: "front",
  repeatedPair: false,
} as const;

function slot(slotIndex: number, extra: Partial<PlanSlot> = {}): PlanSlot {
  return { ...BASE, slotIndex, attemptIdBase: `slot-${slotIndex}`, ...extra };
}

// Slot 1 hides her face behind the phone, 2 looks at her legs, 3 is seen from behind, 4 and 5 show her face.
const SLOTS: PlanSlot[] = [slot(1, { capture: "mirror-hidden", shot: "mirror" }), slot(2, { capture: "pov-legs", shot: "selfie" }), slot(3, { pose: "back", shot: "friend" }), slot(4), slot(5, { pose: "three-quarter" })];

const AT = "2026-10-11T00:00:00.000Z";
function attempt(slotIndex: number, outcome: "qa-retry" | "passed", gate = "face"): RunEvent {
  return outcome === "passed"
    ? { type: "attempt", slotIndex, attemptId: `slot-${slotIndex}-a${gate}`, model: "m", outcome, photoId: `p${slotIndex}`, at: AT }
    : { type: "attempt", slotIndex, attemptId: `slot-${slotIndex}-b${gate}`, model: "m", outcome, error: { code: "QA_REJECTED", detail: `the QA gate "${gate}" asked for another attempt: x` }, at: AT };
}

describe("which slots the face gate judges", () => {
  test("a hidden-face capture, a legs capture and a back view are only marked; the rest are judged", () => {
    expect(SLOTS.map(isFaceJudged)).toEqual([false, false, false, true, true]);
  });
});

describe("pickMismatchTarget", () => {
  const prompts = new Map(SLOTS.map((s) => [s.slotIndex, `prompt ${s.slotIndex}`]));

  test("skips the face-hidden slots and takes the first face-visible one", () => {
    expect(pickMismatchTarget(SLOTS, prompts)).toEqual({ slotIndex: 4, prompt: "prompt 4" });
  });

  test("skips a face-visible slot that has no prompt", () => {
    expect(pickMismatchTarget(SLOTS, new Map([[5, "prompt 5"]]))).toEqual({ slotIndex: 5, prompt: "prompt 5" });
  });

  test("skips a face-visible slot the journal has already ended", () => {
    expect(pickMismatchTarget(SLOTS, prompts, new Set([4]))).toEqual({ slotIndex: 5, prompt: "prompt 5" });
    expect(pickMismatchTarget(SLOTS, prompts, new Set([4, 5]))).toBeNull();
  });

  test("is null when no slot is face-visible or none has a prompt", () => {
    expect(pickMismatchTarget(SLOTS.slice(0, 3), prompts)).toBeNull();
    expect(pickMismatchTarget(SLOTS, new Map())).toBeNull();
  });
});

describe("latestPrompts and endedSlots", () => {
  const events: RunEvent[] = [
    { type: "prompts", prompts: [{ slotIndex: 4, prompt: "old" }, { slotIndex: 5, prompt: "five" }], at: AT },
    { type: "slot", slotIndex: 5, status: "done", photoId: "p5", at: AT },
    { type: "slot", slotIndex: 1, status: "failed", error: { code: "INTERNAL", detail: "x" }, at: AT },
    { type: "prompts", prompts: [{ slotIndex: 4, prompt: "new" }], at: AT },
  ];

  test("a later prompts event replaces the earlier prompt of a slot, and keeps the others", () => {
    expect([...latestPrompts(events)].sort()).toEqual([[4, "new"], [5, "five"]]);
  });

  test("done and failed slots are both ended", () => {
    expect([...endedSlots(events)].sort()).toEqual([1, 5]);
  });
});

describe("slotIndexByPhoto", () => {
  test("maps the photo of every done slot, ignoring failed ones", () => {
    const events: RunEvent[] = [
      { type: "slot", slotIndex: 4, status: "done", photoId: "p4", at: AT },
      { type: "slot", slotIndex: 5, status: "failed", error: { code: "INTERNAL", detail: "x" }, at: AT },
    ];
    expect([...slotIndexByPhoto(events)]).toEqual([["p4", 4]]);
  });
});

describe("faceScoreProblems", () => {
  const owners = new Map([["p1", 1], ["p3", 3], ["p4", 4], ["p5", 5]]);

  test("is empty when judged photos pass and hidden ones are marked, even below the threshold", () => {
    const photos = [{ id: "p1", faceCos: 0.2 }, { id: "p3", faceCos: 0.1 }, { id: "p4", faceCos: 0.9 }, { id: "p5", faceCos: 0.55 }];
    expect(faceScoreProblems(SLOTS, photos, owners)).toEqual([]);
  });

  test("flags a face-visible photo below 0.55 or without a score", () => {
    expect(faceScoreProblems(SLOTS, [{ id: "p4", faceCos: 0.549 }, { id: "p5", faceCos: undefined }], owners)).toHaveLength(2);
  });

  test("flags a face-hidden photo the gate skipped instead of marking", () => {
    expect(faceScoreProblems(SLOTS, [{ id: "p1", faceCos: undefined }, { id: "p4", faceCos: 0.9 }], owners)).toHaveLength(1);
  });

  test("flags a run with no scored face-visible photo, and a photo of no known slot", () => {
    expect(faceScoreProblems(SLOTS, [{ id: "p1", faceCos: 0.9 }], owners)).toHaveLength(1);
    expect(faceScoreProblems(SLOTS, [{ id: "p4", faceCos: 0.9 }, { id: "ghost", faceCos: 0.9 }], owners)).toHaveLength(1);
  });
});

describe("faceRetryProblems", () => {
  const target = { slotIndex: 4, prompt: "prompt 4" };

  test("is empty when the target slot retried through the face gate and no hidden slot did", () => {
    expect(faceRetryProblems(SLOTS, [attempt(4, "qa-retry"), attempt(4, "passed")], target)).toEqual([]);
  });

  test("flags a run where the target slot never retried (the induced mismatch missed)", () => {
    expect(faceRetryProblems(SLOTS, [attempt(5, "qa-retry")], target)).toHaveLength(1);
  });

  test("a retry from another gate on the target does not count", () => {
    expect(faceRetryProblems(SLOTS, [attempt(4, "qa-retry", "pdq")], target)).toHaveLength(1);
  });

  test("flags a face-gate retry on a face-hidden slot, but not a near-duplicate retry there", () => {
    expect(faceRetryProblems(SLOTS, [attempt(4, "qa-retry"), attempt(1, "qa-retry")], target)).toHaveLength(1);
    expect(faceRetryProblems(SLOTS, [attempt(4, "qa-retry"), attempt(1, "qa-retry", "pdq")], target)).toEqual([]);
  });
});
