import { describe, expect, test } from "bun:test";
import type { EventMessage, RunRequest } from "../../shared/engine";
import { MOCK_AGE_CHECK_PER_SLOT, MOCK_BOLD_IMAGE } from "./mockEngine";
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
describe("a run's send is decided by the image's own reserve, the age check by its own", () => {
  const failedOf = (events: readonly EventMessage[]) => events.find((e) => e.type === "job.failed");
  const AGE_WORST = MOCK_AGE_CHECK_PER_SLOT.worst;
  // The first slot of every run below is drawn and settles the 2K attempt plus the age check's typical price; `room` is what the cap then leaves for the second slot.
  const FIRST_SLOT = MOCK_BOLD_IMAGE + MOCK_AGE_CHECK_PER_SLOT.expected;

  async function resumeMidJob(room: number) {
    const mock = makeMock({ imageAgeCheck: "on" });
    const events: EventMessage[] = [];
    mock.client.subscribe((e) => events.push(e));
    const runId = mock.engine.seedRun(boldRun(3, ["beach"]), 0, FIRST_SLOT + room);
    await unwrap(mock.client.request("runs.resume", { runId, acceptedWorstMicros: ENOUGH }));
    mock.scheduler.runAll();
    const run = (await unwrap(mock.client.request("runs.list", {}))).runs.find((r) => r.runId === runId);
    return { run, events };
  }

  test("with the age check on and room for the image but not for its age check, the image is sent and billed, the slot stays open and the job ends RUN_CAP_EXCEEDED", async () => {
    const { run, events } = await resumeMidJob(MOCK_BOLD_IMAGE + AGE_WORST - 1);
    expect(run).toMatchObject({ committedMicros: FIRST_SLOT + MOCK_BOLD_IMAGE, done: 1, open: 2 });
    const failed = failedOf(events);
    expect(failed?.type === "job.failed" && failed.payload.error.code).toBe("RUN_CAP_EXCEEDED");
  });

  test("with the age check on and room for the image and its age check, the second slot is drawn", async () => {
    const { run } = await resumeMidJob(MOCK_BOLD_IMAGE + AGE_WORST);
    expect(run).toMatchObject({ done: 2, open: 1 });
  });

  test("with room for less than the image, the second slot is not sent", async () => {
    const { run } = await resumeMidJob(MOCK_BOLD_IMAGE - 1);
    expect(run).toMatchObject({ committedMicros: FIRST_SLOT, done: 1, open: 2 });
  });

  test("a slot armed to fail meets the cap like any other: with no room for its image it stays open and the job ends RUN_CAP_EXCEEDED", async () => {
    const mock = makeMock();
    const events: EventMessage[] = [];
    mock.client.subscribe((e) => events.push(e));
    // Three ordinary slots at 50 000 µ$; the cap funds two and leaves 40 000 µ$ for the third, which is armed to fail.
    const runId = mock.engine.seedRun({ avatarId: MIA.avatarId, count: 3, categories: ["home"], poses: NO_POSES }, 0, 140_000);
    mock.engine.failNextRunSlots(1);
    await unwrap(mock.client.request("runs.resume", { runId, acceptedWorstMicros: ENOUGH }));
    mock.scheduler.runAll();
    expect((await unwrap(mock.client.request("runs.list", {}))).runs.find((r) => r.runId === runId)).toMatchObject({ done: 2, failed: 0, open: 1 });
    const failed = failedOf(events);
    expect(failed?.type === "job.failed" && failed.payload.error.code).toBe("RUN_CAP_EXCEEDED");
  });
});

// A paid attempt whose picture was dropped (the age check had no room) still counts toward the slot's three (journal.ts: `paidAttempts`): a resume prices only the attempts left,
// and a slot with all three paid ends without a fourth.
describe("a slot's paid attempts count on resume", () => {
  const worstOf = async (mock: ReturnType<typeof makeMock>, runId: string) => (await unwrap(mock.client.request("runs.estimateResume", { runId }))).estimate.worstMicros;

  test("a slot with two paid attempts is priced at one more, not three", async () => {
    const mock = makeMock();
    const fresh = mock.engine.seedRun(boldRun(2, ["beach"]), 0, ENOUGH);
    const spent = mock.engine.seedRun(boldRun(2, ["beach"]), 0, ENOUGH, { paid: 2 });
    expect(await worstOf(mock, spent)).toBe(((await worstOf(mock, fresh)) * 4) / 6);
  });

  test("a slot with all three attempts paid ends failed on resume instead of being sent again", async () => {
    const mock = makeMock();
    const runId = mock.engine.seedRun(boldRun(2, ["beach"]), 0, ENOUGH, { paid: 3 });
    await unwrap(mock.client.request("runs.resume", { runId, acceptedWorstMicros: ENOUGH }));
    mock.scheduler.runAll();
    expect((await unwrap(mock.client.request("runs.list", {}))).runs.find((r) => r.runId === runId)).toMatchObject({ done: 1, failed: 1, open: 0 });
  });

  test("the estimate's expected sum leaves out a slot with all three attempts paid, as the engine does", async () => {
    const mock = makeMock();
    const one = mock.engine.seedRun(boldRun(1, ["beach"]), 0, ENOUGH);
    const exhausted = mock.engine.seedRun(boldRun(2, ["beach"]), 0, ENOUGH, { paid: 3 });
    const expectedOf = async (runId: string) => (await unwrap(mock.client.request("runs.estimateResume", { runId }))).estimate.expectedMicros;
    expect(await expectedOf(exhausted)).toBe(await expectedOf(one));
  });

  test("a run whose only open slot has all three attempts paid is not ended by its cap: the engine has nothing to fund", async () => {
    const mock = makeMock();
    const runId = mock.engine.seedRun(boldRun(1, ["beach"]), 0, 1_000, { paid: 3 });
    expect((await unwrap(mock.client.request("runs.list", {}))).runs.find((r) => r.runId === runId)).toMatchObject({ capExhausted: false, resumable: true });
  });

  test("such a run is not held by a missing 2K tier, and names no 2K attempt", async () => {
    const mock = makeMock();
    const runId = mock.engine.seedRun(boldRun(1, ["beach"]), 0, ENOUGH, { paid: 3 });
    mock.engine.lackBoldPrice();
    const reply = await mock.client.request("runs.estimateResume", { runId });
    expect(reply.ok).toBe(true);
    expect(reply.ok && reply.result.estimate.boldAttemptMicros).toBeUndefined();
  });

  test("a resume reserves only the attempts the slot has left", async () => {
    const committedAtStart = async (paid: number | undefined) => {
      const mock = makeMock();
      const runId = mock.engine.seedRun(boldRun(1, ["beach"]), 0, ENOUGH, paid === undefined ? {} : { paid });
      await unwrap(mock.client.request("runs.resume", { runId, acceptedWorstMicros: ENOUGH }));
      return (await unwrap(mock.client.request("runs.list", {}))).runs.find((r) => r.runId === runId)?.committedMicros ?? Number.NaN;
    };
    const fresh = await committedAtStart(undefined);
    expect(fresh).toBeGreaterThan(0);
    expect((await committedAtStart(2)) * 3).toBe(fresh);
  });

  test("an age check with no room drops the picture but not the bill: the slot has one attempt paid", async () => {
    const mock = makeMock({ imageAgeCheck: "on" });
    const runId = mock.engine.seedRun(boldRun(3, ["beach"]), 0, MOCK_BOLD_IMAGE + MOCK_AGE_CHECK_PER_SLOT.expected + MOCK_BOLD_IMAGE + MOCK_AGE_CHECK_PER_SLOT.worst - 1);
    await unwrap(mock.client.request("runs.resume", { runId, acceptedWorstMicros: ENOUGH }));
    mock.scheduler.runAll();
    const run = (mock.engine as unknown as { runs: { runId: string; slots: { end: string | null; paid?: number }[] }[] }).runs.find((r) => r.runId === runId);
    expect(run?.slots.map((s) => s.paid ?? 0)).toEqual([0, 1, 0]);
  });
});
