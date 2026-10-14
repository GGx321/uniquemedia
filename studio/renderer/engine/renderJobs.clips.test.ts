import { describe, expect, test } from "bun:test";
import type { AvatarSummary } from "../../shared/engine";
import { MIA } from "./mockEngine.testkit";
import { clipQueueRows } from "./renderJobs";
import type { ClipJobInfo, JobView } from "./store";

// Stage 5, 5b.1, S5.V8 (README §S5.VD decision 10, §S5.VD2 question 1): the sidebar's «Очередь» gives each clip at work its own row, «Клип · Nini · <фаза>», in the shape of the
// «Генерация» row with the clip's steps for its bar; an export reads «Клип · Nini · Сохраняем 40 %». A clip never joins «Генерация» (sidebarCounts, S5.V1).

const NINI: AvatarSummary = { ...MIA, avatarId: "avatar-nini-0001", name: "Nini" };
const NOW = Date.UTC(2026, 9, 11, 11, 7, 20);

function clipJob(n: number, info: Partial<ClipJobInfo>, patch: Partial<JobView> = {}): JobView {
  const jobId = `job-${String(n).padStart(8, "0")}`;
  return {
    jobId,
    kind: "clip",
    avatarId: NINI.avatarId,
    runId: null,
    montageId: null,
    videoId: null,
    status: "running",
    saving: false,
    done: 0,
    total: 4,
    result: null,
    error: null,
    clip: { clipId: jobId, phase: "preparing", model: null, submittedAt: null, proveUntil: null, recovery: false, export: false, ...info },
    ...patch,
  };
}

const rows = (jobs: readonly JobView[]) => clipQueueRows(jobs, [NINI], { nowMs: NOW, seenAt: () => NOW });

describe("the clip rows of «Очередь»", () => {
  test("one row per clip at work, named by its avatar, with its short phase and its steps", () => {
    const [row] = rows([clipJob(1, { phase: "rendering", model: "kling", submittedAt: new Date(NOW - 80_000).toISOString() }, { done: 0 })]);
    expect(row).toEqual({ jobId: "job-00000001", label: "Клип · Nini", phase: "Снимается 1:20", warn: false, meter: { kind: "steps", done: 0, total: 4 } });
  });

  test("late reads in the warning's tone; a recovery reads «Восстановление»", () => {
    expect(rows([clipJob(2, { phase: "late", model: "kling" })])[0]).toMatchObject({ phase: "Задерживается", warn: true });
    expect(rows([clipJob(3, { phase: "recovering", recovery: true })])[0]).toMatchObject({ label: "Клип · Nini", phase: "Восстановление", warn: false });
  });

  test("an export: «Клип · Nini · Сохраняем 40 %», its bar the frames encoded", () => {
    const [row] = rows([clipJob(4, { phase: "exporting", export: true, clipId: "clip-0000001" }, { done: 60, total: 150 })]);
    expect(row).toMatchObject({ label: "Клип · Nini", phase: "Сохраняем 40 %", meter: { kind: "bar", percent: 40 } });
  });

  test("ended clips and every other kind of job have no row", () => {
    const run: JobView = { ...clipJob(5, {}), kind: "run", runId: "run-1", clip: undefined };
    expect(rows([clipJob(6, { phase: "saving" }, { status: "done", done: 4 }), clipJob(7, {}, { status: "failed" }), run])).toEqual([]);
  });

  test("a clip of an avatar the window does not list is still a clip", () => {
    expect(clipQueueRows([clipJob(8, { phase: "downloading" }, { done: 1 })], [], { nowMs: NOW, seenAt: () => NOW })[0]).toMatchObject({ label: "Клип", phase: "Скачивается", meter: { kind: "steps", done: 1, total: 4 } });
  });
});
