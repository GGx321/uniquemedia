import { afterEach, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { startMockFlashapi, type MockFlashapi } from "../scripts/mockFlashapi";
import { MusicStatus } from "../shared/engine";
import { captureConsole, expectNoKeyFragment, fragmentForms } from "../testing/keyLeaks";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { nativeFetch, useNativeHttp } from "../testing/nativeHttp";
import { resolveMusicBaseUrl } from "./engine";
import { FLASHAPI_BASE, type FlashapiFetch } from "./music/client";
import { PersistingTestSink } from "./music/testing/testSink";
import { command, failed, ok, startEngine, useEngineDir } from "./testing/engineHarness";
useNativeGlobals();
useNativeHttp();

// Stage 3, task 3c.3: the music commands in the engine. The real flashapi is never contacted: the engine asks for the
// REAL base URL (a production build cannot ask for another), and the test's fetch answers it from a loopback mock.

const dir = useEngineDir("studio-engine-music-");

const MUSIC = "Zq7-vKt9-Wm2x-Lp4s-0000";
const ROTATED = "Hb5-nRw3-Yc8d-Qj6f-9999";

let mock: MockFlashapi | null = null;
const mocks: MockFlashapi[] = [];
afterEach(async () => {
  for (const started of mocks.splice(0)) await started.stop();
  mock = null;
});

/** A fetch that records what the engine asked for and serves it from the mock instead of the internet. */
function viaMock(seen: string[]): FlashapiFetch {
  return (url, init) => {
    seen.push(url);
    if (mock === null) throw new Error("no mock");
    return nativeFetch(url.replace(FLASHAPI_BASE, mock.url), init);
  };
}

const musicDir = () => join(dir(), "userData", "music");

async function start(options: { defaultSink?: boolean; key?: string | null; origin?: "user" | "start"; mockKey?: string; withDir?: boolean; seen?: string[] } = {}) {
  mock = startMockFlashapi({ key: options.mockKey ?? MUSIC });
  mocks.push(mock);
  const seen = options.seen ?? [];
  const started = await startEngine(dir(), {
    key: null,
    init: options.withDir === false ? {} : { musicDir: musicDir() },
    deps: { musicFetch: viaMock(seen), ...(options.defaultSink === true ? {} : { musicSink: new PersistingTestSink() }) },
  });
  if (options.key !== null) await started.engine.applyControl({ kind: "control", type: "musicKey.set", key: options.key ?? MUSIC, origin: options.origin ?? "user" });
  return { ...started, seen };
}

type Started = Awaited<ReturnType<typeof start>>;

const statusOf = async (engine: Started["engine"]) => {
  const response = ok(await engine.handle(command("music.status")));
  if (response.type !== "music.status") throw new Error("wrong type");
  return response.result;
};

/** Waits for the refresh to end: the engine's own settled hook, then a final status. */
async function refreshed(engine: Started["engine"]) {
  const response = ok(await engine.handle(command("music.refresh", { confirm: true })));
  await engine.settled();
  await engine.musicSettled();
  return response;
}

describe("music.status", () => {
  test("of an engine that never refreshed", async () => {
    const { engine } = await start();
    expect(await statusOf(engine)).toEqual({ listFetchedAt: null, trackCount: 0, bytesOnDisk: 0, sentLast31d: 0, limit: 30, serverRemaining: null, nextFreeAt: null, refresh: { state: "idle" }, quotaLog: "ok" });
  });

  test("works without a music folder: the never-refreshed status", async () => {
    const { engine } = await start({ withDir: false });
    expect((await statusOf(engine)).sentLast31d).toBe(0);
  });
});

describe("music.refresh", () => {
  test("asks the REAL flashapi base URL, with the key in its header only, and answers at once with the status running", async () => {
    const seen: string[] = [];
    const { engine } = await start({ seen });
    const response = await refreshed(engine);
    expect(response).toMatchObject({ type: "music.refresh", result: { status: { refresh: { state: "running", done: 0, total: 1 }, sentLast31d: 1 } } });
    expect(seen).toEqual([`${FLASHAPI_BASE}/ig/music_trending/`]);
    expect(mock?.requests[0]?.headers["x-rapidapi-key"]).toBe(MUSIC);
    expectNoKeyFragment(mock?.requests[0]?.url ?? "", MUSIC);
  });

  test("ends idle with the list and the count, announced through music.changed", async () => {
    const { engine, events } = await start();
    await refreshed(engine);
    const status = await statusOf(engine);
    expect(status).toMatchObject({ trackCount: 30, sentLast31d: 1, serverRemaining: 28, refresh: { state: "idle" } });
    const changes = events().filter((e) => e.type === "music.changed");
    expect(changes.length).toBeGreaterThanOrEqual(2);
    for (const change of changes) expect(MusicStatus.safeParse(change.payload.status).success).toBe(true);
    expect(changes[0]?.payload.status.refresh.state).toBe("running");
    expect(changes.at(-1)?.payload.status.refresh.state).toBe("idle");
  });

  test("without a key: MUSIC_KEY_MISSING, nothing sent", async () => {
    const { engine } = await start({ key: null });
    const response = failed(await engine.handle(command("music.refresh", { confirm: true })));
    expect(response.error.code).toBe("MUSIC_KEY_MISSING");
    expect(mock?.requests).toEqual([]);
  });

  test("without a music folder: MUSIC_UNAVAILABLE, nothing sent", async () => {
    const { engine } = await start({ withDir: false });
    expect(failed(await engine.handle(command("music.refresh", { confirm: true }))).error.code).toBe("MUSIC_UNAVAILABLE");
    expect(mock?.requests).toEqual([]);
  });

  test("with no persisting sink (until 3c.4) it is refused as not available yet: no request, no quota line", async () => {
    const { engine } = await start({ defaultSink: true });
    const response = failed(await engine.handle(command("music.refresh", { confirm: true })));
    expect(response.error.code).toBe("MUSIC_UNAVAILABLE");
    expect(response.error.detail).toContain("not available yet");
    expect(mock?.requests).toEqual([]);
    expect((await statusOf(engine)).sentLast31d).toBe(0);
  });

  test("a refresh without confirm: true is refused by the contract", async () => {
    const { engine } = await start();
    expect(failed(await engine.handle(command("music.refresh", {}))).error.code).toBe("VALIDATION");
    expect(mock?.requests).toEqual([]);
  });

  test("30 sends in the window: MUSIC_QUOTA_EXHAUSTED, and no request", async () => {
    const { engine } = await start();
    const lines = Array.from({ length: 30 }, (_, i) => JSON.stringify({ v: 1, kind: "send", id: `seed-${i}`, at: Date.parse("2026-09-24T12:00:00.000Z") - (i + 1) * 3600_000, key: "0000" }));
    await Bun.write(join(musicDir(), "quota.jsonl"), `${lines.join("\n")}\n`);
    expect(failed(await engine.handle(command("music.refresh", { confirm: true }))).error.code).toBe("MUSIC_QUOTA_EXHAUSTED");
    expect(mock?.requests).toEqual([]);
    expect((await statusOf(engine)).sentLast31d).toBe(30);
  });

  test("a second refresh while one runs is IN_FLIGHT", async () => {
    const { engine } = await start();
    mock?.script({ delayMs: 150 });
    ok(await engine.handle(command("music.refresh", { confirm: true })));
    expect(failed(await engine.handle(command("music.refresh", { confirm: true }))).error.code).toBe("IN_FLIGHT");
    await engine.musicSettled();
    expect(mock?.requests).toHaveLength(1);
  });
});

describe("a 401", () => {
  test("marks the music key rejected in the settings and announces it, and the refresh ends failed with MUSIC_KEY_REJECTED", async () => {
    const { engine, events } = await start({ mockKey: ROTATED });
    await refreshed(engine);
    const status = await statusOf(engine);
    expect(status.refresh).toMatchObject({ state: "failed", error: { code: "MUSIC_KEY_REJECTED" } });
    const settings = ok(await engine.handle(command("settings.get")));
    expect(settings).toMatchObject({ result: { musicKey: { stored: true, last4: "0000", rejected: true } } });
    expect(events().some((e) => e.type === "settings.changed" && e.payload.settings.musicKey.rejected)).toBe(true);
  });

  test("a refresh is then refused without a request", async () => {
    const { engine } = await start({ mockKey: ROTATED });
    await refreshed(engine);
    expect(failed(await engine.handle(command("music.refresh", { confirm: true }))).error.code).toBe("MUSIC_KEY_REJECTED");
    expect(mock?.requests).toHaveLength(1);
  });

  test("survives a restart: the key handed over again at start reads as rejected, with no request and no stored key", async () => {
    const first = await start({ mockKey: ROTATED });
    await refreshed(first.engine);
    const second = await start({ mockKey: ROTATED, origin: "start" });
    expect(ok(await second.engine.handle(command("settings.get"))).result).toMatchObject({ musicKey: { stored: true, last4: "0000", rejected: true } });
    expect(failed(await second.engine.handle(command("music.refresh", { confirm: true }))).error.code).toBe("MUSIC_KEY_REJECTED");
    expect(mock?.requests).toEqual([]);
  });

  test("a key stored by the owner after the rejection is not rejected, and a restart keeps it so", async () => {
    const first = await start({ mockKey: ROTATED });
    await refreshed(first.engine);
    await first.engine.applyControl({ kind: "control", type: "musicKey.set", key: MUSIC, origin: "user" });
    const restarted = await start({ mockKey: ROTATED, origin: "start" });
    expect((ok(await restarted.engine.handle(command("settings.get"))).result as { musicKey: { rejected: boolean } }).musicKey.rejected).toBe(false);
  });

  test("the same key stored again by the owner is tried again", async () => {
    const first = await start({ mockKey: ROTATED });
    await refreshed(first.engine);
    await first.engine.applyControl({ kind: "control", type: "musicKey.set", key: MUSIC, origin: "user" });
    expect((ok(await first.engine.handle(command("settings.get"))).result as { musicKey: { rejected: boolean } }).musicKey.rejected).toBe(false);
    ok(await first.engine.handle(command("music.refresh", { confirm: true })));
    await first.engine.musicSettled();
    expect(mock?.requests).toHaveLength(2);
  });

  test("clearing the key forgets the rejection: the next key, stored later, starts clean", async () => {
    const first = await start({ mockKey: ROTATED });
    await refreshed(first.engine);
    await first.engine.applyControl({ kind: "control", type: "musicKey.clear" });
    await first.engine.applyControl({ kind: "control", type: "musicKey.set", key: MUSIC, origin: "start" });
    expect((ok(await first.engine.handle(command("settings.get"))).result as { musicKey: { rejected: boolean } }).musicKey.rejected).toBe(false);
  });
});

describe("the key never leaves the engine's memory and the header", () => {
  test("nothing posted, logged or written holds the key or a fragment of it, in any form", async () => {
    const output = captureConsole();
    try {
      const { engine, posted } = await start({ mockKey: ROTATED });
      await refreshed(engine);
      await engine.applyControl({ kind: "control", type: "musicKey.set", key: MUSIC, origin: "user" });
      await engine.applyControl({ kind: "control", type: "musicKey.clear" });
      expectNoKeyFragment(JSON.stringify(posted), MUSIC);
      expectNoKeyFragment(output.text(), MUSIC);
      const files = (await readdir(dir(), { recursive: true, withFileTypes: true })).filter((e) => e.isFile());
      for (const file of files) {
        const bytes = await readFile(join(file.parentPath, file.name));
        for (const form of fragmentForms(MUSIC)) expect(bytes.includes(form.bytes)).toBe(false);
      }
    } finally {
      output.restore();
    }
  });
});

describe("shutdown", () => {
  test("aborts a request in flight and does not hang", async () => {
    const { engine } = await start();
    mock?.script({ delayMs: 3000 });
    ok(await engine.handle(command("music.refresh", { confirm: true })));
    const started = performance.now();
    await engine.shutdown(500);
    expect(performance.now() - started).toBeLessThan(2500);
  });
});

describe("resolveMusicBaseUrl", () => {
  test("a build without the E2E flag always uses the real base, whatever main asked for", () => {
    expect(resolveMusicBaseUrl("http://127.0.0.1:9999", false)).toBe(FLASHAPI_BASE);
    expect(resolveMusicBaseUrl(undefined, false)).toBe(FLASHAPI_BASE);
  });

  test("an E2E build takes the requested mock", () => {
    expect(resolveMusicBaseUrl("http://127.0.0.1:9999", true)).toBe("http://127.0.0.1:9999");
  });

  test("an E2E build with no mock asked for never reaches flashapi: the base goes to a loopback port nothing listens on", () => {
    const base = resolveMusicBaseUrl(undefined, true);
    expect(base).toBe("http://127.0.0.1:1");
    expect(base).not.toBe(FLASHAPI_BASE);
    expect(new URL(base).hostname).toBe("127.0.0.1");
  });
});
