import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { expectNoKeyFragment } from "../../testing/keyLeaks";
import { musicLists } from "./fixtures";
import { parseFlashapiList } from "./listSchema";
import { buildRefreshReport } from "./refreshReport";
import type { FlashapiResponseInfo } from "./client";

// The first real refresh logs (plan, Quota row): every header NAME with values only for the rate-limit ones, the
// status, the item count, page_info, the dropped items, unknown keys, the distinct open-string values, the explicit
// count, each URL's host and scheme, the minimum expiry, and the local counter beside the server's remaining. Never
// the key and never a whole signed URL.

const KEY = "Zq7-vKt9-Wm2x-Lp4s-0000";

const response: FlashapiResponseInfo = {
  status: 200,
  headerNames: ["content-type", "server", "x-ratelimit-requests-limit", "x-ratelimit-requests-remaining"],
  rateLimit: { "x-ratelimit-requests-limit": "30", "x-ratelimit-requests-remaining": "28" },
  remaining: 28,
  limit: 30,
  bodyBytes: 196_000,
};

function realList() {
  const parsed = parseFlashapiList((JSON.parse(readFileSync(musicLists.kyiv.file, "utf8")) as { response: unknown }).response);
  if (!parsed.ok) throw new Error("fixture");
  return parsed;
}

describe("buildRefreshReport", () => {
  test("of a good answer names the status, header names, rate-limit values and both quota counters", () => {
    const report = buildRefreshReport({ response, list: realList(), localSentInWindow: 1, now: Date.parse(musicLists.kyiv.fetchedAt) });
    expect(report).toMatchObject({
      httpStatus: 200,
      headerNames: response.headerNames,
      rateLimit: response.rateLimit,
      bodyBytes: 196_000,
      quota: { localSentInWindow: 1, serverRemaining: 28, serverLimit: 30 },
      items: 30,
      kept: 30,
      explicit: musicLists.kyiv.explicitCount,
    });
  });

  test("lists the distinct open-string values, the dropped items, the page_info and the unknown keys", () => {
    const report = buildRefreshReport({ response, list: realList(), localSentInWindow: 1, now: 0 });
    expect(report.monetizationValues).toContain("REVSHARE");
    expect(report.licensedSubtypes).toContain("DEFAULT");
    expect(report.pageInfo).toEqual({ nextMaxId: "30", moreAvailable: true });
    expect(report.dropped).toEqual({ total: 0, byReason: {}, indices: [] });
    expect(report.unknownKeys).toEqual({ topLevel: [], track: [], metadata: [] });
  });

  test("counts the dropped items by reason and keeps a bounded list of their indices", () => {
    const junk = Array.from({ length: 80 }, () => null);
    const parsed = parseFlashapiList({ status: "ok", items: junk });
    if (!parsed.ok) throw new Error("list");
    const report = buildRefreshReport({ response, list: parsed, localSentInWindow: 2, now: 0 });
    expect(report.dropped.total).toBe(80);
    expect(report.dropped.byReason).toEqual({ "no-track": 80 });
    expect(report.dropped.indices.length).toBeLessThanOrEqual(50);
  });

  test("gives each URL's scheme and host and the earliest expiry, never a path, a query or a signature", () => {
    const now = Date.parse(musicLists.kyiv.fetchedAt);
    const report = buildRefreshReport({ response, list: realList(), localSentInWindow: 1, now });
    expect(report.urlOrigins).toContain("https://instagram.fkiv8-1.fna.fbcdn.net");
    const text = JSON.stringify(report);
    expect(text).not.toMatch(/oe=|oh=|_nc_|\.mp4|\.jpg/);
    expect(report.minExpiresAt).not.toBeNull();
    const hours = (Date.parse(report.minExpiresAt ?? "") - now) / 3_600_000;
    expect(hours).toBeGreaterThan(100);
    expect(hours).toBeLessThan(110);
  });

  test("of an answer with no list (an error) still has the status, the names and the counters", () => {
    const report = buildRefreshReport({ response: { ...response, status: 401, remaining: null, limit: null, rateLimit: {} }, list: null, localSentInWindow: 3, now: 0 });
    expect(report).toMatchObject({ httpStatus: 401, items: null, kept: null, minExpiresAt: null, quota: { localSentInWindow: 3, serverRemaining: null } });
  });

  test("of a request that got no answer says so", () => {
    const report = buildRefreshReport({ response: null, list: null, localSentInWindow: 3, now: 0 });
    expect(report.httpStatus).toBeNull();
    expect(report.headerNames).toEqual([]);
  });

  test("carries no key and no fragment of it, even when the response's own text did", () => {
    const list = parseFlashapiList({
      status: "ok",
      items: [{ track: { id: "1395615172492847", progressive_download_url: `https://h.example/a.mp4?oe=68DC1E2F&k=${KEY}`, duration_in_ms: 5, song_monetization_info: KEY, title: KEY } }],
    });
    if (!list.ok) throw new Error("list");
    const report = buildRefreshReport({ response: { ...response, rateLimit: { "x-ratelimit-note": KEY } }, list, localSentInWindow: 1, now: 0, key: KEY });
    expectNoKeyFragment(JSON.stringify(report), KEY);
  });
});
