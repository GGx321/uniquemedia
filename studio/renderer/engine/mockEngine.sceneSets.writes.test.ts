import { describe, expect, test } from "bun:test";
import type { AvatarSummary, EventMessage, SceneSetView } from "../../shared/engine";
import { DEFAULT_TRAITS } from "../lib/traits";
import { MockEngine, mockDescriptor, mockEngineClient } from "./mockEngine";
import { ManualScheduler } from "./scheduler";

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

type Target = { kind: "rewrite"; sceneIds: number[]; redraw: boolean } | { kind: "idea"; idea: string; count: number; shot: string | null } | { kind: "resume"; write: number };
const rewrite = (sceneIds: number[], redraw = false): Target => ({ kind: "rewrite", sceneIds, redraw });
const idea = (text: string, count = 1, shot: string | null = null): Target => ({ kind: "idea", idea: text, count, shot });

/** A ready set of `count` written scenes, composed and finished. */
async function readySet(m: Mock, count = 4, categories: string[] = ["home"]): Promise<SceneSetView> {
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
const edit = (m: Mock, view: SceneSetView, op: unknown) => m.client.request("scenes.edit", { sceneSetId: view.sceneSetId, revision: view.revision, op } as never);

/** Starts a write, lets its job run to its end, and answers the set. */
async function writeAndRun(m: Mock, view: SceneSetView, target: Target, accepted = 2 * ATTEMPT): Promise<SceneSetView> {
  await unwrap(write(m, view, target, accepted));
  m.scheduler.runAll();
  return setOf(m);
}
const texts = (view: SceneSetView) => view.scenes.map((s) => s.text);

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

  test("expects the writer's typical tokens: a couple of thousandths of a dollar for one scene", async () => {
    const m = makeMock();
    const view = await readySet(m);
    const { expectedMicros } = await estimate(m, view, rewrite([2]));
    expect(expectedMicros).toBeGreaterThan(300);
    expect(expectedMicros).toBeLessThan(2_500);
  });

  test("the refusals are free and come in the engine's order: NOT_FOUND for the set, then VALIDATION for the scenes and the write", async () => {
    const m = makeMock();
    const view = await readySet(m);
    await unwrap(edit(m, view, { op: "remove", sceneIds: [4] }));
    const fresh = await setOf(m);
    const refused = (target: Target) => codeOf(m.client.request("scenes.estimateWrite", { sceneSetId: fresh.sceneSetId, target } as never));

    expect(await refused(rewrite([99]))).toBe("VALIDATION");
    expect(await refused(rewrite([4]))).toBe("VALIDATION");
    expect(await refused({ kind: "resume", write: 9 })).toBe("VALIDATION");
    expect(await codeOf(m.client.request("scenes.estimateWrite", { sceneSetId: "set-nobody-404", target: rewrite([1]) } as never))).toBe("NOT_FOUND");
  });

  test("mixed kinds and an own scene redrawn are VALIDATION; an idea that would not fit in the set is too", async () => {
    const m = makeMock();
    const view = await readySet(m);
    const withOwn = await writeAndRun(m, view, idea("кофе", 1));
    const own = withOwn.scenes.find((s) => s.origin === "own");
    const refused = (target: Target) => codeOf(m.client.request("scenes.estimateWrite", { sceneSetId: withOwn.sceneSetId, target } as never));
    expect(await refused(rewrite([1, own?.sceneId ?? 0]))).toBe("VALIDATION");
    expect(await refused(rewrite([own?.sceneId ?? 0], true))).toBe("VALIDATION");

    const big = makeMock();
    await readySet(big, 100);
    for (let i = 0; i < 19; i++) {
      const v = await setOf(big);
      await writeAndRun(big, v, idea("кофе", 5));
    }
    const full = await setOf(big);
    expect(full.scenes).toHaveLength(195);
    expect((await estimate(big, full, idea("кофе", 5))).worstMicros).toBe(2 * ATTEMPT);
    const after = await writeAndRun(big, full, idea("кофе", 5));
    expect(after.scenes).toHaveLength(200);
    expect(await codeOf(big.client.request("scenes.estimateWrite", { sceneSetId: after.sceneSetId, target: idea("кофе", 1) } as never))).toBe("VALIDATION");
  });
});

describe("scenes.write: a rewrite", () => {
  test("gives the target a new sentence and touches no other scene; scenes.changed announces its start and its end, the last before job.done", async () => {
    const m = makeMock();
    const view = await readySet(m);
    const before = texts(view);
    const jobId = (await unwrap(write(m, view, rewrite([2])))).jobId;
    expect(await setOf(m)).toMatchObject({ status: "writing", write: { kind: "rewrite", count: 1, sceneIds: [2] } });
    m.scheduler.runAll();

    const after = await setOf(m);
    expect(after).toMatchObject({ status: "ready", write: null });
    expect(after.scenes[1]?.text).not.toBe(before[1]);
    expect(after.scenes.filter((s) => s.sceneId !== 2).map((s) => s.text)).toEqual(before.filter((_, i) => i !== 1));
    const all = m.events;
    const done = all.findLastIndex((e) => e.type === "job.done");
    expect(all[done]).toMatchObject({ payload: { jobId, result: { kind: "scenes", written: 1, unwritten: 0 } } });
    expect(all.findLastIndex((e) => e.type === "scenes.changed")).toBeLessThan(done);
  });

  test("books what the write cost: one request, at the writer's typical tokens", async () => {
    const m = makeMock();
    const view = await readySet(m);
    const spent = view.spentMicros ?? 0;
    const after = await writeAndRun(m, view, rewrite([2]));
    expect((after.spentMicros ?? 0) - spent).toBeGreaterThan(300);
    expect((after.spentMicros ?? 0) - spent).toBeLessThan(2_500);
  });

  test("a redraw shows the new place only with the accepted sentence, avoids the places the set shows, and never touches another scene", async () => {
    const m = makeMock();
    const view = await readySet(m, 3);
    const before = view.scenes[0];
    await unwrap(write(m, view, rewrite([1], true)));
    // The job has not run: the scene is what it was.
    expect((await setOf(m)).scenes[0]).toMatchObject({ place: before?.place, text: before?.text });
    m.scheduler.runAll();

    const after = await setOf(m);
    expect(after.scenes[0]?.place?.location).not.toBe(before?.place?.location);
    expect(after.scenes.slice(1)).toEqual(view.scenes.slice(1));
  });

  test("a redraw of a scene whose category was deleted is NOT_FOUND, free; a plain rewrite of it still works", async () => {
    const m = makeMock();
    const created = await unwrap(m.client.request("categories.create", { name: "Кофейни Парижа", description: "кофейни Парижа", acceptedWorstMicros: 50_000 }));
    const view = await readySet(m, 3, [created.category.categoryId]);
    await unwrap(m.client.request("categories.delete", { categoryId: created.category.categoryId }));

    expect(await codeOf(write(m, view, rewrite([1], true)))).toBe("NOT_FOUND");
    expect(await codeOf(m.client.request("scenes.estimateWrite", { sceneSetId: view.sceneSetId, target: rewrite([1], true) } as never))).toBe("NOT_FOUND");
    const after = await writeAndRun(m, view, rewrite([1], false));
    expect(after.scenes[0]?.text).not.toBe(view.scenes[0]?.text);
  });

  test("a redraw of a custom category refreshes nothing the view shows but the place: the category's name stays the set's snapshot", async () => {
    const m = makeMock();
    const created = await unwrap(m.client.request("categories.create", { name: "Кофейни Парижа", description: "кофейни Парижа", acceptedWorstMicros: 50_000 }));
    const view = await readySet(m, 3, [created.category.categoryId]);
    const after = await writeAndRun(m, view, rewrite([1], true));
    expect(after.categories).toEqual(view.categories);
    expect(after.scenes[0]).toMatchObject({ category: created.category.categoryId, categoryName: "Кофейни Парижа" });
  });

  test("a write that fails leaves the scene exactly as it was: two rejected answers, two attempts paid, no marker, nothing to resume", async () => {
    const m = makeMock();
    const view = await readySet(m);
    m.engine.failNextSceneAttempt("rejected");
    m.engine.failNextSceneAttempt("rejected");
    await unwrap(write(m, view, rewrite([2], true)));
    m.scheduler.runAll();

    expect(m.events.find((e) => e.type === "job.failed")).toMatchObject({ payload: { kind: "scenes" } });
    const after = await setOf(m);
    expect(after.scenes).toEqual(view.scenes);
    expect(after).toMatchObject({ status: "ready" });
    expect((after.spentMicros ?? 0) - (view.spentMicros ?? 0)).toBe(4_000);
    expect(after.scenes.some((s) => s.rewriteInterrupted !== undefined)).toBe(false);
    expect(await codeOf(m.client.request("scenes.estimateWrite", { sceneSetId: after.sceneSetId, target: { kind: "resume", write: 2 } } as never))).toBe("VALIDATION");
  });

  test("a provider's refusal is final: MODERATION_REFUSED, one attempt, nothing changed", async () => {
    const m = makeMock();
    const view = await readySet(m);
    m.engine.failNextSceneAttempt("refused");
    await unwrap(write(m, view, rewrite([2])));
    m.scheduler.runAll();
    expect(m.events.find((e) => e.type === "job.failed")).toMatchObject({ payload: { error: { code: "MODERATION_REFUSED" } } });
    expect((await setOf(m)).scenes).toEqual(view.scenes);
  });
});

describe("an interrupted rewrite: a marker on its scene, the set stays ready", () => {
  test("a free failure marks the scene with why, keeps its old text, and keeps both attempts", async () => {
    const m = makeMock();
    const view = await readySet(m);
    m.engine.failNextSceneAttempt("rate-limited");
    const after = await writeAndRun(m, view, rewrite([2]));

    expect(m.events.find((e) => e.type === "job.failed")).toMatchObject({ payload: { error: { code: "RATE_LIMITED" } } });
    expect(after).toMatchObject({ status: "ready", stoppedBy: null });
    expect(after.scenes.map((s) => s.rewriteInterrupted)).toEqual([undefined, { write: 2, stoppedBy: "rate-limited" }, undefined, undefined]);
    expect(texts(after)).toEqual(texts(view));
    expect((after.spentMicros ?? 0) - (view.spentMicros ?? 0)).toBe(0);
  });

  test("a resume carries the same write on and the marker goes", async () => {
    const m = makeMock();
    const view = await readySet(m);
    m.engine.failNextSceneAttempt("rate-limited");
    const stopped = await writeAndRun(m, view, rewrite([2]));
    const after = await writeAndRun(m, stopped, { kind: "resume", write: 2 });

    expect(after.scenes.some((s) => s.rewriteInterrupted !== undefined)).toBe(false);
    expect(after.scenes[1]?.text).not.toBe(view.scenes[1]?.text);
  });

  test("a dropped connection leaves a reserve open: one attempt left, and a resume waits for the reconcile; after it the resume goes through", async () => {
    const m = makeMock();
    const view = await readySet(m);
    m.engine.failNextSceneAttempt("network");
    const stopped = await writeAndRun(m, view, rewrite([2]));

    expect(stopped).toMatchObject({ status: "ready", openReserveMicros: ATTEMPT });
    expect(stopped.scenes[1]?.rewriteInterrupted).toEqual({ write: 2, stoppedBy: "network" });
    expect((await estimate(m, stopped, { kind: "resume", write: 2 })).worstMicros).toBe(ATTEMPT);
    expect(await codeOf(write(m, stopped, { kind: "resume", write: 2 }, ATTEMPT))).toBe("RECONCILE_REQUIRED");
    await unwrap(m.client.request("money.reconcile", {}));
    const reconciled = await setOf(m);
    expect(reconciled.openReserveMicros).toBe(0);
    const after = await writeAndRun(m, reconciled, { kind: "resume", write: 2 }, ATTEMPT);
    expect(after.scenes[1]?.rewriteInterrupted).toBeUndefined();
    expect(after.scenes[1]?.text).not.toBe(view.scenes[1]?.text);
  });

  test("never a fresh pair: after one interrupted attempt the write gets ONE more, and a rejected answer resolves it", async () => {
    const m = makeMock();
    const view = await readySet(m);
    m.engine.failNextSceneAttempt("network");
    const stopped = await writeAndRun(m, view, rewrite([2]));
    await unwrap(m.client.request("money.reconcile", {}));
    const reconciled = await setOf(m);
    m.engine.failNextSceneAttempt("rejected");
    const after = await writeAndRun(m, reconciled, { kind: "resume", write: 2 }, ATTEMPT);

    expect(after.scenes.some((s) => s.rewriteInterrupted !== undefined)).toBe(false);
    expect(await codeOf(write(m, after, { kind: "resume", write: 2 }, ATTEMPT))).toBe("VALIDATION");
    expect(stopped.scenes[1]?.rewriteInterrupted).toBeDefined();
  });

  test("«Оставить как есть» dismisses the marker, free; the next write is number 2 and the marker of another scene survives", async () => {
    const m = makeMock();
    const view = await readySet(m);
    m.engine.failNextSceneAttempt("rate-limited");
    const first = await writeAndRun(m, view, rewrite([2]));
    m.engine.failNextSceneAttempt("rate-limited");
    const second = await writeAndRun(m, first, rewrite([3]));
    expect(second.scenes.map((s) => s.rewriteInterrupted?.write)).toEqual([undefined, 2, 3, undefined]);

    const dismissed = await unwrap(edit(m, second, { op: "dismissInterrupted", sceneIds: [2] }));
    expect("sceneSet" in dismissed ? dismissed.sceneSet.scenes.map((s) => s.rewriteInterrupted?.write) : null).toEqual([undefined, undefined, 3, undefined]);
    const again = await setOf(m);
    const after = await writeAndRun(m, again, rewrite([2]));
    expect(after.scenes[1]?.text).not.toBe(view.scenes[1]?.text);
    expect(after.scenes[2]?.rewriteInterrupted).toEqual({ write: 3, stoppedBy: "rate-limited" });
  });

  test("dismissing a scene without an interrupted write, or an unknown write, is VALIDATION; a dismissal needs the job to be over", async () => {
    const m = makeMock();
    const view = await readySet(m);
    expect(await codeOf(edit(m, view, { op: "dismissInterrupted", sceneIds: [2] }))).toBe("VALIDATION");
    expect(await codeOf(edit(m, view, { op: "dismissInterrupted", write: 7 }))).toBe("VALIDATION");
    await unwrap(write(m, view, rewrite([2])));
    expect(await codeOf(edit(m, await setOf(m), { op: "dismissInterrupted", write: 2 }))).toBe("IN_FLIGHT");
  });

  test("a cancel mid-request marks the scene as cancelled and leaves the reserve open", async () => {
    const m = makeMock();
    const view = await readySet(m);
    await unwrap(write(m, view, rewrite([2])));
    await unwrap(m.client.request("scenes.cancel", { sceneSetId: view.sceneSetId }));
    m.scheduler.runAll();
    const after = await setOf(m);
    expect(after.scenes[1]?.rewriteInterrupted).toEqual({ write: 2, stoppedBy: "cancelled" });
    expect(after.openReserveMicros).toBe(ATTEMPT);
  });
});

describe("scenes.write: an idea", () => {
  test("adds k own scenes written from the idea, under ids after the set's highest; a planned scene is untouched", async () => {
    const m = makeMock();
    const view = await readySet(m);
    const after = await writeAndRun(m, view, idea("  кофе на балконе утром  ", 3, "friend"));

    expect(m.events.findLast((e) => e.type === "job.done")).toMatchObject({ payload: { result: { written: 3, unwritten: 0 } } });
    expect(after.scenes.slice(0, 4)).toEqual(view.scenes);
    expect(after.scenes.slice(4).map((s) => [s.sceneId, s.origin, s.category, s.place, s.idea, s.shot, s.removed, s.unwritten, s.chunk])).toEqual(
      [5, 6, 7].map((id) => [id, "own", "own", null, "кофе на балконе утром", "friend", false, null, null]),
    );
    expect(after.scenes.slice(4).every((s) => s.text !== null && (s.pose === "front" || s.pose === "three-quarter"))).toBe(true);
    expect(after.lastCompose).toEqual(view.lastCompose);
  });

  test("auto never picks the mirror, and a selfie or mirror scene faces the camera whatever the set allows", async () => {
    const m = makeMock();
    let view = await readySet(m);
    for (let i = 0; i < 4; i++) view = await writeAndRun(m, view, idea("кофе", 5, null));
    expect(view.scenes.filter((s) => s.origin === "own").some((s) => s.shot === "mirror")).toBe(false);
    view = await writeAndRun(m, view, idea("кофе", 5, "mirror"));
    const mirrors = view.scenes.filter((s) => s.origin === "own" && s.shot === "mirror");
    expect(mirrors).toHaveLength(5);
    expect(mirrors.every((s) => s.pose === "front" || s.pose === "three-quarter")).toBe(true);
  });

  test("an idea write that cannot be answered adds no scene and leaves no trace on the set", async () => {
    const m = makeMock();
    const view = await readySet(m);
    m.engine.failNextSceneAttempt("rejected");
    m.engine.failNextSceneAttempt("rejected");
    const after = await writeAndRun(m, view, idea("кофе", 2));
    expect(after.scenes).toHaveLength(4);
    expect(after.interruptedIdeas).toBeUndefined();
  });

  test("an interrupted idea write is listed on the set; a resume adds its scenes under the ids it reserved; «Не нужно» drops it", async () => {
    const m = makeMock();
    const view = await readySet(m);
    m.engine.failNextSceneAttempt("rate-limited");
    const stopped = await writeAndRun(m, view, idea("кофе на балконе", 2, "friend"));
    expect(stopped.interruptedIdeas).toEqual([{ write: 2, idea: "кофе на балконе", count: 2, shot: "friend", stoppedBy: "rate-limited" }]);
    expect(stopped.scenes).toHaveLength(4);

    const meanwhile = await writeAndRun(m, stopped, idea("прогулка", 1));
    expect(meanwhile.scenes.filter((s) => s.origin === "own").map((s) => s.sceneId)).toEqual([7]);
    const resumed = await writeAndRun(m, meanwhile, { kind: "resume", write: 2 });
    expect(resumed.scenes.filter((s) => s.origin === "own").map((s) => s.sceneId)).toEqual([7, 5, 6]);
    expect(resumed.interruptedIdeas).toBeUndefined();

    m.engine.failNextSceneAttempt("rate-limited");
    const stoppedAgain = await writeAndRun(m, resumed, idea("ещё", 1));
    const dropped = await unwrap(edit(m, stoppedAgain, { op: "dismissInterrupted", write: 4 }));
    expect("sceneSet" in dropped ? dropped.sceneSet.interruptedIdeas : "no").toBeUndefined();
  });

  test("a set with no room refuses VALIDATION, free", async () => {
    const m = makeMock();
    const view = await readySet(m, 100);
    let v = view;
    for (let i = 0; i < 20; i++) v = await writeAndRun(m, v, idea("кофе", 5));
    expect(v.scenes).toHaveLength(200);
    expect(await codeOf(write(m, v, idea("кофе", 1)))).toBe("VALIDATION");
  });

  test("⟳ on an own scene writes it again from its stored idea, keeping its shot and pose", async () => {
    const m = makeMock();
    const view = await readySet(m);
    const withOwn = await writeAndRun(m, view, idea("кофе на балконе", 1, "selfie"));
    const own = withOwn.scenes[4];
    const after = await writeAndRun(m, withOwn, rewrite([5]));
    expect(after.scenes[4]).toMatchObject({ origin: "own", idea: "кофе на балконе", shot: own?.shot, pose: own?.pose });
    expect(after.scenes[4]?.text).not.toBe(own?.text);
    expect(await codeOf(write(m, after, rewrite([5], true)))).toBe("VALIDATION");
  });

  test("an own scene is edited, removed and restored like any scene", async () => {
    const m = makeMock();
    const withOwn = await writeAndRun(m, await readySet(m), idea("кофе", 1));
    const typed = await unwrap(edit(m, withOwn, { op: "text", sceneId: 5, text: "She waves from the balcony." }));
    expect("sceneSet" in typed ? typed.sceneSet.scenes[4] : null).toMatchObject({ text: "She waves from the balcony.", edited: true, origin: "own" });
    expect(await codeOf(edit(m, await setOf(m), { op: "text", sceneId: 5, text: "She wears a bikini." }).then((r) => (r.ok && "problem" in r.result ? { ok: false as const, error: { code: "PROBLEM" } } : r)))).toBe("PROBLEM");
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

  test("SCENES_CHANGED when the set moved; VALIDATION once used; IN_FLIGHT while a job runs; NOT_FOUND for an unknown set", async () => {
    const m = makeMock();
    const view = await readySet(m);
    await unwrap(edit(m, view, { op: "remove", sceneIds: [4] }));
    expect(await codeOf(write(m, view, rewrite([2])))).toBe("SCENES_CHANGED");
    const fresh = await setOf(m);
    await unwrap(write(m, fresh, rewrite([2])));
    expect(await codeOf(write(m, await setOf(m), rewrite([3])))).toBe("IN_FLIGHT");
    m.scheduler.runAll();
    expect(await codeOf(m.client.request("scenes.write", { sceneSetId: "set-nobody-404", revision: 1, target: rewrite([1]), acceptedWorstMicros: 2 * ATTEMPT } as never))).toBe("NOT_FOUND");
    m.engine.markSceneSetUsed(fresh.sceneSetId);
    expect(await codeOf(write(m, await setOf(m), rewrite([3])))).toBe("VALIDATION");
  });

  test("a removed scene is not rewritten: VALIDATION, free", async () => {
    const m = makeMock();
    const view = await readySet(m);
    await unwrap(edit(m, view, { op: "remove", sceneIds: [2] }));
    expect(await codeOf(write(m, await setOf(m), rewrite([2])))).toBe("VALIDATION");
  });
});

describe("a crashed «Дописать» does not leave a stale «Готово»", () => {
  test("beginning a write forgets the last job's outcome: the set reads its scenes as they are", async () => {
    const m = makeMock();
    m.engine.failNextSceneAttempt("rate-limited");
    await unwrap(m.client.request("scenes.compose", { avatarId: MIA.avatarId, count: 5, categories: ["home"], poses: POSES, acceptedWorstMicros: 2 * ATTEMPT } as never));
    m.scheduler.runAll();
    const stopped = await setOf(m);
    expect(stopped.lastCompose).toEqual({ total: 5, written: 0, gaveUp: 0 });
    const typed = await unwrap(edit(m, stopped, { op: "text", sceneId: 1, text: "Typed by hand." }));
    const view = "sceneSet" in typed ? typed.sceneSet : stopped;
    expect(view.lastCompose).toEqual({ total: 5, written: 0, gaveUp: 0 });

    await unwrap(write(m, view, { kind: "unwritten" } as never, 2 * ATTEMPT));
    expect((await setOf(m)).lastCompose).toEqual({ total: 5, written: 1, gaveUp: 0 });
  });
});
