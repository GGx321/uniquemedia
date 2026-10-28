import { describe, expect, test } from "bun:test";
import type { AvatarDescriptor, SceneLevel } from "../../shared/engine";
import { SceneSetFile, type StoredSceneSet } from "../library/sceneSets";
import { ownScene, sampleSet } from "../library/testing/sceneSetSample";
import { asLibraryReference, JPEG } from "../openrouter/testing/fakes";
import { buildSceneRunPlan, routedScenes } from "../runs/plan";
import { assembleRun } from "../scenes/assembler";
import type { OwnPlanSlot } from "../scenes/schema";
import { applyEdit } from "./edit";
import { approvalRefusal, runSources } from "./toRun";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.4 (S5.BA9, plan s5a4 §8 BA9): an own scene of a «Смелая» set is a «Смелая» frame. Its run slot carries the Seedream route (so it is drawn, priced and reserved as a bold photo),
// and every content-line site that reads it (the approval, the owner's edit, the assembler's last gate) holds its text to the «Смелая» line, by the marker. Below «Смелая» nothing moves.

const LINGERIE = "She lies across her bed in a black lace bra and panties, propped on one elbow, smiling at the viewer.";
const FREE = { revision: 4, live: false, used: false };

/** A set of three written «Дом» scenes at `level` and one own scene (id 4) with `text`. */
function setAt(level: SceneLevel | undefined, text = LINGERIE): StoredSceneSet {
  const base = sampleSet({ count: 3, written: 3 });
  return SceneSetFile.parse({
    schemaVersion: 1,
    ...base,
    request: { ...base.request, ...(level === undefined ? {} : { level }) },
    revision: 4,
    createdAt: "2026-10-28T12:00:00.000Z",
    updatedAt: "2026-10-28T12:00:00.000Z",
    scenes: [...base.scenes, ownScene(4, { text })],
  });
}

const ownSource = (set: StoredSceneSet) => runSources(set).find((s) => s.sceneId === 4);

describe("an own scene's run slot (S5.BA9)", () => {
  test("in a «Смелая» set it carries the Seedream route", () => {
    expect(ownSource(setAt("bold"))?.slot).toEqual({ kind: "own", shot: "friend", pose: "front", route: "seedream" });
  });

  test.each([["«Обычная»", undefined], ["«Кокетливая»", "flirty"]] as const)("in a %s set it carries none, as before", (_name, level) => {
    const slot = ownSource(setAt(level, "She sips coffee on a balcony."))?.slot;
    expect(slot).toEqual({ kind: "own", shot: "friend", pose: "front" });
    expect(slot !== undefined && "route" in slot).toBe(false);
  });

  test("the run made from a «Смелая» set draws it on the route: its plan's slot carries it, the plan names the bold model, and the routed count holds it", () => {
    const set = setAt("bold");
    const sources = runSources(set);
    const plan = buildSceneRunPlan({ runId: "run-aaaa-0001", avatarId: set.avatarId, createdAt: "2026-10-28T12:00:00.000Z", sceneSetId: set.sceneSetId, imageAgeCheck: "off", models: { imageModel: "x-ai/grok-imagine-image-2.0", textModel: "x-ai/grok-4.3" }, capMicros: 1_000_000, plannedWorstMicros: 1_000_000, scenes: sources });
    expect(plan.scenes.slots.find((s) => s.category === "own")).toMatchObject({ kind: "own", route: "seedream" });
    expect(plan.models.bold).toBeDefined();
    expect(routedScenes(sources)).toBe(1);
  });

  test("a run made from a «Кокетливая» set keeps the own slot off the route, and names no bold model", () => {
    const set = setAt("flirty", "She sips coffee on a balcony.");
    const plan = buildSceneRunPlan({ runId: "run-aaaa-0001", avatarId: set.avatarId, createdAt: "2026-10-28T12:00:00.000Z", sceneSetId: set.sceneSetId, imageAgeCheck: "off", models: { imageModel: "x-ai/grok-imagine-image-2.0", textModel: "x-ai/grok-4.3" }, capMicros: 1_000_000, plannedWorstMicros: 1_000_000, scenes: runSources(set) });
    expect("route" in (plan.scenes.slots.find((s) => s.category === "own") ?? {})).toBe(false);
    expect(plan.models.bold).toBeUndefined();
  });
});

describe("the approval reads an own scene's text at its marker's level (S5.BA9)", () => {
  test("a «Смелая» set's own scene in lingerie goes through", () => {
    expect(approvalRefusal(setAt("bold"), FREE)).toBeNull();
  });

  test("the same text in a «Кокетливая» set is still refused, naming the scene", () => {
    const refusal = approvalRefusal(setAt("flirty"), FREE);
    expect(refusal).toMatchObject({ code: "VALIDATION", sceneReason: "scene-text-problem", sceneId: 4 });
  });

  test("a youth word is refused in a «Смелая» set too (the age guard is unchanged)", () => {
    expect(approvalRefusal(setAt("bold", "A teenage girl lies on her bed in lingerie."), FREE)).toMatchObject({ code: "VALIDATION", sceneId: 4 });
  });
});

describe("the owner's edit of an own scene reads its marker's level (S5.BA9)", () => {
  const edit = (set: StoredSceneSet, text: string) => applyEdit(set, { op: "text", sceneId: 4, text });

  test("in a «Смелая» set lingerie is his to type", () => {
    expect(edit(setAt("bold", "She sips coffee on a balcony."), LINGERIE).kind).toBe("changed");
  });

  test("in an ordinary set it is a revealing word, as before", () => {
    expect(edit(setAt(undefined, "She sips coffee on a balcony."), LINGERIE)).toEqual({ kind: "problem", problem: { reason: "revealing-word", words: ["bra", "panties"] } });
  });

  test("a youth word is a problem in a «Смелая» set too", () => {
    expect(edit(setAt("bold", "She sips coffee on a balcony."), "A teenage girl lies on her bed.")).toMatchObject({ kind: "problem", problem: { reason: "youth-word" } });
  });
});

describe("the assembler's last gate reads an own slot by its route (S5.BA9)", () => {
  const DESCRIPTOR: AvatarDescriptor = { age: 25, text: "25-year-old European woman, light olive skin, hazel eyes, shoulder-length wavy chestnut hair, athletic build, light freckles across the nose." };
  const own = (route?: "seedream"): OwnPlanSlot => ({ kind: "own", slotIndex: 1, category: "own", shot: "friend", pose: "front", attemptIdBase: "slot-1", sentence: LINGERIE, ...(route === undefined ? {} : { route }) });
  const assemble = (slot: OwnPlanSlot) => assembleRun(DESCRIPTOR, { slots: [slot] }, new Map([[1, LINGERIE]]), asLibraryReference(JPEG), { runId: "run-aaaa-0001" });

  test("an own slot on the route is assembled in lingerie", () => {
    expect(assemble(own("seedream"))[0]).toMatchObject({ ok: true, slotIndex: 1 });
  });

  test("an own slot off the route still ends alone as a text problem", () => {
    expect(assemble(own())[0]).toMatchObject({ ok: false, slotIndex: 1, reason: "slot-text-problem" });
  });
});
