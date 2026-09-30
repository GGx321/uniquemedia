import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockFlashapi, type MockFlashapi } from "../../scripts/mockFlashapi";
import { MusicStatus, type EngineError } from "../../shared/engine";
import { captureConsole, expectNoKeyFragment, fragmentForms } from "../../testing/keyLeaks";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { nativeFetch, useNativeHttp } from "../../testing/nativeHttp";
import { type FlashapiFetch } from "./client";
import { QUOTA_LIMIT, QUOTA_WINDOW_MS, type QuotaLine } from "./quotaLedger";
import { MemoryListSink, MusicService, type FetchedList, type MusicListSink } from "./service";
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

function harness(options: { fetch?: FlashapiFetch; sink?: MusicListSink; quota?: string | null; key?: string | null; baseUrl?: string; timeoutMs?: number; mockOptions?: Parameters<typeof startMockFlashapi>[0] } = {}): Harness {
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
    log: (line) => void logs.push(line),
    ...(options.sink === undefined ? {} : { sink: options.sink }),
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
    const sink: MusicListSink = { accept: () => Promise.reject(new Error(`disk full near ${KEY}`)), summary: () => ({ listFetchedAt: null, trackCount: 0, bytesOnDisk: 0 }) };
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
