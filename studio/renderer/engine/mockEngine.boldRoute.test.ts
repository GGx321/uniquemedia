import { describe, expect, test } from "bun:test";
import type { EventMessage, PhotoSummary, RunRequest } from "../../shared/engine";
import { MOCK_BOLD_IMAGE } from "./mockEngine";
import { MIA, makeMock, unwrap, type Mock } from "./mockEngine.testkit";
import { runWorld, startRun, toDone } from "./mockLaunchRun.testkit";

// 5a.3 (S5.9f, plan s5a3 §8, §12, gap A): a photo drawn on the Seedream route carries `route: "seedream"` (the model id alone cannot tell it from the 1K moderation fallback), and
// the owner's old photos carry none. A Seedream slot's two ends are knobs of the mock: `refuseBoldNext(n)` (the model refused: the slot ends `model-refused`, nothing spent for the slot) and
// `emptyBoldNext(n)` (a 2xx without an image: the slot ends `model-empty`, settled at the 2K attempt; a second one in a run stops sending, like the engine). Only a Seedream slot meets them.

const NO_POSES = { profile: false, back: false };
const boldRun = (count: number, categories: RunRequest["categories"]): RunRequest => ({ avatarId: MIA.avatarId, count, categories, poses: NO_POSES, level: "bold" });
const ENOUGH = 100_000_000;

async function start(mock: Mock, req: RunRequest): Promise<string> {
  return (await unwrap(mock.client.request("runs.start", { ...req, acceptedWorstMicros: ENOUGH }))).runId;
}
/** The photos of one run (the world also holds photos the library already had). */
async function photosOf(mock: Mock, runId: string): Promise<PhotoSummary[]> {
  return (await unwrap(mock.client.request("photos.list", { avatarId: MIA.avatarId }))).photos.filter((p) => p.runId === runId);
}
function doneOf(events: readonly EventMessage[]) {
  const done = events.find((e) => e.type === "job.done");
  if (done?.type !== "job.done" || done.payload.result.kind !== "run") throw new Error("expected a run's job.done");
  return done.payload.result;
}
async function listed(mock: Mock) {
  const [run] = (await unwrap(mock.client.request("runs.list", {}))).runs;
  if (run === undefined) throw new Error("no run");
  return run;
}
function withEvents() {
  const mock = makeMock();
  const events: EventMessage[] = [];
  mock.client.subscribe((e) => events.push(e));
  return { mock, events };
}

describe("a photo drawn on the Seedream route says so", () => {
  test("«Пляж и бассейн» at «Смелая»: every photo of the run carries the route", async () => {
    const { mock } = withEvents();
    const runId = await start(mock, boldRun(10, ["beach"]));
    mock.scheduler.runAll();
    const photos = await photosOf(mock, runId);
    expect(photos).toHaveLength(10);
    expect(photos.every((p) => p.route === "seedream")).toBe(true);
  });

  test("«Ночнушки и бельё» at «Смелая»: exactly as many photos carry the route as the same count's scenes do, and the ordinary ones carry none", async () => {
    const { mock } = withEvents();
    await unwrap(mock.client.request("scenes.compose", { avatarId: MIA.avatarId, count: 10, categories: ["nightwear"], level: "bold", acceptedWorstMicros: ENOUGH }));
    mock.scheduler.runAll();
    const set = (await unwrap(mock.client.request("scenes.get", { avatarId: MIA.avatarId }))).sceneSet;
    const routedScenes = set?.scenes.filter((s) => s.route === "seedream").length ?? -1;
    const runId = await start(mock, boldRun(10, ["nightwear"]));
    mock.scheduler.runAll();
    const photos = await photosOf(mock, runId);
    expect(photos).toHaveLength(10);
    expect(routedScenes).toBeGreaterThan(0);
    expect(photos.filter((p) => p.route === "seedream")).toHaveLength(routedScenes);
    expect(photos.filter((p) => p.route === undefined)).toHaveLength(10 - routedScenes);
  });

  test("a «Смелая» run over the five ordinary categories carries no route", async () => {
    const { mock } = withEvents();
    const runId = await start(mock, boldRun(5, ["home", "travel"]));
    mock.scheduler.runAll();
    const photos = await photosOf(mock, runId);
    expect(photos).toHaveLength(5);
    expect(photos.some((p) => "route" in p)).toBe(false);
  });

  test("a run made from a set carries the route of each scene it draws", async () => {
    const { mock } = withEvents();
    await unwrap(mock.client.request("scenes.compose", { avatarId: MIA.avatarId, count: 10, categories: ["beach"], level: "bold", acceptedWorstMicros: ENOUGH }));
    mock.scheduler.runAll();
    const set = (await unwrap(mock.client.request("scenes.get", { avatarId: MIA.avatarId }))).sceneSet;
    if (set === null) throw new Error("no set");
    const { runId } = await unwrap(mock.client.request("runs.startFromScenes", { sceneSetId: set.sceneSetId, revision: set.revision, acceptedWorstMicros: ENOUGH }));
    mock.scheduler.runAll();
    const photos = await photosOf(mock, runId);
    expect(photos).toHaveLength(10);
    expect(photos.every((p) => p.route === "seedream")).toBe(true);
  });

  test("a launch's photos carry the route of the scene they were drawn for", async () => {
    const mock = runWorld();
    const started = await startRun(mock, { categories: ["beach"], level: "bold" });
    await toDone(mock, started.launchId);
    const photos = (await unwrap(mock.client.request("photos.list", { avatarId: MIA.avatarId }))).photos.filter((p) => p.category === "beach");
    expect(photos.length).toBeGreaterThan(0);
    expect(photos.every((p) => p.route === "seedream")).toBe(true);
  });

  test("a photo the library already held carries no route", async () => {
    const before = await unwrap(runWorld().client.request("photos.list", { avatarId: MIA.avatarId }));
    expect(before.photos.length).toBeGreaterThan(0);
    expect(before.photos.some((p) => "route" in p)).toBe(false);
  });
});

describe("a Seedream slot the model refuses", () => {
  test("ends model-refused, alone: the run goes on and its other slots draw", async () => {
    const { mock, events } = withEvents();
    mock.engine.refuseBoldNext(2);
    const runId = await start(mock, boldRun(4, ["beach"]));
    mock.scheduler.runAll();
    const result = doneOf(events);
    expect(result.photoIds).toHaveLength(2);
    expect(result.failedSlots).toBe(2);
    expect(result.failedReasons).toEqual([
      { slotIndex: 1, reason: "model-refused" },
      { slotIndex: 2, reason: "model-refused" },
    ]);
    expect(mock.engine.runSlotError(runId, 1)).toMatchObject({ code: "MODERATION_REFUSED", sceneReason: "model-refused" });
  });

  test("costs nothing for the slot: only the slots that drew are settled", async () => {
    const { mock } = withEvents();
    mock.engine.refuseBoldNext(2);
    await start(mock, boldRun(4, ["beach"]));
    mock.scheduler.runAll();
    expect((await listed(mock)).committedMicros).toBe(2 * MOCK_BOLD_IMAGE);
  });

  test("is final: the run has nothing left to resume", async () => {
    const { mock } = withEvents();
    mock.engine.refuseBoldNext(4);
    await start(mock, boldRun(4, ["beach"]));
    mock.scheduler.runAll();
    expect(await listed(mock)).toMatchObject({ done: 0, failed: 4, open: 0, resumable: false, committedMicros: 0 });
  });

  test("is not met by an ordinary run: its slots draw and the refusal waits armed", async () => {
    const { mock, events } = withEvents();
    mock.engine.refuseBoldNext(1);
    await start(mock, { avatarId: MIA.avatarId, count: 3, categories: ["home"], poses: NO_POSES });
    mock.scheduler.runAll();
    expect(doneOf(events).failedSlots).toBe(0);
    await start(mock, boldRun(2, ["beach"]));
    mock.scheduler.runAll();
    const last = events.filter((e) => e.type === "job.done").at(-1);
    if (last?.type !== "job.done" || last.payload.result.kind !== "run") throw new Error("expected a run's job.done");
    expect(last.payload.result.failedReasons).toEqual([{ slotIndex: 1, reason: "model-refused" }]);
  });

  // 5a.4 (S5.BA2, 2026-10-26, Q-A2, as parity story 4550): every nightwear slot is on the route now, so the slots off it are a «Смелая» «Дом» run's (still drawn as «Кокетливая»).
  test("is not met by the ordinary slots of a «Смелая» run: only the slots with a route end refused", async () => {
    const { mock, events } = withEvents();
    mock.engine.refuseBoldNext(100);
    await start(mock, boldRun(10, ["home", "nightwear"]));
    mock.scheduler.runAll();
    const result = doneOf(events);
    expect(result.photoIds.length).toBeGreaterThan(0);
    expect(result.failedSlots).toBeGreaterThan(0);
    expect(result.failedSlots + result.photoIds.length).toBe(10);
    expect(result.failedReasons?.every((r) => r.reason === "model-refused")).toBe(true);
  });

  test("ends every slot of a nightwear run refused, for nothing: no nightwear slot is on the owner's model (Q-A2)", async () => {
    const { mock, events } = withEvents();
    mock.engine.refuseBoldNext(100);
    await start(mock, boldRun(10, ["nightwear"]));
    mock.scheduler.runAll();
    const result = doneOf(events);
    expect([result.photoIds.length, result.failedSlots]).toEqual([0, 10]);
    expect(result.failedReasons?.every((r) => r.reason === "model-refused")).toBe(true);
  });

  test("n armed refusals end exactly n Seedream slots, and the knob is spent", async () => {
    const { mock, events } = withEvents();
    mock.engine.refuseBoldNext(1);
    await start(mock, boldRun(3, ["beach"]));
    mock.scheduler.runAll();
    expect(doneOf(events).failedSlots).toBe(1);
    await start(mock, boldRun(3, ["beach"]));
    mock.scheduler.runAll();
    const last = events.filter((e) => e.type === "job.done").at(-1);
    if (last?.type !== "job.done" || last.payload.result.kind !== "run") throw new Error("expected a run's job.done");
    expect(last.payload.result.failedSlots).toBe(0);
  });
});

describe("a Seedream answer without an image", () => {
  test("ends model-empty, alone: the run goes on and ends done", async () => {
    const { mock, events } = withEvents();
    mock.engine.emptyBoldNext(1);
    const runId = await start(mock, boldRun(3, ["beach"]));
    mock.scheduler.runAll();
    const result = doneOf(events);
    expect(result.photoIds).toHaveLength(2);
    expect(result.failedReasons).toEqual([{ slotIndex: 1, reason: "model-empty" }]);
    expect(mock.engine.runSlotError(runId, 1)).toMatchObject({ code: "INTERNAL", sceneReason: "model-empty" });
  });

  test("is settled: the slot cost the 2K attempt although it gave no photo", async () => {
    const { mock } = withEvents();
    mock.engine.emptyBoldNext(1);
    await start(mock, boldRun(3, ["beach"]));
    mock.scheduler.runAll();
    expect((await listed(mock)).committedMicros).toBe(3 * MOCK_BOLD_IMAGE);
  });

  test("a second one in a run stops sending: the run fails and the slots not yet sent stay open", async () => {
    const { mock, events } = withEvents();
    mock.engine.emptyBoldNext(2);
    await start(mock, boldRun(4, ["beach"]));
    mock.scheduler.runAll();
    const failed = events.find((e) => e.type === "job.failed");
    if (failed?.type !== "job.failed") throw new Error("expected the run's job.failed");
    expect(failed.payload.error.code).toBe("INTERNAL");
    expect(events.some((e) => e.type === "job.done")).toBe(false);
    expect(await listed(mock)).toMatchObject({ done: 0, failed: 2, open: 2, committedMicros: 2 * MOCK_BOLD_IMAGE });
  });

  test("a resume of that run is priced at the 2K attempt for the slots still open, and names it", async () => {
    const { mock } = withEvents();
    mock.engine.emptyBoldNext(2);
    const runId = await start(mock, boldRun(4, ["beach"]));
    mock.scheduler.runAll();
    const { estimate } = await unwrap(mock.client.request("runs.estimateResume", { runId }));
    expect(estimate).toMatchObject({ worstMicros: 2 * 3 * MOCK_BOLD_IMAGE, expectedMicros: 2 * MOCK_BOLD_IMAGE, boldAttemptMicros: MOCK_BOLD_IMAGE });
  });

  test("the resume sends again: one empty answer more is the run's third, and it stops at once", async () => {
    const { mock, events } = withEvents();
    mock.engine.emptyBoldNext(2);
    const runId = await start(mock, boldRun(4, ["beach"]));
    mock.scheduler.runAll();
    mock.engine.emptyBoldNext(1);
    await unwrap(mock.client.request("runs.resume", { runId, acceptedWorstMicros: ENOUGH }));
    mock.scheduler.runAll();
    expect(events.filter((e) => e.type === "job.failed")).toHaveLength(2);
  });

  test("a resume with the model answering draws the open slots", async () => {
    const { mock, events } = withEvents();
    mock.engine.emptyBoldNext(2);
    const runId = await start(mock, boldRun(4, ["beach"]));
    mock.scheduler.runAll();
    await unwrap(mock.client.request("runs.resume", { runId, acceptedWorstMicros: ENOUGH }));
    mock.scheduler.runAll();
    const done = doneOf(events);
    expect(done.photoIds).toHaveLength(2);
    expect(done.failedReasons).toEqual([
      { slotIndex: 1, reason: "model-empty" },
      { slotIndex: 2, reason: "model-empty" },
    ]);
  });
});
