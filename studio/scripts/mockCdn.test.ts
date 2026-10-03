import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { musicLists } from "../engine/music/fixtures";
import { EXCERPTS, excerptOf, JPEG_1X1 } from "../engine/music/testing/storeKit";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { nativeFetch, useNativeHttp } from "../testing/nativeHttp";
import { signedUrlExpiresAtMs } from "../engine/music/signedUrl";
import { startMockCdn, withExcerptDurations, withFutureExpiry, type MockCdn } from "./mockCdn";
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

/** A path and query without the signature's expiry: the mock keys on everything else. */
const plain = (path: string): string => path.replace(/([?&])oe=[^&]*&?/, "$1").replace(/[?&]$/, "");

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

  // The fixtures' signed URLs expire 104 to 108 hours after 2026-09-27, so a run on the real clock after that would find
  // every URL expired (the E2E scenario did, on 2026-10-01). The run rewrites `oe` into the future; the mock ignores it.
  test("serves a known path whatever its `oe` says", async () => {
    cdn = startMockCdn({});
    const known = pathOf(listOf("kyiv").response.items[0]?.track.progressive_download_url ?? "");
    const later = known.replace(/oe=[0-9A-Fa-f]+/, "oe=FFFFFFFF");
    expect(later).not.toBe(known);
    expect((await get(later)).status).toBe(200);
  });

  test("an override given with any `oe` applies to the same path", async () => {
    cdn = startMockCdn({});
    const known = pathOf(listOf("kyiv").response.items[0]?.track.progressive_download_url ?? "");
    cdn.override(known, { status: 410, body: "gone" });
    expect((await get(known.replace(/oe=[0-9A-Fa-f]+/, "oe=FFFFFFFF"))).status).toBe(410);
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
    expect(cdn.requests[0]).toMatchObject({ method: "GET", path: plain(known) });
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
    expect(cdn.downloadPath(2)).toBe(plain(pathOf(items[2]?.track.progressive_download_url ?? "")));
    expect(cdn.coverPath(2)).toBe(plain(pathOf(items[2]?.track.cover_artwork_uri ?? "")));
  });
});

describe("withFutureExpiry", () => {
  const UNTIL = Date.parse("2030-01-01T00:00:00Z");
  const oeOf = (url: string): string | null => new URL(url).searchParams.get("oe");

  test("sets every download and cover URL's oe to the given time, as hex seconds, and keeps the rest of the URL", () => {
    const { response } = listOf("kyiv");
    const changed = withFutureExpiry(response, UNTIL) as { items: Item[] };
    changed.items.forEach((item, index) => {
      const before = new URL(response.items[index]?.track.progressive_download_url ?? "");
      const after = new URL(item.track.progressive_download_url);
      expect(oeOf(item.track.progressive_download_url)).toBe(Math.floor(UNTIL / 1000).toString(16).toUpperCase());
      expect(after.host + after.pathname).toBe(before.host + before.pathname);
      expect(after.searchParams.get("oh")).toBe(before.searchParams.get("oh"));
      if (item.track.cover_artwork_uri !== undefined) expect(oeOf(item.track.cover_artwork_uri)).toBe(Math.floor(UNTIL / 1000).toString(16).toUpperCase());
    });
  });

  test("makes the URLs live for the store's expiry reader", () => {
    const changed = withFutureExpiry(listOf("kyiv").response, UNTIL) as { items: Item[] };
    expect(signedUrlExpiresAtMs(changed.items[0]?.track.progressive_download_url ?? "")).toBe(Math.floor(UNTIL / 1000) * 1000);
  });

  test("does not modify what it was given, and leaves a body that is not a list as it is", () => {
    const { response } = listOf("kyiv");
    const before = JSON.stringify(response);
    withFutureExpiry(response, UNTIL);
    expect(JSON.stringify(response)).toBe(before);
    expect(withFutureExpiry({ nope: 1 }, UNTIL)).toEqual({ nope: 1 });
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
