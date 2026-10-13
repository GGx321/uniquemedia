import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { EngineFailure } from "../engineFailure";
import { openLibrary } from "../library";
import type { StoredSceneSet } from "../library/sceneSets";
import { steppingClock, useTempDir } from "../library/testing/helpers";
import { sampleSet } from "../library/testing/sceneSetSample";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { applyEdit, textProblem } from "./edit";
import { approveLaunchSet, type LaunchSetDeps } from "./launchDraw";
import { LaunchRegistry } from "./launchRegistry";
import { approvalRefusal } from "./toRun";
import { MemoryLaunches } from "./testing/memoryLaunches";
useNativeGlobals();

// 5a.3 (S5.9c, plan s5a3 §5.3, answer (c)): the owner's words on a scene of a «Смелая» category are checked for youth words only. The edit-time check, the scene-set approval and
// the launch's approval read the scene's content level (`contentLevelOf`): «bikini», «topless» and «naked» are legal on a «Смелая» scene, a youth word is refused there as
// everywhere, and a scene of the five is held to the revealing words as it always was.

const BOLD_TEXT = "She lies under the sheet, topless, in a white string bikini bottom, naked otherwise.";
const YOUTH_TEXT = "A teenage girl in a bikini.";

function setOf(category: "nightwear" | "beach" | "home", count = 4): StoredSceneSet {
  return { schemaVersion: 1, revision: 1, createdAt: "2026-10-07T10:00:00.000Z", updatedAt: "2026-10-07T10:30:00.000Z", ...sampleSet({ count, written: count, categories: [category] }) } as StoredSceneSet;
}
const withText = (set: StoredSceneSet, text: string): StoredSceneSet => ({ ...set, scenes: set.scenes.map((s) => ({ ...s, text })) }) as StoredSceneSet;

describe("textProblem reads the level it is given", () => {
  test("at the default level a revealing word is refused, as it always was", () => {
    expect(textProblem(BOLD_TEXT)).toMatchObject({ reason: "revealing-word" });
  });

  test("at «Смелая» the same text goes through, and a youth word is still refused", async () => {
    const { boldContentLevel } = await import("../../shared/scenes/contentLine");
    expect(textProblem(BOLD_TEXT, boldContentLevel())).toBeNull();
    expect(textProblem(YOUTH_TEXT, boldContentLevel())).toMatchObject({ reason: "youth-word" });
  });
});

describe("the owner's edit of a scene", () => {
  test.each(["nightwear", "beach"] as const)("on a «%s» scene lets «topless», «naked» and «bikini» through", (category) => {
    const set = setOf(category);
    const outcome = applyEdit(set, { op: "text", sceneId: 1, text: BOLD_TEXT });
    expect(outcome.kind).toBe("changed");
  });

  test.each(["nightwear", "beach"] as const)("on a «%s» scene refuses a youth word", (category) => {
    expect(applyEdit(setOf(category), { op: "text", sceneId: 1, text: YOUTH_TEXT })).toMatchObject({ kind: "problem", problem: { reason: "youth-word" } });
  });

  test("on a scene of «Дом» refuses the revealing word as before", () => {
    expect(applyEdit(setOf("home"), { op: "text", sceneId: 1, text: BOLD_TEXT })).toMatchObject({ kind: "problem", problem: { reason: "revealing-word" } });
  });

  test("on an own scene (it has no category) is held to the ordinary rule", () => {
    const set = setOf("nightwear");
    const own = { sceneId: 50, origin: "own", idea: "кофе на балконе", shot: "friend", pose: "front", text: "She sips coffee.", edited: false, removed: false };
    const outcome = applyEdit({ ...set, scenes: [...set.scenes, own] } as unknown as StoredSceneSet, { op: "text", sceneId: 50, text: BOLD_TEXT });
    expect(outcome).toMatchObject({ kind: "problem", problem: { reason: "revealing-word" } });
  });
});

describe("the scene-set approval", () => {
  const FREE = { revision: 1, live: false, used: false };

  test.each(["nightwear", "beach"] as const)("lets a «%s» set whose texts say «topless» and «bikini» through", (category) => {
    expect(approvalRefusal(withText(setOf(category), BOLD_TEXT), FREE)).toBeNull();
  });

  test("refuses a «Смелая» set whose text has a youth word, naming the scene", () => {
    const refusal = approvalRefusal(withText(setOf("nightwear"), YOUTH_TEXT), FREE);
    expect(refusal?.code).toBe("VALIDATION");
    expect(refusal?.detail).toContain("scene 1");
  });

  test("refuses a set of «Дом» whose text has a revealing word", () => {
    expect(approvalRefusal(withText(setOf("home"), BOLD_TEXT), FREE)?.code).toBe("VALIDATION");
  });

  test("a mixed set reads each scene's own category: only the «Смелая» scenes may say it", () => {
    const bold = setOf("nightwear", 2);
    const home = setOf("home", 2);
    const mixed = { ...bold, scenes: [...bold.scenes, ...home.scenes.map((s) => ({ ...s, sceneId: s.sceneId + 10, slot: { ...(s as { slot: object }).slot, slotIndex: s.sceneId + 10 } }))] } as unknown as StoredSceneSet;
    const refusal = approvalRefusal(withText(mixed, BOLD_TEXT), FREE);
    expect(refusal?.code).toBe("VALIDATION");
    expect(refusal?.detail).toContain("scene 11");
  });
});

describe("the launch's approval of a set", () => {
  const root = useTempDir("studio-content-level-");
  const LAUNCH = "launch-0a1b2c3d4e5f";
  const SET = "set-aaaa-0001";

  async function seeded(category: "nightwear" | "home", text: string, sub: string) {
    const launches = new MemoryLaunches().add(LAUNCH);
    const registry = new LaunchRegistry(launches);
    const dir = `${root()}/${sub}`;
    await mkdir(dir, { recursive: true });
    const { library } = await openLibrary(dir, { now: steppingClock("2026-10-07T12:00:00.000Z") });
    const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: { hair: "chestnut" }, descriptor: "a 25-year-old woman with hazel eyes" });
    const base = sampleSet({ sceneSetId: SET, runId: "run-aaaa-0001", avatarId: avatar.id, count: 4, written: 4, categories: [category] });
    await library.sceneSets.create({ ...base, scenes: base.scenes.map((s) => ({ ...s, text })), launchId: LAUNCH } as never);
    const deps: LaunchSetDeps = { library, isLive: () => false, registry };
    return deps;
  }
  const approve = (deps: LaunchSetDeps) => approveLaunchSet(deps, { sceneSetId: SET, launchId: LAUNCH, revision: 1, plannedCount: 4 });

  test("approves a «Смелая» set whose texts say «topless» and «bikini»", async () => {
    const set = await approve(await seeded("nightwear", BOLD_TEXT, "bold-ok"));
    expect(set.launchDraw?.sceneIds).toHaveLength(4);
  });

  test("refuses a «Смелая» set whose text has a youth word: scene-text-problem, free", async () => {
    const error = await approve(await seeded("nightwear", YOUTH_TEXT, "bold-youth")).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(EngineFailure);
    expect((error as EngineFailure).error).toMatchObject({ code: "VALIDATION", sceneReason: "scene-text-problem" });
  });

  test("refuses a set of «Дом» whose text has a revealing word, as before", async () => {
    const error = await approve(await seeded("home", BOLD_TEXT, "home-revealing")).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(EngineFailure);
    expect((error as EngineFailure).error).toMatchObject({ code: "VALIDATION", sceneReason: "scene-text-problem" });
  });
});
