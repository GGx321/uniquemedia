import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockFlashapi, type MockFlashapi } from "../../scripts/mockFlashapi";
import { EngineError, MusicStatus, type MusicUnavailableReason } from "../../shared/engine";
import { captureConsole, expectNoKeyFragment } from "../../testing/keyLeaks";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { nativeFetch, useNativeHttp } from "../../testing/nativeHttp";
import type { FlashapiFetch } from "./client";
import { QUOTA_WINDOW_MS, type QuotaLine } from "./quotaLedger";
import { MusicService, SinkError, type MusicListSink } from "./service";
import { PersistingTestSink } from "./testing/testSink";
useNativeGlobals();
useNativeHttp();

// Stage 3, task 3c.6. Three things the Settings «Музыка» card needs from the service:
//  - the quota log's own state in the status (`quotaLog`), so «Обновить» can say why it is closed before a click;
//  - the cause of every MUSIC_UNAVAILABLE (`musicReason`): «Попробуйте позже» was true for only some of them;
//  - `recoverQuotaLog`: a damaged log is put aside and the quota closed for exactly 31 days, behind the owner's confirmation.
// No real network: flashapi is a loopback mock (studio/scripts/mockFlashapi.ts) or a fake fetch.

const KEY = "Zq7-vKt9-Wm2x-Lp4s-0000";
const LAST4 = "0000";
const NOW = Date.UTC(2026, 9, 3, 10, 15, 0);
const HOUR = 3600 * 1000;

let dir = "";
let mock: MockFlashapi | null = null;
let now = NOW;
let ids = 0;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "studio-music-causes-"));
  now = NOW;
  ids = 0;
});
afterEach(async () => {
  await mock?.stop();
  mock = null;
  await rm(dir, { recursive: true, force: true });
});

const quotaPath = () => join(dir, "music", "quota.jsonl");

/**
 * Puts a FOLDER where the quota file is, so no line can be appended: the disk breaks. The file's lines are kept aside, not
 * deleted, since a log that is gone while its marker says it existed now reads `missing` (review round 1).
 */
async function moveTheLogAway(): Promise<void> {
  await rename(quotaPath(), `${quotaPath()}.away`).catch(() => undefined);
  await mkdir(quotaPath());
}

/** The disk works again: the folder goes, and the log comes back with its lines. */
async function bringTheLogBack(): Promise<void> {
  await rm(quotaPath(), { recursive: true, force: true });
  await rename(`${quotaPath()}.away`, quotaPath()).catch(() => undefined);
}
const NO_CATALOGUE = { list: (): [] => [], peaks: (): Promise<null> => Promise.resolve(null) };
const EMPTY = { listFetchedAt: null, trackCount: 0, bytesOnDisk: 0 };

async function seedText(text: string): Promise<void> {
  await mkdir(join(dir, "music"), { recursive: true });
  await writeFile(quotaPath(), text);
}

const DAMAGED = `${JSON.stringify({ v: 1, kind: "send", id: "send-1", at: NOW - HOUR, key: LAST4 })}\nnot json at all\n`;

async function quotaLines(): Promise<QuotaLine[]> {
  const text = await readFile(quotaPath(), "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as QuotaLine);
}

function harness(options: { fetch?: FlashapiFetch; sink?: MusicListSink; quota?: string | null; baseUrl?: string; timeoutMs?: number; maxBodyBytes?: number } = {}) {
  mock ??= startMockFlashapi({ key: KEY });
  const events: MusicStatus[] = [];
  const logs: string[] = [];
  const holder = { key: KEY as string | null, rejected: false };
  const service = new MusicService({
    quotaPath: options.quota === undefined ? quotaPath() : options.quota,
    baseUrl: options.baseUrl ?? mock.url,
    allowBaseUrlOverride: true,
    fetch: options.fetch ?? ((url, init) => nativeFetch(url, init)),
    clock: () => now,
    newId: () => `refresh-${String(++ids).padStart(4, "0")}`,
    key: () => holder.key,
    keyRejected: () => holder.rejected,
    markKeyRejected: () => undefined,
    emit: (status) => void events.push(status),
    log: (line) => void logs.push(line),
    sink: options.sink ?? new PersistingTestSink(),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
  });
  return { service, events, logs, holder };
}

type Harness = ReturnType<typeof harness>;

/** A refusal's error, checked against the contract (a MUSIC_UNAVAILABLE without its cause would not parse). */
function refusal(answer: Awaited<ReturnType<MusicService["refresh"]>>): EngineError {
  if (answer.ok) throw new Error("expected a refusal");
  return EngineError.parse(answer.error);
}

/** Runs one refresh to its end and answers the error it ended with, checked against the contract. */
async function failureOf(h: Harness): Promise<EngineError> {
  const answer = await h.service.refresh();
  if (!answer.ok) return refusal(answer);
  await h.service.settled();
  const status = MusicStatus.parse(await h.service.status());
  if (status.refresh.state !== "failed") throw new Error(`expected the refresh to fail, it is ${status.refresh.state}`);
  return status.refresh.error;
}

/** A sink that fails the way `error` says. */
const failingSink = (error: () => unknown): MusicListSink => ({ persistent: true, ...NO_CATALOGUE, accept: () => Promise.reject(error()), summary: () => EMPTY });

describe("the status says whether its count can be trusted (quotaLog)", () => {
  test("a fresh log is ok", async () => {
    expect((await harness().service.status()).quotaLog).toBe("ok");
  });

  test("a damaged log is corrupt, and reads 30 of 30", async () => {
    await seedText(DAMAGED);
    const status = MusicStatus.parse(await harness().service.status());
    expect(status).toMatchObject({ quotaLog: "corrupt", sentLast31d: 30, nextFreeAt: null, serverRemaining: null });
  });

  test("a log that cannot be read at all is unreadable, and reads 30 of 30", async () => {
    await mkdir(quotaPath(), { recursive: true });
    const status = MusicStatus.parse(await harness().service.status());
    expect(status).toMatchObject({ quotaLog: "unreadable", sentLast31d: 30 });
  });

  test("a result that could not be written is held: the status says so until a write succeeds, and the refresh says why it waits", async () => {
    // The first request puts a FOLDER where the log is, so its result cannot be written; later ones are served plainly.
    let first = true;
    const breakingTheLog: FlashapiFetch = async (url, init) => {
      if (first) {
        first = false;
        await moveTheLogAway();
      }
      return nativeFetch(url, init);
    };
    mock = startMockFlashapi({ key: KEY });
    mock.script({ status: 500, body: "boom" });
    const h = harness({ fetch: breakingTheLog });
    await h.service.refresh();
    await h.service.settled();
    expect((await h.service.status()).quotaLog).toBe("unreadable");
    await bringTheLogBack();
    // The log is back: it reads again, and the line it could not take waits to be written.
    expect((await h.service.status()).quotaLog).toBe("held");
    await moveTheLogAway();
    expect(refusal(await h.service.refresh())).toMatchObject({ code: "MUSIC_UNAVAILABLE", musicReason: "log-held" });
    expect(mock.requests).toHaveLength(1);
    await bringTheLogBack();
    await h.service.refresh();
    await h.service.settled();
    expect((await h.service.status()).quotaLog).toBe("ok");
  });

  test("without a music folder there is no log to distrust: ok, and a refresh names the missing folder", async () => {
    const h = harness({ quota: null });
    expect((await h.service.status()).quotaLog).toBe("ok");
    expect(refusal(await h.service.refresh())).toMatchObject({ musicReason: "no-music-folder" });
  });
});

describe("every MUSIC_UNAVAILABLE says why (musicReason)", () => {
  describe("nothing was sent", () => {
    const nothingSent = async (h: Harness, reason: MusicUnavailableReason): Promise<void> => {
      const error = refusal(await h.service.refresh());
      expect(error).toMatchObject({ code: "MUSIC_UNAVAILABLE", musicReason: reason });
      expect(mock?.requests ?? []).toEqual([]);
    };

    test("shutting-down", async () => {
      const h = harness();
      await h.service.stop();
      await nothingSent(h, "shutting-down");
    });

    test("not-available: a sink that does not persist", async () => {
      await nothingSent(harness({ sink: { persistent: false, ...NO_CATALOGUE, accept: () => Promise.resolve(), summary: () => EMPTY } }), "not-available");
    });

    test("no-music-folder", async () => {
      await nothingSent(harness({ quota: null }), "no-music-folder");
    });

    test("clock", async () => {
      now = 0;
      await nothingSent(harness(), "clock");
    });

    test("config: a base URL the client refuses", async () => {
      await nothingSent(harness({ baseUrl: "https://evil.example" }), "config");
    });

    test("log-unwritable: the send line cannot be written", async () => {
      await mkdir(join(dir, "music"), { recursive: true });
      await mkdir(`${quotaPath()}.torn`, { recursive: true });
      await writeFile(quotaPath(), '{"v":1,"kind":"send"');
      await nothingSent(harness(), "log-unwritable");
    });

    test("log-unreadable", async () => {
      await mkdir(quotaPath(), { recursive: true });
      await nothingSent(harness(), "log-unreadable");
    });

    test("log-corrupt", async () => {
      await seedText(DAMAGED);
      await nothingSent(harness(), "log-corrupt");
    });
  });

  describe("the request left, and it counts", () => {
    const counted = async (h: Harness, reason: MusicUnavailableReason): Promise<EngineError> => {
      const error = await failureOf(h);
      expect(error).toMatchObject({ code: "MUSIC_UNAVAILABLE", musicReason: reason });
      expect((await quotaLines()).filter((line) => line.kind === "send")).toHaveLength(1);
      return error;
    };

    test("network: no answer at all", async () => {
      await counted(harness({ fetch: () => Promise.reject(new TypeError("connect failed")) }), "network");
    });

    test("network: no answer in time", async () => {
      mock = startMockFlashapi({ key: KEY });
      mock.script({ delayMs: 400 });
      await counted(harness({ timeoutMs: 50 }), "network");
    });

    test("forbidden: a 403 (no subscription on the key)", async () => {
      mock = startMockFlashapi({ key: KEY });
      mock.script({ status: 403, body: { message: "You are not subscribed to this API." } });
      await counted(harness(), "forbidden");
    });

    test("rate-limited: a 429, with the wait the server named", async () => {
      mock = startMockFlashapi({ key: KEY });
      mock.script({ status: 429, body: "slow down", headers: { "retry-after": "120" } });
      const error = await counted(harness(), "rate-limited");
      expect(error.retryAfterMs).toBe(120_000);
    });

    test("server: another HTTP error", async () => {
      mock = startMockFlashapi({ key: KEY });
      mock.script({ status: 502, body: "bad gateway" });
      await counted(harness(), "server");
    });

    test("bad-answer: an answer that is not JSON", async () => {
      mock = startMockFlashapi({ key: KEY });
      mock.script({ status: 200, body: "<html>maintenance</html>" });
      await counted(harness(), "bad-answer");
    });

    test("bad-answer: an answer too large", async () => {
      mock = startMockFlashapi({ key: KEY });
      mock.script({ status: 200, oversize: { bytes: 4096, contentLength: true } });
      await counted(harness({ maxBodyBytes: 1024 }), "bad-answer");
    });

    test("bad-answer: a list with no usable track", async () => {
      mock = startMockFlashapi({ key: KEY });
      mock.script({ status: 200, body: { data: { items: [] } } });
      await counted(harness(), "bad-answer");
    });

    test("store-failed: the list came and the sink could not store it", async () => {
      await counted(harness({ sink: failingSink(() => Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" })) }), "store-failed");
    });

    test("store-failed: a sink's own error with no cause of its own", async () => {
      await counted(harness({ sink: failingSink(() => new SinkError("none of the 3 tracks could be stored (decode-failed x3)")) }), "store-failed");
    });

    test("downloads-stopped: the CDN refused the sampled downloads alike (the 3c.4 breaker), and every URL is kept", async () => {
      const stopped = () => new SinkError("the CDN refused the 2 sampled downloads (status-403); nothing more was requested", "downloads-stopped");
      const error = await counted(harness({ sink: failingSink(stopped) }), "downloads-stopped");
      expect(error.detail).toContain("status-403");
    });
  });

  describe("the downloads of a list fetched earlier: no request at all", () => {
    const resuming = (error: () => unknown): MusicListSink => ({ ...failingSink(error), pendingCount: () => 2, resume: () => Promise.reject(error()) });

    const resumeFailure = async (h: Harness): Promise<EngineError> => {
      await h.service.resumePending();
      await h.service.settled();
      const status = MusicStatus.parse(await h.service.status());
      if (status.refresh.state !== "failed") throw new Error("expected the resume to fail");
      expect(mock?.requests ?? []).toEqual([]);
      expect(await quotaLines()).toEqual([]);
      return status.refresh.error;
    };

    test("downloads-stopped: the breaker tripped again with URLs pending", async () => {
      const error = await resumeFailure(harness({ sink: resuming(() => new SinkError("the CDN refused the 3 sampled downloads (status-429)", "downloads-stopped")) }));
      expect(error).toMatchObject({ code: "MUSIC_UNAVAILABLE", musicReason: "downloads-stopped" });
    });

    test("downloads-failed: anything else", async () => {
      const error = await resumeFailure(harness({ sink: resuming(() => Object.assign(new Error("EACCES"), { code: "EACCES" })) }));
      expect(error).toMatchObject({ code: "MUSIC_UNAVAILABLE", musicReason: "downloads-failed" });
    });
  });
});

// Review round 1 (HIGH): a held result was written only by the next refresh, and the card closes «Обновить» while a line is
// held, so the owner's only way out was a restart, which forgot the line and with it the server's 0. Asking the status now
// writes what is held: it is free, nothing leaves.
describe("a held line is written when the window asks for the status", () => {
  /** The log turns read-only as the request arrives (a permission the owner later fixes), so the answer's result is held. */
  const readOnlyOnce = (): FlashapiFetch => {
    let first = true;
    return async (url, init) => {
      if (first) {
        first = false;
        await chmod(quotaPath(), 0o444);
      }
      return nativeFetch(url, init);
    };
  };

  test("held, the disk fixed, the status asked: written, ok, the server's 0 kept, no request; a restart still refuses", async () => {
    mock = startMockFlashapi({ key: KEY, remaining: 0 });
    const h = harness({ fetch: readOnlyOnce() });
    try {
      await h.service.refresh();
      await h.service.settled();
      expect(await h.service.status()).toMatchObject({ quotaLog: "held", serverRemaining: 0 });
    } finally {
      await chmod(quotaPath(), 0o644);
    }
    const asked = MusicStatus.parse(await h.service.status({ writeHeld: true }));
    expect(asked).toMatchObject({ quotaLog: "ok", sentLast31d: 1, serverRemaining: 0 });
    expect((await quotaLines()).map((line) => line.kind)).toEqual(["send", "result"]);
    expect(mock.requests).toHaveLength(1);

    const restarted = harness();
    expect(await restarted.service.status()).toMatchObject({ quotaLog: "ok", serverRemaining: 0 });
    expect(refusal(await restarted.service.refresh()).code).toBe("MUSIC_QUOTA_EXHAUSTED");
    expect(mock.requests).toHaveLength(1);
  });

  test("while the disk is still broken the asked status stays held, and nothing leaves", async () => {
    mock = startMockFlashapi({ key: KEY, remaining: 0 });
    const h = harness({ fetch: readOnlyOnce() });
    try {
      await h.service.refresh();
      await h.service.settled();
      expect((await h.service.status({ writeHeld: true })).quotaLog).toBe("held");
      expect(mock.requests).toHaveLength(1);
    } finally {
      await chmod(quotaPath(), 0o644);
    }
  });

  test("a status the service builds for its own events does not write: only the window's ask does", async () => {
    mock = startMockFlashapi({ key: KEY, remaining: 0 });
    const h = harness({ fetch: readOnlyOnce() });
    try {
      await h.service.refresh();
      await h.service.settled();
    } finally {
      await chmod(quotaPath(), 0o644);
    }
    expect((await h.service.status()).quotaLog).toBe("held");
  });
});

// Review round 1 (MEDIUM, money): deleting the music folder (its tracks are ~100 MB) took the quota log and the count with it.
describe("a quota log that is gone while its marker says it existed: missing", () => {
  /** A log with one send of this service's, then the music folder deleted (the marker beside it stays). */
  async function deletedAfterASend(h: Harness): Promise<void> {
    mock ??= startMockFlashapi({ key: KEY });
    await h.service.refresh();
    await h.service.settled();
    await rm(join(dir, "music"), { recursive: true, force: true });
  }

  test("reads 30 of 30, and a refresh is refused as log-missing without a request", async () => {
    const h = harness();
    await deletedAfterASend(h);
    expect(MusicStatus.parse(await h.service.status())).toMatchObject({ quotaLog: "missing", sentLast31d: 30, nextFreeAt: null });
    expect(refusal(await h.service.refresh())).toMatchObject({ code: "MUSIC_UNAVAILABLE", musicReason: "log-missing" });
    expect(mock?.requests).toHaveLength(1);
  });

  test("re-entering the key does not start a fresh log: still missing, still refused for it (never «held»)", async () => {
    const h = harness();
    await deletedAfterASend(h);
    await h.service.noteKeyChange(LAST4);
    expect((await h.service.status({ writeHeld: true })).quotaLog).toBe("missing");
    expect(refusal(await h.service.refresh())).toMatchObject({ code: "MUSIC_UNAVAILABLE", musicReason: "log-missing" });
    expect(mock?.requests).toHaveLength(1);
  });

  test("a fresh install (no marker) is not missing: the first refresh goes", async () => {
    const h = harness();
    expect((await h.service.status()).quotaLog).toBe("ok");
    mock ??= startMockFlashapi({ key: KEY });
    expect((await h.service.refresh()).ok).toBe(true);
  });

  test("recovering it closes the quota for 31 days, and what was held meanwhile is written behind it", async () => {
    const h = harness();
    await deletedAfterASend(h);
    await h.service.noteKeyChange(LAST4);
    const answer = await h.service.recoverQuotaLog();
    expect(answer.ok ? MusicStatus.parse(answer.status) : answer.error).toMatchObject({ quotaLog: "ok", sentLast31d: 30, nextFreeAt: new Date(NOW + QUOTA_WINDOW_MS).toISOString() });
    expect((await quotaLines()).map((line) => line.kind)).toEqual(["recovered", "key"]);
    expect(refusal(await h.service.refresh()).code).toBe("MUSIC_QUOTA_EXHAUSTED");
    expect(mock?.requests).toHaveLength(1);
  });
});

describe("recoverQuotaLog while the downloads of a list run (review round 1, LOW)", () => {
  test("is refused IN_FLIGHT, and the damaged log is left as it is", async () => {
    await seedText(DAMAGED);
    let release: () => void = () => undefined;
    const sink: MusicListSink = {
      ...failingSink(() => new Error("unused")),
      pendingCount: () => 1,
      resume: () => new Promise<void>((resolve) => (release = resolve)),
    };
    const h = harness({ sink });
    await h.service.resumePending();
    const answer = await h.service.recoverQuotaLog();
    expect(answer.ok ? null : answer.error.code).toBe("IN_FLIGHT");
    expect(await readFile(quotaPath(), "utf8")).toBe(DAMAGED);
    release();
    await h.service.settled();
    expect((await h.service.recoverQuotaLog()).ok).toBe(true);
  });
});

describe("SinkError", () => {
  test("has no cause unless it is given one", () => {
    expect(new SinkError("x").reason).toBeNull();
    expect(new SinkError("x", "downloads-stopped").reason).toBe("downloads-stopped");
  });
});

describe("recoverQuotaLog", () => {
  async function recovered(h: Harness) {
    const answer = await h.service.recoverQuotaLog();
    if (!answer.ok) throw new Error(`expected a recovery, got ${answer.error.code}`);
    return MusicStatus.parse(answer.status);
  }

  test("puts a damaged log aside and answers the quota closed: 30 of 30 until exactly 31 days from now", async () => {
    await seedText(DAMAGED);
    const h = harness();
    expect(await recovered(h)).toMatchObject({ quotaLog: "ok", sentLast31d: 30, serverRemaining: null, nextFreeAt: new Date(NOW + QUOTA_WINDOW_MS).toISOString() });
    const files = (await readdir(join(dir, "music"))).sort();
    expect(files).toEqual(["quota.jsonl", "quota.jsonl.corrupt-20261003T101500Z"]);
    expect(await readFile(join(dir, "music", "quota.jsonl.corrupt-20261003T101500Z"), "utf8")).toBe(DAMAGED);
  });

  test("announces the new status (music.changed) before it answers", async () => {
    await seedText(DAMAGED);
    const h = harness();
    await recovered(h);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ quotaLog: "ok", sentLast31d: 30, refresh: { state: "idle" } });
  });

  test("sends nothing, and the refresh after it is refused for the quota without a request, until the 31 days end", async () => {
    await seedText(DAMAGED);
    const h = harness();
    await recovered(h);
    expect(refusal(await h.service.refresh()).code).toBe("MUSIC_QUOTA_EXHAUSTED");
    now = NOW + QUOTA_WINDOW_MS - 1;
    expect(refusal(await h.service.refresh()).code).toBe("MUSIC_QUOTA_EXHAUSTED");
    expect(mock?.requests).toEqual([]);
    now = NOW + QUOTA_WINDOW_MS;
    expect((await h.service.refresh()).ok).toBe(true);
    await h.service.settled();
    expect(mock?.requests).toHaveLength(1);
    expect((await h.service.status()).sentLast31d).toBe(1);
  });

  test("keeps the engine's rejected key, so a revoked key still reads as rejected after a restart", async () => {
    await seedText(DAMAGED);
    const h = harness();
    h.holder.rejected = true;
    await recovered(h);
    expect(await harness().service.keyRejected(LAST4)).toBe(true);
  });

  test("a key that is not marked rejected is not written as one", async () => {
    await seedText(DAMAGED);
    const h = harness();
    await recovered(h);
    expect(await harness().service.keyRejected(LAST4)).toBe(false);
  });

  test("a sound log: VALIDATION, nothing changed, nothing announced", async () => {
    const sound = `${JSON.stringify({ v: 1, kind: "send", id: "send-1", at: NOW - HOUR, key: LAST4 })}\n`;
    await seedText(sound);
    const h = harness();
    const answer = await h.service.recoverQuotaLog();
    expect(answer.ok ? null : answer.error.code).toBe("VALIDATION");
    expect(await readFile(quotaPath(), "utf8")).toBe(sound);
    expect(h.events).toEqual([]);
  });

  async function refusedRecovery(reason: MusicUnavailableReason): Promise<void> {
    const h = harness();
    const answer = await h.service.recoverQuotaLog();
    expect(answer.ok ? null : EngineError.parse(answer.error)).toMatchObject({ code: "MUSIC_UNAVAILABLE", musicReason: reason });
    expect(h.events).toEqual([]);
  }

  test("the log cannot be read at all: MUSIC_UNAVAILABLE log-unreadable, nothing changed", async () => {
    await mkdir(quotaPath(), { recursive: true });
    await refusedRecovery("log-unreadable");
  });

  test("the clock is not a real date: MUSIC_UNAVAILABLE clock, the damaged log left as it is", async () => {
    await seedText(DAMAGED);
    now = 0;
    await refusedRecovery("clock");
    expect(await readFile(quotaPath(), "utf8")).toBe(DAMAGED);
  });

  test("no music folder: MUSIC_UNAVAILABLE no-music-folder", async () => {
    const answer = await harness({ quota: null }).service.recoverQuotaLog();
    expect(answer.ok ? null : answer.error).toMatchObject({ code: "MUSIC_UNAVAILABLE", musicReason: "no-music-folder" });
  });

  test("a stopping service: MUSIC_UNAVAILABLE shutting-down, the log left as it is", async () => {
    await seedText(DAMAGED);
    const h = harness();
    await h.service.stop();
    const answer = await h.service.recoverQuotaLog();
    expect(answer.ok ? null : answer.error).toMatchObject({ code: "MUSIC_UNAVAILABLE", musicReason: "shutting-down" });
    expect(await readFile(quotaPath(), "utf8")).toBe(DAMAGED);
  });

  test("a copy that cannot be made: MUSIC_UNAVAILABLE log-unwritable, and the damaged log is still the log (still closed)", async () => {
    await seedText(DAMAGED);
    // Every name the copy could take is already taken.
    for (let n = 1; n <= 100; n++) await mkdir(join(dir, "music", n === 1 ? "quota.jsonl.corrupt-20261003T101500Z" : `quota.jsonl.corrupt-20261003T101500Z-${n}`));
    const h = harness();
    const answer = await h.service.recoverQuotaLog();
    expect(answer.ok ? null : answer.error).toMatchObject({ code: "MUSIC_UNAVAILABLE", musicReason: "log-unwritable" });
    expect(await readFile(quotaPath(), "utf8")).toBe(DAMAGED);
    expect((await h.service.status()).quotaLog).toBe("corrupt");
  });

  test("nothing of the key reaches the files, the events, the log or the console", async () => {
    await seedText(DAMAGED);
    const output = captureConsole();
    try {
      const h = harness();
      h.holder.rejected = true;
      await recovered(h);
      for (const name of await readdir(join(dir, "music"))) expectNoKeyFragment(await readFile(join(dir, "music", name), "utf8"), KEY);
      expectNoKeyFragment(JSON.stringify(h.events), KEY);
      expectNoKeyFragment(h.logs.join("\n"), KEY);
      expectNoKeyFragment(output.text(), KEY);
    } finally {
      output.restore();
    }
  });
});
