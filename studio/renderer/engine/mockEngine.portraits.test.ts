import { describe, expect, test } from "bun:test";
import { PORTRAIT_CANDIDATES_MAX, type AvatarSummary, type ErrorCode, type EventMessage } from "../../shared/engine";
import { portraitsEstimate } from "../../engine/avatars/plan";
import { PriceBook } from "../../engine/money/prices";
import { MockEngine, mockEngineClient } from "./mockEngine";
import { MIA, NORA, SOFIA } from "./mockEngine.testkit";
import { MOCK_PORTRAIT_AGE_MICROS, MOCK_PORTRAIT_IMAGE_MICROS, MOCK_PORTRAIT_SLOTS, type MockPortraitSeed } from "./mockPortraits";
import { ManualScheduler } from "./scheduler";

// The reference portrait commands in the mock (Stage 5, S5.3c): it answers what the engine answers, refusal for refusal and event for event, so the window can be built and demoed
// without the engine. The parity rig plays the same stories against both (engine/parity/testing/scenarios.avatarPortraits.ts).

const NINI: AvatarSummary = { ...MIA, avatarId: "avatar-nini-0004", name: "Nini", masterPhotoId: "photo-nini-source" };
const AVA: AvatarSummary = { ...MIA, avatarId: "avatar-ava-0005", name: "Ava", masterPhotoId: "photo-ava-portrait" };
const SEEDS: MockPortraitSeed[] = [
  { avatarId: NINI.avatarId, sourcePhotoId: "photo-nini-source" },
  {
    avatarId: AVA.avatarId,
    sourcePhotoId: "photo-ava-source",
    masterLikeness: 0.8,
    candidates: [
      { photoId: "photo-ava-c1", likeness: 0.66 },
      { photoId: "photo-ava-c2", likeness: 0.74 },
    ],
  },
];

function makeMock(options: ConstructorParameters<typeof MockEngine>[0] = {}) {
  const scheduler = new ManualScheduler();
  const engine = new MockEngine({ scheduler, avatars: [NINI, AVA, MIA, SOFIA, NORA], portraits: SEEDS, ...options });
  const client = mockEngineClient(engine);
  const events: EventMessage[] = [];
  client.subscribe((e) => events.push(e));
  return { scheduler, engine, client, events };
}

type Mock = ReturnType<typeof makeMock>;

async function unwrap<T>(reply: Promise<{ ok: true; result: T } | { ok: false; error: { code: string } }>): Promise<T> {
  const r = await reply;
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`);
  return r.result;
}

async function refusal(reply: Promise<{ ok: boolean; error?: { code: ErrorCode; portraitReason?: string } }>) {
  const r = await reply;
  if (r.ok || r.error === undefined) throw new Error("expected a refusal");
  return r.error;
}

const BATCH_OFF = 5 * MOCK_PORTRAIT_IMAGE_MICROS;

function generate(m: Mock, avatarId = NINI.avatarId, acceptedWorstMicros = BATCH_OFF) {
  return m.client.request("avatars.generatePortraits", { avatarId, acceptedWorstMicros });
}

async function spentSoFar(m: Mock): Promise<number> {
  const money = await unwrap(m.client.request("money.status", {}));
  if (money.ledger !== "open") throw new Error("the ledger is not open");
  return money.spentMicros;
}

/** Runs the mock's clock until the batch's job ended. */
async function finish(m: Mock, jobId: string) {
  for (let i = 0; i < 50 && !m.events.some((e) => (e.type === "job.done" || e.type === "job.failed" || e.type === "job.cancelled") && "jobId" in e.payload && e.payload.jobId === jobId); i++) m.scheduler.next();
}

describe("the deterministic outcome table", () => {
  test("is five slots: three that pass at 0.76, 0.72 and 0.61, one 0.48 that is not hers, one the model refuses", () => {
    expect(MOCK_PORTRAIT_SLOTS).toEqual([
      { kind: "pass", likeness: 0.76 },
      { kind: "pass", likeness: 0.72 },
      { kind: "pass", likeness: 0.61 },
      { kind: "unlike", likeness: 0.48 },
      { kind: "refused" },
    ]);
  });
});

describe("avatars.estimatePortraits", () => {
  test("is five images with one reference each at $0.06: worst and expected are $0.30 with the age check off", async () => {
    const m = makeMock();

    expect(await unwrap(m.client.request("avatars.estimatePortraits", {}))).toMatchObject({ expectedMicros: BATCH_OFF, worstMicros: BATCH_OFF });
  });

  test("with the age check on it adds five age checks, at the figures the engine prices at the same models", async () => {
    const m = makeMock({ imageAgeCheck: "on" });
    const engineSays = portraitsEstimate({ book: PriceBook.fallback(), asOf: "2026-10-11" }, { imageModel: "x-ai/grok-imagine-image-quality", textModel: "x-ai/grok-4.3", imageQuality: null }, "on");

    const price = await unwrap(m.client.request("avatars.estimatePortraits", {}));

    expect(price.worstMicros).toBe(engineSays.worstMicros);
    expect(price.expectedMicros).toBe(engineSays.expectedMicros);
    expect(MOCK_PORTRAIT_AGE_MICROS).toEqual({ expected: 1_660, worst: 5_250 });
  });

  test("with the age check off it is the engine's figure at the same models too", async () => {
    const m = makeMock();
    const engineSays = portraitsEstimate({ book: PriceBook.fallback(), asOf: "2026-10-11" }, { imageModel: "x-ai/grok-imagine-image-quality", textModel: "x-ai/grok-4.3", imageQuality: null }, "off");

    expect(await unwrap(m.client.request("avatars.estimatePortraits", {}))).toMatchObject({ expectedMicros: engineSays.expectedMicros, worstMicros: engineSays.worstMicros });
  });

  test("is free", async () => {
    const m = makeMock();
    const before = await spentSoFar(m);

    await unwrap(m.client.request("avatars.estimatePortraits", {}));

    expect(await spentSoFar(m)).toBe(before);
  });
});

describe("avatars.portraits", () => {
  test("an imported avatar whose master is the source: the source, no master likeness, no candidates", async () => {
    const m = makeMock();

    expect(await unwrap(m.client.request("avatars.portraits", { avatarId: NINI.avatarId }))).toEqual({
      avatarId: NINI.avatarId,
      masterPhotoId: "photo-nini-source",
      sourcePhotoId: "photo-nini-source",
      masterLikeness: null,
      candidates: [],
    });
  });

  test("a portrait master reports its likeness; the candidates come best first", async () => {
    const m = makeMock();

    expect(await unwrap(m.client.request("avatars.portraits", { avatarId: AVA.avatarId }))).toEqual({
      avatarId: AVA.avatarId,
      masterPhotoId: "photo-ava-portrait",
      sourcePhotoId: "photo-ava-source",
      masterLikeness: 0.8,
      candidates: [
        { avatarId: AVA.avatarId, photoId: "photo-ava-c2", likeness: 0.74 },
        { avatarId: AVA.avatarId, photoId: "photo-ava-c1", likeness: 0.66 },
      ],
    });
  });

  test("a wizard avatar has no source photo and no candidates", async () => {
    const m = makeMock();

    expect(await unwrap(m.client.request("avatars.portraits", { avatarId: MIA.avatarId }))).toEqual({ avatarId: MIA.avatarId, masterPhotoId: MIA.masterPhotoId, sourcePhotoId: null, masterLikeness: null, candidates: [] });
  });

  test("a draft or an unknown id is NOT_FOUND", async () => {
    const m = makeMock();
    const { draft } = await unwrap(m.client.request("avatars.createDraft", { traits: { age: 25, ethnicity: "european", skinTone: "light", hairColor: "chestnut", hairLength: "long", hairTexture: "wavy", eyeColor: "hazel", build: "slim", marks: [], vibe: "" }, acceptedWorstMicros: 10_000_000 }));

    expect((await refusal(m.client.request("avatars.portraits", { avatarId: draft.avatarId }))).code).toBe("NOT_FOUND");
    expect((await refusal(m.client.request("avatars.portraits", { avatarId: "avatar-nobody" }))).code).toBe("NOT_FOUND");
  });
});

describe("avatars.generatePortraits: the batch", () => {
  test("answers the job id at once; the snapshot lists the running job", async () => {
    const m = makeMock();

    const { jobId } = await unwrap(generate(m));

    const snapshot = await unwrap(m.client.request("engine.snapshot", {}));
    expect(snapshot.jobs).toContainEqual({ kind: "avatar.portraits", jobId, avatarId: NINI.avatarId, status: "running", done: 0, total: 5 });
  });

  test("tells each slot by the table: progress per slot, then job.done with the candidates best first and the slots that gave none", async () => {
    const m = makeMock();
    const before = m.events.length;

    const { jobId } = await unwrap(generate(m));
    await finish(m, jobId);

    const mine = m.events.slice(before).filter((e) => "jobId" in e.payload && e.payload.jobId === jobId);
    expect(mine.map((e) => e.type)).toEqual(["job.progress", "job.progress", "job.progress", "job.progress", "job.progress", "job.done"]);
    expect(mine.filter((e) => e.type === "job.progress").map((e) => e.payload)).toEqual([1, 2, 3, 4, 5].map((done) => ({ kind: "avatar.portraits", jobId, avatarId: NINI.avatarId, done, total: 5 })));
    const done = mine.at(-1);
    if (done?.type !== "job.done" || done.payload.result.kind !== "avatar.portraits") throw new Error("expected a portraits job.done");
    expect(done.payload.result.candidates.map((c) => c.likeness)).toEqual([0.76, 0.72, 0.61]);
    expect(done.payload.result.failedSlots).toEqual([
      { slot: 4, reason: "unlike", likeness: 0.48 },
      { slot: 5, reason: "failed", error: { code: "MODERATION_REFUSED", detail: expect.any(String) }, reserveLeftOpen: false },
    ]);
  });

  test("a portrait is stored BEFORE the progress that counts it: a window that re-reads the list on every progress sees it (B1)", async () => {
    const m = makeMock();
    const reads: number[] = [];
    m.client.subscribe((e) => {
      // Read at the very moment the progress is emitted, not a tick later.
      if (e.type === "job.progress" && e.payload.kind === "avatar.portraits") reads.push(m.engine.peekPortraits(NINI.avatarId)?.candidates.length ?? -1);
    });

    const { jobId } = await unwrap(generate(m));
    await finish(m, jobId);

    // Slots 1 to 3 give a candidate each; slots 4 and 5 add none.
    expect(reads).toEqual([1, 2, 3, 3, 3]);
  });

  test("the candidates join the avatar's pending list, best first, and the master stays the source", async () => {
    const m = makeMock();

    const { jobId } = await unwrap(generate(m));
    await finish(m, jobId);

    const list = await unwrap(m.client.request("avatars.portraits", { avatarId: NINI.avatarId }));
    expect(list.candidates.map((c) => c.likeness)).toEqual([0.76, 0.72, 0.61]);
    expect(list.masterPhotoId).toBe("photo-nini-source");
  });

  test("spends the four paid images and nothing for the model's refusal", async () => {
    const m = makeMock();
    const before = await spentSoFar(m);

    const { jobId } = await unwrap(generate(m));
    await finish(m, jobId);

    expect(await spentSoFar(m)).toBe(before + 4 * MOCK_PORTRAIT_IMAGE_MICROS);
    const money = await unwrap(m.client.request("money.status", {}));
    expect(money.ledger === "open" && money.unsettledCount).toBe(0);
  });

  test("with the age check on, a paid image costs the age check too", async () => {
    const m = makeMock({ imageAgeCheck: "on" });
    const before = await spentSoFar(m);
    const worst = (await unwrap(m.client.request("avatars.estimatePortraits", {}))).worstMicros;

    const { jobId } = await unwrap(generate(m, NINI.avatarId, worst));
    await finish(m, jobId);

    // The three that ranked as hers pay the age check; the one that was not hers and the refusal do not.
    expect(await spentSoFar(m)).toBe(before + 4 * MOCK_PORTRAIT_IMAGE_MICROS + 3 * MOCK_PORTRAIT_AGE_MICROS.expected);
  });

  test("a scripted batch replaces the table once (every slot unlike: done with no candidate)", async () => {
    const m = makeMock();
    m.engine.scriptNextPortraits({ slots: [0.5, 0.4, 0.3, 0.2, 0.1].map((likeness) => ({ kind: "unlike" as const, likeness })) });

    const { jobId } = await unwrap(generate(m));
    await finish(m, jobId);

    const done = m.events.find((e) => e.type === "job.done" && e.payload.jobId === jobId);
    expect(done?.type === "job.done" && done.payload.result.kind === "avatar.portraits" && done.payload.result.candidates).toEqual([]);
    // The table is back for the next batch.
    const again = await unwrap(generate(m));
    await finish(m, again.jobId);
    expect((await unwrap(m.client.request("avatars.portraits", { avatarId: NINI.avatarId }))).candidates).toHaveLength(3);
  });

  test("a batch scripted to be refused answers the refusal for free, before any job", async () => {
    const m = makeMock();
    m.engine.scriptNextPortraits({ refuse: { code: "MASTER_FACE_UNUSABLE" } });
    const before = await spentSoFar(m);

    expect((await refusal(generate(m))).code).toBe("MASTER_FACE_UNUSABLE");

    expect(await spentSoFar(m)).toBe(before);
    expect((await unwrap(m.client.request("engine.snapshot", {}))).jobs).toEqual([]);
  });

  test("a cancel ends the job later, as job.cancelled, and keeps the portraits already made", async () => {
    const m = makeMock();
    const { jobId } = await unwrap(generate(m));
    m.scheduler.next();

    await unwrap(m.client.request("avatars.cancel", { jobId }));
    expect(m.events.some((e) => e.type === "job.cancelled")).toBe(false);
    for (let i = 0; i < 10; i++) m.scheduler.next();

    expect(m.events.find((e) => e.type === "job.cancelled")?.payload).toEqual({ kind: "avatar.portraits", jobId, avatarId: NINI.avatarId });
    expect((await unwrap(m.client.request("avatars.portraits", { avatarId: NINI.avatarId }))).candidates).toHaveLength(1);
  });

  test("a rejected key fails the running job with AUTH_INVALID", async () => {
    const m = makeMock();
    const { jobId } = await unwrap(generate(m));

    m.engine.rejectKey();

    const failed = m.events.find((e) => e.type === "job.failed");
    expect(failed?.payload).toMatchObject({ kind: "avatar.portraits", jobId, avatarId: NINI.avatarId, error: { code: "AUTH_INVALID" } });
  });
});

describe("avatars.generatePortraits: refused before anything is spent", () => {
  async function refusedFree(m: Mock, avatarId: string, code: ErrorCode, accepted = BATCH_OFF) {
    const before = await spentSoFar(m);
    const error = await refusal(generate(m, avatarId, accepted));
    expect(error.code).toBe(code);
    expect(await spentSoFar(m)).toBe(before);
    expect((await unwrap(m.client.request("engine.snapshot", {}))).jobs).toEqual([]);
    return error;
  }

  test("a second batch for the avatar while one runs: IN_FLIGHT", async () => {
    const m = makeMock();
    const { jobId } = await unwrap(generate(m));

    expect((await refusal(generate(m))).code).toBe("IN_FLIGHT");

    await finish(m, jobId);
  });

  test("the claim comes first: a held avatar meets IN_FLIGHT even without a key", async () => {
    const m = makeMock({ apiKey: { stored: false, last4: null, encryptionAvailable: true, rejected: false } });
    m.engine.setAvatarEditing(NINI.avatarId, true);

    expect((await refusal(generate(m))).code).toBe("IN_FLIGHT");
  });

  test("without a key: AUTH_INVALID", async () => {
    const m = makeMock({ apiKey: { stored: false, last4: null, encryptionAvailable: true, rejected: false } });

    await refusedFree(m, NINI.avatarId, "AUTH_INVALID");
  });

  test("an unknown id and an archived avatar: NOT_FOUND", async () => {
    const m = makeMock();

    await refusedFree(m, "avatar-nobody", "NOT_FOUND");
    await refusedFree(m, NORA.avatarId, "NOT_FOUND");
  });

  test("a draft: NOT_FOUND", async () => {
    const m = makeMock();
    const { draft } = await unwrap(m.client.request("avatars.createDraft", { traits: { age: 25, ethnicity: "european", skinTone: "light", hairColor: "chestnut", hairLength: "long", hairTexture: "wavy", eyeColor: "hazel", build: "slim", marks: [], vibe: "" }, acceptedWorstMicros: 10_000_000 }));

    await refusedFree(m, draft.avatarId, "NOT_FOUND");
  });

  test("a wizard avatar: VALIDATION not-imported", async () => {
    const m = makeMock();

    expect((await refusedFree(m, MIA.avatarId, "VALIDATION")).portraitReason).toBe("not-imported");
  });

  test("ten pending portraits leave room for a batch of five; eleven do not (15 is the limit)", async () => {
    const pending = (n: number) => Array.from({ length: n }, (_, i) => ({ photoId: `photo-p${n}-${i}`, likeness: 0.7 }));
    const ten: AvatarSummary = { ...MIA, avatarId: "avatar-ten", name: "Ten", masterPhotoId: "photo-ten-source" };
    const eleven: AvatarSummary = { ...MIA, avatarId: "avatar-eleven", name: "Eleven", masterPhotoId: "photo-eleven-source" };
    const m = makeMock({
      avatars: [ten, eleven],
      portraits: [
        { avatarId: ten.avatarId, sourcePhotoId: "photo-ten-source", candidates: pending(10) },
        { avatarId: eleven.avatarId, sourcePhotoId: "photo-eleven-source", candidates: pending(11) },
      ],
    });

    expect(PORTRAIT_CANDIDATES_MAX).toBe(15);
    expect((await refusedFree(m, eleven.avatarId, "VALIDATION")).portraitReason).toBe("too-many-candidates");
    const { jobId } = await unwrap(generate(m, ten.avatarId));
    await finish(m, jobId);
  });

  test("a worst case below the price: PRICE_CHANGED; exactly the price starts the batch", async () => {
    const m = makeMock();

    await refusedFree(m, NINI.avatarId, "PRICE_CHANGED", BATCH_OFF - 1);
    const { jobId } = await unwrap(generate(m, NINI.avatarId, BATCH_OFF));
    await finish(m, jobId);
  });

  test("a month without room for the batch: BUDGET_EXCEEDED", async () => {
    const m = makeMock({ money: { monthlyBudgetMicros: BATCH_OFF - 1 } });

    await refusedFree(m, NINI.avatarId, "BUDGET_EXCEEDED");
  });

  test("a held avatar also holds the other jobs off: a descriptor check meets IN_FLIGHT while the batch runs", async () => {
    const m = makeMock();
    const { jobId } = await unwrap(generate(m));

    expect((await refusal(m.client.request("avatars.checkDescriptor", { avatarId: NINI.avatarId, acceptedWorstMicros: 1_000_000 }))).code).toBe("IN_FLIGHT");

    await finish(m, jobId);
  });
});

describe("avatars.pickPortrait", () => {
  test("a candidate becomes the master; avatar.changed carries it; the other portraits go and the source stays", async () => {
    const m = makeMock();
    const before = m.events.length;

    const { avatar } = await unwrap(m.client.request("avatars.pickPortrait", { avatarId: AVA.avatarId, photoId: "photo-ava-c1" }));

    expect(avatar.masterPhotoId).toBe("photo-ava-c1");
    expect(m.events.slice(before).filter((e) => e.type === "avatar.changed").map((e) => e.type === "avatar.changed" && e.payload.avatar.masterPhotoId)).toEqual(["photo-ava-c1"]);
    expect(await unwrap(m.client.request("avatars.portraits", { avatarId: AVA.avatarId }))).toEqual({
      avatarId: AVA.avatarId,
      masterPhotoId: "photo-ava-c1",
      sourcePhotoId: "photo-ava-source",
      masterLikeness: 0.66,
      candidates: [],
    });
    expect((await unwrap(m.client.request("avatars.list", {}))).avatars.find((a) => a.avatarId === AVA.avatarId)?.masterPhotoId).toBe("photo-ava-c1");
  });

  test("the source photo can be made the master again", async () => {
    const m = makeMock();

    await unwrap(m.client.request("avatars.pickPortrait", { avatarId: AVA.avatarId, photoId: "photo-ava-source" }));

    expect(await unwrap(m.client.request("avatars.portraits", { avatarId: AVA.avatarId }))).toMatchObject({ masterPhotoId: "photo-ava-source", masterLikeness: null, candidates: [] });
  });

  test("the current master is answered as it is: no event, nothing removed", async () => {
    const m = makeMock();
    const before = m.events.length;

    const { avatar } = await unwrap(m.client.request("avatars.pickPortrait", { avatarId: AVA.avatarId, photoId: "photo-ava-portrait" }));

    expect(avatar.masterPhotoId).toBe("photo-ava-portrait");
    expect(m.events.slice(before).filter((e) => e.type === "avatar.changed")).toEqual([]);
    expect((await unwrap(m.client.request("avatars.portraits", { avatarId: AVA.avatarId }))).candidates).toHaveLength(2);
  });

  test("any other photo is VALIDATION not-a-candidate and changes nothing", async () => {
    const m = makeMock();

    const error = await refusal(m.client.request("avatars.pickPortrait", { avatarId: AVA.avatarId, photoId: "photo-sofia-master" }));

    expect(error).toMatchObject({ code: "VALIDATION", portraitReason: "not-a-candidate" });
    expect((await unwrap(m.client.request("avatars.portraits", { avatarId: AVA.avatarId }))).candidates).toHaveLength(2);
  });

  test("a wizard avatar: VALIDATION not-imported", async () => {
    const m = makeMock();

    expect(await refusal(m.client.request("avatars.pickPortrait", { avatarId: MIA.avatarId, photoId: MIA.masterPhotoId }))).toMatchObject({ code: "VALIDATION", portraitReason: "not-imported" });
  });

  test("an archived avatar and an unknown id are NOT_FOUND, never not-a-candidate", async () => {
    const m = makeMock();

    expect((await refusal(m.client.request("avatars.pickPortrait", { avatarId: NORA.avatarId, photoId: "photo-nobody-0001" }))).code).toBe("NOT_FOUND");
    expect((await refusal(m.client.request("avatars.pickPortrait", { avatarId: "avatar-nobody", photoId: "photo-nobody-0001" }))).code).toBe("NOT_FOUND");
  });

  test("is refused IN_FLIGHT while the batch runs", async () => {
    const m = makeMock();
    const { jobId } = await unwrap(generate(m, AVA.avatarId));

    expect((await refusal(m.client.request("avatars.pickPortrait", { avatarId: AVA.avatarId, photoId: "photo-ava-c1" }))).code).toBe("IN_FLIGHT");

    await finish(m, jobId);
  });

  test("is free", async () => {
    const m = makeMock();
    const before = await spentSoFar(m);

    await unwrap(m.client.request("avatars.pickPortrait", { avatarId: AVA.avatarId, photoId: "photo-ava-c1" }));

    expect(await spentSoFar(m)).toBe(before);
  });
});

describe("avatars.discardPortraits", () => {
  test("removes every pending portrait and says how many; the master and the source stay", async () => {
    const m = makeMock();

    expect(await unwrap(m.client.request("avatars.discardPortraits", { avatarId: AVA.avatarId }))).toEqual({ avatarId: AVA.avatarId, removed: 2 });

    expect(await unwrap(m.client.request("avatars.portraits", { avatarId: AVA.avatarId }))).toMatchObject({ masterPhotoId: "photo-ava-portrait", sourcePhotoId: "photo-ava-source", candidates: [] });
  });

  test("with nothing pending it removes none", async () => {
    const m = makeMock();

    expect(await unwrap(m.client.request("avatars.discardPortraits", { avatarId: NINI.avatarId }))).toEqual({ avatarId: NINI.avatarId, removed: 0 });
  });

  test("an archived avatar and an unknown id are NOT_FOUND; a held avatar is IN_FLIGHT", async () => {
    const m = makeMock();

    expect((await refusal(m.client.request("avatars.discardPortraits", { avatarId: NORA.avatarId }))).code).toBe("NOT_FOUND");
    expect((await refusal(m.client.request("avatars.discardPortraits", { avatarId: "avatar-nobody" }))).code).toBe("NOT_FOUND");
    m.engine.setAvatarEditing(AVA.avatarId, true);
    expect((await refusal(m.client.request("avatars.discardPortraits", { avatarId: AVA.avatarId }))).code).toBe("IN_FLIGHT");
  });
});

describe("an imported avatar of the mock", () => {
  test("is a source avatar: after avatars.importAvatar its imported photo is the master and the source", async () => {
    const m = makeMock({ avatars: [] , portraits: [] });
    const staged = await unwrap(m.client.request("avatars.pickImportPhoto", {}));
    if (!staged.picked) throw new Error("expected a photo");
    const price = await unwrap(m.client.request("avatars.estimateImport", { stagingId: staged.stagingId }));

    const { avatar } = await unwrap(m.client.request("avatars.importAvatar", { stagingId: staged.stagingId, name: "Nini", acceptedWorstMicros: price.worstMicros }));

    expect(await unwrap(m.client.request("avatars.portraits", { avatarId: avatar.avatarId }))).toEqual({
      avatarId: avatar.avatarId,
      masterPhotoId: avatar.masterPhotoId,
      sourcePhotoId: avatar.masterPhotoId,
      masterLikeness: null,
      candidates: [],
    });
  });
});

describe("demoPortraits", () => {
  test("the demo preset has an imported Nini, and Ava with a portrait master, its source and three pending candidates", async () => {
    const scheduler = new ManualScheduler();
    const client = mockEngineClient(new MockEngine({ scheduler, preset: "demo", demoPortraits: true }));
    const { avatars } = await unwrap(client.request("avatars.list", {}));
    const nini = avatars.find((a) => a.name === "Nini");
    const ava = avatars.find((a) => a.name === "Ava");
    if (nini === undefined || ava === undefined) throw new Error("the demo has no Nini or no Ava");

    const niniList = await unwrap(client.request("avatars.portraits", { avatarId: nini.avatarId }));
    const avaList = await unwrap(client.request("avatars.portraits", { avatarId: ava.avatarId }));

    expect(niniList).toMatchObject({ masterPhotoId: niniList.sourcePhotoId, masterLikeness: null, candidates: [] });
    expect(avaList.sourcePhotoId).not.toBeNull();
    expect(avaList.masterPhotoId).not.toBe(avaList.sourcePhotoId);
    expect(avaList.masterLikeness).not.toBeNull();
    expect(avaList.candidates).toHaveLength(3);
  });

  test("without the option the demo is exactly what it was: no Nini, and no avatar has a source", async () => {
    const client = mockEngineClient(new MockEngine({ scheduler: new ManualScheduler(), preset: "demo" }));
    const { avatars } = await unwrap(client.request("avatars.list", {}));

    expect(avatars.some((a) => a.name === "Nini")).toBe(false);
    for (const a of avatars) expect((await unwrap(client.request("avatars.portraits", { avatarId: a.avatarId }))).sourcePhotoId).toBeNull();
  });
});
