import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockFlashapi, type MockFlashapi } from "../../scripts/mockFlashapi";
import { MusicStatus, type EngineError } from "../../shared/engine";
import { captureConsole, expectNoKeyFragment, fragmentForms } from "../../testing/keyLeaks";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { nativeFetch, useNativeHttp } from "../../testing/nativeHttp";
import { type FlashapiFetch } from "./client";
import { musicLists } from "./fixtures";
import { QUOTA_LIMIT, QUOTA_WINDOW_MS, type QuotaLine } from "./quotaLedger";
import { MemoryListSink, MusicService, type FetchedList, type MusicListSink } from "./service";
import { runExclusive } from "../library/keyedMutex";
import { hangingBody } from "./testing/hangingBody";
import { PersistingTestSink } from "./testing/testSink";
useNativeGlobals();
useNativeHttp();

// The refresh: admission (key, rejected mark, quota), the durable send line BEFORE the request, one request, its
// result on the ledger, the list handed to the sink (3c.4's seam), and the status and events around it.

const KEY = "Zq7-vKt9-Wm2x-Lp4s-0000";
const ROTATED = "Hb5-nRw3-Yc8d-Qj6f-9999";
const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);
const HOUR = 3600 * 1000;

let dir = "";
let mock: MockFlashapi | null = null;
let now = NOW;
let idCounter = 0;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "studio-music-service-"));
  now = NOW;
  idCounter = 0;
});
afterEach(async () => {
  await mock?.stop();
  mock = null;
  await rm(dir, { recursive: true, force: true });
});

const quotaPath = () => join(dir, "music", "quota.jsonl");

async function quotaLines(): Promise<QuotaLine[]> {
  const text = await readFile(quotaPath(), "utf8").catch(() => "");
  return text.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as QuotaLine);
}

async function seedQuota(lines: readonly QuotaLine[]): Promise<void> {
  await mkdir(join(dir, "music"), { recursive: true });
  await writeFile(quotaPath(), lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
}

const sends = (n: number, end = NOW): QuotaLine[] => Array.from({ length: n }, (_, i) => ({ v: 1, kind: "send", id: `seed-${i}`, at: end - (n - i) * HOUR, key: "0000" }));

interface Harness {
  service: MusicService;
  events: MusicStatus[];
  logs: string[];
  rejectedCalls: string[];
  holder: { key: string | null; rejected: boolean };
  fetched: string[];
}

function harness(options: { log?: (line: string) => void; fetch?: FlashapiFetch; sink?: MusicListSink; quota?: string | null; key?: string | null; baseUrl?: string; timeoutMs?: number; mockOptions?: Parameters<typeof startMockFlashapi>[0] } = {}): Harness {
  mock ??= startMockFlashapi(options.mockOptions ?? { key: KEY });
  const events: MusicStatus[] = [];
  const logs: string[] = [];
  const rejectedCalls: string[] = [];
  const fetched: string[] = [];
  const holder = { key: options.key === undefined ? KEY : options.key, rejected: false };
  const service = new MusicService({
    quotaPath: options.quota === undefined ? quotaPath() : options.quota,
    baseUrl: options.baseUrl ?? mock.url,
    allowBaseUrlOverride: true,
    fetch:
      options.fetch ??
      ((url, init) => {
        fetched.push(url);
        return nativeFetch(url, init);
      }),
    clock: () => now,
    newId: () => `refresh-${String(++idCounter).padStart(4, "0")}`,
    key: () => holder.key,
    keyRejected: () => holder.rejected,
    markKeyRejected: (key) => void rejectedCalls.push(key),
    emit: (status) => void events.push(status),
    log: (line) => (logs.push(line), options.log?.(line)),
    sink: options.sink ?? new PersistingTestSink(),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return { service, events, logs, rejectedCalls, holder, fetched };
}

function refused(answer: Awaited<ReturnType<MusicService["refresh"]>>): EngineError {
  if (answer.ok) throw new Error("expected a refusal");
  return answer.error;
}

describe("status", () => {
  test("of a service that never refreshed: nothing yet, an idle refresh, the limit", async () => {
    const { service } = harness();
    expect(await service.status()).toEqual({ listFetchedAt: null, trackCount: 0, bytesOnDisk: 0, sentLast31d: 0, limit: 30, serverRemaining: null, nextFreeAt: null, refresh: { state: "idle" } });
  });

  test("reads the count from the ledger: 7 sends, the oldest one's leaving as nextFreeAt", async () => {
    await seedQuota(sends(7));
    const status = await harness().service.status();
    expect(status.sentLast31d).toBe(7);
    expect(status.nextFreeAt).toBe(new Date(NOW - 7 * HOUR + QUOTA_WINDOW_MS).toISOString());
  });

  test("clamps sentLast31d at the limit however many sends the log holds", async () => {
    await seedQuota(sends(34));
    expect((await harness().service.status()).sentLast31d).toBe(30);
  });

  test("without a quota file path it is the never-refreshed status, not an error", async () => {
    expect((await harness({ quota: null }).service.status()).sentLast31d).toBe(0);
  });

  test("with a corrupt log it fails closed: the count reads as the limit, so the card cannot show room that is not there", async () => {
    await mkdir(join(dir, "music"), { recursive: true });
    await writeFile(quotaPath(), "not json\n{}\n");
    const status = await harness().service.status();
    expect(status.sentLast31d).toBe(QUOTA_LIMIT);
    expect(status.nextFreeAt).toBeNull();
  });
});

describe("a refresh that goes through", () => {
  test("answers at once with the status running, then ends idle with the list, the count and the server's figure", async () => {
    const h = harness();
    const answer = await h.service.refresh();
    expect(answer).toMatchObject({ ok: true, status: { refresh: { state: "running", done: 0, total: 1 }, sentLast31d: 1 } });
    await h.service.settled();
    const final = await h.service.status();
    expect(final).toMatchObject({ trackCount: 30, listFetchedAt: new Date(NOW).toISOString(), sentLast31d: 1, serverRemaining: 28, refresh: { state: "idle" } });
    expect(h.events.at(-1)).toEqual(final);
  });

  test("every status it emits is a valid MusicStatus, and the first is the running one", async () => {
    const h = harness();
    await h.service.refresh();
    await h.service.settled();
    for (const event of h.events) expect(MusicStatus.safeParse(event).success).toBe(true);
    expect(h.events[0]?.refresh.state).toBe("running");
    expect(h.events.at(-1)?.refresh.state).toBe("idle");
  });

  test("writes the ledger's send and then its ok result with the server's figures, and only the key's last four chars", async () => {
    const h = harness();
    await h.service.refresh();
    await h.service.settled();
    const lines = await quotaLines();
    expect(lines.map((l) => l.kind)).toEqual(["send", "result"]);
    expect(lines[0]).toMatchObject({ kind: "send", id: "refresh-0001", key: "0000", at: NOW });
    expect(lines[1]).toMatchObject({ kind: "result", id: "refresh-0001", key: "0000", outcome: "ok", status: 200, remaining: 28, limit: 30 });
  });

  test("hands the parsed list to the sink, and the sink's progress becomes the status's progress", async () => {
    const accepted: FetchedList[] = [];
    const sink: MusicListSink = {
      persistent: true,
      accept: async (list, progress) => {
        accepted.push(list);
        progress(1, 61);
        progress(31, 61);
      },
      summary: () => ({ listFetchedAt: NOW, trackCount: accepted[0]?.tracks.length ?? 0, bytesOnDisk: 1234 }),
    };
    const h = harness({ sink });
    await h.service.refresh();
    await h.service.settled();
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.tracks).toHaveLength(30);
    expect(accepted[0]?.fetchedAt).toBe(NOW);
    const running = h.events.filter((e) => e.refresh.state === "running").map((e) => (e.refresh.state === "running" ? [e.refresh.done, e.refresh.total] : []));
    expect(running).toContainEqual([1, 61]);
    expect(running).toContainEqual([31, 61]);
    expect(h.events.at(-1)).toMatchObject({ bytesOnDisk: 1234, trackCount: 30, refresh: { state: "idle" } });
  });

  test("a sink that reports progress past its total or a zero total still yields valid statuses", async () => {
    const sink: MusicListSink = {
      persistent: true,
      accept: async (_list, progress) => {
        progress(5, 3);
        progress(0, 0);
      },
      summary: () => ({ listFetchedAt: NOW, trackCount: 30, bytesOnDisk: 0 }),
    };
    const h = harness({ sink });
    await h.service.refresh();
    await h.service.settled();
    for (const event of h.events) expect(MusicStatus.safeParse(event).success).toBe(true);
  });

  test("the default sink keeps the list in memory only: nothing but the quota log is written to disk", async () => {
    const h = harness();
    await h.service.refresh();
    await h.service.settled();
    expect(await readdir(join(dir, "music"))).toEqual(["quota.jsonl"]);
  });

  test("a second refresh after the first has ended goes through", async () => {
    const h = harness();
    await h.service.refresh();
    await h.service.settled();
    now += HOUR;
    expect((await h.service.refresh()).ok).toBe(true);
    await h.service.settled();
    expect((await quotaLines()).filter((l) => l.kind === "send")).toHaveLength(2);
    expect(mock?.requests).toHaveLength(2);
  });
});

describe("the send line is on disk before the request leaves", () => {
  test("when the request arrives the ledger already holds its send, and no result yet", async () => {
    let seenAtRequest: QuotaLine[] | null = null;
    const h = harness({
      fetch: async (url, init) => {
        seenAtRequest = await quotaLines();
        return nativeFetch(url, init);
      },
    });
    await h.service.refresh();
    await h.service.settled();
    expect(seenAtRequest).not.toBeNull();
    expect((seenAtRequest as unknown as QuotaLine[]).map((l) => l.kind)).toEqual(["send"]);
  });

  test("a crash after the send, before any answer: a new service over the same file counts the request", async () => {
    // Never answers, but gives up when it is aborted, as a real fetch does.
    const never: FlashapiFetch = (_url, init) =>
      new Promise<Response>((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    const first = harness({ fetch: never, timeoutMs: 60_000 });
    await first.service.refresh();
    await Bun.sleep(30);
    expect((await quotaLines()).map((l) => l.kind)).toEqual(["send"]);
    // The process "dies" here: a fresh service reads the same file.
    const second = harness();
    expect((await second.service.status()).sentLast31d).toBe(1);
    await first.service.stop();
  });

  test("a send that cannot be written stops the request: nothing leaves", async () => {
    await mkdir(join(dir, "music"), { recursive: true });
    await mkdir(`${quotaPath()}.torn`, { recursive: true });
    await writeFile(quotaPath(), '{"v":1,"kind":"send"');
    const h = harness();
    const error = refused(await h.service.refresh());
    expect(error.code).toBe("MUSIC_UNAVAILABLE");
    expect(mock?.requests).toEqual([]);
    expect((await h.service.status()).refresh).toEqual({ state: "idle" });
  });
});

describe("refusals cost nothing: no request, no ledger line", () => {
  test("no key: MUSIC_KEY_MISSING", async () => {
    const h = harness({ key: null });
    expect(refused(await h.service.refresh()).code).toBe("MUSIC_KEY_MISSING");
    expect(mock?.requests).toEqual([]);
    expect(await quotaLines()).toEqual([]);
  });

  test("a key the engine already marked rejected: MUSIC_KEY_REJECTED", async () => {
    const h = harness();
    h.holder.rejected = true;
    expect(refused(await h.service.refresh()).code).toBe("MUSIC_KEY_REJECTED");
    expect(mock?.requests).toEqual([]);
  });

  test("a key the ledger says was rejected (a restart forgot the engine's flag): MUSIC_KEY_REJECTED, nothing spent", async () => {
    await seedQuota([{ v: 1, kind: "send", id: "seed-1", at: NOW - 2 * HOUR, key: "0000" }, { v: 1, kind: "result", id: "seed-1", at: NOW - 2 * HOUR, key: "0000", outcome: "rejected", status: 401 }]);
    const h = harness();
    expect(refused(await h.service.refresh()).code).toBe("MUSIC_KEY_REJECTED");
    expect(mock?.requests).toEqual([]);
    expect((await quotaLines()).filter((l) => l.kind === "send")).toHaveLength(1);
  });

  test("a rejection recorded for another key's last four chars does not stop this key", async () => {
    await seedQuota([{ v: 1, kind: "result", id: "seed-1", at: NOW - 2 * HOUR, key: "1111", outcome: "rejected", status: 401 }]);
    const h = harness();
    expect((await h.service.refresh()).ok).toBe(true);
    await h.service.settled();
  });

  test("a key stored again after the rejection is tried", async () => {
    await seedQuota([{ v: 1, kind: "result", id: "seed-1", at: NOW - 2 * HOUR, key: "0000", outcome: "rejected", status: 401 }]);
    const h = harness();
    await h.service.noteKeyChange("0000");
    expect((await h.service.refresh()).ok).toBe(true);
    await h.service.settled();
  });

  test("30 sends in the window: MUSIC_QUOTA_EXHAUSTED naming when the next may leave", async () => {
    await seedQuota(sends(30));
    const h = harness();
    const error = refused(await h.service.refresh());
    expect(error.code).toBe("MUSIC_QUOTA_EXHAUSTED");
    expect(error.detail).toContain(new Date(NOW - 30 * HOUR + QUOTA_WINDOW_MS).toISOString());
    expect(mock?.requests).toEqual([]);
    expect(await quotaLines()).toHaveLength(30);
  });

  test("29 sends: it goes through and takes the 30th; the next is refused", async () => {
    await seedQuota(sends(29));
    const h = harness();
    expect((await h.service.refresh()).ok).toBe(true);
    await h.service.settled();
    expect(refused(await h.service.refresh()).code).toBe("MUSIC_QUOTA_EXHAUSTED");
    expect(mock?.requests).toHaveLength(1);
  });

  test("the server's last answer said 0 remained: MUSIC_QUOTA_EXHAUSTED although the local count is low", async () => {
    await seedQuota([{ v: 1, kind: "result", id: "seed-1", at: NOW - HOUR, key: "0000", outcome: "ok", remaining: 0, limit: 30 }]);
    const h = harness();
    expect(refused(await h.service.refresh()).code).toBe("MUSIC_QUOTA_EXHAUSTED");
    expect(mock?.requests).toEqual([]);
  });

  test("a refresh whose answer says remaining 0 succeeds, and the next one is refused", async () => {
    const h = harness({ mockOptions: { key: KEY, remaining: 0 } });
    expect((await h.service.refresh()).ok).toBe(true);
    await h.service.settled();
    expect((await h.service.status()).serverRemaining).toBe(0);
    expect(refused(await h.service.refresh()).code).toBe("MUSIC_QUOTA_EXHAUSTED");
  });

  test("a quota file that cannot be read or trusted: MUSIC_UNAVAILABLE, nothing sent", async () => {
    await mkdir(join(dir, "music"), { recursive: true });
    await writeFile(quotaPath(), "garbage\n");
    const h = harness();
    expect(refused(await h.service.refresh()).code).toBe("MUSIC_UNAVAILABLE");
    expect(mock?.requests).toEqual([]);
  });

  test("no quota path (the music folder was not given): MUSIC_UNAVAILABLE", async () => {
    const h = harness({ quota: null });
    expect(refused(await h.service.refresh()).code).toBe("MUSIC_UNAVAILABLE");
    expect(mock?.requests).toEqual([]);
  });

  test("a base URL the client refuses is refused BEFORE the send is written, so it spends nothing", async () => {
    const h = harness({ baseUrl: "https://evil.example" });
    expect(refused(await h.service.refresh()).code).toBe("MUSIC_UNAVAILABLE");
    expect(await quotaLines()).toEqual([]);
  });
});

describe("one refresh at a time", () => {
  test("a second refresh while the first runs is IN_FLIGHT and writes nothing", async () => {
    mock = startMockFlashapi({ key: KEY });
    mock.script({ delayMs: 200 });
    const h = harness();
    expect((await h.service.refresh()).ok).toBe(true);
    expect(refused(await h.service.refresh()).code).toBe("IN_FLIGHT");
    await h.service.settled();
    expect((await quotaLines()).filter((l) => l.kind === "send")).toHaveLength(1);
    expect(mock.requests).toHaveLength(1);
  });

  test("two refreshes asked at the same instant: exactly one goes through", async () => {
    const h = harness();
    const answers = await Promise.all([h.service.refresh(), h.service.refresh()]);
    await h.service.settled();
    expect(answers.filter((a) => a.ok)).toHaveLength(1);
    expect(mock?.requests).toHaveLength(1);
  });

  test("a refused attempt does not leave the service busy", async () => {
    const h = harness({ key: null });
    await h.service.refresh();
    h.holder.key = KEY;
    expect((await h.service.refresh()).ok).toBe(true);
    await h.service.settled();
  });
});

describe("a request that fails", () => {
  test("a 401 ends failed with MUSIC_KEY_REJECTED, records the rejection, tells the engine which key it was, and blocks the next refresh", async () => {
    mock = startMockFlashapi({ key: ROTATED });
    const h = harness();
    await h.service.refresh();
    await h.service.settled();
    const status = await h.service.status();
    expect(status.refresh).toMatchObject({ state: "failed", error: { code: "MUSIC_KEY_REJECTED" } });
    expect(h.rejectedCalls).toEqual([KEY]);
    expect((await quotaLines()).at(-1)).toMatchObject({ kind: "result", outcome: "rejected", status: 401, key: "0000" });
    expect(refused(await h.service.refresh()).code).toBe("MUSIC_KEY_REJECTED");
    expect(mock.requests).toHaveLength(1);
  });

  test("a rejection survives a restart: a new service over the same file refuses without spending", async () => {
    mock = startMockFlashapi({ key: ROTATED });
    const first = harness();
    await first.service.refresh();
    await first.service.settled();
    const second = harness();
    expect(await second.service.keyRejected("0000")).toBe(true);
    expect(refused(await second.service.refresh()).code).toBe("MUSIC_KEY_REJECTED");
    expect(mock.requests).toHaveLength(1);
  });

  test("the key that is marked rejected is the one the request carried, even if the key was replaced while it was in flight", async () => {
    mock = startMockFlashapi({ key: ROTATED });
    mock.script({ delayMs: 80, status: 401, body: {} });
    const h = harness();
    await h.service.refresh();
    h.holder.key = ROTATED;
    await h.service.settled();
    expect(h.rejectedCalls).toEqual([KEY]);
  });

  test.each([
    ["a 500", { status: 500, body: "boom" }, "MUSIC_UNAVAILABLE", "http-error"],
    ["a 403", { status: 403, body: "no subscription" }, "MUSIC_UNAVAILABLE", "http-error"],
    ["a 429", { status: 429, body: "slow" }, "MUSIC_UNAVAILABLE", "http-error"],
    ["not JSON", { status: 200, body: "<html>" }, "MUSIC_UNAVAILABLE", "invalid"],
    ["a body over the cap", { oversize: { bytes: 2 * 1024 * 1024 + 10, contentLength: true } }, "MUSIC_UNAVAILABLE", "too-large"],
  ] as const)("%s ends failed with %s, is counted and recorded as %s, and is not retried", async (_label, step, code, outcome) => {
    mock = startMockFlashapi({ key: KEY });
    mock.script(step);
    const h = harness();
    await h.service.refresh();
    await h.service.settled();
    const status = await h.service.status();
    expect(status.refresh).toMatchObject({ state: "failed", error: { code } });
    expect(status.sentLast31d).toBe(1);
    expect((await quotaLines()).at(-1)).toMatchObject({ kind: "result", outcome });
    expect(mock.requests).toHaveLength(1);
    expect(h.rejectedCalls).toEqual([]);
  });

  test("a network failure ends failed and counted, and the failure text has no key", async () => {
    const h = harness({ fetch: () => Promise.reject(new TypeError(`connect failed for ${KEY}`)) });
    const output = captureConsole();
    try {
      await h.service.refresh();
      await h.service.settled();
      const status = await h.service.status();
      expect(status.refresh).toMatchObject({ state: "failed", error: { code: "MUSIC_UNAVAILABLE" } });
      expectNoKeyFragment(JSON.stringify(h.events), KEY);
      expectNoKeyFragment(h.logs.join("\n"), KEY);
      expectNoKeyFragment(output.text(), KEY);
      expect((await quotaLines()).at(-1)).toMatchObject({ outcome: "network-error" });
    } finally {
      output.restore();
    }
  });

  test("a timeout ends failed and counted", async () => {
    mock = startMockFlashapi({ key: KEY });
    mock.script({ delayMs: 400 });
    const h = harness({ timeoutMs: 50 });
    await h.service.refresh();
    await h.service.settled();
    expect((await quotaLines()).at(-1)).toMatchObject({ outcome: "timeout" });
    expect((await h.service.status()).refresh).toMatchObject({ state: "failed" });
  });

  test("an empty list ends failed (MUSIC_UNAVAILABLE) and keeps the list already held", async () => {
    const h = harness();
    await h.service.refresh();
    await h.service.settled();
    const before = await h.service.status();
    mock?.script({ status: 200, body: { status: "ok", items: [] }, headers: { "x-ratelimit-requests-remaining": "20" } });
    now += HOUR;
    await h.service.refresh();
    await h.service.settled();
    const after = await h.service.status();
    expect(after.refresh).toMatchObject({ state: "failed", error: { code: "MUSIC_UNAVAILABLE" } });
    expect(after.trackCount).toBe(before.trackCount);
    expect(after.listFetchedAt).toBe(before.listFetchedAt);
    expect(after.serverRemaining).toBe(20);
    expect(after.sentLast31d).toBe(2);
  });

  test("a sink that throws ends failed and keeps the request counted", async () => {
    const sink: MusicListSink = { persistent: true, accept: () => Promise.reject(new Error(`disk full near ${KEY}`)), summary: () => ({ listFetchedAt: null, trackCount: 0, bytesOnDisk: 0 }) };
    const h = harness({ sink });
    await h.service.refresh();
    await h.service.settled();
    const status = await h.service.status();
    expect(status.refresh).toMatchObject({ state: "failed", error: { code: "MUSIC_UNAVAILABLE" } });
    expect(status.sentLast31d).toBe(1);
    expectNoKeyFragment(JSON.stringify(h.events), KEY);
  });

  test("the next refresh starts clean: running again, then idle", async () => {
    mock = startMockFlashapi({ key: KEY });
    mock.script({ status: 500, body: "boom" });
    const h = harness();
    await h.service.refresh();
    await h.service.settled();
    now += HOUR;
    const second = await h.service.refresh();
    expect(second).toMatchObject({ ok: true, status: { refresh: { state: "running" } } });
    await h.service.settled();
    expect((await h.service.status()).refresh).toEqual({ state: "idle" });
  });

  test("stop aborts a request in flight and the service ends failed without leaving a hung refresh", async () => {
    mock = startMockFlashapi({ key: KEY });
    mock.script({ delayMs: 2000 });
    const h = harness();
    await h.service.refresh();
    await Bun.sleep(20);
    const started = performance.now();
    await h.service.stop();
    expect(performance.now() - started).toBeLessThan(1500);
    expect((await h.service.status()).refresh.state).toBe("failed");
  });
});

describe("the server's remaining = 0 on an ERROR answer is the floor (the real exhaustion path is a 429)", () => {
  const zero = { "x-ratelimit-requests-remaining": "0" };

  test.each([
    ["429", { status: 429, body: "quota exceeded", headers: zero }, "http-error", "MUSIC_QUOTA_EXHAUSTED"],
    ["500", { status: 500, body: "boom", headers: zero }, "http-error", "MUSIC_QUOTA_EXHAUSTED"],
    ["403", { status: 403, body: "no subscription", headers: zero }, "http-error", "MUSIC_QUOTA_EXHAUSTED"],
  ] as const)("a %s that carries remaining 0 is recorded with it, and the next refresh is refused as exhausted with one request in all", async (_label, step, outcome, code) => {
    mock = startMockFlashapi({ key: KEY });
    mock.script(step);
    const h = harness();
    await h.service.refresh();
    await h.service.settled();
    expect((await quotaLines()).at(-1)).toMatchObject({ kind: "result", outcome, remaining: 0 });
    expect((await h.service.status()).serverRemaining).toBe(0);
    now += HOUR;
    expect(refused(await h.service.refresh()).code).toBe(code);
    expect(mock.requests).toHaveLength(1);
  });

  test("a 401 that carries remaining 0 records it too, and the next refresh is refused with one request in all", async () => {
    mock = startMockFlashapi({ key: ROTATED });
    mock.script({ status: 401, body: { message: "Invalid API key" }, headers: zero });
    const h = harness();
    await h.service.refresh();
    await h.service.settled();
    expect((await quotaLines()).at(-1)).toMatchObject({ kind: "result", outcome: "rejected", status: 401, remaining: 0 });
    // Both refusals apply (the key is rejected AND the server says 0); the key's is the one that can be acted on.
    expect(["MUSIC_KEY_REJECTED", "MUSIC_QUOTA_EXHAUSTED"]).toContain(refused(await h.service.refresh()).code);
    expect(mock.requests).toHaveLength(1);
    // A key stored again is still held back by the floor.
    await h.service.noteKeyChange("0000");
    expect(refused(await h.service.refresh()).code).toBe("MUSIC_QUOTA_EXHAUSTED");
    expect(mock.requests).toHaveLength(1);
  });

  test("a server that reports a NEGATIVE remaining is exhausted too", async () => {
    mock = startMockFlashapi({ key: KEY });
    mock.script({ status: 429, body: "x", headers: { "x-ratelimit-requests-remaining": "-3" } });
    const h = harness();
    await h.service.refresh();
    await h.service.settled();
    expect((await quotaLines()).at(-1)).toMatchObject({ remaining: 0 });
    expect(refused(await h.service.refresh()).code).toBe("MUSIC_QUOTA_EXHAUSTED");
  });
});

describe("a result that could not be written", () => {
  /** A fetch that, when the request arrives, puts a FOLDER where the quota file is, so the result line cannot be appended. */
  const breakingTheLog: FlashapiFetch = async (url, init) => {
    await rm(quotaPath(), { force: true });
    await mkdir(quotaPath());
    return nativeFetch(url, init);
  };

  const zero = { "x-ratelimit-requests-remaining": "0" };
  /** Breaks the log for the FIRST request only; a later one is served plainly. */
  const breakingOnce = (): FlashapiFetch => {
    let first = true;
    return (url, init) => {
      if (!first) return nativeFetch(url, init);
      first = false;
      return breakingTheLog(url, init);
    };
  };

  test("is held as the line itself: while the log stays broken the next refresh is MUSIC_UNAVAILABLE and sends nothing", async () => {
    mock = startMockFlashapi({ key: KEY });
    mock.script({ status: 429, body: "quota exceeded", headers: zero });
    const h = harness({ fetch: breakingTheLog });
    await h.service.refresh();
    await h.service.settled();
    const error = refused(await h.service.refresh());
    expect(error.code).toBe("MUSIC_UNAVAILABLE");
    expect(error.detail).toContain("could not be written");
    expect(mock.requests).toHaveLength(1);
    expect(h.logs.join("\n")).not.toContain("(unknown)");
  });

  test("is written FIRST when the log works again, so the server's 0 still refuses the next refresh (the floor is not lost)", async () => {
    mock = startMockFlashapi({ key: KEY });
    mock.script({ status: 429, body: "quota exceeded", headers: zero });
    const h = harness({ fetch: breakingTheLog });
    await h.service.refresh();
    await h.service.settled();
    await rm(quotaPath(), { recursive: true, force: true });
    expect(refused(await h.service.refresh()).code).toBe("MUSIC_QUOTA_EXHAUSTED");
    expect(mock.requests).toHaveLength(1);
    expect((await quotaLines()).map((l) => l.kind)).toEqual(["result"]);
    expect((await quotaLines())[0]).toMatchObject({ outcome: "http-error", status: 429, remaining: 0 });
  });

  test("keeps its own time: the line is written with the moment the answer came, not the moment the log recovered", async () => {
    mock = startMockFlashapi({ key: KEY });
    mock.script({ status: 429, body: "x", headers: zero });
    const h = harness({ fetch: breakingTheLog });
    await h.service.refresh();
    await h.service.settled();
    await rm(quotaPath(), { recursive: true, force: true });
    now += 5 * HOUR;
    await h.service.refresh();
    expect((await quotaLines())[0]).toMatchObject({ kind: "result", at: NOW });
  });

  test("a re-entered key does not lose it: the unwritten 429 goes to the log BEFORE the key line, and the next refresh is still refused", async () => {
    mock = startMockFlashapi({ key: KEY });
    mock.script({ status: 429, body: "quota exceeded", headers: zero });
    const h = harness({ fetch: breakingTheLog });
    await h.service.refresh();
    await h.service.settled();
    await rm(quotaPath(), { recursive: true, force: true });
    await h.service.noteKeyChange("0000");
    expect((await quotaLines()).map((l) => l.kind)).toEqual(["result", "key"]);
    expect(refused(await h.service.refresh()).code).toBe("MUSIC_QUOTA_EXHAUSTED");
    expect(mock.requests).toHaveLength(1);
  });

  test("a 401 that could not be written survives a re-entered key the same way: the key line lands after it and clears it", async () => {
    mock = startMockFlashapi({ key: ROTATED });
    const h = harness({ fetch: breakingTheLog });
    await h.service.refresh();
    await h.service.settled();
    await rm(quotaPath(), { recursive: true, force: true });
    await h.service.noteKeyChange("0000");
    // The owner stored a key: the 401 is older than that, so the new key is not held rejected by it.
    expect((await quotaLines()).map((l) => l.kind)).toEqual(["result", "key"]);
    expect(await h.service.keyRejected("0000")).toBe(false);
  });

  test("a key change made while the log is broken is queued behind it, and the refresh waits for both", async () => {
    mock = startMockFlashapi({ key: KEY });
    mock.script({ status: 500, body: "x" });
    const h = harness({ fetch: breakingOnce() });
    await h.service.refresh();
    await h.service.settled();
    await h.service.noteKeyChange("0000");
    expect(refused(await h.service.refresh()).code).toBe("MUSIC_UNAVAILABLE");
    await rm(quotaPath(), { recursive: true, force: true });
    expect((await h.service.refresh()).ok).toBe(true);
    await h.service.settled();
    expect((await quotaLines()).map((l) => l.kind)).toEqual(["result", "key", "send", "result"]);
  });

  test("clears once the line is written: a refresh that had no zero and no 401 to keep goes through", async () => {
    mock = startMockFlashapi({ key: KEY });
    mock.script({ status: 500, body: "x" });
    const h = harness({ fetch: breakingOnce() });
    await h.service.refresh();
    await h.service.settled();
    await rm(quotaPath(), { recursive: true, force: true });
    now += HOUR;
    expect((await h.service.refresh()).ok).toBe(true);
    await h.service.settled();
    expect((await quotaLines()).map((l) => l.kind)).toEqual(["result", "send", "result"]);
  });

  test("names the kind of error in the log, not `unknown`, and never the key", async () => {
    const output = captureConsole();
    try {
      mock = startMockFlashapi({ key: KEY });
      const h = harness({ fetch: breakingTheLog });
      await h.service.refresh();
      await h.service.settled();
      expectNoKeyFragment(output.text() + h.logs.join("\n"), KEY);
      expect(h.logs.join("\n")).toMatch(/quota log \((unwritable|[A-Z]+)\)/);
    } finally {
      output.restore();
    }
  });
});

describe("a refresh never sticks busy", () => {
  test("a sink whose summary throws does not leave the service running or the refresh unanswered", async () => {
    let broken = true;
    const sink: MusicListSink = {
      persistent: true,
      accept: () => Promise.resolve(),
      summary: () => {
        if (broken) throw new Error("summary is broken");
        return { listFetchedAt: null, trackCount: 0, bytesOnDisk: 0 };
      },
    };
    const h = harness({ sink });
    const answer = await h.service.refresh();
    expect(answer.ok).toBe(true);
    await h.service.settled();
    broken = false;
    now += HOUR;
    expect((await h.service.refresh()).ok).toBe(true);
    await h.service.settled();
    expect((await quotaLines()).filter((l) => l.kind === "send")).toHaveLength(2);
  });

  test("the request goes FIRST, then the status: a status() that throws after the send does not stop the request or the answer", async () => {
    const h = harness();
    const broken = spyOn(h.service, "status").mockImplementation(() => Promise.reject(new Error("status is broken")));
    const answer = await h.service.refresh();
    broken.mockRestore();
    expect(answer).toMatchObject({ ok: true, status: { refresh: { state: "running", done: 0, total: 1 } } });
    await h.service.settled();
    expect(mock?.requests).toHaveLength(1);
    expect((await h.service.status()).refresh).toEqual({ state: "idle" });
    now += HOUR;
    expect((await h.service.refresh()).ok).toBe(true);
    await h.service.settled();
  });

  test("a status that cannot be built after the send still ends the refresh: nothing is stuck running", async () => {
    let calls = 0;
    const sink: MusicListSink = {
      persistent: true,
      accept: () => Promise.resolve(),
      summary: () => {
        if (++calls === 1) throw new Error("only the first summary fails");
        return { listFetchedAt: null, trackCount: 0, bytesOnDisk: 0 };
      },
    };
    const h = harness({ sink });
    await h.service.refresh();
    await h.service.settled();
    expect((await h.service.status()).refresh.state).not.toBe("running");
  });
});

describe("a service that is shutting down", () => {
  test("stop() closes it: a refresh after it is refused before anything is written or sent", async () => {
    const h = harness();
    await h.service.stop();
    const error = refused(await h.service.refresh());
    expect(error.code).toBe("MUSIC_UNAVAILABLE");
    expect(error.detail).toContain("shutting down");
    expect(mock?.requests).toEqual([]);
    expect(await quotaLines()).toEqual([]);
  });

  test("stop() while a request is in flight aborts it, and a refresh asked right after is refused too", async () => {
    mock = startMockFlashapi({ key: KEY });
    mock.script({ delayMs: 500 });
    const h = harness();
    await h.service.refresh();
    const stopping = h.service.stop();
    expect(refused(await h.service.refresh()).code).toBe("MUSIC_UNAVAILABLE");
    await stopping;
    expect(mock.requests.length).toBeLessThanOrEqual(1);
    expect((await quotaLines()).filter((l) => l.kind === "send")).toHaveLength(1);
  });
});

describe("stop() racing a refresh that is already inside admission", () => {
  /** Holds the quota file's lock, so a refresh that has passed its first checks waits inside the ledger. */
  async function holdLedger(): Promise<() => void> {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    void runExclusive(`quota:${quotaPath()}`, () => gate);
    await Bun.sleep(5);
    return release;
  }

  test("no request leaves after stop() has resolved, and stop() waits for that refresh to give up", async () => {
    const h = harness();
    const release = await holdLedger();
    let refreshDone = false;
    const refreshing = h.service.refresh().then((answer) => {
      refreshDone = true;
      return answer;
    });
    await Bun.sleep(10);
    let stopped = false;
    const stopping = h.service.stop().then(() => {
      stopped = true;
    });
    await Bun.sleep(10);
    expect(stopped).toBe(false);
    release();
    await Promise.all([refreshing, stopping]);
    expect(refreshDone).toBe(true);
    expect(refused(await refreshing).code).toBe("MUSIC_UNAVAILABLE");
    await Bun.sleep(50);
    expect(mock?.requests).toEqual([]);
    // The send may already be on disk (conservative: it stays counted); a result or a request never is.
    expect((await quotaLines()).filter((l) => l.kind === "result")).toEqual([]);
  });

  test("a refresh that was admitted before stop() is aborted by it, and stop() ends", async () => {
    mock = startMockFlashapi({ key: KEY });
    mock.script({ delayMs: 2000 });
    const h = harness();
    await h.service.refresh();
    await Bun.sleep(20);
    const started = performance.now();
    await h.service.stop();
    expect(performance.now() - started).toBeLessThan(1500);
    expect((await h.service.status()).refresh.state).toBe("failed");
  });
});

describe("a body that hangs still leaves the floor", () => {
  const zero = { "x-ratelimit-requests-remaining": "0", "x-ratelimit-requests-limit": "30" };

  test.each([
    ["a 200", 200, "timeout"],
    ["a 429", 429, "http-error"],
  ] as const)("%s with remaining 0 and a body that never arrives: the result line carries 0 (outcome %s from the status), and the next refresh is refused with one request in all", async (_label, status, outcome) => {
    let calls = 0;
    const hanging = hangingBody(status, zero);
    const h = harness({ fetch: (url, init) => (calls++, hanging(url, init)), timeoutMs: 80 });
    await h.service.refresh();
    await h.service.settled();
    expect((await quotaLines()).at(-1)).toMatchObject({ kind: "result", outcome, status, remaining: 0, limit: 30 });
    expect((await h.service.status()).serverRemaining).toBe(0);
    now += HOUR;
    expect(refused(await h.service.refresh()).code).toBe("MUSIC_QUOTA_EXHAUSTED");
    expect(calls).toBe(1);
  });

  test("the same when stop() aborts the read", async () => {
    const h = harness({ fetch: hangingBody(200, zero), timeoutMs: 5000 });
    await h.service.refresh();
    await Bun.sleep(20);
    await h.service.stop();
    expect((await quotaLines()).at(-1)).toMatchObject({ kind: "result", outcome: "network-error", remaining: 0 });
  });
});

describe("a 401 or a 429 whose body hangs is classified from its status", () => {
  test("a 401: MUSIC_KEY_REJECTED, the key marked rejected, the result line `rejected`", async () => {
    const h = harness({ fetch: hangingBody(401, {}), timeoutMs: 80 });
    await h.service.refresh();
    await h.service.settled();
    expect((await h.service.status()).refresh).toMatchObject({ state: "failed", error: { code: "MUSIC_KEY_REJECTED" } });
    expect(h.rejectedCalls).toEqual([KEY]);
    expect((await quotaLines()).at(-1)).toMatchObject({ kind: "result", outcome: "rejected", status: 401 });
  });

  test("a 429 with a Retry-After: MUSIC_UNAVAILABLE carrying retryAfterMs, the floor kept", async () => {
    const h = harness({ fetch: hangingBody(429, { "retry-after": "9", "x-ratelimit-requests-remaining": "0" }), timeoutMs: 80 });
    await h.service.refresh();
    await h.service.settled();
    expect((await h.service.status()).refresh).toMatchObject({ state: "failed", error: { code: "MUSIC_UNAVAILABLE", retryAfterMs: 9000 } });
    expect((await quotaLines()).at(-1)).toMatchObject({ outcome: "http-error", status: 429, remaining: 0 });
  });
});

describe("a refusal because the ledger remembers a rejected key", () => {
  test("also tells the engine, so the settings show the key as rejected without another request", async () => {
    await seedQuota([
      { v: 1, kind: "send", id: "seed-1", at: NOW - 2 * HOUR, key: "0000" },
      { v: 1, kind: "result", id: "seed-1", at: NOW - 2 * HOUR, key: "0000", outcome: "rejected", status: 401 },
    ]);
    const h = harness();
    expect(refused(await h.service.refresh()).code).toBe("MUSIC_KEY_REJECTED");
    expect(h.rejectedCalls).toEqual([KEY]);
    expect(mock?.requests).toEqual([]);
  });
});

describe("a result that is not a FlashapiError", () => {
  test("still ends failed, with the key redacted from what is said", async () => {
    // A Response whose headers are fine to read a length from and blow up on enumeration, with the key in the message.
    const hostile = {
      status: 200,
      ok: true,
      body: null,
      headers: {
        get: () => null,
        forEach: () => {
          throw new Error(`the runtime broke while reading headers for ${KEY}`);
        },
      },
    } as unknown as Response;
    const h = harness({ fetch: () => Promise.resolve(hostile) });
    const output = captureConsole();
    try {
      await h.service.refresh();
      await h.service.settled();
      const status = await h.service.status();
      expect(status.refresh).toMatchObject({ state: "failed", error: { code: "MUSIC_UNAVAILABLE" } });
      expectNoKeyFragment(JSON.stringify(h.events) + h.logs.join("\n") + output.text(), KEY);
      expect((await quotaLines()).at(-1)).toMatchObject({ kind: "result", outcome: "network-error" });
    } finally {
      output.restore();
    }
  });
});

describe("a good answer that echoes the key", () => {
  test("in its status, its next_max_id and an unknown field NAME leaves nothing of the key in the log, the events or the files", async () => {
    mock = startMockFlashapi({ key: KEY });
    const list = JSON.parse(await Bun.file(musicLists.kyiv.file).text()) as { response: Record<string, unknown> };
    const body = { ...list.response, status: KEY, page_info: { next_max_id: KEY, more_available: true }, [KEY]: "echo" };
    mock.script({ status: 200, body, headers: { "x-ratelimit-requests-remaining": "9", "x-ratelimit-note": KEY } });
    const h = harness();
    const output = captureConsole();
    try {
      await h.service.refresh();
      await h.service.settled();
      const first = h.logs.filter((l) => l.includes("first flashapi refresh"));
      expect(first).toHaveLength(1);
      expectNoKeyFragment(h.logs.join("\n") + JSON.stringify(h.events) + output.text(), KEY);
      const files = (await readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile());
      for (const file of files) expectNoKeyFragment((await readFile(join(file.parentPath, file.name))).toString("utf8"), KEY);
    } finally {
      output.restore();
    }
  });
});

describe("the server's clock", () => {
  test("its Date header is written on the result line (validated), for clock-skew forensics", async () => {
    mock = startMockFlashapi({ key: KEY });
    mock.script({ status: 200, body: { status: "ok", items: [] }, headers: { date: "Wed, 30 Sep 2026 12:00:07 GMT" } });
    const h = harness();
    await h.service.refresh();
    await h.service.settled();
    expect((await quotaLines()).at(-1)).toMatchObject({ kind: "result", serverAt: Date.UTC(2026, 8, 30, 12, 0, 7) });
  });

  test("a junk Date header leaves the field out", async () => {
    mock = startMockFlashapi({ key: KEY });
    mock.script({ status: 200, body: { status: "ok", items: [] }, headers: { date: "someday" } });
    const h = harness();
    await h.service.refresh();
    await h.service.settled();
    expect(Object.keys((await quotaLines()).at(-1) ?? {})).not.toContain("serverAt");
  });
});

describe("until a sink that persists exists (3c.4)", () => {
  test("music.refresh is refused as not available yet: nothing is sent, and no request is spent into memory", async () => {
    const h = harness({ sink: new MemoryListSink() });
    const error = refused(await h.service.refresh());
    expect(error.code).toBe("MUSIC_UNAVAILABLE");
    expect(error.detail).toContain("not available yet");
    expect(mock?.requests).toEqual([]);
    expect(await quotaLines()).toEqual([]);
  });

  test("the in-memory sink says it does not persist, and a persisting one lets a refresh through", () => {
    expect(new MemoryListSink().persistent).toBe(false);
    expect(new PersistingTestSink().persistent).toBe(true);
  });

  test("the status still works with the in-memory sink", async () => {
    expect((await harness({ sink: new MemoryListSink() }).service.status()).refresh).toEqual({ state: "idle" });
  });
});

describe("the first real refresh log", () => {
  test("is written once, when no answer was ever good, and holds the counters, header names and no key", async () => {
    const h = harness();
    await h.service.refresh();
    await h.service.settled();
    const reports = h.logs.filter((l) => l.includes("first flashapi refresh"));
    expect(reports).toHaveLength(1);
    const line = reports[0] ?? "";
    expect(line).toContain("x-ratelimit-requests-remaining");
    expect(line).toContain("REVSHARE");
    expectNoKeyFragment(line, KEY);
    expect(line).not.toMatch(/oe=|oh=/);
    now += HOUR;
    await h.service.refresh();
    await h.service.settled();
    expect(h.logs.filter((l) => l.includes("first flashapi refresh"))).toHaveLength(1);
  });

  test("is written for a failed first attempt too, so a 403 or a changed body can be diagnosed", async () => {
    mock = startMockFlashapi({ key: KEY });
    mock.script({ status: 403, body: { message: "not subscribed" } });
    const h = harness();
    await h.service.refresh();
    await h.service.settled();
    expect(h.logs.some((l) => l.includes("first flashapi refresh") && l.includes("403"))).toBe(true);
  });
});

describe("what reaches the disk", () => {
  test("no file under the user data folder holds the key or a fragment of it, in any form", async () => {
    mock = startMockFlashapi({ key: ROTATED, echoKey: true });
    const h = harness();
    await h.service.refresh();
    await h.service.settled();
    await h.service.noteKeyChange("0000");
    const files = (await readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile());
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const bytes = await readFile(join(file.parentPath, file.name));
      expectNoKeyFragment(bytes.toString("utf8"), KEY);
      for (const form of fragmentForms(KEY)) expect(bytes.includes(form.bytes)).toBe(false);
    }
  });
});

describe("MemoryListSink", () => {
  test("holds the last list only and reports its count and time", async () => {
    const sink = new MemoryListSink();
    expect(sink.summary()).toEqual({ listFetchedAt: null, trackCount: 0, bytesOnDisk: 0 });
    await sink.accept({ fetchedAt: NOW, tracks: [] }, () => undefined, new AbortController().signal);
    expect(sink.summary()).toEqual({ listFetchedAt: NOW, trackCount: 0, bytesOnDisk: 0 });
  });
});

// The clock the ledger trusts is the local one, and a dead RTC battery reads 1970. A line the schema refuses (a time
// outside 2000..2100) used to sit held forever and block every refresh behind it.
describe("a system clock that is not a date between 2000 and 2100", () => {
  test.each([
    ["1970", 0],
    ["1999", Date.UTC(1999, 11, 31, 23, 59, 59)],
    ["2101", Date.UTC(2101, 0, 1)],
  ])("at %s a refresh is refused naming the clock, with no request and no ledger line", async (_label, at) => {
    now = at;
    const h = harness();
    const error = refused(await h.service.refresh());
    expect(error.code).toBe("MUSIC_UNAVAILABLE");
    expect(error.detail).toContain("system clock");
    expect(error.detail).toContain("nothing was sent");
    expect(mock?.requests).toHaveLength(0);
    expect(await quotaLines()).toEqual([]);
  });

  test("a clock that reads NaN is refused the same way", async () => {
    now = Number.NaN;
    const error = refused(await harness().service.refresh());
    expect(error.detail).toContain("system clock");
  });

  test("the status still answers with the clock out of range", async () => {
    await seedQuota(sends(3));
    now = 0;
    const status = await harness().service.status();
    expect(MusicStatus.safeParse(status).success).toBe(true);
  });

  test("the refresh is refused for the clock alone: once it is right the same service goes through", async () => {
    now = 0;
    const h = harness();
    expect(refused(await h.service.refresh()).detail).toContain("system clock");
    now = NOW;
    expect((await h.service.refresh()).ok).toBe(true);
    await h.service.settled();
    expect(mock?.requests).toHaveLength(1);
  });
});

describe("a line held while the clock is wrong", () => {
  const zero = { "x-ratelimit-requests-remaining": "0" };
  /** Serves the mock, but the clock has gone to 1970 by the time the answer is read. */
  const clockDiesDuringRequest: FlashapiFetch = (url, init) => {
    now = 0;
    return nativeFetch(url, init);
  };

  test("a result made at a wrong clock is held, and written after the clock recovers with a time between the send and now", async () => {
    mock = startMockFlashapi({ key: KEY });
    mock.script({ status: 429, body: "quota exceeded", headers: zero });
    const h = harness({ fetch: clockDiesDuringRequest });
    await h.service.refresh();
    await h.service.settled();
    expect((await quotaLines()).map((l) => l.kind)).toEqual(["send"]);
    now = NOW + 5 * HOUR;
    // The floor it carried still refuses, and the line is written first.
    expect(refused(await h.service.refresh()).code).toBe("MUSIC_QUOTA_EXHAUSTED");
    const lines = await quotaLines();
    expect(lines.map((l) => l.kind)).toEqual(["send", "result"]);
    const written = lines[1];
    expect(written?.at).toBeGreaterThanOrEqual(NOW);
    expect(written?.at).toBeLessThanOrEqual(NOW + 5 * HOUR);
    expect(mock.requests).toHaveLength(1);
  });

  test("names the clock in the log, not `unknown`, while it is held", async () => {
    mock = startMockFlashapi({ key: KEY });
    const h = harness({ fetch: clockDiesDuringRequest });
    await h.service.refresh();
    await h.service.settled();
    expect(h.logs.join("\n")).toContain("system clock");
    expect(h.logs.join("\n")).not.toContain("(unknown)");
  });

  test("a key change noted at a wrong clock is held, then written after the send it follows, with an `at` in range", async () => {
    const h = harness();
    now = 0;
    await h.service.noteKeyChange("0000");
    expect(await quotaLines()).toEqual([]);
    now = NOW;
    expect((await h.service.refresh()).ok).toBe(true);
    await h.service.settled();
    const lines = await quotaLines();
    expect(lines.map((l) => l.kind)).toEqual(["key", "send", "result"]);
    expect(lines[0]?.at).toBeGreaterThanOrEqual(946_684_800_000);
    expect(lines[0]?.at).toBeLessThanOrEqual(NOW);
  });

  test("a key change noted at a good clock keeps that time", async () => {
    const h = harness();
    now = NOW + HOUR;
    await h.service.noteKeyChange("0000");
    expect((await quotaLines())[0]).toMatchObject({ kind: "key", at: NOW + HOUR });
  });

  test("a clock stepped BACK after the send (still a real date) writes the result no later than now", async () => {
    mock = startMockFlashapi({ key: KEY });
    const h = harness({
      fetch: (url, init) => {
        now = NOW - 3 * HOUR;
        return nativeFetch(url, init);
      },
    });
    await h.service.refresh();
    await h.service.settled();
    const lines = await quotaLines();
    expect(lines.map((l) => l.kind)).toEqual(["send", "result"]);
    expect(lines[1]?.at).toBeLessThanOrEqual(now);
  });

  test("the status counts a held floor: it does not show room the refresh will refuse", async () => {
    mock = startMockFlashapi({ key: KEY });
    mock.script({ status: 429, body: "x", headers: zero });
    const h = harness({ fetch: clockDiesDuringRequest });
    await h.service.refresh();
    await h.service.settled();
    now = NOW + HOUR;
    const status = await h.service.status();
    expect(status.serverRemaining).toBe(0);
    expect(status.nextFreeAt).not.toBeNull();
    expect(Date.parse(status.nextFreeAt ?? "")).toBeGreaterThan(NOW + 30 * 24 * HOUR);
  });

  test("the status counts a held 401: keyRejected says so before the line is written", async () => {
    mock = startMockFlashapi({ key: ROTATED });
    const h = harness({ fetch: clockDiesDuringRequest });
    await h.service.refresh();
    await h.service.settled();
    now = NOW + HOUR;
    expect(await h.service.keyRejected("0000")).toBe(true);
  });
});

describe("a held line the schema refuses is not a poison pill", () => {
  test("a key change with a tag that is not four chars is dropped and logged; the refresh behind it still goes through", async () => {
    const h = harness();
    await h.service.noteKeyChange("ab");
    expect(h.logs.join("\n")).toMatch(/not valid|invalid/);
    expect((await h.service.refresh()).ok).toBe(true);
    await h.service.settled();
    expect((await quotaLines()).map((l) => l.kind)).toEqual(["send", "result"]);
  });

  test("a later valid line is written after a refused one", async () => {
    const h = harness();
    await h.service.noteKeyChange("ab");
    await h.service.noteKeyChange("0000");
    expect(await quotaLines()).toMatchObject([{ kind: "key", key: "0000" }]);
  });
});

describe("the flush chain survives a failure of its own", () => {
  test("a log() that throws while a write fails does not leave every later flush rejected", async () => {
    mock = startMockFlashapi({ key: KEY });
    let first = true;
    const breaking: FlashapiFetch = async (url, init) => {
      if (first) {
        first = false;
        await rm(quotaPath(), { force: true });
        await mkdir(quotaPath());
      }
      return nativeFetch(url, init);
    };
    let armed = true;
    const h = harness({
      fetch: breaking,
      log: () => {
        if (armed) throw new Error("the logger broke");
      },
    });
    await h.service.refresh();
    await h.service.settled();
    armed = false;
    await rm(quotaPath(), { recursive: true, force: true });
    const answer = await h.service.refresh();
    expect(answer.ok || answer.error.code !== "INTERNAL").toBe(true);
    await h.service.settled();
    expect((await quotaLines()).map((l) => l.kind)).toContain("result");
  });
});
