import { describe, expect, test } from "bun:test";
import { type AvatarSummary, type CategorySummary, type EventMessage, type SceneSetView } from "../../shared/engine";
import { DEFAULT_TRAITS } from "../lib/traits";
import { MockEngine, mockDescriptor, mockEngineClient } from "./mockEngine";
import { ManualScheduler } from "./scheduler";

// CS.8a: the angles a category's description asks for, in the mock. A pool is made from the description alone, so «Вид сзади» gives `poses: ["back"]` and
// «Лежит на животе» gives activities in that body position; the scenes of such a category draw their pose from the list (the run's «Ракурсы» are not asked),
// a back or profile scene never holds a phone, and an idea written on «Авто» takes its angle from the idea. All of it through the validating client the
// renderer uses.

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

const CANARY = "Лежит на животе в домашних шортиках и топике. Вид сзади";
const ATTEMPT = 37_500;
const POOL_WORST = 45_000;
const OFF = { profile: false, back: false };

function makeMock() {
  const scheduler = new ManualScheduler();
  const engine = new MockEngine({ scheduler, avatars: [MIA] });
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

async function createCategory(m: Mock, description: string, name = "Лежит дома"): Promise<CategorySummary> {
  return (await unwrap(m.client.request("categories.create", { name, description, acceptedWorstMicros: POOL_WORST }))).category;
}

async function composed(m: Mock, count: number, categories: string[], poses = OFF): Promise<SceneSetView> {
  await unwrap(m.client.request("scenes.compose", { avatarId: MIA.avatarId, count, categories, poses, acceptedWorstMicros: Math.ceil(count / 25) * 2 * ATTEMPT } as never));
  m.scheduler.runAll();
  return setOf(m);
}
async function setOf(m: Mock): Promise<SceneSetView> {
  const { sceneSet } = await unwrap(m.client.request("scenes.get", { avatarId: MIA.avatarId }));
  if (sceneSet === null) throw new Error("no set");
  return sceneSet;
}
type Target = { kind: "rewrite"; sceneIds: number[]; redraw: boolean } | { kind: "idea"; idea: string; count: number; shot: string | null };
async function writeAndRun(m: Mock, view: SceneSetView, target: Target): Promise<SceneSetView> {
  await unwrap(m.client.request("scenes.write", { sceneSetId: view.sceneSetId, revision: view.revision, target, acceptedWorstMicros: 2 * ATTEMPT } as never));
  m.scheduler.runAll();
  return setOf(m);
}

const phone = (shot: string): boolean => shot === "selfie" || shot === "mirror";

describe("categories.create and categories.regenerate", () => {
  test("a created category carries the angles of its description", async () => {
    const m = makeMock();
    const category = await createCategory(m, CANARY);
    expect(category.pool.poses).toEqual(["back"]);
    expect((await unwrap(m.client.request("categories.list", {}))).categories[0]?.pool.poses).toEqual(["back"]);
  });

});

describe("categories.update: the category's angles", () => {
  test("sets them and announces the change, free", async () => {
    const m = makeMock();
    const category = await createCategory(m, "кофейни");
    const spent = (await unwrap(m.client.request("money.status", {}))) as { spentMicros?: number };

    const { category: updated } = await unwrap(m.client.request("categories.update", { categoryId: category.categoryId, poses: ["back", "profile"] }));

    expect(updated.pool.poses).toEqual(["back", "profile"]);
    expect(m.events.filter((e) => e.type === "category.changed")).toHaveLength(2);
    expect(((await unwrap(m.client.request("money.status", {}))) as { spentMicros?: number }).spentMicros).toBe(spent.spentMicros);
  });

});

describe("scenes.compose with a category that has poses", () => {
  test("every scene of a [back] category is from behind with a shot nobody holds a phone for, although the run's «Ракурсы» are off", async () => {
    const m = makeMock();
    const category = await createCategory(m, CANARY);
    const view = await composed(m, 12, [category.categoryId]);
    expect(view.scenes).toHaveLength(12);
    expect(view.scenes.every((s) => s.pose === "back" && !phone(s.shot))).toBe(true);
  });

});

describe("scenes.write: an idea, the angle from the idea", () => {
  async function readySet(m: Mock): Promise<SceneSetView> {
    return composed(m, 4, ["home"]);
  }

  test("«Авто» with «вид сзади» gives scenes from behind with a shot nobody holds a phone for, the run's toggles off", async () => {
    const m = makeMock();
    const after = await writeAndRun(m, await readySet(m), { kind: "idea", idea: CANARY, count: 3, shot: null });
    const own = after.scenes.filter((s) => s.origin === "own");
    expect(own).toHaveLength(3);
    expect(own.every((s) => s.pose === "back" && s.shot === "candid")).toBe(true);
  });

});
