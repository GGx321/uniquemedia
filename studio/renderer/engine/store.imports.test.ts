import { describe, expect, test } from "bun:test";
import { ENGINE_GONE_DETAIL } from "../../shared/engine";
import { MockEngine, type MockMediaPick, mockEngineClient } from "./mockEngine";
import { ManualScheduler } from "./scheduler";
import { EngineStore, type MediaSignal } from "./store";

// 3f.6: the store keeps the window's view of own-media imports (`imports`) from the snapshot and the `job.*` events of kind `import`,
// apart from the avatars' `jobs`; and it hands `media.changed` to its media listeners in seq order, with `resynced` after a snapshot taken
// again (the «Мои» tab lists the records on demand and listens here). Mock engine on a manual clock.

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

const PHOTO: MockMediaPick = { name: "lake.jpg", accept: { kind: "photo", bytes: 120 } };
const VIDEO: MockMediaPick = { name: "street-walk.mp4", accept: { kind: "video", bytes: 5_000 } };
const BAD_VIDEO: MockMediaPick = { name: "clip.webm", accept: { kind: "video", bytes: 900, failWith: "codec" } };

async function started(engine = new MockEngine({ scheduler: new ManualScheduler() })) {
  const client = mockEngineClient(engine);
  const store = new EngineStore(client);
  store.start();
  await settle();
  return { engine, client, store };
}

async function pick(harness: Awaited<ReturnType<typeof started>>, files: readonly MockMediaPick[]): Promise<string[]> {
  harness.engine.pickMediaNext(files);
  const reply = await harness.client.request("media.pickImport", { kind: "any" });
  await settle();
  if (!reply.ok || !reply.result.picked) throw new Error("nothing picked");
  return reply.result.jobIds;
}

const statuses = (store: EngineStore): [string, string][] => store.getView().imports.map((i) => [i.name, i.status]);

describe("imports in the view", () => {
  test("none at the start; a pick's files are announced (one runs, the next waits) and kept out of the avatars' jobs", async () => {
    const harness = await started();
    expect(harness.store.getView().imports).toEqual([]);
    await pick(harness, [PHOTO, VIDEO]);
    expect(statuses(harness.store)).toEqual([
      ["lake.jpg", "running"],
      ["street-walk.mp4", "queued"],
    ]);
    expect(harness.store.getView().jobs).toEqual([]);
  });

  test("each ends done with its record's id, the next taking its turn", async () => {
    const scheduler = new ManualScheduler();
    const h = await started(new MockEngine({ scheduler }));
    await pick(h, [PHOTO, VIDEO]);
    scheduler.next();
    await settle();
    expect(statuses(h.store)).toEqual([
      ["lake.jpg", "done"],
      ["street-walk.mp4", "running"],
    ]);
    expect(h.store.getView().imports[0]?.mediaId).toMatch(/^media-/);
    scheduler.runAll();
    await settle();
    expect(statuses(h.store).map(([, s]) => s)).toEqual(["done", "done"]);
  });

  test("an importer's refusal ends the import failed with MEDIA_UNSUPPORTED and its reason", async () => {
    const scheduler = new ManualScheduler();
    const h = await started(new MockEngine({ scheduler }));
    await pick(h, [BAD_VIDEO]);
    scheduler.runAll();
    await settle();
    const [failed] = h.store.getView().imports;
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toMatchObject({ code: "MEDIA_UNSUPPORTED", mediaReason: "codec" });
  });

  test("a cancel asked here marks the import until its end; the end makes it cancelled", async () => {
    const scheduler = new ManualScheduler();
    const h = await started(new MockEngine({ scheduler }));
    const [jobId = ""] = await pick(h, [VIDEO]);
    h.store.markImportCancelling(jobId);
    expect(h.store.getView().imports[0]?.cancelRequested).toBe(true);
    const reply = await h.client.request("media.cancelImport", { jobId });
    expect(reply.ok).toBe(true);
    scheduler.runAll();
    await settle();
    expect(h.store.getView().imports[0]).toMatchObject({ status: "cancelled", cancelRequested: true });
  });

  test("a snapshot brings the imports that started before this window looked (another window's pick)", async () => {
    const scheduler = new ManualScheduler();
    const engine = new MockEngine({ scheduler });
    engine.holdImports(true);
    engine.pickMediaNext([VIDEO]);
    await mockEngineClient(engine).request("media.pickImport", { kind: "video" });
    const h = await started(engine);
    expect(statuses(h.store)).toEqual([["street-walk.mp4", "running"]]);
  });

  test("a dismissed import leaves the view and a later snapshot does not bring it back", async () => {
    const scheduler = new ManualScheduler();
    const h = await started(new MockEngine({ scheduler }));
    const [jobId = ""] = await pick(h, [BAD_VIDEO, PHOTO]);
    scheduler.runAll();
    await settle();
    h.store.dismissImport(jobId);
    expect(statuses(h.store)).toEqual([["lake.jpg", "done"]]);
    h.store.reload();
    await settle();
    expect(statuses(h.store)).toEqual([["lake.jpg", "done"]]);
  });

  test("the engine gone for good fails the imports still active (nothing would ever end them)", async () => {
    const scheduler = new ManualScheduler();
    const h = await started(new MockEngine({ scheduler }));
    await pick(h, [VIDEO]);
    h.engine.failNext("engine.snapshot", { code: "INTERNAL", detail: ENGINE_GONE_DETAIL });
    h.store.reload();
    await settle();
    expect(h.store.getView().imports[0]).toMatchObject({ status: "failed", error: { code: "INTERNAL", detail: ENGINE_GONE_DETAIL } });
  });
});

describe("the media listeners", () => {
  test("hear each media.changed in order, and `resynced` after a snapshot taken again (never on the first one)", async () => {
    const scheduler = new ManualScheduler();
    const h = await started(new MockEngine({ scheduler }));
    const heard: MediaSignal[] = [];
    const stop = h.store.subscribeMedia((signal) => heard.push(signal));
    await pick(h, [PHOTO]);
    scheduler.runAll();
    await settle();
    expect(heard.map((s) => s.change)).toEqual(["upserted"]);
    const id = h.store.getView().imports[0]?.mediaId ?? "";
    await h.client.request("media.delete", { mediaId: id });
    await settle();
    expect(heard.map((s) => s.change)).toEqual(["upserted", "removed"]);
    h.store.reload();
    await settle();
    expect(heard.map((s) => s.change)).toEqual(["upserted", "removed", "resynced"]);
    stop();
    h.store.reload();
    await settle();
    expect(heard).toHaveLength(3);
  });
});
