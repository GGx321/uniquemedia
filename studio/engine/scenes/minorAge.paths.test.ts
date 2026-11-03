import { describe, expect, test } from "bun:test";
import type { AvatarDescriptor, SceneLevel } from "../../shared/engine";
import { SceneSetFile, type StoredSceneSet } from "../library/sceneSets";
import { ownScene, sampleSet } from "../library/testing/sceneSetSample";
import { asLibraryReference, JPEG } from "../openrouter/testing/fakes";
import { applyEdit } from "../sceneSets/edit";
import { approvalRefusal } from "../sceneSets/toRun";
import { assembleRun, assembleSlot, AssemblerRefusalError } from "./assembler";
import { readIdeaAnswer, type IdeaSlot } from "./ideaWriter";
import { plan } from "./planner";
import type { OwnPlanSlot, PlanSlot } from "./schema";
import { boldReader, readWriterAnswer, type WriterAnswer } from "./writer";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// S5.BA9 r2 (AGE, review OPEN): every text that reaches an image prompt holds the core age rule of the kept minor-age guard, an explicit age under 18 or an under-21 bound (ageText.ts). The
// clip path had it (motionText.ts); a photo's sentence did not: «She is 17 and …» passed the readers, the owner's edit, the approval and the assembler's last gate. Each of them reads the
// content line (`contentProblems`), which now holds the rule, so each path below refuses the age as it refuses a youth word, and keeps the same sentence without it.

const MINOR = "She is 17 and sips coffee on her sunny balcony, one hand on the railing.";
const ADULT = "She sips coffee on her sunny balcony, one hand on the railing.";
const BOLD_MINOR = "She is 17 and lies across her bed in a black lace bra and panties, smiling at the viewer.";
const BOLD_ADULT = "She lies across her bed in a black lace bra and panties, smiling at the viewer.";

/** The youth words a read refused the answer for: none when it was accepted or refused for another reason. */
const youthOf = (read: WriterAnswer | ReturnType<typeof readIdeaAnswer>): string[] => (read.ok || !read.problems.includes("youth-word") ? [] : read.words);
const answer = (slotIndex: number, sentence: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ scenes: [{ slotIndex, sentence, ...extra }] });

describe("the writers' readers refuse an explicit minor age (S5.BA9 r2)", () => {
  const ordinary = (): PlanSlot => {
    const [slot] = plan({ seed: 1, count: 1, categories: ["home"] }).slots;
    if (slot === undefined) throw new Error("no slot");
    return { ...slot, shot: "friend", pose: "front" };
  };
  const bold = (): PlanSlot => ({
    slotIndex: 1,
    category: "nightwear",
    location: "her bed",
    timeOfDay: "night",
    activity: "lies across her bed",
    outfit: "a black lace bra and panties",
    shot: "friend",
    pose: "front",
    attemptIdBase: "slot-1",
    repeatedPair: false,
    level: "bold",
    route: "seedream",
  });
  const IDEA: IdeaSlot = { slotIndex: 5, idea: "кофе на балконе утром", shot: "friend", pose: "front" };

  test("the compose writer's, at ordinary", () => {
    const slot = ordinary();
    expect(youthOf(readWriterAnswer(answer(slot.slotIndex, MINOR), [slot]))).toEqual(["17"]);
    expect(youthOf(readWriterAnswer(answer(slot.slotIndex, ADULT), [slot]))).toEqual([]);
  });

  test("the compose writer's bold mode, for either origin", () => {
    for (const impliedNudity of [false, true]) {
      expect(youthOf(boldReader(impliedNudity)(answer(1, BOLD_MINOR), [bold()]))).toEqual(["17"]);
      expect(youthOf(boldReader(impliedNudity)(answer(1, BOLD_ADULT), [bold()]))).toEqual([]);
    }
  });

  test("the idea writer's, at ordinary", () => {
    expect(youthOf(readIdeaAnswer(answer(5, MINOR), [IDEA]))).toEqual(["17"]);
    expect(youthOf(readIdeaAnswer(answer(5, ADULT), [IDEA]))).toEqual([]);
  });

  test("the idea writer's «Смелая» variant, for either origin", () => {
    for (const impliedNudity of [false, true]) {
      expect(youthOf(readIdeaAnswer(answer(5, BOLD_MINOR), [IDEA], false, { impliedNudity }))).toEqual(["17"]);
      expect(youthOf(readIdeaAnswer(answer(5, BOLD_ADULT), [IDEA], false, { impliedNudity }))).toEqual([]);
    }
  });
});

describe("the owner's edit and the approval refuse an explicit minor age (S5.BA9 r2)", () => {
  const FREE = { revision: 4, live: false, used: false };
  /** A set of three written «Дом» scenes at `level` and one own scene (id 4) with `text`; `planned` replaces scene 1's text. */
  function setAt(level: SceneLevel | undefined, own: string, planned?: string): StoredSceneSet {
    const base = sampleSet({ count: 3, written: 3 });
    return SceneSetFile.parse({
      schemaVersion: 1,
      ...base,
      request: { ...base.request, ...(level === undefined ? {} : { level }) },
      revision: 4,
      createdAt: "2026-11-03T12:00:00.000Z",
      updatedAt: "2026-11-03T12:00:00.000Z",
      scenes: [...base.scenes.map((s) => (s.sceneId === 1 && planned !== undefined ? { ...s, text: planned } : s)), ownScene(4, { text: own })],
    });
  }

  test.each([
    ["a planned scene of an ordinary set", undefined, 1, MINOR, ADULT],
    ["an own scene of an ordinary set", undefined, 4, MINOR, ADULT],
    ["an own scene of a «Смелая» set", "bold", 4, BOLD_MINOR, BOLD_ADULT],
  ] as const)("the edit of %s", (_name, level, sceneId, minor, adult) => {
    const set = setAt(level, "She sips tea by her window.");
    expect(applyEdit(set, { op: "text", sceneId, text: minor })).toEqual({ kind: "problem", problem: { reason: "youth-word", words: ["17"] } });
    expect(applyEdit(set, { op: "text", sceneId, text: adult }).kind).toBe("changed");
  });

  test("the approval of an own scene's stored text, in an ordinary and in a «Смелая» set", () => {
    expect(approvalRefusal(setAt(undefined, MINOR), FREE)).toMatchObject({ code: "VALIDATION", sceneReason: "scene-text-problem", sceneId: 4 });
    expect(approvalRefusal(setAt("bold", BOLD_MINOR), FREE)).toMatchObject({ code: "VALIDATION", sceneReason: "scene-text-problem", sceneId: 4 });
    expect(approvalRefusal(setAt("bold", BOLD_ADULT), FREE)).toBeNull();
  });

  test("the approval of a planned scene's stored text", () => {
    expect(approvalRefusal(setAt(undefined, ADULT, MINOR), FREE)).toMatchObject({ code: "VALIDATION", sceneReason: "scene-text-problem", sceneId: 1 });
    expect(approvalRefusal(setAt(undefined, ADULT, ADULT), FREE)).toBeNull();
  });
});

describe("the assembler's last gate refuses an explicit minor age before any image is paid for (S5.BA9 r2)", () => {
  const DESCRIPTOR: AvatarDescriptor = { age: 25, text: "25-year-old European woman, light olive skin, hazel eyes, shoulder-length wavy chestnut hair, athletic build, light freckles across the nose." };
  const MASTER = asLibraryReference(JPEG);
  const own = (route?: "seedream"): OwnPlanSlot => ({ kind: "own", slotIndex: 1, category: "own", shot: "friend", pose: "front", attemptIdBase: "slot-1", sentence: MINOR, ...(route === undefined ? {} : { route }) });

  test.each([
    ["an own slot", undefined, MINOR, ADULT],
    ["an own slot on the route", "seedream", BOLD_MINOR, BOLD_ADULT],
  ] as const)("%s ends alone as a text problem, and the same sentence without the age is assembled", (_name, route, minor, adult) => {
    expect(assembleRun(DESCRIPTOR, { slots: [own(route)] }, new Map([[1, minor]]), MASTER, { runId: "run-aaaa-0001" })[0]).toMatchObject({ ok: false, reason: "slot-text-problem" });
    expect(assembleRun(DESCRIPTOR, { slots: [own(route)] }, new Map([[1, adult]]), MASTER, { runId: "run-aaaa-0001" })[0]).toMatchObject({ ok: true });
  });

  test("a planned slot: the slot alone ends, and the slot's own assembly throws", () => {
    const [slot] = plan({ seed: 1, count: 1, categories: ["home"] }).slots;
    if (slot === undefined) throw new Error("no slot");
    expect(assembleRun(DESCRIPTOR, { slots: [slot] }, new Map([[slot.slotIndex, MINOR]]), MASTER, { runId: "run-aaaa-0001" })[0]).toMatchObject({ ok: false, reason: "slot-text-problem" });
    expect(() => assembleSlot(DESCRIPTOR, slot, MINOR, MASTER, { runId: "run-aaaa-0001" })).toThrow(AssemblerRefusalError);
  });
});
