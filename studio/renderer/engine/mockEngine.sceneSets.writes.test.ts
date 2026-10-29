import { describe, expect, test } from "bun:test";
import type { AvatarSummary, EventMessage, SceneSetView } from "../../shared/engine";
import { LLM_ONLY_CATEGORY_RECORD, LLM_ONLY_REF } from "../../engine/scenes/testing/llmOnlyFixture";
import { DEFAULT_TRAITS } from "../lib/traits";
import { MockEngine, mockDescriptor, mockEngineClient } from "./mockEngine";
import { ManualScheduler } from "./scheduler";

// 5a.2 (S5.6e, m11): a built-in scene is written by the code template, at once and for nothing, so these tests of the model's write (its attempt, its ids, its money, its markers) plan their set from
// `cat-llm-only-fixture`, whose scenes only the model writes. The built-in side («Другая сцена» at $0) is in mockEngine.templateScenes.test.ts.
// CS.4b: the mock's review-time writes, driven through the same validating client the renderer uses. The mock keeps what the engine pins with a real
// ledger: a write is ONE request under ids of its own (`${set}:write-${k}#n`), recorded with its draw before the call; a scene changes only when its
// sentence is accepted; answered attempts per write are at most two across all jobs (an open reserve counts as answered); a marker belongs to its scene and
// survives other writes; and the refusals come in the engine's order.

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

/** One writer attempt at its ceilings at the fallback prices. */
const ATTEMPT = 37_500;
const POSES = { profile: false, back: false };
const FIXTURE = { ...LLM_ONLY_CATEGORY_RECORD, createdAt: "2026-10-05T10:00:00.000Z", updatedAt: "2026-10-05T10:00:00.000Z" };

function makeMock(options: ConstructorParameters<typeof MockEngine>[0] = {}) {
  const scheduler = new ManualScheduler();
  const engine = new MockEngine({ scheduler, avatars: [MIA], categories: [FIXTURE], ...options });
  const client = mockEngineClient(engine);
  const events: EventMessage[] = [];
  client.subscribe((e) => events.push(e));
  return { scheduler, engine, client, events };
}
type Mock = ReturnType<typeof makeMock>;
type Reply<T> = Promise<{ ok: true; result: T } | { ok: false; error: { code: string } }>;

async function unwrap<T>(reply: Reply<T>): Promise<T> {
  const r = await reply;
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`);
  return r.result;
}
async function codeOf<T>(reply: Reply<T>): Promise<string> {
  const r = await reply;
  if (r.ok) throw new Error("expected an error");
  return r.error.code;
}

type Target = { kind: "rewrite"; sceneIds: number[]; redraw: boolean } | { kind: "idea"; idea: string; count: number; shot: string | null } | { kind: "resume"; write: number };
const rewrite = (sceneIds: number[], redraw = false): Target => ({ kind: "rewrite", sceneIds, redraw });
const idea = (text: string, count = 1, shot: string | null = null): Target => ({ kind: "idea", idea: text, count, shot });

/** A ready set of `count` written scenes, composed and finished. */
async function readySet(m: Mock, count = 4, categories: string[] = [LLM_ONLY_REF]): Promise<SceneSetView> {
  await unwrap(m.client.request("scenes.compose", { avatarId: MIA.avatarId, count, categories, poses: POSES, acceptedWorstMicros: Math.ceil(count / 25) * 2 * ATTEMPT } as never));
  m.scheduler.runAll();
  return setOf(m);
}
async function setOf(m: Mock): Promise<SceneSetView> {
  const { sceneSet } = await unwrap(m.client.request("scenes.get", { avatarId: MIA.avatarId }));
  if (sceneSet === null) throw new Error("no set");
  return sceneSet;
}
const write = (m: Mock, view: SceneSetView, target: Target, accepted = 2 * ATTEMPT) => m.client.request("scenes.write", { sceneSetId: view.sceneSetId, revision: view.revision, target, acceptedWorstMicros: accepted } as never);
const estimate = async (m: Mock, view: SceneSetView, target: Target) => (await unwrap(m.client.request("scenes.estimateWrite", { sceneSetId: view.sceneSetId, target } as never))).estimate;

/** Starts a write, lets its job run to its end, and answers the set. */
async function writeAndRun(m: Mock, view: SceneSetView, target: Target, accepted = 2 * ATTEMPT): Promise<SceneSetView> {
  await unwrap(write(m, view, target, accepted));
  m.scheduler.runAll();
  return setOf(m);
}

describe("scenes.estimateWrite: rewrite, idea and resume", () => {
  test("a rewrite and an idea write are two attempts at the ceiling, whatever the count; a resume is priced by the attempts its write has left", async () => {
    const m = makeMock();
    const view = await readySet(m);
    expect((await estimate(m, view, rewrite([2], true))).worstMicros).toBe(2 * ATTEMPT);
    expect((await estimate(m, view, rewrite([1, 2, 3, 4]))).worstMicros).toBe(2 * ATTEMPT);
    expect((await estimate(m, view, idea("кофе", 5))).worstMicros).toBe(2 * ATTEMPT);
    m.engine.failNextSceneAttempt("rate-limited");
    const after = await writeAndRun(m, view, rewrite([2]));
    expect((await estimate(m, after, { kind: "resume", write: 2 })).worstMicros).toBe(2 * ATTEMPT);
  });

});

describe("scenes.write: a rewrite", () => {

  test("books what the write cost: one request, at the writer's typical tokens", async () => {
    const m = makeMock();
    const view = await readySet(m);
    const spent = view.spentMicros ?? 0;
    const after = await writeAndRun(m, view, rewrite([2]));
    expect((after.spentMicros ?? 0) - spent).toBeGreaterThan(300);
    expect((after.spentMicros ?? 0) - spent).toBeLessThan(2_500);
  });

  // 5a.2 (S5.6d): this test used to say «a write that fails leaves the scene exactly as it was: two rejected answers». A planned rewrite the model rejects twice takes the
  // plain sentence of the place it drew, as the engine's does, and the write is done; an idea write (below) still leaves no trace.

  // Round-1 review of S5.6d: the provider's refusal ends no planned scene: a planned rewrite takes the plain sentence at once (one attempt, free). An idea has no place
  // to build one from, so its refusal is final and leaves the set as it was.

  test("a write that fails leaves the set exactly as it was: the provider refuses an idea, one attempt, no marker, nothing to resume", async () => {
    const m = makeMock();
    const view = await readySet(m);
    m.engine.failNextSceneAttempt("refused");
    await unwrap(write(m, view, idea("кофе", 1)));
    m.scheduler.runAll();

    expect(m.events.find((e) => e.type === "job.failed")).toMatchObject({ payload: { error: { code: "MODERATION_REFUSED" } } });
    const after = await setOf(m);
    expect(after.scenes).toEqual(view.scenes);
    expect(after.scenes.some((s) => s.rewriteInterrupted !== undefined)).toBe(false);
  });
});

describe("the money and the order of refusals of a review write", () => {
  test("PRICE_CHANGED above what was accepted, BUDGET_EXCEEDED past the month, AUTH_INVALID without a key: nothing is made", async () => {
    const m = makeMock();
    const view = await readySet(m);
    expect(await codeOf(write(m, view, rewrite([2]), 2 * ATTEMPT - 1))).toBe("PRICE_CHANGED");
    expect(await codeOf(write(m, view, idea("кофе"), 2 * ATTEMPT - 1))).toBe("PRICE_CHANGED");
    expect((await setOf(m)).revision).toBe(view.revision);
  });

});

