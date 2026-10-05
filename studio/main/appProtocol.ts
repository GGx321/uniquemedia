import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

// `studio-app://renderer/…`: where the window's page comes from in every build that has no dev server (main.ts).
//
// The page used to be a `file:` URL. There the CSP's 'self' matches every `file:` URL on the disk, and Chromium lets a
// `file:` page read any of them: the 3f.6 security review read /etc/hosts and any photo outside the library with a plain
// `fetch` from the real app, and an injected `<iframe src="file:///…">` ran with the bridge as a top frame of its own. On
// this scheme the page has an origin of its own, so 'self' is this folder and nothing else, and Chromium gives a page of
// another origin no `file:` URL at all (and the packaged app's fuse no longer grants `file:` pages anything extra either).
//
// The handler serves the renderer's build folder (out-studio/renderer, inside app.asar when packaged) and nothing else:
//   - the whole URL is matched byte for byte before anything parses it, so there is no percent sign, backslash, colon,
//     dot segment, leading or trailing dot, query, fragment, credentials or port to reason about, and the host is
//     exactly `renderer`: a URL parser cannot fold `..`, `%2e%2e` or `\` into another file, because none of them gets in;
//   - each name under the folder is `lstat`ed: a link (even to a file inside it), a file where a folder should be, or
//     a folder where the file should be is a refusal;
//   - only a kind the page loads is served, each with its own MIME type (a module script is refused without a
//     JavaScript one), and `nosniff`;
//   - anything else, and any failure at all, is one empty 404.

export const APP_SCHEME = "studio-app";
/** The page the window loads; also the only URL main trusts as the app's own page (requests.ts). */
export const APP_PAGE_URL = `${APP_SCHEME}://renderer/index.html`;

/**
 * Registered before `ready` (main.ts). `standard` gives the page an origin of its own (`studio-app://renderer`, which is
 * what the CSP's 'self' then means) and relative URLs; `secure` makes it a secure context, as a `file:` page was
 * (`crypto.randomUUID` needs one). Nothing else: no `bypassCSP`, no `corsEnabled` (the page loads its own scripts and
 * styles same-origin; no other origin has any business reading them), no service workers, no streaming.
 */
export const APP_SCHEME_PRIVILEGES = { standard: true, secure: true } as const;

/** The kinds the renderer's build holds, and the type each is served with. Anything else is not served. */
const MIME_TYPES: ReadonlyMap<string, string> = new Map([
  ["html", "text/html; charset=utf-8"],
  ["js", "text/javascript; charset=utf-8"],
  ["css", "text/css; charset=utf-8"],
  ["woff2", "font/woff2"],
  ["ttf", "font/ttf"],
]);

// A name: ASCII letters, digits, `_`, `-` and dots, with neither a leading nor a trailing dot (so never `.` or `..`, no
// hidden file, and nothing Windows would read as another name by dropping a trailing dot). Vite's file names fit it.
const NAME = "[A-Za-z0-9_-](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?";
const SHAPE = new RegExp(`^studio-app://renderer/((?:${NAME}/)*${NAME})$`);
const PAGE = /^studio-app:\/\/renderer\/index\.html(?:#.*)?$/s;

/** True only for the app's own page, with or without a fragment: compared as text, so no parser can fold another URL into it. */
export function isAppPage(url: string): boolean {
  return PAGE.test(url);
}

/** The disk calls, injectable so a test can count the reads. Electron's `fs` reads inside app.asar transparently. */
export interface AppFs {
  readFile(path: string): Promise<Uint8Array>;
  lstat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }>;
}

const NODE_APP_FS: AppFs = { readFile: (path) => readFile(path), lstat: (path) => lstat(path) };

/** What a `protocol.handle` request has that this handler reads. */
export interface AppRequest {
  readonly url: string;
  readonly method: string;
}

function notFound(): Response {
  return new Response(null, { status: 404, headers: { "X-Content-Type-Options": "nosniff" } });
}

/** The `protocol.handle` handler for `studio-app://`: a file of `root` (the renderer's build folder), or the one 404. */
export async function handleAppRequest(request: AppRequest, root: string, fs: AppFs = NODE_APP_FS): Promise<Response> {
  if (request.method !== "GET") return notFound();
  const match = SHAPE.exec(request.url);
  if (match === null || match[1] === undefined) return notFound();
  const names = match[1].split("/");
  const type = MIME_TYPES.get(names.at(-1)?.split(".").at(-1) ?? "");
  if (type === undefined) return notFound();
  try {
    for (let depth = 1; depth <= names.length; depth++) {
      const facts = await fs.lstat(join(root, ...names.slice(0, depth)));
      const last = depth === names.length;
      if (facts.isSymbolicLink() || (last ? !facts.isFile() : !facts.isDirectory())) return notFound();
    }
    const bytes = await fs.readFile(join(root, ...names));
    return new Response(new Uint8Array(bytes), { status: 200, headers: { "Content-Type": type, "X-Content-Type-Options": "nosniff" } });
  } catch {
    return notFound();
  }
}
