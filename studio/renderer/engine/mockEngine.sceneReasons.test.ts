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
const estimateRun = (m: Mock, view: SceneSetView) => m.client.request("runs.estimateFromScenes", { sceneSetId: view.sceneSetId, revision: view.revision } as never);

async function ready(m: Mock, count = 4): Promise<SceneSetView> {
  await unwrap(compose(m, count));
  m.scheduler.runAll();
  return setOf(m);
}


describe("compose and «Дописать»", () => {
  test("a second compose while the avatar has an open set: open-set", async () => {
    const m = makeMock();
    await ready(m);
    expect(await refusalOf(compose(m))).toEqual(["VALIDATION", "open-set", undefined]);
  });

});

describe("an approval", () => {
  test("an active scene with no text: scene-without-text, naming the first", async () => {
    const m = makeMock({ sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-seed-0001", count: 5, written: 0 }] });
    expect(await refusalOf(estimateRun(m, await setOf(m)))).toEqual(["VALIDATION", "scene-without-text", 1]);
  });

});

// S5.BA9 r2 (AGE): the mock reads the same content line as the engine (engine/scenes/minorAge.paths.test.ts), so an explicit minor age is refused in the owner's edit and at the approval.
describe("an explicit minor age (S5.BA9 r2)", () => {
  const MINOR = "She is 17 and sips coffee on her sunny balcony, one hand on the railing.";

  test("the owner's edit of a scene: a youth-word problem naming the age, and nothing changed", async () => {
    const m = makeMock();
    const view = await ready(m);
    const result = await unwrap(m.client.request("scenes.edit", { sceneSetId: view.sceneSetId, revision: view.revision, op: { op: "text", sceneId: 1, text: MINOR } }));
    expect("problem" in result ? result.problem : null).toEqual({ reason: "youth-word", words: ["17"] });
  });

  test("the approval of an own scene stored with one: scene-text-problem, naming it", async () => {
    const m = makeMock({
      sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-seed-0001", count: 1, written: 1, scenes: [{ idea: "кофе на балконе", shot: "friend", pose: "front", text: MINOR }] }],
    });
    expect(await refusalOf(estimateRun(m, await setOf(m)))).toEqual(["VALIDATION", "scene-text-problem", 1]);
  });
});
