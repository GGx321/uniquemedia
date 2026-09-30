import { afterEach, describe, expect, test } from "bun:test";
import { startMockFlashapi, type MockFlashapi, type MockFlashapiStep } from "../../scripts/mockFlashapi";
import { captureConsole, expectNoKeyFragment } from "../../testing/keyLeaks";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { nativeFetch, useNativeHttp } from "../../testing/nativeHttp";
import {
  createFlashapiClient,
  FLASHAPI_BASE,
  FLASHAPI_HOST,
  FlashapiError,
  type FlashapiClientOptions,
  type FlashapiFailure,
  type FlashapiFetch,
} from "./client";
useNativeGlobals();
useNativeHttp();

// Only fake keys, only a loopback mock: nothing here reaches the network, and a `fetch` that would is refused.

const KEY = "Zq7-vKt9-Wm2x-Lp4s-0000";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

let mock: MockFlashapi | null = null;
let hosts: string[] = [];
afterEach(async () => {
  await mock?.stop();
  mock = null;
  hosts = [];
});

/** Records every host it is asked for, and refuses one that is not loopback: the real flashapi is never contacted. */
const guardedFetch: FlashapiFetch = (input, init) => {
  const url = new URL(input);
  hosts.push(url.hostname);
  if (!LOOPBACK.has(url.hostname)) throw new Error(`a test reached ${url.hostname}`);
  return nativeFetch(input, init);
};

function start(options: Partial<Parameters<typeof startMockFlashapi>[0]> = {}): MockFlashapi {
  mock = startMockFlashapi({ key: KEY, ...options });
  return mock;
}

function clientFor(m: MockFlashapi, options: Partial<FlashapiClientOptions> = {}) {
  return createFlashapiClient({ key: KEY, baseUrl: m.url, allowBaseUrlOverride: true, fetch: guardedFetch, ...options });
}

/** The failure `fetchTrending` ends in, or a test failure if it succeeds. */
async function failureOf(run: Promise<unknown>): Promise<FlashapiError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof FlashapiError) return error;
    throw error;
  }
  throw new Error("expected the request to fail");
}

/** Everything a failure could print or carry, for a leak check. */
function everythingOf(error: FlashapiError): string {
  // `Bun.inspect` is what `console.error(error)` prints: it shows own properties and a `cause`, which `message` does not.
  return [error.message, error.detail, error.stack ?? "", JSON.stringify(error), JSON.stringify(error.response), Bun.inspect(error)].join("\n");
}

describe("the request", () => {
  test("is one GET of /ig/music_trending/ with the key and the real host name in headers, and nothing else in it", async () => {
    const m = start();
    await clientFor(m).fetchTrending();
    expect(m.requests).toHaveLength(1);
    const [request] = m.requests;
    expect(request).toMatchObject({ method: "GET", path: "/ig/music_trending/", search: "" });
    expect(request?.headers["x-rapidapi-key"]).toBe(KEY);
    expect(request?.headers["x-rapidapi-host"]).toBe(FLASHAPI_HOST);
    expect(request?.headers["authorization"]).toBeUndefined();
    expect(request?.headers["cookie"]).toBeUndefined();
    expect(m.unexpected).toEqual([]);
  });

  test("carries the key ONLY in the x-rapidapi-key header: never in the URL, the query or another header", async () => {
    const m = start();
    await clientFor(m).fetchTrending();
    const [request] = m.requests;
    expectNoKeyFragment(request?.url ?? "", KEY);
    expectNoKeyFragment(request?.search ?? "", KEY);
    for (const [name, value] of Object.entries(request?.headers ?? {})) {
      if (name === "x-rapidapi-key") continue;
      expectNoKeyFragment(`${name}: ${value}`, KEY);
    }
  });

  test("the URL it builds has no key even for a base that carries a path", async () => {
    const seen: string[] = [];
    const client = createFlashapiClient({
      key: KEY,
      baseUrl: FLASHAPI_BASE,
      allowBaseUrlOverride: false,
      fetch: (input) => {
        seen.push(String(input));
        return Promise.reject(new TypeError("no network in this test"));
      },
    });
    await failureOf(client.fetchTrending());
    expect(seen).toEqual([`${FLASHAPI_BASE}/ig/music_trending/`]);
    for (const url of seen) expectNoKeyFragment(url, KEY);
  });

  test("sends no body and no pagination parameter: one page of thirty is enough", async () => {
    const m = start();
    await clientFor(m).fetchTrending();
    expect(m.requests[0]?.search).toBe("");
  });

  test("contacts only loopback in these tests", async () => {
    const m = start();
    await clientFor(m).fetchTrending();
    expect(hosts.length).toBeGreaterThan(0);
    for (const host of hosts) expect(LOOPBACK.has(host)).toBe(true);
  });

  test.each([
    ["a 500", { status: 500, body: "boom" }],
    ["a 429", { status: 429 }],
    ["a 401", { status: 401, body: {} }],
    ["not JSON", { status: 200, body: "not json" }],
    ["slower than the timeout", { delayMs: 200 }],
  ] as const)("makes exactly one request when the answer is %s: no retry", async (_label, step) => {
    const m = start();
    m.script(step);
    await clientFor(m, { timeoutMs: 80 }).fetchTrending().then(() => undefined, () => undefined);
    await Bun.sleep(250);
    expect(m.requests).toHaveLength(1);
  });
});

describe("a good answer", () => {
  test("is the parsed list, with the answer's status and its rate-limit figures", async () => {
    const m = start();
    const { list, response } = await clientFor(m).fetchTrending();
    expect(list.tracks).toHaveLength(30);
    expect(response).toMatchObject({ status: 200, remaining: 28, limit: 30 });
    expect(response.bodyBytes).toBeGreaterThan(100_000);
  });

  test("names every response header, and keeps a value only for the rate-limit ones", async () => {
    const m = start({ echoKey: true });
    const { response } = await clientFor(m).fetchTrending();
    expect(response.headerNames).toContain("x-ratelimit-requests-remaining");
    expect(response.headerNames).toContain("server");
    expect(response.rateLimit).toEqual({ "x-ratelimit-requests-limit": "30", "x-ratelimit-requests-remaining": "28" });
    expect(JSON.stringify(response)).not.toContain("RapidAPI-1.2.8");
  });

  test("a header that echoes the key is neither kept nor able to leak it, even under a rate-limit-like name", async () => {
    const m = start();
    m.script({ status: 200, body: { status: "ok", items: [] }, headers: { "x-ratelimit-note": KEY, "x-echo-key": KEY } });
    const { response } = await clientFor(m).fetchTrending();
    expect(response.headerNames).toContain("x-ratelimit-note");
    expectNoKeyFragment(JSON.stringify(response), KEY);
    expect(response.rateLimit["x-ratelimit-note"]).toBe("[redacted]");
  });

  test("the server's own time, from its Date header, comes back as epoch ms; a missing or junk one is null", async () => {
    const m = start();
    m.script({ status: 200, body: { status: "ok", items: [] }, headers: { date: "Wed, 30 Sep 2026 12:00:00 GMT" } });
    expect((await clientFor(m).fetchTrending()).response.serverDateMs).toBe(Date.UTC(2026, 8, 30, 12, 0, 0));
    for (const junk of ["yesterday", "", "Thu, 01 Jan 1970 00:00:00 GMT", "Wed, 30 Sep 3000 12:00:00 GMT"]) {
      m.script({ status: 200, body: { status: "ok", items: [] }, headers: { date: junk } });
      expect((await clientFor(m).fetchTrending()).response.serverDateMs).toBeNull();
    }
  });

  test("an empty list is a good answer: no tracks, and the figures still come back", async () => {
    const m = start();
    m.script({ status: 200, body: { status: "ok", items: [] }, headers: { "x-ratelimit-requests-remaining": "0" } });
    const { list, response } = await clientFor(m).fetchTrending();
    expect(list.tracks).toEqual([]);
    expect(response.remaining).toBe(0);
  });

  test("the Frankfurt list parses too", async () => {
    const m = start({ fixture: "frankfurt" });
    const { list } = await clientFor(m).fetchTrending();
    expect(list.tracks).toHaveLength(30);
  });

  test.each([
    ["absent", undefined, null],
    ["a number", "7", 7],
    ["zero", "0", 0],
    ["not a number", "many", null],
    ["negative (a server that over-counted: it is exhausted, so 0)", "-1", 0],
    ["a huge negative", "-999999999", 0],
    ["a negative with junk", "-1x", null],
    ["fractional", "2.5", null],
    ["a huge digit string", "9".repeat(30), null],
  ])("the server's remaining, when it is %s, reads as %p", async (_label, header, expected) => {
    const m = start();
    m.script({ status: 200, body: { status: "ok", items: [] }, headers: header === undefined ? {} : { "x-ratelimit-requests-remaining": header } });
    const { response } = await clientFor(m).fetchTrending();
    expect(response.remaining).toBe(expected);
  });
});

describe("a failed answer", () => {
  const cases: { name: string; step: MockFlashapiStep; kind: FlashapiFailure; status: number | null }[] = [
    { name: "401", step: { status: 401, body: { message: "Invalid API key" } }, kind: "rejected", status: 401 },
    { name: "403", step: { status: 403, body: { message: "You are not subscribed to this API." } }, kind: "forbidden", status: 403 },
    { name: "404", step: { status: 404, body: "gone" }, kind: "http", status: 404 },
    { name: "429", step: { status: 429, body: "slow down" }, kind: "rate-limited", status: 429 },
    { name: "500", step: { status: 500, body: "boom" }, kind: "http", status: 500 },
    { name: "503", step: { status: 503, body: "" }, kind: "http", status: 503 },
    { name: "a redirect", step: { redirectTo: "http://127.0.0.1:1/elsewhere" }, kind: "http", status: 302 },
  ];

  test.each(cases)("$name is $kind", async ({ step, kind, status }) => {
    const m = start();
    m.script(step);
    const error = await failureOf(clientFor(m).fetchTrending());
    expect(error.kind).toBe(kind);
    expect(error.status).toBe(status);
    expect(error.response?.status).toBe(status ?? -1);
  });

  test("a failed answer still carries the server's figures, so a floor of 0 is seen on an error too", async () => {
    const m = start();
    m.script({ status: 429, body: "over quota", headers: { "x-ratelimit-requests-remaining": "0" } });
    const error = await failureOf(clientFor(m).fetchTrending());
    expect(error.response?.remaining).toBe(0);
  });

  test("a 429's Retry-After in seconds becomes retryAfterMs; a date or junk is ignored", async () => {
    for (const [header, expected] of [["120", 120_000], ["Wed, 21 Oct 2026 07:28:00 GMT", null], ["-5", null], ["abc", null]] as const) {
      const m = start();
      m.script({ status: 429, headers: { "retry-after": header } });
      const error = await failureOf(clientFor(m).fetchTrending());
      expect(error.retryAfterMs).toBe(expected);
      await m.stop();
      mock = null;
    }
  });

  test("a 401 whose body and header echo the key never carries it, whatever it prints or serialises to", async () => {
    const m = start({ echoKey: true });
    m.script({ status: 401, body: { message: `Invalid API key: ${KEY}` }, headers: { "x-ratelimit-requests-remaining": "3", "x-echo": KEY } });
    const output = captureConsole();
    try {
      const error = await failureOf(clientFor(m).fetchTrending());
      expect(error.kind).toBe("rejected");
      expectNoKeyFragment(everythingOf(error), KEY);
      expectNoKeyFragment(output.text(), KEY);
    } finally {
      output.restore();
    }
  });

  test("a body that echoes the key in an encoded or sliced form is redacted too", async () => {
    const m = start();
    m.script({ status: 500, body: `trace ${encodeURIComponent(KEY)} ${KEY.slice(4, 16)} ${Buffer.from(KEY).toString("base64")}` });
    const error = await failureOf(clientFor(m).fetchTrending());
    expectNoKeyFragment(everythingOf(error), KEY);
    expect(error.detail).toContain("500");
  });

  test("the detail keeps a short redacted, control-free snippet of an error body to diagnose it, and no more", async () => {
    const m = start();
    m.script({ status: 500, body: `oops\u0000\u0007 ${"y".repeat(5000)}` });
    const error = await failureOf(clientFor(m).fetchTrending());
    expect(error.detail).toContain("oops");
    expect(error.detail).not.toMatch(/[\u0000-\u0008]/);
    expect(error.detail.length).toBeLessThan(400);
  });

  test("a redirect is not followed: the key never reaches the other host", async () => {
    const other = startMockFlashapi({ key: KEY });
    try {
      const m = start();
      m.script({ redirectTo: `${other.url}/ig/music_trending/` });
      const error = await failureOf(clientFor(m).fetchTrending());
      expect(error.kind).toBe("http");
      expect(other.requests).toEqual([]);
    } finally {
      await other.stop();
    }
  });
});

describe("a request that fails before an answer", () => {
  test("a network error is `network`, and its message is redacted even when the runtime put the key in it", async () => {
    const client = createFlashapiClient({
      key: KEY,
      baseUrl: FLASHAPI_BASE,
      allowBaseUrlOverride: false,
      fetch: () => Promise.reject(new TypeError(`fetch failed: GET https://h.example/?k=${KEY} with x-rapidapi-key: ${KEY}`)),
    });
    const error = await failureOf(client.fetchTrending());
    expect(error.kind).toBe("network");
    expect(error.status).toBeNull();
    expect(error.response).toBeNull();
    expectNoKeyFragment(everythingOf(error), KEY);
  });

  test.each([
    ["ECONNREFUSED", "ECONNREFUSED"],
    ["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT"],
    ["ENOTFOUND", "ENOTFOUND"],
  ])("under Electron's Node `fetch failed` hides its cause: a cause code %s is appended to the detail", async (_label, code) => {
    const client = createFlashapiClient({
      key: KEY,
      baseUrl: FLASHAPI_BASE,
      allowBaseUrlOverride: false,
      fetch: () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(`connect ${KEY}`), { code }) })),
    });
    const error = await failureOf(client.fetchTrending());
    expect(error.kind).toBe("network");
    expect(error.detail).toContain(code);
    expectNoKeyFragment(everythingOf(error), KEY);
  });

  test.each([
    ["lower case", "econnrefused"],
    ["too short", "E"],
    ["too long", "E".repeat(41)],
    ["holding the key", KEY],
    ["holding a space", "ECONN REFUSED"],
    ["not a string", 42],
  ])("a cause code that is %s is ignored, and the error keeps no reference to the cause", async (_label, code) => {
    const client = createFlashapiClient({
      key: KEY,
      baseUrl: FLASHAPI_BASE,
      allowBaseUrlOverride: false,
      fetch: () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code } })),
    });
    const error = await failureOf(client.fetchTrending());
    expect(error.detail).toBe("the request failed (TypeError: fetch failed)");
    expect(Reflect.get(error, "cause")).toBeUndefined();
    expectNoKeyFragment(everythingOf(error), KEY);
  });

  test("a refused connection (nothing listening) is `network`", async () => {
    const m = start();
    const base = m.url;
    await m.stop();
    mock = null;
    const error = await failureOf(createFlashapiClient({ key: KEY, baseUrl: base, allowBaseUrlOverride: true, fetch: guardedFetch }).fetchTrending());
    expect(error.kind).toBe("network");
  });

  test("an answer slower than the timeout is `timeout`", async () => {
    const m = start();
    m.script({ delayMs: 400 });
    const started = performance.now();
    const error = await failureOf(clientFor(m, { timeoutMs: 60 }).fetchTrending());
    expect(error.kind).toBe("timeout");
    expect(performance.now() - started).toBeLessThan(350);
  });

  test("a caller's abort is `aborted`, not a timeout", async () => {
    const m = start();
    m.script({ delayMs: 400 });
    const controller = new AbortController();
    const run = clientFor(m, { timeoutMs: 5000 }).fetchTrending(controller.signal);
    setTimeout(() => controller.abort(), 30);
    expect((await failureOf(run)).kind).toBe("aborted");
  });

  test("a signal that is already aborted sends nothing", async () => {
    const m = start();
    const controller = new AbortController();
    controller.abort();
    expect((await failureOf(clientFor(m).fetchTrending(controller.signal))).kind).toBe("aborted");
    expect(m.requests).toEqual([]);
  });
});

describe("the size of the answer is bounded", () => {
  test("a Content-Length over the cap is refused BEFORE the body is read: not one chunk is pulled, and the stream is cancelled", async () => {
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fake: FlashapiFetch = () => Promise.resolve(new Response(stream, { status: 200, headers: { "content-length": "20000" } }));
    const client = createFlashapiClient({ key: KEY, baseUrl: FLASHAPI_BASE, allowBaseUrlOverride: false, fetch: fake, maxBodyBytes: 5000 });
    const error = await failureOf(client.fetchTrending());
    expect(error.kind).toBe("too-large");
    expect(error.detail).toContain("5000");
    expect(cancelled).toBe(true);
    // A stream cut is different: it has to pull past the cap first. Here the body was never asked for.
    expect(pulled).toBeLessThanOrEqual(1);
  });

  test("a body that lies about its Content-Length by being longer is cut at the cap, having been read", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
      },
    });
    const fake: FlashapiFetch = () => Promise.resolve(new Response(stream, { status: 200, headers: { "content-length": "100" } }));
    const client = createFlashapiClient({ key: KEY, baseUrl: FLASHAPI_BASE, allowBaseUrlOverride: false, fetch: fake, maxBodyBytes: 5000 });
    expect((await failureOf(client.fetchTrending())).kind).toBe("too-large");
    expect(pulled).toBeGreaterThanOrEqual(5);
  });

  test("a streamed body without a Content-Length is cut off past the cap", async () => {
    const m = start();
    m.script({ oversize: { bytes: 50_000_000, contentLength: false } });
    const started = performance.now();
    const error = await failureOf(clientFor(m, { maxBodyBytes: 5000 }).fetchTrending());
    expect(error.kind).toBe("too-large");
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("a body of exactly the cap is read; one byte more is refused", async () => {
    const body = JSON.stringify({ status: "ok", items: [] });
    const size = new TextEncoder().encode(body).byteLength;
    const m = start();
    m.script({ status: 200, body });
    const { list } = await clientFor(m, { maxBodyBytes: size }).fetchTrending();
    expect(list.tracks).toEqual([]);
    m.script({ status: 200, body });
    expect((await failureOf(clientFor(m, { maxBodyBytes: size - 1 }).fetchTrending())).kind).toBe("too-large");
  });

  test("the default cap holds a real list (about 190 KB) with room to spare", async () => {
    const m = start();
    expect((await clientFor(m).fetchTrending()).response.bodyBytes).toBeLessThan(1024 * 1024);
  });
});

describe("an answer that is not a list", () => {
  test.each([
    ["not JSON", "<html>bad gateway</html>"],
    ["an empty body", ""],
    ["a JSON string", '"ok"'],
    ["an object without items", '{"status":"ok"}'],
    ["a truncated list", '{"status":"ok","items":[{"track":'],
  ])("%s is `invalid`, with the answer's figures", async (_label, body) => {
    const m = start();
    m.script({ status: 200, body, headers: { "x-ratelimit-requests-remaining": "5" } });
    const error = await failureOf(clientFor(m).fetchTrending());
    expect(error.kind).toBe("invalid");
    expect(error.response).toMatchObject({ status: 200, remaining: 5 });
  });
});

describe("what the client refuses to be built with", () => {
  const base = { key: KEY, fetch: guardedFetch };

  test("the real base is accepted without an override", () => {
    expect(() => createFlashapiClient({ ...base, baseUrl: FLASHAPI_BASE, allowBaseUrlOverride: false })).not.toThrow();
    expect(() => createFlashapiClient({ ...base, baseUrl: `${FLASHAPI_BASE}/`, allowBaseUrlOverride: false })).not.toThrow();
  });

  test("any other base is refused in a build without the override, loopback included: the override is compiled out", () => {
    for (const baseUrl of ["http://127.0.0.1:8080", "https://flashapi1.p.rapidapi.com.evil.example", "https://evil.example", "http://flashapi1.p.rapidapi.com"]) {
      expect(() => createFlashapiClient({ ...base, baseUrl, allowBaseUrlOverride: false })).toThrow(/base URL/);
    }
  });

  test("with the override only a loopback http or https base is accepted", () => {
    for (const baseUrl of ["http://127.0.0.1:8080", "http://localhost:9", "https://127.0.0.1:1", "http://[::1]:5"]) {
      expect(() => createFlashapiClient({ ...base, baseUrl, allowBaseUrlOverride: true })).not.toThrow();
    }
    for (const baseUrl of ["https://evil.example", "http://127.0.0.1.evil.example", "ftp://127.0.0.1", "file:///tmp", "http://user:pw@127.0.0.1:1", "http://127.0.0.1:1/?k=v", "not a url", "http://10.0.0.1:80", "http://0.0.0.0:80"]) {
      expect(() => createFlashapiClient({ ...base, baseUrl, allowBaseUrlOverride: true })).toThrow(/base URL/);
    }
  });

  test.each([
    ["empty", ""],
    ["blank", "   "],
    ["with a space", "Zq7-vKt9 Wm2x-Lp4s-0000"],
    ["with a newline", "Zq7-vKt9-Wm2x-Lp4s-0000\n"],
    ["with a non-ASCII char", "Zq7-vKt9-Wm2x-Lp4s-000й"],
  ])("a key that is %s cannot go in a header, and the error does not echo it", (_label, key) => {
    let thrown: unknown;
    try {
      createFlashapiClient({ ...base, key, baseUrl: FLASHAPI_BASE, allowBaseUrlOverride: false });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    if (key.length >= 6) expectNoKeyFragment(String((thrown as Error).message), key);
  });
});
