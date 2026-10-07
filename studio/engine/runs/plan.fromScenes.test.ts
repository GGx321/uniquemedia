import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { plan } from "../scenes";
import { foldRun } from "./journal";
import { buildSceneRunPlan, RunPlanSchema, type NewSceneRunPlan, type RunPlan } from "./plan";
import { remainingPlan } from "./remaining";
import { PriceBook } from "../money/prices";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// CS.5: a run made from a reviewed scene set. Its plan carries the sentences the set already holds, so it has no writer chunks and no `request`; the
// invariant `sceneSetId` <=> every slot has a sentence <=> `writerChunks: []` is the schema's own, so no document can be a mixed plan.

const MODELS = { imageModel: "x-ai/grok-imagine-image-2.0", textModel: "x-ai/grok-4.3" };
const SENTENCE = "A friend catches her mid-laugh at the kitchen counter as morning light spills across the table.";
const planned = plan({ seed: 11, count: 5, categories: ["home"] }).slots;

/** The set's scenes after one removal: ids 1, 3, 4, 5 (scene 2 was removed), each with its text. */
function scenes(): NewSceneRunPlan["scenes"] {
  return [1, 3, 4, 5].map((sceneId) => ({ sceneId, text: `${SENTENCE} (${sceneId})`, slot: planned[sceneId - 1]! }));
}

function input(over: Partial<NewSceneRunPlan> = {}): NewSceneRunPlan {
  return {
    runId: "run-00000001",
    avatarId: "avatar-0001",
    createdAt: "2026-10-07T12:00:00.000Z",
    sceneSetId: "set-00000001",
    imageAgeCheck: "off",
    models: MODELS,
    capMicros: 1_000_000,
    plannedWorstMicros: 1_000_000,
    scenes: scenes(),
    ...over,
  };
}

/** The built plan as the plain JSON a file holds, for a test to damage. */
function json(over: Partial<NewSceneRunPlan> = {}): Record<string, unknown> {
  return JSON.parse(JSON.stringify(buildSceneRunPlan(input(over))));
}

function slotsOf(doc: Record<string, unknown>): Record<string, unknown>[] {
  return (doc.scenes as { slots: Record<string, unknown>[] }).slots;
}

describe("buildSceneRunPlan", () => {
  test("numbers the active scenes 1..M in the set's order, whatever their scene ids", () => {
    const built = buildSceneRunPlan(input());
    expect(built.scenes.slots.map((s) => s.slotIndex)).toEqual([1, 2, 3, 4]);
    expect(built.scenes.slots.map((s) => s.attemptIdBase)).toEqual(["slot-1", "slot-2", "slot-3", "slot-4"]);
    expect(built.slotAttempts.map((s) => s.slotIndex)).toEqual([1, 2, 3, 4]);
  });

  test("keeps the scene id of each slot, for the UI and the history", () => {
    expect(buildSceneRunPlan(input()).sceneIds).toEqual([1, 3, 4, 5]);
  });

  test("carries each scene's own text as the slot's sentence, and the place the planner drew", () => {
    const built = buildSceneRunPlan(input());
    expect(built.scenes.slots.map((s) => s.sentence)).toEqual([1, 3, 4, 5].map((id) => `${SENTENCE} (${id})`));
    expect(built.scenes.slots[1]).toMatchObject({ category: planned[2]!.category, location: planned[2]!.location, outfit: planned[2]!.outfit, shot: planned[2]!.shot, pose: planned[2]!.pose });
  });

  test("has no writer chunks, no request, and names its set", () => {
    const built = buildSceneRunPlan(input());
    expect(built.writerChunks).toEqual([]);
    expect(built.sceneSetId).toBe("set-00000001");
    expect("request" in built).toBe(false);
  });

  test("allocates every slot's attempt ids under the run id, as any run does", () => {
    const built = buildSceneRunPlan(input());
    expect(built.slotAttempts[0]?.attemptIds[0]).toBe("run-00000001:slot-1#1");
    expect(built.slotAttempts).toHaveLength(4);
  });

  test("a 700-char writer sentence reaches the plan whole", () => {
    const long = `${SENTENCE} ${"She keeps laughing as the light moves across the room. ".repeat(12)}`.trim().slice(0, 700);
    expect(long).toHaveLength(700);
    const built = buildSceneRunPlan(input({ scenes: [{ sceneId: 1, text: long, slot: planned[0]! }] }));
    expect(built.scenes.slots[0]?.sentence).toBe(long);
    expect(RunPlanSchema.parse(JSON.parse(JSON.stringify(built))).scenes.slots[0]?.sentence).toHaveLength(700);
  });

  test("a scene with empty text is refused, never planned", () => {
    expect(() => buildSceneRunPlan(input({ scenes: [{ sceneId: 1, text: "", slot: planned[0]! }] }))).toThrow();
  });

  test("an own scene becomes a slot with category own and no place fields", () => {
    const built = buildSceneRunPlan(input({ scenes: [{ sceneId: 7, text: SENTENCE, slot: { kind: "own", shot: "friend", pose: "front" } }] }));
    expect(built.scenes.slots[0]).toEqual({ kind: "own", slotIndex: 1, category: "own", shot: "friend", pose: "front", attemptIdBase: "slot-1", sentence: SENTENCE });
  });

  test("a set of no scenes at all is refused", () => {
    expect(() => buildSceneRunPlan(input({ scenes: [] }))).toThrow();
  });
});

describe("the scene-set plan's schema", () => {
  test("round-trips through JSON unchanged", () => {
    const built = buildSceneRunPlan(input());
    expect(RunPlanSchema.parse(JSON.parse(JSON.stringify(built)))).toEqual(built);
  });

  test("refuses a mixed plan: one slot without a sentence", () => {
    const doc = json();
    delete slotsOf(doc)[2]!.sentence;
    expect(RunPlanSchema.safeParse(doc).success).toBe(false);
  });

  test("refuses a sentence on a slot of a plan that names no set", () => {
    const doc = json();
    delete doc.sceneSetId;
    delete doc.sceneIds;
    doc.request = { avatarId: "avatar-0001", count: 4, categories: ["home"], poses: { profile: false, back: false } };
    expect(RunPlanSchema.safeParse(doc).success).toBe(false);
  });

  test("refuses a sentence-bearing plan that also has writer chunks", () => {
    const doc = json();
    doc.writerChunks = [{ chunk: 1, slotIndexes: [1, 2, 3, 4], attemptIds: ["run-00000001:writer-1#1"] }];
    expect(RunPlanSchema.safeParse(doc).success).toBe(false);
  });

  test("refuses a plan that names its set but has no sentences at all", () => {
    const doc = json();
    for (const slot of slotsOf(doc)) delete slot.sentence;
    expect(RunPlanSchema.safeParse(doc).success).toBe(false);
  });

  test("refuses a plan with neither a request nor a set", () => {
    const doc = json();
    delete doc.sceneSetId;
    delete doc.sceneIds;
    for (const slot of slotsOf(doc)) delete slot.sentence;
    expect(RunPlanSchema.safeParse(doc).success).toBe(false);
  });

  test("refuses a plan that names its set and also carries a request", () => {
    const doc = json();
    doc.request = { avatarId: "avatar-0001", count: 4, categories: ["home"], poses: { profile: false, back: false } };
    expect(RunPlanSchema.safeParse(doc).success).toBe(false);
  });

  test("refuses slots left numbered by their scene ids (1, 3, 4, 5)", () => {
    const doc = json();
    slotsOf(doc).forEach((slot, i) => {
      slot.slotIndex = [1, 3, 4, 5][i];
      slot.attemptIdBase = `slot-${[1, 3, 4, 5][i]}`;
    });
    (doc.slotAttempts as { slotIndex: number; attemptIds: string[] }[]).forEach((s, i) => {
      s.slotIndex = [1, 3, 4, 5][i]!;
      s.attemptIds = s.attemptIds.map((id) => id.replace(/slot-\d+/, `slot-${[1, 3, 4, 5][i]}`));
    });
    expect(RunPlanSchema.safeParse(doc).success).toBe(false);
  });

  test("refuses an empty sentence", () => {
    const doc = json();
    slotsOf(doc)[0]!.sentence = "";
    expect(RunPlanSchema.safeParse(doc).success).toBe(false);
  });

  test("refuses scene ids that repeat, or that do not match the slots one for one", () => {
    const repeated = json();
    repeated.sceneIds = [1, 3, 3, 5];
    expect(RunPlanSchema.safeParse(repeated).success).toBe(false);
    const short = json();
    short.sceneIds = [1, 3, 4];
    expect(RunPlanSchema.safeParse(short).success).toBe(false);
  });

  test("refuses scene ids on a plan that names no set", () => {
    const doc = json();
    delete doc.sceneSetId;
    doc.request = { avatarId: "avatar-0001", count: 4, categories: ["home"], poses: { profile: false, back: false } };
    for (const slot of slotsOf(doc)) delete slot.sentence;
    doc.writerChunks = [{ chunk: 1, slotIndexes: [1, 2, 3, 4], attemptIds: ["run-00000001:writer-1#1"] }];
    expect(RunPlanSchema.safeParse(doc).success).toBe(false);
  });
});

describe("an own slot in a plan", () => {
  const own = (): Record<string, unknown> => json({ scenes: [{ sceneId: 7, text: SENTENCE, slot: { kind: "own", shot: "friend", pose: "profile" } }] });

  test("parses, with its shot and pose", () => {
    expect(RunPlanSchema.safeParse(own()).success).toBe(true);
  });

  test("refuses a place field it must not have", () => {
    const doc = own();
    slotsOf(doc)[0]!.location = "a kitchen";
    expect(RunPlanSchema.safeParse(doc).success).toBe(false);
  });

  test("refuses a selfie that is not facing the camera", () => {
    const doc = own();
    slotsOf(doc)[0]!.shot = "selfie";
    expect(RunPlanSchema.safeParse(doc).success).toBe(false);
  });

  test("refuses a category other than own", () => {
    const doc = own();
    slotsOf(doc)[0]!.category = "home";
    expect(RunPlanSchema.safeParse(doc).success).toBe(false);
  });

  test("refuses an own slot without a sentence", () => {
    const doc = own();
    delete slotsOf(doc)[0]!.sentence;
    expect(RunPlanSchema.safeParse(doc).success).toBe(false);
  });
});

describe("a plan.json written by main 3a9cd498", () => {
  const raw: Record<string, unknown> = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "plan-main-3a9cd498.json"), "utf8"));

  test("still parses unchanged and has none of the scene-set keys", () => {
    const parsed = RunPlanSchema.parse(raw);
    expect<unknown>(parsed).toEqual(raw);
    expect("sceneSetId" in parsed || "sceneIds" in parsed).toBe(false);
  });

  test("is refused when it is given a sentence on one slot (a half-set plan)", () => {
    const doc: Record<string, unknown> = JSON.parse(JSON.stringify(raw));
    slotsOf(doc)[0]!.sentence = SENTENCE;
    expect(RunPlanSchema.safeParse(doc).success).toBe(false);
  });
});

describe("a scene-set plan in the run's own machinery", () => {
  const ledger = { reserveOf: () => undefined, closeOf: () => undefined };
  const run = (): RunPlan => RunPlanSchema.parse(JSON.parse(JSON.stringify(buildSceneRunPlan(input()))));

  test("foldRun seeds the sentences from the plan, with no writer chunk done", () => {
    const state = foldRun(run(), { events: [], photos: [], ...ledger });
    expect([...state.sentences.keys()]).toEqual([1, 2, 3, 4]);
    expect(state.sentences.get(2)).toBe(`${SENTENCE} (3)`);
    expect(state.writerDone.size).toBe(0);
    expect(state.slots).toHaveLength(4);
  });

  test("a resume is priced with no writer term: images only, four slots of three attempts at the dearest image", () => {
    const p = run();
    const state = foldRun(p, { events: [], photos: [], ...ledger });
    const estimate = remainingPlan({ book: PriceBook.fallback(), asOf: "2026-10-07" }, p, state, 0, ledger);
    expect(estimate.estimate.worstMicros).toBe(4 * 3 * 50_000);
    expect(estimate.minToProgressMicros).toBe(50_000);
  });
});
