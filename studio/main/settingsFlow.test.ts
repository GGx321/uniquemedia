import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandMessage, ResponseMessage, type ApiKeyStatus, type EngineCommandMessage } from "../shared/engine";
import type { HostControl } from "../engine/control";
import { handleSettingsCommand, isSettingsCommand, reconcileLibraryPath, type LibraryReconcileDeps, type SettingsCommand, type SettingsFlowDeps } from "./settingsFlow";
import { loadSettings, SettingsStore } from "./settingsStore";

const KEY_STATUS: ApiKeyStatus = { stored: true, last4: "wxyz", encryptionAvailable: true, rejected: false };

let userData = "";
beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), "studio-settings-flow-"));
});
afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

interface Harness {
  deps: SettingsFlowDeps;
  store: SettingsStore;
  sent: HostControl[];
  engineRequests: EngineCommandMessage[];
  picks: string[];
  opened: string[];
  confirmed: string[];
}

/** An engine that answers settings.get from the last settings.update it got (as the real one does). */
async function harness(
  options: { pick?: string | null; openFails?: boolean; confirmFails?: boolean; engineDown?: boolean } = {},
): Promise<Harness> {
  const { store } = await SettingsStore.open(userData);
  const sent: HostControl[] = [];
  const engineRequests: EngineCommandMessage[] = [];
  const picks: string[] = [];
  const opened: string[] = [];
  const confirmed: string[] = [];
  let engineSettings = store.current;
  let n = 0;
  const deps: SettingsFlowDeps = {
    settings: store,
    engine: {
      send: (control) => {
        sent.push(control);
        if (control.type === "settings.update") engineSettings = control.settings;
      },
      request: async (command) => {
        engineRequests.push(command);
        if (options.engineDown) return { v: 1, id: command.id, kind: "response", type: command.type, ok: false, error: { code: "INTERNAL", detail: "the engine is not running" } };
        return { v: 1, id: command.id, kind: "response", type: "settings.get", ok: true, result: { apiKey: { ...KEY_STATUS, rejected: true }, ...engineSettings } };
      },
      openLibrary: async (path) => {
        if (options.engineDown) return { code: "INTERNAL", detail: "the engine is not running" };
        if (options.openFails) return { code: "VALIDATION", detail: `${path} is not empty and holds no library` };
        opened.push(path);
        return null;
      },
      confirmLibrary: async (path) => {
        if (options.engineDown) return { code: "INTERNAL", detail: "the engine is not running" };
        if (options.confirmFails) return { code: "IN_FLIGHT", detail: "paid requests, or a pick or archive, are in flight" };
        confirmed.push(path);
        return null;
      },
    },
    pickFolder: async (defaultPath) => {
      picks.push(defaultPath);
      return options.pick === undefined ? join(userData, "picked") : options.pick;
    },
    keyStatus: () => KEY_STATUS,
    newId: () => `internal-${String(++n).padStart(4, "0")}`,
  };
  return { deps, store, sent, engineRequests, picks, opened, confirmed };
}

/** Built through the T0 schema, so a test never sends a command the contract would refuse. */
function command(type: SettingsCommand["type"], payload: unknown): SettingsCommand {
  const parsed = CommandMessage.parse({ v: 1, id: "cmd-set-00001", kind: "command", type, payload });
  if (!isSettingsCommand(parsed)) throw new Error(`${type} is not a settings command`);
  return parsed;
}

describe("settings.setBudget / setModels / setConcurrency", () => {
  test("persist first, update main's settings, tell the engine, and answer with the engine's view", async () => {
    const h = await harness();
    const response = await handleSettingsCommand(command("settings.setBudget", { monthlyBudgetMicros: 25_000_000 }), h.deps);

    expect(ResponseMessage.safeParse(response).success).toBe(true);
    expect(response).toMatchObject({ ok: true, id: "cmd-set-00001", type: "settings.setBudget", result: { monthlyBudgetMicros: 25_000_000, apiKey: { rejected: true } } });
    expect((await loadSettings(userData)).settings.monthlyBudgetMicros).toBe(25_000_000);
    expect(h.store.current.monthlyBudgetMicros).toBe(25_000_000);
    expect(h.sent).toEqual([{ kind: "control", type: "settings.update", settings: h.store.current }]);
    expect(h.engineRequests.map((c) => c.type)).toEqual(["settings.get"]);
  });

  test("models and concurrency change only their own fields", async () => {
    const h = await harness();
    await handleSettingsCommand(command("settings.setModels", { imageModel: "bytedance/seedream-5-pro", textModel: "x-ai/grok-5" }), h.deps);
    await handleSettingsCommand(command("settings.setConcurrency", { network: 3 }), h.deps);
    expect(h.store.current).toMatchObject({ imageModel: "bytedance/seedream-5-pro", textModel: "x-ai/grok-5", concurrency: { network: 3 }, monthlyBudgetMicros: 10_000_000 });
  });

  test("with the engine down the answer is built from main's own settings and key status", async () => {
    const h = await harness({ engineDown: true });
    const response = await handleSettingsCommand(command("settings.setConcurrency", { network: 2 }), h.deps);
    expect(response).toMatchObject({ ok: true, result: { apiKey: KEY_STATUS, concurrency: { network: 2 } } });
    expect(ResponseMessage.safeParse(response).success).toBe(true);
  });

  test("concurrent changes are applied one after another, none is lost", async () => {
    const h = await harness();
    await Promise.all([
      handleSettingsCommand(command("settings.setBudget", { monthlyBudgetMicros: 1_000_000 }), h.deps),
      handleSettingsCommand(command("settings.setConcurrency", { network: 4 }), h.deps),
      handleSettingsCommand(command("settings.setModels", { imageModel: "x-ai/grok-imagine-image-2.0", textModel: "x-ai/grok-5" }), h.deps),
    ]);
    expect((await loadSettings(userData)).settings).toMatchObject({ monthlyBudgetMicros: 1_000_000, concurrency: { network: 4 }, textModel: "x-ai/grok-5" });
  });
});

describe("settings.setLibraryPath", () => {
  test("the folder comes from main's dialog; the renderer's path is only where the dialog starts", async () => {
    const h = await harness({ pick: join(userData, "chosen") });
    const response = await handleSettingsCommand(command("settings.setLibraryPath", { path: "/etc/evil" }), h.deps);

    expect(h.picks).toEqual(["/etc/evil"]);
    expect(h.opened).toEqual([join(userData, "chosen")]);
    expect(h.confirmed).toEqual([join(userData, "chosen")]);
    expect(h.store.current.libraryPath).toBe(join(userData, "chosen"));
    expect(response).toMatchObject({ ok: true, type: "settings.setLibraryPath", result: { libraryPath: join(userData, "chosen") } });
    expect(h.sent).toEqual([{ kind: "control", type: "settings.update", settings: h.store.current }]);
  });

  test("a confirm the engine refuses with IN_FLIGHT surfaces as the command's error, and nothing is persisted", async () => {
    const h = await harness({ confirmFails: true });
    const before = h.store.current;
    const response = await handleSettingsCommand(command("settings.setLibraryPath", { path: "/Users/me/Studio" }), h.deps);

    expect(response).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });
    expect(ResponseMessage.safeParse(response).success).toBe(true);
    expect(h.opened).toEqual([join(userData, "picked")]);
    expect(h.confirmed).toEqual([]);
    expect(h.store.current).toEqual(before);
    expect((await loadSettings(userData)).settings).toEqual(before);
    expect(h.sent).toEqual([]);
  });

  test("a cancelled dialog changes nothing and answers with the current settings", async () => {
    const h = await harness({ pick: null });
    const before = h.store.current;
    const response = await handleSettingsCommand(command("settings.setLibraryPath", { path: "/Users/me/Studio" }), h.deps);
    expect(response).toMatchObject({ ok: true, result: { libraryPath: before.libraryPath } });
    expect(h.store.current).toEqual(before);
    expect(h.opened).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  test("with the engine down the library cannot be checked, so nothing changes", async () => {
    const h = await harness({ engineDown: true });
    const before = h.store.current;
    const response = await handleSettingsCommand(command("settings.setLibraryPath", { path: "/Users/me/Studio" }), h.deps);
    expect(response).toMatchObject({ ok: false, error: { code: "INTERNAL", detail: "the engine is not running" } });
    expect(h.store.current).toEqual(before);
    expect((await loadSettings(userData)).settings).toEqual(before);
    expect(h.sent).toEqual([]);
  });

  test("a folder that cannot hold a library is refused by the engine and nothing changes", async () => {
    const h = await harness({ openFails: true });
    const before = h.store.current;
    const response = await handleSettingsCommand(command("settings.setLibraryPath", { path: "/Users/me/Studio" }), h.deps);
    expect(response).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(ResponseMessage.safeParse(response).success).toBe(true);
    expect(h.store.current).toEqual(before);
    expect(h.sent).toEqual([]);
  });

  test("a relative path from the dialog is refused", async () => {
    const h = await harness({ pick: "relative/folder" });
    const response = await handleSettingsCommand(command("settings.setLibraryPath", { path: "/Users/me/Studio" }), h.deps);
    expect(response).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(h.opened).toEqual([]);
  });
});

// A `settings.changed` event whose libraryPath disagrees with
// settings.current means a confirm main gave up on (engineHost.ts's 30 s
// deadline) still landed in the engine. The engine is the source of truth.
describe("reconcileLibraryPath", () => {
  test("does nothing when the event's path already matches settings.current: no engine request, nothing saved", async () => {
    const h = await harness();

    await reconcileLibraryPath({ libraryPath: h.store.current.libraryPath }, h.deps);

    expect(h.engineRequests).toEqual([]);
  });

  test("persists the engine's own reported path, not the event's, since it may already be stale", async () => {
    const h = await harness();
    const enginePath = join(userData, "engine-actual-library");
    // The engine now reports a folder settings.current does not name yet
    // (a confirm landed after main gave up on it).
    h.deps.engine.send({ kind: "control", type: "settings.update", settings: { ...h.store.current, libraryPath: enginePath } });

    // The event that triggered this carried a now-stale path (e.g. an even
    // later switch already moved past it); reconcile re-reads instead of trusting it.
    await reconcileLibraryPath({ libraryPath: join(userData, "stale-event-path") }, h.deps);

    expect(h.engineRequests.map((c) => c.type)).toEqual(["settings.get"]);
    expect(h.store.current.libraryPath).toBe(enginePath);
    expect((await loadSettings(userData)).settings.libraryPath).toBe(enginePath);
  });

  test("queues behind a settings command already in flight, and re-reads: it does not clobber that command's own outcome", async () => {
    const h = await harness({ pick: join(userData, "picked-by-command") });
    // A settings.setLibraryPath is already running (holds the exclusive
    // lock); its own picked path is what the engine will report by the time
    // reconcile gets its turn.
    const commanding = handleSettingsCommand(command("settings.setLibraryPath", { path: "/Users/me/Studio" }), h.deps);
    // A settings.changed naming some other, already-superseded path arrives concurrently.
    const reconciling = reconcileLibraryPath({ libraryPath: join(userData, "superseded") }, h.deps);

    await commanding;
    await reconciling;

    // The in-flight command's own outcome stands; reconcile's re-read agreed and changed nothing further.
    expect(h.store.current.libraryPath).toBe(join(userData, "picked-by-command"));
    expect((await loadSettings(userData)).settings.libraryPath).toBe(join(userData, "picked-by-command"));
  });

  test("is genuinely excluded while a settings command holds the lock, not just coincidentally finishing after it", async () => {
    const h = await harness({ pick: join(userData, "picked-by-command") });
    // Gates the command inside its own exclusive-held work (pickFolder is
    // the first await `nextSettings` makes for settings.setLibraryPath), so
    // nothing about the command's own engine.request has happened yet.
    let releasePick: () => void = () => {};
    const pickGate = new Promise<void>((r) => (releasePick = r));
    const originalPickFolder = h.deps.pickFolder;
    h.deps.pickFolder = async (defaultPath) => {
      await pickGate;
      return originalPickFolder(defaultPath);
    };

    const commanding = handleSettingsCommand(command("settings.setLibraryPath", { path: "/Users/me/Studio" }), h.deps);
    const reconciling = reconcileLibraryPath({ libraryPath: join(userData, "superseded") }, h.deps);
    for (let i = 0; i < 200; i++) await Promise.resolve(); // let reconcile run as far as it can on its own

    // If reconcile were not queued behind the command's own lock, it would
    // already have made its own engine.request by now, racing ahead of the
    // command that is still gated at its very first step.
    expect(h.engineRequests).toEqual([]);

    releasePick();
    await commanding;
    await reconciling;
    expect(h.engineRequests.length).toBeGreaterThan(0);
  });

  test("with the engine down, changes nothing rather than throwing", async () => {
    const h = await harness({ engineDown: true });
    const before = h.store.current;

    await reconcileLibraryPath({ libraryPath: join(userData, "somewhere-else") }, h.deps);

    expect(h.store.current).toEqual(before);
  });

  test("a second reconcile arriving while the first is still saving re-reads settings.current fresh, rather than trusting a value read before the first's save landed", async () => {
    const { store } = await SettingsStore.open(userData);
    const A = store.current.libraryPath;
    const B = join(userData, "b");
    let enginePath = B; // a first confirm switched the engine to B
    let n = 0;
    const deps: LibraryReconcileDeps = {
      settings: store,
      engine: {
        request: async (c) => ({ v: 1, id: c.id, kind: "response", type: "settings.get", ok: true, result: { apiKey: KEY_STATUS, ...store.current, libraryPath: enginePath } }),
      },
      newId: () => `internal-${String(++n).padStart(4, "0")}`,
    };
    // Holds the first reconcile's own save open, so a second one can start while store.current is still stale (A).
    let saving: () => void = () => {};
    const inSave = new Promise<void>((r) => (saving = r));
    let finishSave: () => void = () => {};
    const saveGate = new Promise<void>((r) => (finishSave = r));
    const realSave = store.save.bind(store);
    store.save = async (next) => {
      saving();
      await saveGate;
      return realSave(next);
    };

    const r1 = reconcileLibraryPath({ libraryPath: B }, deps); // the event that reported the switch to B
    await inSave; // r1 read B from the engine and is writing settings.json; store.current is still A
    // Meanwhile the engine commits a switch back to A (e.g. a queued settings.update(A)) and emits a second event.
    enginePath = A;
    const r2 = reconcileLibraryPath({ libraryPath: A }, deps);
    finishSave();
    await r1;
    await r2;

    // main (and studio-media://) converge on the engine's actual folder, A:
    // r2 must not have skipped itself by comparing A against a `current`
    // still holding the pre-r1-save value (which also happened to be A).
    expect(enginePath).toBe(A);
    expect(store.current.libraryPath).toBe(A);
    expect((await loadSettings(userData)).settings.libraryPath).toBe(A);
  });
});
