import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { videoPaths } from "./record";
import { recoverVideos, type ExportRootRef } from "./recovery";
import { CrashError, failureOf, rig, useWorld, type World } from "./testing/kit";
useNativeGlobals();

// 5b.2, S5.WA2 (I5.60, Q-F = 1): the clip frames of a render (the snapshot made at admission) travel through the commit into the intent and the record, and a crash between the intent and the
// record loses none of them. Recovery holds the frames of an intent it has not settled, and adopting the intent makes them used. A commit without clip frames writes none (an old shape, byte for byte).

const world = useWorld();
const rootRef = (w: World): ExportRootRef => ({ root: w.exportRoot, rootId: w.rootId, caseInsensitive: false });
const frameOf = (w: World, photoIndex: number) => ({ mediaId: "media-copy-0001", clipId: "clip-0000001", photoId: w.photos[photoIndex]?.id ?? "photo-missing" });

async function jsonOf(path: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
  return Object.fromEntries(Object.entries(parsed));
}

describe("a commit with clip frames", () => {
  test("writes them into the record", async () => {
    const w = world();
    const r = await rig(world, { input: { clipFrames: [frameOf(w, 1)] } });
    await r.run();
    expect((await jsonOf(videoPaths(w.libraryRoot, w.avatar.id).record("video-00000001"))).clipFrames).toEqual([frameOf(w, 1)]);
  });

  test("a commit without them writes no clipFrames key", async () => {
    const r = await rig(world);
    await r.run();
    expect("clipFrames" in (await jsonOf(videoPaths(r.w.libraryRoot, r.w.avatar.id).record("video-00000001")))).toBe(false);
  });

  test("an empty list is not written either: a spec with no clip copy is the old record", async () => {
    const r = await rig(world, { input: { clipFrames: [] } });
    await r.run();
    expect("clipFrames" in (await jsonOf(videoPaths(r.w.libraryRoot, r.w.avatar.id).record("video-00000001")))).toBe(false);
  });
});

describe("a crash between the intent and the record", () => {
  async function crashed() {
    const w = world();
    const r = await rig(world, { input: { clipFrames: [frameOf(w, 1)] } });
    await failureOf(
      r.run({
        hooks: {
          reached: (step) => {
            if (step === "dir-synced") {
              r.fs.die();
              throw new CrashError(step);
            }
          },
        },
      }),
    );
    return r;
  }

  test("the intent carries the clip frames", async () => {
    const r = await crashed();
    expect((await jsonOf(videoPaths(r.w.libraryRoot, r.w.avatar.id).intent("video-00000001"))).clipFrames).toEqual([frameOf(r.w, 1)]);
  });

  test("recovery that cannot settle the intent (no export folder) holds the clip's photo as well as the scene photo", async () => {
    const r = await crashed();
    const library = await r.w.reopen();

    await recoverVideos({ library, exportRoot: null }, { scratchMinAgeMs: 0 });

    const held = library.pendingVideoPhotos(r.w.avatar.id);
    expect([...held].sort()).toEqual([r.w.photos[0]?.id, r.w.photos[1]?.id].sort());
    expect(library.eligibleUnusedPhotos(r.w.avatar.id).map((p) => p.id)).toEqual([r.w.photos[2]?.id]);
  });

  test("recovery that adopts the intent makes the clip's photo used and ends the hold", async () => {
    const r = await crashed();
    const library = await r.w.reopen();

    const report = await recoverVideos({ library, exportRoot: rootRef(r.w) }, { scratchMinAgeMs: 0 });

    expect(report.adopted).toEqual(["video-00000001"]);
    expect(library.pendingVideoPhotos(r.w.avatar.id).size).toBe(0);
    expect(library.photoStates(r.w.avatar.id).get(r.w.photos[1]?.id ?? "")?.usedIn).toEqual(["video-00000001"]);
    expect(library.eligibleUnusedPhotos(r.w.avatar.id).map((p) => p.id)).toEqual([r.w.photos[2]?.id]);
  });

  test("an intent of an OLD shape (no clip frames) is held and adopted as it always was", async () => {
    const r = await rig(world);
    await failureOf(
      r.run({
        hooks: {
          reached: (step) => {
            if (step === "dir-synced") {
              r.fs.die();
              throw new CrashError(step);
            }
          },
        },
      }),
    );
    const library = await r.w.reopen();
    await recoverVideos({ library, exportRoot: null }, { scratchMinAgeMs: 0 });
    expect([...library.pendingVideoPhotos(r.w.avatar.id)]).toEqual([r.w.photos[0]?.id]);
  });
});
