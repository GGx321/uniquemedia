import { describe, expect, test } from "bun:test";
import type { CommandMessage } from "../../shared/engine";
import type { EngineClient } from "./client";
import { MockEngine, mockEngineClient } from "./mockEngine";
import { ManualScheduler } from "./scheduler";
import { EngineStore, EXPORT_RECHECK_MIN_MS } from "./store";

// 3e.3 (K9): `export.status` follows checks only, so a window asks for one when it comes back to the front (an unplugged or replugged
// disk shows up live). The ask is throttled, never piles up, and a failed one changes nothing.

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const checks = (calls: readonly CommandMessage[]): number => calls.filter((c) => c.type === "export.check").length;

async function rig(options: { start?: boolean } = {}) {
  const engine = new MockEngine({ scheduler: new ManualScheduler() });
  let clock = 0;
  const store = new EngineStore(mockEngineClient(engine), { now: () => clock });
  if (options.start !== false) {
    store.start();
    await settle();
  }
  return {
    engine,
    store,
    at: (ms: number): void => {
      clock = ms;
    },
  };
}

describe("EngineStore.recheckExport", () => {
  test("asks the engine to check the export folder, and shows what it found", async () => {
    const { engine, store } = await rig();
    engine.setExportDisk({ status: "unavailable", reason: "missing" });

    await store.recheckExport();

    expect(checks(engine.calls)).toBe(1);
    expect(store.getView().exportStatus).toEqual({ status: "unavailable", reason: "missing" });
  });

  test("shows the folder usable again once the disk is back", async () => {
    const { engine, store, at } = await rig();
    engine.setExportDisk({ status: "unavailable", reason: "missing" });
    await store.recheckExport();
    engine.setExportDisk({ status: "ok" });
    at(EXPORT_RECHECK_MIN_MS);

    await store.recheckExport();

    expect(store.getView().exportStatus).toEqual({ status: "ok" });
  });

  test("a second ask inside the interval is skipped, and one after it goes through", async () => {
    const { engine, store, at } = await rig();
    await store.recheckExport();
    at(EXPORT_RECHECK_MIN_MS - 1);
    await store.recheckExport();
    expect(checks(engine.calls)).toBe(1);

    at(EXPORT_RECHECK_MIN_MS);
    await store.recheckExport();

    expect(checks(engine.calls)).toBe(2);
  });

  test("an ask while one is waiting for its answer joins it: one check, not two", async () => {
    const { engine, store, at } = await rig();
    at(EXPORT_RECHECK_MIN_MS * 10);

    await Promise.all([store.recheckExport(), store.recheckExport()]);

    expect(checks(engine.calls)).toBe(1);
  });

  test("does nothing before the first snapshot: there is no window state to correct yet", async () => {
    const { engine, store } = await rig({ start: false });

    await store.recheckExport();

    expect(checks(engine.calls)).toBe(0);
    expect(store.getView().exportStatus).toBeNull();
  });

  test("an engine that cannot answer leaves the status as it was, and does not throw", async () => {
    const { engine, store } = await rig();
    engine.failNext("export.check", { code: "INTERNAL" });

    await store.recheckExport();

    expect(store.getView().exportStatus).toEqual({ status: "ok" });
  });

  test("a failed ask still counts toward the interval, so a broken engine is not asked again and again", async () => {
    const { engine, store, at } = await rig();
    engine.failNext("export.check", { code: "INTERNAL" });
    await store.recheckExport();
    at(EXPORT_RECHECK_MIN_MS - 1);

    await store.recheckExport();

    expect(checks(engine.calls)).toBe(1);
  });

  test("an export.status that arrives while the check waits is newer than the answer, which does not overwrite it", async () => {
    const engine = new MockEngine({ scheduler: new ManualScheduler() });
    const real = mockEngineClient(engine);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The answer to the check is held back; everything else goes straight through.
    const client: EngineClient = {
      ...real,
      request: async (type, payload) => {
        const reply = await real.request(type, payload);
        if (type === "export.check") await held;
        return reply;
      },
    };
    const store = new EngineStore(client, { now: () => 0 });
    store.start();
    await settle();

    const pending = store.recheckExport();
    await settle();
    // The answer said "ok"; meanwhile a render attempt found the folder gone and the engine said so.
    engine.setExportDisk({ status: "unavailable", reason: "missing" });
    await client.request("videos.delete", { videoId: "video-nobody-0009", mode: "video" });
    release();
    await pending;

    expect(store.getView().exportStatus).toEqual({ status: "unavailable", reason: "missing" });
  });

  test("an ask the owner makes by hand (force) goes through inside the interval too", async () => {
    const { engine, store } = await rig();
    await store.recheckExport();

    await store.recheckExport({ force: true });

    expect(checks(engine.calls)).toBe(2);
  });
});
