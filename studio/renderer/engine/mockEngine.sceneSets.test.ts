import { describe, expect, test } from "bun:test";
import type { AvatarSummary, EventMessage, SceneSetView } from "../../shared/engine";
import { LLM_ONLY_CATEGORY_RECORD, LLM_ONLY_REF } from "../../engine/scenes/testing/llmOnlyFixture";
import { DEFAULT_TRAITS } from "../lib/traits";
import { MockEngine, mockDescriptor, mockEngineClient } from "./mockEngine";
import { ManualScheduler } from "./scheduler";

// 5a.2 (S5.6e, m11): a built-in category is written by the code template with no writer request, so these tests of the writer (its attempts, its chunks, its money) plan from `cat-llm-only-fixture`, the
// category whose activities the template cannot write. The built-in side of the same money is in mockEngine.templateScenes.test.ts.
// CS.4a: the mock's scene sets, driven through the same validating client the renderer uses, so an answer that drifts from the contract (or from the
// engine's order of checks, which the parity suite pins for the free commands) fails here first. What the engine pins with a real ledger, the mock keeps
// with its own: attempts answered and ids used per chunk, an open reserve counted as answered, never a fresh pair after an interruption.

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

/** One writer attempt at its ceilings at the fallback prices: two for a chunk. */
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

const accepted = (count: number) => Math.ceil(count / 25) * 2 * ATTEMPT;

const compose = (m: Mock, count = 20, over: Record<string, unknown> = {}) =>
  m.client.request("scenes.compose", { avatarId: MIA.avatarId, count, categories: [LLM_ONLY_REF], poses: POSES, acceptedWorstMicros: accepted(count), ...over } as never);

async function composed(m: Mock, count = 20): Promise<{ sceneSetId: string; jobId: string | null }> {
  return unwrap(compose(m, count));
}

async function setOf(m: Mock): Promise<SceneSetView> {
  const { sceneSet } = await unwrap(m.client.request("scenes.get", { avatarId: MIA.avatarId }));
  if (sceneSet === null) throw new Error("no set");
  return sceneSet;
}


const write = (m: Mock, sceneSetId: string, revision: number, acceptedWorstMicros: number) => m.client.request("scenes.write", { sceneSetId, revision, target: { kind: "unwritten" }, acceptedWorstMicros });

describe("scenes.estimateCompose", () => {
  test("is the writer's worst case for the scenes, as the engine's at the fallback prices: chunks of 25, two attempts each", async () => {
    const m = makeMock();
    const worst = async (count: number) => (await unwrap(m.client.request("scenes.estimateCompose", { avatarId: MIA.avatarId, count, categories: [LLM_ONLY_REF], poses: POSES }))).estimate.worstMicros;
    expect(await worst(20)).toBe(2 * ATTEMPT);
    expect(await worst(26)).toBe(4 * ATTEMPT);
    expect(await worst(100)).toBe(8 * ATTEMPT);
  });

});

describe("scenes.compose", () => {
  test("writes the set at once and its sentences chunk by chunk as the clock moves; the last scenes.changed comes before job.done", async () => {
    const m = makeMock();
    const { sceneSetId, jobId } = await composed(m, 30);
    expect(await setOf(m)).toMatchObject({ sceneSetId, status: "writing", write: { kind: "compose", count: 30 } });
    expect((await setOf(m)).scenes.every((s) => s.text === null)).toBe(true);

    m.scheduler.runAll();

    const view = await setOf(m);
    expect(view).toMatchObject({ status: "ready", stoppedBy: null, write: null });
    expect(view.scenes.every((s) => s.text !== null && s.unwritten === null)).toBe(true);
    const done = m.events.findIndex((e) => e.type === "job.done");
    expect(m.events[done]).toMatchObject({ payload: { jobId, result: { kind: "scenes", sceneSetId, written: 30, unwritten: 0 } } });
    expect(m.events.findLastIndex((e) => e.type === "scenes.changed")).toBeLessThan(done);
  });

  test("PRICE_CHANGED above the accepted worst case and BUDGET_EXCEEDED past the month: nothing is made", async () => {
    const m = makeMock({ money: { monthlyBudgetMicros: 2 * ATTEMPT - 1 } });
    expect(await codeOf(compose(m, 20, { acceptedWorstMicros: 1 }))).toBe("PRICE_CHANGED");
    expect(await codeOf(compose(m, 20))).toBe("BUDGET_EXCEEDED");
    expect(await unwrap(m.client.request("scenes.get", { avatarId: MIA.avatarId }))).toEqual({ sceneSet: null, unreadable: 0 });
  });

});

describe("a write that stops, and what stays", () => {

  test("a dropped connection leaves a reserve open at its worst case: one attempt left, and paid calls wait for the reconcile", async () => {
    const m = makeMock();
    m.engine.failNextSceneAttempt("network");
    await composed(m, 5);
    m.scheduler.runAll();

    const view = await setOf(m);
    expect(view).toMatchObject({ status: "stopped", stoppedBy: "network", spentMicros: ATTEMPT, openReserveMicros: ATTEMPT });
    expect(view.chunks[0]?.attemptsLeft).toBe(1);
    expect(await codeOf(write(m, view.sceneSetId, view.revision, ATTEMPT))).toBe("RECONCILE_REQUIRED");
  });

  // 5a.2 (S5.6d, plan s5a2 I5.31): this test used to say «a chunk rejected twice is given up (written 5, unwritten 25)». A planned scene the model could not write takes
  // the plain sentence, so the whole set is written and nothing is given up.

  // The model's answer can be wrong for one scene of a chunk and right for the rest (the engine's reader marks the slot): the accepted scenes are kept and the second attempt asks for the one left.

  // Round-1 review of S5.6d (I5.31): final for the request (one attempt, free), never for the scenes: they take the plain sentence at once.

});

