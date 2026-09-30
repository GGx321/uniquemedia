import { afterEach, describe, expect, test } from "bun:test";
import { nativeFetch, useNativeHttp } from "../testing/nativeHttp";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { MOCK_FLASHAPI_HOST, MOCK_TRENDING_PATH, startMockFlashapi, type MockFlashapi } from "./mockFlashapi";
useNativeGlobals();
useNativeHttp();

const KEY = "Zq7-vKt9-Wm2x-Lp4s-0000";

let mock: MockFlashapi | null = null;
afterEach(async () => {
  await mock?.stop();
  mock = null;
});

const start = (options: Partial<Parameters<typeof startMockFlashapi>[0]> = {}): MockFlashapi => (mock = startMockFlashapi({ key: KEY, ...options }));
const call = (m: MockFlashapi, headers: Record<string, string> = { "x-rapidapi-host": MOCK_FLASHAPI_HOST, "x-rapidapi-key": KEY }, path = MOCK_TRENDING_PATH) =>
  nativeFetch(`${m.url}${path}`, { headers });

describe("the mock flashapi", () => {
  test("listens on loopback only", () => {
    expect(new URL(start().url).hostname).toBe("127.0.0.1");
  });

  test("serves a 3c.1 list with flashapi's rate-limit headers, its remaining counting down", async () => {
    const m = start();
    const first = await call(m);
    const body = (await first.json()) as { items: unknown[] };
    expect(first.status).toBe(200);
    expect(body.items).toHaveLength(30);
    expect(first.headers.get("x-ratelimit-requests-remaining")).toBe("28");
    expect(first.headers.get("x-ratelimit-requests-limit")).toBe("30");
    expect((await call(m)).headers.get("x-ratelimit-requests-remaining")).toBe("27");
  });

  test("serves the Frankfurt list when asked", async () => {
    const m = start({ fixture: "frankfurt" });
    const text = await (await call(m)).text();
    expect(text).toContain("cdninstagram.com");
  });

  test("answers 401 to another key and to none, and 403 to a wrong host header", async () => {
    const m = start();
    expect((await call(m, { "x-rapidapi-host": MOCK_FLASHAPI_HOST, "x-rapidapi-key": "someone-else-1" })).status).toBe(401);
    expect((await call(m, { "x-rapidapi-host": MOCK_FLASHAPI_HOST })).status).toBe(401);
    expect((await call(m, { "x-rapidapi-key": KEY, "x-rapidapi-host": "other.example" })).status).toBe(403);
  });

  test("records every request whole, and answers 404 loudly to anything but the list", async () => {
    const m = start();
    await call(m, undefined, "/ig/other/");
    expect(m.unexpected).toEqual(["GET /ig/other/"]);
    expect(m.requests[0]).toMatchObject({ method: "GET", path: "/ig/other/", search: "" });
    expect(m.requests[0]?.headers["x-rapidapi-key"]).toBe(KEY);
  });

  test("a scripted step is served once, in order, then the list again", async () => {
    const m = start();
    m.script({ status: 429, headers: { "retry-after": "120" } }, { status: 500, body: "boom" });
    expect((await call(m)).status).toBe(429);
    expect(await (await call(m)).text()).toBe("boom");
    expect((await call(m)).status).toBe(200);
  });

  test("a scripted oversize body arrives with or without a Content-Length", async () => {
    const m = start();
    m.script({ oversize: { bytes: 5000, contentLength: true } }, { oversize: { bytes: 5000, contentLength: false } });
    const withLength = await call(m);
    expect(withLength.headers.get("content-length")).toBe("5000");
    await withLength.arrayBuffer();
    const streamed = await call(m);
    expect(streamed.headers.get("content-length")).toBeNull();
    expect((await streamed.arrayBuffer()).byteLength).toBe(5000);
  });

  test("echoKey puts the key it was sent into the 401 body and a header", async () => {
    const m = start({ echoKey: true });
    const response = await call(m, { "x-rapidapi-host": MOCK_FLASHAPI_HOST, "x-rapidapi-key": "wrong-key-value" });
    expect(await response.text()).toContain("wrong-key-value");
    expect(response.headers.get("x-echo")).toBe("wrong-key-value");
  });
});

describe("transformResponse", () => {
  test("changes the list it serves, and only the list", async () => {
    const m = start({
      transformResponse: (response) => {
        const copy = structuredClone(response) as { items: unknown[] };
        return { ...copy, items: copy.items.slice(0, 3) };
      },
    });
    const response = await call(m);
    expect(((await response.json()) as { items: unknown[] }).items).toHaveLength(3);
    expect(response.headers.get("x-ratelimit-requests-remaining")).toBe("28");
  });

  test("is asked once, so a later answer is the same list", async () => {
    let calls = 0;
    const m = start({
      transformResponse: (response) => {
        calls++;
        return response;
      },
    });
    await (await call(m)).text();
    await (await call(m)).text();
    expect(calls).toBe(1);
  });

  test("leaves a scripted answer alone", async () => {
    const m = start({ transformResponse: () => ({ items: [] }) });
    m.script({ status: 429, body: "quota exceeded" });
    expect(await (await call(m)).text()).toBe("quota exceeded");
  });
});
