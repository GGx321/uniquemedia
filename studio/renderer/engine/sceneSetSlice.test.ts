import { describe, expect, test } from "bun:test";
import type { AvatarSummary, CommandMessage, CommandType, SceneSetView } from "../../shared/engine";
import { DEFAULT_TRAITS } from "../lib/traits";
import { MockEngine, mockDescriptor, mockEngineClient } from "./mockEngine";
import { ManualScheduler } from "./scheduler";
import { SceneSetSlice } from "./sceneSetSlice";
import { EngineStore } from "./store";

// CS.6: the window's scene set slice. One per window (the engine provider owns it): the Photos screen reads an avatar's set with `scenes.get` when it
// first shows it, follows `scenes.changed`, and asks again after a snapshot taken again, a removal and a reconcile (which changes what the set spent
// without an event of its own). It also keeps what only this window knows: the price it accepted for a scenes job it started (the task line's «≈ … · до
// …»), the scenes its own rewrites replaced («новая»), an open reserve it saw closed by a reconcile, and a dismissed «Готово … не составлены».

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
const LEA: AvatarSummary = { ...MIA, avatarId: "avatar-lea-0002", name: "Lea" };

const ATTEMPT = 37_500;
const POSES = { profile: false, back: false };

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

async function started(options: ConstructorParameters<typeof MockEngine>[0] = {}) {
  const scheduler = new ManualScheduler();
  const engine = new MockEngine({ scheduler, avatars: [MIA, LEA], ...options });
  const client = mockEngineClient(engine);
  const store = new EngineStore(client);
  store.start();
  const slice = new SceneSetSlice(client, store);
  slice.start();
  await settle();
  return { scheduler, engine, client, store, slice };
}
type Harness = Awaited<ReturnType<typeof started>>;

const callsOf = <T extends CommandType>(engine: MockEngine, type: T): Extract<CommandMessage, { type: T }>[] =>
  engine.calls.filter((c): c is Extract<CommandMessage, { type: T }> => c.type === type);

function setOf(h: Harness, avatarId = MIA.avatarId): SceneSetView | null {
  const entry = h.slice.getView().sets.get(avatarId);
  if (entry === undefined || entry.status !== "ready") throw new Error(`the entry is ${entry?.status ?? "missing"}`);
  return entry.sceneSet;
}

async function compose(h: Harness, count = 4): Promise<string> {
  const reply = await h.client.request("scenes.compose", { avatarId: MIA.avatarId, count, categories: ["home"], poses: POSES, acceptedWorstMicros: Math.ceil(count / 25) * 2 * ATTEMPT });
  if (!reply.ok) throw new Error(reply.error.code);
  await settle();
  return reply.result.sceneSetId;
}

describe("reading an avatar's set", () => {
  test("asked once when a screen first shows the avatar, and again only for another retain after a release", async () => {
    const h = await started({ sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-seed-0001", count: 3, written: 3 }] });
    expect(h.slice.getView().sets.get(MIA.avatarId) === undefined).toBe(true);
    const release = h.slice.retain(MIA.avatarId);
    expect(h.slice.getView().sets.get(MIA.avatarId)?.status).toBe("loading");
    const second = h.slice.retain(MIA.avatarId);
    await settle();
    expect(callsOf(h.engine, "scenes.get")).toHaveLength(1);
    expect(setOf(h)?.sceneSetId).toBe("set-seed-0001");
    release();
    second();
    h.slice.retain(MIA.avatarId);
    await settle();
    expect(callsOf(h.engine, "scenes.get")).toHaveLength(2);
  });

  test("an avatar with no set reads null; a refused read is kept as failed until asked again", async () => {
    const h = await started();
    h.engine.failNext("scenes.get", { code: "LIBRARY_UNAVAILABLE" });
    h.slice.retain(MIA.avatarId);
    await settle();
    expect(h.slice.getView().sets.get(MIA.avatarId)?.status).toBe("failed");
    h.slice.reload(MIA.avatarId);
    await settle();
    expect(setOf(h)).toBe(null);
  });
});

describe("following scenes.changed", () => {
  test("a set composed and written is followed revision by revision; another avatar's change leaves this one alone", async () => {
    const h = await started();
    h.slice.retain(MIA.avatarId);
    await settle();
    const id = await compose(h);
    expect(setOf(h)?.sceneSetId).toBe(id);
    expect(setOf(h)?.status).toBe("writing");
    h.scheduler.runAll();
    await settle();
    expect(setOf(h)?.status).toBe("ready");
    const before = setOf(h)?.revision;
    await h.client.request("scenes.compose", { avatarId: LEA.avatarId, count: 2, categories: ["home"], poses: POSES, acceptedWorstMicros: 2 * ATTEMPT });
    await settle();
    expect(setOf(h)?.revision).toBe(before);
    expect(h.slice.getView().sets.get(LEA.avatarId) === undefined).toBe(true);
  });

  test("a change heard while the read is on its way is applied to its (older) answer", async () => {
    const scheduler = new ManualScheduler();
    const engine = new MockEngine({ scheduler, avatars: [MIA], sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-seed-0001", count: 3, written: 3 }] });
    const base = mockEngineClient(engine);
    // The read is answered as the set was when it was asked, but handed over only after an edit's event: a slow answer overtaken by a change.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const client: typeof base = {
      ...base,
      request: (async (type: CommandType, payload: never) => {
        const reply = await base.request(type, payload);
        if (type === "scenes.get") await gate;
        return reply;
      }) as typeof base.request,
    };
    const store = new EngineStore(client);
    store.start();
    const slice = new SceneSetSlice(client, store);
    slice.start();
    await settle();
    slice.retain(MIA.avatarId);
    await settle();
    const edit = await base.request("scenes.edit", { sceneSetId: "set-seed-0001", revision: 1, op: { op: "remove", sceneIds: [1] } });
    expect(edit.ok).toBe(true);
    await settle();
    release();
    await settle();
    const entry = slice.getView().sets.get(MIA.avatarId);
    const set = entry?.status === "ready" ? entry.sceneSet : null;
    expect(set?.revision).toBe(2);
    expect(set?.scenes[0]?.removed).toBe(true);
  });

  test("a command's own answer is taken unless a newer revision is already shown", async () => {
    const h = await started({ sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-seed-0001", count: 3, written: 3 }] });
    h.slice.retain(MIA.avatarId);
    await settle();
    const shown = setOf(h);
    if (shown === null) throw new Error("no set");
    h.slice.apply({ ...shown, revision: shown.revision + 5, scenes: shown.scenes.map((s) => ({ ...s, removed: true })) });
    expect(setOf(h)?.scenes.every((s) => s.removed)).toBe(true);
    h.slice.apply(shown);
    expect(setOf(h)?.revision).toBe(shown.revision + 5);
  });

  test("a discarded set is dropped at once and read again (the avatar's newest used set, if any, takes its place)", async () => {
    const h = await started({ sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-seed-0001", count: 3, written: 3 }] });
    h.slice.retain(MIA.avatarId);
    await settle();
    const reads = callsOf(h.engine, "scenes.get").length;
    await h.client.request("scenes.discard", { sceneSetId: "set-seed-0001" });
    await settle();
    expect(setOf(h)).toBe(null);
    expect(callsOf(h.engine, "scenes.get").length).toBe(reads + 1);
  });

  test("a snapshot taken again reads the set again", async () => {
    const h = await started({ sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-seed-0001", count: 3, written: 3 }] });
    h.slice.retain(MIA.avatarId);
    await settle();
    const reads = callsOf(h.engine, "scenes.get").length;
    h.engine.restart();
    h.store.reconnect();
    await settle();
    expect(callsOf(h.engine, "scenes.get").length).toBe(reads + 1);
  });
});

describe("a reconcile", () => {
  test("reads the set again, and remembers the open reserve it saw closed", async () => {
    const h = await started({ sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-cut-0001", count: 60, written: 25, stopped: "closed", cutOff: { chunk: 2 } }] });
    h.slice.retain(MIA.avatarId);
    await settle();
    expect(setOf(h)?.openReserveMicros).toBe(ATTEMPT);
    expect(h.slice.getView().reconciled.get("set-cut-0001")).toBe(undefined);
    await h.client.request("money.reconcile", {});
    await settle();
    expect(setOf(h)?.openReserveMicros).toBe(0);
    expect(h.slice.getView().reconciled.get("set-cut-0001")).toBe(ATTEMPT);
  });

  test("a window that never saw the reserve open remembers nothing", async () => {
    const h = await started({ sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-cut-0001", count: 60, written: 25, stopped: "closed", cutOff: { chunk: 2 } }] });
    await h.client.request("money.reconcile", {});
    h.slice.retain(MIA.avatarId);
    await settle();
    expect(h.slice.getView().reconciled.get("set-cut-0001")).toBe(undefined);
  });
});

describe("what only this window knows", () => {
  test("the price it accepted for a job it started, and the scenes its own rewrite replaced", async () => {
    const h = await started({ sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-seed-0001", count: 3, written: 3 }] });
    h.slice.retain(MIA.avatarId);
    await settle();
    const price = { expectedMicros: 2_000, worstMicros: 2 * ATTEMPT, prices: "fallback" as const, pricesAsOf: "2026-10-01" };
    const reply = await h.client.request("scenes.write", { sceneSetId: "set-seed-0001", revision: 1, target: { kind: "rewrite", sceneIds: [2], redraw: true }, acceptedWorstMicros: 2 * ATTEMPT });
    if (!reply.ok) throw new Error(reply.error.code);
    h.slice.trackJob(reply.result.jobId, { sceneSetId: "set-seed-0001", kind: "rewrite", price, sceneIds: [2], idea: null });
    expect(h.slice.getView().jobs.get(reply.result.jobId)?.price).toEqual(price);
    expect(h.slice.getView().fresh.get("set-seed-0001") === undefined).toBe(true);
    h.scheduler.runAll();
    await settle();
    expect([...(h.slice.getView().fresh.get("set-seed-0001") ?? [])]).toEqual([2]);
  });

  test("a rewrite that fails marks nothing new", async () => {
    const h = await started({ sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-seed-0001", count: 3, written: 3 }] });
    h.slice.retain(MIA.avatarId);
    await settle();
    h.engine.failNextSceneAttempt("refused");
    const reply = await h.client.request("scenes.write", { sceneSetId: "set-seed-0001", revision: 1, target: { kind: "rewrite", sceneIds: [2], redraw: true }, acceptedWorstMicros: 2 * ATTEMPT });
    if (!reply.ok) throw new Error(reply.error.code);
    h.slice.trackJob(reply.result.jobId, { sceneSetId: "set-seed-0001", kind: "rewrite", price: null, sceneIds: [2], idea: null });
    h.scheduler.runAll();
    await settle();
    expect(h.slice.getView().fresh.get("set-seed-0001") === undefined).toBe(true);
  });

  test("a «Готово … не составлены» dismissed stays dismissed for that set", async () => {
    const h = await started();
    h.slice.dismissGaveUp("set-seed-0001");
    expect(h.slice.getView().dismissed.has("set-seed-0001")).toBe(true);
  });
});

describe("the focus asked for a job's «Отменить» (CS.7)", () => {
  const PRICE = { expectedMicros: 2_000, worstMicros: 2 * ATTEMPT, prices: "fallback" as const, pricesAsOf: "2026-10-01" };

  /** A rewrite of scene 2 sent; its answer is in hand, but the screen has not handled it yet. */
  async function rewriteSent(h: Harness): Promise<string> {
    h.slice.retain(MIA.avatarId);
    await settle();
    const reply = await h.client.request("scenes.write", { sceneSetId: "set-seed-0001", revision: 1, target: { kind: "rewrite", sceneIds: [2], redraw: true }, acceptedWorstMicros: 2 * ATTEMPT });
    if (!reply.ok) throw new Error(reply.error.code);
    return reply.result.jobId;
  }

  /** What the screen does with the answer (usePaidAction's onSent): the store and the slice learn of the job, and the focus is asked for. */
  function handleAnswer(h: Harness, jobId: string): void {
    h.store.trackScenesJob(jobId, "set-seed-0001", MIA.avatarId, 1);
    h.slice.trackJob(jobId, { sceneSetId: "set-seed-0001", kind: "rewrite", price: PRICE, sceneIds: [2], idea: null });
    h.slice.requestCancelFocus(jobId);
  }

  test("a job.cancelled heard before the write's answer is handled: no request is kept for it, so no later «Отменить» takes the focus", async () => {
    const h = await started({ sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-seed-0001", count: 3, written: 3 }] });
    const jobId = await rewriteSent(h);
    // The order the window hears them in: the cancel (another window's, say) and its job.cancelled first, the answer's handling after.
    const cancel = await h.client.request("scenes.cancel", { sceneSetId: "set-seed-0001" });
    if (!cancel.ok) throw new Error(cancel.error.code);
    h.scheduler.runAll();
    await settle();
    expect(h.store.getView().jobs.find((j) => j.jobId === jobId)?.status).toBe("cancelled");
    handleAnswer(h, jobId);
    expect(h.slice.getView().cancelFocus.has(jobId)).toBe(false);
  });

  test("a request still waiting when its job ends is dropped with it", async () => {
    const h = await started({ sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-seed-0001", count: 3, written: 3 }] });
    const jobId = await rewriteSent(h);
    handleAnswer(h, jobId);
    expect(h.slice.getView().cancelFocus.has(jobId)).toBe(true);
    const cancel = await h.client.request("scenes.cancel", { sceneSetId: "set-seed-0001" });
    if (!cancel.ok) throw new Error(cancel.error.code);
    h.scheduler.runAll();
    await settle();
    expect(h.store.getView().jobs.find((j) => j.jobId === jobId)?.status).toBe("cancelled");
    expect(h.slice.getView().cancelFocus.has(jobId)).toBe(false);
  });
});
