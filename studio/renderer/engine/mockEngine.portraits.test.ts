import { describe, expect, test } from "bun:test";
import { type AvatarSummary, type ErrorCode, type EventMessage } from "../../shared/engine";
import { MockEngine, mockEngineClient } from "./mockEngine";
import { MIA, NORA, SOFIA } from "./mockEngine.testkit";
import { MOCK_PORTRAIT_IMAGE_MICROS, type MockPortraitSeed } from "./mockPortraits";
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

describe("avatars.estimatePortraits", () => {
  test("is five images with one reference each at $0.06: worst and expected are $0.30 with the age check off", async () => {
    const m = makeMock();

    expect(await unwrap(m.client.request("avatars.estimatePortraits", {}))).toMatchObject({ expectedMicros: BATCH_OFF, worstMicros: BATCH_OFF });
  });

});

describe("avatars.generatePortraits: the batch", () => {

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
      { slot: 5, reason: "failed", error: { code: "MODERATION_REFUSED", detail: expect.any(String) }, reserveLeftOpen: false, charge: "free" },
    ]);
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

});

