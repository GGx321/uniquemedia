import { describe, expect, test } from "bun:test";
import type { PlanSlot } from "./schema";
import { readWriterAnswer, type WriterAnswer } from "./writer";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.4 (S5.BA4, plan s5a4 §5.3.3, §8 «S5.BA4», I5.71–I5.80): the scene writer's bold mode, the one a custom category's «Смелая» frames are written in.
// Its prompt, its slot JSON, its reader and the coverage appended after the read. The ordinary writer stays byte for byte as it was (writer.test.ts,
// writer.custom.test.ts and sceneSets/floor.test.ts pin it).

const CUSTOM = "cat-fixture-paris-cafes";

/** A custom category's «Смелая» slot as the planner draws it (S5.BA3): on the route, with its world, from the shared «rooms» bank. */
function routed(overrides: Partial<PlanSlot> = {}): PlanSlot {
  return {
    slotIndex: 1,
    category: CUSTOM,
    location: "her room",
    timeOfDay: "evening",
    activity: "lies back across the bed",
    outfit: "a white lace bra and panties",
    shot: "selfie",
    pose: "front",
    attemptIdBase: "slot-1",
    repeatedPair: false,
    capture: "above",
    level: "flirty",
    route: "seedream",
    world: "a cafe terrace in Paris",
    ...overrides,
  };
}

/** The same custom category's slot stored before 5a.4: no route, no world, an everyday outfit. */
function unrouted(overrides: Partial<PlanSlot> = {}): PlanSlot {
  return {
    slotIndex: 1,
    category: CUSTOM,
    location: "a corner cafe",
    timeOfDay: "morning",
    activity: "sips a coffee",
    outfit: "a beige trench coat and jeans",
    shot: "friend",
    pose: "front",
    attemptIdBase: "slot-1",
    repeatedPair: false,
    ...overrides,
  };
}

const answer = (scenes: { slotIndex: number; sentence: string }[]): string => JSON.stringify({ scenes });
const problemsOf = (read: WriterAnswer): string[] => (read.ok ? [] : read.problems);

describe("the reader holds each slot to its own content level (§5.3.3 «The reader»)", () => {
  const LACE = "In her hotel room in Paris, she lies back across the bed in a white lace bra and panties, smiling up at the viewer, a box of macarons on the nightstand.";

  test("«a black lace bra and panties» passes on a routed custom slot", () => {
    const sentence = "In her hotel room in Paris, she lies back across the bed in a black lace bra and panties, smiling up at the viewer, a box of macarons on the nightstand.";
    const read = readWriterAnswer(answer([{ slotIndex: 1, sentence }]), [routed({ outfit: "a black lace bra and panties" })]);
    expect(read.ok).toBe(true);
  });

  test("a nightwear slot is a «Смелая» frame without the route, so its lingerie passes too", () => {
    const read = readWriterAnswer(answer([{ slotIndex: 1, sentence: LACE }]), [routed({ category: "nightwear", route: undefined, world: undefined, location: "her bedroom" })]);
    expect(read.ok).toBe(true);
  });

  test("a youth word is still refused on a routed slot, and refuses the whole answer", () => {
    const read = readWriterAnswer(answer([{ slotIndex: 1, sentence: `${LACE} She looks like a schoolgirl.` }]), [routed()]);
    expect(problemsOf(read)).toEqual(["youth-word"]);
    expect(read.ok === false && read.repair).toBeUndefined();
  });

  test("the babydoll is a garment at «Смелая»: exempt on a routed slot, a youth word on an unrouted one", () => {
    const sentence = "In her hotel room in Paris, she lies back across the bed in a sheer babydoll over a lace set, a box of macarons on the nightstand.";
    expect(readWriterAnswer(answer([{ slotIndex: 1, sentence }]), [routed({ outfit: "a sheer babydoll over a lace set" })]).ok).toBe(true);
    expect(problemsOf(readWriterAnswer(answer([{ slotIndex: 1, sentence }]), [unrouted()]))).toContain("youth-word");
  });

  test("a revealing word on an unrouted custom slot is still refused, as today", () => {
    const read = readWriterAnswer(answer([{ slotIndex: 1, sentence: LACE }]), [unrouted()]);
    expect(problemsOf(read)).toEqual(["revealing-word"]);
    expect(read.ok === false && read.words).toEqual(["bra", "panties"]);
  });

  test("the owner's denim shorts are refused at every level, under our name for them", () => {
    const sentence = "In her hotel room in Paris, she lies back across the bed in denim shorts and a white lace bra, a box of macarons on the nightstand.";
    const read = readWriterAnswer(answer([{ slotIndex: 1, sentence }]), [routed()]);
    expect(problemsOf(read)).toEqual(["revealing-word"]);
    expect(read.ok === false && read.words).toEqual(["denim shorts"]);
  });

  test("in a chunk that holds both, only the unrouted slot is marked; the routed one is kept", () => {
    const read = readWriterAnswer(
      answer([
        { slotIndex: 1, sentence: LACE },
        { slotIndex: 2, sentence: LACE },
      ]),
      [routed({ slotIndex: 1 }), unrouted({ slotIndex: 2 })],
    );
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.repair?.marked).toEqual([2]);
    expect([...(read.repair?.accepted.keys() ?? [])]).toEqual([1]);
  });
});

