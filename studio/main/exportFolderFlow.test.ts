import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { CommandMessage, PROTOCOL_VERSION, ResponseMessage, type ApiKeyStatus, type EngineCommandMessage, type EngineError, type MusicKeyStatus } from "../shared/engine";
import type { HostControl } from "../engine/control";
import { displayPath, handleExportFolderCommand, isExportFolderCommand, type ExportChoice, type ExportFolderCommand, type ExportFolderFlowDeps } from "./exportFolderFlow";
import { handleSettingsCommand, isSettingsCommand } from "./settingsFlow";
import { loadSettings, SettingsStore } from "./settingsStore";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// 3e.3 in main: the owner's pick of the export folder. Main opens its own dialog (the window never names a folder), asks the
// engine what the pick is (`export.choose`), and only after an ok reply persists the path and sends `settings.update`.

const KEY_STATUS: ApiKeyStatus = { stored: true, last4: "wxyz", encryptionAvailable: true, rejected: false };
const MUSIC_STATUS: MusicKeyStatus = { stored: true, last4: "0000", rejected: false };
const ROOT_ID = "root-00000001";

let userData = "";
beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), "studio-export-folder-flow-"));
});
afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

interface Harness {
  deps: ExportFolderFlowDeps;
  store: SettingsStore;
  sent: HostControl[];
  picks: string[];
  chosen: string[];
  engineRequests: EngineCommandMessage[];
}

async function harness(options: { pick?: string | null; choice?: ExportChoice | ((path: string) => ExportChoice); home?: string; platform?: NodeJS.Platform } = {}): Promise<Harness> {
  const { store } = await SettingsStore.open(userData);
  const sent: HostControl[] = [];
  const picks: string[] = [];
  const chosen: string[] = [];
  const engineRequests: EngineCommandMessage[] = [];
  let engineSettings = store.current;
  let n = 0;
  const deps: ExportFolderFlowDeps = {
    settings: store,
    engine: {
      send: (control) => {
        sent.push(control);
        if (control.type === "settings.update") engineSettings = control.settings;
      },
      request: async (command) => {
        engineRequests.push(command);
        return { v: PROTOCOL_VERSION, id: command.id, kind: "response", type: "settings.get", ok: true, result: { apiKey: KEY_STATUS, musicKey: MUSIC_STATUS, ...engineSettings } };
      },
      chooseExport: async (path) => {
        chosen.push(path);
        const choice = options.choice ?? { error: null, exportFolder: { rootId: ROOT_ID, resolved: 3, elsewhere: 1, incomplete: false } };
        return typeof choice === "function" ? choice(path) : choice;
      },
    },
    pickFolder: async (defaultPath) => {
      picks.push(defaultPath);
      return options.pick === undefined ? join(userData, "picked") : options.pick;
    },
    keyStatus: () => KEY_STATUS,
    musicKeyStatus: () => MUSIC_STATUS,
    newId: () => `internal-${String(++n).padStart(4, "0")}`,
    home: () => options.home ?? "/Users/alex",
    platform: options.platform ?? process.platform,
  };
  return { deps, store, sent, picks, chosen, engineRequests };
}

function command(type: ExportFolderCommand["type"], payload: unknown = {}): ExportFolderCommand {
  const parsed = CommandMessage.parse({ v: PROTOCOL_VERSION, id: "cmd-exp-00001", kind: "command", type, payload });
  if (!isExportFolderCommand(parsed)) throw new Error(`${type} is not an export folder command`);
  return parsed;
}

const refused = (error: EngineError): ExportChoice => ({ error });

describe("settings.setExportPath: the dialog", () => {
  test("opens at the current export folder, and never at a path the window named", async () => {
    const h = await harness({ pick: null });
    await handleExportFolderCommand(command("settings.setExportPath"), h.deps);

    expect(h.picks).toEqual([h.store.current.exportPath]);
  });

  test("a cancelled dialog answers picked: false and changes nothing: the engine is not asked, nothing is saved or sent", async () => {
    const h = await harness({ pick: null });
    const before = h.store.current;

    const response = await handleExportFolderCommand(command("settings.setExportPath"), h.deps);

    expect(response).toEqual({ v: PROTOCOL_VERSION, id: "cmd-exp-00001", kind: "response", type: "settings.setExportPath", ok: true, result: { picked: false } });
    expect(ResponseMessage.safeParse(response).success).toBe(true);
    expect(h.chosen).toEqual([]);
    expect(h.sent).toEqual([]);
    expect(h.store.current).toEqual(before);
    expect(await loadSettings(userData)).toMatchObject({ settings: before });
  });

  test("a pick that is not an absolute path is refused with VALIDATION and the engine is not asked", async () => {
    const h = await harness({ pick: "Reels" });

    const response = await handleExportFolderCommand(command("settings.setExportPath"), h.deps);

    expect(response).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(h.chosen).toEqual([]);
    expect(h.sent).toEqual([]);
  });
});

describe("settings.setExportPath: a pick the engine accepts", () => {
  test("asks the engine about the picked folder, persists it first, tells the engine, and answers with the engine's counts and view of the settings", async () => {
    const picked = join(userData, "Reels");
    const h = await harness({ pick: picked });

    const response = await handleExportFolderCommand(command("settings.setExportPath"), h.deps);

    expect(ResponseMessage.safeParse(response).success).toBe(true);
    expect(response).toMatchObject({
      ok: true,
      id: "cmd-exp-00001",
      type: "settings.setExportPath",
      result: { picked: true, rootId: ROOT_ID, resolved: 3, elsewhere: 1, incomplete: false, settings: { exportPath: picked, apiKey: KEY_STATUS } },
    });
    expect(h.chosen).toEqual([picked]);
    expect((await loadSettings(userData)).settings.exportPath).toBe(picked);
    expect(h.store.current.exportPath).toBe(picked);
    expect(h.sent).toEqual([{ kind: "control", type: "settings.update", settings: h.store.current }]);
  });

  test("changes only the export folder", async () => {
    const h = await harness({ pick: join(userData, "Reels") });
    const before = h.store.current;

    await handleExportFolderCommand(command("settings.setExportPath"), h.deps);

    expect(h.store.current).toEqual({ ...before, exportPath: join(userData, "Reels") });
    expect(h.store.current.libraryPath).toBe(before.libraryPath);
  });

  test("picking the folder already in use still answers its counts, and keeps it", async () => {
    const h = await harness({});
    const current = h.store.current.exportPath;
    // The dialog opens at the current folder, and the owner confirms it as it is.
    const deps: ExportFolderFlowDeps = { ...h.deps, pickFolder: async (defaultPath) => defaultPath };

    const response = await handleExportFolderCommand(command("settings.setExportPath"), deps);

    expect(response).toMatchObject({ ok: true, result: { picked: true, resolved: 3, elsewhere: 1, settings: { exportPath: current } } });
    expect(h.store.current.exportPath).toBe(current);
  });

  test("is queued with the other settings commands, so neither change is lost to a stale copy of the settings", async () => {
    const h = await harness({ pick: join(userData, "Reels") });
    const budget = CommandMessage.parse({ v: PROTOCOL_VERSION, id: "cmd-bud-00001", kind: "command", type: "settings.setBudget", payload: { monthlyBudgetMicros: 7_000_000 } });
    if (!isSettingsCommand(budget)) throw new Error("settings.setBudget is a settings command");
    const settingsDeps = { ...h.deps, engine: { ...h.deps.engine, openLibrary: async () => null, confirmLibrary: async () => null } };

    await Promise.all([handleExportFolderCommand(command("settings.setExportPath"), h.deps), handleSettingsCommand(budget, settingsDeps)]);

    expect(h.store.current).toMatchObject({ exportPath: join(userData, "Reels"), monthlyBudgetMicros: 7_000_000 });
    expect((await loadSettings(userData)).settings).toMatchObject({ exportPath: join(userData, "Reels"), monthlyBudgetMicros: 7_000_000 });
  });
});

describe("settings.setExportPath: a pick the engine refuses", () => {
  test.each(["missing", "not-a-directory", "not-writable", "overlaps-library", "invalid-marker", "invalid-marker-with-records", "newer-marker"] as const)(
    "%s is answered with EXPORT_UNAVAILABLE and its reason, and nothing is saved or sent",
    async (exportReason) => {
      const h = await harness({ pick: join(userData, "Reels"), choice: refused({ code: "EXPORT_UNAVAILABLE", exportReason, detail: "the folder cannot be the export folder" }) });
      const before = h.store.current;

      const response = await handleExportFolderCommand(command("settings.setExportPath"), h.deps);

      expect(ResponseMessage.safeParse(response).success).toBe(true);
      expect(response).toMatchObject({ ok: false, type: "settings.setExportPath", error: { code: "EXPORT_UNAVAILABLE", exportReason } });
      expect(h.sent).toEqual([]);
      expect(h.store.current).toEqual(before);
      expect(await loadSettings(userData)).toMatchObject({ settings: before });
    },
  );

  test("IN_FLIGHT (a render is queued or running) is passed on, and nothing changes", async () => {
    const h = await harness({ pick: join(userData, "Reels"), choice: refused({ code: "IN_FLIGHT", detail: "a video render is queued or running" }) });
    const before = h.store.current;

    const response = await handleExportFolderCommand(command("settings.setExportPath"), h.deps);

    expect(response).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });
    expect(h.sent).toEqual([]);
    expect(h.store.current).toEqual(before);
    expect(await loadSettings(userData)).toMatchObject({ settings: before });
  });

  test("an answer that says its counts are incomplete passes that on: the window must not claim that every video is there", async () => {
    const h = await harness({ pick: join(userData, "Reels"), choice: { error: null, exportFolder: { rootId: ROOT_ID, resolved: 2, elsewhere: 0, incomplete: true } } });

    const response = await handleExportFolderCommand(command("settings.setExportPath"), h.deps);

    expect(ResponseMessage.safeParse(response).success).toBe(true);
    expect(response).toMatchObject({ ok: true, result: { picked: true, resolved: 2, elsewhere: 0, incomplete: true } });
  });

  test("an engine that does not answer (INTERNAL) is passed on, and nothing changes", async () => {
    const h = await harness({ pick: join(userData, "Reels"), choice: refused({ code: "INTERNAL", detail: "the engine is not running" }) });
    const before = h.store.current;

    const response = await handleExportFolderCommand(command("settings.setExportPath"), h.deps);

    expect(response).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    expect(h.store.current).toEqual(before);
  });

  test("an ok reply with no folder in it is INTERNAL, not a silent switch", async () => {
    const h = await harness({ pick: join(userData, "Reels"), choice: { error: null } });
    const before = h.store.current;

    const response = await handleExportFolderCommand(command("settings.setExportPath"), h.deps);

    expect(response).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    expect(h.store.current).toEqual(before);
    expect(h.sent).toEqual([]);
  });

  test("settings.json that cannot be written is INTERNAL, and the engine is not told", async () => {
    const h = await harness({ pick: join(userData, "Reels") });
    await rm(userData, { recursive: true, force: true });
    await Bun.write(userData, "a file where the folder was");

    const response = await handleExportFolderCommand(command("settings.setExportPath"), h.deps);

    expect(response).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    expect(h.sent).toEqual([]);
    await rm(userData, { force: true });
  });
});

describe("settings.exportDisplay", () => {
  test("answers the export folder as a person reads it, from main's own copy of the settings", async () => {
    const h = await harness({ home: "/Users/alex", platform: "darwin" });
    await h.store.save({ ...h.store.current, exportPath: "/Users/alex/Studio/export" });

    const response = await handleExportFolderCommand(command("settings.exportDisplay"), h.deps);

    expect(ResponseMessage.safeParse(response).success).toBe(true);
    expect(response).toMatchObject({ ok: true, type: "settings.exportDisplay", result: { display: "~/Studio/export" } });
    expect(h.picks).toEqual([]);
    expect(h.chosen).toEqual([]);
  });

  test("follows a pick", async () => {
    const h = await harness({ home: userData, pick: join(userData, "Reels") });
    await handleExportFolderCommand(command("settings.setExportPath"), h.deps);

    const response = await handleExportFolderCommand(command("settings.exportDisplay"), h.deps);

    expect(response).toMatchObject({ ok: true, result: { display: `~${sep}Reels` } });
  });
});

describe("displayPath", () => {
  const posix = (path: string, home = "/Users/alex") => displayPath(path, { home, platform: "darwin" });
  const win = (path: string, home = "C:\\Users\\Alex") => displayPath(path, { home, platform: "win32" });

  test("shows the home folder as «~»", () => {
    expect(posix("/Users/alex/Studio/export")).toBe("~/Studio/export");
    expect(posix("/Users/alex")).toBe("~");
  });

  test("leaves a folder outside home as it is, and a sibling that merely starts with the same letters", () => {
    expect(posix("/Volumes/Reels")).toBe("/Volumes/Reels");
    expect(posix("/Users/alexander/Reels")).toBe("/Users/alexander/Reels");
  });

  test("does not mind a trailing slash on home, and keeps non-Latin names whole", () => {
    expect(posix("/Users/alex/Готовые видео", "/Users/alex/")).toBe("~/Готовые видео");
  });

  test("on macOS and Linux letter case matters: another spelling of home is another folder, and is shown whole", () => {
    expect(posix("/users/alex/Studio")).toBe("/users/alex/Studio");
  });

  test("on Windows the drive letter and the folder names fold case, and the separator stays a backslash", () => {
    expect(win("C:\\Users\\Alex\\Studio\\export")).toBe("~\\Studio\\export");
    expect(win("c:\\users\\alex\\Reels")).toBe("~\\Reels");
    expect(win("C:\\Users\\Alex")).toBe("~");
  });

  test("on Windows a second volume and a sibling of home are shown whole", () => {
    expect(win("D:\\Reels")).toBe("D:\\Reels");
    expect(win("C:\\Users\\Alexandra\\Reels")).toBe("C:\\Users\\Alexandra\\Reels");
  });

  test("a home that is empty or relative never hides anything", () => {
    expect(posix("/Users/alex/Reels", "")).toBe("/Users/alex/Reels");
    expect(posix("/Users/alex/Reels", "alex")).toBe("/Users/alex/Reels");
  });
});
