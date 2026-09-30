import { afterEach, describe, expect, test } from "bun:test";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { startMockFlashapi, type MockFlashapi } from "../scripts/mockFlashapi";
import { MusicListResult, MusicPeaksResult, MusicStatus } from "../shared/engine";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { nativeFetch, useNativeHttp } from "../testing/nativeHttp";
import { FLASHAPI_BASE, type FlashapiFetch } from "./music/client";
import { excerptOf, fakeCdn, JPEG_1X1, listTracks, type FakeCdn } from "./music/testing/storeKit";
import { TrackStore } from "./music/trackStore";
import { NOW, command, failed, ok, startEngine, useEngineDir } from "./testing/engineHarness";
useNativeGlobals();
useNativeHttp();

// 3c.4 in the engine: with the track store as the sink, music.refresh downloads the list's tracks and covers, and
// music.list, music.status and music.peaks read what is on disk. The real flashapi and the real CDN are never
// contacted: the flashapi is the loopback mock, and the CDN is an in-memory fake behind the store's transport.

const dir = useEngineDir("studio-engine-music-store-");
const MUSIC = "Zq7-vKt9-Wm2x-Lp4s-0000";

let mock: MockFlashapi | null = null;
afterEach(async () => {
  await mock?.stop();
  mock = null;
});

const musicDir = () => join(dir(), "userData", "music");

function viaMock(): FlashapiFetch {
  return (url, init) => {
    if (mock === null) throw new Error("no mock");
    return nativeFetch(url.replace(FLASHAPI_BASE, mock.url), init);
  };
}

async function start(options: { serve?: boolean; decodeMs?: number } = {}) {
  mock = startMockFlashapi({ key: MUSIC });
  const cdn: FakeCdn = fakeCdn();
  const tracks = listTracks(30);
  if (options.serve !== false) {
    tracks.forEach((track, index) => {
      cdn.serve(track.downloadUrl, { bytes: excerptOf(index) });
      if (track.coverUrl !== null) cdn.serve(track.coverUrl, { bytes: JPEG_1X1 });
    });
  }
  const store = await TrackStore.open({
    dir: musicDir(),
    transport: cdn.transport,
    clock: () => NOW,
    log: () => undefined,
    decode: async (o) => ({ decodedMs: o.expectedMs, peaks: Array.from({ length: 160 }, (_, i) => (i * 7) % 1001) }),
  });
  const started = await startEngine(dir(), { key: null, init: { musicDir: musicDir() }, deps: { musicFetch: viaMock(), musicSink: store } });
  await started.engine.applyControl({ kind: "control", type: "musicKey.set", key: MUSIC, origin: "user" });
  return { ...started, cdn, store, tracks };
}

type Started = Awaited<ReturnType<typeof start>>;

async function refreshed(engine: Started["engine"]) {
  const response = ok(await engine.handle(command("music.refresh", { confirm: true })));
  await engine.settled();
  await engine.musicSettled();
  return response;
}

async function listOf(engine: Started["engine"]) {
  const response = ok(await engine.handle(command("music.list")));
  if (response.type !== "music.list") throw new Error("wrong type");
  return response.result;
}

async function statusOf(engine: Started["engine"]) {
  const response = ok(await engine.handle(command("music.status")));
  if (response.type !== "music.status") throw new Error("wrong type");
  return response.result;
}

describe("music.list", () => {
  test("of an engine that never refreshed is empty", async () => {
    const { engine } = await start();
    expect(await listOf(engine)).toEqual({ tracks: [] });
  });

  test("after a refresh holds the 30 tracks of the list, each a valid summary, in the API's order", async () => {
    const { engine, tracks } = await start();
    await refreshed(engine);
    const list = await listOf(engine);
    expect(MusicListResult.safeParse(list).success).toBe(true);
    expect(list.tracks.map((t) => t.trackId)).toEqual(tracks.map((t) => t.trackId));
  });

  test("keeps explicit per track and offers highlights sorted with a 1500 last", async () => {
    const { engine } = await start();
    await refreshed(engine);
    const { tracks } = await listOf(engine);
    expect(tracks.some((t) => t.explicit)).toBe(true);
    for (const track of tracks) {
      const rest = track.highlights.filter((h) => !h.likelyDefault).map((h) => h.ms);
      expect(rest).toEqual([...rest].sort((a, b) => a - b));
      const flagged = track.highlights.filter((h) => h.likelyDefault);
      if (flagged.length > 0) expect(track.highlights.at(-1)).toEqual({ ms: 1500, likelyDefault: true });
    }
  });

  test("answers nothing that could reach a file: no URL, no path, no hash", async () => {
    const { engine } = await start();
    await refreshed(engine);
    expect(JSON.stringify(await listOf(engine))).not.toMatch(/https?:|oh=|oe=|\.m4a|[0-9a-f]{64}|userData/);
  });

  test("takes an empty payload only", async () => {
    const { engine } = await start();
    expect(failed(await engine.handle(command("music.list", { limit: 3 }))).error.code).toBe("VALIDATION");
  });
});

describe("music.refresh with the track store", () => {
  test("is no longer refused as not available yet: it downloads every track and cover, and ends idle", async () => {
    const { engine, cdn } = await start();
    await refreshed(engine);
    expect((await statusOf(engine)).refresh).toEqual({ state: "idle" });
    expect(cdn.requested.length).toBe(60);
    const files = await readdir(join(musicDir(), "tracks"));
    expect(files.filter((f) => f.endsWith(".m4a"))).toHaveLength(30);
  });

  test("the status reports the real count, bytes and list time", async () => {
    const { engine } = await start();
    await refreshed(engine);
    const status = await statusOf(engine);
    expect(MusicStatus.safeParse(status).success).toBe(true);
    let onDisk = 0;
    for (const folder of ["tracks", "covers"]) for (const name of await readdir(join(musicDir(), folder))) onDisk += (await stat(join(musicDir(), folder, name))).size;
    expect(status).toMatchObject({ trackCount: 30, bytesOnDisk: onDisk, listFetchedAt: new Date(NOW).toISOString(), sentLast31d: 1 });
  });

  test("announces progress through music.changed: running from the list itself, then one step per download, to the end", async () => {
    const { engine, events } = await start();
    await refreshed(engine);
    const running = events()
      .filter((e) => e.type === "music.changed")
      .map((e) => e.payload.status.refresh)
      .filter((r) => r.state === "running");
    expect(running[0]).toEqual({ state: "running", done: 0, total: 1 });
    expect(running[1]).toEqual({ state: "running", done: 1, total: 61 });
    expect(running.at(-1)).toEqual({ state: "running", done: 61, total: 61 });
    for (let i = 1; i < running.length; i++) {
      const before = running[i - 1];
      const after = running[i];
      if (before?.state === "running" && after?.state === "running") expect(after.done).toBeGreaterThanOrEqual(before.done);
    }
    expect(events().filter((e) => e.type === "music.changed").at(-1)?.payload.status.refresh).toEqual({ state: "idle" });
  });

  test("when no download works the refresh ends failed, the request stays counted, and the list is still on disk", async () => {
    const { engine } = await start({ serve: false });
    await refreshed(engine);
    const status = await statusOf(engine);
    expect(status.refresh).toMatchObject({ state: "failed", error: { code: "MUSIC_UNAVAILABLE" } });
    expect(status.sentLast31d).toBe(1);
    expect(JSON.stringify(status.refresh)).not.toMatch(/https?:|oh=|oe=/);
    expect((await listOf(engine)).tracks).toEqual([]);
    expect(JSON.parse(await readFile(join(musicDir(), "lists", "current.json"), "utf8")).tracks).toHaveLength(30);
  });

  test("a restarted engine over the same folder lists the same tracks with no request", async () => {
    const first = await start();
    await refreshed(first.engine);
    const before = await listOf(first.engine);
    await mock?.stop();
    const cdn = fakeCdn();
    const store = await TrackStore.open({ dir: musicDir(), transport: cdn.transport, clock: () => NOW, log: () => undefined });
    const second = await startEngine(dir(), { key: null, init: { musicDir: musicDir() }, deps: { musicSink: store } });
    expect(await listOf(second.engine)).toEqual(before);
    expect((await statusOf(second.engine)).trackCount).toBe(30);
    expect(cdn.requested).toEqual([]);
  });
});

describe("music.peaks", () => {
  const peaksCommand = (trackId: string, extra: Record<string, unknown> = {}) =>
    command("music.peaks", { track: { source: "trending", trackId }, startMs: 0, durationMs: 8_000, bars: 72, ...extra });

  test("answers a window of a stored track: one integer from 0 to 1000 per bar", async () => {
    const { engine, tracks } = await start();
    await refreshed(engine);
    const response = ok(await engine.handle(peaksCommand(tracks[0]?.trackId ?? "")));
    if (response.type !== "music.peaks") throw new Error("wrong type");
    expect(MusicPeaksResult.safeParse(response.result).success).toBe(true);
    expect(response.result.peaks).toHaveLength(72);
    expect(Math.max(...response.result.peaks)).toBeGreaterThan(0);
  });

  test("the whole track in 68 bars and a 15 s window in 72 both work: one command serves the picker and the timeline", async () => {
    const { engine, tracks } = await start();
    await refreshed(engine);
    const id = tracks[0]?.trackId ?? "";
    for (const [durationMs, bars] of [
      [8_000, 68],
      [15_000, 72],
    ] as const) {
      const response = ok(await engine.handle(peaksCommand(id, { durationMs, bars })));
      if (response.type !== "music.peaks") throw new Error("wrong type");
      expect(response.result.peaks).toHaveLength(bars);
    }
  });

  test("a track that is not stored is NOT_FOUND", async () => {
    const { engine } = await start();
    await refreshed(engine);
    expect(failed(await engine.handle(peaksCommand("9999999999999999"))).error.code).toBe("NOT_FOUND");
  });

  test("an own track is NOT_FOUND until own music exists (3f)", async () => {
    const { engine } = await start();
    const own = command("music.peaks", { track: { source: "own", mediaId: "media-00000001" }, startMs: 0, durationMs: 1000, bars: 16 });
    const response = failed(await engine.handle(own));
    expect(response.error.code).toBe("NOT_FOUND");
    expect(response.error.detail).toContain("own");
  });

  test.each([
    ["an id that could be a path", { track: { source: "trending", trackId: "../../etc/passwd" } }],
    ["15 bars", { bars: 15 }],
    ["a zero window", { durationMs: 0 }],
  ])("%s is refused by the contract, before any file is looked at", async (_label, patch) => {
    const { engine } = await start();
    expect(failed(await engine.handle(peaksCommand("4199287736976977", patch))).error.code).toBe("VALIDATION");
  });
});
