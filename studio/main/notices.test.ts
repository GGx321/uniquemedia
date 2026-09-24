import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineNotice } from "../shared/engine";
import type { EngineInit } from "../engine/control";
import { Engine } from "../engine/engine";
import { createEngineClient, type EngineBridge } from "../renderer/engine/client";
import { EngineStore } from "../renderer/engine/store";
import { HostNotices } from "./notices";
import { handleRendererRequest, type SenderFrame, type TrustedRenderer } from "./requests";

// A real engine and the renderer's real EngineStore, joined through main's
// request path (handleRendererRequest) with asynchronous event delivery like
// IPC. Main's notices reach the engine only through `init`, as main.ts builds
// it on every (re)start. Counts the store's engine.snapshot requests: a notice
// must show up in the store without ever making it resync in a loop, and it
// must never look like an engine error.

const FILE_URL = "file:///app/out-studio/renderer/index.html";
const TRUSTED: TrustedRenderer = { fileUrl: FILE_URL };
const FRAME: SenderFrame = { url: FILE_URL, isTopFrame: true, isAppWindow: true };
const CORRUPT = "settings.json is not valid JSON; it was moved to settings.json.corrupt-20260924T100000Z and the defaults are in use";
const CRASH = "the engine exited unexpectedly (code 9); restarting it";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "studio-notices-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const settle = (ms = 60) => Bun.sleep(ms);

async function harness() {
  const listeners = new Set<(event: unknown) => void>();
  /** Like IPC: an event reaches the window later, never inside the call that emitted it. */
  const deliver = (event: unknown) => setTimeout(() => listeners.forEach((l) => l(event)), 0);
  let n = 0;
  let clock = Date.parse("2026-09-24T10:00:00.000Z");
  const notices = new HostNotices({ newId: () => `notice-${String(++n).padStart(6, "0")}`, clock: () => (clock += 1000) });
  let engine: Engine | null = null;
  /** What main.ts does on every (re)start: init carries every notice of this app session. */
  const startEngine = async (bootId: string) => {
    const init: EngineInit = {
      kind: "control",
      type: "init",
      ledgerPath: join(dir, "ledger.jsonl"),
      settings: {
        monthlyBudgetMicros: 10_000_000,
        libraryPath: join(dir, "library"),
        imageModel: "x-ai/grok-imagine-image-2.0",
        textModel: "x-ai/grok-4.3",
        concurrency: { network: 6 },
      },
      encryptionAvailable: true,
      notices: [...notices.all],
    };
    engine = await Engine.start(init, {
      bootId,
      clock: Date.now,
      monotonic: () => performance.now(),
      newId: () => `id-${bootId}-${String(++n).padStart(6, "0")}`,
      post: (message) => {
        if (message.kind === "event") deliver(message);
      },
      fetch: async (url) => {
        throw new Error(`unexpected network call to ${url}`);
      },
    });
  };
  let snapshots = 0;

  const bridge: EngineBridge = {
    request: async (command) => {
      if (command.type === "engine.snapshot") snapshots++;
      return handleRendererRequest(command, FRAME, TRUSTED, {
        mainOnly: async () => {
          throw new Error("not used");
        },
        settings: async () => {
          throw new Error("not used");
        },
        engine: (c) => {
          if (engine === null) throw new Error("the engine is not started");
          return engine.handle(c);
        },
      });
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const window = () => new EngineStore(createEngineClient(bridge, "window"));
  return { window, notices, snapshots: () => snapshots, startEngine };
}

describe("HostNotices", () => {
  test("builds contract notices with an id and a time, oldest first", () => {
    let n = 0;
    const notices = new HostNotices({ newId: () => `notice-${String(++n).padStart(4, "0")}`, clock: () => Date.parse("2026-09-24T10:00:00.000Z") });
    notices.add("settings-reset", CORRUPT);
    notices.add("engine-restarted", CRASH);
    expect(notices.all).toEqual([
      { noticeId: "notice-0001", code: "settings-reset", detail: CORRUPT, at: "2026-09-24T10:00:00.000Z", count: 1 },
      { noticeId: "notice-0002", code: "engine-restarted", detail: CRASH, at: "2026-09-24T10:00:00.000Z", count: 1 },
    ]);
    expect(notices.all.every((notice) => EngineNotice.safeParse(notice).success)).toBe(true);
  });

  test("a notice that happens again replaces the earlier one of its kind: a new id, the latest detail and time, and the count", () => {
    let n = 0;
    let clock = Date.parse("2026-09-24T10:00:00.000Z");
    const notices = new HostNotices({ newId: () => `notice-${String(++n).padStart(4, "0")}`, clock: () => (clock += 60_000) });
    notices.add("settings-reset", CORRUPT);
    notices.add("engine-restarted", "the engine exited unexpectedly (code 9); restarting it");
    notices.add("engine-restarted", "the engine exited unexpectedly (code 11); restarting it");

    expect(notices.all).toEqual([
      { noticeId: "notice-0001", code: "settings-reset", detail: CORRUPT, at: "2026-09-24T10:01:00.000Z", count: 1 },
      { noticeId: "notice-0003", code: "engine-restarted", detail: "the engine exited unexpectedly (code 11); restarting it", at: "2026-09-24T10:03:00.000Z", count: 2 },
    ]);
  });

  test("however often the engine restarts (the restart budget resets after healthy running), the list keeps one notice per kind", () => {
    let n = 0;
    const notices = new HostNotices({ newId: () => `notice-${String(++n).padStart(4, "0")}`, clock: () => 0 });
    for (let i = 0; i < 500; i++) notices.add("engine-restarted", CRASH);
    expect(notices.all).toHaveLength(1);
    expect(notices.all[0]?.count).toBe(500);
  });

  test("clips a detail to the contract's 500 chars, so a long diagnostic cannot break the engine's init", () => {
    const notices = new HostNotices({ newId: () => "notice-0001", clock: () => 0 });
    const [notice] = [notices.add("settings-reset", "x".repeat(2000))];
    expect(notice.detail?.length).toBe(500);
    expect(EngineNotice.safeParse(notice).success).toBe(true);
  });
});

describe("main's notices reach the renderer store through the engine's snapshot and stream", () => {
  test("a notice from startup (corrupt settings.json) is in the first snapshot, with one snapshot and no engine error", async () => {
    const h = await harness();
    h.notices.add("settings-reset", CORRUPT);
    await h.startEngine("boot-aaaa-0001");
    const store = h.window();
    const stop = store.start();
    await settle();

    expect(store.getView()).toMatchObject({ phase: "ready", bootId: "boot-aaaa-0001", engineError: null });
    expect(store.getView().notices).toMatchObject([{ code: "settings-reset", detail: CORRUPT }]);
    await settle(200);
    expect(h.snapshots()).toBe(1);
    stop();
  });

  test("after an engine restart the store resyncs once and ends with the crash notice", async () => {
    const h = await harness();
    await h.startEngine("boot-aaaa-0001");
    const store = h.window();
    const stop = store.start();
    await settle();
    expect(h.snapshots()).toBe(1);

    h.notices.add("engine-restarted", CRASH);
    await h.startEngine("boot-bbbb-0002");
    await settle();

    expect(store.getView()).toMatchObject({ phase: "ready", bootId: "boot-bbbb-0002", engineError: null });
    expect(store.getView().notices).toMatchObject([{ code: "engine-restarted", detail: CRASH }]);
    expect(h.snapshots()).toBe(2);
    await settle(200);
    expect(h.snapshots()).toBe(2);
    stop();
  });

  test("a window opened after the notices were emitted still shows them", async () => {
    const h = await harness();
    h.notices.add("settings-reset", CORRUPT);
    await h.startEngine("boot-aaaa-0001");
    const first = h.window();
    const stopFirst = first.start();
    await settle();
    stopFirst();

    const later = h.window();
    const stopLater = later.start();
    await settle();
    expect(later.getView().notices).toMatchObject([{ code: "settings-reset" }]);
    stopLater();
  });

  test("a restarted engine gets every notice of the session again, not only the new one", async () => {
    const h = await harness();
    h.notices.add("settings-reset", CORRUPT);
    await h.startEngine("boot-aaaa-0001");
    h.notices.add("engine-restarted", CRASH);
    await h.startEngine("boot-bbbb-0002");

    const store = h.window();
    const stop = store.start();
    await settle();
    expect(store.getView().notices.map((n) => n.code)).toEqual(["settings-reset", "engine-restarted"]);
    stop();
  });
});
