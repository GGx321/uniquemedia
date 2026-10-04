import { describe, expect, test } from "bun:test";
import { JobProgress, JobState, type EventMessage } from "../../shared/engine";
import { ImportProgressInvariants } from "../../engine/parity/testing/progress";
import { makeMock, typesOf, unwrap, type Mock } from "./mockEngine.testkit";

// 3f.6: the mock plays the import's two stages as the engine does: the copy in bytes, then (for a file whose script says it has a prepare) the
// importer's own units from zero of their own total, never full before the record is stored. A file whose script says nothing of it plays exactly
// as before (the parity suite's older stories and the 3f.1b tests hold that), so the stage is opt-in: `accept.prepare`.

const video = { name: "walk.mov", accept: { kind: "video", bytes: 5000, facts: { durationMs: 2000, sourceFps: 60, hdrToSdr: true }, prepare: {} } } as const;

async function pick(mock: Mock, files: Parameters<Mock["engine"]["pickMediaNext"]>[0], kind: "photo" | "video" | "audio" | "sticker" | "any" = "video") {
  mock.engine.pickMediaNext(files);
  return unwrap(mock.client.request("media.pickImport", { kind }));
}

const progressOf = (mock: Mock): Extract<JobProgress, { kind: "import" }>[] =>
  mock.events.flatMap((e: EventMessage) => {
    if (e.type !== "job.progress") return [];
    const p = JobProgress.parse(e.payload);
    return p.kind === "import" ? [p] : [];
  });
const importEvents = (mock: Mock): EventMessage[] => mock.events.filter((e) => e.type === "job.progress" || e.type === "job.done" || e.type === "job.cancelled" || e.type === "job.failed" || e.type === "media.changed");

describe("a file whose script has a prepare stage", () => {
  test("plays the copy to its total, then the prepare from zero of the importer's own units, then the record", async () => {
    const mock = makeMock();
    await pick(mock, [video]);
    mock.scheduler.runAll();
    const progress = progressOf(mock);
    const stages = progress.map((p) => p.stage ?? "copy");
    const firstPrepare = stages.indexOf("prepare");

    expect(firstPrepare).toBeGreaterThan(0);
    expect(progress[firstPrepare - 1]).toMatchObject({ done: 5000, total: 5000 });
    expect(progress[firstPrepare]).toMatchObject({ stage: "prepare", done: 0 });
    expect(stages.slice(firstPrepare).every((s) => s === "prepare")).toBe(true);
    expect(typesOf(importEvents(mock)).slice(-2)).toEqual(["media.changed", "job.done"]);
  });

  test("counts a video in output frames: its length at 30 fps, and says what the probe judged", async () => {
    const mock = makeMock();
    await pick(mock, [video]);
    mock.scheduler.runAll();
    const prepare = progressOf(mock).filter((p) => p.stage === "prepare");
    expect(prepare.every((p) => p.total === 60)).toBe(true);
    expect(prepare.every((p) => p.prepare?.hdrToSdr === true && p.prepare.fromFps === 60)).toBe(true);
  });

  test("a clip already at 30 fps says no source rate, and a photo carries no judged facts", async () => {
    const mock = makeMock();
    await pick(mock, [{ name: "a.mov", accept: { kind: "video", bytes: 100, facts: { durationMs: 1000, sourceFps: 30 }, prepare: {} } }]);
    mock.scheduler.runAll();
    expect(progressOf(mock).find((p) => p.stage === "prepare")?.prepare).toEqual({ hdrToSdr: false, fromFps: null });

    const other = makeMock();
    await pick(other, [{ name: "a.jpg", accept: { kind: "photo", bytes: 100, prepare: {} } }], "photo");
    other.scheduler.runAll();
    const steps = progressOf(other).filter((p) => p.stage === "prepare");
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((p) => p.prepare === undefined && p.total === 3)).toBe(true);
  });

  test("counts a track in output milliseconds", async () => {
    const mock = makeMock();
    await pick(mock, [{ name: "t.mp3", accept: { kind: "audio", bytes: 900, facts: { durationMs: 42_000 }, prepare: {} } }], "audio");
    mock.scheduler.runAll();
    expect(progressOf(mock).find((p) => p.stage === "prepare")).toMatchObject({ total: 42_000 });
  });

  test("the script may name the units, the steps and what was judged", async () => {
    const mock = makeMock();
    await pick(mock, [{ name: "a.mov", accept: { kind: "video", bytes: 100, prepare: { total: 500, steps: 2, judged: { hdrToSdr: true, fromFps: 24 } } } }]);
    mock.scheduler.runAll();
    const prepare = progressOf(mock).filter((p) => p.stage === "prepare");
    expect(prepare.map((p) => p.done)).toEqual([0, 166, 333]);
    expect(prepare.every((p) => p.total === 500 && p.prepare?.fromFps === 24)).toBe(true);
  });

  test("never reaches the total before the record is stored, and the numbers satisfy the parity invariants", async () => {
    const mock = makeMock();
    await pick(mock, [video, { name: "b.mov", accept: { kind: "video", bytes: 800, prepare: {} } }]);
    mock.scheduler.runAll();
    const invariants = new ImportProgressInvariants();
    for (const p of progressOf(mock)) invariants.check(p);
    expect(progressOf(mock).filter((p) => p.stage === "prepare").every((p) => p.done < p.total)).toBe(true);
  });

  test("a second job waits its turn and its prepare comes after the first job's end", async () => {
    const mock = makeMock();
    await pick(mock, [video, { name: "b.mov", accept: { kind: "video", bytes: 800, prepare: {} } }]);
    mock.scheduler.runAll();
    const order = importEvents(mock).flatMap((e) => (e.type === "job.done" ? ["done"] : e.type === "job.progress" && e.payload.kind === "import" && e.payload.stage === "prepare" ? ["prepare"] : []));
    const firstDone = order.indexOf("done");
    expect(order.slice(0, firstDone).every((x) => x === "prepare")).toBe(true);
    expect(order.slice(firstDone + 1).filter((x) => x === "prepare").length).toBeGreaterThan(0);
  });

  test("the snapshot of a job in its prepare shows the stage, the units and the judged facts, and fits the contract", async () => {
    const mock = makeMock();
    await pick(mock, [video]);
    // The copy is over (one step), then the prepare begins and its first step runs.
    mock.scheduler.next();
    mock.scheduler.next();
    const snapshot = await unwrap(mock.client.request("engine.snapshot", {}));
    const job = snapshot.jobs.find((j) => j.kind === "import");
    expect(JobState.safeParse(job).success).toBe(true);
    expect(job).toMatchObject({ status: "running", stage: "prepare", total: 60, prepare: { hdrToSdr: true, fromFps: 60 } });
  });

  test("a cancel during the prepare ends the job cancelled with nothing stored, and no later step is announced", async () => {
    const mock = makeMock();
    const answer = await pick(mock, [video]);
    if (!answer.picked) throw new Error("not picked");
    const [jobId] = answer.jobIds as [string];
    mock.scheduler.next();
    mock.scheduler.next();
    await unwrap(mock.client.request("media.cancelImport", { jobId }));
    const mark = progressOf(mock).length;
    mock.scheduler.runAll();
    expect(progressOf(mock).length).toBe(mark);
    expect(typesOf(importEvents(mock)).at(-1)).toBe("job.cancelled");
    expect((await unwrap(mock.client.request("media.list", {}))).total).toBe(0);
  });

  test("a file the importer refuses after its prepare fails with its reason and stores nothing", async () => {
    const mock = makeMock();
    await pick(mock, [{ name: "short.mov", accept: { kind: "video", bytes: 100, prepare: {}, failWith: "too-short" } }]);
    mock.scheduler.runAll();
    const last = importEvents(mock).at(-1);
    expect(last?.type).toBe("job.failed");
    expect(last?.type === "job.failed" && last.payload.error).toMatchObject({ code: "MEDIA_UNSUPPORTED", mediaReason: "too-short" });
    expect((await unwrap(mock.client.request("media.list", {}))).total).toBe(0);
  });
});

describe("a file whose script says nothing of a prepare", () => {
  test("plays as it always did: the copy to its total, the record, the end, and no stage anywhere", async () => {
    const mock = makeMock();
    await pick(mock, [{ name: "walk.mov", accept: { kind: "video", bytes: 5000 } }]);
    mock.scheduler.runAll();
    expect(typesOf(importEvents(mock))).toEqual(["job.progress", "job.progress", "media.changed", "job.done"]);
    expect(progressOf(mock).every((p) => p.stage === undefined)).toBe(true);
  });
});
