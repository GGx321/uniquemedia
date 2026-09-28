import { expect, test } from "bun:test";
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
};

const REQUEST: RunRequest = { avatarId: MIA.avatarId, count: 20, categories: ["home", "travel", "shoot", "glam", "fit"], resolution: "1k", poses: { profile: false, back: false } };

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

test("runs.estimate prices a run like the Photos mockup: 20 × 1K is ≈ $1.01, до $3.07", async () => {
  const { client } = makeMock();
  const { estimate } = await unwrap(client.request("runs.estimate", REQUEST));
  expect(estimate).toMatchObject({ expectedMicros: 1_009_160, worstMicros: 3_070_000 });
  const twoK = await unwrap(client.request("runs.estimate", { ...REQUEST, resolution: "2k" }));
  expect(twoK.estimate.worstMicros).toBe(60 * 70_000 + 70_000);
});

test("the age check, when on, is priced into every attempt", async () => {
  const { client } = makeMock({ imageAgeCheck: "on" });
  const { estimate } = await unwrap(client.request("runs.estimate", REQUEST));
  expect(estimate.worstMicros).toBe(3_070_000 + 60 * 2_000);
});

test("a whole run goes through the validating client: progress per slot, job.done, and its photos listed newest first", async () => {
  const { scheduler, client, events } = makeMock();
  const { runId, jobId } = await unwrap(client.request("runs.start", { ...REQUEST, acceptedWorstMicros: 3_070_000 }));

  scheduler.runAll();
  const progress = events.flatMap((e) => (e.type === "job.progress" ? [e.payload.done] : []));
  expect(progress).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
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
    expect.objectContaining({ runId, total: 20, done: 20, failed: 0, open: 0, running: false, resumable: false, capMicros: 3_070_000, committedMicros: 1_000_000 }),
  ]);

  const money = await unwrap(client.request("money.status", {}));
  expect(money).toMatchObject({ ledger: "open", unsettledMicros: 0 });
});

test("a stored run photo bumps its avatar's photoCount and announces avatar.changed, like the real engine does per photo (MEDIUM-3)", async () => {
  const { scheduler, client, events } = makeMock();
  await unwrap(client.request("runs.start", { ...REQUEST, acceptedWorstMicros: 3_070_000 }));

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

  await unwrap(client.request("runs.start", { ...REQUEST, acceptedWorstMicros: 3_070_000 }));
  expect(await client.request("runs.start", { ...REQUEST, acceptedWorstMicros: 3_070_000 })).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });

  engine.setRunImagePrice("1k", 60_000);
  expect((await unwrap(client.request("runs.estimate", REQUEST))).estimate.worstMicros).toBe(3_670_000);
});

test("runs.estimate and runs.start answer NOT_FOUND for an avatar that is not saved and active", async () => {
  const archived: AvatarSummary = { ...MIA, avatarId: "avatar-nora-0001", status: "archived" };
  const { client } = makeMock({ avatars: [MIA, archived] });
  expect(await client.request("runs.estimate", { ...REQUEST, avatarId: archived.avatarId })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  expect(await client.request("runs.start", { ...REQUEST, avatarId: "avatar-none-0001", acceptedWorstMicros: 9_000_000 })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  // The gallery itself still answers for an archived avatar.
  expect(await unwrap(client.request("photos.list", { avatarId: archived.avatarId }))).toEqual({ photos: [], skippedTotal: 0 });
});

test("a cancel keeps only the in-flight slots' reserves open (MEDIUM-2); reconciling frees the rest for the resume to price again", async () => {
  const { scheduler, client, events } = makeMock(); // default concurrency: 6
  const { runId, jobId } = await unwrap(client.request("runs.start", { ...REQUEST, acceptedWorstMicros: 3_070_000 }));
  scheduler.next(); // one slot lands

  expect(await unwrap(client.request("runs.cancel", { runId }))).toEqual({ runId });
  expect(events.some((e) => e.type === "job.cancelled")).toBe(false);
  scheduler.runAll();
  expect(events.filter((e) => e.type === "job.cancelled").map((e) => (e.type === "job.cancelled" ? e.payload.jobId : ""))).toEqual([jobId]);
  expect(events.some((e) => e.type === "job.done")).toBe(false);

  // 19 open slots, but only 6 (the network's own concurrency) were ever
  // actually in flight: their reserves ($0.90) stay open, the other 13's
  // ($1.95, never sent) are released for free. Committed so far: $0.05
  // settled + $0.90 reserved = $0.95; the cap ($3.07) leaves $2.12.
  const [run] = (await unwrap(client.request("runs.list", {}))).runs;
  expect(run).toMatchObject({ runId, done: 1, open: 19, running: false, resumable: true, committedMicros: 950_000, remainingWorstMicros: 2_120_000 });
  const { estimate } = await unwrap(client.request("runs.estimateResume", { runId }));
  expect(estimate).toMatchObject({ expectedMicros: 950_000, worstMicros: 2_120_000 });

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
  expect(progress[0]).toBe(2); // continues the run's own count
  const done = events.find((e) => e.type === "job.done");
  if (done?.type !== "job.done" || done.payload.result.kind !== "run") throw new Error("expected the resumed run's job.done");
  expect(done.payload.result.photoIds).toHaveLength(20);
  expect(await client.request("runs.resume", { runId, acceptedWorstMicros: 3_070_000 })).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
});

test("a resume never offers more than the run's cap leaves", async () => {
  const { client, engine } = makeMock();
  const runId = engine.seedRun({ ...REQUEST, count: 12 }, 8);
  engine.setRunImagePrice("1k", 1_000_000);
  // 4 open slots × 3 × $1 would be $12; the cap ($1.87) less its $0.40 settled leaves $1.47.
  const { estimate } = await unwrap(client.request("runs.estimateResume", { runId }));
  expect(estimate.worstMicros).toBe(1_870_000 - 400_000);
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
  const { runId } = await unwrap(client.request("runs.start", { ...REQUEST, count: 5, acceptedWorstMicros: 15 * 52_000 + 70_000 }));
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
  expect(estimate).toMatchObject({ expectedMicros: 174_600, worstMicros: 174_600 });
  expect(engine.calls.at(-1)?.type).toBe("runs.estimateResume");
});

test("failed slots end without a photo and are counted in the run's result", async () => {
  const { scheduler, client, events, engine } = makeMock();
  engine.failNextRunSlots(3);
  await unwrap(client.request("runs.start", { ...REQUEST, count: 5, acceptedWorstMicros: 5 * 3 * 50_000 + 70_000 }));
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
  expect(await unwrap(client.request("photos.list", { avatarId: MIA.avatarId }))).toEqual({ photos: [], skippedTotal: 2 });
  expect(await client.request("photos.list", { avatarId: "avatar-none-0001" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
});

test("a running run is in the snapshot as a run job, with its runId and avatar", async () => {
  const { client } = makeMock();
  const { runId, jobId } = await unwrap(client.request("runs.start", { ...REQUEST, acceptedWorstMicros: 3_070_000 }));
  const snapshot = await unwrap(client.request("engine.snapshot", {}));
  expect(snapshot.jobs).toEqual([{ kind: "run", jobId, runId, avatarId: MIA.avatarId, status: "queued", done: 0, total: 20 }]);
});

test("a rejected key fails a running run; its open slots stay open for a resume", async () => {
  const { scheduler, client, engine, events } = makeMock();
  const { runId } = await unwrap(client.request("runs.start", { ...REQUEST, acceptedWorstMicros: 3_070_000 }));
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
  const { runId } = await unwrap(client.request("runs.start", { ...REQUEST, avatarId: mia.avatarId, acceptedWorstMicros: 3_070_000 }));
  expect(runId).toBe("run-0001");
});
