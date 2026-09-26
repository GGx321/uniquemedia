import { expect, test } from "bun:test";
import { AvatarDescriptor, type EventMessage } from "../../shared/engine";
import { DEFAULT_TRAITS, randomTraits } from "../lib/traits";
import { MOCK_ESTIMATE, MockEngine, mockDescriptor, mockEngineClient } from "./mockEngine";
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

test("the descriptor the mock writes passes the contract for any traits", () => {
  let seed = 1;
  const rng = (): number => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 500; i++) {
    expect(AvatarDescriptor.safeParse(mockDescriptor(randomTraits(rng))).success).toBe(true);
  }
});

test("a whole avatar flow goes through the validating client without contract errors", async () => {
  const { scheduler, client, events } = makeMock();
  const snapshot = await unwrap(client.request("engine.snapshot", {}));
  expect(snapshot.avatars).toEqual([]);

  const estimate = await unwrap(client.request("avatars.estimate", { traits: DEFAULT_TRAITS }));
  expect(estimate).toEqual(MOCK_ESTIMATE);

  const { draft } = await unwrap(client.request("avatars.createDraft", { traits: DEFAULT_TRAITS, acceptedWorstMicros: estimate.worstMicros }));
  const { jobId } = await unwrap(client.request("avatars.generateCandidates", { avatarId: draft.avatarId, acceptedWorstMicros: estimate.worstMicros }));

  scheduler.runAll();
  const progress = events.filter((e) => e.type === "job.progress");
  expect(progress.map((e) => (e.type === "job.progress" ? e.payload.done : -1))).toEqual([1, 2, 3, 4]);
  const done = events.find((e) => e.type === "job.done");
  if (done?.type !== "job.done" || done.payload.result.kind !== "avatar.candidates") throw new Error("expected job.done");
  expect(done.payload.jobId).toBe(jobId);
  expect(done.payload.result.candidates).toHaveLength(4);

  const photoId = done.payload.result.candidates[1]?.photoId ?? "";
  const { avatar } = await unwrap(client.request("avatars.pick", { avatarId: draft.avatarId, photoId, name: "Mia" }));
  expect(avatar).toMatchObject({ name: "Mia", masterPhotoId: photoId, status: "active" });

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

test("a 401 mid-job fails the job with AUTH_INVALID and marks the key rejected", async () => {
  const { scheduler, engine, client, events } = makeMock();
  const { draft } = await unwrap(client.request("avatars.createDraft", { traits: DEFAULT_TRAITS, acceptedWorstMicros: 223_000 }));
  await unwrap(client.request("avatars.generateCandidates", { avatarId: draft.avatarId, acceptedWorstMicros: 223_000 }));
  scheduler.next();
  engine.rejectKey();
  scheduler.runAll();
  expect(events.find((e) => e.type === "job.failed")).toMatchObject({ payload: { error: { code: "AUTH_INVALID" } } });
  expect(events.some((e) => e.type === "job.done")).toBe(false);
  expect((await unwrap(client.request("settings.get", {}))).apiKey.rejected).toBe(true);
});

test("the API key never comes back, only its last four characters", async () => {
  const { client } = makeMock({ apiKey: { stored: false, last4: null, encryptionAvailable: true, rejected: false } });
  const status = await unwrap(client.request("settings.setApiKey", { key: "sk-or-v1-secret-7890" }));
  expect(status).toEqual({ stored: true, last4: "7890", encryptionAvailable: true, rejected: false });
  expect(JSON.stringify(await unwrap(client.request("engine.snapshot", {})))).not.toContain("secret");
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
  expect(money).toMatchObject({ reconcileNeeded: true, reconcileReasons: ["open-reserves"], unsettledCount: 1 });

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
test("every settings command emits settings.changed, carrying the current library-switch generation", async () => {
  const { client, events } = makeMock();

  await unwrap(client.request("settings.setBudget", { monthlyBudgetMicros: 5_000_000 }));

  const changed = events.filter((e) => e.type === "settings.changed");
  expect(changed).toHaveLength(1);
  expect(changed[0]).toMatchObject({ type: "settings.changed", payload: { settings: { monthlyBudgetMicros: 5_000_000 }, librarySwitchGeneration: 0 } });
});

test("settings.setApiKey, clearApiKey, setModels and setConcurrency each emit settings.changed too", async () => {
  const { client, events } = makeMock();

  await unwrap(client.request("settings.setApiKey", { key: "sk-or-v1-abcdefgh-0000" }));
  await unwrap(client.request("settings.clearApiKey", {}));
  await unwrap(client.request("settings.setModels", { imageModel: "bytedance/seedream-5-pro", textModel: "x-ai/grok-5" }));
  await unwrap(client.request("settings.setConcurrency", { network: 3 }));

  expect(events.filter((e) => e.type === "settings.changed")).toHaveLength(4);
});

test("a library switch bumps the generation the settings.changed event carries; the same path does not", async () => {
  const { engine, client, events } = makeMock();
  const other = "/Users/studio/Other/library";

  await unwrap(client.request("settings.setLibraryPath", { path: other }));
  await unwrap(client.request("settings.setLibraryPath", { path: other }));

  const changed = events.filter((e) => e.type === "settings.changed");
  expect(changed).toHaveLength(2);
  expect(changed[0]).toMatchObject({ payload: { settings: { libraryPath: other }, librarySwitchGeneration: 1 } });
  expect(changed[1]).toMatchObject({ payload: { settings: { libraryPath: other }, librarySwitchGeneration: 1 } });
  expect((await unwrap(client.request("engine.snapshot", {}))).librarySwitchGeneration).toBe(1);
  expect(engine.currentBootId).toBeTruthy(); // sanity: this mock did not restart
});

// ---------- money stops the UI must show (review of T6a part 1) ----------

test("a mock whose ledger could not be read reports no amounts and refuses paid commands and reconcile with the cause", async () => {
  const { client } = makeMock({ money: { unavailable: { cause: "LEDGER_CORRUPT", detail: "ledger.jsonl:3 is not valid JSON" } } });
  expect(await unwrap(client.request("money.status", {}))).toEqual({
    ledger: "unavailable",
    month: "2026-09",
    monthlyBudgetMicros: 10_000_000,
    reconcileNeeded: false,
    reconcileReasons: [],
    halt: { cause: "LEDGER_CORRUPT", detail: "ledger.jsonl:3 is not valid JSON" },
  });
  expect(await client.request("avatars.createDraft", { traits: DEFAULT_TRAITS, acceptedWorstMicros: 223_000 })).toMatchObject({
    ok: false,
    error: { code: "LEDGER_CORRUPT" },
  });
  expect(await client.request("money.reconcile", {})).toMatchObject({ ok: false, error: { code: "LEDGER_CORRUPT" } });
});

test("a mock halted by a failed ledger write refuses paid commands and reconcile until a restart", async () => {
  const { client } = makeMock({ money: { halt: { cause: "LEDGER_WRITE_FAILED", detail: "a ledger write failed" } } });
  expect(await unwrap(client.request("money.status", {}))).toMatchObject({ ledger: "open", halt: { cause: "LEDGER_WRITE_FAILED" } });
  expect(await client.request("avatars.createDraft", { traits: DEFAULT_TRAITS, acceptedWorstMicros: 223_000 })).toMatchObject({
    ok: false,
    error: { code: "LEDGER_WRITE_FAILED" },
  });
  expect(await client.request("money.reconcile", {})).toMatchObject({ ok: false, error: { code: "LEDGER_WRITE_FAILED" } });
});

test("a settle above its worst case shows in the money status and a reconcile lifts it", async () => {
  const { engine, client, events } = makeMock();
  engine.haltAboveWorst();
  expect(events.at(-1)).toMatchObject({ type: "money.changed", payload: { status: { halt: { cause: "SETTLE_ABOVE_WORST" } } } });
  expect(await unwrap(client.request("money.reconcile", {}))).toMatchObject({ status: "done", aboveWorstAttempts: ["mock-attempt#1"] });
  expect(await unwrap(client.request("money.status", {}))).toMatchObject({ halt: null });
});

test("another batch for a draft is priced by its own command: accepted at the batch's worst case, it runs", async () => {
  const { client } = makeMock();
  const { draft } = await unwrap(client.request("avatars.createDraft", { traits: DEFAULT_TRAITS, acceptedWorstMicros: MOCK_ESTIMATE.worstMicros }));
  const batch = await unwrap(client.request("avatars.estimateCandidates", { avatarId: draft.avatarId }));
  expect(batch.worstMicros).toBeLessThan(MOCK_ESTIMATE.worstMicros);
  expect(draft.estimate).toEqual(batch);

  const reply = await client.request("avatars.generateCandidates", { avatarId: draft.avatarId, acceptedWorstMicros: batch.worstMicros });
  expect(reply.ok).toBe(true);
});

test("another batch accepted below the batch's worst case is refused with PRICE_CHANGED", async () => {
  const { client } = makeMock();
  const { draft } = await unwrap(client.request("avatars.createDraft", { traits: DEFAULT_TRAITS, acceptedWorstMicros: MOCK_ESTIMATE.worstMicros }));
  const batch = await unwrap(client.request("avatars.estimateCandidates", { avatarId: draft.avatarId }));

  const reply = await client.request("avatars.generateCandidates", { avatarId: draft.avatarId, acceptedWorstMicros: batch.worstMicros - 1 });
  expect(reply).toMatchObject({ ok: false, error: { code: "PRICE_CHANGED" } });
});

// ---------- unreadable avatars and their rewrite recovery (T6a-2b) ----------

test("avatars.list and the snapshot carry a seeded unreadable avatar, with the count derived from its length", async () => {
  const { client, engine } = makeMock();
  engine.seedUnreadable({ avatarId: "avatar-broken-0001", reason: "manifest-unreadable", detail: "its manifest file could not be read or parsed" });

  const list = await unwrap(client.request("avatars.list", {}));
  expect(list.unreadableAvatars).toEqual([{ avatarId: "avatar-broken-0001", reason: "manifest-unreadable", detail: "its manifest file could not be read or parsed" }]);
  expect(list.unreadableTotal).toBe(1);
  const snapshot = await unwrap(client.request("engine.snapshot", {}));
  expect(snapshot.unreadableAvatars).toHaveLength(1);
  expect(snapshot.unreadableTotal).toBe(1);
});

test("avatars.estimateRewriteDescriptor prices the descriptor call alone for a descriptor-invalid entry", async () => {
  const { client, engine } = makeMock();
  engine.seedUnreadable(
    { avatarId: "avatar-broken-0001", reason: "descriptor-invalid", detail: "its stored descriptor no longer fits today's rules" },
    { status: "draft", name: "Draft", traits: DEFAULT_TRAITS },
  );

  const estimate = await unwrap(client.request("avatars.estimateRewriteDescriptor", { avatarId: "avatar-broken-0001" }));
  expect(estimate.worstMicros).toBeLessThan(MOCK_ESTIMATE.worstMicros);
  expect(estimate.expectedMicros).toBeLessThan(estimate.worstMicros);
});

test("avatars.estimateRewriteDescriptor answers NOT_FOUND for an unknown id", async () => {
  const { client } = makeMock();
  expect(await client.request("avatars.estimateRewriteDescriptor", { avatarId: "avatar-nobody-0001" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
});

test("avatars.estimateRewriteDescriptor answers VALIDATION for an avatar whose descriptor already fits: nothing to fix", async () => {
  const { client } = makeMock({ preset: "demo" });
  const { avatars } = await unwrap(client.request("avatars.list", {}));
  const avatarId = avatars[0]?.avatarId ?? "";

  expect(await client.request("avatars.estimateRewriteDescriptor", { avatarId })).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
});

test("avatars.rewriteDescriptor pays once, turns a draft's unreadable entry into a normal draft, and emits draft.changed", async () => {
  const { client, engine, events } = makeMock();
  engine.seedUnreadable(
    { avatarId: "avatar-broken-0001", reason: "descriptor-invalid", detail: "its stored descriptor no longer fits today's rules" },
    { status: "draft", name: "Draft", traits: DEFAULT_TRAITS },
  );
  const estimate = await unwrap(client.request("avatars.estimateRewriteDescriptor", { avatarId: "avatar-broken-0001" }));

  const result = await unwrap(client.request("avatars.rewriteDescriptor", { avatarId: "avatar-broken-0001", acceptedWorstMicros: estimate.worstMicros }));
  expect(result).toEqual({ avatarId: "avatar-broken-0001" });

  const snapshot = await unwrap(client.request("engine.snapshot", {}));
  expect(snapshot.unreadableAvatars).toEqual([]);
  expect(snapshot.drafts).toMatchObject([{ avatarId: "avatar-broken-0001", traits: DEFAULT_TRAITS }]);
  expect(AvatarDescriptor.safeParse(snapshot.drafts[0]?.descriptor).success).toBe(true);
  expect(events.some((e) => e.type === "draft.changed")).toBe(true);
  expect(await unwrap(client.request("money.status", {}))).toMatchObject({ spentMicros: estimate.expectedMicros });
});

test("avatars.rewriteDescriptor turns an active avatar's unreadable entry into a normal, listed avatar and emits avatar.changed", async () => {
  const { client, engine, events } = makeMock();
  engine.seedUnreadable(
    { avatarId: "avatar-broken-0002", reason: "descriptor-invalid", detail: "its stored descriptor no longer fits today's rules" },
    { status: "active", name: "Mia", traits: DEFAULT_TRAITS, masterPhotoId: "photo-broken-0001", photoCount: 3 },
  );
  const estimate = await unwrap(client.request("avatars.estimateRewriteDescriptor", { avatarId: "avatar-broken-0002" }));

  await unwrap(client.request("avatars.rewriteDescriptor", { avatarId: "avatar-broken-0002", acceptedWorstMicros: estimate.worstMicros }));

  const list = await unwrap(client.request("avatars.list", {}));
  expect(list.unreadableAvatars).toEqual([]);
  expect(list.avatars).toMatchObject([{ avatarId: "avatar-broken-0002", name: "Mia", masterPhotoId: "photo-broken-0001", photoCount: 3, status: "active" }]);
  expect(events.some((e) => e.type === "avatar.changed")).toBe(true);
});

test("avatars.rewriteDescriptor answers VALIDATION and spends nothing for an avatar whose descriptor already fits", async () => {
  const { client } = makeMock({ preset: "demo" });
  const { avatars } = await unwrap(client.request("avatars.list", {}));
  const avatarId = avatars[0]?.avatarId ?? "";

  const reply = await client.request("avatars.rewriteDescriptor", { avatarId, acceptedWorstMicros: 1_000_000 });
  expect(reply).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  expect(await unwrap(client.request("money.status", {}))).toMatchObject({ spentMicros: 1_420_000 });
});

test("avatars.rewriteDescriptor answers NOT_FOUND for an unknown id, and PRICE_CHANGED below the current worst case", async () => {
  const { client, engine } = makeMock();
  engine.seedUnreadable(
    { avatarId: "avatar-broken-0003", reason: "descriptor-invalid", detail: "its stored descriptor no longer fits today's rules" },
    { status: "draft", name: "Draft", traits: DEFAULT_TRAITS },
  );
  const estimate = await unwrap(client.request("avatars.estimateRewriteDescriptor", { avatarId: "avatar-broken-0003" }));

  expect(await client.request("avatars.rewriteDescriptor", { avatarId: "avatar-nobody-0001", acceptedWorstMicros: 1_000_000 })).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND" },
  });
  expect(await client.request("avatars.rewriteDescriptor", { avatarId: "avatar-broken-0003", acceptedWorstMicros: estimate.worstMicros - 1 })).toMatchObject({
    ok: false,
    error: { code: "PRICE_CHANGED" },
  });
});

// ---------- M3: mock parity with the engine's guard order and error codes ----------

test("avatars.rewriteDescriptor checks the key and the ledger before the id: AUTH_INVALID beats NOT_FOUND, matching the engine's order", async () => {
  const { client } = makeMock({ apiKey: { stored: false, last4: null, encryptionAvailable: true, rejected: false } });

  expect(await client.request("avatars.rewriteDescriptor", { avatarId: "avatar-nobody-0001", acceptedWorstMicros: 1_000_000 })).toMatchObject({
    ok: false,
    error: { code: "AUTH_INVALID" },
  });
});

test("avatars.rewriteDescriptor checks the key and the ledger before whether there is anything to fix: AUTH_INVALID beats VALIDATION", async () => {
  const { client } = makeMock({ preset: "demo", apiKey: { stored: false, last4: null, encryptionAvailable: true, rejected: false } });
  const { avatars } = await unwrap(client.request("avatars.list", {}));
  const avatarId = avatars[0]?.avatarId ?? "";

  expect(await client.request("avatars.rewriteDescriptor", { avatarId, acceptedWorstMicros: 1_000_000 })).toMatchObject({ ok: false, error: { code: "AUTH_INVALID" } });
});

test("avatars.rewriteDescriptor: a ledger halt beats NOT_FOUND too", async () => {
  const { client } = makeMock({ money: { halt: { cause: "LEDGER_WRITE_FAILED", detail: "a ledger write failed" } } });

  expect(await client.request("avatars.rewriteDescriptor", { avatarId: "avatar-nobody-0001", acceptedWorstMicros: 1_000_000 })).toMatchObject({
    ok: false,
    error: { code: "LEDGER_WRITE_FAILED" },
  });
});

test("a manifest-unreadable entry answers NOT_FOUND, not VALIDATION: the engine never finds such a manifest at all", async () => {
  const { client, engine } = makeMock();
  engine.seedUnreadable({ avatarId: "avatar-broken-0004", reason: "manifest-unreadable", detail: "its manifest file could not be read or parsed" });

  expect(await client.request("avatars.estimateRewriteDescriptor", { avatarId: "avatar-broken-0004" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  expect(await client.request("avatars.rewriteDescriptor", { avatarId: "avatar-broken-0004", acceptedWorstMicros: 1_000_000 })).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND" },
  });
});

test("a contract-mismatch entry (not descriptor-invalid, no recovery target) answers VALIDATION, not NOT_FOUND", async () => {
  const { client, engine } = makeMock();
  engine.seedUnreadable({ avatarId: "avatar-broken-0005", reason: "contract-mismatch", detail: "its stored record no longer fits the contract" });

  expect(await client.request("avatars.rewriteDescriptor", { avatarId: "avatar-broken-0005", acceptedWorstMicros: 1_000_000 })).toMatchObject({
    ok: false,
    error: { code: "VALIDATION" },
  });
});

test("avatars.estimateCandidates and generateCandidates answer DESCRIPTOR_INVALID for a draft whose descriptor fails today's rules", async () => {
  const { client } = makeMock({ drafts: [{ avatarId: "avatar-baddesc-0001", traits: DEFAULT_TRAITS, descriptor: { age: 25, text: "a young woman with hazel eyes" }, candidates: [], estimate: null }] });

  expect(await client.request("avatars.estimateCandidates", { avatarId: "avatar-baddesc-0001" })).toMatchObject({ ok: false, error: { code: "DESCRIPTOR_INVALID" } });
  expect(await client.request("avatars.generateCandidates", { avatarId: "avatar-baddesc-0001", acceptedWorstMicros: 1_000_000 })).toMatchObject({
    ok: false,
    error: { code: "DESCRIPTOR_INVALID" },
  });
});

test("applyRewrite keeps the draft's existing candidates, as the engine does", async () => {
  const { client, engine } = makeMock();
  engine.seedUnreadable(
    { avatarId: "avatar-broken-0006", reason: "descriptor-invalid", detail: "its stored descriptor no longer fits today's rules" },
    { status: "draft", name: "Draft", traits: DEFAULT_TRAITS, candidates: [{ avatarId: "avatar-broken-0006", photoId: "photo-broken-0001" }] },
  );
  const estimate = await unwrap(client.request("avatars.estimateRewriteDescriptor", { avatarId: "avatar-broken-0006" }));

  await unwrap(client.request("avatars.rewriteDescriptor", { avatarId: "avatar-broken-0006", acceptedWorstMicros: estimate.worstMicros }));

  const snapshot = await unwrap(client.request("engine.snapshot", {}));
  expect(snapshot.drafts).toMatchObject([{ avatarId: "avatar-broken-0006", candidates: [{ avatarId: "avatar-broken-0006", photoId: "photo-broken-0001" }] }]);
});
