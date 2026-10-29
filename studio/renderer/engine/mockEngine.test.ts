import { expect, test } from "bun:test";
import { type EventMessage } from "../../shared/engine";
import { DEFAULT_TRAITS } from "../lib/traits";
import { MOCK_ESTIMATE, MockEngine, mockEngineClient } from "./mockEngine";
import { ManualScheduler } from "./scheduler";

function makeMock(options: ConstructorParameters<typeof MockEngine>[0] = {}) {
  const scheduler = new ManualScheduler();
  const engine = new MockEngine({ scheduler, ...options });
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

test("a whole avatar flow goes through the validating client without contract errors", async () => {
  const { scheduler, client, events } = makeMock({ imageAgeCheck: "on" });
  const snapshot = await unwrap(client.request("engine.snapshot", {}));
  expect(snapshot.avatars).toEqual([]);

  const estimate = await unwrap(client.request("avatars.estimate", { traits: DEFAULT_TRAITS }));
  expect(estimate).toEqual(MOCK_ESTIMATE);

  const { draft } = await unwrap(client.request("avatars.createDraft", { traits: DEFAULT_TRAITS, acceptedWorstMicros: estimate.worstMicros }));
  const { jobId } = await unwrap(client.request("avatars.generateCandidates", { avatarId: draft.avatarId, acceptedWorstMicros: estimate.worstMicros }));

  scheduler.runAll();
  const progress = events.filter((e) => e.type === "job.progress");
  expect(progress.map((e) => (e.type === "job.progress" ? e.payload.done : -1))).toEqual([1, 2, 3, 4]);
  // Protocol 3: every job event names its job.
  expect(progress.every((e) => e.type === "job.progress" && e.payload.kind === "avatar.candidates" && e.payload.jobId === jobId && e.payload.avatarId === draft.avatarId)).toBe(true);
  const done = events.find((e) => e.type === "job.done");
  if (done?.type !== "job.done" || done.payload.result.kind !== "avatar.candidates") throw new Error("expected job.done");
  expect(done.payload.jobId).toBe(jobId);
  expect(done.payload.result.candidates).toHaveLength(4);

  const photoId = done.payload.result.candidates[1]?.photoId ?? "";
  const { avatar } = await unwrap(client.request("avatars.pick", { avatarId: draft.avatarId, photoId, name: "Mia" }));
  // photoCount is the gallery's count: the picked master is not a gallery photo.
  expect(avatar).toMatchObject({ name: "Mia", masterPhotoId: photoId, status: "active", photoCount: 0 });

  const money = await unwrap(client.request("money.status", {}));
  expect(money).toMatchObject({ ledger: "open", spentMicros: MOCK_ESTIMATE.expectedMicros, unsettledMicros: 0, halt: null });

  // Seqs are contiguous from 1 and all carry the same bootId.
  expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
  expect(new Set(events.map((e) => e.bootId)).size).toBe(1);
});

test("a paid command below the current worst case is refused with PRICE_CHANGED and spends nothing", async () => {
  const { engine, client } = makeMock();
  engine.setPrice({ expectedMicros: 215_000, worstMicros: 250_000 });
  const reply = await client.request("avatars.createDraft", { traits: DEFAULT_TRAITS, acceptedWorstMicros: 223_000 });
  expect(reply).toMatchObject({ ok: false, error: { code: "PRICE_CHANGED" } });
  expect(await unwrap(client.request("money.status", {}))).toMatchObject({ spentMicros: 0 });
});

test("budget, reconcile and key gates refuse paid commands", async () => {
  const budget = makeMock({ money: { spentMicros: 9_900_000 } });
  expect(await budget.client.request("avatars.createDraft", { traits: DEFAULT_TRAITS, acceptedWorstMicros: 223_000 })).toMatchObject({
    ok: false,
    error: { code: "BUDGET_EXCEEDED" },
  });

  const reconcile = makeMock();
  reconcile.engine.requireReconcile(["open-reserves"]);
  expect(await reconcile.client.request("avatars.createDraft", { traits: DEFAULT_TRAITS, acceptedWorstMicros: 223_000 })).toMatchObject({
    ok: false,
    error: { code: "RECONCILE_REQUIRED" },
  });

  const noKey = makeMock({ apiKey: { stored: false, last4: null, encryptionAvailable: true, rejected: false } });
  expect(await noKey.client.request("avatars.createDraft", { traits: DEFAULT_TRAITS, acceptedWorstMicros: 223_000 })).toMatchObject({
    ok: false,
    error: { code: "AUTH_INVALID" },
  });
});

test("the API key never comes back, only its last four characters", async () => {
  const { client } = makeMock({ apiKey: { stored: false, last4: null, encryptionAvailable: true, rejected: false } });
  const status = await unwrap(client.request("settings.setApiKey", { key: "sk-or-v1-secret-7890" }));
  expect(status).toEqual({ stored: true, last4: "7890", encryptionAvailable: true, rejected: false });
  expect(JSON.stringify(await unwrap(client.request("engine.snapshot", {})))).not.toContain("secret");
});

test("the music key starts empty, is set and cleared like the API key, and never comes back", async () => {
  const { client, events } = makeMock();
  expect((await unwrap(client.request("settings.get", {}))).musicKey).toEqual({ stored: false, last4: null, rejected: false });

  const status = await unwrap(client.request("settings.setMusicKey", { key: "Zq7-vKt9-Wm2x-Lp4s-0000" }));
  expect(status).toEqual({ stored: true, last4: "0000", rejected: false });
  expect((await unwrap(client.request("settings.get", {}))).musicKey).toEqual(status);
  expect(JSON.stringify(await unwrap(client.request("engine.snapshot", {})))).not.toContain("Wm2x");

  const cleared = await unwrap(client.request("settings.clearMusicKey", {}));
  expect(cleared).toEqual({ stored: false, last4: null, rejected: false });
  expect(events.filter((e) => e.type === "settings.changed")).toHaveLength(2);
});

test("a restart starts a new bootId and flags open reserves for a reconcile", async () => {
  const { engine, client, events } = makeMock();
  const { draft } = await unwrap(client.request("avatars.createDraft", { traits: DEFAULT_TRAITS, acceptedWorstMicros: 223_000 }));
  await unwrap(client.request("avatars.generateCandidates", { avatarId: draft.avatarId, acceptedWorstMicros: 223_000 }));
  const before = engine.currentBootId;
  engine.restart();
  expect(engine.currentBootId).not.toBe(before);
  const last = events.at(-1);
  expect(last).toMatchObject({ bootId: engine.currentBootId, seq: 1, type: "money.changed" });
  const money = await unwrap(client.request("money.status", {}));
  // Reserved per slot, not as one lump for the batch: none of the four ran, so all four are still open.
  expect(money).toMatchObject({ reconcileNeeded: true, reconcileReasons: ["open-reserves"], unsettledCount: 4 });

  const events1 = await unwrap(client.request("engine.events", { afterSeq: 3, bootId: before }));
  expect(events1).toEqual({ gap: true });
});

test("reconcile answers from its queue, then closes open reserves at their worst case", async () => {
  const { engine, client } = makeMock();
  engine.queueReconcile({ status: "too-early", retryAfterMs: 95_000, warnings: [] });
  expect(await unwrap(client.request("money.reconcile", {}))).toEqual({ status: "too-early", retryAfterMs: 95_000, warnings: [] });
  const done = await unwrap(client.request("money.reconcile", {}));
  expect(done).toMatchObject({ status: "done", closedReserves: 0 });
});

// The real engine emits settings.changed on every settings command
// (engine.ts's #emitSettings); without it here, generation-based resync
// (store.ts) is dead in mock/dev mode, since the renderer never learns a
// library switch happened unless it happens to poll a snapshot.

// ---------- money stops the UI must show (review of T6a part 1) ----------

// ---------- unreadable avatars and their rewrite recovery (T6a-2b) ----------

// ---------- M3: mock parity with the engine's guard order and error codes ----------

// ---------- mock parity: one-by-one candidates, IN_FLIGHT, cancellation, failed slots (T8a) ----------


// ---------- the image model choice ----------


