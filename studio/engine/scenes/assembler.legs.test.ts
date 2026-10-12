import { describe, expect, test } from "bun:test";
import { youthWords, type AvatarDescriptor } from "../../shared/engine";
import { BANKS } from "../../shared/scenes/banks";
import { categoryBankProblems } from "../../shared/scenes/banks/schema";
import { captureOfShot, shotOf, type Capture } from "../../shared/scenes/captures";
import { templateSentence } from "../../shared/scenes/template";
import { YOUTH_PROPS } from "../../shared/scenes/words";
import { asLibraryReference, JPEG } from "../openrouter/testing/fakes";
import { assembleRun, assembleSlot, AssemblerRefusalError, BINDING_ANCHOR, NO_FACE_ANCHOR, POSE_PHRASE } from "./assembler";
import { hairLinesOf } from "./hairLines";
import { captureLineOf, CONSTRAINTS, hairLine, phoneHandLineOf, slotKeyOf } from "./phoneLook";
import { plan } from "./planner";
import { slotLookOf } from "./roomPlace";
import type { PlanSlot } from "./schema";
import { revealingWordsIn } from "./words";
import { CATEGORIES, type Category } from "./types";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.2c (S5.8a, plan s5a2 §7.2): the legs lines, the legs frame's pose phrase, the body binding on whatever the shot, no hair line on a legs slot, feet that render
// and stockings that are refused. The lines are the plan's, word for word.

const DESCRIPTOR: AvatarDescriptor = { age: 25, text: "25-year-old European woman, light olive skin, hazel eyes, shoulder-length wavy chestnut hair, athletic build." };
const WITH_BODY: AvatarDescriptor = { ...DESCRIPTOR, body: "a slim build with narrow hips" };
const MASTER = asLibraryReference(JPEG);
const RUN_ID = "run-legs-1";
const BODY_BINDING = ", and her exact body proportions as described";
const LEGS_POSE_PHRASE = "Her legs fill most of the frame; her face may be out of frame.";

const POV_LEGS_LINE = "A photo she took looking down along her own legs from where she lies or sits, held at her eye level; nothing in her hand can be seen.";
const LOW_FEET_LINE = "A quick phone photo a friend took of her, crouching a couple of metres away, low down near her feet; both of her hands are empty; she is not taking the photo herself.";

const legsSlots = (category: Category, seed: number, count = 20): PlanSlot[] => plan({ seed, count, categories: [category], legsShare: 30 }).slots.filter((s) => s.framing === "legs");
const SLOTS: PlanSlot[] = CATEGORIES.flatMap((c) => [1, 2, 3, 4, 5].flatMap((seed) => legsSlots(c, seed * 31)));
const sentenceOf = (slot: PlanSlot): string => templateSentence(slot, { key: slotKeyOf(RUN_ID, slot.attemptIdBase) }) ?? "It is a plain sentence.";
const assemble = (slot: PlanSlot, descriptor: AvatarDescriptor = DESCRIPTOR, hair?: string): string =>
  assembleSlot(descriptor, slot, sentenceOf(slot), MASTER, { runId: RUN_ID, lookOf: slotLookOf, ...(hair === undefined ? {} : { hairStyleOf: () => hair }) }).prompt;
const captureOf = (slot: PlanSlot): Capture => slot.capture ?? captureOfShot(slot.shot);

describe("the legs lines (plan s5a2 §7.2)", () => {
  test("the pov-legs line, verbatim", () => {
    expect(captureLineOf("pov-legs", "any-key")).toBe(POV_LEGS_LINE);
  });

  test("the low-feet line, verbatim: the friend crouches a couple of metres away and both of her hands are empty", () => {
    expect(captureLineOf("low-feet", "any-key")).toBe(LOW_FEET_LINE);
  });

  test("a pov-legs prompt opens with its line, and its hand line says nothing is in her hand", () => {
    const slot = SLOTS.find((s) => captureOf(s) === "pov-legs");
    expect(slot).toBeDefined();
    if (slot === undefined) return;
    expect(assemble(slot).startsWith(POV_LEGS_LINE)).toBe(true);
    expect(phoneHandLineOf("pov-legs")).toBe("Her phone arm is out of the frame; her other hand is free and holds nothing.");
    expect(assemble(slot).endsWith(`${CONSTRAINTS} ${phoneHandLineOf("pov-legs")}`)).toBe(true);
  });

  test("a low-feet prompt opens with its line and has no phone-hand line: someone else took the photo", () => {
    const slot = SLOTS.find((s) => captureOf(s) === "low-feet");
    expect(slot).toBeDefined();
    if (slot === undefined) return;
    expect(assemble(slot).startsWith(LOW_FEET_LINE)).toBe(true);
    expect(phoneHandLineOf("low-feet")).toBeNull();
  });
});

describe("the legs frame's pose phrase", () => {
  test("every legs prompt carries the pose phrase «Her legs fill most of the frame; her face may be out of frame.»", () => {
    expect(SLOTS.length).toBeGreaterThan(30);
    for (const slot of SLOTS) expect(assemble(slot), `${slot.location} | ${slot.activity}`).toContain(` ${LEGS_POSE_PHRASE} `);
  });

  test("a legs prompt never claims her face is clearly visible, whatever the pose", () => {
    for (const slot of SLOTS) {
      const prompt = assemble(slot);
      for (const phrase of Object.values(POSE_PHRASE)) expect(prompt, slot.activity).not.toContain(phrase);
      expect(prompt).not.toContain("face clearly visible");
    }
  });

  test("an ordinary slot keeps its own pose phrase and never the legs one", () => {
    const ordinary = plan({ seed: 9, count: 30, categories: [...CATEGORIES], legsShare: 30 }).slots.filter((s) => s.framing === undefined);
    for (const slot of ordinary.slice(0, 40)) expect(assemble(slot)).not.toContain(LEGS_POSE_PHRASE);
  });
});

describe("the binding of a legs frame", () => {
  test("the body binding is on whatever the shot, when the avatar has a body", () => {
    const shots = new Set(SLOTS.map((s) => captureOf(s)));
    expect([...shots].sort()).toEqual(["low-feet", "mirror-hidden", "pov-legs"]);
    for (const slot of SLOTS) expect(assemble(slot, WITH_BODY), `${captureOf(slot)} ${slot.activity}`).toContain(BODY_BINDING);
  });

  test("and absent when the avatar has no body: the prompt is the one it was", () => {
    for (const slot of SLOTS) expect(assemble(slot, DESCRIPTOR)).not.toContain(BODY_BINDING);
  });

  test("a legs frame binds by the same woman: a frame without her face on hair, build and skin tone; one that may show it on her face as the pose says", () => {
    for (const slot of SLOTS) {
      const prompt = assemble(slot);
      if (captureOf(slot) === "low-feet") expect(prompt).toContain(BINDING_ANCHOR[slot.pose]);
      else expect(prompt).toContain(NO_FACE_ANCHOR);
    }
  });

  test("a legs slot of a capture that never had the body binding (a close selfie from above) still gets it: the binding follows the framing", () => {
    const base = SLOTS.find((s) => captureOf(s) === "pov-legs");
    expect(base).toBeDefined();
    if (base === undefined) return;
    const asSelfie: PlanSlot = { ...base, shot: "selfie" };
    const { capture: _capture, ...plain } = asSelfie;
    expect(assemble(plain, WITH_BODY)).toContain(BODY_BINDING);
  });
});

describe("no hair line on a legs slot", () => {
  test("hairLinesOf leaves a legs slot out and gives the other slots their styles", () => {
    for (const seed of [3, 7, 11]) {
      const slots = plan({ seed, count: 30, categories: [...CATEGORIES], legsShare: 30 }).slots;
      const lines = hairLinesOf(slots, "long", `run-${seed}`);
      const legs = slots.filter((s) => s.framing === "legs");
      expect(legs.length).toBeGreaterThan(5);
      for (const slot of legs) expect(lines.has(slot.slotIndex)).toBe(false);
      expect(slots.filter((s) => s.framing !== "legs" && lines.has(s.slotIndex)).length).toBeGreaterThan(5);
    }
  });

  test("the prompt of a legs slot carries no hair line, even when one is offered", () => {
    const slot = SLOTS[0];
    expect(slot).toBeDefined();
    if (slot === undefined) return;
    expect(assemble(slot, DESCRIPTOR, "in a low ponytail")).not.toContain(hairLine("in a low ponytail"));
    const ordinary = plan({ seed: 9, count: 12, categories: ["home"] }).slots.find((s) => s.framing === undefined);
    expect(ordinary).toBeDefined();
    if (ordinary !== undefined) expect(assemble(ordinary, DESCRIPTOR, "in a low ponytail")).toContain(hairLine("in a low ponytail"));
  });
});

describe("feet render and stockings are refused", () => {
  test("every legs moment of every bank renders a sentence at some outfit that shows her legs", () => {
    for (const category of CATEGORIES) {
      for (const place of BANKS[category].places) {
        for (const moment of place.moments.filter((m) => m.legs !== undefined)) {
          const outfit = (moment.outfits ?? BANKS[category].outfits.filter((o) => o.showsLegs === true && o.pinOnly !== true).map((o) => o.text))[0];
          const capture = moment.captures[0];
          expect(outfit).toBeDefined();
          expect(capture).toBeDefined();
          if (outfit === undefined || capture === undefined) continue;
          const slot = { category, location: place.name, activity: moment.text, outfit, shot: shotOf(capture), capture, pose: moment.angle ?? ("front" as const), framing: "legs" as const };
          const sentence = templateSentence(slot, { key: "feet" });
          expect(sentence, `${category} | ${place.name} | ${moment.text}`).not.toBeNull();
          expect(sentence).toContain(moment.text);
        }
      }
    }
  });

  test("a legs slot with a legwear item the bank does not hold renders nothing: stockings are not in the bank", () => {
    const slot = SLOTS.find((s) => s.category === "home" && s.activity === "stretches her legs along the bed");
    expect(slot).toBeDefined();
    if (slot === undefined) return;
    expect(templateSentence({ ...slot, legwear: "black stockings" }, { key: "k" })).toBeNull();
    expect(templateSentence({ ...slot, legwear: "sheer black tights" }, { key: "k" })).not.toBeNull();
  });

  test("a sentence that names stockings never reaches an image: the assembler ends the slot as a word-rule problem", () => {
    const slot = SLOTS[0];
    expect(slot).toBeDefined();
    if (slot === undefined) return;
    expect(() => assembleSlot(DESCRIPTOR, slot, "On her bed, she stretches her legs in black stockings.", MASTER, { runId: RUN_ID })).toThrow(AssemblerRefusalError);
    const [result] = assembleRun(DESCRIPTOR, { slots: [slot] }, new Map([[slot.slotIndex, "She wears thigh-high stockings."]]), MASTER, { runId: RUN_ID });
    expect(result?.ok).toBe(false);
  });

  test("a bank that offers stockings as legwear is refused at load: they wait for «Смелая» (5a.3)", () => {
    const home = { ...BANKS.home, legwear: { items: ["white knee-high socks", "black stockings"], share: 0.4 } };
    expect(categoryBankProblems(home, "home").join("\n")).toMatch(/\[legwear\][^\n]*stocking/i);
    expect(categoryBankProblems({ ...BANKS.home, legwear: { items: ["thigh-high stockings"], share: 0.4 } }, "home").length).toBeGreaterThan(0);
  });
});

describe("K-17 on the legs frames: the legwear that came back, and what stays out", () => {
  test.each(["white knee-high socks", "black knee-high socks", "thigh-high socks", "sheer black tights"])("«%s» is allowed legwear", (item) => {
    expect(categoryBankProblems({ ...BANKS.home, legwear: { items: [item], share: 0.4 } }, "home")).toEqual([]);
    expect(revealingWordsIn(item)).toEqual([]);
    expect(youthWords(item, "descriptor")).toEqual([]);
  });

  test.each(["striped thigh-highs", "striped thigh highs", "plush slippers", "teddy bear socks", "gaming controller", "swinging her legs", "pigtails", "two braids", "space buns"])("«%s» stays out as a youth prop", (text) => {
    expect(YOUTH_PROPS.test(text)).toBe(true);
  });

  test("a bank that offers striped thigh-highs as legwear is refused", () => {
    expect(categoryBankProblems({ ...BANKS.home, legwear: { items: ["striped thigh-highs"], share: 0.4 } }, "home").join("\n")).toMatch(/\[youth-prop\]/);
  });

  test("a legs sentence, motion and prompt of the sweep carry no youth prop, no youth word and no revealing word", () => {
    for (const slot of SLOTS) {
      for (const said of [slot.activity, sentenceOf(slot), assemble(slot, WITH_BODY)]) {
        expect(YOUTH_PROPS.test(said), said).toBe(false);
        expect(youthWords(said, "descriptor"), said).toEqual([]);
        expect(revealingWordsIn(said), said).toEqual([]);
      }
    }
  });
});
