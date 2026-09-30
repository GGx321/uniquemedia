/**
 * A mock CDN for Studio's E2E build (3c.4): `Bun.serve` on 127.0.0.1 with an ephemeral port, the only kind of host the
 * E2E engine's loopback transport may reach (`createLoopbackCdnTransport` refuses any other). The engine still checks
 * every download URL against the real host allowlist and then sends only its path and query here, so a run proves the
 * allowlist and the whole download pipeline; only where the bytes come from changes.
 *
 * It answers exactly the paths of a 3c.1 list: each `progressive_download_url` with one of the four HE-AAC excerpts
 * (cycling by the item's index, the same choice `withExcerptDurations` makes for its claimed length) and each cover with
 * a JPEG. Anything else is a 404 kept in `unexpected`, which the caller asserts is empty. Each request is recorded whole,
 * headers included, so a scenario can assert that no key, cookie or credential ever reached this host. `override` swaps in
 * a redirect, an HTML page or an error for one path, to stage a hostile answer.
 */
import { readFileSync } from "node:fs";
import { musicLists } from "../engine/music/fixtures";
import { EXCERPTS, excerptOf, JPEG_1X1 } from "../engine/music/testing/storeKit";

export interface MockCdnServed {
  status?: number;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
}

export interface RecordedCdnRequest {
  method: string;
  /** The path and query as the server saw them. */
  path: string;
  /** Lowercase names. */
  headers: Record<string, string>;
}

export interface MockCdn {
  /** Pass as --studio-music-cdn-base-url. */
  url: string;
  requests: RecordedCdnRequest[];
  unexpected: string[];
  override(pathAndQuery: string, served: MockCdnServed): void;
  /** The path and query of item `index`'s full track and cover, as the engine will ask for them. */
  downloadPath(index: number): string;
  coverPath(index: number): string;
  stop(): Promise<void>;
}

export interface MockCdnOptions {
  /** Which 3c.1 list's paths it serves; default Kyiv. */
  fixture?: "kyiv" | "frankfurt";
}

interface ListFile {
  response: { items?: { track?: { progressive_download_url?: string; cover_artwork_uri?: string } }[] };
}

function pathOf(href: string | undefined): string | null {
  if (href === undefined) return null;
  try {
    const url = new URL(href);
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

export function startMockCdn(options: MockCdnOptions): MockCdn {
  const list = JSON.parse(readFileSync(musicLists[options.fixture ?? "kyiv"].file, "utf8")) as ListFile;
  const items = list.response.items ?? [];
  const downloads = items.map((item) => pathOf(item.track?.progressive_download_url) ?? "");
  const covers = items.map((item) => pathOf(item.track?.cover_artwork_uri) ?? "");
  const table = new Map<string, MockCdnServed>();
  downloads.forEach((path, index) => path !== "" && table.set(path, { body: excerptOf(index), headers: { "content-type": "video/mp4" } }));
  covers.forEach((path) => path !== "" && table.set(path, { body: JPEG_1X1, headers: { "content-type": "image/jpeg" } }));
  const requests: RecordedCdnRequest[] = [];
  const unexpected: string[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const path = `${url.pathname}${url.search}`;
      const headers: Record<string, string> = {};
      req.headers.forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });
      requests.push({ method: req.method, path, headers });
      const served = req.method === "GET" ? table.get(path) : undefined;
      if (served === undefined) {
        unexpected.push(`${req.method} ${path}`);
        console.error(`mock CDN: unexpected request ${req.method} ${url.pathname}`);
        return new Response("not found", { status: 404 });
      }
      const body = typeof served.body === "string" ? served.body : served.body === undefined ? null : Uint8Array.from(served.body);
      return new Response(body, { status: served.status ?? 200, headers: served.headers ?? {} });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    unexpected,
    override: (pathAndQuery, served) => void table.set(pathAndQuery, served),
    downloadPath: (index) => downloads[index] ?? "",
    coverPath: (index) => covers[index] ?? "",
    stop: async () => {
      await server.stop(true);
    },
  };
}

/**
 * The flashapi mock's `transformResponse` for a run that downloads from this CDN: each track claims the length of the
 * excerpt that serves it (an excerpt is 6 to 8 seconds of a track the list says is minutes long, and the store's decode
 * checks the claim). Works on a copy; anything that is not a list is returned as it is.
 */
export function withExcerptDurations(response: unknown): unknown {
  if (typeof response !== "object" || response === null) return response;
  const items: unknown = Reflect.get(response, "items");
  if (!Array.isArray(items)) return response;
  const copy = structuredClone(response) as { items: { track?: { duration_in_ms?: number } }[] };
  copy.items.forEach((item, index) => {
    if (item.track !== undefined) item.track.duration_in_ms = EXCERPTS[index % EXCERPTS.length]?.durationMs ?? 8000;
  });
  return copy;
}
