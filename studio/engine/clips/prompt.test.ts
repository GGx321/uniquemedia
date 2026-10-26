import { describe, expect, test } from "bun:test";
import { BANKS } from "../../shared/scenes/banks";
import type { OwnPlanSlot, PlanSlot } from "../scenes/schema";
import { shotOf } from "../../shared/scenes/captures";
import { CUSTOM_REF } from "../scenes/testing/customPool";
import { frameFactsOf, type FrameFacts, type FrameFactsResult } from "./frameFacts";
import { VIDEO_TIERS } from "../money/prices";
import { motionChoicesOf } from "./motion";
import { clipPromptOf, clipRequestBody } from "./prompt";
import { ADULT_LINE, COMES_OFF_LINE, CONTINUITY_LINE, LEGS_LINE, LOOK_LINE, POSE_ANCHOR, PRONE_ANCHOR, PROMPT_WORDS_MAX, SLOW_LINE, cameraLineOf, legwearLineOf, wordCount, type ClipDialect } from "./videoLook";
import { everyMoment, photoOf, pick, planlessPhoto, promptNamingLegwear, sceneRun, slotOf } from "./testing/frameFixtures";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.1, S5.V5 (plan s5b1 §5.5, I5.51, I5.57): the clip prompt is code. In order: the camera line, the pose anchor, the motion sentence, the prone anchor, the legs
// line, the continuity line, the legwear line, the pacing, the look, and «She is an adult woman.». It carries no outfit text and, since FU-CLIP (canary C5c, 2026-10-26), no
// activity of the slot. The three prompts probe P-V ran on frames of «Смелая» (2026-10-13, 3 of 3 completed, accepted by the owner) are pinned below, with the camera and look
// lines the C3 polish (2026-10-14) rewrote and the pose anchor FU-CLIP put in place of their pose sentence. What P-V ran, as history: S1 opened with «Handheld by a friend who
// stays at the same distance, gentle sway, the framing drifts only a little.», S2 with «A selfie at arm's length: the camera stays in her outstretched hand the whole time.»,
// all three looks were «Vertical phone video, slight noise, everything in focus. No text on screen.», and their pose sentences were «The adult woman steps out of the water.»,
// «The adult woman lies back, one knee up.» and «The adult woman stands with one hand on her hip.»

function factsOf(result: FrameFactsResult): FrameFacts {
  if (result.kind !== "gallery") throw new Error(`expected a gallery photo, got ${result.kind}`);
  return result.facts;
}

/** The facts of a planned photo of `slot` (a scene-set run of one slot), its prompt the run's own unless `prompt` replaces it. */
function factsFor(slot: PlanSlot, prompt?: string): FrameFacts {
  const run = sceneRun("run-00000201", [slot]);
  return factsOf(frameFactsOf(photoOf(run, run.scenes.slots[0] as PlanSlot, prompt === undefined ? {} : { prompt }), run));
}

function promptOf(facts: FrameFacts, motion: string, dialect: ClipDialect = "kling"): string {
  const result = clipPromptOf(facts, motion, dialect, "scene");
  if (!result.ok) throw new Error(`no prompt: ${result.problems.join("; ")}`);
  return result.prompt;
}

/** A custom category's slot (the test kit's «Кофейни Парижа») on `capture`, with a pool activity of its own and no bank moment. */
function customSlot(capture: "friend" | "selfie" | "timer", activity: string): PlanSlot {
  const { level: _level, ...base } = slotOf(pick("travel", (m) => m.captures.includes("friend")), "friend");
  return { ...base, category: CUSTOM_REF, location: "a riverside cafe", activity, outfit: "a linen dress", shot: shotOf(capture), capture };
}

/** The first bank moment (of the 7 banks) whose motion is `motion`. */
function everyMomentWith(motion: string) {
  const found = everyMoment().find((p) => p.moment.motion === motion);
  if (found === undefined) throw new Error(`no bank moment moves «${motion}»`);
  return found;
}

const sceneMotion = (facts: FrameFacts): string => {
  if (facts.moment === null) throw new Error("no bank moment");
  return facts.moment.motion;
};

describe("the prompts probe P-V ran (2026-10-13), as the C3 polish rewrote their camera and look lines and FU-CLIP their pose sentence", () => {
  test("S1: «Пляж и бассейн», candid, steps out of the water", () => {
    const facts = factsFor(slotOf(pick("beach", (m) => m.text === "steps out of the water"), "candid", "front", { level: "bold" }));
    expect(promptOf(facts, sceneMotion(facts))).toBe(
      "Handheld steadily by a friend at the same distance the whole time; the framing barely moves. The adult woman starts in her pose from the photo. Over the whole clip she keeps walking slowly. Nothing new appears, and nothing she holds or wears changes. Slow, gentle, unhurried, real-time speed; no fast or abrupt movements, no sudden gestures. Vertical phone video, slight noise, everything in focus. One continuous shot, no cuts. No text on screen. She is an adult woman.",
    );
  });

  test("S2: «Ночнушки и бельё», a selfie from above, one knee up", () => {
    const facts = factsFor(slotOf(pick("nightwear", (m) => m.text === "lies back, one knee up"), "above"));
    expect(promptOf(facts, sceneMotion(facts))).toBe(
      "A selfie at arm's length: the view stays at that same distance from her and the framing never changes; one arm leaves the frame at its edge the whole time. The adult woman keeps her pose from the photo. Over the whole clip she sways her knee a little. Nothing new appears, and nothing she holds or wears changes. Slow, gentle, unhurried, real-time speed; no fast or abrupt movements, no sudden gestures. Vertical phone video, slight noise, everything in focus. One continuous shot, no cuts. No text on screen. She is an adult woman.",
    );
  });

  test("S3: «Ночнушки и бельё», a mirror selfie, one hand on her hip", () => {
    const facts = factsFor(slotOf(pick("nightwear", (m) => m.text === "stands with one hand on her hip"), "mirror"));
    expect(promptOf(facts, sceneMotion(facts))).toBe(
      "A mirror selfie: the phone stays in her raised hand the whole time and sways only a little. The adult woman keeps her pose from the photo. Over the whole clip she turns her hips a little. Nothing new appears, and nothing she holds or wears changes. Slow, gentle, unhurried, real-time speed; no fast or abrupt movements, no sudden gestures. Vertical phone video, slight noise, everything in focus. One continuous shot, no cuts. No text on screen. She is an adult woman.",
    );
  });
});

describe("the prompt's shape (§5.5)", () => {
  test("the prone example of the plan: the camera, the pose anchor, the motion, the prone anchor, the continuity, the pacing, the look, the adult line", () => {
    const facts = factsFor(slotOf(pick("home", (m) => m.captures.includes("prone") && /\bhips\b/.test(m.motion)), "prone"));
    expect(promptOf(facts, sceneMotion(facts))).toBe(
      [
        cameraLineOf("prone", "kling"),
        POSE_ANCHOR,
        `Over the whole clip ${sceneMotion(facts)}.`,
        PRONE_ANCHOR,
        CONTINUITY_LINE,
        SLOW_LINE,
        LOOK_LINE,
        ADULT_LINE,
      ].join(" "),
    );
  });

  test("a legs frame with legwear: the legs line after the anchors, the legwear line after the continuity", () => {
    const picked = pick("home", (m) => m.captures.includes("pov-legs") && m.noLegwear !== true && !/\b(socks?|socked|bare|tights)\b/.test(m.text));
    const facts = factsFor(slotOf(picked, "pov-legs", "front", { legwear: "white knee-high socks" }));
    const prompt = promptOf(facts, sceneMotion(facts));
    const at = (line: string): number => prompt.indexOf(line);
    expect(at(LEGS_LINE)).toBeGreaterThan(at(`Over the whole clip ${sceneMotion(facts)}.`));
    expect(at(legwearLineOf("white knee-high socks"))).toBeGreaterThan(at(CONTINUITY_LINE));
    expect(at(SLOW_LINE)).toBeGreaterThan(at(legwearLineOf("white knee-high socks")));
    expect(prompt.endsWith(ADULT_LINE)).toBe(true);
  });

  test("Grok's dialect differs on the timer line only", () => {
    const facts = factsFor(slotOf(pick("home", (m) => m.captures.includes("timer") && m.legs === undefined), "timer"));
    const kling = promptOf(facts, sceneMotion(facts), "kling");
    const grok = promptOf(facts, sceneMotion(facts), "grok");
    expect(grok).toBe(kling.replace(cameraLineOf("timer", "kling"), cameraLineOf("timer", "grok")));
    expect(grok).not.toBe(kling);
  });
});

describe("the content level follows the category (I5.51, I5.57)", () => {
  const bold = pick("nightwear", (m) => m.level === "bold" && /\bpanties\b/.test(m.text));

  test("a «Смелая» moment's words on a «Дом» slot never reach its prompt (FU-CLIP: no activity is sent at any level)", () => {
    const home = pick("home", (m) => m.captures.includes("mirror-hidden") && m.legs === undefined);
    const slot = { ...slotOf(home, "mirror-hidden"), activity: bold.moment.text };
    const facts = factsFor(slot, `In her bedroom, she ${bold.moment.text}, wearing a grey tee.`);
    expect(facts.activity).toBe(bold.moment.text);
    expect(promptOf(facts, "she turns her head a little")).not.toContain(bold.moment.text);
  });

  test("a youth word in a motion fails everywhere, «Смелая» included; one in the activity never reaches the prompt", () => {
    const beach = pick("beach", (m) => m.captures.includes("friend") && m.legs === undefined);
    const youthful = "sits like a teen on the sand";
    for (const category of ["home", "beach"] as const) {
      const slot = { ...slotOf(beach, "friend"), category, activity: youthful, level: undefined };
      const facts = factsFor(slot, `On the beach, she ${youthful}, wearing a sundress.`);
      expect(promptOf(facts, "she turns her head a little")).not.toMatch(/\bteen\b/);
      expect(clipPromptOf(facts, "she sits like a teen a little", "kling", "scene").ok).toBe(false);
    }
  });
});

describe("the anchors (§5.5 items 4-6)", () => {
  test("the prone anchor on a prone and an over-shoulder capture, which lie her on her stomach by construction (an «on her stomach» activity elsewhere: FU-CLIP below)", () => {
    const prone = factsFor(slotOf(pick("home", (m) => m.captures.includes("prone")), "prone"));
    const over = factsFor(slotOf(pick("home", (m) => m.captures.includes("over-shoulder")), "over-shoulder", "three-quarter"));
    for (const facts of [prone, over]) expect(promptOf(facts, sceneMotion(facts))).toContain(PRONE_ANCHOR);
  });

  test("never elsewhere", () => {
    const timer = factsFor(slotOf(pick("home", (m) => m.captures.includes("timer") && !/stomach|prone/.test(m.text)), "timer"));
    expect(promptOf(timer, sceneMotion(timer))).not.toContain(PRONE_ANCHOR);
  });

  test("a «Ножки» frame by the mirror never sends the camera up to her face: the phone covers it (round 2; its legs line went with FU-CLIP)", () => {
    const legs = factsFor(slotOf(pick("home", (m) => m.captures.includes("mirror-hidden") && m.legs?.framing === "legs"), "mirror-hidden"));
    const prompt = promptOf(legs, sceneMotion(legs));
    expect(prompt).not.toMatch(/turns up to her face/);
    expect(prompt).toContain("she holds her phone right in front of her face");
  });

  test("the legs line on a «Ножки» frame only", () => {
    const legs = factsFor(slotOf(pick("photoshoot", (m) => m.captures.includes("low-feet")), "low-feet"));
    const plain = factsFor(slotOf(pick("photoshoot", (m) => m.captures.includes("friend") && m.legs === undefined), "friend"));
    expect(promptOf(legs, sceneMotion(legs))).toContain(LEGS_LINE);
    expect(promptOf(plain, sceneMotion(plain))).not.toContain(LEGS_LINE);
  });

  test("«comes off» when the motion moves what she wears; the base line otherwise", () => {
    const strap = pick("nightwear", (m) => /\bstrap\b/.test(m.motion));
    const facts = factsFor(slotOf(strap, strap.moment.captures[0] ?? "mirror"));
    const prompt = promptOf(facts, sceneMotion(facts));
    expect(prompt).toContain(COMES_OFF_LINE);
    expect(prompt).not.toContain(CONTINUITY_LINE);
  });

  test("a bag's strap keeps the base line: the moment names the bag, and the prompt reads the moment (post-review)", () => {
    // «adjusts the strap of her bag» → «she tugs the strap a little»: the motion says only «strap»; the activity the photo carries makes it a held bag's.
    const bag = pick("photoshoot", (m) => /\bstrap\b/.test(m.motion) && /\bbag\b/.test(m.text));
    const facts = factsFor(slotOf(bag, bag.moment.captures.includes("friend") ? "friend" : (bag.moment.captures[0] ?? "friend")));
    expect(facts.activity).toBe(bag.moment.text);
    const prompt = promptOf(facts, sceneMotion(facts));
    expect(prompt).toContain(CONTINUITY_LINE);
    expect(prompt).not.toContain(COMES_OFF_LINE);
  });

  test("a garment strap with the same kind of motion takes «comes off» (post-review)", () => {
    const strap = pick("beach", (m) => /\bstrap\b/.test(m.motion) && !/\bbag\b/.test(m.text));
    const facts = factsFor(slotOf(strap, strap.moment.captures[0] ?? "friend", strap.moment.angle ?? "front"));
    const prompt = promptOf(facts, sceneMotion(facts));
    expect(prompt).toContain(COMES_OFF_LINE);
    expect(prompt).not.toContain(CONTINUITY_LINE);
  });

  test("the legwear line only with the slot's own legwear, never on a noLegwear moment, never from the motion's words", () => {
    const socks = pick("home", (m) => m.captures.includes("timer") && m.noLegwear !== true && m.legs === undefined);
    expect(promptOf(factsFor(slotOf(socks, "timer", "front", { legwear: "sheer black tights" })), "she slowly takes a breath and relaxes her shoulders")).toContain(legwearLineOf("sheer black tights"));
    const bare = factsFor(slotOf(socks, "timer"));
    expect(promptOf(bare, "she wiggles her toes in her socks a little")).not.toContain("stay on her feet");
    const raised = pick("home", (m) => m.captures.includes("prone") && m.noLegwear === true);
    expect(promptOf(factsFor(slotOf(raised, "prone", "front", { legwear: "sheer black tights" })), sceneMotion(factsFor(slotOf(raised, "prone"))))).not.toContain("stay on her feet");
  });
});

describe("checks before any money (I5.51)", () => {
  const facts = factsFor(slotOf(pick("home", (m) => m.captures.includes("timer") && m.legs === undefined), "timer"));

  test("a motion must open with «she» or «her»", () => {
    expect(clipPromptOf(facts, "slowly she turns", "kling", "scene").ok).toBe(false);
  });

  test("a motion with a staging or video word is refused", () => {
    expect(clipPromptOf(facts, "she turns as the camera zooms in slowly", "kling", "scene").ok).toBe(false);
    expect(clipPromptOf(facts, "she turns slowly in a cinematic orbit", "kling", "scene").ok).toBe(false);
  });

  test("S5.WC2c: a revealing word in a motion is refused no more, on an ordinary frame too (the bank says none at its frame's level: motionText.test.ts sweeps all 271)", () => {
    expect(clipPromptOf(facts, "she adjusts her bra strap slowly", "kling", "scene").ok).toBe(true);
  });

  test("a motion that names a phone on a propped capture is refused", () => {
    expect(clipPromptOf(facts, "she checks her phone slowly", "kling", "scene").ok).toBe(false);
  });

  test("a motion that moves her face is refused where the photo does not show it (the face cover, a legs frame), and kept where it does", () => {
    const hidden = factsFor(slotOf(pick("home", (m) => m.captures.includes("mirror-hidden") && m.legs === undefined), "mirror-hidden"));
    const legs = factsFor(slotOf(pick("photoshoot", (m) => m.captures.includes("low-feet")), "low-feet"));
    for (const motion of ["she sips and smiles a little", "she slowly blinks and smiles", "she presses her lips together a bit", "she laughs a little"]) {
      expect(clipPromptOf(hidden, motion, "kling", "scene").ok).toBe(false);
      expect(clipPromptOf(legs, motion, "kling", "scene").ok).toBe(false);
      expect(clipPromptOf(facts, motion, "kling", "scene").ok).toBe(true);
    }
    expect(clipPromptOf(hidden, "she turns her head a little", "kling", "scene").ok).toBe(true);
  });

  test("every prompt carries the pacing line and ends with the adult line, within the cap", () => {
    const result = clipPromptOf(facts, sceneMotion(facts), "kling", "scene");
    if (!result.ok) throw new Error(result.problems.join("; "));
    expect(result.prompt).toContain(SLOW_LINE);
    expect(result.prompt.endsWith(ADULT_LINE)).toBe(true);
    expect(result.words).toBe(wordCount(result.prompt));
    expect(result.words).toBeLessThanOrEqual(PROMPT_WORDS_MAX);
  });

  test("a pov-legs frame over the cap takes the short camera line, never losing an anchor", () => {
    const legs = pick("home", (m) => m.captures.includes("pov-legs") && m.noLegwear !== true && !/\b(socks?|socked|bare)\b/.test(m.text));
    // The bank's «Дом» list holds no stockings, so the kit's sentence names none: the photo's prompt is made to name them (MEDIUM-2).
    const run = sceneRun("run-00000204", [slotOf(legs, "pov-legs", "front", { legwear: "white lace-top stockings" })]);
    const slot = run.scenes.slots[0] as PlanSlot;
    const long = factsOf(frameFactsOf(photoOf(run, slot, { prompt: promptNamingLegwear(run, slot) }), run));
    const motion = "she stretches her toes toward the far end of the bed a little";
    const result = clipPromptOf(long, motion, "kling", "scene");
    if (!result.ok) throw new Error(result.problems.join("; "));
    expect(result.words).toBeLessThanOrEqual(PROMPT_WORDS_MAX);
    expect(result.prompt).toContain(LEGS_LINE);
    expect(result.prompt).toContain(legwearLineOf("white lace-top stockings"));
    expect(result.prompt).not.toContain(cameraLineOf("pov-legs", "kling"));
  });
});

describe("FU-CLIP: the prompt makes no claim about her pose that only the plan makes (C5c, 2026-10-26)", () => {
  // C5c clip 2: the plan said «lies curled under the blanket», the photo showed her sitting on top of it, and Kling drew the blanket in from nowhere.
  const ANCHOR = "The adult woman keeps her pose from the photo.";
  const curled = (): FrameFacts => factsFor(slotOf(pick("home", (m) => m.text === "lies curled under the blanket" && m.captures.includes("timer")), "timer"));
  const visionPrompt = (facts: FrameFacts, motion: string, dialect: ClipDialect): string => {
    const result = clipPromptOf(facts, motion, dialect, "vision");
    if (!result.ok) throw new Error(`no prompt: ${result.problems.join("; ")}`);
    return result.prompt;
  };

  test("a slot whose activity is «lies curled under the blanket» gives a prompt with no «blanket» and no «lies», in both dialects", () => {
    const facts = curled();
    expect(facts.activity).toBe("lies curled under the blanket");
    for (const dialect of ["kling", "grok"] as const) {
      const prompt = visionPrompt(facts, "she gently tucks her hair behind her ear", dialect);
      expect(prompt).not.toMatch(/\bblanket\b/i);
      expect(prompt).not.toMatch(/\blies\b/i);
    }
  });

  test("the anchor follows the camera line in both dialects: on a planned slot, an own scene and a photo with no plan", () => {
    const run = sceneRun("run-00000203", [{ kind: "own", shot: "friend", pose: "front", text: "She waves from a boat." }]);
    const own = factsOf(frameFactsOf(photoOf(run, run.scenes.slots[0] as OwnPlanSlot), run));
    const planless = factsOf(frameFactsOf(planlessPhoto("home", { faceCos: 0.7 }), null));
    for (const facts of [curled(), own, planless]) {
      for (const dialect of ["kling", "grok"] as const) {
        const prompt = visionPrompt(facts, "she slowly turns her head a little", dialect);
        expect(prompt.startsWith(`${cameraLineOf(facts.capture, dialect)} ${ANCHOR} Over the whole clip `)).toBe(true);
        expect(prompt.split(ANCHOR)).toHaveLength(2);
      }
    }
  });

  test("an activity of any kind stays out of the prompt: a phone one on a friend's photo, an «-ing» pool one, a «Смелая» moment", () => {
    const phone = factsFor(customSlot("friend", "texting on her phone"), "At a riverside cafe, she is texting on her phone, wearing a linen dress.");
    const reading = factsFor(customSlot("friend", "reading a paperback"), "A friend took this. At a riverside cafe, she is reading a paperback, wearing a linen dress.");
    const bold = pick("nightwear", (m) => m.level === "bold" && /\bpanties\b/.test(m.text));
    const boldFacts = factsFor(slotOf(bold, bold.moment.captures[0] ?? "mirror-hidden", bold.moment.angle ?? "front"));
    for (const facts of [phone, reading, boldFacts]) {
      expect(facts.activity).not.toBeNull();
      expect(promptOf(facts, "she slowly turns her head a little")).not.toContain(facts.activity ?? "");
    }
  });

  // Round 2 (MEDIUM-1): plan-based on purpose. A hips motion on a frame the plan lies on her stomach, with no anchor, is the hips-2 take the owner rejected.
  const G_HIPS = "she turns her hips a little toward the mirror and back";

  test("«hips behind» and «on her elbows» by the mirror take the prone anchor with their scene motion and with g-hips", () => {
    for (const text of ["lies on her stomach, hips behind", "lies on her stomach, on her elbows"]) {
      const facts = factsFor(slotOf(pick("home", (m) => m.text === text && m.captures.includes("mirror-hidden")), "mirror-hidden"));
      for (const [motion, source] of [[sceneMotion(facts), "scene"], [G_HIPS, "code"]] as const) {
        const result = clipPromptOf(facts, motion, "kling", source);
        if (!result.ok) throw new Error(result.problems.join("; "));
        expect([text, motion, result.prompt.includes(PRONE_ANCHOR)]).toEqual([text, motion, true]);
      }
    }
  });

  test("«legs bent up» on a timer with «she kicks her feet slowly» takes no prone anchor: the motion moves no hips", () => {
    const facts = factsFor(slotOf(pick("home", (m) => m.text === "lies on her stomach, legs bent up"), "timer"));
    expect(sceneMotion(facts)).toBe("she kicks her feet slowly");
    expect(promptOf(facts, sceneMotion(facts))).not.toContain(PRONE_ANCHOR);
  });

  test("fitness «hand on her stomach» takes no prone anchor, a hips motion included: she does not lie on her stomach", () => {
    const mirror = factsFor(slotOf(pick("home", (m) => m.captures.includes("mirror") && m.legs === undefined && !/stomach|prone/.test(m.text)), "mirror"));
    for (const activity of ["lies back, hand on her stomach", "turns side-on, hand on her stomach"]) {
      const facts = { ...mirror, activity };
      for (const motion of [G_HIPS, "she shifts her hips a little"]) {
        const result = clipPromptOf(facts, motion, "kling", motion === G_HIPS ? "code" : "vision");
        if (!result.ok) throw new Error(result.problems.join("; "));
        expect([activity, motion, result.prompt.includes(PRONE_ANCHOR)]).toEqual([activity, motion, false]);
      }
    }
  });

  test("the legs line only on a legs capture (pov-legs its photo proves, low-feet): a mirror-hidden legs frame says nothing of her legs", () => {
    const mirror = factsFor(slotOf(pick("home", (m) => m.captures.includes("mirror-hidden") && m.legs?.framing === "legs"), "mirror-hidden"));
    expect(mirror.legs).toBe(true);
    const prompt = promptOf(mirror, sceneMotion(mirror));
    expect(prompt).not.toMatch(/Her legs fill/);
    const pov = factsFor(slotOf(pick("home", (m) => m.captures.includes("pov-legs")), "pov-legs"));
    const low = factsFor(slotOf(pick("photoshoot", (m) => m.captures.includes("low-feet")), "low-feet"));
    for (const facts of [pov, low]) expect(promptOf(facts, sceneMotion(facts))).toContain(LEGS_LINE);
  });

  test("round 2 (MEDIUM-4): a bank motion that moves her across the frame starts her in the photo's pose instead of keeping her in it", () => {
    // The 7 banks' moving motions; the companions' «she wades into the water slowly» is pinned in videoLook.test.ts.
    const MOVING = ["she keeps walking slowly", "she walks on slowly, the water at her feet", "she takes a small step closer", "she laughs and steps back a little"];
    const STARTS = "The adult woman starts in her pose from the photo.";
    for (const motion of MOVING) {
      const picked = everyMomentWith(motion);
      const facts = factsFor(slotOf(picked, picked.moment.captures[0] ?? "friend", picked.moment.angle ?? "front"));
      const prompt = promptOf(facts, motion);
      expect([motion, prompt.includes(STARTS), prompt.includes(ANCHOR)]).toEqual([motion, true, false]);
    }
    const still = curled();
    expect(promptOf(still, sceneMotion(still))).not.toContain(STARTS);
  });

  test("round 2 (MEDIUM-2): a photo whose prompt names no socks gets no line that keeps socks on her feet; one whose prompt names them keeps it", () => {
    const picked = pick("home", (m) => m.captures.includes("timer") && m.noLegwear !== true && m.legs === undefined);
    const slot = slotOf(picked, "timer", "front", { legwear: "white knee-high socks" });
    const bare = factsFor(slot, `The phone is propped up. In her bedroom, she ${picked.moment.text}, wearing ${slot.outfit}. She is an adult woman.`);
    expect(bare.legwear).toBeNull();
    expect(promptOf(bare, "she slowly takes a breath and relaxes her shoulders")).not.toMatch(/socks stay on her feet/);
    const socked = factsFor(slot, `The phone is propped up. In her bedroom, she ${picked.moment.text}, wearing ${slot.outfit} and white knee-high socks. She is an adult woman.`);
    expect(promptOf(socked, "she slowly takes a breath and relaxes her shoulders")).toContain("Her white knee-high socks stay on her feet the whole time.");
  });

  test("round 2 (MEDIUM-3): on C5c clip 2's frame «Как в сцене» («she pulls the blanket up a little») is not offered: only the activity names the blanket", () => {
    const facts = curled();
    expect(facts.moment?.motion).toBe("she pulls the blanket up a little");
    const choices = motionChoicesOf(facts);
    expect(choices.map((choice) => choice.id)).not.toContain("scene");
    expect(choices.length).toBeGreaterThan(0);
    for (const choice of choices) expect(choice.text).not.toMatch(/\bblanket\b/);
  });

  test("round 2 (MEDIUM-3): the same motion is offered when the photo's prompt names the blanket outside the activity", () => {
    const picked = pick("home", (m) => m.text === "lies curled under the blanket" && m.captures.includes("timer"));
    const slot = slotOf(picked, "timer");
    const facts = factsFor(slot, `The phone is propped up. On her bed with a knitted blanket, she lies curled under the blanket, wearing ${slot.outfit}. She is an adult woman.`);
    expect(motionChoicesOf(facts)[0]).toMatchObject({ id: "scene", text: "she pulls the blanket up a little" });
  });

  test("C5c clip 2, rebuilt on its frame: the exact prompt the paid re-check sends", () => {
    expect(visionPrompt(curled(), "she gently tucks her hair behind her ear", "kling")).toBe(
      "The phone is propped up and does not move at all; the framing never changes. The adult woman keeps her pose from the photo. Over the whole clip she gently tucks her hair behind her ear. Nothing new appears, and nothing she holds or wears changes. Slow, gentle, unhurried, real-time speed; no fast or abrupt movements, no sudden gestures. Vertical phone video, slight noise, everything in focus. One continuous shot, no cuts. No text on screen. She is an adult woman.",
    );
  });
});

describe("the request body (§5.5)", () => {
  const FRAME = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==";

  test("Kling std: 720p, no audio, the first frame", () => {
    expect(clipRequestBody({ prompt: "P", model: "kling", quality: "std", seconds: 5, firstFrame: FRAME })).toEqual({
      model: "kwaivgi/kling-v3.0-std",
      prompt: "P",
      duration: 5,
      resolution: "720p",
      aspect_ratio: "9:16",
      generate_audio: false,
      frame_images: [{ type: "image_url", image_url: { url: FRAME }, frame_type: "first_frame" }],
    });
  });

  test("Kling pro: 1080p", () => {
    expect(clipRequestBody({ prompt: "P", model: "kling", quality: "pro", seconds: 10, firstFrame: FRAME })).toMatchObject({ model: "kwaivgi/kling-v3.0-pro", duration: 10, resolution: "1080p" });
  });

  test("the bytes sent: Kling std, Kling pro and Grok serialise in the probes' key order, generate_audio before the frames (post-review)", () => {
    const frames = `"frame_images":[{"type":"image_url","image_url":{"url":"${FRAME}"},"frame_type":"first_frame"}]`;
    expect(JSON.stringify(clipRequestBody({ prompt: "P", model: "kling", quality: "std", seconds: 5, firstFrame: FRAME }))).toBe(
      `{"model":"kwaivgi/kling-v3.0-std","prompt":"P","duration":5,"resolution":"720p","aspect_ratio":"9:16","generate_audio":false,${frames}}`,
    );
    expect(JSON.stringify(clipRequestBody({ prompt: "P", model: "kling", quality: "pro", seconds: 10, firstFrame: FRAME }))).toBe(
      `{"model":"kwaivgi/kling-v3.0-pro","prompt":"P","duration":10,"resolution":"1080p","aspect_ratio":"9:16","generate_audio":false,${frames}}`,
    );
    expect(JSON.stringify(clipRequestBody({ prompt: "P", model: "grok", quality: "std", seconds: 5, firstFrame: FRAME }))).toBe(
      `{"model":"x-ai/grok-imagine-video-1.5","prompt":"P","duration":5,"resolution":"720p","aspect_ratio":"9:16",${frames}}`,
    );
  });

  test("Grok: 720p and no audio flag at all (its listing has none)", () => {
    const body = clipRequestBody({ prompt: "P", model: "grok", quality: "pro", seconds: 5, firstFrame: FRAME });
    expect(body).toMatchObject({ model: "x-ai/grok-imagine-video-1.5", resolution: "720p", duration: 5, aspect_ratio: "9:16" });
    expect("generate_audio" in body).toBe(false);
  });

  test("the sent model is the priced model: every body names the model and the resolution of V2's VIDEO_TIERS", () => {
    for (const model of ["kling", "grok"] as const) {
      for (const quality of ["std", "pro"] as const) {
        for (const seconds of [5, 10] as const) {
          const body = clipRequestBody({ prompt: "P", model, quality, seconds, firstFrame: FRAME });
          const tier = VIDEO_TIERS[model === "grok" ? "grok" : quality];
          expect({ model: body.model, resolution: body.resolution }).toEqual({ model: tier.model, resolution: tier.resolution });
        }
      }
    }
  });

  test("a first frame that is not a JPEG data URL is refused", () => {
    expect(() => clipRequestBody({ prompt: "P", model: "kling", quality: "std", seconds: 5, firstFrame: "data:image/png;base64,AAAA" })).toThrow();
    expect(() => clipRequestBody({ prompt: "P", model: "kling", quality: "std", seconds: 5, firstFrame: "https://example.com/a.jpg" })).toThrow();
  });
});

describe("the fixtures read the banks (never their words)", () => {
  test("every bank the sweep reads is there", () => {
    expect(Object.keys(BANKS).sort()).toEqual(["beach", "fitness", "glamour", "home", "nightwear", "photoshoot", "travel"]);
  });
});
