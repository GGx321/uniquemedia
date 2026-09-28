import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { requestCarries, startMockOpenRouter, type MockOpenRouter } from "./mockOpenRouter";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// The packaged smoke's marker scan (smoke-engine.ts) reads what this mock
// recorded, so it can only be as thorough as the record: the request's URL
// (query included), every header, and the body as it was sent, the way
// engine.canary.test.ts's own scan reads a fake fetch's call. A word hidden
// in a query string, a header or a body that is not JSON must not slip past.

// The test preload swaps the global fetch for happy-dom's (which sends a CORS preflight and returns its own Response); Bun's own is the one that speaks plain HTTP to the loopback mock.
const nativeFetch = Bun.fetch;
// ...and the mock answers with `new Response(...)`, which Bun.serve only accepts native: swap that one global too for this file.
const happyDomResponse = globalThis.Response;
const sample = await nativeFetch("data:,");
const nativeResponse = sample.constructor;
beforeAll(() => {
  if (typeof nativeResponse === "function") globalThis.Response = nativeResponse as typeof Response;
});
afterAll(() => {
  globalThis.Response = happyDomResponse;
});

const WORDS = ["zebra", "lantern", "marmalade"];

let mock: MockOpenRouter | null = null;
afterEach(async () => {
  await mock?.stop();
  mock = null;
});

async function started(): Promise<MockOpenRouter> {
  mock = await startMockOpenRouter({ descriptorText: "A 25-year-old woman." });
  return mock;
}

/** The mock's base is `http://127.0.0.1:<port>/api/v1`; every request below is a loopback one. */
async function send(m: MockOpenRouter, path: string, init: RequestInit = {}): Promise<void> {
  await nativeFetch(`${m.url}${path}`, init).then((r) => r.text());
}

describe("requestCarries", () => {
  test("finds a word in the URL's query string, in any letter case", async () => {
    const m = await started();
    await send(m, "/credits?note=Zebra");
    expect(m.requests.map((r) => requestCarries(r, WORDS))).toEqual([true]);
    expect(m.requests[0]?.url).toContain("/api/v1/credits?note=Zebra");
  });

  test("finds a word in any header, not only Authorization", async () => {
    const m = await started();
    await send(m, "/credits", { headers: { "x-note": "a LANTERN glows" } });
    expect(m.requests.map((r) => requestCarries(r, WORDS))).toEqual([true]);
    expect(m.requests[0]?.headers["x-note"]).toBe("a LANTERN glows");
  });

  test("finds a word in a JSON body", async () => {
    const m = await started();
    await send(m, "/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "Marmalade toast" }] }) });
    expect(m.requests.map((r) => requestCarries(r, WORDS))).toEqual([true]);
  });

  test("finds a word in a body that is not JSON: the parsed body is null there, the text as sent is not", async () => {
    const m = await started();
    await send(m, "/chat/completions", { method: "POST", headers: { "content-type": "text/plain" }, body: "not json, but ZEBRA is in it" });
    expect(m.requests[0]?.body).toBeNull();
    expect(m.requests.map((r) => requestCarries(r, WORDS))).toEqual([true]);
  });

  test("a request with none of the words carries none", async () => {
    const m = await started();
    await send(m, "/credits");
    await send(m, "/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [] }) });
    expect(m.requests.map((r) => requestCarries(r, WORDS))).toEqual([false, false]);
  });

  test("an empty word list matches nothing", async () => {
    const m = await started();
    await send(m, "/credits?note=zebra");
    expect(m.requests.map((r) => requestCarries(r, []))).toEqual([false]);
  });
});
