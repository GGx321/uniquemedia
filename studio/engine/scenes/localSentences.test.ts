import { describe, expect, test } from "bun:test";
import { BANKS } from "../../shared/scenes/banks";
import type { BankCategory, Moment } from "../../shared/scenes/banks/types";
import { shotOf, type Capture } from "../../shared/scenes/captures";
import type { TemplateSlot } from "../../shared/scenes/template";
import { localSentences } from "./localSentences";

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

  test("returns null for a custom category with no snapshot in the plan", () => {
    const slot = bankSlot(1, { category: "custom:cat-0001" });
    expect(localSentences({ slots: [slot], keyOf })(slot)).toBeNull();
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
});
