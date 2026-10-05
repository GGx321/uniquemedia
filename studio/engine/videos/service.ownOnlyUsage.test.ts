import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { EngineFailure } from "../engineFailure";
import type { EngineError } from "../../shared/engine";
import type { MontageDraft } from "../../shared/engine/montage";
import { LibraryError } from "../library";
import type { MediaLookup } from "../media/service";
import { specOf, useWorld, type World } from "./testing/kit";
import { serviceRig, withOverrides } from "./testing/serviceKit";
useNativeGlobals();

// A draft of only own files names no scene photo, so an avatar whose photo usage cannot be trusted has nothing to refuse it for: the render goes through
// (the refusal would have no cell to name, which the contract does not allow). A record from a newer Studio is another matter: LIBRARY_TOO_NEW stays.

const world = useWorld();
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 1, 1, 0xff, 0xd9]);

async function failureOf(work: Promise<unknown>): Promise<EngineError | null> {
  try {
    await work;
  } catch (error) {
    if (error instanceof EngineFailure) return error.error;
    throw error;
  }
  return null;
}

async function ownMedia(w: World): Promise<{ lookup(mediaId: string, kind: "photo", onFound?: (found: MediaLookup) => void): Promise<MediaLookup | undefined> }> {
  const dir = join(w.dir, "own-media");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "media-0000001.jpg");
  await writeFile(path, JPEG);
  return {
    lookup: async (mediaId, _kind, onFound) => {
      const summary = { mediaId, kind: "photo" as const, name: "own.jpg", bytes: JPEG.length, createdAt: "2026-10-04T10:00:00.000Z", width: 1080, height: 1920, durationMs: null, sourceFps: null, hdrToSdr: false, loopFrames: null, delayFrames: null };
      const found: MediaLookup = { summary, path, sha256: "0".repeat(64), bytes: JPEG.length, format: "jpeg" };
      onFound?.(found);
      return found;
    },
  };
}

const ownOnly = (w: World): MontageDraft => ({
  ...specOf(w.avatar.id, [], 4_000),
  clips: [{ clipId: "clip-00000001", kind: "photo", cell: { photo: { source: "own", mediaId: "media-0000001" }, focus: { x: 0.5, y: 0.4 } }, motion: "static", durationMs: 4_000, transitionIn: "cut" }],
});

describe("videos.render of a draft of only own files", () => {
  test("a stale used index that cannot be read again does not refuse it", async () => {
    const w = world();
    w.library.flagVideoIndexStale(w.avatar.id, "video-committed-1");
    const library = withOverrides(w.library, { reloadVideoRecords: () => Promise.reject(new Error("EIO")) });
    const r = serviceRig(w, { library, deps: { media: await ownMedia(w) } });

    expect(await failureOf(r.service.render({ spec: ownOnly(w) }))).toBeNull();
    await r.queue.idle();
  });

  test("records that need repair do not refuse it", async () => {
    const w = world();
    const library = withOverrides(w.library, {
      eligibleUnusedPhotos: () => {
        throw new LibraryError("log-needs-repair", "the video records need repair");
      },
    });
    const r = serviceRig(w, { library, deps: { media: await ownMedia(w) } });

    expect(await failureOf(r.service.render({ spec: ownOnly(w) }))).toBeNull();
    await r.queue.idle();
  });

  test("a record from a newer Studio still answers LIBRARY_TOO_NEW", async () => {
    const w = world();
    const library = withOverrides(w.library, {
      eligibleUnusedPhotos: () => {
        throw new LibraryError("library-too-new", "a newer record");
      },
    });
    const r = serviceRig(w, { library, deps: { media: await ownMedia(w) } });

    expect(await failureOf(r.service.render({ spec: ownOnly(w) }))).toMatchObject({ code: "LIBRARY_TOO_NEW" });
  });
});
