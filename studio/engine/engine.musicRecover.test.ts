import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startMockFlashapi, type MockFlashapi } from "../scripts/mockFlashapi";
import { EngineError, MusicStatus } from "../shared/engine";
import { captureConsole, expectNoKeyFragment } from "../testing/keyLeaks";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { nativeFetch, useNativeHttp } from "../testing/nativeHttp";
import { FLASHAPI_BASE, type FlashapiFetch } from "./music/client";
import { PersistingTestSink } from "./music/testing/testSink";
import { command, failed, ok, startEngine, useEngineDir } from "./testing/engineHarness";
useNativeGlobals();
useNativeHttp();

// Stage 3, task 3c.6: `music.recoverQuotaLog` in the engine. A damaged quota log reads 30 of 30 forever; the command puts it
// aside and closes the quota for exactly 31 days, sending nothing. flashapi is a loopback mock, and no request may reach it.

const dir = useEngineDir("studio-engine-music-recover-");
const MUSIC = "Zq7-vKt9-Wm2x-Lp4s-0000";
const DAMAGED = `${JSON.stringify({ v: 1, kind: "send", id: "send-1", at: Date.UTC(2026, 9, 1), key: "0000" })}\nnot json at all\n`;

const mocks: MockFlashapi[] = [];
afterEach(async () => {
  for (const started of mocks.splice(0)) await started.stop();
});

const musicDir = () => join(dir(), "userData", "music");

async function start(options: { damaged?: boolean } = {}) {
  const mock = startMockFlashapi({ key: MUSIC });
  mocks.push(mock);
  if (options.damaged !== false) {
    await mkdir(musicDir(), { recursive: true });
    await writeFile(join(musicDir(), "quota.jsonl"), DAMAGED);
  }
  const fetchViaMock: FlashapiFetch = (url, init) => nativeFetch(url.replace(FLASHAPI_BASE, mock.url), init);
  const started = await startEngine(dir(), { key: null, init: { musicDir: musicDir() }, deps: { musicFetch: fetchViaMock, musicSink: new PersistingTestSink() } });
  await started.engine.applyControl({ kind: "control", type: "musicKey.set", key: MUSIC, origin: "start" });
  return { ...started, mock };
}

const statusOf = async (engine: Awaited<ReturnType<typeof start>>["engine"]) => {
  const response = ok(await engine.handle(command("music.status")));
  if (response.type !== "music.status") throw new Error("wrong type");
  return MusicStatus.parse(response.result);
};

describe("music.status writes a held line (review round 1, HIGH)", () => {
  test("a result held by a read-only log, the permission fixed: the window's music.status writes it, keeps the server's 0 and sends nothing", async () => {
    const mock = startMockFlashapi({ key: MUSIC, remaining: 0 });
    mocks.push(mock);
    let first = true;
    const log = join(musicDir(), "quota.jsonl");
    const readOnlyOnce: FlashapiFetch = async (url, init) => {
      if (first) {
        first = false;
        await chmod(log, 0o444);
      }
      return nativeFetch(url.replace(FLASHAPI_BASE, mock.url), init);
    };
    const { engine } = await startEngine(dir(), { key: null, init: { musicDir: musicDir() }, deps: { musicFetch: readOnlyOnce, musicSink: new PersistingTestSink() } });
    await engine.applyControl({ kind: "control", type: "musicKey.set", key: MUSIC, origin: "user" });
    try {
      ok(await engine.handle(command("music.refresh", { confirm: true })));
      await engine.musicSettled();
    } finally {
      await chmod(log, 0o644);
    }
    expect(await statusOf(engine)).toMatchObject({ quotaLog: "ok", serverRemaining: 0 });
    expect(failed(await engine.handle(command("music.refresh", { confirm: true }))).error.code).toBe("MUSIC_QUOTA_EXHAUSTED");
    expect(mock.requests).toHaveLength(1);
  });
});

describe("a quota log deleted with the music folder (review round 1, MEDIUM)", () => {
  test("reads missing and 30 of 30, refuses a refresh without a request, and its recovery closes the quota for 31 days", async () => {
    const { engine, mock } = await start({ damaged: false });
    // The key line the owner's «Сохранить» wrote is the log's first line: the marker beside music/ now says it existed.
    expect(await statusOf(engine)).toMatchObject({ quotaLog: "ok" });
    await engine.applyControl({ kind: "control", type: "musicKey.set", key: MUSIC, origin: "user" });
    await rm(musicDir(), { recursive: true, force: true });
    expect(await statusOf(engine)).toMatchObject({ quotaLog: "missing", sentLast31d: 30 });
    expect(EngineError.parse(failed(await engine.handle(command("music.refresh", { confirm: true }))).error)).toMatchObject({ code: "MUSIC_UNAVAILABLE", musicReason: "log-missing" });
    const recovered = ok(await engine.handle(command("music.recoverQuotaLog", { confirm: true })));
    if (recovered.type !== "music.recoverQuotaLog") throw new Error("wrong type");
    expect(recovered.result.status).toMatchObject({ quotaLog: "ok", sentLast31d: 30 });
    expect(failed(await engine.handle(command("music.refresh", { confirm: true }))).error.code).toBe("MUSIC_QUOTA_EXHAUSTED");
    expect(mock.requests).toEqual([]);
  });
});

describe("a 401 the damaged log still names (review round 1, LOW)", () => {
  test("an engine started on the damaged log knew nothing of it; recovery keeps it, so the next refresh says the key is rejected", async () => {
    const rejected = { v: 1, kind: "result", id: "send-1", at: Date.UTC(2026, 9, 1), key: MUSIC.slice(-4), outcome: "rejected", status: 401 };
    await mkdir(musicDir(), { recursive: true });
    await writeFile(join(musicDir(), "quota.jsonl"), `${JSON.stringify(rejected)}\nnot json at all\n`);
    const { engine, mock } = await start({ damaged: false });
    ok(await engine.handle(command("music.recoverQuotaLog", { confirm: true })));
    expect(failed(await engine.handle(command("music.refresh", { confirm: true }))).error.code).toBe("MUSIC_KEY_REJECTED");
    const settings = ok(await engine.handle(command("settings.get")));
    expect(settings.type === "settings.get" ? settings.result.musicKey.rejected : null).toBe(true);
    expect(mock.requests).toEqual([]);
  });
});

describe("music.recoverQuotaLog", () => {
  test("a damaged log reads as corrupt and 30 of 30, and a refresh says so without a request", async () => {
    const { engine, mock } = await start();
    expect(await statusOf(engine)).toMatchObject({ quotaLog: "corrupt", sentLast31d: 30 });
    const refused = failed(await engine.handle(command("music.refresh", { confirm: true })));
    expect(EngineError.parse(refused.error)).toMatchObject({ code: "MUSIC_UNAVAILABLE", musicReason: "log-corrupt" });
    expect(mock.requests).toEqual([]);
  });

  test("puts the log aside, announces and answers the quota closed for 31 days, and the next refresh is refused for the quota", async () => {
    const { engine, events, mock } = await start();
    const response = ok(await engine.handle(command("music.recoverQuotaLog", { confirm: true })));
    if (response.type !== "music.recoverQuotaLog") throw new Error("wrong type");
    expect(response.result.status).toMatchObject({ quotaLog: "ok", sentLast31d: 30 });
    const announced = events().filter((e) => e.type === "music.changed");
    expect(announced.at(-1)?.payload.status).toMatchObject({ quotaLog: "ok", sentLast31d: 30 });
    expect((await readdir(musicDir())).filter((name) => name.startsWith("quota.jsonl.corrupt-"))).toHaveLength(1);
    expect(failed(await engine.handle(command("music.refresh", { confirm: true }))).error.code).toBe("MUSIC_QUOTA_EXHAUSTED");
    expect(mock.requests).toEqual([]);
  });

  test("a sound log is refused with VALIDATION and left as it is", async () => {
    const { engine } = await start({ damaged: false });
    expect(failed(await engine.handle(command("music.recoverQuotaLog", { confirm: true }))).error.code).toBe("VALIDATION");
    expect((await readdir(musicDir()).catch(() => [])).filter((name) => name.includes("corrupt"))).toEqual([]);
  });

  test("the payload must confirm: without it nothing is touched", async () => {
    const { engine } = await start();
    expect(failed(await engine.handle(command("music.recoverQuotaLog", {}))).error.code).toBe("VALIDATION");
    expect(await readFile(join(musicDir(), "quota.jsonl"), "utf8")).toStartWith(DAMAGED);
  });

  test("leaves nothing of the key in the files, the events or the console", async () => {
    const output = captureConsole();
    try {
      const { engine, events } = await start();
      ok(await engine.handle(command("music.recoverQuotaLog", { confirm: true })));
      for (const name of await readdir(musicDir())) expectNoKeyFragment(await readFile(join(musicDir(), name), "utf8"), MUSIC);
      expectNoKeyFragment(JSON.stringify(events()), MUSIC);
      expectNoKeyFragment(output.text(), MUSIC);
    } finally {
      output.restore();
    }
  });
});
