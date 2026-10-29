import { describe, expect, test } from "bun:test";
import type { AvatarSummary, SceneSetView } from "../../shared/engine";
import { LLM_ONLY_CATEGORY_RECORD, LLM_ONLY_REF } from "../../engine/scenes/testing/llmOnlyFixture";
import { DEFAULT_TRAITS } from "../lib/traits";
import { MockEngine, mockDescriptor, mockEngineClient } from "./mockEngine";
import { ManualScheduler } from "./scheduler";

// 5a.2 (S5.6e, m11): a built-in scene is written by the code template, so a set whose scenes wait for the WRITER (a cut-off request, a chunk given up on) is a set of `cat-llm-only-fixture` scenes.
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

const FIXTURE = { ...LLM_ONLY_CATEGORY_RECORD, createdAt: "2026-10-05T10:00:00.000Z", updatedAt: "2026-10-05T10:00:00.000Z" };

function makeMock(options: ConstructorParameters<typeof MockEngine>[0] = {}) {
  const scheduler = new ManualScheduler();
  const engine = new MockEngine({ scheduler, avatars: [MIA], categories: [FIXTURE], ...options });
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

  test("after the reconcile the reserve is closed at its worst: still spent, no longer open, still an answered attempt", async () => {
    const m = makeMock({ sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-cut-0001", count: 60, written: 25, stopped: "closed", cutOff: { chunk: 2 }, categories: [LLM_ONLY_REF] }] });
    const before = await setOf(m);
    const done = await m.client.request("money.reconcile", {});
    expect(done.ok).toBe(true);
    const after = await setOf(m);
    expect(after.openReserveMicros).toBe(0);
    expect(after.spentMicros).toBe(before.spentMicros);
    expect(after.chunks.map((c) => c.attemptsLeft)).toEqual([1, 1, 2]);
    expect(await reconcileNeeded(m)).toBe(false);
  });

});

