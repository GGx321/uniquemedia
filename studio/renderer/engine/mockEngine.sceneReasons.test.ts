import { describe, expect, test } from "bun:test";
import type { AvatarSummary, EngineError, EventMessage, SceneReason, SceneSetView } from "../../shared/engine";
import { DEFAULT_TRAITS } from "../lib/traits";
import { MockEngine, mockDescriptor, mockEngineClient } from "./mockEngine";
import { ManualScheduler } from "./scheduler";

// CS.7: the mock refuses a scene-set command with the same closed `sceneReason` (and the same scene) as the engine (engine/sceneSets/reasons.test.ts), so a
// window built against the mock reads the reasons it will meet in the product.

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
type Reply<T> = Promise<{ ok: true; result: T } | { ok: false; error: EngineError }>;

async function unwrap<T>(reply: Reply<T>): Promise<T> {
  const r = await reply;
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`);
  return r.result;
}

/** The refusal: its code, scene reason and scene. */
async function refusalOf<T>(reply: Reply<T>): Promise<[string, SceneReason | undefined, number | undefined]> {
  const r = await reply;
  if (r.ok) throw new Error("expected an error");
  return [r.error.code, r.error.sceneReason, r.error.sceneId];
}

async function setOf(m: Mock): Promise<SceneSetView> {
  const { sceneSet } = await unwrap(m.client.request("scenes.get", { avatarId: MIA.avatarId }));
  if (sceneSet === null) throw new Error("no set");
  return sceneSet;
}

const compose = (m: Mock, count = 4) => m.client.request("scenes.compose", { avatarId: MIA.avatarId, count, categories: ["home"], poses: POSES, acceptedWorstMicros: Math.ceil(count / 25) * 2 * ATTEMPT } as never);
const edit = (m: Mock, view: SceneSetView, op: unknown) => m.client.request("scenes.edit", { sceneSetId: view.sceneSetId, revision: view.revision, op } as never);
const write = (m: Mock, view: SceneSetView, target: unknown) => m.client.request("scenes.write", { sceneSetId: view.sceneSetId, revision: view.revision, target, acceptedWorstMicros: 2 * ATTEMPT } as never);
const estimate = (m: Mock, view: SceneSetView, target: unknown) => m.client.request("scenes.estimateWrite", { sceneSetId: view.sceneSetId, target } as never);
const estimateRun = (m: Mock, view: SceneSetView) => m.client.request("runs.estimateFromScenes", { sceneSetId: view.sceneSetId, revision: view.revision } as never);

async function ready(m: Mock, count = 4): Promise<SceneSetView> {
  await unwrap(compose(m, count));
  m.scheduler.runAll();
  return setOf(m);
}

const rewrite = (sceneIds: number[], redraw = false) => ({ kind: "rewrite", sceneIds, redraw });
const idea = (text: string, count = 1) => ({ kind: "idea", idea: text, count, shot: null });

describe("compose and «Дописать»", () => {
  test("a second compose while the avatar has an open set: open-set", async () => {
    const m = makeMock();
    await ready(m);
    expect(await refusalOf(compose(m))).toEqual(["VALIDATION", "open-set", undefined]);
  });

  test("a write when nothing is waiting: nothing-waiting", async () => {
    const m = makeMock();
    const view = await ready(m);
    expect(await refusalOf(write(m, view, { kind: "unwritten" }))).toEqual(["VALIDATION", "nothing-waiting", undefined]);
  });

  test("a write to a used set: set-used", async () => {
    const m = makeMock();
    const view = await ready(m);
    m.engine.markSceneSetUsed(view.sceneSetId);
    expect(await refusalOf(write(m, view, { kind: "unwritten" }))).toEqual(["VALIDATION", "set-used", undefined]);
    expect(await refusalOf(write(m, view, rewrite([1])))).toEqual(["VALIDATION", "set-used", undefined]);
  });
});

describe("free edits", () => {
  test("a text for a scene the set lacks: scene-missing, naming it", async () => {
    const m = makeMock();
    const view = await ready(m);
    expect(await refusalOf(edit(m, view, { op: "text", sceneId: 99, text: "Typed." }))).toEqual(["VALIDATION", "scene-missing", 99]);
  });

  test("a text for a removed scene: target-removed, naming it", async () => {
    const m = makeMock();
    const view = await ready(m);
    await unwrap(edit(m, view, { op: "remove", sceneIds: [2] }));
    const fresh = await setOf(m);
    expect(await refusalOf(edit(m, fresh, { op: "text", sceneId: 2, text: "Typed." }))).toEqual(["VALIDATION", "target-removed", 2]);
  });

  test("a removal or restore naming scenes the set lacks: scene-missing, naming the first", async () => {
    const m = makeMock();
    const view = await ready(m);
    expect(await refusalOf(edit(m, view, { op: "remove", sceneIds: [1, 98, 99] }))).toEqual(["VALIDATION", "scene-missing", 98]);
    expect(await refusalOf(edit(m, view, { op: "restore", sceneIds: [99] }))).toEqual(["VALIDATION", "scene-missing", 99]);
  });

  test("an edit of a used set: set-used", async () => {
    const m = makeMock();
    const view = await ready(m);
    m.engine.markSceneSetUsed(view.sceneSetId);
    expect(await refusalOf(edit(m, view, { op: "remove", sceneIds: [1] }))).toEqual(["VALIDATION", "set-used", undefined]);
  });

  test("dismissing a write the set does not have: no-open-write; a scene without one: nothing-to-dismiss; a scene the set lacks: scene-missing", async () => {
    const m = makeMock({ sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-seed-0001", count: 4, written: 4, writes: 2, reviewWrites: [{ kind: "rewrite", k: 2, sceneIds: [2], stoppedBy: "network" }] }] });
    const view = await setOf(m);
    expect(await refusalOf(edit(m, view, { op: "dismissInterrupted", write: 9 }))).toEqual(["VALIDATION", "no-open-write", undefined]);
    expect(await refusalOf(edit(m, view, { op: "dismissInterrupted", sceneIds: [2, 4] }))).toEqual(["VALIDATION", "nothing-to-dismiss", undefined]);
    expect(await refusalOf(edit(m, view, { op: "dismissInterrupted", sceneIds: [99] }))).toEqual(["VALIDATION", "scene-missing", 99]);
  });
});

describe("review writes", () => {
  test("a scene the set lacks, or has removed: scene-missing, target-removed (the estimate and the write alike)", async () => {
    const m = makeMock();
    const view = await ready(m);
    await unwrap(edit(m, view, { op: "remove", sceneIds: [4] }));
    const fresh = await setOf(m);
    expect(await refusalOf(estimate(m, fresh, rewrite([99])))).toEqual(["VALIDATION", "scene-missing", 99]);
    expect(await refusalOf(estimate(m, fresh, rewrite([4])))).toEqual(["VALIDATION", "target-removed", 4]);
    expect(await refusalOf(write(m, fresh, rewrite([4])))).toEqual(["VALIDATION", "target-removed", 4]);
  });

  test("planned and own scenes together: mixed-kinds; a redraw of an own scene: own-redraw", async () => {
    const m = makeMock();
    let view = await ready(m);
    await unwrap(write(m, view, idea("кофе")));
    m.scheduler.runAll();
    view = await setOf(m);
    const own = view.scenes.find((s) => s.origin === "own");
    if (own === undefined) throw new Error("expected an own scene");
    expect(await refusalOf(estimate(m, view, rewrite([1, own.sceneId])))).toEqual(["VALIDATION", "mixed-kinds", undefined]);
    expect(await refusalOf(estimate(m, view, rewrite([own.sceneId], true)))).toEqual(["VALIDATION", "own-redraw", undefined]);
  });

  test("a resume of a write the set does not have: no-open-write", async () => {
    const m = makeMock();
    const view = await ready(m);
    expect(await refusalOf(estimate(m, view, { kind: "resume", write: 9 }))).toEqual(["VALIDATION", "no-open-write", undefined]);
  });

  test("a resume of a rewrite whose every scene is removed: target-removed", async () => {
    const m = makeMock({ sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-seed-0001", count: 4, written: 4, writes: 2, reviewWrites: [{ kind: "rewrite", k: 2, sceneIds: [2], stoppedBy: "network" }] }] });
    const view = await setOf(m);
    await unwrap(edit(m, view, { op: "remove", sceneIds: [2] }));
    expect(await refusalOf(estimate(m, await setOf(m), { kind: "resume", write: 2 }))).toEqual(["VALIDATION", "target-removed", undefined]);
  });

  test("a set that already records 500 writes: write-record-cap", async () => {
    const records = Array.from({ length: 500 }, (_, i) => ({ kind: "rewrite" as const, k: i + 1, sceneIds: [1], stoppedBy: "network" as const }));
    const m = makeMock({ sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-seed-0001", count: 4, written: 4, reviewWrites: records }] });
    const view = await setOf(m);
    expect(await refusalOf(estimate(m, view, rewrite([2])))).toEqual(["VALIDATION", "write-record-cap", undefined]);
  });

  test("an idea that would not fit in the set: idea-room", async () => {
    const scenes = Array.from({ length: 199 }, (_, i) => ({ idea: `idea ${i}`, shot: "friend" as const, pose: "front" as const, text: `She waits (${i}).` }));
    const m = makeMock({ sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-seed-0001", count: 199, scenes }] });
    const view = await setOf(m);
    expect(await refusalOf(estimate(m, view, idea("кофе", 2)))).toEqual(["VALIDATION", "idea-room", undefined]);
  });
});

describe("an approval", () => {
  test("an active scene with no text: scene-without-text, naming the first", async () => {
    const m = makeMock({ sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-seed-0001", count: 5, written: 0 }] });
    expect(await refusalOf(estimateRun(m, await setOf(m)))).toEqual(["VALIDATION", "scene-without-text", 1]);
  });

  test("every scene removed: no-active-scenes", async () => {
    const m = makeMock();
    const view = await ready(m, 2);
    await unwrap(edit(m, view, { op: "remove", sceneIds: [1, 2] }));
    expect(await refusalOf(estimateRun(m, await setOf(m)))).toEqual(["VALIDATION", "no-active-scenes", undefined]);
  });

  test("101 active scenes: too-many-active", async () => {
    const scenes = Array.from({ length: 101 }, (_, i) => ({ idea: `idea ${i}`, shot: "friend" as const, pose: "front" as const, text: `She waits (${i}).` }));
    const m = makeMock({ sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-seed-0001", count: 101, scenes }] });
    expect(await refusalOf(estimateRun(m, await setOf(m)))).toEqual(["VALIDATION", "too-many-active", undefined]);
  });

  test("a text that breaks today's word rules: scene-text-problem, naming the scene", async () => {
    const scenes = [
      { idea: "a", shot: "friend" as const, pose: "front" as const, text: "She waits at the window." },
      { idea: "b", shot: "friend" as const, pose: "front" as const, text: "A teenage girl in a bikini." },
    ];
    const m = makeMock({ sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-seed-0001", count: 2, scenes }] });
    expect(await refusalOf(estimateRun(m, await setOf(m)))).toEqual(["VALIDATION", "scene-text-problem", 2]);
  });

  test("a set already used: set-used", async () => {
    const m = makeMock();
    const view = await ready(m);
    m.engine.markSceneSetUsed(view.sceneSetId);
    expect(await refusalOf(estimateRun(m, view))).toEqual(["VALIDATION", "set-used", undefined]);
  });

  test("a moved revision is SCENES_CHANGED with no scene reason", async () => {
    const m = makeMock();
    const view = await ready(m);
    expect(await refusalOf(m.client.request("runs.estimateFromScenes", { sceneSetId: view.sceneSetId, revision: view.revision + 1 } as never))).toEqual(["SCENES_CHANGED", undefined, undefined]);
  });
});
