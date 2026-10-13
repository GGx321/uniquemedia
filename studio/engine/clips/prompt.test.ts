import { describe, expect, test } from "bun:test";
import { BANKS } from "../../shared/scenes/banks";
import type { OwnPlanSlot, PlanSlot } from "../scenes/schema";
import { shotOf } from "../../shared/scenes/captures";
import { CUSTOM_REF } from "../scenes/testing/customPool";
import { frameFactsOf, type FrameFacts, type FrameFactsResult } from "./frameFacts";
import { VIDEO_TIERS } from "../money/prices";
import { clipPromptOf, clipRequestBody, poseSentenceFor } from "./prompt";
import { ADULT_LINE, COMES_OFF_LINE, CONTINUITY_LINE, LEGS_LINE, LOOK_LINE, PRONE_ANCHOR, PROMPT_WORDS_MAX, SLOW_LINE, cameraLineOf, legwearLineOf, wordCount, type ClipDialect } from "./videoLook";
import { photoOf, pick, planlessPhoto, sceneRun, slotOf } from "./testing/frameFixtures";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.1, S5.V5 (plan s5b1 §5.5, I5.51, I5.57): the clip prompt is code. In order: the camera line, the pose sentence (the slot's activity), the motion sentence, the
// prone anchor, the legs line, the continuity line, the legwear line, the pacing, the look, and «She is an adult woman.». It carries no outfit text. The three prompts probe P-V
// ran on frames of «Смелая» (2026-10-13, 3 of 3 completed, accepted by the owner) are pinned word for word: the builder must still write them.

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
  const result = clipPromptOf(facts, motion, dialect);
  if (!result.ok) throw new Error(`no prompt: ${result.problems.join("; ")}`);
  return result.prompt;
}

/** A custom category's slot (the test kit's «Кофейни Парижа») on `capture`, with a pool activity of its own and no bank moment. */
function customSlot(capture: "friend" | "selfie" | "timer", activity: string): PlanSlot {
  const { level: _level, ...base } = slotOf(pick("travel", (m) => m.captures.includes("friend")), "friend");
  return { ...base, category: CUSTOM_REF, location: "a riverside cafe", activity, outfit: "a linen dress", shot: shotOf(capture), capture };
}

const sceneMotion = (facts: FrameFacts): string => {
  if (facts.moment === null) throw new Error("no bank moment");
  return facts.moment.motion;
};

describe("the prompts probe P-V ran (2026-10-13), word for word", () => {
  test("S1: «Пляж и бассейн», candid, steps out of the water", () => {
    const facts = factsFor(slotOf(pick("beach", (m) => m.text === "steps out of the water"), "candid", "front", { level: "bold" }));
    expect(promptOf(facts, sceneMotion(facts))).toBe(
      "Handheld by a friend who stays at the same distance, gentle sway, the framing drifts only a little. The adult woman steps out of the water. Over the whole clip she keeps walking slowly. Nothing new appears, and nothing she holds or wears changes. Slow, gentle, unhurried, real-time speed; no fast or abrupt movements, no sudden gestures. Vertical phone video, slight noise, everything in focus. No text on screen. She is an adult woman.",
    );
  });

  test("S2: «Ночнушки и бельё», a selfie from above, one knee up", () => {
    const facts = factsFor(slotOf(pick("nightwear", (m) => m.text === "lies back, one knee up"), "above"));
    expect(promptOf(facts, sceneMotion(facts))).toBe(
      "A selfie at arm's length: the camera stays in her outstretched hand the whole time. The adult woman lies back, one knee up. Over the whole clip she sways her knee a little. Nothing new appears, and nothing she holds or wears changes. Slow, gentle, unhurried, real-time speed; no fast or abrupt movements, no sudden gestures. Vertical phone video, slight noise, everything in focus. No text on screen. She is an adult woman.",
    );
  });

  test("S3: «Ночнушки и бельё», a mirror selfie, one hand on her hip", () => {
    const facts = factsFor(slotOf(pick("nightwear", (m) => m.text === "stands with one hand on her hip"), "mirror"));
    expect(promptOf(facts, sceneMotion(facts))).toBe(
      "A mirror selfie: the phone stays in her raised hand the whole time and sways only a little. The adult woman stands with one hand on her hip. Over the whole clip she turns her hips a little. Nothing new appears, and nothing she holds or wears changes. Slow, gentle, unhurried, real-time speed; no fast or abrupt movements, no sudden gestures. Vertical phone video, slight noise, everything in focus. No text on screen. She is an adult woman.",
    );
  });
});

describe("the prompt's shape (§5.5)", () => {
  test("the prone example of the plan: the camera, the pose, the motion, the anchor, the continuity, the pacing, the look, the adult line", () => {
    const facts = factsFor(slotOf(pick("home", (m) => m.captures.includes("prone") && /\bhips\b/.test(m.motion)), "prone"));
    expect(promptOf(facts, sceneMotion(facts))).toBe(
      [
        cameraLineOf("prone", "kling"),
        `The adult woman ${facts.activity}.`,
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

describe("the pose sentence (§5.5 item 2)", () => {
  test("a bank moment: «The adult woman {activity}.»", () => {
    const facts = factsFor(slotOf(pick("travel", (m) => m.captures.includes("friend") && m.legs === undefined), "friend"));
    expect(poseSentenceFor(facts)).toBe(`The adult woman ${facts.activity}.`);
  });

  test("an «-ing» pool activity of a custom category: «… is …»", () => {
    const facts = factsFor(customSlot("friend", "reading a paperback"), "A friend took this. At a riverside cafe, she is reading a paperback, wearing a linen dress.");
    expect(poseSentenceFor(facts)).toBe("The adult woman is reading a paperback.");
  });

  test("an activity that names her phone on an arm's-length or propped capture is left out", () => {
    const prompt = "At a riverside cafe, she is texting on her phone, wearing a linen dress.";
    expect(poseSentenceFor(factsFor(customSlot("selfie", "texting on her phone"), prompt))).toBeNull();
    expect(poseSentenceFor(factsFor(customSlot("timer", "texting on her phone"), prompt))).toBeNull();
  });

  test("the same activity on a friend's photo stays", () => {
    const prompt = "At a riverside cafe, she is texting on her phone, wearing a linen dress.";
    expect(poseSentenceFor(factsFor(customSlot("friend", "texting on her phone"), prompt))).toBe("The adult woman is texting on her phone.");
  });

  test("an activity with a video word, or one that is neither a verb phrase nor an «-ing» phrase, is left out", () => {
    expect(poseSentenceFor(factsFor(customSlot("friend", "posing for a film crew"), "At a riverside cafe, she is posing for a film crew, wearing a linen dress."))).toBeNull();
    expect(poseSentenceFor(factsFor(customSlot("friend", "a picnic by the river"), "At a riverside cafe, she is enjoying a picnic by the river, wearing a linen dress."))).toBeNull();
  });

  test("an own scene and a photo with no plan have no activity, so no pose sentence", () => {
    const run = sceneRun("run-00000202", [{ kind: "own", shot: "friend", pose: "front", text: "She waves from a boat." }]);
    expect(poseSentenceFor(factsOf(frameFactsOf(photoOf(run, run.scenes.slots[0] as OwnPlanSlot), run)))).toBeNull();
    expect(poseSentenceFor(factsOf(frameFactsOf(planlessPhoto("home", { faceCos: 0.7 }), null)))).toBeNull();
  });
});

describe("the content level follows the category (I5.51, I5.57)", () => {
  const bold = pick("nightwear", (m) => m.level === "bold" && /\bpanties\b/.test(m.text));

  test("a «Смелая» moment's activity passes at bold", () => {
    const facts = factsFor(slotOf(bold, bold.moment.captures[0] ?? "mirror-hidden", bold.moment.angle ?? "front"));
    expect(poseSentenceFor(facts)).toBe(`The adult woman ${bold.moment.text}.`);
  });

  test("the same words on a «Дом» slot fail, and leave the pose sentence out", () => {
    const home = pick("home", (m) => m.captures.includes("mirror-hidden") && m.legs === undefined);
    const slot = { ...slotOf(home, "mirror-hidden"), activity: bold.moment.text };
    const facts = factsFor(slot, `In her bedroom, she ${bold.moment.text}, wearing a grey tee.`);
    expect(facts.activity).toBe(bold.moment.text);
    expect(poseSentenceFor(facts)).toBeNull();
  });

  test("a youth word fails everywhere, «Смелая» included", () => {
    const beach = pick("beach", (m) => m.captures.includes("friend") && m.legs === undefined);
    const youthful = "sits like a teen on the sand";
    for (const category of ["home", "beach"] as const) {
      const slot = { ...slotOf(beach, "friend"), category, activity: youthful, level: undefined };
      expect(poseSentenceFor(factsFor(slot, `On the beach, she ${youthful}, wearing a sundress.`))).toBeNull();
      expect(clipPromptOf(factsFor(slot, `On the beach, she ${youthful}, wearing a sundress.`), "she sits like a teen a little", "kling").ok).toBe(false);
    }
  });
});

describe("the anchors (§5.5 items 4-6)", () => {
  test("the prone anchor on a prone and an over-shoulder capture, and on an «on her stomach» activity elsewhere", () => {
    const prone = factsFor(slotOf(pick("home", (m) => m.captures.includes("prone")), "prone"));
    const over = factsFor(slotOf(pick("home", (m) => m.captures.includes("over-shoulder")), "over-shoulder", "three-quarter"));
    const mirror = factsFor(slotOf(pick("home", (m) => m.captures.includes("mirror-hidden") && /on her stomach/.test(m.text)), "mirror-hidden"));
    for (const facts of [prone, over, mirror]) expect(promptOf(facts, sceneMotion(facts))).toContain(PRONE_ANCHOR);
  });

  test("never elsewhere", () => {
    const timer = factsFor(slotOf(pick("home", (m) => m.captures.includes("timer") && !/stomach|prone/.test(m.text)), "timer"));
    expect(promptOf(timer, sceneMotion(timer))).not.toContain(PRONE_ANCHOR);
  });

  test("a «Ножки» frame by the mirror says only that her legs fill the frame: the phone already covers her face (round 2)", () => {
    const legs = factsFor(slotOf(pick("home", (m) => m.captures.includes("mirror-hidden") && m.legs?.framing === "legs"), "mirror-hidden"));
    const prompt = promptOf(legs, sceneMotion(legs));
    expect(prompt).toContain("Her legs fill most of the frame the whole time.");
    expect(prompt).not.toContain(LEGS_LINE);
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
    expect(clipPromptOf(facts, "slowly she turns", "kling").ok).toBe(false);
  });

  test("a motion with a staging or video word is refused", () => {
    expect(clipPromptOf(facts, "she turns as the camera zooms in slowly", "kling").ok).toBe(false);
    expect(clipPromptOf(facts, "she turns slowly in a cinematic orbit", "kling").ok).toBe(false);
  });

  test("a revealing word is refused on an ordinary frame", () => {
    expect(clipPromptOf(facts, "she adjusts her bra strap slowly", "kling").ok).toBe(false);
  });

  test("a motion that names a phone on a propped capture is refused", () => {
    expect(clipPromptOf(facts, "she checks her phone slowly", "kling").ok).toBe(false);
  });

  test("a motion that moves her face is refused where the photo does not show it (the face cover, a legs frame), and kept where it does", () => {
    const hidden = factsFor(slotOf(pick("home", (m) => m.captures.includes("mirror-hidden") && m.legs === undefined), "mirror-hidden"));
    const legs = factsFor(slotOf(pick("photoshoot", (m) => m.captures.includes("low-feet")), "low-feet"));
    for (const motion of ["she sips and smiles a little", "she slowly blinks and smiles", "she presses her lips together a bit", "she laughs a little"]) {
      expect(clipPromptOf(hidden, motion, "kling").ok).toBe(false);
      expect(clipPromptOf(legs, motion, "kling").ok).toBe(false);
      expect(clipPromptOf(facts, motion, "kling").ok).toBe(true);
    }
    expect(clipPromptOf(hidden, "she turns her head a little", "kling").ok).toBe(true);
  });

  test("every prompt carries the pacing line and ends with the adult line, within the cap", () => {
    const result = clipPromptOf(facts, sceneMotion(facts), "kling");
    if (!result.ok) throw new Error(result.problems.join("; "));
    expect(result.prompt).toContain(SLOW_LINE);
    expect(result.prompt.endsWith(ADULT_LINE)).toBe(true);
    expect(result.words).toBe(wordCount(result.prompt));
    expect(result.words).toBeLessThanOrEqual(PROMPT_WORDS_MAX);
  });

  test("a pov-legs frame over the cap takes the short camera line, never losing an anchor", () => {
    const legs = pick("home", (m) => m.captures.includes("pov-legs") && m.noLegwear !== true && !/\b(socks?|socked|bare)\b/.test(m.text));
    const long = factsFor(slotOf(legs, "pov-legs", "front", { legwear: "white lace-top stockings" }));
    const motion = "she stretches her toes toward the far end of the bed a little";
    const result = clipPromptOf(long, motion, "kling");
    if (!result.ok) throw new Error(result.problems.join("; "));
    expect(result.words).toBeLessThanOrEqual(PROMPT_WORDS_MAX);
    expect(result.prompt).toContain(LEGS_LINE);
    expect(result.prompt).toContain(legwearLineOf("white lace-top stockings"));
    expect(result.prompt).not.toContain(cameraLineOf("pov-legs", "kling"));
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
