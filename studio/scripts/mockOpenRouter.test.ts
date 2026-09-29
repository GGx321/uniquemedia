import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { authorizationLabel, markerMatch, requestCarries, startMockOpenRouter, type MockOpenRouter } from "./mockOpenRouter";
import { failureDetail } from "./failureDetail";
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

describe("requestCarries lowercases the marker words too", () => {
  test("an upper-case or mixed-case word in the list still matches", async () => {
    const m = await started();
    await send(m, "/credits?note=zebra");
    expect(m.requests.map((r) => requestCarries(r, ["ZEBRA"]))).toEqual([true]);
    expect(m.requests.map((r) => requestCarries(r, ["Lantern", "Zebra"]))).toEqual([true]);
  });
});

describe("markerMatch says which word matched and where, and nothing else", () => {
  test.each([
    ["url", "/credits?note=zebra", {}],
    ["headers", "/credits", { headers: { "x-note": "lantern" } }],
    ["body", "/chat/completions", { method: "POST", headers: { "content-type": "text/plain" }, body: "marmalade" }],
  ] as const)("a word in the %s", async (where, path, init: RequestInit) => {
    const m = await started();
    await send(m, path, init);
    const found = m.requests[0] === undefined ? null : markerMatch(m.requests[0], WORDS);
    expect(found?.in).toBe(where);
    expect(WORDS).toContain(found?.word ?? "");
  });

  test("null when no word is there", async () => {
    const m = await started();
    await send(m, "/credits");
    expect(m.requests[0] === undefined ? "no request" : markerMatch(m.requests[0], WORDS)).toBeNull();
  });
});

// A failed check prints its detail. A recorded request holds the Authorization header and whole bodies: none of that may
// ever reach the output, only what kind of request it was and where it went.
describe("failureDetail", () => {
  const request = {
    method: "POST",
    path: "/api/v1/chat/completions",
    schemaName: "avatar_descriptor",
    authorization: "Bearer sk-or-v1-secret",
    url: "http://127.0.0.1:1/api/v1/chat/completions",
    headers: { authorization: "Bearer sk-or-v1-secret", "x-note": "hello" },
    body: { messages: [{ content: "a very private prompt" }] },
    bodyText: '{"messages":[{"content":"a very private prompt"}]}',
  };

  test("drops every header, the Authorization value and both forms of the body, at any depth", () => {
    const text = failureDetail([{ carrying: [request] }, request]);
    expect(text).not.toContain("sk-or-v1-secret");
    expect(text).not.toContain("Bearer");
    expect(text).not.toContain("private prompt");
    expect(text).not.toContain("x-note");
    expect(text).toContain("/api/v1/chat/completions");
    expect(text).toContain("avatar_descriptor");
  });

  test("drops those keys in any letter case", () => {
    const text = failureDetail({ Authorization: "Bearer sk-secret", HEADERS: { a: "b" }, Body: "private", BodyText: "private", path: "/x" });
    expect(text).toBe('{"path":"/x"}');
  });

  test("truncates a long string and the whole text", () => {
    expect(failureDetail({ why: "x".repeat(5_000) }).length).toBeLessThanOrEqual(600);
    expect(failureDetail(["y".repeat(300)])).toContain("…");
  });

  test("leaves plain values alone", () => {
    expect(failureDetail({ a: 1, b: ["two"] })).toBe('{"a":1,"b":["two"]}');
    expect(failureDetail(undefined)).toBe("");
  });
});

// The smoke's "exactly Bearer <the fake key>" check must say what went wrong without ever printing a header value.
describe("authorizationLabel", () => {
  const base = { method: "POST", path: "/api/v1/images", body: null, schemaName: null, url: "", headers: {}, bodyText: "" };

  test("none, expected, or other: never the value", () => {
    expect(authorizationLabel({ ...base, authorization: null }, "sk-fake")).toBe("none");
    expect(authorizationLabel({ ...base, authorization: "Bearer sk-fake" }, "sk-fake")).toBe("expected");
    expect(authorizationLabel({ ...base, authorization: "Bearer sk-real-secret" }, "sk-fake")).toBe("other");
    expect(authorizationLabel({ ...base, authorization: "sk-fake" }, "sk-fake")).toBe("other");
  });
});
