import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TrackSummary } from "../../shared/engine";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import type { QuotaLine } from "./quotaLedger";
import { MusicService, type MusicListSink } from "./service";
useNativeGlobals();

// S4.10 fix B: `MusicService.autoRefreshOutlook` is the plan card's DRY RUN of the engine's own auto-refresh decision. It reads the files the real decision reads and answers the
// card's word and the requests left; it reserves nothing, logs nothing, heals nothing and sends nothing. The rule's boundaries are held in shared/autopilot/autoRefresh.test.ts;
// here is what the SERVICE feeds it and what it leaves alone.

const KEY = "Zq7-vKt9-Wm2x-Lp4s-0000";
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "studio-music-outlook-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const quotaPath = () => join(dir, "music", "quota.jsonl");
const autoPath = () => join(dir, "music", "auto-sends.jsonl");
const sendLine = (n: number, at: number): QuotaLine => ({ v: 1, kind: "send", id: `seed-${n}`, at, key: "0000" });
/** `n` sends, an hour apart, the newest 100 h ago: out of the way of the 72 h rules, inside the 31 days. */
const oldSends = (n: number): QuotaLine[] => Array.from({ length: n }, (_, i) => sendLine(i, NOW - 100 * HOUR - (n - i) * HOUR));
async function seedQuota(lines: readonly QuotaLine[]): Promise<void> {
  await mkdir(join(dir, "music"), { recursive: true });
  await writeFile(quotaPath(), lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
}
async function seedAuto(ats: readonly number[], tail = ""): Promise<void> {
  await mkdir(join(dir, "music"), { recursive: true });
  await writeFile(autoPath(), ats.map((at, i) => `${JSON.stringify({ id: `auto-${i}`, at })}\n`).join("") + tail);
}
/** The files as they are, and the folder's names: what «nothing happened» looks like. */
async function snapshot(): Promise<{ quota: string; auto: string; names: string[] }> {
  return {
    quota: await readFile(quotaPath(), "utf8").catch(() => "none"),
    auto: await readFile(autoPath(), "utf8").catch(() => "none"),
    names: await readdir(join(dir, "music")).catch(() => []),
  };
}

/** A sink that stores nothing and reports the list's age: the part of the sink the dry run reads. */
function sinkAt(listFetchedAt: number | null, persistent = true): MusicListSink {
  return {
    persistent,
    accept: () => Promise.reject(new Error("a dry run stores no list")),
    summary: () => ({ listFetchedAt, trackCount: 0, bytesOnDisk: 0 }),
    list: (): TrackSummary[] => [],
    peaks: () => Promise.resolve(null),
  };
}

interface Rig {
  service: MusicService;
  requests: string[];
  holder: { key: string | null; rejected: boolean };
}

function rig(options: { sink?: MusicListSink; quota?: boolean } = {}): Rig {
  const requests: string[] = [];
  const holder = { key: KEY as string | null, rejected: false };
  const service = new MusicService({
    quotaPath: options.quota === false ? null : quotaPath(),
    baseUrl: "http://127.0.0.1:1",
    allowBaseUrlOverride: true,
    fetch: (url) => {
      requests.push(String(url));
      return Promise.reject(new Error("a dry run sends nothing"));
    },
    clock: () => NOW,
    newId: () => "never-used",
    key: () => holder.key,
    keyRejected: () => holder.rejected,
    markKeyRejected: () => undefined,
    emit: () => undefined,
    log: () => undefined,
    sink: options.sink ?? sinkAt(NOW - 100 * HOUR),
  });
  return { service, requests, holder };
}

describe("autoRefreshOutlook: the word and the requests left", () => {
  test("a key, no quota file and a stale list: will, with all 30 left", async () => {
    expect(await rig().service.autoRefreshOutlook(5)).toEqual({ autoRefresh: "will", quotaRemaining: 30 });
  });

  test("19 sends in the window: will, 11 left", async () => {
    await seedQuota(oldSends(19));
    expect(await rig().service.autoRefreshOutlook(5)).toEqual({ autoRefresh: "will", quotaRemaining: 11 });
  });

  test("20 sends in the window: no-quota, 10 left", async () => {
    await seedQuota(oldSends(20));
    expect(await rig().service.autoRefreshOutlook(5)).toEqual({ autoRefresh: "no-quota", quotaRemaining: 10 });
  });

  test("no key: no-key, and the requests left are still told", async () => {
    await seedQuota(oldSends(9));
    const r = rig();
    r.holder.key = null;
    expect(await r.service.autoRefreshOutlook(5)).toEqual({ autoRefresh: "no-key", quotaRemaining: 21 });
  });

  test("a key the engine marked rejected: no-key", async () => {
    const r = rig();
    r.holder.rejected = true;
    expect((await r.service.autoRefreshOutlook(5)).autoRefresh).toBe("no-key");
  });

  test("a key the ledger remembers as rejected: no-key", async () => {
    await seedQuota([sendLine(1, NOW - 5 * DAY), { v: 1, kind: "result", id: "seed-1", at: NOW - 5 * DAY, key: "0000", outcome: "rejected", status: 401 }]);
    expect((await rig().service.autoRefreshOutlook(5)).autoRefresh).toBe("no-key");
  });

  test("a server that last said 10 requests remain: no-quota", async () => {
    await seedQuota([sendLine(1, NOW - 5 * DAY), { v: 1, kind: "result", id: "seed-1", at: NOW - 5 * DAY, key: "0000", outcome: "ok", status: 200, remaining: 10, limit: 30 }]);
    expect((await rig().service.autoRefreshOutlook(5)).autoRefresh).toBe("no-quota");
  });

  test("a quota log that cannot be read: no-quota and no figure", async () => {
    await mkdir(join(dir, "music"), { recursive: true });
    await writeFile(quotaPath(), "this is not json\n");
    expect(await rig().service.autoRefreshOutlook(5)).toEqual({ autoRefresh: "no-quota", quotaRemaining: null });
  });

  test("10 automatic sends in the window: no-quota", async () => {
    await seedAuto(Array.from({ length: 10 }, (_, i) => NOW - 4 * DAY - i * 2 * HOUR));
    expect((await rig().service.autoRefreshOutlook(5)).autoRefresh).toBe("no-quota");
  });

  test("9 automatic sends, the newest 4 days ago: will", async () => {
    await seedAuto(Array.from({ length: 9 }, (_, i) => NOW - 4 * DAY - i * 2 * HOUR));
    expect((await rig().service.autoRefreshOutlook(5)).autoRefresh).toBe("will");
  });

  test("an automatic send 71 h ago: no-quota", async () => {
    await seedAuto([NOW - 71 * HOUR]);
    expect((await rig().service.autoRefreshOutlook(5)).autoRefresh).toBe("no-quota");
  });

  test("a damaged automatic log: no-quota", async () => {
    await mkdir(join(dir, "music"), { recursive: true });
    await writeFile(autoPath(), "nonsense\n");
    expect((await rig().service.autoRefreshOutlook(5)).autoRefresh).toBe("no-quota");
  });

  test("a list 71 h old with 10 candidates: not-needed", async () => {
    expect((await rig({ sink: sinkAt(NOW - 71 * HOUR) }).service.autoRefreshOutlook(10)).autoRefresh).toBe("not-needed");
  });

  test("a list 71 h old with 9 candidates: will", async () => {
    expect((await rig({ sink: sinkAt(NOW - 71 * HOUR) }).service.autoRefreshOutlook(9)).autoRefresh).toBe("will");
  });

  test("a list 72 h old with 40 candidates: will", async () => {
    expect((await rig({ sink: sinkAt(NOW - 72 * HOUR) }).service.autoRefreshOutlook(40)).autoRefresh).toBe("will");
  });

  test("a sink that keeps nothing across a restart cannot refresh: no-quota", async () => {
    expect((await rig({ sink: sinkAt(null, false) }).service.autoRefreshOutlook(5)).autoRefresh).toBe("no-quota");
  });

  test("no music folder: no-quota and no figure", async () => {
    expect(await rig({ quota: false }).service.autoRefreshOutlook(5)).toEqual({ autoRefresh: "no-quota", quotaRemaining: null });
  });
});

describe("autoRefreshOutlook: a dry run", () => {
  test("sends no request", async () => {
    await seedQuota(oldSends(3));
    const r = rig();
    await r.service.autoRefreshOutlook(5);
    expect(r.requests).toEqual([]);
  });

  test("changes no file: the ledger, the automatic log and the folder stay as they were", async () => {
    await seedQuota(oldSends(3));
    await seedAuto([NOW - 4 * DAY]);
    const before = await snapshot();
    await rig().service.autoRefreshOutlook(5);
    expect(await snapshot()).toEqual(before);
  });

  test("leaves a torn tail of the automatic log where it is, and counts the whole lines", async () => {
    await seedAuto(Array.from({ length: 9 }, (_, i) => NOW - 4 * DAY - i * 2 * HOUR), '{"id":"auto-9","at":17');
    const before = await snapshot();
    expect((await rig().service.autoRefreshOutlook(5)).autoRefresh).toBe("will");
    expect(await snapshot()).toEqual(before);
  });

  test("creates no file in a folder that has none", async () => {
    await rig().service.autoRefreshOutlook(5);
    expect(await readdir(dir)).toEqual([]);
  });

  test("does not use up the launch's one automatic refresh: asked twice, it says the same", async () => {
    const r = rig();
    const first = await r.service.autoRefreshOutlook(5);
    expect(await r.service.autoRefreshOutlook(5)).toEqual(first);
  });
});
