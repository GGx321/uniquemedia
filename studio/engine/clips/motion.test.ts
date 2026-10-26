import { describe, expect, test } from "bun:test";
import { ClipMotionChoice } from "../../shared/engine";
import { BANKS } from "../../shared/scenes/banks";
import { categoryBankProblems } from "../../shared/scenes/banks/schema";
import type { CategoryBank } from "../../shared/scenes/banks/types";
import { PHONE_WORDS, SELFIE_WORDS } from "../../shared/scenes/words";
import type { PlanSlot } from "../scenes/schema";
import { frameFactsOf, type FrameFacts, type FrameFactsResult } from "./frameFacts";
import { CODE_MOTIONS, chosenMotion, clipSuitabilityOf, codeMotionsFor, motionChoicesOf } from "./motion";
import { CLIP_CAPTURES, WORN_OR_HELD, type ClipCapture } from "./videoLook";
import { photoOf, pick, planlessPhoto, sceneRun, slotOf } from "./testing/frameFixtures";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.1, S5.V5 (plan s5b1 §5.5 «Choices», I5.51): what the sheet offers. The photo's own scene motion first, verbatim from the bank, when the photo's prompt still says
// its moment; then up to three code motions that fit who took the photo and whether her face shows. A legs frame and a face-hidden frame take their motion from the banks alone
// (only the hips turn to a mirror is code). Never free text: an id resolves only to a listed choice.

function factsOf(result: FrameFactsResult): FrameFacts {
  if (result.kind !== "gallery") throw new Error(`expected a gallery photo, got ${result.kind}`);
  return result.facts;
}

/** The facts of a planned photo on `capture` and `pose`, for a moment `test` picks (its scene motion offered unless `prompt` drops it). */
function planned(category: keyof typeof BANKS, test: Parameters<typeof pick>[1], capture: ClipCapture, pose: PlanSlot["pose"] = "front", prompt?: string): FrameFacts {
  if (capture === "unknown") throw new Error("a planned photo has a capture");
  const run = sceneRun("run-00000101", [slotOf(pick(category, test), capture, pose)]);
  return factsOf(frameFactsOf(photoOf(run, run.scenes.slots[0] as PlanSlot, prompt === undefined ? {} : { prompt }), run));
}

/** The same facts with the scene motion withdrawn (an owner-edited sentence): only code motions remain. */
function codeOnly(facts: FrameFacts): FrameFacts {
  return { ...facts, sceneMotion: false, activity: null };
}

/** Facts for a capture with her face showing, as a frame with no bank moment of its own would have them. */
function visible(capture: ClipCapture, pose: PlanSlot["pose"] = "front"): FrameFacts {
  const base = factsOf(frameFactsOf(planlessPhoto("home", { faceCos: 0.7 }), null));
  return { ...base, capture, pose, face: "yes", faceRole: pose === "profile" ? "profile" : "judged" };
}

const VIEWER_GAZE_MOTIONS = ["g-blink", "g-tilt", "g-glance"];
const ARM_LENGTH: readonly ClipCapture[] = ["selfie", "above", "prone", "over-shoulder", "pov-legs", "mirror", "mirror-hidden", "timer"];

describe("the code motions (plan §5.5 table)", () => {
  test("are the plan's seven, each with a Russian label and an English text", () => {
    expect(CODE_MOTIONS.map((m) => m.id)).toEqual(["g-blink", "g-hair", "g-tilt", "g-glance", "g-breath", "g-down", "g-hips"]);
    for (const motion of CODE_MOTIONS) {
      expect(motion.label).toMatch(/[а-яё]/i);
      expect(ClipMotionChoice.safeParse({ id: motion.id, source: "code", label: motion.label, text: motion.text }).success).toBe(true);
    }
  });

  test("each passes the bank grammar itself: «she/her», small or slow, one movement, no staging word, no phone, at most 60 characters", () => {
    const home = BANKS.home;
    for (const motion of CODE_MOTIONS) {
      // The bank's own motion rules (checkMotion), run on a copy of «Дом» whose first moment takes this code motion.
      const [place, ...places] = home.places;
      const [moment, ...moments] = place?.moments ?? [];
      if (place === undefined || moment === undefined) throw new Error("the home bank has no moment");
      const bank: CategoryBank = { ...home, places: [{ ...place, moments: [{ ...moment, motion: motion.text }, ...moments] }, ...places] };
      expect(categoryBankProblems(bank, "home").filter((problem) => problem.includes("(motion)"))).toEqual([]);
    }
  });

  test("the bank's copy check itself passes on the real «Дом» (so a failure above is the code motion's)", () => {
    expect(categoryBankProblems(BANKS.home, "home")).toEqual([]);
  });
});

describe("which code motions a frame gets", () => {
  for (const capture of CLIP_CAPTURES) {
    if (capture === "mirror-hidden" || capture === "pov-legs" || capture === "low-feet") continue;
    test(`${capture}, her face showing: two or three, never more`, () => {
      const motions = codeMotionsFor(visible(capture));
      expect(motions.length).toBeGreaterThanOrEqual(2);
      expect(motions.length).toBeLessThanOrEqual(3);
    });
  }

  test("a candid clip never looks at the viewer", () => {
    expect(codeMotionsFor(visible("candid")).map((m) => m.id).filter((id) => VIEWER_GAZE_MOTIONS.includes(id))).toEqual([]);
  });

  test("an arm's-length, mirror or propped capture never gets a motion that names a phone or a selfie", () => {
    for (const capture of ARM_LENGTH) {
      for (const motion of codeMotionsFor(visible(capture))) {
        expect(PHONE_WORDS.test(motion.text)).toBe(false);
        expect(SELFIE_WORDS.test(motion.text)).toBe(false);
      }
    }
  });

  test("the hips turn to the mirror belongs to the two mirror captures alone (plan table: mirror, mirror-hidden)", () => {
    for (const capture of CLIP_CAPTURES) {
      const ids = codeMotionsFor(visible(capture)).map((m) => m.id);
      if (capture !== "mirror" && capture !== "mirror-hidden") expect(ids).not.toContain("g-hips");
    }
    expect(codeMotionsFor(visible("mirror")).map((m) => m.id)).toContain("g-hips");
  });

  test("a face-hidden mirror frame gets the hips turn and nothing else", () => {
    const facts = planned("home", (m) => m.captures.includes("mirror-hidden") && m.legs === undefined, "mirror-hidden");
    expect(codeMotionsFor(facts).map((m) => m.id)).toEqual(["g-hips"]);
  });

  test("a legs frame gets no code motion, whatever its capture", () => {
    expect(codeMotionsFor(planned("home", (m) => m.captures.includes("pov-legs"), "pov-legs"))).toEqual([]);
    expect(codeMotionsFor(planned("photoshoot", (m) => m.captures.includes("low-feet"), "low-feet"))).toEqual([]);
    expect(codeMotionsFor(planned("home", (m) => m.captures.includes("mirror-hidden") && m.legs?.framing === "legs", "mirror-hidden"))).toEqual([]);
  });

  test("a frame seen from behind gets no code motion", () => {
    expect(codeMotionsFor(planned("photoshoot", (m) => m.captures.includes("friend") && m.angle === "back", "friend", "back"))).toEqual([]);
  });

  test("no plan: a judged photo takes the face-visible motions of an unknown capture; a marked one takes none", () => {
    const judged = factsOf(frameFactsOf(planlessPhoto("home", { faceCos: 0.7 }), null));
    expect(codeMotionsFor(judged).length).toBeGreaterThanOrEqual(2);
    expect(codeMotionsFor(factsOf(frameFactsOf(planlessPhoto("home", { faceCos: 0.7, faceMarked: true }), null)))).toEqual([]);
    expect(codeMotionsFor(factsOf(frameFactsOf(planlessPhoto("home", {}), null)))).toEqual([]);
  });
});

describe("the sheet's choices", () => {
  // A moment whose motion moves no worn or held thing: one that does is offered only when the photo's prompt names the thing outside the moment (FU-CLIP round 2, MEDIUM-3).
  const timer = planned("home", (m) => m.captures.includes("timer") && m.level === undefined && m.legs === undefined && m.angle === undefined && !WORN_OR_HELD.test(m.motion), "timer");

  test("«Как в сцене» first: the bank's motion verbatim, then the code motions; at most four, ids unique, each a valid choice", () => {
    const choices = motionChoicesOf(timer);
    expect(choices[0]).toEqual({ id: "scene", source: "scene", label: "Как в сцене", text: timer.moment?.motion ?? "" });
    expect(choices.length).toBeLessThanOrEqual(4);
    expect(new Set(choices.map((c) => c.id)).size).toBe(choices.length);
    for (const choice of choices) expect(ClipMotionChoice.safeParse(choice).success).toBe(true);
    expect(choices.slice(1).every((c) => c.source === "code")).toBe(true);
  });

  test("an edited scene loses «Как в сцене» and keeps the code motions", () => {
    const choices = motionChoicesOf(codeOnly(timer));
    expect(choices.map((c) => c.id)).not.toContain("scene");
    expect(choices.length).toBeGreaterThanOrEqual(2);
  });

  test("a legs frame offers its bank motion alone", () => {
    const legs = planned("home", (m) => m.captures.includes("pov-legs"), "pov-legs");
    expect(motionChoicesOf(legs).map((c) => c.id)).toEqual(["scene"]);
  });

  test("a bank motion that fails a check is dropped from the choices and logged, never offered", () => {
    const logged: string[] = [];
    const moment = timer.moment;
    if (moment === null) throw new Error("no moment");
    const staged = { ...timer, moment: { ...moment, motion: "she turns slowly for a cinematic push-in" } };
    const choices = motionChoicesOf(staged, (line) => logged.push(line));
    expect(choices.map((c) => c.id)).not.toContain("scene");
    expect(logged.length).toBe(1);
  });

  test("a bank motion that names a phone on an arm's-length capture is dropped", () => {
    const selfie = planned("travel", (m) => m.captures.includes("selfie") && m.level === undefined && m.legs === undefined, "selfie");
    const moment = selfie.moment;
    if (moment === null) throw new Error("no moment");
    const phoned = { ...selfie, moment: { ...moment, motion: "she checks her phone slowly" } };
    expect(motionChoicesOf(phoned, () => undefined).map((c) => c.id)).not.toContain("scene");
  });
});

describe("suitability (§5.4)", () => {
  test("a back or legs frame with no bank moment has no motion: `no-motion`", () => {
    const back = planned("photoshoot", (m) => m.captures.includes("friend") && m.angle === "back", "friend", "back");
    expect(clipSuitabilityOf({ kind: "gallery", facts: codeOnly(back) }, "kling-only")).toEqual({ suitable: false, reason: "no-motion" });
    const legs = planned("home", (m) => m.captures.includes("pov-legs"), "pov-legs");
    expect(clipSuitabilityOf({ kind: "gallery", facts: codeOnly(legs) }, "kling-only")).toEqual({ suitable: false, reason: "no-motion" });
  });

  test("a frame with a motion is suitable and carries its choices", () => {
    const facts = planned("home", (m) => m.captures.includes("timer") && m.legs === undefined, "timer");
    const answer = clipSuitabilityOf({ kind: "gallery", facts }, "kling-only");
    if (!answer.suitable) throw new Error(`refused: ${answer.reason}`);
    expect(answer.motions).toEqual(motionChoicesOf(facts));
  });

  test("the refusals come in clips.create's order: not a gallery photo, age, «Смелая» off, no motion", () => {
    expect(clipSuitabilityOf({ kind: "not-a-gallery-photo" }, "kling-only")).toEqual({ suitable: false, reason: "not-a-gallery-photo" });
    const young = factsOf(frameFactsOf(planlessPhoto("nightwear", { faceMarked: true, age: { adult: false, confidence: 0.9 } }), null));
    expect(clipSuitabilityOf({ kind: "gallery", facts: young }, "off")).toEqual({ suitable: false, reason: "age-unverified" });
    const bold = factsOf(frameFactsOf(planlessPhoto("nightwear", { faceMarked: true }), null));
    expect(clipSuitabilityOf({ kind: "gallery", facts: bold }, "off")).toEqual({ suitable: false, reason: "bold-off" });
    expect(clipSuitabilityOf({ kind: "gallery", facts: bold }, "kling-only")).toEqual({ suitable: false, reason: "no-motion" });
  });
});

describe("a motion id resolves only to a listed choice (I5.51: never free text)", () => {
  const timer = planned("home", (m) => m.captures.includes("timer") && m.legs === undefined, "timer");

  test("a listed id answers its choice", () => {
    for (const choice of motionChoicesOf(timer)) expect(chosenMotion(timer, choice.id)).toEqual(choice);
  });

  test("an id the sheet did not list answers nothing", () => {
    expect(chosenMotion(timer, "g-hips")).toBeNull();
    expect(chosenMotion(timer, "g-unknown")).toBeNull();
    expect(chosenMotion(codeOnly(timer), "scene")).toBeNull();
  });
});
