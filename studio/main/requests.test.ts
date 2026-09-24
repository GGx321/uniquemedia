import { describe, expect, test } from "bun:test";
import { ResponseMessage, type EngineCommandMessage } from "../shared/engine";
import type { KeyCommand } from "./keyFlow";
import type { SettingsCommand } from "./settingsFlow";
import { handleRendererRequest, isTrustedSender, type RequestRoutes, type SenderFrame, type TrustedRenderer } from "./requests";

// A renderer URL with a drive letter is an absolute path on every platform
// ("/C:/…" off Windows, "C:\…" on it), so the request path's tests hold on the
// Windows runner as on macOS. A URL without one is no path at all on Windows.
const FILE_URL = "file:///C:/Program%20Files/Studio/resources/app.asar/out-studio/renderer/index.html";
const MAC_FILE_URL = "file:///Applications/Studio.app/Contents/Resources/app.asar/out-studio/renderer/index.html";
const PLATFORMS: NodeJS.Platform[] = ["darwin", "linux", "win32"];
const PACKAGED: TrustedRenderer = { fileUrl: FILE_URL };
const DEV: TrustedRenderer = { devServerUrl: "http://localhost:5173/", fileUrl: FILE_URL };
const APP_FRAME: SenderFrame = { url: FILE_URL, isTopFrame: true, isAppWindow: true };
const KEY = "sk-or-v1-0123456789abcdef-wxyz";

function routesSpy() {
  const mainOnly: KeyCommand[] = [];
  const settings: SettingsCommand[] = [];
  const engine: EngineCommandMessage[] = [];
  const routes: RequestRoutes = {
    mainOnly: async (command) => {
      mainOnly.push(command);
      return { v: 1, id: command.id, kind: "response", type: command.type, ok: true, result: { stored: false, last4: null, encryptionAvailable: true, rejected: false } };
    },
    settings: async (command) => {
      settings.push(command);
      return { v: 1, id: command.id, kind: "response", type: command.type, ok: false, error: { code: "INTERNAL", detail: "stub" } };
    },
    engine: async (command) => {
      engine.push(command);
      return { v: 1, id: command.id, kind: "response", type: command.type, ok: false, error: { code: "INTERNAL", detail: "stub" } };
    },
  };
  return { routes, mainOnly, settings, engine };
}

function command(type: string, payload: unknown = {}, id = "cmd-00000001"): unknown {
  return { v: 1, id, kind: "command", type, payload };
}

describe("isTrustedSender", () => {
  test("the renderer URL these tests use is the renderer on every platform, so they hold on the Windows runner too", () => {
    for (const platform of PLATFORMS) expect(isTrustedSender(APP_FRAME, PACKAGED, platform)).toBe(true);
  });

  for (const platform of PLATFORMS) {
    test(`accepts the packaged renderer file, with or without a fragment or query (${platform})`, () => {
      expect(isTrustedSender(APP_FRAME, PACKAGED, platform)).toBe(true);
      expect(isTrustedSender({ ...APP_FRAME, url: `${FILE_URL}#/avatars` }, PACKAGED, platform)).toBe(true);
      expect(isTrustedSender({ ...APP_FRAME, url: `${FILE_URL}?x=1` }, PACKAGED, platform)).toBe(true);
    });
  }

  const rejected: [string, SenderFrame, TrustedRenderer][] = [
    ["an iframe", { ...APP_FRAME, isTopFrame: false }, PACKAGED],
    ["a frame that is not an app window's main frame", { ...APP_FRAME, isAppWindow: false }, PACKAGED],
    ["a frame that is gone", { ...APP_FRAME, url: null }, PACKAGED],
    ["another file", { ...APP_FRAME, url: "file:///C:/Users/Public/evil/index.html" }, PACKAGED],
    ["a sibling of the renderer", { ...APP_FRAME, url: FILE_URL.replace("index.html", "other.html") }, PACKAGED],
    ["the renderer's path on another host (a Windows share)", { ...APP_FRAME, url: FILE_URL.replace("file:///", "file://evil/") }, PACKAGED],
    ["the renderer's path under another scheme, with no host either", { ...APP_FRAME, url: FILE_URL.replace("file:", "studio-media:") }, PACKAGED],
    ["a web page", { ...APP_FRAME, url: "https://example.com/" }, PACKAGED],
    ["the dev server in a packaged run", { ...APP_FRAME, url: "http://localhost:5173/" }, PACKAGED],
    ["another origin in dev", { ...APP_FRAME, url: "http://localhost:5174/" }, DEV],
    ["the file URL in dev, when the dev server is the renderer", APP_FRAME, DEV],
    ["garbage", { ...APP_FRAME, url: "::::" }, PACKAGED],
  ];
  for (const platform of PLATFORMS) {
    for (const [name, frame, trusted] of rejected) {
      test(`rejects ${name} (${platform})`, () => {
        expect(isTrustedSender(frame, trusted, platform)).toBe(false);
      });
    }
  }

  for (const platform of PLATFORMS) {
    test(`compares file URLs as paths: percent-encoding and dot segments do not matter (${platform})`, () => {
      expect(isTrustedSender({ ...APP_FRAME, url: FILE_URL.replace("index.html", "index%2Ehtml") }, PACKAGED, platform)).toBe(true);
      expect(isTrustedSender({ ...APP_FRAME, url: FILE_URL.replace("renderer/", "main/../renderer/") }, PACKAGED, platform)).toBe(true);
      expect(isTrustedSender({ ...APP_FRAME, url: FILE_URL.replace("index.html", "index.html%2F..%2Fx") }, PACKAGED, platform)).toBe(false);
    });

    test(`an encoded backslash never leads to the renderer: a separator Windows refuses, a plain character elsewhere (${platform})`, () => {
      expect(isTrustedSender({ ...APP_FRAME, url: FILE_URL.replace("index.html", "x%5C..%5Cindex.html") }, PACKAGED, platform)).toBe(false);
      expect(isTrustedSender({ ...APP_FRAME, url: FILE_URL.replace("index.html", "x%5c..%5cindex.html") }, PACKAGED, platform)).toBe(false);
    });
  }

  test("the macOS app's renderer URL, which has no drive letter, is its renderer off Windows", () => {
    const trusted: TrustedRenderer = { fileUrl: MAC_FILE_URL };
    expect(isTrustedSender({ ...APP_FRAME, url: MAC_FILE_URL }, trusted, "darwin")).toBe(true);
    expect(isTrustedSender({ ...APP_FRAME, url: MAC_FILE_URL }, trusted, "linux")).toBe(true);
  });

  test("on Windows a file URL without a drive letter is not an absolute path, so it is never the renderer", () => {
    expect(isTrustedSender({ ...APP_FRAME, url: MAC_FILE_URL }, { fileUrl: MAC_FILE_URL }, "win32")).toBe(false);
  });

  test("on Windows the comparison ignores letter case; elsewhere it does not", () => {
    const trusted: TrustedRenderer = { fileUrl: "file:///C:/Program%20Files/Studio/resources/app.asar/out-studio/renderer/index.html" };
    const frame: SenderFrame = { ...APP_FRAME, url: "file:///c:/program%20files/studio/Resources/app.asar/out-studio/renderer/index.html" };
    expect(isTrustedSender(frame, trusted, "win32")).toBe(true);
    expect(isTrustedSender(frame, trusted, "darwin")).toBe(false);
  });

  describe("on Windows only ASCII letters fold: a sign JavaScript lowercases to a letter is another name to NTFS", () => {
    const rendererIn = (user: string) => `file:///C:/Users/${user}/AppData/Local/Programs/Studio/resources/app.asar/out-studio/renderer/index.html`;
    const signs: [string, string, string][] = [
      ["KELVIN SIGN (U+212A) is not k", "Nikita", "Ni%E2%84%AAita"],
      ["ANGSTROM SIGN (U+212B) is not å", "H%C3%A5kon", "H%E2%84%ABkon"],
      ["OHM SIGN (U+2126) is not ω", "%CF%89", "%E2%84%A6"],
    ];
    for (const [name, trusted, window] of signs) {
      test(name, () => {
        expect(isTrustedSender({ ...APP_FRAME, url: rendererIn(window) }, { fileUrl: rendererIn(trusted) }, "win32")).toBe(false);
      });
    }

    test("an ASCII difference of case, in the drive letter or a folder, still matches", () => {
      const window = rendererIn("NIKITA").replace("file:///C:/", "file:///c:/");
      expect(isTrustedSender({ ...APP_FRAME, url: window }, { fileUrl: rendererIn("Nikita") }, "win32")).toBe(true);
    });
  });

  test("accepts any path on the dev server's origin in dev", () => {
    expect(isTrustedSender({ ...APP_FRAME, url: "http://localhost:5173/index.html#x" }, DEV)).toBe(true);
  });
});

describe("handleRendererRequest", () => {
  test("a frame mismatch is rejected before anything is handled or forwarded", async () => {
    const { routes, mainOnly, engine } = routesSpy();
    for (const raw of [command("settings.get"), command("settings.setApiKey", { key: KEY })]) {
      const response = await handleRendererRequest(raw, { ...APP_FRAME, isTopFrame: false }, PACKAGED, routes);
      expect(response).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
      expect(ResponseMessage.safeParse(response).success).toBe(true);
    }
    expect(mainOnly).toEqual([]);
    expect(engine).toEqual([]);
  });

  test("a message that breaks the schema gets VALIDATION with its id and is not forwarded", async () => {
    const { routes, engine } = routesSpy();
    const cases: unknown[] = [
      null,
      "settings.get",
      { v: 2, id: "cmd-00000001", kind: "command", type: "settings.get", payload: {} },
      command("settings.get", { extra: true }),
      command("settings.setBudget", { monthlyBudgetMicros: 1.5 }),
      command("no.such.command"),
      command("settings.get", {}, "BAD ID"),
    ];
    for (const raw of cases) {
      const response = await handleRendererRequest(raw, APP_FRAME, PACKAGED, routes);
      expect(response).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
      expect(ResponseMessage.safeParse(response).success).toBe(true);
    }
    expect(engine).toEqual([]);
    expect(await handleRendererRequest(command("settings.get", { extra: true }, "cmd-keep-id-1"), APP_FRAME, PACKAGED, routes)).toMatchObject({ id: "cmd-keep-id-1", type: "settings.get" });
  });

  test("responses and events sent by the renderer are refused", async () => {
    const { routes, engine } = routesSpy();
    const event = { v: 1, id: "evt-00000001", kind: "event", seq: 1, bootId: "boot-00000001", type: "engine.error", payload: { error: { code: "INTERNAL" } } };
    const response = await handleRendererRequest(event, APP_FRAME, PACKAGED, routes);
    expect(response).toMatchObject({ ok: false, error: { code: "VALIDATION", detail: "only commands may be sent" } });
    expect(engine).toEqual([]);
  });

  test("main-only key commands are handled by main and never forwarded", async () => {
    const { routes, mainOnly, engine } = routesSpy();
    await handleRendererRequest(command("settings.setApiKey", { key: KEY }), APP_FRAME, PACKAGED, routes);
    await handleRendererRequest(command("settings.clearApiKey", {}, "cmd-00000002"), APP_FRAME, PACKAGED, routes);
    expect(mainOnly.map((c) => c.type)).toEqual(["settings.setApiKey", "settings.clearApiKey"]);
    expect(engine).toEqual([]);
  });

  test("a validation failure on a key command never echoes the key", async () => {
    const { routes, mainOnly } = routesSpy();
    const response = await handleRendererRequest(command("settings.setApiKey", { key: `${KEY} with spaces` }), APP_FRAME, PACKAGED, routes);
    expect(response).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(JSON.stringify(response)).not.toContain(KEY);
    expect(mainOnly).toEqual([]);
  });

  test("settings changes are answered by main, which owns settings.json, and never forwarded", async () => {
    const { routes, settings, engine } = routesSpy();
    await handleRendererRequest(command("settings.setBudget", { monthlyBudgetMicros: 5_000_000 }), APP_FRAME, PACKAGED, routes);
    await handleRendererRequest(command("settings.setModels", { imageModel: "x-ai/grok-imagine-image-2.0", textModel: "x-ai/grok-4.3" }, "cmd-00000002"), APP_FRAME, PACKAGED, routes);
    await handleRendererRequest(command("settings.setConcurrency", { network: 2 }, "cmd-00000003"), APP_FRAME, PACKAGED, routes);
    await handleRendererRequest(command("settings.setLibraryPath", { path: "/Users/me/Studio" }, "cmd-00000004"), APP_FRAME, PACKAGED, routes);
    expect(settings.map((c) => c.type)).toEqual(["settings.setBudget", "settings.setModels", "settings.setConcurrency", "settings.setLibraryPath"]);
    expect(engine).toEqual([]);
  });

  test("settings.get still goes to the engine", async () => {
    const { routes, settings, engine } = routesSpy();
    await handleRendererRequest(command("settings.get"), APP_FRAME, PACKAGED, routes);
    expect(settings).toEqual([]);
    expect(engine.map((c) => c.type)).toEqual(["settings.get"]);
  });

  test("engine commands are forwarded as parsed", async () => {
    const { routes, engine } = routesSpy();
    await handleRendererRequest(command("money.status"), APP_FRAME, PACKAGED, routes);
    expect(engine).toEqual([{ v: 1, id: "cmd-00000001", kind: "command", type: "money.status", payload: {} }]);
  });

  test("a route that throws becomes INTERNAL without the error's text", async () => {
    const routes: RequestRoutes = {
      mainOnly: async () => {
        throw new Error(`disk full while writing ${KEY}`);
      },
      settings: async () => {
        throw new Error("unreachable");
      },
      engine: async () => {
        throw new Error("unreachable");
      },
    };
    const response = await handleRendererRequest(command("settings.setApiKey", { key: KEY }), APP_FRAME, PACKAGED, routes);
    expect(response).toMatchObject({ ok: false, id: "cmd-00000001", error: { code: "INTERNAL", detail: "main failed to handle the command" } });
    expect(JSON.stringify(response)).not.toContain(KEY);
  });
});
