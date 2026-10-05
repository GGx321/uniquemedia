import { describe, expect, test } from "bun:test";
import { ResponseMessage, type EngineCommandMessage } from "../shared/engine";
import type { ExportFolderCommand } from "./exportFolderFlow";
import type { ImportPhotoCommand } from "./importFlow";
import type { KeyCommand } from "./keyFlow";
import type { MediaPickCommand } from "./mediaImportFlow";
import type { MusicKeyCommand } from "./musicKeyFlow";
import type { RevealCommand, RevealFolderCommand } from "./revealFlow";
import type { SettingsCommand } from "./settingsFlow";
import type { OwnStickerBytesCommand } from "./ownStickerBytesFlow";
import type { StickerBytesCommand } from "./stickerBytesFlow";
import { APP_PAGE_URL } from "./appProtocol";
import { handleRendererRequest, isTrustedSender, type RequestRoutes, type SenderFrame, type TrustedRenderer } from "./requests";
import { captureConsole, expectNoKeyFragment } from "../testing/keyLeaks";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { PROTOCOL_VERSION } from "../shared/engine";
useNativeGlobals();

// The window's page is `studio-app://renderer/index.html` in every build without a dev server (appProtocol.ts): the same URL
// on every platform, with no drive letter, letter case or path separator to read it by.
const PACKAGED: TrustedRenderer = {};
const DEV: TrustedRenderer = { devServerUrl: "http://localhost:5173/" };
const APP_FRAME: SenderFrame = { url: APP_PAGE_URL, isTopFrame: true, isAppWindow: true };
const KEY = "sk-or-v1-0123456789abcdef-wxyz";
const MUSIC_KEY = "Zq7-vKt9-Wm2x-Lp4s-0000";

function routesSpy() {
  const mainOnly: KeyCommand[] = [];
  const musicKey: MusicKeyCommand[] = [];
  const settings: SettingsCommand[] = [];
  const importPhoto: ImportPhotoCommand[] = [];
  const exportFolder: ExportFolderCommand[] = [];
  const reveal: RevealCommand[] = [];
  const revealFolder: RevealFolderCommand[] = [];
  const mediaImport: MediaPickCommand[] = [];
  const stickerBytes: StickerBytesCommand[] = [];
  const ownStickerBytes: OwnStickerBytesCommand[] = [];
  const engine: EngineCommandMessage[] = [];
  const routes: RequestRoutes = {
    mainOnly: async (command) => {
      mainOnly.push(command);
      return { v: PROTOCOL_VERSION, id: command.id, kind: "response", type: command.type, ok: true, result: { stored: false, last4: null, encryptionAvailable: true, rejected: false } };
    },
    musicKey: async (command) => {
      musicKey.push(command);
      return { v: PROTOCOL_VERSION, id: command.id, kind: "response", type: command.type, ok: true, result: { stored: false, last4: null, rejected: false } };
    },
    settings: async (command) => {
      settings.push(command);
      return { v: PROTOCOL_VERSION, id: command.id, kind: "response", type: command.type, ok: false, error: { code: "INTERNAL", detail: "stub" } };
    },
    importPhoto: async (command) => {
      importPhoto.push(command);
      return { v: PROTOCOL_VERSION, id: command.id, kind: "response", type: command.type, ok: true, result: { picked: false } };
    },
    exportFolder: async (command) => {
      exportFolder.push(command);
      return { v: PROTOCOL_VERSION, id: command.id, kind: "response", type: command.type, ok: false, error: { code: "INTERNAL", detail: "stub" } };
    },
    reveal: async (command) => {
      reveal.push(command);
      return { v: PROTOCOL_VERSION, id: command.id, kind: "response", type: command.type, ok: true, result: { videoId: command.payload.videoId } };
    },
    revealFolder: async (command) => {
      revealFolder.push(command);
      return { v: PROTOCOL_VERSION, id: command.id, kind: "response", type: command.type, ok: true, result: { opened: "avatar" } };
    },
    mediaImport: async (command) => {
      mediaImport.push(command);
      return { v: PROTOCOL_VERSION, id: command.id, kind: "response", type: command.type, ok: true, result: { picked: false } };
    },
    stickerBytes: async (command) => {
      stickerBytes.push(command);
      return { v: PROTOCOL_VERSION, id: command.id, kind: "response", type: command.type, ok: true, result: { stickerId: command.payload.stickerId, apngBase64: "iVBORw0KGgo=" } };
    },
    ownStickerBytes: async (command) => {
      ownStickerBytes.push(command);
      return { v: PROTOCOL_VERSION, id: command.id, kind: "response", type: command.type, ok: true, result: { mediaId: command.payload.mediaId, apngBase64: "iVBORw0KGgo=" } };
    },
    engine: async (command) => {
      engine.push(command);
      return { v: PROTOCOL_VERSION, id: command.id, kind: "response", type: command.type, ok: false, error: { code: "INTERNAL", detail: "stub" } };
    },
  };
  return { routes, mainOnly, musicKey, settings, importPhoto, exportFolder, reveal, revealFolder, mediaImport, stickerBytes, ownStickerBytes, engine };
}

function command(type: string, payload: unknown = {}, id = "cmd-00000001"): unknown {
  return { v: PROTOCOL_VERSION, id, kind: "command", type, payload };
}

describe("isTrustedSender", () => {
  test("accepts the app's own page, with or without a fragment", () => {
    expect(isTrustedSender(APP_FRAME, PACKAGED)).toBe(true);
    expect(isTrustedSender({ ...APP_FRAME, url: `${APP_PAGE_URL}#/avatars` }, PACKAGED)).toBe(true);
  });

  const rejected: [string, SenderFrame, TrustedRenderer][] = [
    ["an iframe", { ...APP_FRAME, isTopFrame: false }, PACKAGED],
    ["a frame that is not an app window's main frame", { ...APP_FRAME, isAppWindow: false }, PACKAGED],
    ["a frame that is gone", { ...APP_FRAME, url: null }, PACKAGED],
    // The page used to be this file. No `file:` page is the app's own any more, whichever file it is.
    ["the renderer file the page used to be (Windows)", { ...APP_FRAME, url: "file:///C:/Program%20Files/Studio/resources/app.asar/out-studio/renderer/index.html" }, PACKAGED],
    ["the renderer file the page used to be (macOS)", { ...APP_FRAME, url: "file:///Applications/Studio.app/Contents/Resources/app.asar/out-studio/renderer/index.html" }, PACKAGED],
    ["another file", { ...APP_FRAME, url: "file:///C:/Users/Public/evil/index.html" }, PACKAGED],
    ["another file of the bundle", { ...APP_FRAME, url: "studio-app://renderer/assets/index.js" }, PACKAGED],
    ["the page with a query", { ...APP_FRAME, url: `${APP_PAGE_URL}?x=1` }, PACKAGED],
    ["the page reached through a dot segment", { ...APP_FRAME, url: "studio-app://renderer/assets/../index.html" }, PACKAGED],
    ["the page with an encoded name", { ...APP_FRAME, url: "studio-app://renderer/index%2Ehtml" }, PACKAGED],
    ["the page on another host of the scheme", { ...APP_FRAME, url: "studio-app://evil/index.html" }, PACKAGED],
    ["the page under the media scheme", { ...APP_FRAME, url: "studio-media://renderer/index.html" }, PACKAGED],
    ["a web page", { ...APP_FRAME, url: "https://example.com/" }, PACKAGED],
    ["the dev server in a packaged run", { ...APP_FRAME, url: "http://localhost:5173/" }, PACKAGED],
    ["another origin in dev", { ...APP_FRAME, url: "http://localhost:5174/" }, DEV],
    ["the app's page in dev, when the dev server is the renderer", APP_FRAME, DEV],
    ["garbage", { ...APP_FRAME, url: "::::" }, PACKAGED],
  ];
  for (const [name, frame, trusted] of rejected) {
    test(`rejects ${name}`, () => {
      expect(isTrustedSender(frame, trusted)).toBe(false);
    });
  }

  test("accepts any path on the dev server's origin in dev", () => {
    expect(isTrustedSender({ ...APP_FRAME, url: "http://localhost:5173/index.html#x" }, DEV)).toBe(true);
  });

  test('a URL with an opaque origin is never the dev server\'s, though a parser reads both origins as "null"', () => {
    expect(isTrustedSender({ ...APP_FRAME, url: "evil://x/index.html" }, { devServerUrl: "studio-app://renderer/" })).toBe(false);
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
      { v: PROTOCOL_VERSION + 1, id: "cmd-00000001", kind: "command", type: "settings.get", payload: {} },
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
    const event = { v: PROTOCOL_VERSION, id: "evt-00000001", kind: "event", seq: 1, bootId: "boot-00000001", type: "engine.error", payload: { error: { code: "INTERNAL" } } };
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

  test("the music key commands are handled by main's music key route and never forwarded", async () => {
    const { routes, mainOnly, musicKey, engine } = routesSpy();
    await handleRendererRequest(command("settings.setMusicKey", { key: MUSIC_KEY }), APP_FRAME, PACKAGED, routes);
    await handleRendererRequest(command("settings.clearMusicKey", {}, "cmd-00000002"), APP_FRAME, PACKAGED, routes);
    expect(musicKey.map((c) => c.type)).toEqual(["settings.setMusicKey", "settings.clearMusicKey"]);
    expect(mainOnly).toEqual([]);
    expect(engine).toEqual([]);
  });

  test("the music key reaches its route trimmed, as parsed", async () => {
    const { routes, musicKey } = routesSpy();
    await handleRendererRequest(command("settings.setMusicKey", { key: `  ${MUSIC_KEY}\n` }), APP_FRAME, PACKAGED, routes);
    expect(musicKey[0]?.payload).toEqual({ key: MUSIC_KEY });
  });

  test.each([
    ["holding a space", "Zq7-vKt9 Wm2x-Lp4s-0000"],
    ["holding a control character", "Zq7-vKt9\u0007Wm2x-Lp4s-0000"],
    ["too short", "abc"],
    ["not a string", 12345678],
  ])("a music key %s is refused with VALIDATION before any route runs, and is not echoed", async (_label, key) => {
    const { routes, mainOnly, musicKey, engine } = routesSpy();
    const response = await handleRendererRequest(command("settings.setMusicKey", { key }), APP_FRAME, PACKAGED, routes);
    expect(response).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(JSON.stringify(response)).not.toContain("Wm2x");
    expect([mainOnly, musicKey, engine]).toEqual([[], [], []]);
  });

  test("a music key route that throws becomes INTERNAL without the error's text", async () => {
    const { routes } = routesSpy();
    const throwing: RequestRoutes = {
      ...routes,
      musicKey: async () => {
        throw new Error(`disk full while writing ${MUSIC_KEY}`);
      },
    };
    const output = captureConsole();
    try {
      const response = await handleRendererRequest(command("settings.setMusicKey", { key: MUSIC_KEY }), APP_FRAME, PACKAGED, throwing);
      expect(response).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
      expectNoKeyFragment(JSON.stringify(response), MUSIC_KEY);
      expectNoKeyFragment(output.text(), MUSIC_KEY);
    } finally {
      output.restore();
    }
  });

  test("avatars.pickImportPhoto is handled by main and never forwarded to the engine", async () => {
    const { routes, importPhoto, engine } = routesSpy();
    await handleRendererRequest(command("avatars.pickImportPhoto", {}), APP_FRAME, PACKAGED, routes);
    expect(importPhoto.map((c) => c.type)).toEqual(["avatars.pickImportPhoto"]);
    expect(engine).toEqual([]);
  });

  test.each(["settings.setExportPath", "settings.exportDisplay"] as const)("%s is main's alone: it reaches the export folder route and is never forwarded to the engine", async (type) => {
    const { routes, mainOnly, settings, importPhoto, exportFolder, engine } = routesSpy();
    await handleRendererRequest(command(type), APP_FRAME, PACKAGED, routes);
    expect(exportFolder.map((c) => c.type)).toEqual([type]);
    expect([mainOnly, settings, importPhoto, engine]).toEqual([[], [], [], []]);
  });

  test("settings.setExportPath carrying a path is refused by the contract before any route runs: the window never names the folder", async () => {
    const { routes, exportFolder, engine } = routesSpy();
    const response = await handleRendererRequest(command("settings.setExportPath", { path: "/Volumes/Reels" }), APP_FRAME, PACKAGED, routes);
    expect(response).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect([exportFolder, engine]).toEqual([[], []]);
  });

  test("export.check is an engine command: forwarded as parsed", async () => {
    const { routes, exportFolder, engine } = routesSpy();
    await handleRendererRequest(command("export.check"), APP_FRAME, PACKAGED, routes);
    expect(engine.map((c) => c.type)).toEqual(["export.check"]);
    expect(exportFolder).toEqual([]);
  });

  test("videos.reveal is main's alone: it reaches the reveal route and is never forwarded to the engine", async () => {
    const { routes, mainOnly, settings, importPhoto, exportFolder, reveal, engine } = routesSpy();
    const response = await handleRendererRequest(command("videos.reveal", { videoId: "video-00000001" }), APP_FRAME, PACKAGED, routes);
    expect(response).toMatchObject({ ok: true, type: "videos.reveal", result: { videoId: "video-00000001" } });
    expect(ResponseMessage.safeParse(response).success).toBe(true);
    expect(reveal.map((c) => c.payload)).toEqual([{ videoId: "video-00000001" }]);
    expect([mainOnly, settings, importPhoto, exportFolder, engine]).toEqual([[], [], [], [], []]);
  });

  test("videos.reveal carrying a path is refused by the contract before any route runs: the window names no path", async () => {
    const { routes, reveal, engine } = routesSpy();
    const response = await handleRendererRequest(command("videos.reveal", { videoId: "video-00000001", path: "/Volumes/Reels/a.mp4" }), APP_FRAME, PACKAGED, routes);
    expect(response).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect([reveal, engine]).toEqual([[], []]);
  });

  test("videos.reveal from a frame that is not the app's own window is refused before it reaches the route", async () => {
    const { routes, reveal } = routesSpy();
    const stranger: SenderFrame = { url: "https://example.com/", isTopFrame: true, isAppWindow: true };
    const response = await handleRendererRequest(command("videos.reveal", { videoId: "video-00000001" }), stranger, PACKAGED, routes);
    expect(response).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(reveal).toEqual([]);
  });

  test("videos.revealFolder is main's alone (K17): it reaches its route and is never forwarded to the engine", async () => {
    const { routes, mainOnly, settings, importPhoto, exportFolder, reveal, revealFolder, engine } = routesSpy();
    const response = await handleRendererRequest(command("videos.revealFolder", { avatarId: "avatar-0001" }), APP_FRAME, PACKAGED, routes);
    expect(response).toMatchObject({ ok: true, type: "videos.revealFolder", result: { opened: "avatar" } });
    expect(revealFolder.map((c) => c.payload)).toEqual([{ avatarId: "avatar-0001" }]);
    expect([mainOnly, settings, importPhoto, exportFolder, reveal, engine]).toEqual([[], [], [], [], [], []]);
  });

  test("videos.revealFolder carrying a path is refused by the contract before any route runs", async () => {
    const { routes, revealFolder, engine } = routesSpy();
    const response = await handleRendererRequest(command("videos.revealFolder", { avatarId: "avatar-0001", path: "/Volumes/Reels" }), APP_FRAME, PACKAGED, routes);
    expect(response).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect([revealFolder, engine]).toEqual([[], []]);
  });

  test("the new engine commands of 3e.2 are forwarded to the engine: videos.get and the two usage recoveries", async () => {
    const { routes, engine } = routesSpy();
    await handleRendererRequest(command("videos.get", { videoId: "video-00000001" }), APP_FRAME, PACKAGED, routes);
    await handleRendererRequest(command("videos.quarantineRecords", { avatarId: "avatar-0001" }), APP_FRAME, PACKAGED, routes);
    await handleRendererRequest(command("photos.rebuildRejected", { avatarId: "avatar-0001" }), APP_FRAME, PACKAGED, routes);
    expect(engine.map((c) => c.type)).toEqual(["videos.get", "videos.quarantineRecords", "photos.rebuildRejected"]);
  });

  test("a Stage 3 engine command (videos.list) is forwarded to the engine", async () => {
    const { routes, engine } = routesSpy();
    await handleRendererRequest(command("videos.list", { avatarId: "avatar-0001" }), APP_FRAME, PACKAGED, routes);
    expect(engine.map((c) => c.type)).toEqual(["videos.list"]);
  });

  test("a validation failure on a key command never echoes the key", async () => {
    const { routes, mainOnly } = routesSpy();
    const response = await handleRendererRequest(command("settings.setApiKey", { key: `${KEY} with spaces` }), APP_FRAME, PACKAGED, routes);
    expect(response).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(JSON.stringify(response)).not.toContain(KEY);
    expect(mainOnly).toEqual([]);
  });

  test.each([
    ["holding a space", "Zq7-vKt9 Wm2x-Lp4s-0000"],
    ["holding a control character", "Zq7-vKt9\u0007Wm2x-Lp4s-0000"],
    ["not a string", 12345678],
  ])("an OpenRouter key %s is refused without a fragment of it in the answer or in the logs", async (_label, key) => {
    const { routes, mainOnly } = routesSpy();
    const output = captureConsole();
    try {
      const response = await handleRendererRequest(command("settings.setApiKey", { key }), APP_FRAME, PACKAGED, routes);
      expect(response).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
      if (typeof key === "string") {
        expectNoKeyFragment(JSON.stringify(response), key);
        expectNoKeyFragment(output.text(), key);
      }
      expect(mainOnly).toEqual([]);
    } finally {
      output.restore();
    }
  });

  test("settings changes are answered by main, which owns settings.json, and never forwarded", async () => {
    const { routes, settings, engine } = routesSpy();
    await handleRendererRequest(command("settings.setBudget", { monthlyBudgetMicros: 5_000_000 }), APP_FRAME, PACKAGED, routes);
    await handleRendererRequest(command("settings.setModels", { imageModel: "x-ai/grok-imagine-image-2.0", textModel: "x-ai/grok-4.3" }, "cmd-00000002"), APP_FRAME, PACKAGED, routes);
    await handleRendererRequest(command("settings.setConcurrency", { network: 2 }, "cmd-00000003"), APP_FRAME, PACKAGED, routes);
    await handleRendererRequest(command("settings.setLibraryPath", { path: "/Users/me/Studio" }, "cmd-00000004"), APP_FRAME, PACKAGED, routes);
    await handleRendererRequest(command("settings.setImageAgeCheck", { imageAgeCheck: "on" }, "cmd-00000005"), APP_FRAME, PACKAGED, routes);
    expect(settings.map((c) => c.type)).toEqual([
      "settings.setBudget",
      "settings.setModels",
      "settings.setConcurrency",
      "settings.setLibraryPath",
      "settings.setImageAgeCheck",
    ]);
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
    expect(engine).toEqual([{ v: PROTOCOL_VERSION, id: "cmd-00000001", kind: "command", type: "money.status", payload: {} }]);
  });

  test("a route that throws becomes INTERNAL without the error's text", async () => {
    const routes: RequestRoutes = {
      mainOnly: async () => {
        throw new Error(`disk full while writing ${KEY}`);
      },
      musicKey: async () => {
        throw new Error("unreachable");
      },
      settings: async () => {
        throw new Error("unreachable");
      },
      importPhoto: async () => {
        throw new Error("unreachable");
      },
      exportFolder: async () => {
        throw new Error("unreachable");
      },
      reveal: async () => {
        throw new Error("unreachable");
      },
      revealFolder: async () => {
        throw new Error("unreachable");
      },
      mediaImport: async () => {
        throw new Error("unreachable");
      },
      stickerBytes: async () => {
        throw new Error("unreachable");
      },
      ownStickerBytes: async () => {
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

// 3f.1 (invariant 34): own media come in through main only, and the window names a kind and nothing else.
describe("media.pickImport routing", () => {
  test("is main's alone: it reaches the media route and is never forwarded to the engine", async () => {
    const { routes, mediaImport, importPhoto, exportFolder, engine } = routesSpy();
    const response = await handleRendererRequest(command("media.pickImport", { kind: "video" }), APP_FRAME, PACKAGED, routes);
    expect(response).toMatchObject({ ok: true, type: "media.pickImport", result: { picked: false } });
    expect(ResponseMessage.safeParse(response).success).toBe(true);
    expect(mediaImport.map((c) => c.payload)).toEqual([{ kind: "video" }]);
    expect([importPhoto, exportFolder, engine]).toEqual([[], [], []]);
  });

  test("carrying a path is refused by the contract before any route runs", async () => {
    const { routes, mediaImport, engine } = routesSpy();
    for (const extra of [{ path: "/etc/passwd" }, { filePath: "C:\\a.jpg" }, { paths: ["/a"] }, { bytes: [1] }]) {
      const response = await handleRendererRequest(command("media.pickImport", { kind: "photo", ...extra }), APP_FRAME, PACKAGED, routes);
      expect(response).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    }
    expect([mediaImport, engine]).toEqual([[], []]);
  });

  test("with no kind, an unknown kind or a bare string payload is refused before any route runs", async () => {
    const { routes, mediaImport, engine } = routesSpy();
    for (const payload of [{}, { kind: "document" }, "/etc/passwd", null]) {
      const response = await handleRendererRequest(command("media.pickImport", payload), APP_FRAME, PACKAGED, routes);
      expect(response).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    }
    expect([mediaImport, engine]).toEqual([[], []]);
  });

  test("from a sender that is not the app's own top frame is refused before any route runs", async () => {
    const { routes, mediaImport, engine } = routesSpy();
    const frames: SenderFrame[] = [
      { url: "https://example.com/", isTopFrame: true, isAppWindow: true },
      { url: APP_PAGE_URL, isTopFrame: false, isAppWindow: true },
      { url: APP_PAGE_URL, isTopFrame: true, isAppWindow: false },
      { url: null, isTopFrame: true, isAppWindow: true },
    ];
    for (const frame of frames) {
      const response = await handleRendererRequest(command("media.pickImport", { kind: "photo" }), frame, PACKAGED, routes);
      expect(response).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    }
    expect([mediaImport, engine]).toEqual([[], []]);
  });

  test("a route that throws becomes INTERNAL without the error's text, which may hold a path", async () => {
    const { routes } = routesSpy();
    const throwing: RequestRoutes = {
      ...routes,
      mediaImport: async () => {
        throw new Error("could not open /Users/me/secret/holiday.jpg");
      },
    };
    const output = captureConsole();
    try {
      const response = await handleRendererRequest(command("media.pickImport", { kind: "photo" }), APP_FRAME, PACKAGED, throwing);
      expect(response).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
      expect(JSON.stringify(response).includes("/Users/me")).toBe(false);
      expect(output.text().includes("/Users/me")).toBe(false);
    } finally {
      output.restore();
    }
  });
});

// 3d.4 review round 1 (HIGH): the preview's sticker bytes come over IPC from main, never by reading the media scheme. The window
// names a built-in sticker's id, behind the same trusted-sender check as every request.
describe("stickers.bytes routing", () => {
  test("is main's alone: it reaches the sticker route and is never forwarded to the engine", async () => {
    const { routes, stickerBytes, mediaImport, engine } = routesSpy();
    const response = await handleRendererRequest(command("stickers.bytes", { stickerId: "heart-pulse" }), APP_FRAME, PACKAGED, routes);
    expect(response).toMatchObject({ ok: true, type: "stickers.bytes", result: { stickerId: "heart-pulse" } });
    expect(ResponseMessage.safeParse(response).success).toBe(true);
    expect(stickerBytes.map((c) => c.payload)).toEqual([{ stickerId: "heart-pulse" }]);
    expect([mediaImport, engine]).toEqual([[], []]);
  });

  test("a path, a file name or anything beside a contract id is refused before any route runs", async () => {
    const { routes, stickerBytes, engine } = routesSpy();
    for (const payload of [{ stickerId: "heart-pulse", path: "/etc/passwd" }, { stickerId: "../photos/x" }, { stickerId: "heart-pulse.apng" }, {}, "heart-pulse", null]) {
      const response = await handleRendererRequest(command("stickers.bytes", payload), APP_FRAME, PACKAGED, routes);
      expect(response).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    }
    expect([stickerBytes, engine]).toEqual([[], []]);
  });

  test("from a sender that is not the app's own top frame (another page, an iframe, no window) is refused before any route runs", async () => {
    const { routes, stickerBytes, engine } = routesSpy();
    const frames: SenderFrame[] = [
      { url: "data:text/html,<p>x</p>", isTopFrame: true, isAppWindow: true },
      { url: "https://example.com/", isTopFrame: true, isAppWindow: true },
      { url: APP_PAGE_URL, isTopFrame: false, isAppWindow: true },
      { url: APP_PAGE_URL, isTopFrame: true, isAppWindow: false },
      { url: null, isTopFrame: true, isAppWindow: true },
    ];
    for (const frame of frames) {
      const response = await handleRendererRequest(command("stickers.bytes", { stickerId: "heart-pulse" }), frame, PACKAGED, routes);
      expect(response).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    }
    expect([stickerBytes, engine]).toEqual([[], []]);
  });
});

// 3f.5: an OWN sticker's bytes for the preview, a command of its own (the built-in door stays closed to user files). Main-only, behind the same
// trusted-sender check as every request; the window names a media id and nothing else.
describe("media.stickerBytes routing", () => {
  test("is main's alone: it reaches the own-sticker route and is never forwarded to the engine, nor to the built-in route", async () => {
    const { routes, ownStickerBytes, stickerBytes, mediaImport, engine } = routesSpy();
    const response = await handleRendererRequest(command("media.stickerBytes", { mediaId: "media-0000001" }), APP_FRAME, PACKAGED, routes);
    expect(response).toMatchObject({ ok: true, type: "media.stickerBytes", result: { mediaId: "media-0000001" } });
    expect(ResponseMessage.safeParse(response).success).toBe(true);
    expect(ownStickerBytes.map((c) => c.payload)).toEqual([{ mediaId: "media-0000001" }]);
    expect([stickerBytes, mediaImport, engine]).toEqual([[], [], []]);
  });

  test("the built-in command never reaches the own-sticker route", async () => {
    const { routes, ownStickerBytes, stickerBytes } = routesSpy();
    await handleRendererRequest(command("stickers.bytes", { stickerId: "heart-pulse" }), APP_FRAME, PACKAGED, routes);
    expect(ownStickerBytes).toEqual([]);
    expect(stickerBytes).toHaveLength(1);
  });

  test("a path, a file name, a kind or anything beside a media id is refused before any route runs", async () => {
    const { routes, ownStickerBytes, stickerBytes, engine } = routesSpy();
    for (const payload of [{ mediaId: "media-0000001", path: "/etc/passwd" }, { mediaId: "media-0000001", kind: "photo" }, { mediaId: "../photos/x" }, { mediaId: "media-0000001.png" }, { stickerId: "heart-pulse" }, {}, "media-0000001", null]) {
      const response = await handleRendererRequest(command("media.stickerBytes", payload), APP_FRAME, PACKAGED, routes);
      expect(response).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    }
    expect([ownStickerBytes, stickerBytes, engine]).toEqual([[], [], []]);
  });

  test("from a sender that is not the app's own top frame (another page, an iframe, no window) is refused before any route runs", async () => {
    const { routes, ownStickerBytes, engine } = routesSpy();
    const frames: SenderFrame[] = [
      { url: "data:text/html,<p>x</p>", isTopFrame: true, isAppWindow: true },
      { url: "https://example.com/", isTopFrame: true, isAppWindow: true },
      { url: APP_PAGE_URL, isTopFrame: false, isAppWindow: true },
      { url: APP_PAGE_URL, isTopFrame: true, isAppWindow: false },
      { url: null, isTopFrame: true, isAppWindow: true },
    ];
    for (const frame of frames) {
      const response = await handleRendererRequest(command("media.stickerBytes", { mediaId: "media-0000001" }), frame, PACKAGED, routes);
      expect(response).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    }
    expect([ownStickerBytes, engine]).toEqual([[], []]);
  });
});
