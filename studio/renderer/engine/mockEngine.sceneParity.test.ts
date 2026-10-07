import { describe, expect, test } from "bun:test";
import type { AvatarSummary, EngineError, EventMessage, SceneSetView } from "../../shared/engine";
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
const compose = (m: Mock, count = 4, avatarId = MIA.avatarId, categories: string[] = ["home"]) =>
  m.client.request("scenes.compose", { avatarId, count, categories, poses: POSES, acceptedWorstMicros: Math.ceil(count / 25) * 2 * ATTEMPT } as never);
async function ready(m: Mock, count = 4, avatarId = MIA.avatarId, categories: string[] = ["home"]): Promise<SceneSetView> {
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

  test("the switch is checked before the library itself, as the engine's liveLibrary does", async () => {
    const f = await fixture();
    f.m.engine.setLibraryAvailable(false);
    expect(await errorOf(f.m.client.request("scenes.discard", { sceneSetId: f.view.sceneSetId }))).toMatchObject({ code: "IN_FLIGHT" });
  });

  test("reads and estimates still answer", async () => {
    const { m, view } = await fixture();
    expect((await unwrap(m.client.request("scenes.get", { avatarId: MIA.avatarId }))).sceneSet?.sceneSetId).toBe(view.sceneSetId);
    expect(await unwrap(m.client.request("categories.list", {}))).toMatchObject({ categories: [{ name: "Кофейни Парижа" }] });
    expect(await unwrap(m.client.request("categories.estimate", {}))).toMatchObject({ worstMicros: 45_000 });
    expect(await unwrap(m.client.request("scenes.estimateWrite", { sceneSetId: view.sceneSetId, target: { kind: "rewrite", sceneIds: [1], redraw: false } } as never))).toMatchObject({ estimate: { worstMicros: 2 * ATTEMPT } });
  });

  test("once the survey ends the writes answer again", async () => {
    const { m, view } = await fixture();
    m.engine.setLibrarySwitching(false);
    await unwrap(m.client.request("scenes.edit", { sceneSetId: view.sceneSetId, revision: view.revision, op: { op: "remove", sceneIds: [1] } } as never));
  });
});

// ---------- scenes.write: the order of the refusals ----------

describe("scenes.write: a set whose own job runs is IN_FLIGHT before anything else", () => {
  test("even when the ledger wants a reconcile, as the engine answers (its set claim comes first)", async () => {
    const m = makeMock();
    await unwrap(compose(m, 30));
    const view = await setOf(m);
    expect(view.status).toBe("writing");
    // A cancel with a request out keeps its reserve open: every paid command now waits for a reconcile, except that the set's own job is still ending.
    await unwrap(m.client.request("scenes.cancel", { sceneSetId: view.sceneSetId }));

    expect(await errorOf(write(m, view, { kind: "unwritten" }, 4 * ATTEMPT))).toMatchObject({ code: "IN_FLIGHT" });
  });

  test("once the job has ended the ledger's own refusal is the answer", async () => {
    const m = makeMock();
    await unwrap(compose(m, 30));
    await unwrap(m.client.request("scenes.cancel", { sceneSetId: (await setOf(m)).sceneSetId }));
    m.scheduler.runAll();
    const view = await setOf(m);

    expect(await errorOf(write(m, view, { kind: "unwritten" }, 4 * ATTEMPT))).toMatchObject({ code: "RECONCILE_REQUIRED" });
  });
});

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

  test("between requests (setSceneCancelOutcome) nothing is open: the set is stopped, «Дописать» is allowed at once, and no reconcile is asked", async () => {
    const m = makeMock();
    m.engine.setSceneCancelOutcome("between");
    await unwrap(compose(m, 30));
    await unwrap(m.client.request("scenes.cancel", { sceneSetId: (await setOf(m)).sceneSetId }));
    m.scheduler.runAll();
    const view = await setOf(m);

    expect(view.openReserveMicros).toBe(0);
    expect(view.spentMicros).toBe(0);
    expect(view.stoppedBy).toBe("cancelled");
    await unwrap(write(m, view, { kind: "unwritten" }, 4 * ATTEMPT));
  });

  test("a review write cancelled between requests opens nothing either", async () => {
    const m = makeMock();
    const view = await ready(m);
    m.engine.setSceneCancelOutcome("between");
    await unwrap(write(m, view, { kind: "rewrite", sceneIds: [2], redraw: false }));
    await unwrap(m.client.request("scenes.cancel", { sceneSetId: view.sceneSetId }));
    m.scheduler.runAll();

    expect((await setOf(m)).openReserveMicros).toBe(0);
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

  test("is a number with a readable ledger", async () => {
    const m = makeMock({ sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-seed-0001", count: 3, written: 3 }] });
    const view = await setOf(m);
    expect(typeof view.spentMicros).toBe("number");
    expect(view.openReserveMicros).toBe(0);
  });
});

describe("scene set files the library could not read", () => {
  test("a number per avatar: one avatar's unreadable files are not another's", async () => {
    const m = makeMock({ avatars: [MIA, SOFIA], unreadableSceneSets: { [MIA.avatarId]: 2 } });
    expect((await unwrap(m.client.request("scenes.get", { avatarId: MIA.avatarId }))).unreadable).toBe(2);
    expect((await unwrap(m.client.request("scenes.get", { avatarId: SOFIA.avatarId }))).unreadable).toBe(0);
  });

  test("a plain number still counts for every avatar, as before", async () => {
    const m = makeMock({ avatars: [MIA, SOFIA], unreadableSceneSets: 1 });
    expect((await unwrap(m.client.request("scenes.get", { avatarId: MIA.avatarId }))).unreadable).toBe(1);
    expect((await unwrap(m.client.request("scenes.get", { avatarId: SOFIA.avatarId }))).unreadable).toBe(1);
  });
});

// ---------- the snapshot a redraw takes ----------

describe("a redraw refreshes the set's snapshot of its category with the name the library had when the write was PLANNED", () => {
  async function withCategory() {
    const m = makeMock();
    const category = (await unwrap(m.client.request("categories.create", { name: "Кофейни Парижа", description: "кофейни и булочные Парижа", acceptedWorstMicros: 45_000 }))).category;
    const view = await ready(m, 4, MIA.avatarId, [category.categoryId]);
    return { m, category, view };
  }
  const rename = (m: Mock, categoryId: string, name: string) => m.client.request("categories.update", { categoryId, name } as never);
  const nameOf = async (m: Mock, categoryId: string) => (await setOf(m)).categories.find((c) => c.ref === categoryId)?.name;

  test("a category renamed after the write began does not change what the resumed write records", async () => {
    const { m, category, view } = await withCategory();
    m.engine.failNextSceneAttempt("rate-limited");
    await unwrap(write(m, view, { kind: "rewrite", sceneIds: [1], redraw: true }));
    m.scheduler.runAll();
    await unwrap(rename(m, category.categoryId, "Новое имя"));

    await unwrap(write(m, await setOf(m), { kind: "resume", write: 2 }));
    m.scheduler.runAll();

    expect(await nameOf(m, category.categoryId)).toBe("Кофейни Парижа");
  });

  test("a write planned after the rename records the new name", async () => {
    const { m, category, view } = await withCategory();
    await unwrap(rename(m, category.categoryId, "Новое имя"));
    await unwrap(write(m, view, { kind: "rewrite", sceneIds: [1], redraw: true }));
    m.scheduler.runAll();

    expect(await nameOf(m, category.categoryId)).toBe("Новое имя");
  });

  test("an older write that finishes later does not undo a newer write's snapshot", async () => {
    const { m, category, view } = await withCategory();
    m.engine.failNextSceneAttempt("rate-limited");
    await unwrap(write(m, view, { kind: "rewrite", sceneIds: [1], redraw: true }));
    m.scheduler.runAll();
    await unwrap(rename(m, category.categoryId, "Новое имя"));
    await unwrap(write(m, await setOf(m), { kind: "rewrite", sceneIds: [2], redraw: true }));
    m.scheduler.runAll();
    expect(await nameOf(m, category.categoryId)).toBe("Новое имя");

    await unwrap(write(m, await setOf(m), { kind: "resume", write: 2 }));
    m.scheduler.runAll();

    expect(await nameOf(m, category.categoryId)).toBe("Новое имя");
  });
});

// ---------- a write cancelled before its answer ----------

describe("cancelNextSceneWriteBeforeAnswer: the order the engine gives when a cancel beats the job's start", () => {
  test("the set is announced as it is, job.cancelled follows, and the answer to the write comes last", async () => {
    const m = makeMock();
    const view = await ready(m);
    m.engine.cancelNextSceneWriteBeforeAnswer();
    const heard: string[] = [];
    m.client.subscribe((e) => {
      if (e.type === "scenes.changed" || e.type === "job.cancelled") heard.push(e.type);
    });

    const { jobId } = await unwrap(write(m, view, { kind: "rewrite", sceneIds: [2], redraw: false }));
    heard.push("answer");

    expect(heard).toEqual(["scenes.changed", "job.cancelled", "answer"]);
    const cancelled = m.events.find((e) => e.type === "job.cancelled");
    expect(cancelled?.payload).toMatchObject({ kind: "scenes", jobId, sceneSetId: view.sceneSetId });
  });

  test("the set's file is untouched: the same revision, nothing spent, and the set is ready", async () => {
    const m = makeMock();
    const view = await ready(m);
    m.engine.cancelNextSceneWriteBeforeAnswer();
    await unwrap(write(m, view, { kind: "rewrite", sceneIds: [2], redraw: false }));

    const after = await setOf(m);
    expect(after.revision).toBe(view.revision);
    expect(after.status).toBe("ready");
    expect(after.spentMicros).toBe(view.spentMicros);
    expect(after.scenes).toEqual(view.scenes);
  });

  test("the job is listed as cancelled in the snapshot", async () => {
    const m = makeMock();
    const view = await ready(m);
    m.engine.cancelNextSceneWriteBeforeAnswer();
    const { jobId } = await unwrap(write(m, view, { kind: "rewrite", sceneIds: [2], redraw: false }));

    const snapshot = await unwrap(m.client.request("engine.snapshot", {}));
    expect(snapshot.jobs.find((j) => "jobId" in j && j.jobId === jobId)).toMatchObject({ kind: "scenes", status: "cancelled" });
  });

  test("it is for one write: the next goes through and ends done", async () => {
    const m = makeMock();
    const view = await ready(m);
    m.engine.cancelNextSceneWriteBeforeAnswer();
    await unwrap(write(m, view, { kind: "rewrite", sceneIds: [2], redraw: false }));
    await unwrap(write(m, await setOf(m), { kind: "rewrite", sceneIds: [2], redraw: false }));
    m.scheduler.runAll();

    expect(m.events.filter((e) => e.type === "job.done")).toHaveLength(2);
  });

  test("the write's own refusals still come first: a stale price is PRICE_CHANGED and the flag stays for the next accepted write", async () => {
    const m = makeMock();
    const view = await ready(m);
    m.engine.cancelNextSceneWriteBeforeAnswer();
    expect(await errorOf(write(m, view, { kind: "rewrite", sceneIds: [2], redraw: false }, 1))).toMatchObject({ code: "PRICE_CHANGED" });
    expect(m.events.some((e) => e.type === "job.cancelled")).toBe(false);
    await unwrap(write(m, view, { kind: "rewrite", sceneIds: [2], redraw: false }));
    expect(m.events.some((e) => e.type === "job.cancelled")).toBe(true);
  });
});

// ---------- two windows ----------

describe("a write refused before it begins leaves no window on «writing»", () => {
  test("two subscribers hear no writing set from a write the price refuses, and both read the set as ready", async () => {
    const m = makeMock();
    const view = await ready(m);
    const windowB: EventMessage[] = [];
    m.client.subscribe((e) => windowB.push(e));
    const before = m.events.length;

    expect(await errorOf(write(m, view, { kind: "rewrite", sceneIds: [2], redraw: false }, 1))).toMatchObject({ code: "PRICE_CHANGED" });

    const heard = [...m.events.slice(before), ...windowB].flatMap((e) => (e.type === "scenes.changed" && e.payload.change === "upserted" ? [e.payload.sceneSet.status] : []));
    expect(heard).not.toContain("writing");
    expect((await setOf(m)).status).toBe("ready");
  });
});
