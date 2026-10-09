import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import type { DecodeOptions, DecodeResult } from "./decodeCheck";
import type { MusicTrack } from "./listSchema";
import { TrackStore } from "./trackStore";
import { fakeCdn, JPEG_1X1, excerptOf, listTracks, type FakeCdn } from "./testing/storeKit";
useNativeGlobals();

// `TrackStore.storedTrends()` (Stage 4, S4.5d; plan §7): every STORED trending track, of the current list or kept from an earlier one, as the autopilot's chooser takes it. It is
// not `list()`, which offers only the current list. A track whose audio is pending or failed is not stored and is not a candidate. The explicit flag is passed through, not
// filtered: the candidate builder decides.

const FETCHED = Date.parse("2026-10-01T10:00:00.000Z");
const NOW = FETCHED + 1000;

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "studio-track-candidates-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A decode that proves 9 s whatever was claimed, so the proven length is not the list's. */
const decodeNineSeconds = async (_options: DecodeOptions): Promise<DecodeResult> => ({ decodedMs: 9_000, peaks: [100, 200] });

async function open(cdn: FakeCdn): Promise<TrackStore> {
  return TrackStore.open({ dir: join(root, "music"), transport: cdn.transport, clock: () => NOW, log: () => undefined, decode: decodeNineSeconds });
}

function serve(cdn: FakeCdn, tracks: readonly MusicTrack[], except: ReadonlySet<number> = new Set()): void {
  tracks.forEach((track, index) => {
    if (!except.has(index)) cdn.serve(track.downloadUrl, { bytes: excerptOf(index) });
    if (track.coverUrl !== null) cdn.serve(track.coverUrl, { bytes: JPEG_1X1 });
  });
}

const accept = (store: TrackStore, tracks: readonly MusicTrack[]): Promise<void> => store.accept({ fetchedAt: FETCHED, tracks }, () => undefined, new AbortController().signal);

describe("storedTrends", () => {
  test("a store that never refreshed has none", async () => {
    expect((await open(fakeCdn())).storedTrends()).toEqual([]);
  });

  test("a stored track comes with its PROVEN length, its highlights and its explicit flag, and is in the list", async () => {
    const cdn = fakeCdn();
    const [track] = listTracks(1) as [MusicTrack];
    serve(cdn, [track]);
    const store = await open(cdn);
    await accept(store, [{ ...track, explicit: true, highlightsMs: [4_000, 6_000] }]);
    expect(store.storedTrends()).toEqual([
      {
        source: "trending",
        trackId: track.trackId,
        durationMs: 9_000,
        highlights: [
          { ms: 4_000, likelyDefault: false },
          { ms: 6_000, likelyDefault: false },
        ],
        explicit: true,
        inList: true,
      },
    ]);
  });

  test("a track kept from an earlier list is a candidate too, told as not in the list; music.list offers only the current one", async () => {
    const cdn = fakeCdn();
    const all = listTracks(4);
    serve(cdn, all);
    const store = await open(cdn);
    await accept(store, all.slice(0, 3));
    await accept(store, all.slice(1, 4));
    const trends = store.storedTrends();
    expect(trends.map((t) => t.trackId).sort()).toEqual(all.map((t) => t.trackId).sort());
    expect(trends.filter((t) => !t.inList).map((t) => t.trackId)).toEqual([all[0]?.trackId ?? ""]);
    expect(store.list().map((t) => t.trackId)).toEqual(all.slice(1, 4).map((t) => t.trackId));
  });

  test("a track whose audio failed to download is not a candidate", async () => {
    const cdn = fakeCdn();
    const tracks = listTracks(3);
    serve(cdn, tracks, new Set([1]));
    const store = await open(cdn);
    await accept(store, tracks).catch(() => undefined);
    expect(store.storedTrends().map((t) => t.trackId)).toEqual([tracks[0]?.trackId, tracks[2]?.trackId].map((id) => id ?? ""));
  });
});
