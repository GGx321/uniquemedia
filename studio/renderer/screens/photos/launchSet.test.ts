import { describe, expect, test } from "bun:test";
import { drawingRow, view } from "../../../shared/engine/autopilot.fixtures";
import { LaunchView, type RunSummary } from "../../../shared/engine";
import { emptySetToFill, isLaunchBatch, launchGo, launchWriteHint, type LaunchLink } from "./launchSet";
import { sceneSet, written } from "./sceneFixtures";

// S4.9b round 1: which batch on «Фото» is the launch's (M2), and what the launch's strip offers while «Стоп» is on its way (L1).

const A = "avatar-mia-0001";
const run = (runId: string, over: Partial<RunSummary> = {}): RunSummary => ({
  runId,
  avatarId: A,
  createdAt: "2026-10-08T14:04:00.000Z",
  total: 5,
  done: 2,
  failed: 0,
  open: 3,
  capMicros: 1_050_000,
  committedMicros: 140_000,
  running: true,
  resumable: false,
  capExhausted: false,
  remainingWorstMicros: 630_000,
  ...over,
});
const link = (over: Record<string, unknown> = {}): LaunchLink => {
  const launch = LaunchView.parse({ ...view, ...over });
  const row = launch.avatars.find((a) => a.avatarId === A) ?? drawingRow(A);
  return { launch, row };
};
const paused = { status: "paused", paused: { cause: "owner", at: "2026-10-08T14:05:00.000Z" } };

describe("the batch drawing now: the launch's, or the owner's own (M2)", () => {
  test("`RunSummary.launchId` decides once the run is listed, whatever the launch's row says", () => {
    expect(isLaunchBatch("run-00000001", [run("run-00000001", { launchId: view.launchId })], link(paused))).toBe(true);
    expect(isLaunchBatch("run-00000002", [run("run-00000002")], link())).toBe(false);
  });

  test("not listed yet: the launch's only while the launch runs and the row draws", () => {
    expect(isLaunchBatch("run-00000003", [], link())).toBe(true);
    expect(isLaunchBatch("run-00000003", [], link(paused))).toBe(false);
    expect(isLaunchBatch("run-00000003", [], link({ avatars: view.avatars.map((a) => (a.avatarId === A ? { ...a, phase: "montage", slice: null } : a)) }))).toBe(false);
    expect(isLaunchBatch("run-00000003", [], null)).toBe(false);
  });
});

describe("the strip while «Стоп» is on its way (L1)", () => {
  test("no «Продолжить запуск»: the set goes back to «Фото» as an ordinary one", () => {
    const awaiting = link({ status: "stopping", avatars: view.avatars.map((a) => (a.avatarId === A ? { ...a, phase: "awaiting-review", slice: null } : a)) });
    expect(launchGo(awaiting)).toEqual({ kind: "stopping", text: "Запуск останавливается — набор вернётся на «Фото» обычным." });
  });
});

// ---------- S4.9d: what the S4.9b review left on «Фото» ----------

describe("S4.9d (S4.9b L2): an empty set opens «по описанию» by itself only when it is the owner's", () => {
  test("the owner's empty set with nothing written: yes; a launch's: never — a launch draws no own scene, and the form would sit armed until the set came back", () => {
    const empty = sceneSet([], { sceneSetId: "set-0009" });
    expect(emptySetToFill(empty, null)).toBe("set-0009");
    expect(emptySetToFill(empty, link())).toBeNull();
    expect(emptySetToFill(sceneSet(written(3)), null)).toBeNull();
    expect(emptySetToFill(sceneSet([], { write: { kind: "compose", count: 14 } }), null)).toBeNull();
    expect(emptySetToFill(null, null)).toBeNull();
  });
});

describe("S4.9d (S4.9b L8): the hint where a write of a launch's set has no «Отменить»", () => {
  test("the launch's own writes are stopped from «Автопилот»; the owner's rewrite during the review is not, and the hint says what is true of it", () => {
    expect(launchWriteHint("compose")).toBe("Отменить и продолжить — в «Автопилоте»: «Пауза», «Стоп»");
    expect(launchWriteHint("unwritten")).toBe("Отменить и продолжить — в «Автопилоте»: «Пауза», «Стоп»");
    expect(launchWriteHint("rewrite")).toBe("Ваша правка сцен: платится отдельно от запуска («Правки сцен»). «Пауза» и «Стоп» её не останавливают — она допишется сама.");
    expect(launchWriteHint("rewrite")).not.toContain("«Пауза», «Стоп»");
  });
});
