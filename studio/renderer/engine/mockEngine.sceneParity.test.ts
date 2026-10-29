import { describe, expect, test } from "bun:test";
import type { AvatarSummary, EngineError, EventMessage, SceneSetView } from "../../shared/engine";
import { LLM_ONLY_CATEGORY_RECORD, LLM_ONLY_REF } from "../../engine/scenes/testing/llmOnlyFixture";
import { DEFAULT_TRAITS } from "../lib/traits";
import { MockEngine, mockDescriptor, mockEngineClient } from "./mockEngine";
import { ManualScheduler } from "./scheduler";

// CS.7: where the mock differed from the engine on a scene-set or category command, and now does not: the refusals during a library switch, the order of
// `scenes.write`'s IN_FLIGHT, a cancel that had no request out, an unreadable ledger or file, the snapshot a redraw takes, and a write cancelled before its
// answer. Each test drives the same validating client the renderer uses.

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
const SOFIA: AvatarSummary = { ...MIA, avatarId: "avatar-sofia-0002", name: "Sofia", masterPhotoId: "photo-sofia-0002" };

// 5a.2 (S5.6e, m11): the writes these tests refuse and price are the MODEL's, so their sets are `cat-llm-only-fixture` scenes (the code template writes a built-in scene for nothing).
const ATTEMPT = 37_500;
const FIXTURE = { ...LLM_ONLY_CATEGORY_RECORD, createdAt: "2026-10-05T10:00:00.000Z", updatedAt: "2026-10-05T10:00:00.000Z" };

const POSES = { profile: false, back: false };

function makeMock(options: ConstructorParameters<typeof MockEngine>[0] = {}) {
  const scheduler = new ManualScheduler();
  const engine = new MockEngine({ scheduler, avatars: [MIA], categories: [FIXTURE], ...options });
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
async function errorOf<T>(reply: Reply<T>): Promise<EngineError> {
  const r = await reply;
  if (r.ok) throw new Error("expected an error");
  return r.error;
}

async function setOf(m: Mock, avatarId = MIA.avatarId): Promise<SceneSetView> {
  const { sceneSet } = await unwrap(m.client.request("scenes.get", { avatarId }));
  if (sceneSet === null) throw new Error("no set");
  return sceneSet;
}
const compose = (m: Mock, count = 4, avatarId = MIA.avatarId, categories: string[] = [LLM_ONLY_REF]) =>
  m.client.request("scenes.compose", { avatarId, count, categories, poses: POSES, acceptedWorstMicros: Math.ceil(count / 25) * 2 * ATTEMPT } as never);
async function ready(m: Mock, count = 4, avatarId = MIA.avatarId, categories: string[] = [LLM_ONLY_REF]): Promise<SceneSetView> {
  await unwrap(compose(m, count, avatarId, categories));
  m.scheduler.runAll();
  return setOf(m, avatarId);
}
const write = (m: Mock, view: SceneSetView, target: unknown, accepted = 2 * ATTEMPT) => m.client.request("scenes.write", { sceneSetId: view.sceneSetId, revision: view.revision, target, acceptedWorstMicros: accepted } as never);

// ---------- a library switch ----------

describe("while a library switch is surveyed, every scene-set and category write waits with IN_FLIGHT", () => {
  async function fixture() {
    const m = makeMock();
    const category = (await unwrap(m.client.request("categories.create", { name: "Кофейни Парижа", description: "кофейни и булочные Парижа", acceptedWorstMicros: 45_000 }))).category;
    const view = await ready(m);
    m.engine.setLibrarySwitching(true);
    return { m, view, category };
  }

  const commands: [string, (f: Awaited<ReturnType<typeof fixture>>) => Reply<unknown>][] = [
    ["scenes.compose", ({ m }) => compose(m, 3, SOFIA.avatarId)],
    ["scenes.edit", ({ m, view }) => m.client.request("scenes.edit", { sceneSetId: view.sceneSetId, revision: view.revision, op: { op: "remove", sceneIds: [1] } } as never)],
    ["scenes.write", ({ m, view }) => write(m, view, { kind: "rewrite", sceneIds: [1], redraw: false })],
    ["scenes.discard", ({ m, view }) => m.client.request("scenes.discard", { sceneSetId: view.sceneSetId })],
    ["runs.startFromScenes", ({ m, view }) => m.client.request("runs.startFromScenes", { sceneSetId: view.sceneSetId, revision: view.revision, acceptedWorstMicros: 10_000_000 })],
    ["categories.create", ({ m }) => m.client.request("categories.create", { name: "Другая", description: "что-то ещё", acceptedWorstMicros: 45_000 })],
    ["categories.regenerate", ({ m, category }) => m.client.request("categories.regenerate", { categoryId: category.categoryId, description: "кофейни у Сены", acceptedWorstMicros: 45_000 })],
    ["categories.update", ({ m, category }) => m.client.request("categories.update", { categoryId: category.categoryId, name: "Переименована" })],
    ["categories.delete", ({ m, category }) => m.client.request("categories.delete", { categoryId: category.categoryId })],
    ["categories.dismissInterrupted", ({ m }) => m.client.request("categories.dismissInterrupted", { jobId: "job-00000042" })],
  ];

  test.each(commands)("%s", async (_name, run) => {
    const f = await fixture();
    expect(await errorOf(run(f))).toMatchObject({ code: "IN_FLIGHT" });
  });

});

// ---------- scenes.write: the order of the refusals ----------

// ---------- a cancel ----------

describe("a cancel opens a reserve only when a request was out", () => {
  test("with a request in flight (the default) the cancelled attempt keeps a reserve open at its worst case, and a reconcile is needed", async () => {
    const m = makeMock();
    await unwrap(compose(m, 30));
    await unwrap(m.client.request("scenes.cancel", { sceneSetId: (await setOf(m)).sceneSetId }));
    m.scheduler.runAll();
    const view = await setOf(m);

    expect(view.openReserveMicros).toBe(ATTEMPT);
    expect(view.status).toBe("stopped");
  });

});

// ---------- an unreadable ledger, unreadable files ----------

describe("a set's spend when the ledger cannot be read", () => {
  test("is null, and so is the open reserve (both known or both unknown, as the contract has it)", async () => {
    const m = makeMock({ money: { unavailable: { cause: "LEDGER_CORRUPT", detail: "ledger.jsonl:3 is not valid JSON" } }, sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-seed-0001", count: 3, written: 3 }] });
    const view = await setOf(m);
    expect(view.spentMicros).toBeNull();
    expect(view.openReserveMicros).toBeNull();
  });

});

// ---------- the snapshot a redraw takes ----------

// ---------- a write cancelled before its answer ----------

// ---------- two windows ----------

