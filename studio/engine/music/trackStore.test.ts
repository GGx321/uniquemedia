import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { TrackSummary } from "../../shared/engine";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { CdnBlockedError } from "./cdnTransport";
import { DecodeError, type DecodeOptions, type DecodeResult } from "./decodeCheck";
import type { MusicTrack } from "./listSchema";
import { ListRecordSchema, type ListRecord } from "./trackRecord";
import { TrackStore, type TrackStoreDeps } from "./trackStore";
import { EXCERPTS, excerptOf, fakeCdn, JPEG_1X1, listTracks, PNG_1X1_BYTES, sha256Hex, WEBP_1X1, type FakeCdn } from "./testing/storeKit";
useNativeGlobals();

// 3c.4, the track store: the list is on disk BEFORE any download; every track and cover is downloaded at refresh time
// under invariant 31; a track is stored only after the walker and the decode; nothing partial is ever visible; a failed
// track does not poison the list; no signed URL survives the downloads.

const FETCHED = Date.parse("2026-09-27T20:42:44.190Z");
const NOW = FETCHED + 1000;
const HOUR = 3600 * 1000;

let root = "";
let musicDir = "";
let now = NOW;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "studio-track-store-"));
  musicDir = join(root, "music");
  now = NOW;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Every file under the music folder, relative, sorted. */
async function tree(dir = musicDir): Promise<string[]> {
  const out: string[] = [];
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path);
      else out.push(relative(dir, path).split("\\").join("/"));
    }
  };
  await walk(dir);
  return out.sort();
}

const readRecord = async (): Promise<ListRecord> => ListRecordSchema.parse(JSON.parse(await readFile(join(musicDir, "lists", "current.json"), "utf8")));

/** A decode that proves whatever length was claimed, fast: for tests that are not about the decode. */
const fastDecode = async (options: DecodeOptions): Promise<DecodeResult> => ({ decodedMs: options.expectedMs, peaks: [100, 200, 300] });

interface Harness {
  store: TrackStore;
  cdn: FakeCdn;
  logs: string[];
  progress: [number, number][];
}

async function harness(options: { cdn?: FakeCdn; decode?: TrackStoreDeps["decode"]; log?: (line: string) => void } = {}): Promise<Harness> {
  const cdn = options.cdn ?? fakeCdn();
  const logs: string[] = [];
  const store = await TrackStore.open({
    dir: musicDir,
    transport: cdn.transport,
    clock: () => now,
    log: (line) => (logs.push(line), options.log?.(line)),
    ...(options.decode === undefined ? {} : { decode: options.decode }),
  });
  return { store, cdn, logs, progress: [] };
}

/** Serves every track of `tracks` from an excerpt and every cover as a JPEG. */
function serveAll(cdn: FakeCdn, tracks: readonly MusicTrack[]): void {
  tracks.forEach((track, index) => {
    cdn.serve(track.downloadUrl, { bytes: excerptOf(index) });
    if (track.coverUrl !== null) cdn.serve(track.coverUrl, { bytes: JPEG_1X1 });
  });
}

const signal = () => new AbortController().signal;

async function refresh(h: Harness, tracks: readonly MusicTrack[], controller: AbortSignal = signal()): Promise<void> {
  await h.store.accept({ fetchedAt: FETCHED, tracks }, (done, total) => void h.progress.push([done, total]), controller);
}

describe("a refresh that goes through", () => {
  test("stores every track at tracks/<id>.m4a byte for byte, with its sha256 and size in the record", async () => {
    const h = await harness();
    const tracks = listTracks(4);
    serveAll(h.cdn, tracks);
    await refresh(h, tracks);
    const record = await readRecord();
    expect(record.complete).toBe(true);
    for (const [index, track] of tracks.entries()) {
      const file = await readFile(join(musicDir, "tracks", `${track.trackId}.m4a`));
      expect(Buffer.from(file).equals(Buffer.from(excerptOf(index)))).toBe(true);
      const entry = record.tracks.find((candidate) => candidate.trackId === track.trackId);
      expect(entry?.audio).toMatchObject({ state: "stored", bytes: excerptOf(index).byteLength, sha256: sha256Hex(excerptOf(index)) });
    }
  });

  test("the record says what the walker and the decode read: the object type, the rate, the channels, the proven length", async () => {
    const h = await harness();
    const tracks = listTracks(1);
    serveAll(h.cdn, tracks);
    await refresh(h, tracks);
    const audio = (await readRecord()).tracks[0]?.audio;
    expect(audio).toMatchObject({ state: "stored", channels: 2, sampleRate: EXCERPTS[0].sampleRate });
    expect(audio?.state === "stored" && Math.abs(audio.decodedMs - EXCERPTS[0].durationMs)).toBeLessThanOrEqual(100);
  });

  test("stores each cover at covers/<id>.<ext>, the extension from the bytes and never from the URL or the content type", async () => {
    const h = await harness({ decode: fastDecode });
    const tracks = listTracks(3);
    serveAll(h.cdn, tracks);
    h.cdn.serve(tracks[0]?.coverUrl ?? "", { bytes: JPEG_1X1, headers: { "content-type": "image/svg+xml" } });
    h.cdn.serve(tracks[1]?.coverUrl ?? "", { bytes: PNG_1X1_BYTES, headers: { "content-type": "image/jpeg" } });
    h.cdn.serve(tracks[2]?.coverUrl ?? "", { bytes: WEBP_1X1 });
    await refresh(h, tracks);
    const files = await tree();
    expect(files).toContain(`covers/${tracks[0]?.trackId}.jpg`);
    expect(files).toContain(`covers/${tracks[1]?.trackId}.png`);
    expect(files).toContain(`covers/${tracks[2]?.trackId}.webp`);
    expect((await readRecord()).tracks.map((t) => (t.cover.state === "stored" ? t.cover.ext : "-"))).toEqual(["jpg", "png", "webp"]);
  });

  test("requests the FULL track URL and the cover URL of each item, and nothing else", async () => {
    const h = await harness({ decode: fastDecode });
    const tracks = listTracks(3);
    serveAll(h.cdn, tracks);
    await refresh(h, tracks);
    const allowed = new Set(tracks.flatMap((t) => [t.downloadUrl, t.coverUrl ?? ""]));
    expect(h.cdn.requested.length).toBe(6);
    for (const href of h.cdn.requested) expect(allowed.has(href)).toBe(true);
  });

  test("downloads the tracks one at a time, in list order, each track's cover after its audio", async () => {
    const h = await harness({ decode: fastDecode });
    const tracks = listTracks(2);
    serveAll(h.cdn, tracks);
    await refresh(h, tracks);
    expect(h.cdn.requested).toEqual([tracks[0]?.downloadUrl, tracks[0]?.coverUrl, tracks[1]?.downloadUrl, tracks[1]?.coverUrl].map((href) => href ?? ""));
  });

  test("the record keeps no signed URL, no `oh=` or `oe=` and no dash manifest once the downloads are done", async () => {
    const h = await harness({ decode: fastDecode });
    const tracks = listTracks(3);
    serveAll(h.cdn, tracks);
    await refresh(h, tracks);
    const text = await readFile(join(musicDir, "lists", "current.json"), "utf8");
    expect(text).not.toMatch(/https?:|oh=|oe=|_nc_|dash|manifest|cdninstagram|fbcdn/i);
  });

  test("nothing but the list, the tracks, the covers and the waveforms is left on disk: no temp file", async () => {
    const h = await harness({ decode: fastDecode });
    const tracks = listTracks(2);
    serveAll(h.cdn, tracks);
    await refresh(h, tracks);
    const files = await tree();
    expect(files.every((file) => /^(lists\/current\.json|tracks\/[a-z0-9-]+\.m4a|covers\/[a-z0-9-]+\.(jpg|png|webp)|peaks\/[a-z0-9-]+\.json)$/.test(file))).toBe(true);
    expect(files).toHaveLength(1 + 2 + 2 + 2);
  });

  test("progress starts at the list itself (1 of 1 + tracks + covers), rises one step per download, and ends complete", async () => {
    const h = await harness({ decode: fastDecode });
    const tracks = listTracks(3);
    serveAll(h.cdn, tracks);
    await refresh(h, tracks);
    expect(h.progress[0]).toEqual([1, 7]);
    expect(h.progress.at(-1)).toEqual([7, 7]);
    for (let i = 1; i < h.progress.length; i++) {
      expect(h.progress[i]?.[0]).toBeGreaterThanOrEqual(h.progress[i - 1]?.[0] ?? 0);
      expect(h.progress[i]?.[1]).toBe(7);
    }
  });

  test("a track with no cover URL has no cover download and is counted once", async () => {
    const h = await harness({ decode: fastDecode });
    const tracks = listTracks(2).map((t, i) => (i === 0 ? { ...t, coverUrl: null } : t));
    serveAll(h.cdn, tracks);
    await refresh(h, tracks);
    expect(h.progress[0]).toEqual([1, 4]);
    expect((await readRecord()).tracks[0]?.cover).toEqual({ state: "none" });
  });
});

describe("the list is on disk before any download starts", () => {
  test("when the first request arrives the record is there, incomplete, with every track pending and its signed URL", async () => {
    const h = await harness({ decode: fastDecode });
    const tracks = listTracks(3);
    serveAll(h.cdn, tracks);
    let atFirstRequest: ListRecord | null = null;
    h.cdn.onRequest = async () => {
      atFirstRequest ??= await readRecord();
    };
    await refresh(h, tracks);
    expect(atFirstRequest).not.toBeNull();
    const seen = atFirstRequest as unknown as ListRecord;
    expect(seen.complete).toBe(false);
    expect(seen.fetchedAt).toBe(FETCHED);
    expect(seen.tracks.map((t) => t.trackId)).toEqual(tracks.map((t) => t.trackId));
    for (const [index, entry] of seen.tracks.entries()) {
      expect(entry.audio).toMatchObject({ state: "pending", url: tracks[index]?.downloadUrl });
    }
  });

  test("a list that cannot be written stops the refresh before ONE request is made", async () => {
    // The music folder is a file: nothing can be created in it.
    await writeFile(musicDir, "not a folder");
    const h = await harness({ decode: fastDecode });
    const tracks = listTracks(2);
    serveAll(h.cdn, tracks);
    await expect(refresh(h, tracks)).rejects.toBeDefined();
    expect(h.cdn.requested).toEqual([]);
  });

  test("the record on disk is written whole or not at all: it always parses as a record", async () => {
    const h = await harness({ decode: fastDecode });
    const tracks = listTracks(3);
    serveAll(h.cdn, tracks);
    const seen: boolean[] = [];
    h.cdn.onRequest = async () => {
      seen.push(ListRecordSchema.safeParse(JSON.parse(await readFile(join(musicDir, "lists", "current.json"), "utf8"))).success);
    };
    await refresh(h, tracks);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
  });
});

describe("when a signed URL expires", () => {
  const withUrl = (track: MusicTrack, query: string): MusicTrack => ({ ...track, downloadUrl: `${track.downloadUrl.split("?")[0]}?${query}`, coverUrl: null });
  const oeHex = (at: number): string => Math.floor(at / 1000).toString(16).toUpperCase();

  async function pendingExpiry(track: MusicTrack): Promise<number> {
    const h = await harness({ decode: fastDecode });
    h.cdn.serve(track.downloadUrl, { bytes: excerptOf(0) });
    let expiresAt = -1;
    h.cdn.onRequest = async () => {
      const audio = (await readRecord()).tracks[0]?.audio;
      if (audio?.state === "pending") expiresAt = audio.expiresAt;
    };
    await refresh(h, [track]);
    return expiresAt;
  }

  test("the pending entry carries the URL's own oe when it is inside the 104 hour ceiling", async () => {
    const at = FETCHED + 100 * HOUR;
    expect(await pendingExpiry(withUrl(listTracks(1)[0] as MusicTrack, `oh=x&oe=${oeHex(at)}`))).toBe(Math.floor(at / 1000) * 1000);
  });

  test("is capped at 104 hours after the response", async () => {
    expect(await pendingExpiry(withUrl(listTracks(1)[0] as MusicTrack, `oh=x&oe=${oeHex(FETCHED + 300 * HOUR)}`))).toBe(FETCHED + 104 * HOUR);
  });

  test("a missing oe counts as 24 hours", async () => {
    expect(await pendingExpiry(withUrl(listTracks(1)[0] as MusicTrack, "oh=x"))).toBe(FETCHED + 24 * HOUR);
  });

  test("a garbled oe counts as 24 hours", async () => {
    expect(await pendingExpiry(withUrl(listTracks(1)[0] as MusicTrack, "oh=x&oe=nothex"))).toBe(FETCHED + 24 * HOUR);
  });

  test("a URL past its expiry is never requested: the track fails as expired and the others go on", async () => {
    const h = await harness({ decode: fastDecode });
    const [first, second] = listTracks(2) as [MusicTrack, MusicTrack];
    const stale = withUrl(first, `oh=x&oe=${oeHex(FETCHED + 2 * HOUR)}`);
    now = FETCHED + 3 * HOUR;
    h.cdn.serve(stale.downloadUrl, { bytes: excerptOf(0) });
    h.cdn.serve(second.downloadUrl, { bytes: excerptOf(1) });
    await refresh(h, [stale, { ...second, coverUrl: null }]);
    expect(h.cdn.requested).toEqual([second.downloadUrl]);
    const entries = (await readRecord()).tracks;
    expect(entries[0]?.audio).toEqual({ state: "failed", reason: "expired" });
    expect(entries[1]?.audio.state).toBe("stored");
  });
});

describe("a track that is refused or fails does not poison the list", () => {
  test("a 404 on one track: the others are stored, that one is failed with a reason, and the refresh still succeeds", async () => {
    const h = await harness({ decode: fastDecode });
    const tracks = listTracks(4);
    serveAll(h.cdn, tracks);
    h.cdn.serve(tracks[1]?.downloadUrl ?? "", { status: 404 });
    await refresh(h, tracks);
    const states = (await readRecord()).tracks.map((t) => t.audio.state);
    expect(states).toEqual(["stored", "failed", "stored", "stored"]);
    expect(h.store.list().map((t) => t.trackId)).toEqual([tracks[0], tracks[2], tracks[3]].map((t) => t?.trackId));
    expect(h.store.summary().trackCount).toBe(3);
  });

  test("the failed track's reason names the kind and nothing from the network", async () => {
    const h = await harness({ decode: fastDecode });
    const tracks = listTracks(1);
    serveAll(h.cdn, tracks);
    h.cdn.serve(tracks[0]?.downloadUrl ?? "", { status: 403 });
    await refresh(h, tracks).catch(() => undefined);
    const audio = (await readRecord()).tracks[0]?.audio;
    expect(audio).toMatchObject({ state: "failed" });
    expect(audio?.state === "failed" && audio.reason).toMatch(/^[a-z0-9:_-]+$/);
  });

  test("when every track fails the refresh fails, saying so without a URL, and the record still holds the list", async () => {
    const h = await harness({ decode: fastDecode });
    const tracks = listTracks(3);
    // Nothing is served: every download is a 404.
    const error = await refresh(h, tracks).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error).not.toBeNull();
    expect(error?.message).not.toMatch(/https?:|oh=|oe=/);
    expect((await readRecord()).tracks).toHaveLength(3);
    expect(h.store.summary().trackCount).toBe(0);
  });

  test("a cover that fails does not fail its track", async () => {
    const h = await harness({ decode: fastDecode });
    const tracks = listTracks(2);
    serveAll(h.cdn, tracks);
    h.cdn.serve(tracks[0]?.coverUrl ?? "", { status: 500 });
    await refresh(h, tracks);
    const entries = (await readRecord()).tracks;
    expect(entries[0]?.audio.state).toBe("stored");
    expect(entries[0]?.cover.state).toBe("failed");
    expect(h.store.list()[0]?.hasCover).toBe(false);
    expect(h.store.list()[1]?.hasCover).toBe(true);
  });

  test("a cover that is not an image (SVG, HTML, a track) is refused and nothing is written for it", async () => {
    const h = await harness({ decode: fastDecode });
    const tracks = listTracks(3);
    serveAll(h.cdn, tracks);
    h.cdn.serve(tracks[0]?.coverUrl ?? "", { bytes: new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"), headers: { "content-type": "image/png" } });
    h.cdn.serve(tracks[1]?.coverUrl ?? "", { bytes: new TextEncoder().encode("<html>hi</html>") });
    h.cdn.serve(tracks[2]?.coverUrl ?? "", { bytes: excerptOf(0) });
    await refresh(h, tracks);
    expect((await tree()).filter((f) => f.startsWith("covers/"))).toEqual([]);
    expect((await readRecord()).tracks.every((t) => t.cover.state === "failed")).toBe(true);
  });

  test("a cover over 2 MB is refused", async () => {
    const h = await harness({ decode: fastDecode });
    const tracks = listTracks(1);
    serveAll(h.cdn, tracks);
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    big.set(PNG_1X1_BYTES);
    h.cdn.serve(tracks[0]?.coverUrl ?? "", { bytes: big });
    await refresh(h, tracks);
    expect((await readRecord()).tracks[0]?.cover.state).toBe("failed");
    expect((await tree()).filter((f) => f.startsWith("covers/"))).toEqual([]);
  });

  test("a cover of exactly 2 MB is kept", async () => {
    const h = await harness({ decode: fastDecode });
    const tracks = listTracks(1);
    serveAll(h.cdn, tracks);
    const exact = new Uint8Array(2 * 1024 * 1024);
    exact.set(PNG_1X1_BYTES);
    h.cdn.serve(tracks[0]?.coverUrl ?? "", { bytes: exact });
    await refresh(h, tracks);
    expect((await readRecord()).tracks[0]?.cover.state).toBe("stored");
  });
});

describe("a track is stored only after the walker and the decode", () => {
  test.each([
    ["an MP3", new TextEncoder().encode("ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000".padEnd(4096, "\u00ff"))],
    ["a PNG", PNG_1X1_BYTES],
    ["an HTML page", new TextEncoder().encode("<html>login</html>")],
    ["zeros", new Uint8Array(4096)],
  ])("%s is refused by the walker: no file, and the decode is never started", async (_label, bytes) => {
    let decoded = 0;
    const h = await harness({ decode: async (o) => (decoded++, fastDecode(o)) });
    const tracks = listTracks(1);
    h.cdn.serve(tracks[0]?.downloadUrl ?? "", { bytes });
    await refresh(h, tracks).catch(() => undefined);
    expect(decoded).toBe(0);
    expect((await tree()).filter((f) => f.startsWith("tracks/") || f.startsWith("peaks/"))).toEqual([]);
    expect((await readRecord()).tracks[0]?.audio).toMatchObject({ state: "failed", reason: expect.stringMatching(/^probe:/) });
  });

  test("a container that walks clean but does not decode is refused: no file, no temp", async () => {
    const h = await harness({
      decode: async () => {
        throw new DecodeError("exit", "ffmpeg exited with code 1");
      },
    });
    const tracks = listTracks(1);
    serveAll(h.cdn, tracks);
    await refresh(h, tracks).catch(() => undefined);
    expect((await tree()).filter((f) => f.startsWith("tracks/") || f.startsWith("peaks/"))).toEqual([]);
    expect((await readRecord()).tracks[0]?.audio).toEqual({ state: "failed", reason: "decode:exit" });
  });

  test("audio of the wrong length is refused by the real decode", async () => {
    const h = await harness();
    const [track] = listTracks(1) as [MusicTrack];
    h.cdn.serve(track.downloadUrl, { bytes: excerptOf(0) });
    await refresh(h, [{ ...track, durationMs: 200_000, coverUrl: null }]).catch(() => undefined);
    expect((await readRecord()).tracks[0]?.audio).toEqual({ state: "failed", reason: "decode:duration-mismatch" });
    expect(await tree()).toEqual(["lists/current.json"]);
  });

  test("a container with a video stream is refused by the walker", async () => {
    const { buildM4a } = await import("./testing/m4aBuilder");
    const h = await harness({ decode: fastDecode });
    const tracks = listTracks(1);
    h.cdn.serve(tracks[0]?.downloadUrl ?? "", { bytes: buildM4a({ extraTracks: ["vide"] }) });
    await refresh(h, tracks).catch(() => undefined);
    expect((await readRecord()).tracks[0]?.audio).toEqual({ state: "failed", reason: "probe:several-tracks" });
  });

  test("a track over 25 MB is refused by its size: nothing is written", async () => {
    const h = await harness({ decode: fastDecode });
    const tracks = listTracks(1);
    h.cdn.serve(tracks[0]?.downloadUrl ?? "", { bytes: new Uint8Array(25 * 1024 * 1024 + 1) });
    await refresh(h, tracks).catch(() => undefined);
    expect((await readRecord()).tracks[0]?.audio).toEqual({ state: "failed", reason: "too-large" });
    expect(await tree()).toEqual(["lists/current.json"]);
  });

  test("a streamed track that grows past 25 MB with no Content-Length is cut", async () => {
    const h = await harness({ decode: fastDecode });
    const tracks = listTracks(1);
    let sent = 0;
    h.cdn.serve(tracks[0]?.downloadUrl ?? "", {
      body: (async function* () {
        for (;;) {
          sent += 1024 * 1024;
          yield new Uint8Array(1024 * 1024);
        }
      })(),
    });
    await refresh(h, tracks).catch(() => undefined);
    expect(sent).toBeLessThanOrEqual(27 * 1024 * 1024);
    expect((await readRecord()).tracks[0]?.audio).toEqual({ state: "failed", reason: "too-large" });
  });
});

describe("a partial file is never visible", () => {
  test("while the decode runs the track is only a dot-prefixed .tmp file: the served name does not exist yet", async () => {
    const seen: { final: boolean; temp: string; tempExists: boolean }[] = [];
    const h = await harness({
      decode: async (options) => {
        const name = options.path.split(/[\\/]/).at(-1) ?? "";
        seen.push({ final: existsSync(join(musicDir, "tracks", `${listTracks(1)[0]?.trackId}.m4a`)), temp: name, tempExists: existsSync(options.path) });
        return fastDecode(options);
      },
    });
    const tracks = listTracks(1);
    serveAll(h.cdn, tracks);
    await refresh(h, tracks);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.final).toBe(false);
    expect(seen[0]?.tempExists).toBe(true);
    expect(seen[0]?.temp).toMatch(/^\..+\.tmp$/);
  });

  test("a failed decode leaves no temp file behind", async () => {
    const h = await harness({
      decode: async () => {
        throw new DecodeError("timeout");
      },
    });
    const tracks = listTracks(2);
    serveAll(h.cdn, tracks);
    await refresh(h, tracks).catch(() => undefined);
    expect((await tree()).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("an abort in the middle of a download leaves nothing at a served name, and the record says what is still to do", async () => {
    const controller = new AbortController();
    const h = await harness({ decode: fastDecode });
    const tracks = listTracks(3);
    serveAll(h.cdn, tracks);
    h.cdn.serve(tracks[1]?.downloadUrl ?? "", {
      body: (async function* () {
        controller.abort();
        await new Promise<void>(() => undefined);
        yield new Uint8Array(1);
      })(),
    });
    await expect(refresh(h, tracks, controller.signal)).rejects.toBeDefined();
    const files = await tree();
    expect(files).toContain(`tracks/${tracks[0]?.trackId}.m4a`);
    expect(files.filter((f) => f.startsWith("tracks/") && !f.endsWith(".m4a"))).toEqual([]);
    expect(files).not.toContain(`tracks/${tracks[1]?.trackId}.m4a`);
    const record = await readRecord();
    expect(record.complete).toBe(false);
    expect(record.tracks.map((t) => t.audio.state)).toEqual(["stored", "pending", "pending"]);
  });

  test("temp files a crash left behind are swept when the store opens", async () => {
    await mkdir(join(musicDir, "tracks"), { recursive: true });
    await mkdir(join(musicDir, "covers"), { recursive: true });
    await writeFile(join(musicDir, "tracks", ".4199287736976977.m4a.abc123.tmp"), "half");
    await writeFile(join(musicDir, "covers", ".4199287736976977.jpg.abc123.tmp"), "half");
    await harness();
    expect(await tree()).toEqual([]);
  });

  test("a temp sweep never touches a served file", async () => {
    await mkdir(join(musicDir, "tracks"), { recursive: true });
    await writeFile(join(musicDir, "tracks", "4199287736976977.m4a"), "kept");
    await harness();
    expect(await tree()).toEqual(["tracks/4199287736976977.m4a"]);
  });
});

describe("invariant 31: sources", () => {
  test("a URL on a foreign host is never requested and never written into the record; the log names the host only", async () => {
    const h = await harness({ decode: fastDecode });
    const tracks = listTracks(2);
    serveAll(h.cdn, tracks);
    const evil = { ...(tracks[0] as MusicTrack), downloadUrl: "https://evil.example/secret/path/track.m4a?oh=SIGNATURE&oe=6ABF5FF1", coverUrl: "https://evil.example/cover.jpg?oh=SIGNATURE" };
    await refresh(h, [evil, tracks[1] as MusicTrack]);
    expect(h.cdn.requested.some((href) => href.includes("evil.example"))).toBe(false);
    const text = await readFile(join(musicDir, "lists", "current.json"), "utf8");
    expect(text).not.toContain("evil.example");
    expect(text).not.toContain("SIGNATURE");
    const logged = h.logs.join("\n");
    expect(logged).toContain("evil.example");
    expect(logged).not.toContain("SIGNATURE");
    expect(logged).not.toContain("secret/path");
    expect((await readRecord()).tracks[0]?.audio).toEqual({ state: "failed", reason: "refused-host" });
  });

  test.each([
    ["http", "http://scontent-fra3-1.cdninstagram.com/x.m4a"],
    ["a suffix host", "https://evilcdninstagram.com/x.m4a"],
    ["another port", "https://scontent-fra3-1.cdninstagram.com:8443/x.m4a"],
    ["an IP literal", "https://169.254.169.254/latest/meta-data"],
    ["localhost", "https://localhost/x.m4a"],
  ])("%s is refused before any request", async (_label, downloadUrl) => {
    const h = await harness({ decode: fastDecode });
    const track = { ...(listTracks(1)[0] as MusicTrack), downloadUrl, coverUrl: null };
    await refresh(h, [track]).catch(() => undefined);
    expect(h.cdn.requested).toEqual([]);
  });

  test("a redirect is not followed, even to another allowed host: one request, a failed track", async () => {
    const h = await harness({ decode: fastDecode });
    const tracks = listTracks(1);
    h.cdn.serve(tracks[0]?.downloadUrl ?? "", { status: 302, headers: { location: "https://scontent-fra3-2.cdninstagram.com/other.m4a" }, bytes: new Uint8Array(0) });
    await refresh(h, tracks).catch(() => undefined);
    expect(h.cdn.requested).toHaveLength(1);
    expect((await readRecord()).tracks[0]?.audio).toEqual({ state: "failed", reason: "redirect" });
  });

  test("a refused address (SSRF) fails that track and is logged by host only", async () => {
    const cdn = fakeCdn();
    const blocked = { ...cdn, transport: () => Promise.reject(new CdnBlockedError("address")) };
    const h = await harness({ cdn: blocked, decode: fastDecode });
    const tracks = listTracks(2);
    await refresh(h, tracks).catch(() => undefined);
    expect((await readRecord()).tracks.map((t) => (t.audio.state === "failed" ? t.audio.reason : t.audio.state))).toEqual(["blocked-address", "blocked-address"]);
    expect(h.logs.join("\n")).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
  });

  test("no log line carries a signed URL, whatever fails", async () => {
    const h = await harness({ decode: fastDecode });
    const tracks = listTracks(3);
    h.cdn.serve(tracks[0]?.downloadUrl ?? "", { status: 500 });
    h.cdn.serve(tracks[1]?.downloadUrl ?? "", { bytes: PNG_1X1_BYTES });
    await refresh(h, tracks).catch(() => undefined);
    expect(h.logs.length).toBeGreaterThan(0);
    expect(h.logs.join("\n")).not.toMatch(/oh=|oe=|_nc_|https?:\/\/|\/v\/t/);
  });
});

describe("no path from the network reaches the filesystem", () => {
  test("an id that is not a safe id is skipped: no request, no file, nothing outside the music folder", async () => {
    const h = await harness({ decode: fastDecode });
    const good = listTracks(1)[0] as MusicTrack;
    const hostile = ["../../evil", "..\\..\\evil", "a/b/c/d/e/f/g/h", "ABCDEFGH1234", "x", "/etc/passwd", "con:1234567"].map((trackId) => ({ ...good, trackId }));
    serveAll(h.cdn, [good]);
    await refresh(h, [good, ...hostile]);
    expect(h.cdn.requested).toEqual([good.downloadUrl, good.coverUrl ?? ""]);
    expect((await tree(root)).every((file) => file.startsWith("music/"))).toBe(true);
    const stored = (await readRecord()).tracks.map((t) => t.trackId);
    expect(stored).toEqual([good.trackId]);
  });

  test("the same id twice is one track: one download and one file", async () => {
    const h = await harness({ decode: fastDecode });
    const [track] = listTracks(1) as [MusicTrack];
    serveAll(h.cdn, [track]);
    await refresh(h, [track, { ...track, title: "A copy" }, track]);
    expect(h.cdn.requested).toHaveLength(2);
    const record = await readRecord();
    expect(record.tracks).toHaveLength(1);
    expect(record.tracks[0]?.title).not.toBe("A copy");
  });
});

describe("what a track keeps", () => {
  test("its highlights sorted, a 1500 flagged and last, and its explicit flag", async () => {
    const h = await harness({ decode: fastDecode });
    const [track] = listTracks(1) as [MusicTrack];
    serveAll(h.cdn, [track]);
    await refresh(h, [{ ...track, durationMs: EXCERPTS[0].durationMs + 100_000, explicit: true, highlightsMs: [1_500, 6_000, 2_000, 6_000] }]);
    const [summary] = h.store.list();
    expect(summary?.highlights).toEqual([
      { ms: 2_000, likelyDefault: false },
      { ms: 6_000, likelyDefault: false },
      { ms: 1_500, likelyDefault: true },
    ]);
    expect(summary?.explicit).toBe(true);
  });

  test("music.list's answer is valid TrackSummary items, at most 100, with no URL or path in it", async () => {
    const h = await harness({ decode: fastDecode });
    const tracks = listTracks(5);
    serveAll(h.cdn, tracks);
    await refresh(h, tracks);
    const list = h.store.list();
    expect(list).toHaveLength(5);
    for (const item of list) expect(TrackSummary.safeParse(item).success).toBe(true);
    expect(JSON.stringify(list)).not.toMatch(/https?:|oh=|\.m4a|sha/);
  });

  test("monetization and the licensed subtype are kept in the record, as cleaned strings", async () => {
    const h = await harness({ decode: fastDecode });
    const [track] = listTracks(1) as [MusicTrack];
    serveAll(h.cdn, [track]);
    await refresh(h, [{ ...track, monetization: "REVSHARE", licensedSubtype: null }]);
    expect((await readRecord()).tracks[0]).toMatchObject({ monetization: "REVSHARE", licensedSubtype: null });
  });
});

describe("the summary", () => {
  test("says nothing of a store that never refreshed", async () => {
    expect((await harness()).store.summary()).toEqual({ listFetchedAt: null, trackCount: 0, bytesOnDisk: 0 });
  });

  test("after a refresh: when the list came, how many tracks are stored and the bytes of every stored file", async () => {
    const h = await harness({ decode: fastDecode });
    const tracks = listTracks(3);
    serveAll(h.cdn, tracks);
    await refresh(h, tracks);
    const files = (await tree()).filter((f) => f.startsWith("tracks/") || f.startsWith("covers/"));
    let onDisk = 0;
    for (const file of files) onDisk += (await stat(join(musicDir, file))).size;
    expect(h.store.summary()).toEqual({ listFetchedAt: FETCHED, trackCount: 3, bytesOnDisk: onDisk });
  });

  test("says it persists, so the service lets a refresh through", async () => {
    expect((await harness()).store.persistent).toBe(true);
  });
});

describe("a second refresh", () => {
  test("does not download a track that is already stored, and keeps its file untouched", async () => {
    const h = await harness({ decode: fastDecode });
    const tracks = listTracks(3);
    serveAll(h.cdn, tracks);
    await refresh(h, tracks);
    const before = await readFile(join(musicDir, "tracks", `${tracks[0]?.trackId}.m4a`));
    h.cdn.requested.length = 0;
    await refresh(h, tracks);
    expect(h.cdn.requested).toEqual([]);
    expect(new Uint8Array(await readFile(join(musicDir, "tracks", `${tracks[0]?.trackId}.m4a`)))).toEqual(new Uint8Array(before));
    expect(h.store.summary().trackCount).toBe(3);
  });

  test("downloads only the new tracks, and keeps the ones the new list dropped: Stage 3 prunes nothing", async () => {
    const h = await harness({ decode: fastDecode });
    const all = listTracks(4);
    serveAll(h.cdn, all);
    await refresh(h, all.slice(0, 3));
    h.cdn.requested.length = 0;
    await refresh(h, all.slice(1, 4));
    expect(h.cdn.requested).toEqual([all[3]?.downloadUrl ?? "", all[3]?.coverUrl ?? ""]);
    const files = await tree();
    for (const track of all) expect(files).toContain(`tracks/${track.trackId}.m4a`);
    // music.list offers the current list only; the dropped one is kept, and is not offered.
    expect(h.store.list().map((t) => t.trackId)).toEqual(all.slice(1, 4).map((t) => t.trackId));
    const dropped = (await readRecord()).tracks.find((t) => t.trackId === all[0]?.trackId);
    expect(dropped).toMatchObject({ inList: false, audio: { state: "stored" } });
  });

  test("takes the new list's title and highlights for a track it already holds", async () => {
    const h = await harness({ decode: fastDecode });
    const [track] = listTracks(1) as [MusicTrack];
    serveAll(h.cdn, [track]);
    await refresh(h, [{ ...track, title: "Old", highlightsMs: [3_000] }]);
    await refresh(h, [{ ...track, title: "New", highlightsMs: [4_000] }]);
    expect(h.store.list()[0]).toMatchObject({ title: "New", highlights: [{ ms: 4_000, likelyDefault: false }] });
  });

  test("re-downloads a stored track whose file has gone missing", async () => {
    const h = await harness({ decode: fastDecode });
    const tracks = listTracks(2);
    serveAll(h.cdn, tracks);
    await refresh(h, tracks);
    await rm(join(musicDir, "tracks", `${tracks[0]?.trackId}.m4a`));
    h.cdn.requested.length = 0;
    await refresh(h, tracks);
    expect(h.cdn.requested).toContain(tracks[0]?.downloadUrl);
    expect(h.cdn.requested).not.toContain(tracks[1]?.downloadUrl);
  });

  test("a track that failed the first time is tried again with the new list's URL", async () => {
    const h = await harness({ decode: fastDecode });
    const tracks = listTracks(2);
    serveAll(h.cdn, tracks);
    h.cdn.serve(tracks[0]?.downloadUrl ?? "", { status: 500 });
    await refresh(h, tracks);
    h.cdn.serve(tracks[0]?.downloadUrl ?? "", { bytes: excerptOf(0) });
    await refresh(h, tracks);
    expect(h.store.summary().trackCount).toBe(2);
  });

  test("two refreshes at once: the second is refused, so one list is never written by two", async () => {
    const h = await harness({ decode: fastDecode });
    const tracks = listTracks(2);
    serveAll(h.cdn, tracks);
    const first = refresh(h, tracks);
    await expect(refresh(h, tracks)).rejects.toBeDefined();
    await first;
    expect(h.store.summary().trackCount).toBe(2);
  });
});

describe("opening a store that holds an earlier refresh", () => {
  test("restores the list, the counts and the summary with no request", async () => {
    const first = await harness({ decode: fastDecode });
    const tracks = listTracks(3);
    serveAll(first.cdn, tracks);
    await refresh(first, tracks);
    const again = await harness();
    expect(again.cdn.requested).toEqual([]);
    expect(again.store.summary()).toEqual(first.store.summary());
    expect(again.store.list()).toEqual(first.store.list());
  });

  test("a stored track whose file is gone is not listed and not counted", async () => {
    const first = await harness({ decode: fastDecode });
    const tracks = listTracks(3);
    serveAll(first.cdn, tracks);
    await refresh(first, tracks);
    await rm(join(musicDir, "tracks", `${tracks[1]?.trackId}.m4a`));
    const again = await harness();
    expect(again.store.list().map((t) => t.trackId)).toEqual([tracks[0], tracks[2]].map((t) => t?.trackId));
    expect(again.store.summary().trackCount).toBe(2);
  });

  test("a stored track whose file has a different size is not trusted", async () => {
    const first = await harness({ decode: fastDecode });
    const tracks = listTracks(2);
    serveAll(first.cdn, tracks);
    await refresh(first, tracks);
    await writeFile(join(musicDir, "tracks", `${tracks[0]?.trackId}.m4a`), "short");
    const again = await harness();
    expect(again.store.list().map((t) => t.trackId)).toEqual([tracks[1]?.trackId ?? ""]);
  });

  test("a record that is not valid JSON is set aside, logged, and the store starts empty", async () => {
    await mkdir(join(musicDir, "lists"), { recursive: true });
    await writeFile(join(musicDir, "lists", "current.json"), "{ not json");
    const h = await harness();
    expect(h.store.summary()).toEqual({ listFetchedAt: null, trackCount: 0, bytesOnDisk: 0 });
    expect(h.logs.join("\n")).toMatch(/list record/);
    const files = await tree();
    expect(files.some((f) => f.startsWith("lists/current.json."))).toBe(true);
  });

  test("a record written by a newer version is set aside too, never overwritten", async () => {
    await mkdir(join(musicDir, "lists"), { recursive: true });
    await writeFile(join(musicDir, "lists", "current.json"), JSON.stringify({ v: 2, fetchedAt: FETCHED, complete: true, tracks: [] }));
    const h = await harness();
    expect(h.store.summary().trackCount).toBe(0);
    expect((await tree()).some((f) => f.startsWith("lists/current.json."))).toBe(true);
  });

  test("a record that names a file by a path is refused as a whole: an id is the only way to a file", async () => {
    await mkdir(join(musicDir, "lists"), { recursive: true });
    const entry = { trackId: "../../evil", title: null, artist: null, durationMs: 1000, explicit: false, highlights: [], monetization: null, licensedSubtype: null, inList: true, audio: { state: "failed", reason: "x" }, cover: { state: "none" } };
    await writeFile(join(musicDir, "lists", "current.json"), JSON.stringify({ v: 1, fetchedAt: FETCHED, complete: true, tracks: [entry] }));
    const h = await harness();
    expect(h.store.list()).toEqual([]);
  });

  test("a pending URL past its expiry is dropped from what is held: it can never be used", async () => {
    await mkdir(join(musicDir, "lists"), { recursive: true });
    const entry = {
      trackId: "4199287736976977",
      title: "T",
      artist: null,
      durationMs: 8000,
      explicit: false,
      highlights: [],
      monetization: null,
      licensedSubtype: null,
      inList: true,
      audio: { state: "pending", url: "https://scontent-fra3-1.cdninstagram.com/x?oe=1", expiresAt: FETCHED + HOUR },
      cover: { state: "none" },
    };
    await writeFile(join(musicDir, "lists", "current.json"), JSON.stringify({ v: 1, fetchedAt: FETCHED, complete: false, tracks: [entry] }));
    now = FETCHED + 2 * HOUR;
    const h = await harness();
    expect(h.store.list()).toEqual([]);
    expect(h.cdn.requested).toEqual([]);
  });
});

describe("the waveform", () => {
  test("music.peaks answers a window from the envelope kept at download time", async () => {
    const h = await harness({ decode: async (o) => ({ decodedMs: o.expectedMs, peaks: Array.from({ length: 160 }, (_, i) => i * 6) }) });
    const tracks = listTracks(1);
    serveAll(h.cdn, tracks);
    await refresh(h, tracks);
    const peaks = await h.store.peaks(tracks[0]?.trackId ?? "", 0, 8_000, 16);
    expect(peaks).toHaveLength(16);
    expect(peaks?.[0]).toBe(6 * 9);
    expect(peaks?.[15]).toBe(6 * 159);
  });

  test("a track that is not stored has no waveform", async () => {
    const h = await harness({ decode: fastDecode });
    expect(await h.store.peaks("4199287736976977", 0, 1000, 16)).toBeNull();
  });

  test("an id that could be a path has none either, and reads nothing", async () => {
    const h = await harness({ decode: fastDecode });
    expect(await h.store.peaks("../../etc/passwd", 0, 1000, 16)).toBeNull();
  });

  test("a waveform file that was tampered with (not valid, or huge) is no waveform", async () => {
    const h = await harness({ decode: fastDecode });
    const tracks = listTracks(2);
    serveAll(h.cdn, tracks);
    await refresh(h, tracks);
    await writeFile(join(musicDir, "peaks", `${tracks[0]?.trackId}.json`), "{ nope");
    await writeFile(join(musicDir, "peaks", `${tracks[1]?.trackId}.json`), JSON.stringify({ v: 1, stepMs: 50, peaks: Array(50_000).fill(1) }));
    expect(await h.store.peaks(tracks[0]?.trackId ?? "", 0, 1000, 16)).toBeNull();
    expect(await h.store.peaks(tracks[1]?.trackId ?? "", 0, 1000, 16)).toBeNull();
  });

  test("a waveform is kept for a track of an earlier list too", async () => {
    const h = await harness({ decode: fastDecode });
    const all = listTracks(3);
    serveAll(h.cdn, all);
    await refresh(h, all.slice(0, 2));
    await refresh(h, all.slice(1, 3));
    expect(await h.store.peaks(all[0]?.trackId ?? "", 0, 1000, 16)).toHaveLength(16);
  });
});

describe("resuming after a stop or a crash", () => {
  /** A first run that is cut in the middle of the second track: one stored, two pending with their URLs. */
  async function interrupted(): Promise<{ tracks: MusicTrack[] }> {
    const controller = new AbortController();
    const first = await harness({ decode: fastDecode });
    const tracks = listTracks(3);
    serveAll(first.cdn, tracks);
    first.cdn.serve(tracks[1]?.downloadUrl ?? "", {
      body: (async function* () {
        controller.abort();
        await new Promise<void>(() => undefined);
        yield new Uint8Array(1);
      })(),
    });
    await refresh(first, tracks, controller.signal).catch(() => undefined);
    return { tracks };
  }

  test("a store opened over the interrupted run knows what is still to download", async () => {
    await interrupted();
    const again = await harness({ decode: fastDecode });
    expect(again.store.pendingCount()).toBe(4);
    expect(again.store.list()).toHaveLength(1);
  });

  test("resume downloads only what is pending, with the URLs the record kept, and then the record is complete and holds none", async () => {
    const { tracks } = await interrupted();
    const again = await harness({ decode: fastDecode });
    serveAll(again.cdn, tracks);
    await again.store.resume((done, total) => void again.progress.push([done, total]), signal());
    expect(again.cdn.requested).toEqual([tracks[1], tracks[2]].flatMap((t) => [t?.downloadUrl ?? "", t?.coverUrl ?? ""]));
    expect(again.store.pendingCount()).toBe(0);
    expect(again.store.list()).toHaveLength(3);
    const text = await readFile(join(musicDir, "lists", "current.json"), "utf8");
    expect(JSON.parse(text).complete).toBe(true);
    expect(text).not.toMatch(/https?:|oh=|oe=|cdninstagram|fbcdn/i);
    expect(again.progress[0]).toEqual([1, 5]);
    expect(again.progress.at(-1)).toEqual([5, 5]);
  });

  test("a URL that expired while the app was closed is dropped when the store opens, and the record on disk stops holding it", async () => {
    await interrupted();
    now = FETCHED + 200 * HOUR;
    const again = await harness({ decode: fastDecode });
    expect(again.store.pendingCount()).toBe(0);
    const text = await readFile(join(musicDir, "lists", "current.json"), "utf8");
    expect(text).not.toMatch(/https?:|oh=|oe=|cdninstagram|fbcdn/i);
    await again.store.resume(() => undefined, signal());
    expect(again.cdn.requested).toEqual([]);
  });

  test("with nothing pending resume does nothing: no request, no progress", async () => {
    const h = await harness({ decode: fastDecode });
    const tracks = listTracks(2);
    serveAll(h.cdn, tracks);
    await refresh(h, tracks);
    h.cdn.requested.length = 0;
    h.progress.length = 0;
    await h.store.resume((done, total) => void h.progress.push([done, total]), signal());
    expect(h.cdn.requested).toEqual([]);
    expect(h.progress).toEqual([]);
  });

  test("a resumed track that fails is recorded as failed, and the ones after it still go on", async () => {
    const { tracks } = await interrupted();
    const again = await harness({ decode: fastDecode });
    serveAll(again.cdn, tracks);
    again.cdn.serve(tracks[1]?.downloadUrl ?? "", { status: 503 });
    await again.store.resume(() => undefined, signal());
    expect((await readRecord()).tracks.map((t) => t.audio.state)).toEqual(["stored", "failed", "stored"]);
  });

  test("resume is refused while a refresh is being stored", async () => {
    const h = await harness({ decode: fastDecode });
    const tracks = listTracks(2);
    serveAll(h.cdn, tracks);
    const running = refresh(h, tracks);
    await expect(h.store.resume(() => undefined, signal())).rejects.toBeDefined();
    await running;
  });
});
