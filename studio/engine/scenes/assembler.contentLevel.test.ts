import { describe, expect, test } from "bun:test";
import type { AvatarDescriptor } from "../../shared/engine";
import { templateSentence } from "../../shared/scenes/template";
import { asLibraryReference, JPEG } from "../openrouter/testing/fakes";
import { assembleRun, assembleSlot, AssemblerRefusalError } from "./assembler";
import { slotKeyOf } from "./phoneLook";
import { plan } from "./planner";
import { slotLookOf } from "./roomPlace";
import type { PlanSlot } from "./schema";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.3 (S5.9c, plan s5a3 §5.3, answer (c)): the assembler's last gate reads the slot's content level. On a slot of a «Смелая» category a sentence may say «bikini», «bra» or
// «topless» (only youth words are refused there, with the garment name «babydoll» exempt); on a slot of the five it is held to the revealing words as ever, whatever the slot's mix level.

const DESCRIPTOR: AvatarDescriptor = { age: 25, text: "25-year-old European woman, light olive skin, hazel eyes, shoulder-length wavy chestnut hair, athletic build." };
const MASTER = asLibraryReference(JPEG);
const RUN_ID = "run-content-1";
const OPTIONS = { runId: RUN_ID, lookOf: slotLookOf };

const slotOf = (category: "nightwear" | "beach" | "home", level: "ordinary" | "flirty" | "bold" = "bold"): PlanSlot => {
  const slot = plan({ seed: 11, count: 10, categories: [category], level: category === "home" ? "flirty" : level }).slots[0] as PlanSlot;
  return slot;
};
/** A slot of a «Смелая» category at every mix level, because the gate follows the category and never the level. */
const boldSlots = (category: "nightwear" | "beach"): PlanSlot[] => plan({ seed: 11, count: 10, categories: [category], level: "bold" }).slots;
const BOLD_SENTENCE = "She lies back in a black lace bra and panties, topless under the sheet, in a white string bikini.";

describe("assembleSlot", () => {
  test.each(["nightwear", "beach"] as const)("lets a %s slot say bra, panties, bikini and topless, at every mix level", (category) => {
    const slots = boldSlots(category);
    expect(new Set(slots.map((s) => s.level ?? "ordinary"))).toEqual(new Set(["ordinary", "flirty", "bold"]));
    for (const slot of slots) expect(() => assembleSlot(DESCRIPTOR, slot, BOLD_SENTENCE, MASTER, OPTIONS)).not.toThrow();
  });

  test.each(["nightwear", "beach"] as const)("still refuses a youth word on a %s slot", (category) => {
    const slot = slotOf(category);
    expect(() => assembleSlot(DESCRIPTOR, slot, "A teenage girl in a white string bikini.", MASTER, OPTIONS)).toThrow(AssemblerRefusalError);
  });

  test("refuses a revealing word on a slot of «Дом», flirty or not", () => {
    for (const slot of plan({ seed: 11, count: 10, categories: ["home"], level: "flirty" }).slots) expect(() => assembleSlot(DESCRIPTOR, slot, BOLD_SENTENCE, MASTER, OPTIONS)).toThrow(AssemblerRefusalError);
  });

  // 5a.4 (S5.BA3, 2026-10-26, plan s5a4 I5.73, §7.4, BA2 part 2 review L1): a «Смелая» «Дом» plan is routed and read at the bold content line now. The old control (a «Смелая» «Дом» slot drawn as
  // «Кокетливая», held to the revealing words) is the slot of a set stored before 5a.4: a flirty slot with no route, which a «Смелая» request planned then.
  test("a «Дом» slot stored before 5a.4 (drawn as «Кокетливая» at a «Смелая» request, no route) is held to the revealing words too", () => {
    for (const slot of plan({ seed: 11, count: 10, categories: ["home"], level: "flirty" }).slots) {
      expect(slot.route).toBeUndefined();
      expect(() => assembleSlot(DESCRIPTOR, slot, BOLD_SENTENCE, MASTER, OPTIONS)).toThrow(AssemblerRefusalError);
    }
  });

  test("a «Смелая» «Дом» plan is on the route and read at the bold content line: bra and panties pass, a youth word does not", () => {
    for (const slot of plan({ seed: 11, count: 10, categories: ["home"], level: "bold" }).slots) {
      expect(slot.route).toBe("seedream");
      expect(() => assembleSlot(DESCRIPTOR, slot, BOLD_SENTENCE, MASTER, OPTIONS)).not.toThrow();
      expect(() => assembleSlot(DESCRIPTOR, slot, "A teenage girl in a white string bikini.", MASTER, OPTIONS)).toThrow(AssemblerRefusalError);
    }
  });

  test("the sentence the template writes for a «Смелая» slot passes the gate", () => {
    for (const slot of boldSlots("nightwear")) {
      const sentence = templateSentence(slot, { key: slotKeyOf(RUN_ID, slot.attemptIdBase) });
      expect(sentence).not.toBeNull();
      expect(() => assembleSlot(DESCRIPTOR, slot, sentence as string, MASTER, OPTIONS)).not.toThrow();
    }
  });
});

describe("assembleRun", () => {
  test("ends a «Дом» slot with slot-text-problem and lets the «Смелая» slot of the same run through", () => {
    const home = slotOf("home");
    const bold = { ...(slotOf("nightwear") as PlanSlot), slotIndex: 2, attemptIdBase: "slot-2" };
    const results = assembleRun(DESCRIPTOR, { slots: [home, bold] }, new Map([[home.slotIndex, BOLD_SENTENCE], [bold.slotIndex, BOLD_SENTENCE]]), MASTER, OPTIONS);
    expect(results.map((r) => (r.ok ? "ok" : r.reason))).toEqual(["slot-text-problem", "ok"]);
  });

  test("a «Смелая» slot with a youth word ends slot-text-problem, free", () => {
    const bold = slotOf("beach");
    const [result] = assembleRun(DESCRIPTOR, { slots: [bold] }, new Map([[bold.slotIndex, "A schoolgirl in a bikini."]]), MASTER, OPTIONS);
    expect(result?.ok).toBe(false);
  });
});
