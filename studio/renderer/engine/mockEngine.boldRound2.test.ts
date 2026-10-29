import { describe, expect, test } from "bun:test";
import type { EventMessage, RunRequest } from "../../shared/engine";
import { MOCK_BOLD_IMAGE } from "./mockEngine";
import { MIA, makeMock, unwrap } from "./mockEngine.testkit";
import { runUntil, runWorld, startRun, tick } from "./mockLaunchRun.testkit";

// 5a.3 (S5.9f, rounds 2 and 3): the mock agrees with the engine where the first round left it apart: a launch's slice run knows which of its slots are on the Seedream route (so a resume prices
// them at the 2K attempt and a finished slice bills it), a resume and a launch start meet a missing 2K tier as the engine does (before the cap, and in the run list), the zero-photo launch
// estimate follows the launch's set, the knobs add up, and the run's cap lets a request out only while one attempt fits.

const ATTEMPTS = 3;
const ENOUGH = 100_000_000;
const NO_POSES = { profile: false, back: false };
const boldRun = (count: number, categories: RunRequest["categories"]): RunRequest => ({ avatarId: MIA.avatarId, count, categories, poses: NO_POSES, level: "bold" });

describe("a launch's slice run takes its routes from the scenes", () => {
  async function stoppedSlice() {
    const mock = runWorld();
    const started = await startRun(mock, { categories: ["beach"], level: "bold", videosPerAvatar: 6 });
    await runUntil(mock, started.launchId, "the draw", (v) => v.avatars.some((a) => a.phase === "drawing" && a.photos.done >= 1));
    await unwrap(mock.client.request("autopilot.stop", { launchId: started.launchId }));
    tick(mock, 50);
    const runs = (await unwrap(mock.client.request("runs.list", {}))).runs;
    const slice = runs.find((r) => r.open > 0);
    if (slice === undefined) throw new Error("the stopped launch left no slice with open slots");
    return { mock, slice };
  }

  test("a resume of the stopped slice is priced at the 2K attempt for each open slot, and names it", async () => {
    const { mock, slice } = await stoppedSlice();
    const { estimate } = await unwrap(mock.client.request("runs.estimateResume", { runId: slice.runId }));
    expect(estimate).toMatchObject({ worstMicros: slice.open * ATTEMPTS * MOCK_BOLD_IMAGE, expectedMicros: slice.open * MOCK_BOLD_IMAGE, boldAttemptMicros: MOCK_BOLD_IMAGE });
  });

});

// The engine reserves per ATTEMPT (93 000 µ$ for a Seedream 2K one, the owner's model's price otherwise) and sends a slot only while the run's settled money and open reserves leave room for it
// (budget.ts: scopeCommitted + worst > cap is RUN_CAP_EXCEEDED). A slot that does not fit stays open, and the job ends failed with that code.
describe("a run's cap lets a request out only while one attempt fits", () => {
  const failedOf = (events: readonly EventMessage[]) => events.find((e) => e.type === "job.failed");

  test("a Seedream slot is sent, billed and ended empty while an attempt still fits, whatever the reserve for the whole slot was cut to", async () => {
    const mock = makeMock();
    const events: EventMessage[] = [];
    mock.client.subscribe((e) => events.push(e));
    mock.engine.emptyBoldNext(2);
    const { runId } = await unwrap(mock.client.request("runs.start", { ...boldRun(4, ["beach"]), acceptedWorstMicros: ENOUGH }));
    mock.scheduler.runAll();
    mock.engine.setRunImagePrice(400_000);
    mock.engine.refuseBoldNext(1);
    mock.engine.emptyBoldNext(1);
    events.length = 0;
    await unwrap(mock.client.request("runs.resume", { runId, acceptedWorstMicros: ENOUGH }));
    mock.scheduler.runAll();
    // The refusal is free; the next slot is sent (930 000 µ$ remain, an attempt is 93 000), comes back empty and is billed; it is the run's third empty answer, so the job stops.
    expect((await unwrap(mock.client.request("runs.list", {}))).runs[0]).toMatchObject({ committedMicros: 3 * MOCK_BOLD_IMAGE, failed: 4, open: 0 });
    const failed = failedOf(events);
    expect(failed?.type === "job.failed" && failed.payload.error.code).toBe("INTERNAL");
  });

  test("a Seedream slot with less than one attempt left is not sent, stays open, and the job ends RUN_CAP_EXCEEDED", async () => {
    const mock = makeMock();
    const events: EventMessage[] = [];
    mock.client.subscribe((e) => events.push(e));
    // Four Seedream slots, one drawn, a cap that funds one more attempt and 50 000 µ$ over: 143 000 µ$ remain, the first open slot fits, the next does not.
    const cap = 2 * MOCK_BOLD_IMAGE + 50_000;
    const runId = mock.engine.seedRun(boldRun(4, ["beach"]), 1, cap);
    await unwrap(mock.client.request("runs.resume", { runId, acceptedWorstMicros: ENOUGH }));
    mock.scheduler.runAll();
    const failed = failedOf(events);
    expect(failed?.type === "job.failed" && failed.payload.error.code).toBe("RUN_CAP_EXCEEDED");
    const run = (await unwrap(mock.client.request("runs.list", {}))).runs.find((r) => r.runId === runId);
    expect(run).toMatchObject({ done: 2, open: 2 });
    expect(run?.committedMicros).toBeLessThanOrEqual(cap);
  });

});

// Polish (post-C4): the engine reserves the IMAGE alone before it sends (image.ts) and the age check separately after the picture is back (ageGate.ts); a refusal of either only
// sets `limited`. A slot the test armed to fail goes through the same reserve, so a cap that leaves no room holds it open instead of ending it.

// A paid attempt whose picture was dropped (the age check had no room) still counts toward the slot's three (journal.ts: `paidAttempts`): a resume prices only the attempts left,
// and a slot with all three paid ends without a fourth.

