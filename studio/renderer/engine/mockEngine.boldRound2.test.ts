import { describe, expect, test } from "bun:test";
import type { EventMessage, RunRequest } from "../../shared/engine";
import { MOCK_BOLD_IMAGE } from "./mockEngine";
import { MIA, freePhotos, makeMock, unwrap } from "./mockEngine.testkit";
import { draftOf, errorOf, runUntil, runWorld, startRun, tick } from "./mockLaunchRun.testkit";

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

  test("the run list states the same remaining worst case", async () => {
    const { slice } = await stoppedSlice();
    expect(slice.remainingWorstMicros).toBe(slice.open * ATTEMPTS * MOCK_BOLD_IMAGE);
  });

  test("finishing the slice from the gallery draws photos with the Seedream tag and bills the 2K attempt for each", async () => {
    const { mock, slice } = await stoppedSlice();
    const { estimate } = await unwrap(mock.client.request("runs.estimateResume", { runId: slice.runId }));
    await unwrap(mock.client.request("runs.resume", { runId: slice.runId, acceptedWorstMicros: estimate.worstMicros }));
    mock.scheduler.runAll();
    const photos = (await unwrap(mock.client.request("photos.list", { avatarId: MIA.avatarId }))).photos.filter((p) => p.runId === slice.runId);
    expect(photos.length).toBe(slice.total);
    expect(photos.every((p) => p.route === "seedream")).toBe(true);
    const run = (await unwrap(mock.client.request("runs.list", {}))).runs.find((r) => r.runId === slice.runId);
    expect(run?.committedMicros).toBe(slice.total * MOCK_BOLD_IMAGE);
  });
});

describe("a launch start and a resume meet a missing 2K tier as the engine does", () => {
  test("a launch whose draw is all from the library starts although the tier is missing", async () => {
    const photos = freePhotos(40, MIA).map((p) => ({ ...p, category: "nightwear" as const }));
    const mock = runWorld({ photos, avatars: [{ ...MIA, photoCount: 40, eligibleUnusedCount: 40 }] });
    mock.engine.lackBoldPrice();
    const draft = draftOf({ categories: ["nightwear"], level: "bold", library: true, generate: true, videosPerAvatar: 2 });
    const preview = (await unwrap(mock.client.request("autopilot.estimate", { draft }))).preview;
    expect(preview.totals.toGenerate).toBe(0);
    const started = await mock.client.request("autopilot.start", { draft: { ...draft, planSeed: preview.planSeed }, acceptedWorstMicros: preview.estimate.worstMicros });
    expect(started.ok).toBe(true);
  });

  async function failedBoldRun() {
    const mock = makeMock();
    mock.engine.emptyBoldNext(2);
    const { runId } = await unwrap(mock.client.request("runs.start", { ...boldRun(4, ["beach"]), acceptedWorstMicros: ENOUGH }));
    mock.scheduler.runAll();
    return { mock, runId };
  }

  test("estimating a resume that still has Seedream slots is PRICE_UNAVAILABLE with the bold scope", async () => {
    const { mock, runId } = await failedBoldRun();
    mock.engine.lackBoldPrice();
    expect(await errorOf(mock.client.request("runs.estimateResume", { runId }))).toMatchObject({ code: "PRICE_UNAVAILABLE", priceScope: "bold" });
  });

  test("resuming it is refused the same way, and nothing starts", async () => {
    const { mock, runId } = await failedBoldRun();
    mock.engine.lackBoldPrice();
    expect(await errorOf(mock.client.request("runs.resume", { runId, acceptedWorstMicros: ENOUGH }))).toMatchObject({ code: "PRICE_UNAVAILABLE", priceScope: "bold" });
    expect((await unwrap(mock.client.request("runs.list", {}))).runs[0]?.running).toBe(false);
  });

  test("a resume whose open slots are on the owner's model is not refused", async () => {
    const mock = makeMock();
    const runId = mock.engine.seedRun({ avatarId: MIA.avatarId, count: 3, categories: ["home"], poses: NO_POSES }, 1);
    mock.engine.lackBoldPrice();
    expect((await mock.client.request("runs.estimateResume", { runId })).ok).toBe(true);
  });
});

describe("a missing 2K tier is met before the cap is", () => {
  // 50 000 µ$ remain on a run whose open slot is on Seedream: below the 93 000 µ$ attempt, so the run has ended on its cap.
  function exhausted() {
    const mock = makeMock();
    const runId = mock.engine.seedRun(boldRun(3, ["beach"]), 2, 2 * MOCK_BOLD_IMAGE + 50_000);
    return { mock, runId };
  }

  test("with the tier there, the run has ended on its cap: a resume is RUN_CAP_EXCEEDED", async () => {
    const { mock, runId } = exhausted();
    expect(await errorOf(mock.client.request("runs.estimateResume", { runId }))).toMatchObject({ code: "RUN_CAP_EXCEEDED" });
  });

  test("with the tier missing, estimating a resume answers PRICE_UNAVAILABLE with the bold scope", async () => {
    const { mock, runId } = exhausted();
    mock.engine.lackBoldPrice();
    expect(await errorOf(mock.client.request("runs.estimateResume", { runId }))).toMatchObject({ code: "PRICE_UNAVAILABLE", priceScope: "bold" });
  });

  test("with the tier missing, a resume answers PRICE_UNAVAILABLE with the bold scope", async () => {
    const { mock, runId } = exhausted();
    mock.engine.lackBoldPrice();
    expect(await errorOf(mock.client.request("runs.resume", { runId, acceptedWorstMicros: ENOUGH }))).toMatchObject({ code: "PRICE_UNAVAILABLE", priceScope: "bold" });
  });

  test("the run list cannot price the remainder nor tell the cap has ended it: remainingWorstMicros null, capExhausted false, still resumable", async () => {
    const { mock, runId } = exhausted();
    mock.engine.lackBoldPrice();
    const run = (await unwrap(mock.client.request("runs.list", {}))).runs.find((r) => r.runId === runId);
    expect(run).toMatchObject({ remainingWorstMicros: null, capExhausted: false, resumable: true });
  });

  test("the run list prices the remainder again when the tier is back", async () => {
    const { mock, runId } = exhausted();
    mock.engine.lackBoldPrice();
    mock.engine.lackBoldPrice(false);
    const run = (await unwrap(mock.client.request("runs.list", {}))).runs.find((r) => r.runId === runId);
    expect(run?.remainingWorstMicros).not.toBeNull();
    expect(run?.capExhausted).toBe(true);
  });
});

describe("the price of a «Смелая» launch's photos still to draw, with none left", () => {
  // The engine decides «bold» from the avatar's scene SET (`set !== null && isBoldLook(set.request)`, engine.ts), and the set FILE exists only once the launch's compose has made it: the
  // set's id is allocated at the start, the file is not. Before that the answer is the ordinary zero estimate; once the set is there it names the 2K attempt even with nothing left to draw.
  test("before the launch's set exists, it is a zero estimate that names no 2K attempt", async () => {
    const mock = runWorld();
    const started = await startRun(mock, { categories: ["nightwear"], level: "bold" });
    const row = started.avatars[0];
    if (row === undefined) throw new Error("no row");
    const { estimate, photos } = await unwrap(mock.client.request("runs.estimateImages", { launchId: started.launchId, avatarId: row.avatarId }));
    expect(photos).toBe(0);
    expect(estimate).toMatchObject({ expectedMicros: 0, worstMicros: 0 });
    expect("boldAttemptMicros" in estimate).toBe(false);
  });

  test("once the set is there and the avatar has nothing left to draw, it is zero and names the 2K attempt", async () => {
    const mock = runWorld();
    const started = await startRun(mock, { categories: ["nightwear"], level: "bold" });
    const finished = await runUntil(mock, started.launchId, "the montage", (v) => v.avatars.some((a) => a.phase === "montage" || a.phase === "done"));
    const row = finished.avatars[0];
    if (row === undefined) throw new Error("no row");
    const answer = await mock.client.request("runs.estimateImages", { launchId: started.launchId, avatarId: row.avatarId });
    if (!answer.ok) throw new Error(`refused: ${answer.error.code}`);
    expect(answer.result.photos).toBe(0);
    expect(answer.result.estimate).toMatchObject({ expectedMicros: 0, worstMicros: 0, boldAttemptMicros: MOCK_BOLD_IMAGE });
  });

  test("names no 2K attempt for an ordinary launch", async () => {
    const mock = runWorld();
    const started = await startRun(mock, { categories: ["home"] });
    const finished = await runUntil(mock, started.launchId, "the montage", (v) => v.avatars.some((a) => a.phase === "montage" || a.phase === "done"));
    const row = finished.avatars[0];
    if (row === undefined) throw new Error("no row");
    const answer = await mock.client.request("runs.estimateImages", { launchId: started.launchId, avatarId: row.avatarId });
    if (!answer.ok) throw new Error(`refused: ${answer.error.code}`);
    expect("boldAttemptMicros" in answer.result.estimate).toBe(false);
  });
});

describe("the knobs add up", () => {
  test("two refusals armed one after the other refuse two Seedream slots", async () => {
    const mock = makeMock();
    const events: EventMessage[] = [];
    mock.client.subscribe((e) => events.push(e));
    mock.engine.refuseBoldNext(1);
    mock.engine.refuseBoldNext(1);
    await unwrap(mock.client.request("runs.start", { ...boldRun(4, ["beach"]), acceptedWorstMicros: ENOUGH }));
    mock.scheduler.runAll();
    const done = events.find((e) => e.type === "job.done");
    expect(done?.type === "job.done" && done.payload.result.kind === "run" && done.payload.result.failedSlots).toBe(2);
  });

  test("two empty answers armed one after the other end two slots", async () => {
    const mock = makeMock();
    mock.engine.emptyBoldNext(1);
    mock.engine.emptyBoldNext(1);
    await unwrap(mock.client.request("runs.start", { ...boldRun(4, ["beach"]), acceptedWorstMicros: ENOUGH }));
    mock.scheduler.runAll();
    expect((await unwrap(mock.client.request("runs.list", {}))).runs[0]).toMatchObject({ failed: 2, open: 2 });
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
    expect(failedOf(events)?.type).toBe("job.failed");
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

  test("a slot of the owner's model is held to the same rule at the owner's model's price", async () => {
    const mock = makeMock();
    const events: EventMessage[] = [];
    mock.client.subscribe((e) => events.push(e));
    // Four ordinary slots at 50 000 µ$, two drawn, a cap of 160 000 µ$: 60 000 µ$ remain, one more attempt fits, a second does not.
    const runId = mock.engine.seedRun({ avatarId: MIA.avatarId, count: 4, categories: ["home"], poses: NO_POSES }, 2, 160_000);
    await unwrap(mock.client.request("runs.resume", { runId, acceptedWorstMicros: ENOUGH }));
    mock.scheduler.runAll();
    const failed = failedOf(events);
    expect(failed?.type === "job.failed" && failed.payload.error.code).toBe("RUN_CAP_EXCEEDED");
    expect((await unwrap(mock.client.request("runs.list", {}))).runs.find((r) => r.runId === runId)).toMatchObject({ done: 3, open: 1 });
  });
});
