import { describe, expect, test } from "bun:test";
import { installSessionPermissions, type PermissionDetails, type PermissionTarget } from "./sessionPermissions";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 3 whole-slice review L4: Electron grants every permission to a page that asks unless the session has handlers, and Studio had none: a script in the window
// could have had the clipboard, notifications, the file system picker and the rest without a prompt. The session now denies everything, with ONE exception: the
// native controls of the Videos tab's `<video controls>` ask for `fullscreen`, MEASURED on Electron 43: with a deny-all handler the request hangs and the
// fullscreen button does nothing. That one is granted to the app's own page, in its top frame, and to no one else.

interface Installed {
  request: (webContents: unknown, permission: string, callback: (granted: boolean) => void, details: PermissionDetails) => void;
  check: (webContents: unknown, permission: string) => boolean;
}

function install(trusted: { devServerUrl?: string } = {}): Installed {
  let request: Installed["request"] | null = null;
  let check: Installed["check"] | null = null;
  const target: PermissionTarget = {
    setPermissionRequestHandler: (handler) => {
      request = handler;
    },
    setPermissionCheckHandler: (handler) => {
      check = handler;
    },
  };
  installSessionPermissions(target, trusted);
  if (request === null || check === null) throw new Error("a handler was not installed");
  return { request, check };
}

function asked(handlers: Installed, permission: string, details: PermissionDetails): boolean {
  let answer: boolean | null = null;
  handlers.request(null, permission, (granted) => {
    answer = granted;
  }, details);
  if (answer === null) throw new Error("the request handler never answered");
  return answer;
}

const APP_TOP = { requestingUrl: "studio-app://renderer/index.html", isMainFrame: true } as const;
const ALL_PERMISSIONS = [
  "clipboard-read",
  "clipboard-sanitized-write",
  "display-capture",
  "fullscreen",
  "geolocation",
  "idle-detection",
  "media",
  "mediaKeySystem",
  "midi",
  "midiSysex",
  "notifications",
  "pointerLock",
  "keyboardLock",
  "openExternal",
  "speaker-selection",
  "storage-access",
  "top-level-storage-access",
  "window-management",
  "unknown",
  "fileSystem",
] as const;

describe("the session's permission handlers", () => {
  test("both handlers are installed", () => {
    const { request, check } = install();
    expect(typeof request).toBe("function");
    expect(typeof check).toBe("function");
  });

  test.each(ALL_PERMISSIONS.filter((p) => p !== "fullscreen").map((p) => [p] as const))("a request for %s from the app's own page is denied", (permission) => {
    expect(asked(install(), permission, APP_TOP)).toBe(false);
  });

  test.each(ALL_PERMISSIONS.map((p) => [p] as const))("the check for %s says no, for every permission including fullscreen", (permission) => {
    expect(install().check(null, permission)).toBe(false);
  });

  test("fullscreen is granted to the app's own page in its top frame: the video controls' button needs it", () => {
    expect(asked(install(), "fullscreen", APP_TOP)).toBe(true);
  });

  test("fullscreen is granted to the app's page with a fragment too", () => {
    expect(asked(install(), "fullscreen", { requestingUrl: "studio-app://renderer/index.html#/videos", isMainFrame: true })).toBe(true);
  });

  test.each([
    ["a sub frame of the app's page", { requestingUrl: "studio-app://renderer/index.html", isMainFrame: false }],
    ["another page of the app's scheme", { requestingUrl: "studio-app://renderer/other.html", isMainFrame: true }],
    ["a web page", { requestingUrl: "https://example.com/index.html", isMainFrame: true }],
    ["a file URL", { requestingUrl: "file:///etc/passwd", isMainFrame: true }],
    ["an opaque origin", { requestingUrl: "about:blank", isMainFrame: true }],
    ["no URL at all", { isMainFrame: true }],
    ["no frame information", {}],
  ] as const)("fullscreen is denied to %s", (_label, details) => {
    expect(asked(install(), "fullscreen", details)).toBe(false);
  });

  test("with the dev server, fullscreen is granted to the dev server's page and still not to another origin", () => {
    const handlers = install({ devServerUrl: "http://localhost:5173" });
    expect(asked(handlers, "fullscreen", { requestingUrl: "http://localhost:5173/", isMainFrame: true })).toBe(true);
    expect(asked(handlers, "fullscreen", { requestingUrl: "http://localhost:5174/", isMainFrame: true })).toBe(false);
    expect(asked(handlers, "clipboard-read", { requestingUrl: "http://localhost:5173/", isMainFrame: true })).toBe(false);
  });

  test("without a dev server, a localhost page gets nothing", () => {
    expect(asked(install(), "fullscreen", { requestingUrl: "http://localhost:5173/", isMainFrame: true })).toBe(false);
  });

  test("each request is answered exactly once", () => {
    const handlers = install();
    let answers = 0;
    handlers.request(null, "fullscreen", () => void answers++, APP_TOP);
    handlers.request(null, "notifications", () => void answers++, APP_TOP);
    expect(answers).toBe(2);
  });
});
