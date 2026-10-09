import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockFlashapi, type MockFlashapi } from "../../scripts/mockFlashapi";
import type { MusicStatus } from "../../shared/engine";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { nativeFetch, useNativeHttp } from "../../testing/nativeHttp";
import type { FlashapiFetch } from "./client";
import type { QuotaLine } from "./quotaLedger";
import { MusicService, type AutoRefreshAnswer } from "./service";
import { PersistingTestSink } from "./testing/testSink";
useNativeGlobals();
useNativeHttp();

// The send path of the auto-refresh rule (Stage 4, S4.5d; plan §7, A11): `MusicService.autoRefresh` applies the rule inside the ordinary admission. The rule's own boundaries are
// in autoRefresh.test.ts; here is what the SERVICE does around it: nothing is sent or written when the rule says no, the automatic line goes to auto-sends.jsonl BEFORE the
// ledger's reserve, the ledger's lines stay exactly what a manual refresh writes, and one launch gets one automatic refresh.

const KEY = "Zq7-vKt9-Wm2x-Lp4s-0000";
const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

let dir = "";
let mock: MockFlashapi | null = null;
let now = NOW;
let idCounter = 0;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "studio-music-auto-"));
  now = NOW;
  idCounter = 0;
});
afterEach(async () => {
  await mock?.stop();
  mock = null;
  await rm(dir, { recursive: true, force: true });
});

const quotaPath = () => join(dir, "music", "quota.jsonl");
const autoPath = () => join(dir, "music", "auto-sends.jsonl");
const readLines = async (path: string): Promise<string[]> => (await readFile(path, "utf8").catch(() => "")).split("\n").filter((l) => l !== "");
const quotaLines = async (): Promise<QuotaLine[]> => (await readLines(quotaPath())).map((l) => JSON.parse(l) as QuotaLine);
const autoLines = async (): Promise<unknown[]> => (await readLines(autoPath())).map((l) => JSON.parse(l) as unknown);

const sendLine = (n: number, at: number): QuotaLine => ({ v: 1, kind: "send", id: `seed-${n}`, at, key: "0000" });
/** `n` sends, an hour apart, the newest 100 h ago: out of the way of the 72 h rules, inside the 31 days. */
const oldSends = (n: number): QuotaLine[] => Array.from({ length: n }, (_, i) => sendLine(i, NOW - 100 * HOUR - (n - i) * HOUR));
async function seedQuota(lines: readonly QuotaLine[]): Promise<void> {
  await mkdir(join(dir, "music"), { recursive: true });
  await writeFile(quotaPath(), lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
}
/** `n` automatic sends, a day apart, the newest 4 days ago (clear of the 72 h spacing). */
async function seedAuto(n: number, tail = ""): Promise<void> {
  await mkdir(join(dir, "music"), { recursive: true });
  const lines = Array.from({ length: n }, (_, i) => JSON.stringify({ id: `auto-${i}`, at: NOW - 4 * DAY - (n - 1 - i) * 2 * HOUR }));
  await writeFile(autoPath(), lines.map((l) => `${l}\n`).join("") + tail);
}

interface Harness {
  service: MusicService;
  events: MusicStatus[];
  holder: { key: string | null; rejected: boolean };
}

function harness(options: { fetch?: FlashapiFetch; timeoutMs?: number } = {}): Harness {
  mock ??= startMockFlashapi({ key: KEY });
  const events: MusicStatus[] = [];
  const holder = { key: KEY as string | null, rejected: false };
  const service = new MusicService({
    quotaPath: quotaPath(),
    baseUrl: mock.url,
    allowBaseUrlOverride: true,
    fetch: options.fetch ?? ((url, init) => nativeFetch(url, init)),
    clock: () => now,
    newId: () => `refresh-${String(++idCounter).padStart(4, "0")}`,
    key: () => holder.key,
    keyRejected: () => holder.rejected,
    markKeyRejected: () => undefined,
    emit: (status) => void events.push(status),
    log: () => undefined,
    sink: new PersistingTestSink(),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return { service, events, holder };
}

const declinedFor = (answer: AutoRefreshAnswer): string => (answer.kind === "declined" ? answer.reason : answer.kind);
const ask = (h: Harness, launchId = "launch-0001", candidateCount = 50) => h.service.autoRefresh({ launchId, candidateCount });

/** The quota file and the automatic file as they are, and the requests the mock saw: what «nothing happened» looks like. */
async function untouched(): Promise<{ quota: string; auto: string }> {
  return { quota: await readFile(quotaPath(), "utf8").catch(() => "none"), auto: await readFile(autoPath(), "utf8").catch(() => "none") };
}

describe("an allowed automatic refresh", () => {
  test("starts, sends one request, and writes the same id to auto-sends.jsonl and to the ledger's send line", async () => {
    const h = harness();
    const answer = await ask(h);
    await h.service.settled();
    expect(answer.kind).toBe("started");
    expect(mock?.requests).toHaveLength(1);
    expect(await autoLines()).toEqual([{ id: "refresh-0001", at: NOW }]);
    const sends = (await quotaLines()).filter((l) => l.kind === "send");
    expect(sends).toEqual([{ v: 1, kind: "send", id: "refresh-0001", at: NOW, key: "0000" }]);
    expect(h.events.at(-1)?.refresh.state).toBe("idle");
  });

  test("the auto line is on disk when the request arrives, with the ledger's send beside it and no result yet", async () => {
    const seen: { at: { auto: unknown[]; kinds: string[] } | null } = { at: null };
    const h = harness({
      fetch: async (url, init) => {
        seen.at = { auto: await autoLines(), kinds: (await quotaLines()).map((l) => l.kind) };
        return nativeFetch(url, init);
      },
    });
    await ask(h);
    await h.service.settled();
    expect(seen.at).toEqual({ auto: [{ id: "refresh-0001", at: NOW }], kinds: ["send"] });
  });

  test("the ledger's lines are byte-identical to a manual refresh's: the same keys, no new field", async () => {
    const manual = harness();
    expect((await manual.service.refresh()).ok).toBe(true);
    await manual.service.settled();
    const manualText = await readFile(quotaPath(), "utf8");
    await mock?.stop();
    mock = null;
    await rm(join(dir, "music"), { recursive: true, force: true });
    await rm(join(dir, ".music-quota-started"), { force: true });
    idCounter = 0;

    const auto = harness();
    expect((await ask(auto)).kind).toBe("started");
    await auto.service.settled();
    // serverAt is the mock server's own Date header (real time), so two runs can straddle a second; every other byte must match.
    const withoutServerClock = (text: string): string => text.replace(/"serverAt":\d+/g, '"serverAt":0');
    const autoText = await readFile(quotaPath(), "utf8");
    expect(autoText).toContain('"serverAt":');
    expect(withoutServerClock(autoText)).toBe(withoutServerClock(manualText));
  });

  test("an automatic send is written before the ledger's reserve: when the ledger cannot take its line, the auto line is there and nothing left", async () => {
    await seedQuota(oldSends(1));
    await chmod(quotaPath(), 0o444);
    const h = harness();
    const answer = await ask(h);
    expect(answer).toMatchObject({ kind: "failed", error: { code: "MUSIC_UNAVAILABLE", musicReason: "log-unwritable" } });
    expect(await autoLines()).toEqual([{ id: "refresh-0001", at: NOW }]);
    expect(mock?.requests).toHaveLength(0);
    expect((await quotaLines()).filter((l) => "id" in l && l.id === "refresh-0001")).toEqual([]);
  });
});

describe("a declined automatic refresh sends nothing and writes nothing", () => {
  test("with no key", async () => {
    const h = harness();
    h.holder.key = null;
    const before = await untouched();
    expect(declinedFor(await ask(h))).toBe("no-key");
    expect(await untouched()).toEqual(before);
    expect(mock?.requests).toHaveLength(0);
  });

  test("with a key the server rejected", async () => {
    const h = harness();
    h.holder.rejected = true;
    expect(declinedFor(await ask(h))).toBe("key-rejected");
    expect(await untouched()).toEqual({ quota: "none", auto: "none" });
  });

  test("while a refresh is running: the running one is not disturbed and a second request is not sent", async () => {
    const never: FlashapiFetch = (_url, init) => new Promise<Response>((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    const h = harness({ fetch: never, timeoutMs: 60_000 });
    expect((await h.service.refresh()).ok).toBe(true);
    expect(declinedFor(await ask(h))).toBe("refresh-running");
    expect(await readLines(autoPath())).toEqual([]);
    expect((await quotaLines()).filter((l) => l.kind === "send")).toHaveLength(1);
    await h.service.stop();
  });

  test("a decline does not leave the service busy: the next ask, with the key back, goes through", async () => {
    const h = harness();
    h.holder.key = null;
    expect(declinedFor(await ask(h))).toBe("no-key");
    h.holder.key = KEY;
    expect((await ask(h)).kind).toBe("started");
    await h.service.settled();
  });

  test("a second automatic refresh in the same launch, even long after the first", async () => {
    const h = harness();
    expect((await ask(h, "launch-0001")).kind).toBe("started");
    await h.service.settled();
    now += 200 * HOUR;
    expect(declinedFor(await ask(h, "launch-0001"))).toBe("launch-already-refreshed");
    expect(mock?.requests).toHaveLength(1);
    expect(await autoLines()).toHaveLength(1);
  });

  test("a launch whose automatic refresh FAILED has still had its one", async () => {
    mock ??= startMockFlashapi({ key: KEY });
    mock.script({ status: 500, body: "boom" });
    const h = harness();
    expect((await ask(h, "launch-0001")).kind).toBe("started");
    await h.service.settled();
    now += 200 * HOUR;
    expect(declinedFor(await ask(h, "launch-0001"))).toBe("launch-already-refreshed");
  });

  test("another launch is held back by the 72 h spacing at 71 h and let through at 72 h", async () => {
    const h = harness();
    expect((await ask(h, "launch-0001")).kind).toBe("started");
    await h.service.settled();
    // Few candidates, so the list's age is not what holds the second launch back: the spacing is.
    now = NOW + 71 * HOUR;
    expect(declinedFor(await ask(h, "launch-0002", 5))).toBe("recent-auto");
    now = NOW + 72 * HOUR;
    expect((await ask(h, "launch-0002", 5)).kind).toBe("started");
    await h.service.settled();
    expect(await autoLines()).toHaveLength(2);
  });

  test("a list that is 71 h old with enough candidates is fresh: declined; at 72 h it is stale: allowed", async () => {
    const h = harness();
    expect((await h.service.refresh()).ok).toBe(true);
    await h.service.settled();
    now = NOW + 71 * HOUR;
    expect(declinedFor(await ask(h))).toBe("list-fresh");
    now = NOW + 72 * HOUR;
    expect((await ask(h)).kind).toBe("started");
    await h.service.settled();
  });

  test("a fresh list with fewer than 10 candidates still asks for a refresh", async () => {
    const h = harness();
    expect((await h.service.refresh()).ok).toBe(true);
    await h.service.settled();
    now = NOW + 2 * HOUR;
    expect(declinedFor(await ask(h, "launch-0001", 10))).toBe("list-fresh");
    expect((await ask(h, "launch-0001", 9)).kind).toBe("started");
    await h.service.settled();
  });
});

describe("the counts (A11)", () => {
  test("19 sends in all: the automatic refresh is the 20th and goes through", async () => {
    await seedQuota(oldSends(19));
    const h = harness();
    expect((await ask(h)).kind).toBe("started");
    await h.service.settled();
  });

  test("20 sends in all: declined, since it would leave fewer than 10 of the 30; a manual refresh still goes through", async () => {
    await seedQuota(oldSends(20));
    const h = harness();
    expect(declinedFor(await ask(h))).toBe("total-quota");
    expect(await readLines(autoPath())).toEqual([]);
    expect((await h.service.refresh()).ok).toBe(true);
    await h.service.settled();
  });

  test("9 automatic sends so far: the 10th goes through", async () => {
    await seedAuto(9);
    const h = harness();
    expect((await ask(h)).kind).toBe("started");
    await h.service.settled();
    expect(await autoLines()).toHaveLength(10);
  });

  test("10 automatic sends so far: declined", async () => {
    await seedAuto(10);
    const h = harness();
    expect(declinedFor(await ask(h))).toBe("auto-quota");
    expect(mock?.requests).toHaveLength(0);
  });

  test("a torn tail of auto-sends.jsonl is healed on the attempt and the whole lines are counted: 2 whole lines, the 3rd goes through", async () => {
    await seedAuto(2, '{"id":"auto-x","at":17');
    const h = harness();
    expect((await ask(h)).kind).toBe("started");
    await h.service.settled();
    expect(await autoLines()).toHaveLength(3);
    expect(await readFile(`${autoPath()}.torn`, "utf8")).toContain('{"id":"auto-x"');
  });

  test("9 whole lines and a torn tail: the 10th goes through; 10 whole lines and a torn tail: auto-quota", async () => {
    await seedAuto(9, '{"id":"auto-x","at":17');
    const nine = harness();
    expect((await ask(nine)).kind).toBe("started");
    await nine.service.settled();
    await mock?.stop();
    mock = null;
    await rm(join(dir, "music"), { recursive: true, force: true });
    await rm(join(dir, ".music-quota-started"), { force: true });
    await seedAuto(10, '{"id":"auto-x","at":17');
    const ten = harness();
    expect(declinedFor(await ask(ten, "launch-0002"))).toBe("auto-quota");
  });

  test("a broken WHOLE line in auto-sends.jsonl is auto-log-damaged (not auto-quota): the file is left as it was and a manual refresh is unaffected", async () => {
    await seedAuto(2, "");
    await writeFile(autoPath(), `${await readFile(autoPath(), "utf8")}nonsense\n`);
    const broken = await readFile(autoPath(), "utf8");
    const h = harness();
    expect(declinedFor(await ask(h))).toBe("auto-log-damaged");
    expect(await readFile(autoPath(), "utf8")).toBe(broken);
    expect(mock?.requests).toHaveLength(0);
    expect((await h.service.refresh()).ok).toBe(true);
    await h.service.settled();
    expect(await readFile(autoPath(), "utf8")).toBe(broken);
  });

  test("the server's last answer said 11 remain: allowed; 10: declined", async () => {
    const result = (remaining: number): QuotaLine => ({ v: 1, kind: "result", id: "seed-0", at: NOW - 100 * HOUR, key: "0000", outcome: "ok", remaining, limit: 30 });
    await seedQuota([sendLine(0, NOW - 100 * HOUR), result(11)]);
    const allowed = harness();
    expect((await ask(allowed)).kind).toBe("started");
    await allowed.service.settled();
    await mock?.stop();
    mock = null;
    await rm(join(dir, "music"), { recursive: true, force: true });
    await rm(join(dir, ".music-quota-started"), { force: true });
    await seedQuota([sendLine(0, NOW - 100 * HOUR), result(10)]);
    const refused = harness();
    expect(declinedFor(await ask(refused, "launch-0002"))).toBe("server-remaining");
  });

  test("an unreadable quota log declines nothing it can count: the refresh fails closed with the ledger's own refusal and nothing is sent", async () => {
    await mkdir(join(dir, "music"), { recursive: true });
    await writeFile(quotaPath(), "not json\n");
    const h = harness();
    const answer = await ask(h);
    expect(answer).toMatchObject({ kind: "failed", error: { code: "MUSIC_UNAVAILABLE", musicReason: "log-corrupt" } });
    expect(await readLines(autoPath())).toEqual([]);
    expect(mock?.requests).toHaveLength(0);
  });
});
