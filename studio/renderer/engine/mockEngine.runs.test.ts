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

test("runs.estimate prices a run like the Photos mockup: 20 photos is ≈ $1.00, до $3.00", async () => {
  const { client } = makeMock();
  const { estimate } = await unwrap(client.request("runs.estimate", REQUEST));
  expect(estimate).toMatchObject({ expectedMicros: 1_000_000, worstMicros: 3_000_000 });
});

test("runs.start caps the run at the chosen quality's worst case, so a price accepted at the low quality is PRICE_CHANGED once medium is chosen", async () => {
  const { client } = makeMock();
  await unwrap(client.request("settings.setModels", { imageModel: "x-ai/grok-imagine-image-2.0", imageQuality: "medium", textModel: "x-ai/grok-4.3" }));

  expect(await client.request("runs.start", { ...REQUEST, acceptedWorstMicros: 3_000_000 })).toMatchObject({ ok: false, error: { code: "PRICE_CHANGED" } });
  expect(await client.request("runs.start", { ...REQUEST, acceptedWorstMicros: 4_200_000 })).toMatchObject({ ok: true });
});

test("runs.start refuses a price the user did not accept, and a second run of a busy avatar", async () => {
  const { client, engine } = makeMock();
  expect(await client.request("runs.start", { ...REQUEST, acceptedWorstMicros: 2_999_999 })).toMatchObject({ ok: false, error: { code: "PRICE_CHANGED" } });
  expect(await unwrap(client.request("runs.list", {}))).toEqual({ runs: [] });

  await unwrap(client.request("runs.start", { ...REQUEST, acceptedWorstMicros: 3_000_000 }));
  expect(await client.request("runs.start", { ...REQUEST, acceptedWorstMicros: 3_000_000 })).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });

  engine.setRunImagePrice(60_000);
  expect((await unwrap(client.request("runs.estimate", REQUEST))).estimate.worstMicros).toBe(3_600_000);
});

test("a cancel keeps only the in-flight slots' reserves open (MEDIUM-2); reconciling frees the rest for the resume to price again", async () => {
  const { scheduler, client, events } = makeMock(); // default concurrency: 6
  const { runId, jobId } = await unwrap(client.request("runs.start", { ...REQUEST, acceptedWorstMicros: 3_000_000 }));
  scheduler.next(); // one slot lands

  expect(await unwrap(client.request("runs.cancel", { runId }))).toEqual({ runId });
  expect(events.some((e) => e.type === "job.cancelled")).toBe(false);
  scheduler.runAll();
  expect(events.filter((e) => e.type === "job.cancelled").map((e) => (e.type === "job.cancelled" ? e.payload.jobId : ""))).toEqual([jobId]);
  expect(events.some((e) => e.type === "job.done")).toBe(false);

  // 19 open slots, but only 6 (the network's own concurrency) were ever
  // actually in flight: their reserves ($0.90) stay open, the other 13's
  // ($1.95, never sent) are released for free. Committed so far: $0.05
  // settled + $0.90 reserved = $0.95; the cap ($3.00) leaves $2.05.
  const [run] = (await unwrap(client.request("runs.list", {}))).runs;
  expect(run).toMatchObject({ runId, done: 1, open: 19, running: false, resumable: true, committedMicros: 950_000, remainingWorstMicros: 2_050_000 });
  const { estimate } = await unwrap(client.request("runs.estimateResume", { runId }));
  expect(estimate).toMatchObject({ expectedMicros: 950_000, worstMicros: 2_050_000 });

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
  expect(await client.request("runs.resume", { runId, acceptedWorstMicros: 3_000_000 })).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
});

// 5a.2 (S5.6d): a slot whose sentence breaks today's word rules ends alone, free, with the scene reason `slot-text-problem`. The slot's error itself is not on the wire (S5.7a puts only its
// scene reason on the result), so the mock keeps it for the test that wants to see which kind of end it was.

// S5.7a (I5.31): the result names the reason of the slots that ended with one, as the engine's job end does; a slot that failed for another reason names none.

// Protocol 3: every job event names its job (kind, avatar and, for a run, the runId).

// A run whose cap cannot fund one more attempt has ended (protocol 4): the mock follows the real engine's rule.

test("a cap that leaves exactly one attempt still funds a resume; one micro-dollar less ends the run (the boundary)", async () => {
  const { engine, client } = makeMock();
  const funded = engine.seedRun({ ...REQUEST, count: 12, categories: ["home"] }, 8, 400_000 + 50_000);
  const ended = engine.seedRun({ ...REQUEST, count: 12, categories: ["home"] }, 8, 400_000 + 49_999);
  const runs = (await unwrap(client.request("runs.list", {}))).runs;
  expect(runs.find((r) => r.runId === funded)).toMatchObject({ resumable: true, capExhausted: false });
  expect(runs.find((r) => r.runId === ended)).toMatchObject({ resumable: false, capExhausted: true });
});

test("runs.estimateResume and runs.resume refuse a cap-exhausted run with RUN_CAP_EXCEEDED", async () => {
  const { engine, client } = makeMock();
  const runId = engine.seedRun({ ...REQUEST, count: 12, categories: ["home"] }, 8, 400_000);
  expect(await client.request("runs.estimateResume", { runId })).toMatchObject({ ok: false, error: { code: "RUN_CAP_EXCEEDED" } });
  expect(await client.request("runs.resume", { runId, acceptedWorstMicros: 0 })).toMatchObject({ ok: false, error: { code: "RUN_CAP_EXCEEDED" } });
});

// ---------- parity with the real engine: the refusals a mock run never used to produce ----------
// S5.6R (I5.30): the writer is priced for the model's scenes alone. A built-in run (WORST_20) has no writer term, like the engine's `runEstimate`; the same run on
// `cat-llm-only-fixture`, whose sentences only the model writes, keeps the writer's chunks (75,000 micro-dollars each: 2 attempts × $0.0375).


// CS.1/CS.2: a custom ref the mock's category library does not hold is unknown, like the engine's: NOT_FOUND, free, after the avatar check and
// before the price (a ref the library holds is covered in mockEngine.categories.test.ts).

// Open reserves count at their worst case only until a reconcile, so a run whose OWN reserves wait for one is never
// called ended by its cap (the real engine pins that with a real run's reserves). A reconcile needed for another
// scope's reserves says nothing about this run's money, so the run is ended all the same, and its estimate refuses.

// Like the engine, the mock announces a run when it launches (done 0), so a window that did not start it sees it at once.

