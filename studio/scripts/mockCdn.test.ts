import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { musicLists } from "../engine/music/fixtures";
import { EXCERPTS, excerptOf, JPEG_1X1 } from "../engine/music/testing/storeKit";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { nativeFetch, useNativeHttp } from "../testing/nativeHttp";
import { startMockCdn, withExcerptDurations, type MockCdn } from "./mockCdn";
useNativeGlobals();
useNativeHttp();

// The mock CDN of the E2E build (3c.4): 127.0.0.1 only, answering exactly the paths of a 3c.1 list with the HE-AAC
// excerpts and a JPEG cover, and nothing else. It never sees the flashapi key, and it says so if it was sent one.

interface Item {
  track: { progressive_download_url: string; cover_artwork_uri?: string; duration_in_ms: number };
}
const listOf = (which: keyof typeof musicLists): { response: { items: Item[] } } => JSON.parse(readFileSync(musicLists[which].file, "utf8")) as { response: { items: Item[] } };
const pathOf = (href: string): string => {
  const url = new URL(href);
  return `${url.pathname}${url.search}`;
};

let cdn: MockCdn | null = null;
afterEach(async () => {
  await cdn?.stop();
  cdn = null;
});

const get = async (path: string, headers: Record<string, string> = {}) => {
  const response = await nativeFetch(`${cdn?.url}${path}`, { headers });
  return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()), type: response.headers.get("content-type") };
};

describe("the mock CDN", () => {
  test("listens on loopback only", () => {
    cdn = startMockCdn({});
    expect(new URL(cdn.url).hostname).toBe("127.0.0.1");
  });

  test("serves each download path of the list with an excerpt, cycling through the four", async () => {
    cdn = startMockCdn({});
    const { items } = listOf("kyiv").response;
    for (const index of [0, 1, 2, 3, 4]) {
      const got = await get(pathOf(items[index]?.track.progressive_download_url ?? ""));
      expect(got.status).toBe(200);
      expect(Buffer.from(got.bytes).equals(Buffer.from(excerptOf(index)))).toBe(true);
      expect(got.type).toBe("video/mp4");
    }
  });

  test("serves each cover path with a JPEG", async () => {
    cdn = startMockCdn({});
    const first = listOf("kyiv").response.items[0]?.track.cover_artwork_uri ?? "";
    const got = await get(pathOf(first));
    expect(got.status).toBe(200);
    expect(Buffer.from(got.bytes).equals(Buffer.from(JPEG_1X1))).toBe(true);
  });

  test("serves the Frankfurt list's paths too", async () => {
    cdn = startMockCdn({ fixture: "frankfurt" });
    const item = listOf("frankfurt").response.items[0];
    expect((await get(pathOf(item?.track.progressive_download_url ?? ""))).status).toBe(200);
  });

  test("answers any other path with a 404, and keeps it in `unexpected` for the caller to assert empty", async () => {
    cdn = startMockCdn({});
    expect((await get("/somewhere/else.m4a")).status).toBe(404);
    expect(cdn.unexpected).toEqual(["GET /somewhere/else.m4a"]);
  });

  test("a different query on a known path is another path", async () => {
    cdn = startMockCdn({});
    const known = pathOf(listOf("kyiv").response.items[0]?.track.progressive_download_url ?? "");
    expect((await get(`${known}&extra=1`)).status).toBe(404);
  });

  test("records every request with its headers, so a test can assert what was and was not sent", async () => {
    cdn = startMockCdn({});
    const known = pathOf(listOf("kyiv").response.items[0]?.track.progressive_download_url ?? "");
    await get(known, { "x-marker": "hello" });
    expect(cdn.requests).toHaveLength(1);
    expect(cdn.requests[0]).toMatchObject({ method: "GET", path: known });
    expect(cdn.requests[0]?.headers["x-marker"]).toBe("hello");
  });

  test("an override answers a path with something else: a redirect, an HTML page, an error", async () => {
    cdn = startMockCdn({});
    const known = pathOf(listOf("kyiv").response.items[0]?.track.progressive_download_url ?? "");
    cdn.override(known, { status: 302, headers: { location: "https://scontent-fra3-1.cdninstagram.com/other" } });
    const redirect = await nativeFetch(`${cdn.url}${known}`, { redirect: "manual" });
    expect(redirect.status).toBe(302);
    cdn.override(known, { body: "<html>login</html>", headers: { "content-type": "text/html" } });
    const html = await get(known);
    expect(new TextDecoder().decode(html.bytes)).toBe("<html>login</html>");
    expect(html.type).toBe("text/html");
  });

  test("is listed by index so a scenario can name the track it spoils", () => {
    cdn = startMockCdn({});
    const { items } = listOf("kyiv").response;
    expect(cdn.downloadPath(2)).toBe(pathOf(items[2]?.track.progressive_download_url ?? ""));
    expect(cdn.coverPath(2)).toBe(pathOf(items[2]?.track.cover_artwork_uri ?? ""));
  });
});

describe("withExcerptDurations", () => {
  test("sets each track's claimed length to the excerpt that serves it, and touches nothing else", () => {
    const { response } = listOf("kyiv");
    const changed = withExcerptDurations(structuredClone(response)) as { items: Item[] };
    changed.items.forEach((item, index) => {
      expect(item.track.duration_in_ms).toBe(EXCERPTS[index % EXCERPTS.length]?.durationMs ?? 0);
      expect(item.track.progressive_download_url).toBe(response.items[index]?.track.progressive_download_url ?? "");
    });
    expect(changed.items).toHaveLength(response.items.length);
  });

  test("does not modify the object it was given", () => {
    const { response } = listOf("kyiv");
    const before = JSON.stringify(response);
    withExcerptDurations(response);
    expect(JSON.stringify(response)).toBe(before);
  });

  test("leaves a body that is not a list as it is", () => {
    expect(withExcerptDurations({ nope: 1 })).toEqual({ nope: 1 });
    expect(withExcerptDurations("text")).toBe("text");
  });
});
