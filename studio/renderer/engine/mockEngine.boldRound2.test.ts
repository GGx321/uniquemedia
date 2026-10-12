import { describe, expect, test } from "bun:test";
import type { EventMessage, RunRequest } from "../../shared/engine";
import { MOCK_BOLD_IMAGE } from "./mockEngine";
import { MIA, freePhotos, makeMock, unwrap } from "./mockEngine.testkit";
import { draftOf, errorOf, runUntil, runWorld, startRun, tick } from "./mockLaunchRun.testkit";

// 5a.3 (S5.9f, round 2): the mock agrees with the engine where the first round left it apart: a launch's slice run knows which of its slots are on the Seedream route (so a resume prices them
// at the 2K attempt and a finished slice bills it), a resume and a launch start meet a missing 2K tier as the engine does, the zero-photo launch estimate names the 2K attempt, the knobs add up,
// and an empty answer is not billed for a request the cap would not have let out.

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
    mock.engine.failNextRunSlots(0);
    const { runId } = await unwrap(mock.client.request("runs.start", { avatarId: MIA.avatarId, count: 3, categories: ["home"], poses: NO_POSES, acceptedWorstMicros: ENOUGH }));
    mock.scheduler.next();
    await unwrap(mock.client.request("runs.cancel", { runId }));
    mock.scheduler.runAll();
    mock.engine.lackBoldPrice();
    expect((await mock.client.request("runs.estimateResume", { runId })).ok).toBe(true);
  });
});

describe("the price of a «Смелая» launch's photos still to draw, with none left", () => {
  test("is zero and still names the 2K attempt, as the engine's estimate does", async () => {
    const mock = runWorld();
    const started = await startRun(mock, { categories: ["nightwear"], level: "bold" });
    const row = started.avatars[0];
    if (row === undefined) throw new Error("no row");
    const { estimate, photos } = await unwrap(mock.client.request("runs.estimateImages", { launchId: started.launchId, avatarId: row.avatarId }));
    expect(photos).toBe(0);
    expect(estimate).toMatchObject({ expectedMicros: 0, worstMicros: 0, boldAttemptMicros: MOCK_BOLD_IMAGE });
  });

  test("names no 2K attempt for an ordinary launch", async () => {
    const mock = runWorld();
    const started = await startRun(mock, { categories: ["home"] });
    const row = started.avatars[0];
    if (row === undefined) throw new Error("no row");
    const { estimate } = await unwrap(mock.client.request("runs.estimateImages", { launchId: started.launchId, avatarId: row.avatarId }));
    expect("boldAttemptMicros" in estimate).toBe(false);
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

describe("an empty answer needs a request the cap lets out", () => {
  test("a slot whose reserve was cut below one attempt is not sent: no empty answer, nothing billed, the slot stays open", async () => {
    const mock = makeMock();
    mock.engine.emptyBoldNext(2);
    const { runId } = await unwrap(mock.client.request("runs.start", { ...boldRun(4, ["beach"]), acceptedWorstMicros: ENOUGH }));
    mock.scheduler.runAll();
    // The model got dearer while the run stood: the cap that funded all four slots at 93 000 µ$ leaves 930 000 µ$, which funds the first open slot's attempt at 400 000 µ$ and no more.
    mock.engine.setRunImagePrice(400_000);
    mock.engine.refuseBoldNext(1);
    mock.engine.emptyBoldNext(1);
    await unwrap(mock.client.request("runs.resume", { runId, acceptedWorstMicros: ENOUGH }));
    mock.scheduler.runAll();
    const run = (await unwrap(mock.client.request("runs.list", {}))).runs[0];
    // The first open slot met the refusal (free). The second had no room for an attempt: never sent, so the empty answer was never given or billed.
    expect(run).toMatchObject({ committedMicros: 2 * MOCK_BOLD_IMAGE, failed: 3, open: 1 });
  });
});
