import { describe, expect, test } from "bun:test";
import type { AvatarSummary, SceneSetView } from "../../shared/engine";
import { DEFAULT_TRAITS } from "../lib/traits";
import { MockEngine, mockDescriptor, mockEngineClient } from "./mockEngine";
import { ManualScheduler } from "./scheduler";

// CS.6: what the review UI's screen tests and shots need the mock to stand in for. A Studio that closed mid-request leaves that request's reserve open
// (it counts as an answered attempt and waits for the reconcile) and no outcome (the set reads `closed`): a seed says which request it cut off. And an
// explicitly good answer can be scripted, so a test can give up on a LATER chunk than the first.

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

function makeMock(options: ConstructorParameters<typeof MockEngine>[0] = {}) {
  const scheduler = new ManualScheduler();
  const engine = new MockEngine({ scheduler, avatars: [MIA], ...options });
  const client = mockEngineClient(engine);
  return { scheduler, engine, client };
}
type Mock = ReturnType<typeof makeMock>;

async function setOf(m: Mock): Promise<SceneSetView> {
  const reply = await m.client.request("scenes.get", { avatarId: MIA.avatarId });
  if (!reply.ok || reply.result.sceneSet === null) throw new Error("no set");
  return reply.result.sceneSet;
}

async function reconcileNeeded(m: Mock): Promise<boolean> {
  const reply = await m.client.request("engine.snapshot", {});
  if (!reply.ok) throw new Error("no snapshot");
  return reply.result.money.reconcileNeeded;
}

describe("a seeded set whose request the closed Studio cut off", () => {
  test("reads stopped and closed, holds that request's reserve open at its worst, and leaves that chunk one attempt (the written first chunk answered once)", async () => {
    const m = makeMock({ sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-cut-0001", count: 60, written: 25, stopped: "closed", cutOff: { chunk: 2 } }] });
    const set = await setOf(m);
    expect(set.status).toBe("stopped");
    expect(set.stoppedBy).toBe("closed");
    expect(set.openReserveMicros).toBe(ATTEMPT);
    expect((set.spentMicros ?? 0) - ATTEMPT).toBeGreaterThan(0);
    expect(set.chunks.map((c) => c.attemptsLeft)).toEqual([1, 1, 2]);
    expect(await reconcileNeeded(m)).toBe(true);
    // «Дописать»: the cut-off chunk at its one attempt, the third at two.
    const price = await m.client.request("scenes.estimateWrite", { sceneSetId: set.sceneSetId, target: { kind: "unwritten" } });
    expect(price.ok && price.result.estimate.worstMicros).toBe(ATTEMPT + 2 * ATTEMPT);
  });

  test("after the reconcile the reserve is closed at its worst: still spent, no longer open, still an answered attempt", async () => {
    const m = makeMock({ sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-cut-0001", count: 60, written: 25, stopped: "closed", cutOff: { chunk: 2 } }] });
    const before = await setOf(m);
    const done = await m.client.request("money.reconcile", {});
    expect(done.ok).toBe(true);
    const after = await setOf(m);
    expect(after.openReserveMicros).toBe(0);
    expect(after.spentMicros).toBe(before.spentMicros);
    expect(after.chunks.map((c) => c.attemptsLeft)).toEqual([1, 1, 2]);
    expect(await reconcileNeeded(m)).toBe(false);
  });

  test("a cut-off rewrite marks its scene, and carrying it on is priced at the one attempt it has left", async () => {
    const m = makeMock({
      sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-cut-0002", count: 6, written: 6, writes: 1, reviewWrites: [{ kind: "rewrite", k: 2, sceneIds: [2], redraw: true, cutOff: true }] }],
    });
    const set = await setOf(m);
    expect(set.status).toBe("ready");
    expect(set.scenes.find((s) => s.sceneId === 2)?.rewriteInterrupted).toEqual({ write: 2, stoppedBy: "closed" });
    expect(set.openReserveMicros).toBe(ATTEMPT);
    const price = await m.client.request("scenes.estimateWrite", { sceneSetId: set.sceneSetId, target: { kind: "resume", write: 2 } });
    expect(price.ok && price.result.estimate.worstMicros).toBe(ATTEMPT);
    expect(await reconcileNeeded(m)).toBe(true);
  });

  test("a cut-off idea write is listed with the one attempt it has left", async () => {
    const m = makeMock({
      sceneSets: [
        {
          avatarId: MIA.avatarId,
          sceneSetId: "set-cut-0003",
          count: 3,
          written: 3,
          writes: 1,
          reviewWrites: [{ kind: "idea", k: 2, idea: "Утренний кофе на балконе", count: 2, shot: null, sceneIds: [4, 5], cutOff: true }],
        },
      ],
    });
    const set = await setOf(m);
    expect(set.interruptedIdeas).toEqual([{ write: 2, idea: "Утренний кофе на балконе", count: 2, shot: null, stoppedBy: "closed" }]);
    const price = await m.client.request("scenes.estimateWrite", { sceneSetId: set.sceneSetId, target: { kind: "resume", write: 2 } });
    expect(price.ok && price.result.estimate.worstMicros).toBe(ATTEMPT);
  });
});

describe("a scripted good answer", () => {
  test("lets the first chunk through so the second is the one given up on", async () => {
    const m = makeMock();
    m.engine.failNextSceneAttempt("ok");
    m.engine.failNextSceneAttempt("rejected");
    m.engine.failNextSceneAttempt("rejected");
    const reply = await m.client.request("scenes.compose", { avatarId: MIA.avatarId, count: 60, categories: ["home"], poses: { profile: false, back: false }, acceptedWorstMicros: 6 * ATTEMPT });
    expect(reply.ok).toBe(true);
    m.scheduler.runAll();
    const set = await setOf(m);
    expect(set.status).toBe("ready");
    expect(set.chunks.map((c) => c.gaveUpBy)).toEqual([null, "rejected", null]);
    expect(set.lastCompose).toEqual({ total: 60, written: 35, gaveUp: 25 });
  });
});
