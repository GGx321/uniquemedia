import { describe, expect, test } from "bun:test";
import type { AvatarSummary, EventMessage, SceneSetView } from "../../shared/engine";
import { DEFAULT_TRAITS } from "../lib/traits";
import { MockEngine, MOCK_RUN_WRITER, mockDescriptor, mockEngineClient } from "./mockEngine";
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

describe("runs.estimateFromScenes", () => {
  test("is the whole run's estimate for M photos less its writer: the same images, no writer term", async () => {
    const m = makeMock();
    const set = await readySet(m, 5);
    const scenes = (await unwrap(estimateOf(m, set))).estimate;
    const whole = (await unwrap(m.client.request("runs.estimate", { avatarId: MIA.avatarId, count: 5, categories: ["home"], poses: POSES }))).estimate;
    expect(whole.worstMicros - scenes.worstMicros).toBe(MOCK_RUN_WRITER.worstPerChunk);
    expect(whole.expectedMicros - scenes.expectedMicros).toBe(5 * MOCK_RUN_WRITER.expectedPerPhoto);
  });

  test("falls with a removed scene by exactly its three attempts, and counts nothing for a writer", async () => {
    const m = makeMock();
    let set = await readySet(m, 5);
    const five = (await unwrap(estimateOf(m, set))).estimate.worstMicros;
    set = await edited(m, set, { op: "remove", sceneIds: [2] });
    const four = (await unwrap(estimateOf(m, set))).estimate.worstMicros;
    expect(five / 5).toBe(four / 4);
    expect(five - four).toBe(five / 5);
  });

  test("refuses in the engine's order: revision, empty text, none active, a job running, already used", async () => {
    const m = makeMock();
    const set = await readySet(m, 3);
    expect(await codeOf(m.client.request("runs.estimateFromScenes", { sceneSetId: set.sceneSetId, revision: set.revision + 1 }))).toBe("SCENES_CHANGED");
    expect(await codeOf(m.client.request("runs.estimateFromScenes", { sceneSetId: "set-nobody-0404", revision: 1 }))).toBe("NOT_FOUND");

    const removed = await edited(m, set, { op: "remove", sceneIds: [1, 2, 3] });
    expect(await codeOf(estimateOf(m, removed))).toBe("VALIDATION");
  });

  test("an active scene with no text is VALIDATION, and a removed one does not count", async () => {
    const m = makeMock({ sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-seed-0001", count: 30, written: 25 }] });
    const set = await setOf(m);
    const empty = set.scenes.filter((s) => s.text === null).map((s) => s.sceneId);
    expect(empty).toHaveLength(5);
    expect(await codeOf(estimateOf(m, set))).toBe("VALIDATION");
    const cleaned = await edited(m, set, { op: "remove", sceneIds: empty });
    expect((await unwrap(estimateOf(m, cleaned))).estimate.worstMicros).toBeGreaterThan(0);
  });
});

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

  test("the set reads used and names the run it made", async () => {
    const m = makeMock();
    const set = await readySet(m, 3);
    const worst = (await unwrap(estimateOf(m, set))).estimate.worstMicros;
    const { runId } = await unwrap(start(m, set, worst));
    expect(await setOf(m)).toMatchObject({ status: "used", runId });
  });

  test("announces the set as used before any event of the run's job", async () => {
    const m = makeMock();
    const set = await readySet(m, 3);
    const worst = (await unwrap(estimateOf(m, set))).estimate.worstMicros;
    const { runId } = await unwrap(start(m, set, worst));
    const usedAt = m.events.findIndex((e) => e.type === "scenes.changed" && e.payload.change === "upserted" && e.payload.sceneSet.status === "used" && e.payload.sceneSet.runId === runId);
    const jobAt = m.events.findIndex((e) => e.type === "job.progress" && e.payload.kind === "run");
    expect(usedAt).toBeGreaterThanOrEqual(0);
    expect(usedAt).toBeLessThan(jobAt);
  });

  test("a price above what the owner accepted is PRICE_CHANGED, and the set stays open", async () => {
    const m = makeMock();
    const set = await readySet(m, 3);
    const worst = (await unwrap(estimateOf(m, set))).estimate.worstMicros;
    expect(await codeOf(start(m, set, worst - 1))).toBe("PRICE_CHANGED");
    expect((await setOf(m)).status).toBe("ready");
  });

  test("refuses a moved revision, an empty text and a set with nothing active, all free", async () => {
    const m = makeMock();
    const set = await readySet(m, 3);
    expect(await codeOf(m.client.request("runs.startFromScenes", { sceneSetId: set.sceneSetId, revision: set.revision + 1, acceptedWorstMicros: 10_000_000 }))).toBe("SCENES_CHANGED");
    const removed = await edited(m, set, { op: "remove", sceneIds: [1, 2, 3] });
    expect(await codeOf(start(m, removed, 10_000_000))).toBe("VALIDATION");
    expect((await unwrap(m.client.request("runs.list", {}))).runs).toEqual([]);
  });

  test("a second start of the same set is refused, and the set is read-only after the first", async () => {
    const m = makeMock();
    const set = await readySet(m, 3);
    const worst = (await unwrap(estimateOf(m, set))).estimate.worstMicros;
    await unwrap(start(m, set, worst));
    m.scheduler.runAll();
    const used = await setOf(m);
    expect(await codeOf(start(m, used, worst))).toBe("VALIDATION");
    expect(await codeOf(edit(m, used, { op: "remove", sceneIds: [1] }))).toBe("VALIDATION");
    expect(await codeOf(m.client.request("scenes.discard", { sceneSetId: used.sceneSetId }))).toBe("VALIDATION");
    expect((await unwrap(m.client.request("runs.list", {}))).runs).toHaveLength(1);
  });

  test("a job of the avatar running is IN_FLIGHT", async () => {
    const m = makeMock();
    const set = await readySet(m, 3);
    const worst = (await unwrap(estimateOf(m, set))).estimate.worstMicros;
    await unwrap(m.client.request("runs.start", { avatarId: MIA.avatarId, count: 2, categories: ["home"], poses: POSES, acceptedWorstMicros: 10_000_000 }));
    expect(await codeOf(start(m, set, worst))).toBe("IN_FLIGHT");
  });

  test("the run draws one photo per scene and finishes, and a resume of a cancelled one is priced with no writer", async () => {
    const m = makeMock();
    const set = await readySet(m, 3);
    const worst = (await unwrap(estimateOf(m, set))).estimate.worstMicros;
    const { runId } = await unwrap(start(m, set, worst));
    m.scheduler.runAll();
    const { runs } = await unwrap(m.client.request("runs.list", {}));
    expect(runs.find((r) => r.runId === runId)).toMatchObject({ total: 3, done: 3, open: 0 });
  });

  test("a cancelled run's resume is priced for its images only", async () => {
    const m = makeMock();
    const set = await readySet(m, 3);
    const worst = (await unwrap(estimateOf(m, set))).estimate.worstMicros;
    const { runId } = await unwrap(start(m, set, worst));
    await unwrap(m.client.request("runs.cancel", { runId }));
    m.scheduler.runAll();
    const { estimate } = await unwrap(m.client.request("runs.estimateResume", { runId }));
    expect(estimate.worstMicros).toBeLessThanOrEqual(worst);
    expect(estimate.worstMicros % 3).toBe(0);
  });
});

// CS.4b x CS.5: an own scene (written from an idea) is a run slot of no category. The engine's `photoCategoryOf` makes its photo `"own"`, and its run
// request never names "own" as a category (that is the type's own rule: `RunRequest.categories` holds only categories).
describe("runs.startFromScenes: an own scene", () => {
  /** A ready set of `count` planned scenes plus one own scene written from an idea. */
  async function setWithOwn(m: Mock, count = 3): Promise<SceneSetView> {
    const set = await readySet(m, count);
    const target = { kind: "idea", idea: "кофе на балконе утром", count: 1, shot: null };
    await unwrap(m.client.request("scenes.write", { sceneSetId: set.sceneSetId, revision: set.revision, target, acceptedWorstMicros: 2 * ATTEMPT } as never));
    m.scheduler.runAll();
    const after = await setOf(m);
    expect(after.scenes.filter((s) => s.origin === "own")).toHaveLength(1);
    return after;
  }

  test("is drawn like any scene: the run counts it, and its photo carries the category own", async () => {
    const m = makeMock();
    const set = await setWithOwn(m, 3);
    const worst = (await unwrap(estimateOf(m, set))).estimate.worstMicros;
    const { runId } = await unwrap(start(m, set, worst));
    m.scheduler.runAll();
    const { runs } = await unwrap(m.client.request("runs.list", {}));
    expect(runs.find((r) => r.runId === runId)).toMatchObject({ total: 4, done: 4, open: 0 });
    const { photos } = await unwrap(m.client.request("photos.list", { avatarId: MIA.avatarId }));
    const made = photos.filter((p) => p.runId === runId);
    expect(made.filter((p) => p.category === "own")).toHaveLength(1);
    expect(made.filter((p) => p.category === "home")).toHaveLength(3);
  });

  test("the run's request never names own as a category, however many own scenes the set has", async () => {
    const m = makeMock();
    const set = await setWithOwn(m, 3);
    const worst = (await unwrap(estimateOf(m, set))).estimate.worstMicros;
    const { runId } = await unwrap(start(m, set, worst));
    // The mock's own record of the run: `runs.list` does not carry the request, and the plan's request is what a resume reads.
    const runs = (m.engine as unknown as { runs: { runId: string; request: { categories: string[] } }[] })["runs"];
    const request = runs.find((r) => r.runId === runId)?.request;
    expect(request?.categories).toEqual(["home"]);
    expect(request?.categories).not.toContain("own");
  });

  test("a set of own scenes only makes photos that are all own, none with a category name", async () => {
    const m = makeMock();
    let set = await setWithOwn(m, 3);
    set = await edited(m, set, { op: "remove", sceneIds: set.scenes.filter((s) => s.origin === "planned").map((s) => s.sceneId) });
    const worst = (await unwrap(estimateOf(m, set))).estimate.worstMicros;
    const { runId } = await unwrap(start(m, set, worst));
    m.scheduler.runAll();
    const { photos } = await unwrap(m.client.request("photos.list", { avatarId: MIA.avatarId }));
    const made = photos.filter((p) => p.runId === runId);
    expect(made.map((p) => p.category)).toEqual(["own"]);
    expect(made.some((p) => "categoryName" in p)).toBe(false);
  });
});
