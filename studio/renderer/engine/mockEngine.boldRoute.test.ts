import { describe, expect, test } from "bun:test";
import type { EventMessage, PhotoSummary, RunRequest } from "../../shared/engine";
import { MIA, makeMock, unwrap, type Mock } from "./mockEngine.testkit";

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

  // 5a.4 (S5.BA7, 2026-10-27, plan s5a4 I5.77, §5.7; BA5 review L-5): scope edit. «Смелая» plans the five on the route (I5.71), so a «Смелая» run over them carries it on every photo; the run
  // with no route is a «Кокетливая» one.

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

  // 5a.4 (S5.BA2, 2026-10-26, Q-A2, as parity story 4550): every nightwear slot is on the route now, so the slots off it were a «Смелая» «Дом» run's (drawn as «Кокетливая»).
  // 5a.4 (S5.BA3, 2026-10-26, plan s5a4 §7.4, QB-5, BA2 part 2 review L1): «Смелая» plans «Дом» on the route once the mock mirrors the engine, and the mix is the point (a run that has slots on and off the
  // route), so the run is made from a set stored before 5a.4: seeded, then started from its scenes.

});

