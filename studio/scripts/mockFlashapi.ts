/**
 * A mock flashapi (RapidAPI) server for Studio's music tests (3c.3): `Bun.serve` on 127.0.0.1 with an ephemeral port,
 * the only kind of host the E2E build's `--studio-flashapi-base-url` override may point at (the client's
 * `checkedBaseUrl` refuses anything but a loopback base, like OpenRouter's). It serves what the client calls:
 *
 *   GET /ig/music_trending/   the list of a 3c.1 fixture (studio/engine/music/fixtures), with flashapi's rate-limit
 *                             headers, its own `remaining` counting down per answer
 *
 * The only key it accepts is the FAKE one it was started with; anything else is a 401 (a body that echoes what it
 * was sent, on purpose: the client must redact it). Anything else it is asked for is a bug of the client or a leak
 * past the base-URL rule: it answers 404, logs to stderr and keeps the request in `unexpected`, which the caller must
 * assert is empty. No request reaches the real network and no real key is ever sent here.
 *
 * `script` queues one-shot behaviours (a status, a body, headers, a delay, an oversized body, a redirect) served in
 * order to the next requests, so a test can stage a 401, a 429, a hang or a torn answer. Each request the mock
 * receives is recorded whole, the key header included (the fake one), so a test can assert where the key was and was
 * not: the request's URL, its query, its headers.
 */
import { readFileSync } from "node:fs";
import { musicLists } from "../engine/music/fixtures";

export const MOCK_FLASHAPI_HOST = "flashapi1.p.rapidapi.com";
export const MOCK_TRENDING_PATH = "/ig/music_trending/";

export interface RecordedFlashapiRequest {
  method: string;
  /** The whole URL as the server saw it (path and query). The key must never be in it. */
  url: string;
  path: string;
  search: string;
  /** Lowercase names. Holds the (fake) key as sent. */
  headers: Record<string, string>;
}

export interface MockFlashapiStep {
  status?: number;
  /** A JSON value, or a string sent as it is. */
  body?: unknown;
  headers?: Record<string, string>;
  /** Held after the request is recorded and before it is answered. */
  delayMs?: number;
  /** Send a body of this many bytes of `x`: with `contentLength` false it is streamed without a Content-Length. */
  oversize?: { bytes: number; contentLength: boolean };
  /** A 302 to this URL (the client must not follow it). */
  redirectTo?: string;
}

export interface MockFlashapiOptions {
  /** The fake key the mock accepts. */
  key: string;
  /** Which 3c.1 list it serves; default Kyiv. */
  fixture?: "kyiv" | "frankfurt";
  /** `x-ratelimit-requests-remaining` of the first answer, counting down by one per served list; default the fixture's own. */
  remaining?: number;
  /** Echo what a request sent (the key included) in its 401 body and in a header, to prove the client redacts it. */
  echoKey?: boolean;
  /**
   * Changes the list the mock serves, once, when it starts (3c.4): the E2E run that downloads from the mock CDN makes each
   * track claim the length of the excerpt that serves it. Scripted answers are not touched.
   */
  transformResponse?: (response: unknown) => unknown;
}

export interface MockFlashapi {
  /** Pass as --studio-flashapi-base-url. */
  url: string;
  requests: RecordedFlashapiRequest[];
  unexpected: string[];
  script(...steps: MockFlashapiStep[]): void;
  stop(): Promise<void>;
}

interface FixtureFile {
  quota: { remaining: string; limit: string };
  response: unknown;
}

export function startMockFlashapi(options: MockFlashapiOptions): MockFlashapi {
  const fixture = JSON.parse(readFileSync(musicLists[options.fixture ?? "kyiv"].file, "utf8")) as FixtureFile;
  const listBody = JSON.stringify(options.transformResponse === undefined ? fixture.response : options.transformResponse(fixture.response));
  let remaining = options.remaining ?? Number(fixture.quota.remaining);
  const limit = fixture.quota.limit;
  const requests: RecordedFlashapiRequest[] = [];
  const unexpected: string[] = [];
  const steps: MockFlashapiStep[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const headers: Record<string, string> = {};
      req.headers.forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });
      requests.push({ method: req.method, url: `${url.pathname}${url.search}`, path: url.pathname, search: url.search, headers });
      const sent = headers["x-rapidapi-key"];

      if (req.method !== "GET" || url.pathname !== MOCK_TRENDING_PATH) {
        const line = `${req.method} ${url.pathname}`;
        unexpected.push(line);
        console.error(`mock flashapi: unexpected request ${line}`);
        return new Response("unexpected", { status: 404 });
      }
      const step = steps.shift();
      if (step?.delayMs) await Bun.sleep(step.delayMs);
      const echo: Record<string, string> = options.echoKey ? { "x-echo": sent ?? "" } : {};
      const rate: Record<string, string> = { "x-ratelimit-requests-limit": limit };

      if (step?.redirectTo !== undefined) return new Response(null, { status: 302, headers: { location: step.redirectTo } });
      if (step?.oversize !== undefined) {
        const { bytes, contentLength } = step.oversize;
        if (contentLength) return new Response("x".repeat(bytes), { status: 200, headers: { "content-type": "application/json", ...rate } });
        const chunk = new TextEncoder().encode("x".repeat(1024));
        let left = bytes;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (left <= 0) return controller.close();
            controller.enqueue(chunk.subarray(0, Math.min(chunk.length, left)));
            left -= chunk.length;
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "application/json", ...rate } });
      }
      if (step?.status !== undefined || step?.body !== undefined) {
        const status = step.status ?? 200;
        const body = typeof step.body === "string" ? step.body : JSON.stringify(step.body ?? {});
        return new Response(body, { status, headers: { "content-type": "application/json", ...rate, ...echo, ...step.headers } });
      }

      if (headers["x-rapidapi-host"] !== MOCK_FLASHAPI_HOST) {
        return new Response(JSON.stringify({ message: "You are not subscribed to this API." }), { status: 403, headers: { "content-type": "application/json" } });
      }
      if (sent !== options.key) {
        const message = options.echoKey ? `Invalid API key: ${sent ?? "(none)"}` : "Invalid API key. Go to https://docs.rapidapi.com/docs/keys for more info.";
        return new Response(JSON.stringify({ message }), { status: 401, headers: { "content-type": "application/json", ...echo } });
      }
      const answer = new Response(listBody, {
        status: 200,
        headers: { "content-type": "application/json", server: "RapidAPI-1.2.8", ...rate, "x-ratelimit-requests-remaining": String(Math.max(0, remaining)), ...echo, ...(step?.headers ?? {}) },
      });
      remaining -= 1;
      return answer;
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    unexpected,
    script: (...more) => void steps.push(...more),
    stop: async () => {
      await server.stop(true);
    },
  };
}
