import { describe, expect, test } from "bun:test";
import { drawingRow, view } from "../../../shared/engine/autopilot.fixtures";
import { LaunchView, type RunSummary } from "../../../shared/engine";
import { isLaunchBatch, launchGo, type LaunchLink } from "./launchSet";

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
