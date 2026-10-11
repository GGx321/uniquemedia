import { describe, expect, test } from "bun:test";
import { BANKS, CUES, GAZE } from "../../shared/scenes/banks";
import type { BankCategory, Moment } from "../../shared/scenes/banks/types";
import { shotOf, type Capture } from "../../shared/scenes/captures";
import type { TemplateSlot } from "../../shared/scenes/template";
import { localSentences } from "./localSentences";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// S5.6c1 (plan s5a2 r1.5 §5.4): the template's side of the writer seam. A slot renders only when its place AND its moment are found by name in today's
// banks (m2); anything else is null and goes to the model. The draws are pure functions of the slot's key; an equal sentence in the run is redrawn.

type Slot = TemplateSlot & { slotIndex: number };

function plainMoment(category: BankCategory, open = false): { place: string; moment: Moment; capture: Capture } {
  for (const place of BANKS[category].places.filter((p) => !open || (p.room !== true && p.details.length > 1))) {
    const moment = place.moments.find((m) => m.twoHanded === false && m.angle === undefined && m.level === undefined && m.outfits === undefined && m.gaze === undefined && m.legs === undefined && m.captures.length > 0);
    const capture = moment?.captures[0];
    if (moment !== undefined && capture !== undefined) return { place: place.name, moment, capture };
  }
  throw new Error("no plain moment");
}

function bankSlot(slotIndex: number, extra: Partial<TemplateSlot> = {}, category: BankCategory = "home", open = false): Slot {
  const { place, moment, capture } = plainMoment(category, open);
  return { slotIndex, category, location: place, activity: moment.text, outfit: BANKS[category].outfits.find((o) => o.pinOnly !== true)?.text ?? "", shot: shotOf(capture), capture, pose: "front", ...extra };
}

const keyOf = (slot: Slot): string => `run-00000001:slot-${slot.slotIndex}`;

describe("localSentences carries «Подача» (S5.7b)", () => {
  const flirtyCues = CUES.filter((c) => c.level === "flirty").map((c) => c.text);
  const flirtyGaze = GAZE.filter((g) => g.level === "flirty").map((g) => g.text);
  const saysFlirty = (text: string | null): boolean => flirtyCues.some((c) => (text ?? "").includes(c)) || flirtyGaze.some((g) => (text ?? "").includes(g));

  test("a flirty slot says a flirty cue or gaze, and an ordinary slot of the same list says none", () => {
    const flirty = bankSlot(1, { level: "flirty" }, "glamour", true);
    const ordinary = bankSlot(2, {}, "glamour", true);
    const local = localSentences({ slots: [flirty, ordinary], keyOf });
    expect(saysFlirty(local(flirty))).toBe(true);
    expect(saysFlirty(local(ordinary))).toBe(false);
  });
});

describe("localSentences", () => {
  test("renders a slot whose place and moment are in the banks", () => {
    const slot = bankSlot(1);
    const text = localSentences({ slots: [slot], keyOf })(slot);
    expect(text).toContain("she " + slot.activity);
  });

  test("returns null for a place the banks do not have", () => {
    const slot = bankSlot(1, { location: "a place renamed since this plan was made" });
    expect(localSentences({ slots: [slot], keyOf })(slot)).toBeNull();
  });

  test("returns null for a moment the place does not have", () => {
    const slot = bankSlot(1, { activity: "doing something no bank ever listed" });
    expect(localSentences({ slots: [slot], keyOf })(slot)).toBeNull();
  });

  const CUSTOM = "cat-paris-cafes";
  const customSlot = (): Slot => ({ slotIndex: 1, category: CUSTOM, location: "a corner cafe in Paris", activity: "reading a menu", outfit: "a beige trench coat", shot: "friend", pose: "front" });

  test("returns null for a custom category with no snapshot in the plan", () => {
    const slot = customSlot();
    expect(localSentences({ slots: [slot], keyOf })(slot)).toBeNull();
  });

  test("renders a custom slot whose category the plan holds a snapshot of", () => {
    const slot = customSlot();
    expect(localSentences({ slots: [slot], keyOf, snapshots: [{ ref: CUSTOM }] })(slot)).toContain("she is reading a menu");
  });

  test("returns null for a slot it was not given", () => {
    expect(localSentences({ slots: [], keyOf })(bankSlot(9))).toBeNull();
  });

  test("renders the same text for the same key on a second call (a resume)", () => {
    const slots = [bankSlot(1), bankSlot(2), bankSlot(3)];
    const first = localSentences({ slots, keyOf });
    const second = localSentences({ slots, keyOf });
    expect(slots.map(first)).toEqual(slots.map(second));
  });

  test("answers the same text each time it is asked about a slot", () => {
    const slots = [bankSlot(1), bankSlot(2)];
    const local = localSentences({ slots, keyOf });
    expect(local(slots[1] as Slot)).toBe(local(slots[1] as Slot));
  });

  test("redraws a slot whose sentence an earlier slot of the run already has", () => {
    // Twelve slots of one place, one moment, one outfit: only the draws differ, and one draw key: without the redraw every sentence would be equal.
    const slots = Array.from({ length: 12 }, (_, i) => bankSlot(i + 1, {}, "glamour", true));
    const sameKey = (): string => "run-00000001:slot-1";
    const texts = slots.map(localSentences({ slots, keyOf: sameKey }));
    expect(new Set(texts).size).toBeGreaterThan(1);
  });

  test("does not redraw against the sentences of slots after it: a slot's text does not depend on a later slot", () => {
    const slots = Array.from({ length: 6 }, (_, i) => bankSlot(i + 1));
    const all = localSentences({ slots, keyOf });
    const head = localSentences({ slots: slots.slice(0, 3), keyOf });
    expect(slots.slice(0, 3).map(head)).toEqual(slots.slice(0, 3).map(all));
  });

  test("redraws a slot whose sentence is one the set already holds", () => {
    const slot = bankSlot(1, {}, "glamour", true);
    const alone = localSentences({ slots: [slot], keyOf })(slot);
    const against = localSentences({ slots: [slot], keyOf, seen: [alone ?? ""] })(slot);
    expect(alone).not.toBeNull();
    expect(against).not.toBeNull();
    expect(against).not.toBe(alone);
  });
});

// S5.6R (round C): the same expression came back 3 times or more in 499 of 500 twenty-photo runs, and the same gaze in 464. A gaze or an expression (cue) is
// drawn at most twice in any 20 sentences in a row of a run; the draws stay hash picks of the slot's key, so a resume renders the same text.
describe("localSentences: a gaze or an expression at most twice in 20 photos", () => {
  const VOICES = [...GAZE, ...CUES].map((v) => v.text);
  /** The most times one gaze or one expression is said in the sentences. */
  const mostSaid = (texts: readonly (string | null)[]): number => Math.max(0, ...VOICES.map((voice) => texts.filter((t) => t?.includes(voice) === true).length));
  // A friend's photo of an open place: a gaze and a cue in every sentence, from 10 gazes and 9 expressions.
  const runOf = (n: number): Slot[] => Array.from({ length: n }, (_, i) => bankSlot(i + 1, {}, "glamour", true));

  test("the run holds a gaze and an expression in every sentence", () => {
    const slots = runOf(20);
    const texts = slots.map(localSentences({ slots, keyOf }));
    expect(texts.every((t) => GAZE.some((g) => t?.includes(g.text) === true) && CUES.some((c) => t?.includes(c.text) === true))).toBe(true);
  });

  test("a 20-photo run says no gaze and no expression three times", () => {
    const slots = runOf(20);
    expect(mostSaid(slots.map(localSentences({ slots, keyOf })))).toBeLessThanOrEqual(2);
  });

  test("a 60-photo run says none of them three times in any 20 photos in a row", () => {
    const slots = runOf(60);
    const texts = slots.map(localSentences({ slots, keyOf }));
    const windows = Array.from({ length: texts.length - 19 }, (_, i) => mostSaid(texts.slice(i, i + 20)));
    expect(Math.max(...windows)).toBeLessThanOrEqual(2);
  });

  test("a resume renders the same capped text", () => {
    const slots = runOf(40);
    expect(slots.map(localSentences({ slots, keyOf }))).toEqual(slots.map(localSentences({ slots, keyOf })));
  });
});
