import { describe, expect, test } from "bun:test";
import type { AvatarSummary, EventMessage, SceneSetView } from "../../shared/engine";
import { DEFAULT_TRAITS } from "../lib/traits";
import { MockEngine, mockDescriptor, mockEngineClient } from "./mockEngine";
import { ManualScheduler } from "./scheduler";

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

function makeMock(options: ConstructorParameters<typeof MockEngine>[0] = {}) {
  const scheduler = new ManualScheduler();
  const engine = new MockEngine({ scheduler, avatars: [MIA], ...options });
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
  m.client.request("scenes.compose", { avatarId: MIA.avatarId, count, categories: ["home"], poses: POSES, acceptedWorstMicros: accepted(count), ...over } as never);

async function composed(m: Mock, count = 20): Promise<{ sceneSetId: string; jobId: string | null }> {
  return unwrap(compose(m, count));
}

async function setOf(m: Mock): Promise<SceneSetView> {
  const { sceneSet } = await unwrap(m.client.request("scenes.get", { avatarId: MIA.avatarId }));
  if (sceneSet === null) throw new Error("no set");
  return sceneSet;
}

const edit = (m: Mock, sceneSetId: string, revision: number, op: unknown) => m.client.request("scenes.edit", { sceneSetId, revision, op } as never);
const write = (m: Mock, sceneSetId: string, revision: number, acceptedWorstMicros: number) => m.client.request("scenes.write", { sceneSetId, revision, target: { kind: "unwritten" }, acceptedWorstMicros });
const changes = (events: EventMessage[]) => events.flatMap((e) => (e.type === "scenes.changed" && e.payload.change === "upserted" ? [e.payload.sceneSet] : []));

describe("scenes.estimateCompose", () => {
  test("is the writer's worst case for the scenes, as the engine's at the fallback prices: chunks of 25, two attempts each", async () => {
    const m = makeMock();
    const worst = async (count: number) => (await unwrap(m.client.request("scenes.estimateCompose", { avatarId: MIA.avatarId, count, categories: ["home"], poses: POSES }))).estimate.worstMicros;
    expect(await worst(20)).toBe(2 * ATTEMPT);
    expect(await worst(26)).toBe(4 * ATTEMPT);
    expect(await worst(100)).toBe(8 * ATTEMPT);
  });

  test("expects the writer's typical tokens: about $0.009 for 20 scenes, and an empty set is free", async () => {
    const m = makeMock();
    const estimate = async (count: number) => (await unwrap(m.client.request("scenes.estimateCompose", { avatarId: MIA.avatarId, count, categories: count === 0 ? [] : ["home"], poses: POSES }))).estimate;
    expect((await estimate(20)).expectedMicros).toBe(9_150);
    expect(await estimate(0)).toMatchObject({ expectedMicros: 0, worstMicros: 0 });
  });

  test("NOT_FOUND for an avatar that cannot get photos, or a custom category the library lacks", async () => {
    const m = makeMock();
    expect(await codeOf(m.client.request("scenes.estimateCompose", { avatarId: "avatar-nobody-404", count: 5, categories: ["home"], poses: POSES }))).toBe("NOT_FOUND");
    expect(await codeOf(m.client.request("scenes.estimateCompose", { avatarId: MIA.avatarId, count: 5, categories: ["cat-no-such-category"], poses: POSES }))).toBe("NOT_FOUND");
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

  test("the job counts scenes: its progress ends at the total, and its state is in the snapshot", async () => {
    const m = makeMock();
    const { jobId } = await composed(m, 30);
    m.scheduler.runAll();

    const progress = m.events.flatMap((e) => (e.type === "job.progress" && e.payload.kind === "scenes" ? [[e.payload.done, e.payload.total]] : []));
    expect(progress.at(0)).toEqual([0, 30]);
    expect(progress.at(-1)).toEqual([30, 30]);
    const snapshot = await unwrap(m.client.request("engine.snapshot", {}));
    expect(snapshot.jobs.find((j) => j.kind === "scenes")).toMatchObject({ jobId, status: "done", done: 30, total: 30 });
  });

  test("books what the writer cost, and the view says so", async () => {
    const m = makeMock();
    await composed(m, 20);
    m.scheduler.runAll();
    const view = await setOf(m);
    expect(view.spentMicros).toBeGreaterThan(0);
    expect(view.spentMicros).toBeLessThan(2 * ATTEMPT);
    expect(view.openReserveMicros).toBe(0);
  });

  test("an empty set is free: no job, no money, and the set is announced", async () => {
    const m = makeMock();
    const { sceneSetId, jobId } = await unwrap(m.client.request("scenes.compose", { avatarId: MIA.avatarId, count: 0, categories: [], poses: POSES, acceptedWorstMicros: 0 }));
    expect(jobId).toBeNull();
    expect(await setOf(m)).toMatchObject({ sceneSetId, status: "ready", scenes: [], spentMicros: 0 });
    expect(changes(m.events).map((s) => s.sceneSetId)).toEqual([sceneSetId]);
  });

  test("PRICE_CHANGED above the accepted worst case and BUDGET_EXCEEDED past the month: nothing is made", async () => {
    const m = makeMock({ money: { monthlyBudgetMicros: 2 * ATTEMPT - 1 } });
    expect(await codeOf(compose(m, 20, { acceptedWorstMicros: 1 }))).toBe("PRICE_CHANGED");
    expect(await codeOf(compose(m, 20))).toBe("BUDGET_EXCEEDED");
    expect(await unwrap(m.client.request("scenes.get", { avatarId: MIA.avatarId }))).toEqual({ sceneSet: null, unreadable: 0 });
  });

  test("AUTH_INVALID without a key; NOT_FOUND for an unknown avatar", async () => {
    const m = makeMock({ apiKey: { stored: false, last4: null, encryptionAvailable: true, rejected: false } });
    expect(await codeOf(compose(m))).toBe("AUTH_INVALID");
    const n = makeMock();
    expect(await codeOf(n.client.request("scenes.compose", { avatarId: "avatar-nobody-404", count: 5, categories: ["home"], poses: POSES, acceptedWorstMicros: accepted(5) }))).toBe("NOT_FOUND");
  });

  test("one open set per avatar: a second compose is VALIDATION until the first is discarded", async () => {
    const m = makeMock();
    const first = await composed(m, 5);
    m.scheduler.runAll();
    expect(await codeOf(compose(m, 5))).toBe("VALIDATION");
    await unwrap(m.client.request("scenes.discard", { sceneSetId: first.sceneSetId }));
    expect((await composed(m, 5)).sceneSetId).not.toBe(first.sceneSetId);
  });

  test("is refused while the avatar's scenes job runs, and so is a photo run: IN_FLIGHT", async () => {
    const m = makeMock();
    await composed(m, 5);
    expect(await codeOf(compose(m, 5))).toBe("IN_FLIGHT");
    expect(await codeOf(m.client.request("runs.start", { avatarId: MIA.avatarId, count: 4, categories: ["home"], poses: POSES, acceptedWorstMicros: 10_000_000 }))).toBe("IN_FLIGHT");
    m.scheduler.runAll();
  });

  test("money.reconcile waits while a scenes job runs", async () => {
    const m = makeMock();
    await composed(m, 5);
    expect(await codeOf(m.client.request("money.reconcile", {}))).toBe("IN_FLIGHT");
    m.scheduler.runAll();
  });

  test("the avatar is not deleted while its scenes job runs, and its sets go with it", async () => {
    const m = makeMock();
    await composed(m, 5);
    expect(await codeOf(m.client.request("avatars.delete", { avatarId: MIA.avatarId }))).toBe("IN_FLIGHT");
    m.scheduler.runAll();
    await unwrap(m.client.request("avatars.delete", { avatarId: MIA.avatarId }));
    expect(await codeOf(m.client.request("scenes.get", { avatarId: MIA.avatarId }))).toBe("NOT_FOUND");
  });
});

describe("a write that stops, and what stays", () => {
  test("a free failure (429) stops the job with both attempts kept: failed after scenes.changed, stopped by the rate limit", async () => {
    const m = makeMock();
    m.engine.failNextSceneAttempt("rate-limited");
    const { jobId } = await composed(m, 5);
    m.scheduler.runAll();

    expect(m.events.find((e) => e.type === "job.failed")).toMatchObject({ payload: { kind: "scenes", jobId, error: { code: "RATE_LIMITED" } } });
    expect(m.events.findLastIndex((e) => e.type === "scenes.changed")).toBeLessThan(m.events.findIndex((e) => e.type === "job.failed"));
    const view = await setOf(m);
    expect(view).toMatchObject({ status: "stopped", stoppedBy: "rate-limited", spentMicros: 0 });
    expect(view.chunks[0]?.attemptsLeft).toBe(2);
  });

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

  test("after the reconcile closed it at the worst case, «Дописать» gets ONE attempt, never a fresh pair", async () => {
    const m = makeMock();
    m.engine.failNextSceneAttempt("network");
    await composed(m, 5);
    m.scheduler.runAll();
    await unwrap(m.client.request("money.reconcile", {}));
    const view = await setOf(m);
    expect(view).toMatchObject({ openReserveMicros: 0, spentMicros: ATTEMPT });
    expect(view.chunks[0]?.attemptsLeft).toBe(1);
    expect((await unwrap(m.client.request("scenes.estimateWrite", { sceneSetId: view.sceneSetId, target: { kind: "unwritten" } }))).estimate.worstMicros).toBe(ATTEMPT);

    m.engine.failNextSceneAttempt("rejected");
    await unwrap(write(m, view.sceneSetId, view.revision, ATTEMPT));
    m.scheduler.runAll();

    const after = await setOf(m);
    expect(after.status).toBe("ready");
    expect(after.scenes.every((s) => s.unwritten === "gave-up" && s.gaveUpBy === "rejected")).toBe(true);
    expect(after.chunks[0]).toMatchObject({ attemptsLeft: 0, gaveUpBy: "rejected" });
  });

  test("a chunk rejected twice is given up and the job goes on with the next one", async () => {
    const m = makeMock();
    m.engine.failNextSceneAttempt("rejected");
    m.engine.failNextSceneAttempt("rejected");
    const { jobId } = await composed(m, 30);
    m.scheduler.runAll();

    expect(m.events.find((e) => e.type === "job.done")).toMatchObject({ payload: { jobId, result: { written: 5, unwritten: 25 } } });
    const view = await setOf(m);
    expect(view.chunks.map((c) => c.gaveUpBy)).toEqual(["rejected", null]);
    expect(view.scenes.slice(0, 25).every((s) => s.gaveUpBy === "rejected")).toBe(true);
    expect(view.scenes.slice(25).every((s) => s.text !== null)).toBe(true);
    expect(view.lastCompose).toEqual({ total: 30, written: 5, gaveUp: 25 });
  });

  test("a provider's refusal ends its chunk at once and the next chunk is written", async () => {
    const m = makeMock();
    m.engine.failNextSceneAttempt("refused");
    await composed(m, 30);
    m.scheduler.runAll();
    expect((await setOf(m)).chunks.map((c) => c.gaveUpBy)).toEqual(["refused", null]);
  });

  test("scenes.cancel stops the job: cancelled after scenes.changed, the chunks written stay", async () => {
    const m = makeMock();
    const { sceneSetId, jobId } = await composed(m, 30);
    m.scheduler.next();
    await unwrap(m.client.request("scenes.cancel", { sceneSetId }));
    m.scheduler.runAll();

    expect(m.events.find((e) => e.type === "job.cancelled")).toMatchObject({ payload: { kind: "scenes", jobId } });
    const view = await setOf(m);
    expect(view).toMatchObject({ status: "stopped", stoppedBy: "cancelled" });
    expect(view.scenes.slice(0, 25).every((s) => s.text !== null)).toBe(true);
    expect(view.scenes.slice(25).every((s) => s.text === null)).toBe(true);
  });

  test("«Дописать» writes only what is waiting, within its price, and ends the set ready", async () => {
    const m = makeMock();
    m.engine.failNextSceneAttempt("rate-limited");
    await composed(m, 30);
    m.scheduler.runAll();
    const view = await setOf(m);

    const estimate = (await unwrap(m.client.request("scenes.estimateWrite", { sceneSetId: view.sceneSetId, target: { kind: "unwritten" } }))).estimate;
    expect(estimate.worstMicros).toBe(4 * ATTEMPT);
    expect(await codeOf(write(m, view.sceneSetId, view.revision, estimate.worstMicros - 1))).toBe("PRICE_CHANGED");
    expect(await codeOf(write(m, view.sceneSetId, view.revision + 5, estimate.worstMicros))).toBe("SCENES_CHANGED");
    await unwrap(write(m, view.sceneSetId, view.revision, estimate.worstMicros));
    m.scheduler.runAll();

    expect(await setOf(m)).toMatchObject({ status: "ready", write: null });
    expect(await codeOf(write(m, view.sceneSetId, (await setOf(m)).revision, 10 * ATTEMPT))).toBe("VALIDATION");
  });
});

describe("scenes.edit", () => {
  async function readySet(m: Mock, count = 5): Promise<SceneSetView> {
    await composed(m, count);
    m.scheduler.runAll();
    return setOf(m);
  }

  test("a text edit is announced and answered with the next revision", async () => {
    const m = makeMock();
    const before = await readySet(m);
    const result = await unwrap(edit(m, before.sceneSetId, before.revision, { op: "text", sceneId: 2, text: "She waves from the pier." }));
    if (!("sceneSet" in result)) throw new Error("expected the set");
    expect(result.sceneSet.revision).toBe(before.revision + 1);
    expect(result.sceneSet.scenes[1]).toMatchObject({ text: "She waves from the pier.", edited: true });
    expect(changes(m.events).at(-1)?.revision).toBe(before.revision + 1);
  });

  test.each([
    ["   ", "empty"],
    ["a".repeat(601), "too-long"],
    ["one\ntwo", "not-one-line"],
    ["She wears a bikini.", "revealing-word"],
    ["A teenage girl smiles.", "youth-word"],
  ])("the problem with %j is %s: a result, and nothing changes", async (text, reason) => {
    const m = makeMock();
    const before = await readySet(m);
    const eventsBefore = changes(m.events).length;
    expect(await unwrap(edit(m, before.sceneSetId, before.revision, { op: "text", sceneId: 1, text }))).toMatchObject({ problem: { reason } });
    expect(await setOf(m)).toEqual(before);
    expect(changes(m.events)).toHaveLength(eventsBefore);
  });

  test("a stale revision is SCENES_CHANGED, and two edits on one revision lose nothing", async () => {
    const m = makeMock();
    const { sceneSetId, revision } = await readySet(m);
    await unwrap(edit(m, sceneSetId, revision, { op: "text", sceneId: 1, text: "From window A." }));
    expect(await codeOf(edit(m, sceneSetId, revision, { op: "remove", sceneIds: [2] }))).toBe("SCENES_CHANGED");
    const view = await setOf(m);
    expect(view.scenes[0]?.text).toBe("From window A.");
    expect(view.scenes[1]?.removed).toBe(false);
  });

  test("removing many scenes is one revision and one event, and restoring brings them back", async () => {
    const m = makeMock();
    const before = await readySet(m, 5);
    const eventsBefore = changes(m.events).length;
    const removed = await unwrap(edit(m, before.sceneSetId, before.revision, { op: "remove", sceneIds: [1, 2, 3] }));
    if (!("sceneSet" in removed)) throw new Error("expected the set");
    expect(removed.sceneSet.revision).toBe(before.revision + 1);
    expect(removed.sceneSet.scenes.filter((s) => s.removed)).toHaveLength(3);
    expect(changes(m.events)).toHaveLength(eventsBefore + 1);
    const restored = await unwrap(edit(m, before.sceneSetId, removed.sceneSet.revision, { op: "restore", sceneIds: [1, 2, 3] }));
    if (!("sceneSet" in restored)) throw new Error("expected the set");
    expect(restored.sceneSet.scenes.every((s) => !s.removed)).toBe(true);
  });

  test("a typed text makes a waiting scene written, and a set whose waiting scenes are all removed reads ready", async () => {
    const m = makeMock();
    m.engine.failNextSceneAttempt("rate-limited");
    await composed(m, 5);
    m.scheduler.runAll();
    const before = await setOf(m);
    expect(before.status).toBe("stopped");
    const typed = await unwrap(edit(m, before.sceneSetId, before.revision, { op: "text", sceneId: 1, text: "Typed." }));
    if (!("sceneSet" in typed)) throw new Error("expected the set");
    expect(typed.sceneSet.scenes[0]).toMatchObject({ text: "Typed.", unwritten: null });
    const removed = await unwrap(edit(m, before.sceneSetId, typed.sceneSet.revision, { op: "remove", sceneIds: [2, 3, 4, 5] }));
    if (!("sceneSet" in removed)) throw new Error("expected the set");
    expect(removed.sceneSet).toMatchObject({ status: "ready", stoppedBy: null });
  });

  test("a scene the set does not have is VALIDATION; IN_FLIGHT while the job runs; NOT_FOUND for an unknown set", async () => {
    const m = makeMock();
    const { sceneSetId } = await composed(m, 5);
    expect(await codeOf(edit(m, sceneSetId, 1, { op: "remove", sceneIds: [1] }))).toBe("IN_FLIGHT");
    m.scheduler.runAll();
    const view = await setOf(m);
    expect(await codeOf(edit(m, sceneSetId, view.revision, { op: "remove", sceneIds: [1, 99] }))).toBe("VALIDATION");
    expect(await codeOf(edit(m, "set-nobody-0404", 1, { op: "remove", sceneIds: [1] }))).toBe("NOT_FOUND");
  });

  test("a used set is read-only: VALIDATION for an edit, a write and a discard", async () => {
    const m = makeMock();
    const view = await readySet(m);
    m.engine.markSceneSetUsed(view.sceneSetId);
    expect(await setOf(m)).toMatchObject({ status: "used", runId: expect.any(String) });
    expect(await codeOf(edit(m, view.sceneSetId, view.revision, { op: "remove", sceneIds: [1] }))).toBe("VALIDATION");
    expect(await codeOf(m.client.request("scenes.discard", { sceneSetId: view.sceneSetId }))).toBe("VALIDATION");
    expect(await codeOf(write(m, view.sceneSetId, view.revision, 10 * ATTEMPT))).toBe("VALIDATION");
  });
});

describe("scenes.discard, scenes.cancel and a seeded set", () => {
  test("a discard removes the set and announces it; refused while a job runs", async () => {
    const m = makeMock();
    const { sceneSetId } = await composed(m, 5);
    expect(await codeOf(m.client.request("scenes.discard", { sceneSetId }))).toBe("IN_FLIGHT");
    m.scheduler.runAll();
    await unwrap(m.client.request("scenes.discard", { sceneSetId }));
    expect(m.events.at(-1)).toMatchObject({ type: "scenes.changed", payload: { change: "removed", sceneSetId, avatarId: MIA.avatarId } });
    expect(await unwrap(m.client.request("scenes.get", { avatarId: MIA.avatarId }))).toEqual({ sceneSet: null, unreadable: 0 });
  });

  test("a cancel answers ok for a set that is not running, NOT_FOUND for an unknown one", async () => {
    const m = makeMock();
    const { sceneSetId } = await composed(m, 5);
    m.scheduler.runAll();
    expect(await unwrap(m.client.request("scenes.cancel", { sceneSetId }))).toEqual({ sceneSetId });
    expect(await codeOf(m.client.request("scenes.cancel", { sceneSetId: "set-nobody-0404" }))).toBe("NOT_FOUND");
  });

  test("a seeded set is what scenes.get answers, with the files nobody could read counted", async () => {
    const m = makeMock({ sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-seed-0001", count: 30, written: 25, stopped: "closed" }], unreadableSceneSets: 2 });
    const { sceneSet, unreadable } = await unwrap(m.client.request("scenes.get", { avatarId: MIA.avatarId }));
    expect(unreadable).toBe(2);
    expect(sceneSet).toMatchObject({ sceneSetId: "set-seed-0001", status: "stopped", stoppedBy: "closed" });
    expect(sceneSet?.scenes.filter((s) => s.unwritten === "pending")).toHaveLength(5);
  });

  test("scenes.get for an avatar the library does not have is NOT_FOUND", async () => {
    const m = makeMock();
    expect(await codeOf(m.client.request("scenes.get", { avatarId: "avatar-nobody-404" }))).toBe("NOT_FOUND");
  });
});
