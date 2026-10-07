import { describe, expect, test } from "bun:test";
import { CategoryPool, POOL_TEXT_MAX, type AvatarSummary, type CategorySummary, type EventMessage, type ScenePose, type SceneSetView } from "../../shared/engine";
import { DEFAULT_TRAITS } from "../lib/traits";
import { mockCategoryPool } from "./mockCategories";
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
async function codeOf<T>(reply: Reply<T>): Promise<string> {
  const r = await reply;
  if (r.ok) throw new Error("expected an error");
  return r.error.code;
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

describe("the pool the mock makes from a description", () => {
  test("the paid canary's description («Лежит на животе… Вид сзади») gives poses [back] and activities in that body position", () => {
    const { pool } = mockCategoryPool("Лежит дома", CANARY);
    expect(pool.poses).toEqual(["back"]);
    const activities = pool.locations.flatMap((l) => l.activities.map((a) => a.text));
    expect(activities.length).toBeGreaterThan(0);
    expect(activities.every((text) => text.startsWith("lying on her stomach, "))).toBe(true);
  });

  test("every activity of it fits the 35 characters, and the pool passes the contract", () => {
    const { pool } = mockCategoryPool("Лежит дома", CANARY);
    for (const place of pool.locations) for (const a of place.activities) expect(a.text.length).toBeLessThanOrEqual(POOL_TEXT_MAX);
    expect(CategoryPool.safeParse(pool).success).toBe(true);
  });

  test("every place keeps a one-handed activity and two distinct activities, as the contract wants", () => {
    const { pool } = mockCategoryPool("Лежит дома", CANARY);
    for (const place of pool.locations) {
      expect(new Set(place.activities.map((a) => a.text)).size).toBe(place.activities.length);
      expect(place.activities.some((a) => !a.twoHanded)).toBe(true);
    }
  });

  test.each<[string, ScenePose[]]>([
    ["Вид сзади", ["back"]],
    ["фото со спины, вид сзади", ["back"]],
    ["lying down, back view", ["back"]],
    ["shot from behind", ["back"]],
    ["в профиль у окна", ["profile"]],
    ["side profile portraits", ["profile"]],
    ["вид сзади и в профиль", ["profile", "back"]],
    ["анфас, лицом к камере", ["front"]],
    ["в три четверти", ["three-quarter"]],
    ["вид спереди и вид сзади", ["front", "back"]],
  ])("«%s» gives the angles %p, in the vocabulary's order", (description, poses) => {
    expect(mockCategoryPool("Name", description).pool.poses).toEqual(poses);
  });

  test("a description with no angle gives a pool without the key", () => {
    const { pool } = mockCategoryPool("Name", "Парижские кофейни и булочные");
    expect("poses" in pool).toBe(false);
  });

  test("a description with no body position keeps the activities the places always had", () => {
    const plain = mockCategoryPool("Name", "Парижские кофейни и булочные").pool;
    expect(plain.locations.flatMap((l) => l.activities.map((a) => a.text)).some((text) => text.startsWith("lying"))).toBe(false);
  });

  test("it is deterministic: the same description gives the same pool", () => {
    expect(mockCategoryPool("Name", CANARY)).toEqual(mockCategoryPool("Name", CANARY));
  });
});

describe("categories.create and categories.regenerate", () => {
  test("a created category carries the angles of its description", async () => {
    const m = makeMock();
    const category = await createCategory(m, CANARY);
    expect(category.pool.poses).toEqual(["back"]);
    expect((await unwrap(m.client.request("categories.list", {}))).categories[0]?.pool.poses).toEqual(["back"]);
  });

  test("a regeneration re-derives them: a description with no angle clears the poses", async () => {
    const m = makeMock();
    const category = await createCategory(m, CANARY);
    const regenerated = await unwrap(m.client.request("categories.regenerate", { categoryId: category.categoryId, description: "кофейни и булочные", acceptedWorstMicros: POOL_WORST }));
    expect("poses" in regenerated.category.pool).toBe(false);
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

  test("replaces them, and null clears them", async () => {
    const m = makeMock();
    const category = await createCategory(m, CANARY);
    const replaced = await unwrap(m.client.request("categories.update", { categoryId: category.categoryId, poses: ["front"] }));
    expect(replaced.category.pool.poses).toEqual(["front"]);
    const cleared = await unwrap(m.client.request("categories.update", { categoryId: category.categoryId, poses: null }));
    expect("poses" in cleared.category.pool).toBe(false);
  });

  test("goes together with a rename in one write", async () => {
    const m = makeMock();
    const category = await createCategory(m, "кофейни");
    const { category: updated } = await unwrap(m.client.request("categories.update", { categoryId: category.categoryId, name: "Новое имя", poses: ["back"] }));
    expect([updated.name, updated.pool.poses]).toEqual(["Новое имя", ["back"]]);
  });

  test("a removal the pool cannot take refuses the whole update: the poses stay as they were", async () => {
    const m = makeMock();
    const category = await createCategory(m, "кофейни");
    const refused = m.client.request("categories.update", { categoryId: category.categoryId, poses: ["back"], removeLocations: [category.pool.locations[0]?.name ?? "x"] });
    expect(await codeOf(refused)).toBe("VALIDATION");
    expect("poses" in ((await unwrap(m.client.request("categories.list", {}))).categories[0]?.pool ?? {})).toBe(false);
  });

  test("an unknown category is NOT_FOUND", async () => {
    const m = makeMock();
    expect(await codeOf(m.client.request("categories.update", { categoryId: "cat-nobody-here", poses: ["back"] }))).toBe("NOT_FOUND");
  });

  test("an update that names nothing is refused by the contract", async () => {
    const m = makeMock();
    const category = await createCategory(m, "кофейни");
    expect(await codeOf(m.client.request("categories.update", { categoryId: category.categoryId } as never))).toBe("VALIDATION");
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

  test("the run's toggles do not change it", async () => {
    const m = makeMock();
    const category = await createCategory(m, CANARY);
    const off = await composed(m, 10, [category.categoryId], OFF);
    await unwrap(m.client.request("scenes.discard", { sceneSetId: off.sceneSetId } as never));
    const on = await composed(m, 10, [category.categoryId], { profile: true, back: true });
    expect(on.scenes.map((s) => [s.pose, s.shot])).toEqual(off.scenes.map((s) => [s.pose, s.shot]));
  });

  test("the built-ins in the same set are still governed by the toggles", async () => {
    const m = makeMock();
    const category = await createCategory(m, CANARY);
    const view = await composed(m, 40, ["home", category.categoryId], OFF);
    const home = view.scenes.filter((s) => s.category === "home");
    expect(home.length).toBeGreaterThan(0);
    expect(home.every((s) => s.pose === "front" || s.pose === "three-quarter")).toBe(true);
  });

  test("a category with front and back draws both, and a front scene may keep a selfie; a selfie or mirror is never turned away", async () => {
    const m = makeMock();
    const category = await createCategory(m, "вид спереди и вид сзади");
    expect(category.pool.poses).toEqual(["front", "back"]);
    const view = await composed(m, 40, [category.categoryId]);
    expect(new Set(view.scenes.map((s) => s.pose))).toEqual(new Set(["front", "back"]));
    for (const scene of view.scenes) if (phone(scene.shot)) expect(["front", "three-quarter"]).toContain(scene.pose);
  });

  test("never a selfie or a mirror shot facing away, for any count, any list of poses", async () => {
    for (const description of ["вид сзади", "в профиль", "вид сзади и в профиль", "вид спереди и вид сзади", "анфас"]) {
      for (const count of [1, 2, 3, 5, 7, 12, 25, 26, 40]) {
        const m = makeMock();
        const category = await createCategory(m, description);
        const view = await composed(m, count, [category.categoryId]);
        for (const scene of view.scenes) if (phone(scene.shot)) expect(["front", "three-quarter"]).toContain(scene.pose);
      }
    }
  });

  test("a category without poses plans as it always did: its poses follow the toggles", async () => {
    const m = makeMock();
    const category = await createCategory(m, "кофейни");
    const off = await composed(m, 30, [category.categoryId], OFF);
    expect(off.scenes.every((s) => s.pose === "front" || s.pose === "three-quarter")).toBe(true);
    await unwrap(m.client.request("scenes.discard", { sceneSetId: off.sceneSetId } as never));
    const on = await composed(m, 30, [category.categoryId], { profile: true, back: true });
    expect(on.scenes.some((s) => s.pose === "back")).toBe(true);
  });
});

describe("⟳ on a scene of a category with poses", () => {
  test("a redraw keeps the pose in the category's list and never leaves a phone facing away", async () => {
    const m = makeMock();
    const category = await createCategory(m, CANARY);
    let view = await composed(m, 8, [category.categoryId]);
    for (const scene of view.scenes) {
      view = await writeAndRun(m, view, { kind: "rewrite", sceneIds: [scene.sceneId], redraw: true });
    }
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

  test("in English too: «back view» and «from behind»", async () => {
    const m = makeMock();
    let view = await readySet(m);
    view = await writeAndRun(m, view, { kind: "idea", idea: "lying on her stomach, back view", count: 1, shot: null });
    view = await writeAndRun(m, view, { kind: "idea", idea: "walking away, from behind", count: 1, shot: null });
    expect(view.scenes.filter((s) => s.origin === "own").map((s) => s.pose)).toEqual(["back", "back"]);
  });

  test("«в профиль» gives profile", async () => {
    const m = makeMock();
    const after = await writeAndRun(m, await readySet(m), { kind: "idea", idea: "у окна в профиль", count: 1, shot: null });
    expect(after.scenes.at(-1)).toMatchObject({ origin: "own", pose: "profile", shot: "candid" });
  });

  test("a shot the owner chose stays, and a selfie or a mirror is not turned away", async () => {
    const m = makeMock();
    let view = await readySet(m);
    view = await writeAndRun(m, view, { kind: "idea", idea: "вид сзади", count: 1, shot: "friend" });
    view = await writeAndRun(m, view, { kind: "idea", idea: "вид сзади", count: 1, shot: "selfie" });
    view = await writeAndRun(m, view, { kind: "idea", idea: "вид сзади", count: 1, shot: "mirror" });
    expect(view.scenes.filter((s) => s.origin === "own").map((s) => [s.shot, s.pose === "back" || s.pose === "profile"])).toEqual([
      ["friend", true],
      ["selfie", false],
      ["mirror", false],
    ]);
  });

  test("an idea with no angle in it faces the camera, never the mirror on «Авто»", async () => {
    const m = makeMock();
    let view = await readySet(m);
    for (let i = 0; i < 4; i++) view = await writeAndRun(m, view, { kind: "idea", idea: "кофе", count: 5, shot: null });
    const own = view.scenes.filter((s) => s.origin === "own");
    expect(own.some((s) => s.shot === "mirror")).toBe(false);
    expect(own.every((s) => s.pose === "front" || s.pose === "three-quarter")).toBe(true);
  });
});
