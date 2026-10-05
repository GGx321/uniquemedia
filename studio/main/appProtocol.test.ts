import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { canSymlink } from "./media/testing";
import { useNativeGlobals, useNativeWebClasses } from "../testing/nativeGlobals";
import { APP_PAGE_URL, APP_SCHEME, APP_SCHEME_PRIVILEGES, handleAppRequest, isAppPage, type AppFs } from "./appProtocol";
useNativeGlobals();
useNativeWebClasses();

// `studio-app://renderer/…`: the scheme the window's page is served from in every build without a dev server. The page used to
// be a `file:` URL, where the CSP's 'self' matched every `file:` URL on the disk and Chromium let the page fetch any of them (the
// 3f.6 security review read /etc/hosts from the real app). The handler serves the renderer's build folder and nothing else.

const SECRET = "SECRET-OUTSIDE-THE-BUNDLE";
let dir = "";
let root = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "studio-app-scheme-"));
  root = join(dir, "renderer");
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "index.html"), "<!doctype html><title>Studio</title>");
  await writeFile(join(root, "assets", "index-DOFSCYS-.js"), "export {};");
  await writeFile(join(root, "assets", "index-CQrcRTQT.css"), "body{}");
  await writeFile(join(root, "assets", "onest-latin-wght-normal-Dun_Rd-l.woff2"), "wOF2");
  await writeFile(join(root, "assets", "Oswald-600-BZESNG4B.ttf"), "ttf");
  await writeFile(join(root, "assets", "notes.txt"), "a file of a kind the page never loads");
  // What a page must never read: files beside and above the bundle.
  await writeFile(join(dir, "secret.js"), SECRET);
  await writeFile(join(dir, "secret.html"), SECRET);
  await mkdir(join(dir, "etc"), { recursive: true });
  await writeFile(join(dir, "etc", "hosts"), SECRET);
});
afterEach(() => rm(dir, { recursive: true, force: true }));

/** The disk, with every read counted: a refused URL must not reach `readFile` at all. */
function countingFs(): AppFs & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    readFile: async (path) => {
      reads.push(path);
      return readFile(path);
    },
    lstat: (path) => lstat(path),
  };
}

const get = (url: string, fs?: AppFs, method = "GET"): Promise<Response> => handleAppRequest({ url, method }, root, fs);

async function expectNotFound(url: string, method = "GET"): Promise<void> {
  const fs = countingFs();
  const response = await get(url, fs, method);
  expect([url, response.status]).toEqual([url, 404]);
  expect(response.headers.get("Content-Type")).toBeNull();
  const body = await response.text();
  expect(body).toBe("");
  expect(fs.reads).toEqual([]);
}

describe("handleAppRequest serves the renderer's build folder", () => {
  const served: [string, string, string][] = [
    ["index.html", "text/html; charset=utf-8", "<!doctype html><title>Studio</title>"],
    ["assets/index-DOFSCYS-.js", "text/javascript; charset=utf-8", "export {};"],
    ["assets/index-CQrcRTQT.css", "text/css; charset=utf-8", "body{}"],
    ["assets/onest-latin-wght-normal-Dun_Rd-l.woff2", "font/woff2", "wOF2"],
    ["assets/Oswald-600-BZESNG4B.ttf", "font/ttf", "ttf"],
  ];
  for (const [path, type, body] of served) {
    test(`${path} is a 200 with ${type} and nosniff (a module script needs a JavaScript MIME type)`, async () => {
      const response = await get(`studio-app://renderer/${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe(type);
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(await response.text()).toBe(body);
    });
  }

  test("the page the window loads is the build's index.html", async () => {
    expect(APP_PAGE_URL).toBe("studio-app://renderer/index.html");
    expect((await get(APP_PAGE_URL)).status).toBe(200);
  });
});

describe("handleAppRequest refuses everything else with the same empty 404, and reads nothing outside the folder", () => {
  const refused: [string, string][] = [
    ["a dot-dot segment", "studio-app://renderer/../secret.js"],
    ["a dot-dot segment under a folder", "studio-app://renderer/assets/../../secret.js"],
    ["dot-dot segments to the system's files", "studio-app://renderer/../../../../../../etc/hosts"],
    ["an encoded dot-dot (lowercase)", "studio-app://renderer/%2e%2e/secret.js"],
    ["an encoded dot-dot (uppercase)", "studio-app://renderer/%2E%2E/secret.js"],
    ["a half-encoded dot-dot", "studio-app://renderer/.%2e/secret.js"],
    ["an encoded slash after a dot-dot", "studio-app://renderer/..%2fsecret.js"],
    ["an encoded slash, uppercase", "studio-app://renderer/assets%2F..%2F..%2Fsecret.js"],
    ["an encoded backslash (Windows' separator)", "studio-app://renderer/..%5csecret.js"],
    ["an encoded backslash, uppercase", "studio-app://renderer/assets%5C..%5C..%5Csecret.js"],
    ["a raw backslash", "studio-app://renderer/..\\secret.js"],
    ["raw backslashes under a folder", "studio-app://renderer/assets\\..\\..\\secret.js"],
    ["an absolute POSIX path", "studio-app://renderer//etc/hosts"],
    ["a Windows drive path", "studio-app://renderer/C:/Windows/win.ini"],
    ["a Windows drive path with backslashes", "studio-app://renderer/C:\\Windows\\win.ini"],
    ["a UNC path", "studio-app://renderer/\\\\server\\share\\x.js"],
    ["an encoded NUL", "studio-app://renderer/index.html%00.js"],
    ["a raw NUL", "studio-app://renderer/index.html\u0000.js"],
    ["a percent-encoded name", "studio-app://renderer/index%2Ehtml"],
    ["a dot segment", "studio-app://renderer/./index.html"],
    ["a hidden name", "studio-app://renderer/.index.html"],
    ["a trailing dot (Windows drops it)", "studio-app://renderer/index.html."],
    ["a trailing space (Windows drops it)", "studio-app://renderer/index.html%20"],
    ["an alternate data stream", "studio-app://renderer/index.html::$DATA"],
    ["an 8.3 short name", "studio-app://renderer/ASSETS~1/index-DOFSCYS-.js"],
    ["a query", "studio-app://renderer/index.html?x=1"],
    ["a fragment", "studio-app://renderer/index.html#x"],
    ["another host", "studio-app://other/index.html"],
    ["the host in another case", "studio-app://RENDERER/index.html"],
    ["credentials", "studio-app://user@renderer/index.html"],
    ["a port", "studio-app://renderer:80/index.html"],
    ["no path", "studio-app://renderer"],
    ["the folder itself", "studio-app://renderer/"],
    ["a folder", "studio-app://renderer/assets"],
    ["a folder with a slash", "studio-app://renderer/assets/"],
    ["a file that is not there", "studio-app://renderer/assets/missing.js"],
    ["a kind the page never loads", "studio-app://renderer/assets/notes.txt"],
    ["another scheme", "studio-media://renderer/index.html"],
    ["a file URL", "file:///etc/hosts"],
    ["garbage", "::::"],
    ["empty", ""],
  ];
  for (const [name, url] of refused) {
    test(name, () => expectNotFound(url));
  }

  test("only GET is served", async () => {
    for (const method of ["POST", "PUT", "DELETE", "HEAD", "OPTIONS"]) await expectNotFound(APP_PAGE_URL, method);
  });

  test("a disk failure is the same 404, not an error", async () => {
    const failing: AppFs = { readFile: () => Promise.reject(new Error("EIO")), lstat: (path) => lstat(path) };
    expect((await get(APP_PAGE_URL, failing)).status).toBe(404);
  });

  test.skipIf(!canSymlink)("a link inside the folder is refused, even to a file the page could load", async () => {
    await symlink(join(dir, "secret.js"), join(root, "assets", "linked.js"), "file");
    await symlink(join(root, "index.html"), join(root, "assets", "inside.html"), "file");
    await expectNotFound("studio-app://renderer/assets/linked.js");
    await expectNotFound("studio-app://renderer/assets/inside.html");
  });

  test.skipIf(!canSymlink)("a linked folder is refused", async () => {
    await mkdir(join(dir, "elsewhere"));
    await writeFile(join(dir, "elsewhere", "x.js"), SECRET);
    await symlink(join(dir, "elsewhere"), join(root, "linked"), "dir");
    await expectNotFound("studio-app://renderer/linked/x.js");
  });
});

describe("isAppPage: the one URL main trusts as the app's own page (requests.ts)", () => {
  test("the page, with or without a fragment", () => {
    expect(isAppPage(APP_PAGE_URL)).toBe(true);
    expect(isAppPage(`${APP_PAGE_URL}#/avatars`)).toBe(true);
  });

  const others: [string, string][] = [
    ["another file of the bundle", "studio-app://renderer/assets/index-DOFSCYS-.js"],
    ["a query", `${APP_PAGE_URL}?x=1`],
    ["another host", "studio-app://other/index.html"],
    ["the host in another case", "studio-app://RENDERER/index.html"],
    ["credentials", "studio-app://user@renderer/index.html"],
    ["a port", "studio-app://renderer:80/index.html"],
    ["a dot-dot path that a parser would fold into the page", "studio-app://renderer/assets/../index.html"],
    ["an encoded name", "studio-app://renderer/index%2Ehtml"],
    // The page's URL inside another one: only the whole URL may be the page.
    ["another scheme ending in the app's", "x-studio-app://renderer/index.html"],
    ["the page's URL as a data: URL's text", "data:,studio-app://renderer/index.html"],
    ["the page's URL as another page's fragment", "about:blank#studio-app://renderer/index.html"],
    ["the page as a file URL", "file:///Applications/Studio.app/Contents/Resources/app.asar/out-studio/renderer/index.html"],
    ["the page under the media scheme", "studio-media://renderer/index.html"],
    ["a web page", "https://renderer/index.html"],
    ["garbage", "::::"],
  ];
  for (const [name, url] of others) {
    test(`not ${name}`, () => expect(isAppPage(url)).toBe(false));
  }
});

describe("the scheme's registration", () => {
  test("a standard, secure scheme (an origin of its own, a secure context), and nothing that opens it wider", () => {
    expect(APP_SCHEME).toBe("studio-app");
    expect(APP_SCHEME_PRIVILEGES).toMatchObject({ standard: true, secure: true });
    // No supportFetchAPI either: the page cannot `fetch` its own scheme (the smoke checks it in the real app).
    for (const wider of ["bypassCSP", "corsEnabled", "supportFetchAPI", "allowServiceWorkers", "stream"]) expect(APP_SCHEME_PRIVILEGES).not.toHaveProperty(wider);
  });

  test("main registers both schemes in its one call, serves this one from the renderer folder and loads the page from it", async () => {
    const source = await readFile(resolve(import.meta.dirname, "main.ts"), "utf8");
    expect(source).toContain("{ scheme: APP_SCHEME, privileges: APP_SCHEME_PRIVILEGES }");
    expect(source.match(/registerSchemesAsPrivileged\(/g)).toHaveLength(1);
    // The root is the renderer's build folder itself: one level up would serve main's and the engine's code.
    expect(source).toContain('const RENDERER_DIR = join(import.meta.dirname, "../renderer");');
    expect(source.match(/protocol\.handle\(APP_SCHEME, .*\);/g)).toEqual(["protocol.handle(APP_SCHEME, (request) => handleAppRequest(request, RENDERER_DIR));"]);
    expect(source.match(/RENDERER_DIR/g)).toHaveLength(2);
    expect(source).toContain("win.loadURL(APP_PAGE_URL)");
    // The page is never a `file:` URL again.
    expect(source).not.toContain("loadFile(");
    expect(source).not.toContain("pathToFileURL");
  });
});

describe("the renderer CSP", () => {
  async function directives(): Promise<Record<string, string[]>> {
    const html = await readFile(resolve(import.meta.dirname, "../renderer/index.html"), "utf8");
    const csp = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1] ?? "";
    return Object.fromEntries(csp.split(";").map((part) => part.trim().split(/\s+/)).map(([name, ...values]) => [name ?? "", values]));
  }

  test("no frame, child, worker or plugin of any origin, no <base> and no form target", async () => {
    const csp = await directives();
    expect(csp["frame-src"]).toEqual(["'none'"]);
    expect(csp["child-src"]).toEqual(["'none'"]);
    expect(csp["object-src"]).toEqual(["'none'"]);
    expect(csp["base-uri"]).toEqual(["'none'"]);
    expect(csp["form-action"]).toEqual(["'none'"]);
  });

  test("everything else is the page's own origin, the media scheme only for images and media", async () => {
    const csp = await directives();
    expect(csp["default-src"]).toEqual(["'self'"]);
    expect(csp["img-src"]).toEqual(["'self'", "data:", "studio-media:"]);
    expect(csp["media-src"]).toEqual(["studio-media:"]);
    expect(csp["style-src"]).toEqual(["'self'", "'unsafe-inline'"]);
    // Each falls back to default-src, so to the page's own origin.
    for (const name of ["script-src", "connect-src", "font-src", "worker-src"]) expect([name, name in csp]).toEqual([name, false]);
  });

  test("no directive names file:, a wildcard, or the app's scheme itself ('self' is the page's own origin)", async () => {
    for (const [name, values] of Object.entries(await directives())) {
      for (const value of values) expect([name, value.startsWith("file:") || value.includes("*") || value.startsWith(`${APP_SCHEME}:`) || value === "'unsafe-eval'"]).toEqual([name, false]);
    }
  });
});
