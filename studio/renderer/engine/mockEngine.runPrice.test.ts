import { describe, expect, test } from "bun:test";
import type { AvatarSummary, CategorySummary, RunRequest } from "../../shared/engine";
import { LLM_ONLY_CATEGORY_RECORD, LLM_ONLY_REF } from "../../engine/scenes/testing/llmOnlyFixture";
import { DEFAULT_TRAITS } from "../lib/traits";
import { MockEngine, mockDescriptor, mockEngineClient } from "./mockEngine";
import { ManualScheduler } from "./scheduler";

// S5.6R (I5.30): the mock prices a run on the shared writer bound, like the real engine (runEstimate). The code template writes every slot of a built-in
// category and of a covered custom one, so such a run's writer costs $0; only the slots of an uncovered custom category can go to the model, at
// `writerChunksWorst` requests. The estimate, the start's cap and a resume's estimate all read the one figure.

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

const STAMPS = { createdAt: "2026-10-05T10:00:00.000Z", updatedAt: "2026-10-05T10:00:00.000Z" };
const LLM_ONLY: CategorySummary = { ...LLM_ONLY_CATEGORY_RECORD, ...STAMPS };
const COVERED_REF = "cat-covered-fixture" as const;
const COVERED: CategorySummary = {
  categoryId: COVERED_REF,
  name: "Покрытая",
  description: "a category the template writes whole",
  label: "Covered cafes",
  style: "phone",
  pool: {
    locations: ["a quiet bookshop", "a flower stall", "a corner cafe", "a bridge over the river", "a sunny terrace"].map((name) => ({
      name,
      times: ["midday" as const],
      activities: [{ text: "holding a mug", twoHanded: false }, { text: "browsing the shelves", twoHanded: false }],
      mirror: false,
    })),
    outfits: ["a cozy cardigan", "jeans and a tee", "a linen dress"],
    shotDeck: ["friend", "friend", "friend", "friend", "friend"],
  },
  model: "x-ai/grok-4.3",
  spentMicros: 0,
  ...STAMPS,
};

const IMAGE = 50_000;
const ATTEMPTS = 3;
const CHUNK_WORST = 75_000;
const NO_POSES = { profile: false, back: false };

function request(count: number, categories: RunRequest["categories"]): RunRequest {
  return { avatarId: MIA.avatarId, count, categories, poses: NO_POSES };
}

function makeMock() {
  const engine = new MockEngine({ scheduler: new ManualScheduler(), avatars: [MIA], categories: [LLM_ONLY, COVERED] });
  return { engine, client: mockEngineClient(engine) };
}

async function worstOf(client: ReturnType<typeof makeMock>["client"], req: RunRequest): Promise<number> {
  const reply = await client.request("runs.estimate", req);
  if (!reply.ok) throw new Error(`expected ok, got ${reply.error.code}`);
  return reply.result.estimate.worstMicros;
}

describe("the mock's run price reads the writer bound", () => {
  test("a built-in run prices no writer: 20 photos are 60 attempts and nothing else", async () => {
    const { client } = makeMock();
    expect(await worstOf(client, request(20, ["home", "travel", "shoot", "glam", "fit"]))).toBe(20 * ATTEMPTS * IMAGE);
  });

  test("a run of a covered custom category prices no writer", async () => {
    const { client } = makeMock();
    expect(await worstOf(client, request(20, [COVERED_REF]))).toBe(20 * ATTEMPTS * IMAGE);
  });

  test("a run of a category only the model writes keeps the writer's chunks: 20 photos are one chunk", async () => {
    const { client } = makeMock();
    expect(await worstOf(client, request(20, [LLM_ONLY_REF]))).toBe(20 * ATTEMPTS * IMAGE + CHUNK_WORST);
  });

  test("a mixed run (built-in, covered and model-only) prices the writer for the model-only block alone, capped at the plan's chunks", async () => {
    const { client } = makeMock();
    // 75 photos split 25 / 25 / 25: the model-only block touches ⌈25/25⌉ + 1 = 2 chunks, the plan has 3.
    expect(await worstOf(client, request(75, ["home", COVERED_REF, LLM_ONLY_REF]))).toBe(75 * ATTEMPTS * IMAGE + 2 * CHUNK_WORST);
  });

  test("the expected cost carries the writer's typical share for the model's scenes only", async () => {
    const { client } = makeMock();
    const built = await client.request("runs.estimate", request(20, ["home"]));
    const modelOnly = await client.request("runs.estimate", request(20, [LLM_ONLY_REF]));
    if (!built.ok || !modelOnly.ok) throw new Error("expected ok");
    expect(modelOnly.result.estimate.expectedMicros - built.result.estimate.expectedMicros).toBe(20 * 458);
  });

  test("runs.start caps a built-in run at the estimate with no writer in it", async () => {
    const { client } = makeMock();
    const req = request(12, ["home"]);
    const worst = await worstOf(client, req);
    expect(worst).toBe(12 * ATTEMPTS * IMAGE);
    const started = await client.request("runs.start", { ...req, acceptedWorstMicros: worst });
    if (!started.ok) throw new Error(`expected ok, got ${started.error.code}`);
    const listed = await client.request("runs.list", {});
    if (!listed.ok) throw new Error(`expected ok, got ${listed.error.code}`);
    expect(listed.result.runs.find((r) => r.runId === started.result.runId)?.capMicros).toBe(worst);
  });

  test("runs.start refuses a model-only run accepted at the old writer-free price (PRICE_CHANGED)", async () => {
    const { client } = makeMock();
    const req = request(12, [LLM_ONLY_REF]);
    const refused = await client.request("runs.start", { ...req, acceptedWorstMicros: 12 * ATTEMPTS * IMAGE });
    expect(refused).toMatchObject({ ok: false, error: { code: "PRICE_CHANGED" } });
  });
});

describe("a resume prices the writer a run can still need", () => {
  test("a stopped built-in run with its writer unanswered counts no writer in what a resume could spend", async () => {
    const { engine, client } = makeMock();
    const runId = engine.seedRun(request(12, ["home"]), 0, undefined, { writerDone: false });
    const reply = await client.request("runs.estimateResume", { runId });
    if (!reply.ok) throw new Error(`expected ok, got ${reply.error.code}`);
    expect(reply.result.estimate.worstMicros).toBe(12 * ATTEMPTS * IMAGE);
  });

  test("a stopped model-only run with its writer unanswered counts the writer's chunk on top of its open slots", async () => {
    const { engine, client } = makeMock();
    // The cap is lifted by one chunk so the cap does not hide the writer term.
    const runId = engine.seedRun(request(12, [LLM_ONLY_REF]), 0, 12 * ATTEMPTS * IMAGE + CHUNK_WORST, { writerDone: false });
    const reply = await client.request("runs.estimateResume", { runId });
    if (!reply.ok) throw new Error(`expected ok, got ${reply.error.code}`);
    expect(reply.result.estimate.worstMicros).toBe(12 * ATTEMPTS * IMAGE + CHUNK_WORST);
  });
});
