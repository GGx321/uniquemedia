import { afterEach, beforeEach, expect, test } from "bun:test";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createServer as createNetServer, type AddressInfo, type Server as NetServer } from "node:net";
import { createOpenRouterClient } from "./client";
import { chatBody, chatParams, imageBody, imageParams, PNG, setupMoney, TEST_KEY, WORST_ONE_REF, type Money } from "./testing/fakes";
import type { OpenRouterClientOptions } from "./types";

// Real HTTP against a loopback mock: exercises the real fetch, headers and
// socket failures. The test preload swaps the global fetch for happy-dom's,
// so the native one is taken from Bun.
const nativeFetch = Bun.fetch;

let money: Money;
let closers: (() => Promise<void>)[] = [];

beforeEach(async () => {
  money = await setupMoney();
  closers = [];
});

afterEach(async () => {
  for (const close of closers) await close();
  await money.cleanup();
});

interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  body: string;
}

async function httpMock(handler: (req: IncomingMessage, res: ServerResponse, seen: Seen) => void): Promise<{ base: string; seen: Seen[] }> {
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
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`, seen };
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
  const { base, seen } = await httpMock((req, res) => {
    if (req.url === "/api/v1/images") {
      res.writeHead(307, { Location: "/elsewhere/images" });
      res.end();
    } else {
      json(res, 200, imageBody(PNG, { cost: 0.05 }));
    }
  });

  const result = await client(base).generateImage(imageParams(money));

  expect(seen.map((s) => s.url)).toEqual(["/api/v1/images"]);
  expect(result.status).not.toBe("ok");
});

test("leaves the reserve open when the server drops the connection after the request was sent", async () => {
  const server: NetServer = createNetServer((socket) => socket.once("data", () => socket.destroy()));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;

  const result = await client(base).generateImage(imageParams(money));

  expect(result).toMatchObject({ status: "error", kind: "NETWORK", ledger: { action: "left-open", worstMicros: WORST_ONE_REF } });
  expect(money.lines().map((l) => l.type)).toEqual(["reserve"]);
  expect(JSON.stringify(result)).not.toContain(TEST_KEY);
});

test("times out against a server that never answers and leaves the reserve open", async () => {
  const { base } = await httpMock(() => {});

  const result = await client(base, { timeoutMs: 100 }).generateImage(imageParams(money));

  expect(result).toMatchObject({ status: "error", kind: "TIMEOUT", ledger: { action: "left-open" } });
  expect(money.budget.status()).toMatchObject({ openAttempts: 1 });
});
