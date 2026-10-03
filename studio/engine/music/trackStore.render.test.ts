import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { DecodeError, type DecodeOptions, type DecodeResult } from "./decodeCheck";
import type { MusicTrack } from "./listSchema";
import { EXCERPTS, excerptOf, fakeCdn, JPEG_1X1, listTracks, sha256Hex } from "./testing/storeKit";
import { TrackStore, TrackUnavailableError } from "./trackStore";
useNativeGlobals();

// 3c.5, the track store as the render's only source of a track's file (invariant 31): the path comes from the engine's own
// store by track id, and a track that is missing, failed, changed or no longer one audio stream is a clean refusal, never an
// ffmpeg run on an unverified file.

const FETCHED = Date.parse("2026-09-27T20:42:44.190Z");
const NOW = FETCHED + 1000;

let root = "";
let musicDir = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "studio-track-render-"));
  musicDir = join(root, "music");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const fastDecode = async (options: DecodeOptions): Promise<DecodeResult> => ({ decodedMs: options.expectedMs - 20, peaks: [1, 2, 3] });
const oneAudio = async (): Promise<readonly string[]> => ["Audio"];

interface Rig {
  store: TrackStore;
  tracks: MusicTrack[];
  inspected: string[];
}

async function stored(options: { inspect?: (path: string, signal: AbortSignal) => Promise<readonly string[]>; decode?: (o: DecodeOptions) => Promise<DecodeResult>; count?: number } = {}): Promise<Rig> {
  const cdn = fakeCdn();
  const inspected: string[] = [];
  const tracks = listTracks(options.count ?? 4);
  tracks.forEach((track, index) => {
    cdn.serve(track.downloadUrl, { bytes: excerptOf(index) });
    if (track.coverUrl !== null) cdn.serve(track.coverUrl, { bytes: JPEG_1X1 });
  });
  const inspect = options.inspect ?? oneAudio;
  const store = await TrackStore.open({
    dir: musicDir,
    transport: cdn.transport,
    clock: () => NOW,
    log: () => undefined,
    decode: options.decode ?? fastDecode,
    inspect: async (path, signal) => (inspected.push(path), inspect(path, signal)),
  });
  await store.accept({ fetchedAt: FETCHED, tracks }, () => undefined, new AbortController().signal);
  return { store, tracks, inspected };
}

const idOf = (rig: Rig, index: number): string => rig.tracks[index]?.trackId ?? "";
const fileOf = (rig: Rig, index: number): string => join(musicDir, "tracks", `${idOf(rig, index)}.m4a`);
const signal = (): AbortSignal => new AbortController().signal;

async function refusal(run: Promise<unknown>): Promise<TrackUnavailableError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof TrackUnavailableError) return error;
    throw error;
  }
  throw new Error("expected the track to be refused");
}

describe("TrackStore.stored: what the record says, with no disk", () => {
  test("gives the proven length of a stored track", async () => {
    const rig = await stored();
    expect(rig.store.stored(idOf(rig, 0))).toEqual({ decodedMs: (EXCERPTS[0]?.durationMs ?? 0) - 20 });
  });

  test("gives null for an id that was never listed", async () => {
    const rig = await stored();
    expect(rig.store.stored("9999999999")).toBeNull();
  });

  test("gives null for a track whose decode refused it, and still the others", async () => {
    const rig = await stored({
      decode: async (options) => {
        if (options.expectedMs === EXCERPTS[1]?.durationMs) throw new DecodeError("no-audio");
        return fastDecode(options);
      },
    });
    expect(rig.store.stored(idOf(rig, 1))).toBeNull();
    expect(rig.store.stored(idOf(rig, 0))).not.toBeNull();
  });

  test("gives null for an id that is not a safe id", async () => {
    const rig = await stored();
    expect(rig.store.stored("../../etc/passwd")).toBeNull();
    expect(rig.store.stored("")).toBeNull();
  });
});

describe("TrackStore.openForRender: a track the render may read", () => {
  test("gives the verified BYTES of the track, never a path, with its size, sha256 and proven length", async () => {
    const rig = await stored();
    const track = await rig.store.openForRender(idOf(rig, 0), signal());
    expect(Buffer.from(track.data).equals(Buffer.from(excerptOf(0)))).toBe(true);
    expect("path" in track).toBe(false);
    expect(track.bytes).toBe(excerptOf(0).byteLength);
    expect(track.sha256).toBe(sha256Hex(excerptOf(0)));
    expect(track.decodedMs).toBe((EXCERPTS[0]?.durationMs ?? 0) - 20);
  });

  test("the bytes are the ones that were verified, whatever happens to the stored file afterwards", async () => {
    const rig = await stored();
    const track = await rig.store.openForRender(idOf(rig, 0), signal());
    await writeFile(fileOf(rig, 0), new Uint8Array(excerptOf(0).byteLength));
    expect(Buffer.from(track.data).equals(Buffer.from(excerptOf(0)))).toBe(true);
  });

  test("has ffmpeg itself confirm that the COPY it is given holds exactly one audio stream, when the render asks", async () => {
    const rig = await stored();
    rig.inspected.length = 0;
    const track = await rig.store.openForRender(idOf(rig, 2), signal());
    expect(rig.inspected).toEqual([]);
    await track.check("/job/track.m4a", signal());
    expect(rig.inspected).toEqual(["/job/track.m4a"]);
  });

  test("lists the list's title and artist as strings the output must not carry", async () => {
    const rig = await stored();
    const listed = rig.tracks[0];
    const track = await rig.store.openForRender(idOf(rig, 0), signal());
    for (const text of [listed?.title, listed?.artist]) if (text !== null && text !== undefined && text.trim().length >= 8) expect(track.forbidden).toContain(text.trim());
  });

  test("gives the title and artist the tile shows", async () => {
    const rig = await stored();
    const track = await rig.store.openForRender(idOf(rig, 0), signal());
    expect(track.title).toBe(rig.tracks[0]?.title ?? "Untitled track");
    expect(track.artist).toBe(rig.tracks[0]?.artist ?? null);
  });
});

describe("TrackStore.openForRender: a clean refusal, and never an ffmpeg run on an unverified file", () => {
  test("an id the store never held", async () => {
    const rig = await stored();
    rig.inspected.length = 0;
    const error = await refusal(rig.store.openForRender("9999999999", signal()));
    expect(error.kind).toBe("not-stored");
    expect(rig.inspected).toEqual([]);
  });

  test("an id that could name a path outside the store", async () => {
    const rig = await stored();
    rig.inspected.length = 0;
    for (const id of ["../tracks/x", "a/b", "..", ""]) expect((await refusal(rig.store.openForRender(id, signal()))).kind).toBe("not-stored");
    expect(rig.inspected).toEqual([]);
  });

  test("a track the store failed to verify when it was downloaded (it was never stored)", async () => {
    const rig = await stored({
      decode: async (options) => {
        if (options.expectedMs === EXCERPTS[1]?.durationMs) throw new DecodeError("no-audio");
        return fastDecode(options);
      },
    });
    rig.inspected.length = 0;
    expect((await refusal(rig.store.openForRender(idOf(rig, 1), signal()))).kind).toBe("not-stored");
    expect(rig.inspected).toEqual([]);
  });

  test("a stored track whose file is gone", async () => {
    const rig = await stored();
    await rm(fileOf(rig, 0));
    rig.inspected.length = 0;
    expect((await refusal(rig.store.openForRender(idOf(rig, 0), signal()))).kind).toBe("changed");
    expect(rig.inspected).toEqual([]);
  });

  test("a file replaced by another of the same size (the hash differs)", async () => {
    const rig = await stored();
    const original = excerptOf(0);
    const forged = Uint8Array.from(original);
    forged[original.byteLength - 1] = (forged[original.byteLength - 1] ?? 0) ^ 0xff;
    await writeFile(fileOf(rig, 0), forged);
    rig.inspected.length = 0;
    expect((await refusal(rig.store.openForRender(idOf(rig, 0), signal()))).kind).toBe("changed");
    expect(rig.inspected).toEqual([]);
  });

  test("a file replaced by a longer one", async () => {
    const rig = await stored();
    await writeFile(fileOf(rig, 0), Buffer.concat([Buffer.from(excerptOf(0)), Buffer.from("tail")]));
    rig.inspected.length = 0;
    expect((await refusal(rig.store.openForRender(idOf(rig, 0), signal()))).kind).toBe("changed");
    expect(rig.inspected).toEqual([]);
  });

  test.skipIf(process.platform === "win32")("a symlink in place of the file, even to the same bytes", async () => {
    const rig = await stored();
    const elsewhere = join(root, "elsewhere.m4a");
    await writeFile(elsewhere, excerptOf(0));
    await rm(fileOf(rig, 0));
    await symlink(elsewhere, fileOf(rig, 0));
    rig.inspected.length = 0;
    expect((await refusal(rig.store.openForRender(idOf(rig, 0), signal()))).kind).toBe("changed");
    expect(rig.inspected).toEqual([]);
  });

  test("a directory in place of the file", async () => {
    const rig = await stored();
    await rm(fileOf(rig, 0));
    await mkdir(fileOf(rig, 0));
    expect((await refusal(rig.store.openForRender(idOf(rig, 0), signal()))).kind).toBe("changed");
  });

  test("a file ffmpeg now sees as more than one stream (cover art spelled in a way the walker did not know)", async () => {
    const rig = await stored({ inspect: async () => ["Audio", "Video"] });
    const track = await rig.store.openForRender(idOf(rig, 0), signal());
    expect((await refusal(track.check("/job/track.m4a", signal()))).kind).toBe("not-audio");
  });

  test("a file ffmpeg sees as no audio stream", async () => {
    const rig = await stored({ inspect: async () => [] });
    const track = await rig.store.openForRender(idOf(rig, 0), signal());
    expect((await refusal(track.check("/job/track.m4a", signal()))).kind).toBe("not-audio");
  });

  test("a file ffmpeg cannot be asked about in time", async () => {
    const rig = await stored({ inspect: async () => Promise.reject(new DecodeError("timeout")) });
    const track = await rig.store.openForRender(idOf(rig, 0), signal());
    expect((await refusal(track.check("/job/track.m4a", signal()))).kind).toBe("not-audio");
  });

  test("a cancel during the check is the abort reason", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled mid-check");
    const rig = await stored({
      inspect: async () => {
        controller.abort(reason);
        throw new DecodeError("aborted");
      },
    });
    const track = await rig.store.openForRender(idOf(rig, 0), controller.signal);
    expect(await track.check("/job/track.m4a", controller.signal).catch((e: unknown) => e)).toBe(reason);
  });

  test("a cancel is the abort reason, not a refusal of the track", async () => {
    const rig = await stored();
    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);
    expect(await rig.store.openForRender(idOf(rig, 0), controller.signal).catch((e: unknown) => e)).toBe(reason);
  });

  test("the refusal's text names no path", async () => {
    const rig = await stored({ inspect: async () => ["Audio", "Video"] });
    const track = await rig.store.openForRender(idOf(rig, 0), signal());
    const error = await refusal(track.check(join(root, "job", "track.m4a"), signal()));
    expect(error.message).not.toContain(musicDir);
    expect(error.message).not.toContain(root);
  });
});

describe("TrackStore.openForRender after a restart", () => {
  test("a store opened again over the same folder serves the track it stored", async () => {
    const rig = await stored();
    const reopened = await TrackStore.open({ dir: musicDir, transport: fakeCdn().transport, clock: () => NOW, log: () => undefined, inspect: oneAudio });
    const track = await reopened.openForRender(idOf(rig, 0), signal());
    expect(track.sha256).toBe(sha256Hex(excerptOf(0)));
  });

  test("a store whose file went missing while the app was closed no longer holds the track at all", async () => {
    const rig = await stored();
    await rename(fileOf(rig, 0), join(root, "moved.m4a"));
    const reopened = await TrackStore.open({ dir: musicDir, transport: fakeCdn().transport, clock: () => NOW, log: () => undefined, inspect: oneAudio });
    expect(reopened.stored(idOf(rig, 0))).toBeNull();
    expect((await refusal(reopened.openForRender(idOf(rig, 0), signal()))).kind).toBe("not-stored");
    expect((await readFile(fileOf(rig, 1))).byteLength).toBeGreaterThan(0);
  });
});
