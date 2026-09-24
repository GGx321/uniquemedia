import { afterEach, beforeEach, expect, test } from "bun:test";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from "node:net";
import { nativeAbortController, nativeAbortSignal } from "../../../nativeGlobals";
import { createOpenRouterClient } from "./client";
import { chatBody, chatParams, imageBody, imageParams, PNG, setupMoney, TEST_KEY, WORST_ONE_REF, type Money } from "./testing/fakes";
import type { OpenRouterClientOptions } from "./types";

// Real HTTP against a loopback mock: exercises the real fetch, headers and
// socket failures. The test preload swaps the global fetch/AbortController/
// AbortSignal for happy-dom's; newer Bun's native fetch rejects a happy-dom
// AbortSignal outright ("signal is not of type AbortSignal"), so both must be
// native for the transport code under test: `new AbortController()` in
// transport.ts and credits.ts, `AbortSignal.timeout()` in priceFetch.ts (and,
// elsewhere in the engine, money/prices.ts and avatars/candidateJob.ts).
// Each test swaps both globals for the pre-registration native ones
// (nativeGlobals.ts) it runs and restores happy-dom's right after, matching
// what Electron's Node gives the engine in production.
//
// This only swaps the two bindings that code reads, rather than tearing down
// the shared happy-dom window (GlobalRegistrator.unregister()): an earlier
// version did that in beforeAll/afterAll (once for the whole file) and, under
// `bun test --randomize`, caused 32 unrelated failures elsewhere ("window
// object is not available for the provided node"). Verified: --randomize
// shuffles file order and, within a file, test order, but does not interleave
// two files' tests. So the failures were not a file simply running mid-way
// through another file's DOM-torn-down window. The likely cause (not fully
// confirmed): @testing-library/dom's `screen` is a module-level singleton
// bound once, at first import, to whatever `document.body` exists then
// (node_modules/@testing-library/dom/dist/screen.js); unregistering and
// re-registering happy-dom builds a new window/document, so `screen` is left
// pointing at the torn-down one for the rest of the run. Swapping only
// AbortController/AbortSignal here never touches document/window, so this
// does not matter either way.
const nativeFetch = Bun.fetch;
const happyDomAbortController = globalThis.AbortController;
const happyDomAbortSignal = globalThis.AbortSignal;

let money: Money;
let closers: (() => Promise<void>)[] = [];

beforeEach(async () => {
  globalThis.AbortController = nativeAbortController;
  globalThis.AbortSignal = nativeAbortSignal;
  money = await setupMoney();
  closers = [];
});

afterEach(async () => {
  // Restored first, synchronously, before anything is awaited: a closer can
  // hang (a raw-server test whose abort never reached the socket leaves
  // server.close() waiting for a connection that will never end on its own,
  // timing out this whole hook), and when it does, the native classes must
  // already be back to happy-dom's — not still the global once the hook gives
  // up, which would otherwise leak them into every later test in the run.
  globalThis.AbortController = happyDomAbortController;
  globalThis.AbortSignal = happyDomAbortSignal;
  for (const close of closers) await close();
  await money.cleanup();
});

interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  body: string;
}

async function httpMock(handler: (req: IncomingMessage, res: ServerResponse, seen: Seen) => void): Promise<{ base: string; seen: Seen[]; server: HttpServer }> {
  const seen: Seen[] = [];
  const server: HttpServer = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const entry = { method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization, body: Buffer.concat(chunks).toString("utf8") };
      seen.push(entry);
      handler(req, res, entry);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`, seen, server };
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function client(base: string, overrides: Partial<OpenRouterClientOptions> = {}) {
  return createOpenRouterClient({
    apiKey: TEST_KEY,
    baseUrl: base,
    allowBaseUrlOverride: true,
    fetch: nativeFetch,
    saveRaw: async () => {},
    sleep: async () => {},
    ...overrides,
  });
}

/**
 * A closer for a raw `net.Server`: destroys any socket still open before
 * closing the server. `server.close()`'s callback waits for every connection
 * to end on its own; a socket a bug left open (an abort that never reached
 * the real fetch) would otherwise make this hang until the hook times out.
 */
function closeNetServer(server: NetServer, sockets: Set<Socket>): () => Promise<void> {
  return () =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    });
}

test("generates an image against a loopback mock over real HTTP", async () => {
  const { base, seen } = await httpMock((_req, res) => json(res, 200, imageBody(PNG, { cost: 0.05 })));

  const result = await client(base).generateImage(imageParams(money));

  expect(result).toMatchObject({ status: "ok", mediaType: "image/png", costMicros: 50_000 });
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ method: "POST", url: "/api/v1/images", authorization: `Bearer ${TEST_KEY}` });
  expect(JSON.parse(seen[0]?.body ?? "{}")).toMatchObject({ model: "x-ai/grok-imagine-image-2.0", aspect_ratio: "3:4" });
});

test("reads a real Retry-After header and retries inside the same attempt id", async () => {
  let n = 0;
  const { base, seen } = await httpMock((_req, res) => (n++ === 0 ? json(res, 429, { error: { message: "slow down" } }, { "Retry-After": "2" }) : json(res, 200, imageBody(PNG, { cost: 0.05 }))));
  const sleeps: number[] = [];

  const result = await client(base, { sleep: async (ms) => void sleeps.push(ms), random: () => 0 }).generateImage(imageParams(money));

  expect(result).toMatchObject({ status: "ok", httpTries: 2 });
  expect(seen).toHaveLength(2);
  expect(sleeps).toEqual([2_000]);
  expect(money.lines().map((l) => l.type)).toEqual(["reserve", "settle"]);
});

test("runs a chat call and fetches credits over real HTTP", async () => {
  const { base, seen } = await httpMock((req, res) =>
    req.url === "/api/v1/credits" ? json(res, 200, { data: { total_credits: 20, total_usage: 1.5 } }) : json(res, 200, chatBody("ok", { cost: 0.001 }))
  );
  const c = client(base);

  const answer = await c.chat(chatParams(money));
  const credits = await c.fetchCredits();

  expect(answer).toMatchObject({ status: "ok", content: "ok", costMicros: 1_000 });
  expect(credits).toEqual({ data: { total_credits: 20, total_usage: 1.5 } });
  expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(["POST /api/v1/chat/completions", "GET /api/v1/credits"]);
});

test("does not follow a redirect with the paid POST", async () => {
  const { base, seen, server } = await httpMock((req, res) => {
    if (req.url === "/api/v1/images") {
      res.writeHead(307, { Location: "/elsewhere/images" });
      res.end();
    } else {
      json(res, 200, imageBody(PNG, { cost: 0.05 }));
    }
  });
  // A connection-level check, independent of `seen`: proves the client really
  // opened a socket to the server rather than the request failing before any
  // network activity (e.g. a broken AbortSignal throws inside `fetch` before
  // it connects — confirmed by reproducing the original bug: `seen` stayed
  // empty), which also leaves `result` not "ok" and could otherwise pass this
  // test for the wrong reason. (Not a byte-level `data` probe: verified that
  // Bun's node:http compat fires `connection` on the exposed socket but never
  // emits `data` on it — the request is parsed through an internal path that
  // bypasses the Node socket stream.)
  let reachedServer = false;
  server.once("connection", () => (reachedServer = true));

  const result = await client(base).generateImage(imageParams(money));

  expect(reachedServer).toBe(true);
  expect(seen.map((s) => s.url)).toEqual(["/api/v1/images"]);
  expect(result.status).not.toBe("ok");
});

test("leaves the reserve open when the server drops the connection after the request was sent", async () => {
  // `requested` proves the request actually left before the server dropped
  // the connection: a broken AbortSignal throwing inside `fetch` before it
  // ever connects would also settle NETWORK + left-open (same kind, same
  // ledger action), and could otherwise pass this test for the wrong reason.
  let requested = false;
  const sockets = new Set<Socket>();
  const server: NetServer = createNetServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.once("data", () => {
      requested = true;
      socket.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(closeNetServer(server, sockets));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;

  const result = await client(base).generateImage(imageParams(money));

  expect(requested).toBe(true);
  expect(result).toMatchObject({ status: "error", kind: "NETWORK", ledger: { action: "left-open", worstMicros: WORST_ONE_REF } });
  expect(money.lines().map((l) => l.type)).toEqual(["reserve"]);
  expect(JSON.stringify(result)).not.toContain(TEST_KEY);
});

test("times out against a server that never answers and leaves the reserve open", async () => {
  // A raw TCP server, not httpMock: only a real abort of the client's fetch
  // closes the socket, and Bun's node:http server does not report a client
  // disconnect (see studio/engine/openrouter/testing/nativeAbort.ts).
  let socketClosed = false;
  let markClosed = (): void => {};
  const closed = new Promise<void>((resolve) => (markClosed = resolve));
  const sockets = new Set<Socket>();
  const server: NetServer = createNetServer((socket) => {
    sockets.add(socket);
    // A paused Node/Bun socket (no reader) can leave `close` undelivered even
    // after the peer really disconnects; a `data` listener puts it in flowing
    // mode so `close` fires promptly, same as the other raw-socket tests here.
    socket.once("data", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
      socketClosed = true;
      markClosed();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(closeNetServer(server, sockets));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;

  const result = await client(base, { timeoutMs: 100 }).generateImage(imageParams(money));

  expect(result).toMatchObject({ status: "error", kind: "TIMEOUT", ledger: { action: "left-open" } });
  expect(money.budget.status()).toMatchObject({ openAttempts: 1 });
  // Proves the timeout reached the native fetch and tore down the connection:
  // a signal fetch silently ignored would still report TIMEOUT (sendOnce
  // races the fetch call against its own timer regardless), but the socket
  // would stay open. The close can lag slightly behind the timeout firing.
  await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
  expect(socketClosed).toBe(true);
}, 5_000);
