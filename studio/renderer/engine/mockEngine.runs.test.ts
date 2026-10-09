import { describe, expect, test } from "bun:test";
import type { AvatarSummary, EventMessage, RunRequest } from "../../shared/engine";
import { DEFAULT_TRAITS } from "../lib/traits";
import { MockEngine, mockDescriptor, mockEngineClient } from "./mockEngine";
import { ManualScheduler } from "./scheduler";

// T8b: the mock's photo runs, driven through the same validating client the
// renderer uses, so a run, a resume or a gallery answer that drifts from the
// contract fails here first.

const MIA: AvatarSummary = {
  avatarId: "avatar-mia-0001",
  name: "Mia",
  descriptor: mockDescriptor(DEFAULT_TRAITS),
  masterPhotoId: "photo-mia-0001",
  createdAt: "2026-09-24T09:00:00.000Z",
  status: "active",
  photoCount: 1,
  videoCount: 0,
  eligibleUnusedCount: 0,
  usage: { state: "ok" },
};

const REQUEST: RunRequest = { avatarId: MIA.avatarId, count: 20, categories: ["home", "travel", "shoot", "glam", "fit"], poses: { profile: false, back: false } };

function makeMock(options: ConstructorParameters<typeof MockEngine>[0] = {}) {
  const scheduler = new ManualScheduler();
  const engine = new MockEngine({ scheduler, avatars: [MIA], ...options });
  const client = mockEngineClient(engine);
  const events: EventMessage[] = [];
  client.subscribe((e) => events.push(e));
  return { scheduler, engine, client, events };
}

async function unwrap<T>(reply: Promise<{ ok: true; result: T } | { ok: false; error: { code: string } }>): Promise<T> {
  const r = await reply;
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`);
  return r.result;
}

test("runs.estimate prices a run like the Photos mockup: 20 photos is ≈ $1.01, до $3.08", async () => {
  const { client } = makeMock();
  const { estimate } = await unwrap(client.request("runs.estimate", REQUEST));
  expect(estimate).toMatchObject({ expectedMicros: 1_009_160, worstMicros: 3_075_000 });
});

test("runs.estimate prices the chosen quality like the engine: medium is $0.06 + $0.01 an attempt, so 20 photos cap at $4.275 (low: $3.075)", async () => {
  const { client } = makeMock();
  expect((await unwrap(client.request("runs.estimate", REQUEST))).estimate.worstMicros).toBe(3_075_000);

  await unwrap(client.request("settings.setModels", { imageModel: "x-ai/grok-imagine-image-2.0", imageQuality: "medium", textModel: "x-ai/grok-4.3" }));

  expect((await unwrap(client.request("runs.estimate", REQUEST))).estimate.worstMicros).toBe(4_275_000);
});

test("runs.estimate prices the chosen model like the engine: seedream-5-0-pro, with no quality knob, is its own $0.048 an attempt", async () => {
  const { client } = makeMock();

  await unwrap(client.request("settings.setModels", { imageModel: "bytedance-seed/seedream-5-0-pro", textModel: "x-ai/grok-4.3" }));

  expect((await unwrap(client.request("runs.estimate", REQUEST))).estimate.worstMicros).toBe(60 * 48_000 + 75_000);
});

test("runs.start caps the run at the chosen quality's worst case, so a price accepted at the low quality is PRICE_CHANGED once medium is chosen", async () => {
  const { client } = makeMock();
  await unwrap(client.request("settings.setModels", { imageModel: "x-ai/grok-imagine-image-2.0", imageQuality: "medium", textModel: "x-ai/grok-4.3" }));

  expect(await client.request("runs.start", { ...REQUEST, acceptedWorstMicros: 3_075_000 })).toMatchObject({ ok: false, error: { code: "PRICE_CHANGED" } });
  expect(await client.request("runs.start", { ...REQUEST, acceptedWorstMicros: 4_275_000 })).toMatchObject({ ok: true });
});

test("the age check, when on, is priced into every attempt", async () => {
  const { client } = makeMock({ imageAgeCheck: "on" });
  const { estimate } = await unwrap(client.request("runs.estimate", REQUEST));
  expect(estimate.worstMicros).toBe(3_075_000 + 60 * 2_000);
});

test("a whole run goes through the validating client: progress per slot, job.done, and its photos listed newest first", async () => {
  const { scheduler, client, events } = makeMock();
  const { runId, jobId } = await unwrap(client.request("runs.start", { ...REQUEST, acceptedWorstMicros: 3_075_000 }));

  scheduler.runAll();
  const progress = events.flatMap((e) => (e.type === "job.progress" ? [e.payload.done] : []));
  expect(progress).toEqual(Array.from({ length: 21 }, (_, i) => i)); // the launch announcement (0), then one per slot
  const done = events.find((e) => e.type === "job.done");
  if (done?.type !== "job.done" || done.payload.result.kind !== "run") throw new Error("expected a run's job.done");
  expect(done.payload).toMatchObject({ jobId, result: { runId, avatarId: MIA.avatarId, failedSlots: 0 } });
  expect(done.payload.result.photoIds).toHaveLength(20);

  const { photos, skippedTotal } = await unwrap(client.request("photos.list", { avatarId: MIA.avatarId }));
  expect(skippedTotal).toBe(0);
  expect(photos.map((p) => p.photoId)).toEqual([...done.payload.result.photoIds].reverse());
  // The planner's split, in canonical order: four of each category.
  expect(photos.filter((p) => p.category === "glam")).toHaveLength(4);
  // Some carry the face gate's similarity, some none (a profile or back shot).
  expect(photos.filter((p) => p.qa?.faceCos !== undefined)).toHaveLength(16);
  expect(photos.filter((p) => p.qa === undefined)).toHaveLength(4);

  const { runs } = await unwrap(client.request("runs.list", {}));
  expect(runs).toEqual([
    expect.objectContaining({ runId, total: 20, done: 20, failed: 0, open: 0, running: false, resumable: false, capMicros: 3_075_000, committedMicros: 1_000_000 }),
  ]);

  const money = await unwrap(client.request("money.status", {}));
  expect(money).toMatchObject({ ledger: "open", unsettledMicros: 0 });
});

test("a stored run photo bumps its avatar's photoCount and announces avatar.changed, like the real engine does per photo (MEDIUM-3)", async () => {
  const { scheduler, client, events } = makeMock();
  await unwrap(client.request("runs.start", { ...REQUEST, acceptedWorstMicros: 3_075_000 }));

  scheduler.next(); // one slot lands
  const firstChanged = events.filter((e) => e.type === "avatar.changed");
  expect(firstChanged).toHaveLength(1);
  if (firstChanged[0]?.type !== "avatar.changed") throw new Error("expected avatar.changed");
  expect(firstChanged[0].payload.avatar.photoCount).toBe(MIA.photoCount + 1);

  scheduler.runAll(); // the other 19 land
  const list = await unwrap(client.request("avatars.list", {}));
  const mia = list.avatars.find((a) => a.avatarId === MIA.avatarId);
  // The rule (L7/MEDIUM-3): photoCount equals the gallery's own photo count.
  const gallery = await unwrap(client.request("photos.list", { avatarId: MIA.avatarId }));
  expect(mia?.photoCount).toBe(MIA.photoCount + 20);
  expect(mia?.photoCount).toBe(MIA.photoCount + gallery.photos.length);
  expect(events.filter((e) => e.type === "avatar.changed")).toHaveLength(20);
});

test("runs.start refuses a price the user did not accept, and a second run of a busy avatar", async () => {
  const { client, engine } = makeMock();
  expect(await client.request("runs.start", { ...REQUEST, acceptedWorstMicros: 3_069_999 })).toMatchObject({ ok: false, error: { code: "PRICE_CHANGED" } });
  expect(await unwrap(client.request("runs.list", {}))).toEqual({ runs: [] });

  await unwrap(client.request("runs.start", { ...REQUEST, acceptedWorstMicros: 3_075_000 }));
  expect(await client.request("runs.start", { ...REQUEST, acceptedWorstMicros: 3_075_000 })).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });

  engine.setRunImagePrice(60_000);
  expect((await unwrap(client.request("runs.estimate", REQUEST))).estimate.worstMicros).toBe(3_675_000);
});

test("runs.estimate and runs.start answer NOT_FOUND for an avatar that is not saved and active", async () => {
  const archived: AvatarSummary = { ...MIA, avatarId: "avatar-nora-0001", status: "archived" };
  const { client } = makeMock({ avatars: [MIA, archived] });
  expect(await client.request("runs.estimate", { ...REQUEST, avatarId: archived.avatarId })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  expect(await client.request("runs.start", { ...REQUEST, avatarId: "avatar-none-0001", acceptedWorstMicros: 9_000_000 })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  // The gallery itself still answers for an archived avatar.
  expect(await unwrap(client.request("photos.list", { avatarId: archived.avatarId }))).toEqual({ photos: [], skippedTotal: 0, nextCursor: null, remainingTotal: 0 });
});

test("a cancel keeps only the in-flight slots' reserves open (MEDIUM-2); reconciling frees the rest for the resume to price again", async () => {
  const { scheduler, client, events } = makeMock(); // default concurrency: 6
  const { runId, jobId } = await unwrap(client.request("runs.start", { ...REQUEST, acceptedWorstMicros: 3_075_000 }));
  scheduler.next(); // one slot lands

  expect(await unwrap(client.request("runs.cancel", { runId }))).toEqual({ runId });
  expect(events.some((e) => e.type === "job.cancelled")).toBe(false);
  scheduler.runAll();
  expect(events.filter((e) => e.type === "job.cancelled").map((e) => (e.type === "job.cancelled" ? e.payload.jobId : ""))).toEqual([jobId]);
  expect(events.some((e) => e.type === "job.done")).toBe(false);

  // 19 open slots, but only 6 (the network's own concurrency) were ever
  // actually in flight: their reserves ($0.90) stay open, the other 13's
  // ($1.95, never sent) are released for free. Committed so far: $0.05
  // settled + $0.90 reserved = $0.95; the cap ($3.08) leaves $2.12.
  const [run] = (await unwrap(client.request("runs.list", {}))).runs;
  expect(run).toMatchObject({ runId, done: 1, open: 19, running: false, resumable: true, committedMicros: 950_000, remainingWorstMicros: 2_125_000 });
  const { estimate } = await unwrap(client.request("runs.estimateResume", { runId }));
  expect(estimate).toMatchObject({ expectedMicros: 950_000, worstMicros: 2_125_000 });

  // The 6 in-flight slots' reserves stay open at their worst case (M3): any
  // paid call, a resume included, is refused until a reconcile — mirrors the
  // real engine's own open-reserves rule and the mock's own avatars.cancel.
  expect(await client.request("runs.resume", { runId, acceptedWorstMicros: estimate.worstMicros })).toMatchObject({ ok: false, error: { code: "RECONCILE_REQUIRED" } });
  const status = await unwrap(client.request("money.status", {}));
  if (status.ledger !== "open") throw new Error("expected an open ledger");
  expect(status).toMatchObject({ reconcileNeeded: true, reconcileReasons: ["open-reserves"], unsettledMicros: 900_000 });

  expect((await unwrap(client.request("money.reconcile", {}))).status).toBe("done");

  // Reconciled: the released slots' worst case is back in the cap the resume can offer.
  const fresh = await unwrap(client.request("runs.estimateResume", { runId }));
  expect(fresh.estimate).toMatchObject({ worstMicros: 19 * 3 * 50_000 });

  expect(await client.request("runs.resume", { runId, acceptedWorstMicros: fresh.estimate.worstMicros - 1 })).toMatchObject({ ok: false, error: { code: "PRICE_CHANGED" } });
  const resumed = await unwrap(client.request("runs.resume", { runId, acceptedWorstMicros: fresh.estimate.worstMicros }));
  expect(resumed.runId).toBe(runId);
  expect(await client.request("runs.resume", { runId, acceptedWorstMicros: fresh.estimate.worstMicros })).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });

  scheduler.runAll();
  const progress = events.flatMap((e) => (e.type === "job.progress" && e.payload.jobId === resumed.jobId ? [e.payload.done] : []));
  expect(progress.slice(0, 2)).toEqual([1, 2]); // announced at launch with the run's own count, then continues it
  const done = events.find((e) => e.type === "job.done");
  if (done?.type !== "job.done" || done.payload.result.kind !== "run") throw new Error("expected the resumed run's job.done");
  expect(done.payload.result.photoIds).toHaveLength(20);
  expect(await client.request("runs.resume", { runId, acceptedWorstMicros: 3_075_000 })).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
});

test("a resume never offers more than the run's cap leaves", async () => {
  const { client, engine } = makeMock();
  const runId = engine.seedRun({ ...REQUEST, count: 12 }, 8);
  engine.setRunImagePrice(1_000_000);
  // 4 open slots × 3 × $1 would be $12; the cap ($1.87) less its $0.40 settled leaves $1.47.
  const { estimate } = await unwrap(client.request("runs.estimateResume", { runId }));
  expect(estimate.worstMicros).toBe(1_875_000 - 400_000);
  expect(estimate.expectedMicros).toBeLessThanOrEqual(estimate.worstMicros);
});

test("a capped resume's own reserves never push committedMicros past the run's cap (N6)", async () => {
  const { client, engine } = makeMock();
  // capMicros $0.60: $0.40 already settled (8 done at $0.05), $0.20 left for
  // 4 open slots whose raw worst case (4 × 3 × $0.05 = $0.60) is 3× that.
  const runId = engine.seedRun({ ...REQUEST, count: 12, categories: ["home"] }, 8, 8 * 50_000 + 200_000);
  const { estimate } = await unwrap(client.request("runs.estimateResume", { runId }));
  expect(estimate.worstMicros).toBe(200_000);

  const resumed = await unwrap(client.request("runs.resume", { runId, acceptedWorstMicros: estimate.worstMicros }));
  const [run] = (await unwrap(client.request("runs.list", {}))).runs;
  expect(run).toMatchObject({ runId, capMicros: 600_000, committedMicros: 600_000 });
  expect(run?.committedMicros).toBeLessThanOrEqual(run?.capMicros ?? 0);
  expect(resumed.runId).toBe(runId);
});

test("runs.estimateResume on a fully ended run answers VALIDATION, like runs.resume itself (L7)", async () => {
  const { client, engine } = makeMock();
  const runId = engine.seedRun({ ...REQUEST, count: 3, categories: ["home"] }, 3); // every slot already done
  expect(await client.request("runs.estimateResume", { runId })).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
});

test("runs.list answers no runs at all when the ledger is unavailable, like the real engine's own #listRuns (L7)", async () => {
  const { client, engine } = makeMock({ money: { unavailable: { cause: "LEDGER_CORRUPT", detail: "ledger.jsonl:3 is not valid JSON" } } });
  engine.seedRun({ ...REQUEST, count: 3, categories: ["home"] }, 1);
  expect(await unwrap(client.request("runs.list", {}))).toEqual({ runs: [] });
});

test("runs.list orders runs by createdAt, newest first, regardless of seed order (L7)", async () => {
  const { client, engine } = makeMock();
  const first = engine.seedRun({ ...REQUEST, count: 3, categories: ["home"] }, 1); // createdAt an hour before START_OF_TIME: the newer of the two
  const second = engine.seedRun({ ...REQUEST, count: 3, categories: ["home"] }, 1); // createdAt two hours before: the older of the two
  const { runs } = await unwrap(client.request("runs.list", {}));
  expect(runs.map((r) => r.runId)).toEqual([first, second]);
});

test("a run keeps the age-check mode it started with: its resume price and reserves include the checks", async () => {
  const { scheduler, client, engine } = makeMock({ imageAgeCheck: "on" });
  const { runId } = await unwrap(client.request("runs.start", { ...REQUEST, count: 5, acceptedWorstMicros: 15 * 52_000 + 75_000 }));
  scheduler.next();
  const during = await unwrap(client.request("money.status", {}));
  expect(during).toMatchObject({ ledger: "open", unsettledMicros: 4 * 3 * 52_000 });
  await unwrap(client.request("runs.cancel", { runId }));
  scheduler.runAll();

  // Turning the toggle off later does not change a run that was planned with
  // it on. All 4 open slots stayed in flight at cancel (the network's own
  // concurrency, 6, covers them): their reserve (4 × 3 × $0.052 = $0.624)
  // is still open (MEDIUM-2) and already accounts for nearly the whole cap
  // ($0.85), leaving only $0.1746 more before a reconcile.
  await unwrap(client.request("settings.setImageAgeCheck", { imageAgeCheck: "off" }));
  const { estimate } = await unwrap(client.request("runs.estimateResume", { runId }));
  expect(estimate).toMatchObject({ expectedMicros: 179_600, worstMicros: 179_600 });
  expect(engine.calls.at(-1)?.type).toBe("runs.estimateResume");
});

test("failed slots end without a photo and are counted in the run's result", async () => {
  const { scheduler, client, events, engine } = makeMock();
  engine.failNextRunSlots(3);
  await unwrap(client.request("runs.start", { ...REQUEST, count: 5, acceptedWorstMicros: 5 * 3 * 50_000 + 75_000 }));
  scheduler.runAll();
  const done = events.find((e) => e.type === "job.done");
  if (done?.type !== "job.done" || done.payload.result.kind !== "run") throw new Error("expected a run's job.done");
  expect(done.payload.result).toMatchObject({ failedSlots: 3 });
  expect(done.payload.result.photoIds).toHaveLength(2);
  const [run] = (await unwrap(client.request("runs.list", {}))).runs;
  expect(run).toMatchObject({ done: 2, failed: 3, open: 0, resumable: false });
});

test("photos.list is NOT_FOUND only for an unknown avatar, and carries the unreadable count", async () => {
  const { client } = makeMock({ skippedPhotos: { [MIA.avatarId]: 2 } });
  expect(await unwrap(client.request("photos.list", { avatarId: MIA.avatarId }))).toEqual({ photos: [], skippedTotal: 2, nextCursor: null, remainingTotal: 0 });
  expect(await client.request("photos.list", { avatarId: "avatar-none-0001" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
});

test("a running run is in the snapshot as a run job, with its runId and avatar", async () => {
  const { client } = makeMock();
  const { runId, jobId } = await unwrap(client.request("runs.start", { ...REQUEST, acceptedWorstMicros: 3_075_000 }));
  const snapshot = await unwrap(client.request("engine.snapshot", {}));
  expect(snapshot.jobs).toEqual([{ kind: "run", jobId, runId, avatarId: MIA.avatarId, status: "queued", done: 0, total: 20 }]);
});

test("a rejected key fails a running run; its open slots stay open for a resume", async () => {
  const { scheduler, client, engine, events } = makeMock();
  const { runId } = await unwrap(client.request("runs.start", { ...REQUEST, acceptedWorstMicros: 3_075_000 }));
  scheduler.next();
  engine.rejectKey();
  expect(events.some((e) => e.type === "job.failed")).toBe(true);
  const [run] = (await unwrap(client.request("runs.list", {}))).runs;
  expect(run).toMatchObject({ runId, done: 1, open: 19, running: false, resumable: true });
  const money = await unwrap(client.request("money.status", {}));
  expect(money).toMatchObject({ ledger: "open", unsettledMicros: 0 });
});

test("the demo library seeds Mia's gallery and a stopped run to resume, without shifting any other id", async () => {
  const demo = new MockEngine({ preset: "demo", scheduler: new ManualScheduler() });
  const client = mockEngineClient(demo);
  const snapshot = await unwrap(client.request("engine.snapshot", {}));
  const mia = snapshot.avatars.find((a) => a.name === "Mia");
  if (!mia) throw new Error("the demo has Mia");
  const gallery = await unwrap(client.request("photos.list", { avatarId: mia.avatarId }));
  expect(gallery.photos).toHaveLength(8);
  // Demo data consistency: the Avatars grid's own count must match what the Photos screen actually lists.
  expect(mia.photoCount).toBe(gallery.photos.length + gallery.skippedTotal);
  expect((await unwrap(client.request("runs.list", {}))).runs).toEqual([expect.objectContaining({ avatarId: mia.avatarId, done: 8, open: 4, resumable: true })]);
  // The first id the demo hands out afterwards is still its first.
  const { runId } = await unwrap(client.request("runs.start", { ...REQUEST, avatarId: mia.avatarId, acceptedWorstMicros: 3_075_000 }));
  expect(runId).toBe("run-0001");
});

// Protocol 3: every job event names its job (kind, avatar and, for a run, the runId).
test("a run's job events all carry kind, runId and avatarId: progress, then failed or cancelled", async () => {
  const { engine, scheduler, client, events } = makeMock();
  const { runId, jobId } = await unwrap(client.request("runs.start", { ...REQUEST, acceptedWorstMicros: 3_075_000 }));
  scheduler.next();
  await unwrap(client.request("runs.cancel", { runId }));
  scheduler.runAll();
  const ref = { kind: "run", jobId, runId, avatarId: MIA.avatarId };
  expect(events.find((e) => e.type === "job.progress")).toMatchObject({ payload: ref });
  expect(events.find((e) => e.type === "job.cancelled")).toMatchObject({ payload: ref });

  const failing = makeMock();
  const started = await unwrap(failing.client.request("runs.start", { ...REQUEST, acceptedWorstMicros: 3_075_000 }));
  failing.engine.rejectKey();
  expect(failing.events.find((e) => e.type === "job.failed")).toMatchObject({
    payload: { kind: "run", jobId: started.jobId, runId: started.runId, avatarId: MIA.avatarId, error: { code: "AUTH_INVALID" } },
  });
  void engine;
});

// A run whose cap cannot fund one more attempt has ended (protocol 4): the mock follows the real engine's rule.
test("a seeded run whose cap the done slots used up is listed as ended by its cap, not resumable", async () => {
  const { engine, client } = makeMock();
  // 8 done slots settled $0.05 each; the cap is exactly that, so nothing is left for the 4 open slots.
  const runId = engine.seedRun({ ...REQUEST, count: 12, categories: ["home"] }, 8, 400_000);
  const run = (await unwrap(client.request("runs.list", {}))).runs.find((r) => r.runId === runId);
  expect(run).toMatchObject({ done: 8, open: 4, running: false, resumable: false, capExhausted: true, remainingWorstMicros: 0 });
});

test("a cap that leaves exactly one attempt still funds a resume; one micro-dollar less ends the run (the boundary)", async () => {
  const { engine, client } = makeMock();
  const funded = engine.seedRun({ ...REQUEST, count: 12, categories: ["home"] }, 8, 400_000 + 50_000);
  const ended = engine.seedRun({ ...REQUEST, count: 12, categories: ["home"] }, 8, 400_000 + 49_999);
  const runs = (await unwrap(client.request("runs.list", {}))).runs;
  expect(runs.find((r) => r.runId === funded)).toMatchObject({ resumable: true, capExhausted: false });
  expect(runs.find((r) => r.runId === ended)).toMatchObject({ resumable: false, capExhausted: true });
});

test("a torn ledger line, which no run's own reserve caused, does not keep an ended run resumable (the real engine scopes the reconcile check to the run)", async () => {
  const { engine, client } = makeMock();
  const runId = engine.seedRun({ ...REQUEST, count: 12, categories: ["home"] }, 8, 400_000);
  engine.requireReconcile(["torn-ledger-line"]);
  const run = (await unwrap(client.request("runs.list", {}))).runs.find((r) => r.runId === runId);
  expect(run).toMatchObject({ resumable: false, capExhausted: true });
  expect(await client.request("runs.estimateResume", { runId })).toMatchObject({ ok: false, error: { code: "RUN_CAP_EXCEEDED" } });
});

test("runs.estimateResume and runs.resume refuse a cap-exhausted run with RUN_CAP_EXCEEDED", async () => {
  const { engine, client } = makeMock();
  const runId = engine.seedRun({ ...REQUEST, count: 12, categories: ["home"] }, 8, 400_000);
  expect(await client.request("runs.estimateResume", { runId })).toMatchObject({ ok: false, error: { code: "RUN_CAP_EXCEEDED" } });
  expect(await client.request("runs.resume", { runId, acceptedWorstMicros: 0 })).toMatchObject({ ok: false, error: { code: "RUN_CAP_EXCEEDED" } });
});

// ---------- parity with the real engine: the refusals a mock run never used to produce ----------

const WORST_20 = 20 * 3 * 50_000 + 75_000;
const START = { ...REQUEST, acceptedWorstMicros: WORST_20 };

async function runCount(client: ReturnType<typeof makeMock>["client"]): Promise<number> {
  return (await unwrap(client.request("runs.list", {}))).runs.length;
}

test("the writer's worst case is the real engine's 75,000 micro-dollars per chunk: 20 photos are «до $3.08» exactly", async () => {
  const { client } = makeMock();
  const { estimate } = await unwrap(client.request("runs.estimate", REQUEST));
  expect(estimate.worstMicros).toBe(WORST_20);
  // 100 photos are four writer chunks, like the real engine's ceil(100 / 25).
  const { estimate: hundred } = await unwrap(client.request("runs.estimate", { ...REQUEST, count: 100 }));
  expect(hundred.worstMicros).toBe(100 * 3 * 50_000 + 4 * 75_000);
});

// CS.1/CS.2: a custom ref the mock's category library does not hold is unknown, like the engine's: NOT_FOUND, free, after the avatar check and
// before the price (a ref the library holds is covered in mockEngine.categories.test.ts).
describe("a custom category in a run request that the library does not hold", () => {
  const WITH_CUSTOM = { ...REQUEST, categories: ["home" as const, "cat-paris-cafes" as const] };

  test("runs.estimate is NOT_FOUND for it, naming it", async () => {
    const { client } = makeMock();
    const reply = await client.request("runs.estimate", WITH_CUSTOM);
    expect(reply).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(reply.ok ? "" : (reply.error.detail ?? "")).toContain("cat-paris-cafes");
  });

  test("runs.start is NOT_FOUND for it, even at a price nobody accepted: no run is created", async () => {
    const { client } = makeMock();
    expect(await client.request("runs.start", { ...WITH_CUSTOM, acceptedWorstMicros: 0 })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await runCount(client)).toBe(0);
  });

  test("an avatar that cannot run is refused for the avatar first, as the engine does", async () => {
    const { client } = makeMock();
    const reply = await client.request("runs.start", { ...WITH_CUSTOM, avatarId: "avatar-nobody", acceptedWorstMicros: 0 });
    expect(reply).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(reply.ok ? "" : (reply.error.detail ?? "")).not.toContain("cat-paris-cafes");
  });

  test("a built-in-only run still starts and splits like the planner: four of each of five categories for 20 photos", async () => {
    const { scheduler, client } = makeMock();
    await unwrap(client.request("runs.start", { ...REQUEST, acceptedWorstMicros: WORST_20 }));
    scheduler.runAll();
    const { photos } = await unwrap(client.request("photos.list", { avatarId: MIA.avatarId }));
    expect(["home", "travel", "shoot", "glam", "fit"].map((c) => photos.filter((p) => p.category === c).length)).toEqual([4, 4, 4, 4, 4]);
  });
});

describe("runs.start refusals, in the real engine's order", () => {
  test("FACE_GATE_UNAVAILABLE when no face gate is wired: free, no run is created", async () => {
    const { engine, client } = makeMock();
    engine.setFaceGateAvailable(false);
    expect(await client.request("runs.start", START)).toMatchObject({ ok: false, error: { code: "FACE_GATE_UNAVAILABLE" } });
    expect(await runCount(client)).toBe(0);
  });

  test("the face gate's load error rides along in the refusal's detail, as in the engine", async () => {
    const { engine, client } = makeMock();
    engine.setFaceGateAvailable(false, "the yunet model could not be read");
    const reply = await client.request("runs.start", START);
    expect(reply.ok ? "" : (reply.error.detail ?? "")).toContain("the yunet model could not be read");
  });

  test("AGE_GATE_UNAVAILABLE only when the image age check is on: off, the missing age gate is not in the run's path", async () => {
    const off = makeMock({ imageAgeCheck: "off" });
    off.engine.setAgeGateAvailable(false);
    expect((await off.client.request("runs.start", START)).ok).toBe(true);

    const on = makeMock({ imageAgeCheck: "on" });
    on.engine.setAgeGateAvailable(false);
    const worstOn = (await unwrap(on.client.request("runs.estimate", REQUEST))).estimate.worstMicros;
    expect(await on.client.request("runs.start", { ...REQUEST, acceptedWorstMicros: worstOn })).toMatchObject({ ok: false, error: { code: "AGE_GATE_UNAVAILABLE" } });
    expect(await runCount(on.client)).toBe(0);
  });

  test("the age gate is checked before the face gate, as the engine does", async () => {
    const { engine, client } = makeMock({ imageAgeCheck: "on" });
    engine.setAgeGateAvailable(false);
    engine.setFaceGateAvailable(false);
    const worstOn = (await unwrap(client.request("runs.estimate", REQUEST))).estimate.worstMicros;
    expect(await client.request("runs.start", { ...REQUEST, acceptedWorstMicros: worstOn })).toMatchObject({ ok: false, error: { code: "AGE_GATE_UNAVAILABLE" } });
  });

  test("LIBRARY_UNAVAILABLE when no library is open: runs.start refuses it, runs.estimate cannot find the avatar (NOT_FOUND) and runs.list has no runs", async () => {
    const { engine, client } = makeMock();
    engine.setLibraryAvailable(false);
    expect(await client.request("runs.start", START)).toMatchObject({ ok: false, error: { code: "LIBRARY_UNAVAILABLE" } });
    expect(await client.request("runs.estimate", REQUEST)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await runCount(client)).toBe(0);
  });

  test("a missing master photo is NOT_FOUND at start, after the avatar itself is found", async () => {
    const { engine, client } = makeMock();
    engine.removeMaster(MIA.avatarId);
    expect(await client.request("runs.start", START)).toMatchObject({ ok: false, error: { code: "NOT_FOUND", detail: expect.stringContaining("master") } });
    expect(await runCount(client)).toBe(0);
    // An avatar the library does not have is NOT_FOUND too, but about the avatar.
    const unknown = await client.request("runs.start", { ...START, avatarId: "avatar-nobody-9999" });
    expect(unknown).toMatchObject({ ok: false, error: { code: "NOT_FOUND", detail: expect.not.stringContaining("master") } });
  });

  test.each(["MASTER_FACE_UNUSABLE", "INTERNAL"] as const)("%s from the master's own look before a run exists: refused free, no run is created", async (code) => {
    const { engine, client } = makeMock();
    engine.setMasterPreflightFailure(MIA.avatarId, { code });
    expect(await client.request("runs.start", START)).toMatchObject({ ok: false, error: { code } });
    expect(await runCount(client)).toBe(0);
    // Cleared, the same start goes through.
    engine.setMasterPreflightFailure(MIA.avatarId, null);
    expect((await client.request("runs.start", START)).ok).toBe(true);
  });

  test("the master's own look comes after the price: a start that would be PRICE_CHANGED never gets that far", async () => {
    const { engine, client } = makeMock();
    engine.setMasterPreflightFailure(MIA.avatarId, { code: "MASTER_FACE_UNUSABLE" });
    expect(await client.request("runs.start", { ...START, acceptedWorstMicros: 1 })).toMatchObject({ ok: false, error: { code: "PRICE_CHANGED" } });
  });

  test("the order: key, then the ledger, then the library, then the avatar, then the master, then the gates, then the price", async () => {
    const { engine, client } = makeMock({ imageAgeCheck: "on" });
    engine.setAgeGateAvailable(false);
    engine.setFaceGateAvailable(false);
    engine.removeMaster(MIA.avatarId);
    engine.setLibraryAvailable(false);
    engine.requireReconcile(["open-reserves"]);
    const cheap = { ...START, acceptedWorstMicros: 1 };
    const codes: string[] = [];
    const next = async (): Promise<void> => {
      const reply = await client.request("runs.start", cheap);
      codes.push(reply.ok ? "ok" : reply.error.code);
    };

    await next(); // the ledger wants a reconcile
    await unwrap(client.request("money.reconcile", {}));
    await next(); // the library is not open
    engine.setLibraryAvailable(true);
    await next(); // the master is gone
    engine.restoreMaster(MIA.avatarId);
    await next(); // the age gate
    engine.setAgeGateAvailable(true);
    await next(); // the face gate
    engine.setFaceGateAvailable(true);
    await next(); // only now the price

    expect(codes).toEqual(["RECONCILE_REQUIRED", "LIBRARY_UNAVAILABLE", "NOT_FOUND", "AGE_GATE_UNAVAILABLE", "FACE_GATE_UNAVAILABLE", "PRICE_CHANGED"]);
  });
});

describe("runs.resume and runs.estimateResume, in the real engine's order", () => {
  const resumeOf = (runId: string) => ({ runId, acceptedWorstMicros: 10_000_000 });

  test("an unknown run is answered by the key, the ledger and the library first, NOT_FOUND only after them", async () => {
    const { engine, client } = makeMock();
    const codes: string[] = [];
    const next = async (): Promise<void> => {
      const reply = await client.request("runs.resume", resumeOf("run-nobody-9999"));
      codes.push(reply.ok ? "ok" : reply.error.code);
    };
    engine.requireReconcile(["open-reserves"]);
    await next();
    await unwrap(client.request("money.reconcile", {}));
    engine.setLibraryAvailable(false);
    await next();
    engine.setLibraryAvailable(true);
    await next();
    expect(codes).toEqual(["RECONCILE_REQUIRED", "LIBRARY_UNAVAILABLE", "NOT_FOUND"]);
  });

  test("a run that is running is IN_FLIGHT before anything else, the key included", async () => {
    const { engine, client } = makeMock();
    const { runId } = await unwrap(client.request("runs.start", START));
    engine.requireReconcile(["open-reserves"]);
    expect(await client.request("runs.resume", resumeOf(runId))).toMatchObject({ ok: false, error: { code: "IN_FLIGHT", detail: expect.stringContaining("already running") } });
  });

  test("the face gate and the library refuse a resume free, and the price is compared last", async () => {
    const { engine, client } = makeMock();
    const runId = engine.seedRun({ ...REQUEST, count: 12, categories: ["home"] }, 8);
    engine.setFaceGateAvailable(false);
    expect(await client.request("runs.resume", resumeOf(runId))).toMatchObject({ ok: false, error: { code: "FACE_GATE_UNAVAILABLE" } });
    engine.setFaceGateAvailable(true);
    engine.setLibraryAvailable(false);
    expect(await client.request("runs.resume", resumeOf(runId))).toMatchObject({ ok: false, error: { code: "LIBRARY_UNAVAILABLE" } });
    expect(await client.request("runs.estimateResume", { runId })).toMatchObject({ ok: false, error: { code: "LIBRARY_UNAVAILABLE" } });
    engine.setLibraryAvailable(true);
    expect(await client.request("runs.resume", { runId, acceptedWorstMicros: 1 })).toMatchObject({ ok: false, error: { code: "PRICE_CHANGED" } });
    expect(await runCount(client)).toBe(1);
  });

  test("a resume whose master is gone starts, then its job fails NOT_FOUND, as the real job's loadMaster does (the engine refuses only a start up front)", async () => {
    const { engine, client, scheduler, events } = makeMock();
    const runId = engine.seedRun({ ...REQUEST, count: 12, categories: ["home"] }, 8);
    engine.removeMaster(MIA.avatarId);
    const { jobId } = await unwrap(client.request("runs.resume", resumeOf(runId)));
    scheduler.runAll();
    expect(events.find((e) => e.type === "job.failed")).toMatchObject({ payload: { kind: "run", jobId, runId, avatarId: MIA.avatarId, error: { code: "NOT_FOUND" } } });
  });
});

describe("resumePrice carries the writer term when the writer has not finished", () => {
  test("a run stopped before its writer answered: every open slot's attempts plus the writer chunk's own ceiling", async () => {
    const { engine, client } = makeMock();
    const runId = engine.seedRun({ ...REQUEST, count: 12, categories: ["home"] }, 0, undefined, { writerDone: false });
    const { estimate } = await unwrap(client.request("runs.estimateResume", { runId }));
    expect(estimate.worstMicros).toBe(12 * 3 * 50_000 + 75_000);
    expect(estimate.expectedMicros).toBe(12 * 50_000 + 12 * 458);
  });

  test("a run whose writer is done has no writer term", async () => {
    const { engine, client } = makeMock();
    const runId = engine.seedRun({ ...REQUEST, count: 12, categories: ["home"] }, 8);
    const { estimate } = await unwrap(client.request("runs.estimateResume", { runId }));
    expect(estimate.worstMicros).toBe(4 * 3 * 50_000);
    expect(estimate.expectedMicros).toBe(4 * 50_000);
  });

  // The engine's minToProgressMicros adds ONE writer call's ceiling (37,500), not the chunk's two attempts (75,000).
  test("the writer's ceiling counts in whether the cap funds a resume: room for one image attempt and one writer call is enough, a micro-dollar less ends the run", async () => {
    const { engine, client } = makeMock();
    // Nothing committed yet (no slot done): the cap is all the room there is.
    const funded = engine.seedRun({ ...REQUEST, count: 12, categories: ["home"] }, 0, 50_000 + 37_500, { writerDone: false });
    const ended = engine.seedRun({ ...REQUEST, count: 12, categories: ["home"] }, 0, 50_000 + 37_500 - 1, { writerDone: false });
    const runs = (await unwrap(client.request("runs.list", {}))).runs;
    expect(runs.find((r) => r.runId === funded)).toMatchObject({ resumable: true, capExhausted: false });
    expect(runs.find((r) => r.runId === ended)).toMatchObject({ resumable: false, capExhausted: true });
  });
});

// Open reserves count at their worst case only until a reconcile, so a run whose OWN reserves wait for one is never
// called ended by its cap (the real engine pins that with a real run's reserves). A reconcile needed for another
// scope's reserves says nothing about this run's money, so the run is ended all the same, and its estimate refuses.
test("a reconcile needed for other scopes' reserves does not stop a run from being reported cap-exhausted; reconciling changes nothing for it", async () => {
  const { engine, client } = makeMock();
  const runId = engine.seedRun({ ...REQUEST, count: 12, categories: ["home"] }, 8, 400_000);
  engine.requireReconcile(["open-reserves"]);
  const during = (await unwrap(client.request("runs.list", {}))).runs.find((r) => r.runId === runId);
  expect(during).toMatchObject({ resumable: false, capExhausted: true });
  expect(await client.request("runs.estimateResume", { runId })).toMatchObject({ ok: false, error: { code: "RUN_CAP_EXCEEDED" } });

  await unwrap(client.request("money.reconcile", {}));
  const after = (await unwrap(client.request("runs.list", {}))).runs.find((r) => r.runId === runId);
  expect(after).toMatchObject({ resumable: false, capExhausted: true });
});

// Like the engine, the mock announces a run when it launches (done 0), so a window that did not start it sees it at once.
test("a run, started or resumed, is announced with a job.progress at launch, before any slot ends", async () => {
  const { client, events } = makeMock();
  const { runId, jobId } = await unwrap(client.request("runs.start", START));
  expect(events.filter((e) => e.type === "job.progress").map((e) => e.payload)).toEqual([{ kind: "run", jobId, runId, avatarId: MIA.avatarId, done: 0, total: 20 }]);

  const other = makeMock();
  const seeded = other.engine.seedRun({ ...REQUEST, count: 12, categories: ["home"] }, 8);
  const resumed = await unwrap(other.client.request("runs.resume", { runId: seeded, acceptedWorstMicros: 10_000_000 }));
  expect(other.events.find((e) => e.type === "job.progress")).toMatchObject({ payload: { kind: "run", jobId: resumed.jobId, runId: seeded, done: 8, total: 12 } });
});
