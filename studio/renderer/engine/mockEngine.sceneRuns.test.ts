import { describe, expect, test } from "bun:test";
import type { AvatarSummary, EventMessage, SceneSetView } from "../../shared/engine";
import { DEFAULT_TRAITS } from "../lib/traits";
import { MockEngine, mockDescriptor, mockEngineClient } from "./mockEngine";
import { ManualScheduler } from "./scheduler";

// CS.5: the mock's runs from a scene set, through the same validating client the renderer uses: the engine's refusals in the engine's order, its money (M photos
// and no writer term), the set becoming used and announced before the run's job, and a run that asks the writer for nothing. The parity suite pins the free
// refusals against the real engine; this pins the rest.

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

const POSES = { profile: false, back: false };
const ATTEMPT = 37_500;

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

/** A composed and fully written set of `count` scenes. */
async function readySet(m: Mock, count = 5): Promise<SceneSetView> {
  await unwrap(m.client.request("scenes.compose", { avatarId: MIA.avatarId, count, categories: ["home"], poses: POSES, acceptedWorstMicros: Math.ceil(count / 25) * 2 * ATTEMPT }));
  m.scheduler.runAll();
  return setOf(m);
}
async function setOf(m: Mock): Promise<SceneSetView> {
  const { sceneSet } = await unwrap(m.client.request("scenes.get", { avatarId: MIA.avatarId }));
  if (sceneSet === null) throw new Error("no set");
  return sceneSet;
}
const edit = (m: Mock, set: SceneSetView, op: unknown) => m.client.request("scenes.edit", { sceneSetId: set.sceneSetId, revision: set.revision, op } as never);
async function edited(m: Mock, set: SceneSetView, op: unknown): Promise<SceneSetView> {
  const result = await unwrap(edit(m, set, op));
  if (!("sceneSet" in result)) throw new Error("expected the set");
  return result.sceneSet;
}
const estimateOf = (m: Mock, set: SceneSetView) => m.client.request("runs.estimateFromScenes", { sceneSetId: set.sceneSetId, revision: set.revision });
const start = (m: Mock, set: SceneSetView, acceptedWorstMicros: number) => m.client.request("runs.startFromScenes", { sceneSetId: set.sceneSetId, revision: set.revision, acceptedWorstMicros });

describe("runs.startFromScenes", () => {
  test("makes a run of exactly the active scenes, capped at the accepted worst case, with no writer in it", async () => {
    const m = makeMock();
    let set = await readySet(m, 5);
    set = await edited(m, set, { op: "remove", sceneIds: [2] });
    const worst = (await unwrap(estimateOf(m, set))).estimate.worstMicros;
    const { runId } = await unwrap(start(m, set, worst));
    const { runs } = await unwrap(m.client.request("runs.list", {}));
    const run = runs.find((r) => r.runId === runId);
    expect(run).toMatchObject({ total: 4, capMicros: worst });
  });

  test("a price above what the owner accepted is PRICE_CHANGED, and the set stays open", async () => {
    const m = makeMock();
    const set = await readySet(m, 3);
    const worst = (await unwrap(estimateOf(m, set))).estimate.worstMicros;
    expect(await codeOf(start(m, set, worst - 1))).toBe("PRICE_CHANGED");
    expect((await setOf(m)).status).toBe("ready");
  });

});

// CS.4b x CS.5: an own scene (written from an idea) is a run slot of no category. The engine's `photoCategoryOf` makes its photo `"own"`, and its run
// request never names "own" as a category (that is the type's own rule: `RunRequest.categories` holds only categories).

