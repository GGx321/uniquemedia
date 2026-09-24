import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandMessage, ResponseMessage, type ApiKeyStatus, type EngineCommandMessage } from "../shared/engine";
import type { HostControl } from "../engine/control";
import { handleSettingsCommand, isSettingsCommand, type SettingsCommand, type SettingsFlowDeps } from "./settingsFlow";
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
}

/** An engine that answers settings.get from the last settings.update it got (as the real one does). */
async function harness(options: { pick?: string | null; openFails?: boolean; engineDown?: boolean } = {}): Promise<Harness> {
  const { store } = await SettingsStore.open(userData);
  const sent: HostControl[] = [];
  const engineRequests: EngineCommandMessage[] = [];
  const picks: string[] = [];
  const opened: string[] = [];
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
    },
    pickFolder: async (defaultPath) => {
      picks.push(defaultPath);
      return options.pick === undefined ? join(userData, "picked") : options.pick;
    },
    keyStatus: () => KEY_STATUS,
    newId: () => `internal-${String(++n).padStart(4, "0")}`,
  };
  return { deps, store, sent, engineRequests, picks, opened };
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
    expect(h.store.current.libraryPath).toBe(join(userData, "chosen"));
    expect(response).toMatchObject({ ok: true, type: "settings.setLibraryPath", result: { libraryPath: join(userData, "chosen") } });
    expect(h.sent).toEqual([{ kind: "control", type: "settings.update", settings: h.store.current }]);
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
