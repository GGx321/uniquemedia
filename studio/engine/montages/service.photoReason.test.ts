import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EngineFailure } from "../engineFailure";
import type { EngineError } from "../../shared/engine";
import { openLibrary } from "../library";
import { sceneSpec, writeVideoRecord } from "../library/testing/videoRecords";
import { useWorld } from "../videos/testing/kit";
import { montageRig, worldPhotoIds } from "./testing/rig";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// `montages.create` says WHY a picked photo was refused (`photoReason`), as `videos.render` does: the same causes, the same codes.

const world = useWorld();

async function failureOf(work: Promise<unknown>): Promise<EngineError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof EngineFailure) return error.error;
    throw error;
  }
  throw new Error("expected the call to fail");
}

describe("montages.create: photoReason of PHOTO_UNAVAILABLE", () => {
  test("a photo already in a video is in-video", async () => {
    const w = world();
    const [a = ""] = worldPhotoIds(w);
    await writeVideoRecord(w.libraryRoot, "video-0000001", sceneSpec(w.avatar.id, [a]));
    await w.library.reloadVideoRecords(w.avatar.id);

    const error = await failureOf(montageRig(w).service.create({ avatarId: w.avatar.id, photoIds: [a] }));

    expect(error).toMatchObject({ code: "PHOTO_UNAVAILABLE", photoReason: "in-video" });
  });

  test("a photo a queued or running render holds is held-by-render", async () => {
    const w = world();
    const [a = "", b = ""] = worldPhotoIds(w);
    const { library } = await openLibrary(w.libraryRoot, { reservedPhotos: () => new Set([a]) });

    const error = await failureOf(montageRig(w, { library }).service.create({ avatarId: w.avatar.id, photoIds: [a, b] }));

    expect(error).toMatchObject({ code: "PHOTO_UNAVAILABLE", photoReason: "held-by-render" });
  });

  test("a photo only an unfinished video's intent holds is pending-video", async () => {
    const w = world();
    const [a = ""] = worldPhotoIds(w);
    w.library.holdPendingPhotos(w.avatar.id, "video-unfinished-1", [a]);

    const error = await failureOf(montageRig(w).service.create({ avatarId: w.avatar.id, photoIds: [a] }));

    expect(error).toMatchObject({ code: "PHOTO_UNAVAILABLE", photoReason: "pending-video" });
  });

  test("a photo that a render AND an unfinished intent hold is held-by-render: there is a render to cancel", async () => {
    const w = world();
    const [a = ""] = worldPhotoIds(w);
    const { library } = await openLibrary(w.libraryRoot, { reservedPhotos: () => new Set([a]) });
    library.holdPendingPhotos(w.avatar.id, "video-unfinished-1", [a]);

    const error = await failureOf(montageRig(w, { library }).service.create({ avatarId: w.avatar.id, photoIds: [a] }));

    expect(error).toMatchObject({ code: "PHOTO_UNAVAILABLE", photoReason: "held-by-render" });
  });

  test("a rejected photo carries no reason", async () => {
    const w = world();
    const [a = ""] = worldPhotoIds(w);
    await w.library.setRejected(w.avatar.id, a, true);

    const error = await failureOf(montageRig(w).service.create({ avatarId: w.avatar.id, photoIds: [a] }));

    expect(error.code).toBe("PHOTO_UNAVAILABLE");
    expect(error.photoReason).toBeUndefined();
  });

  test("photos refused for different causes carry no single reason", async () => {
    const w = world();
    const [a = "", b = ""] = worldPhotoIds(w);
    await writeVideoRecord(w.libraryRoot, "video-0000001", sceneSpec(w.avatar.id, [a]));
    await w.library.reloadVideoRecords(w.avatar.id);
    await w.library.setRejected(w.avatar.id, b, true);

    const error = await failureOf(montageRig(w).service.create({ avatarId: w.avatar.id, photoIds: [a, b] }));

    expect(error.issues).toHaveLength(2);
    expect(error.photoReason).toBeUndefined();
  });

  test("while the used index is stale the reason is index-stale", async () => {
    const w = world();
    const [a = ""] = worldPhotoIds(w);
    w.library.flagVideoIndexStale(w.avatar.id, "video-0000001");

    const error = await failureOf(montageRig(w).service.create({ avatarId: w.avatar.id, photoIds: [a] }));

    expect(error).toMatchObject({ code: "PHOTO_UNAVAILABLE", photoReason: "index-stale" });
  });

  test("while a record cannot be read the reason is log-needs-repair", async () => {
    const w = world();
    const [a = ""] = worldPhotoIds(w);
    const videos = join(w.libraryRoot, "avatars", w.avatar.id, "videos");
    await mkdir(videos, { recursive: true });
    await writeFile(join(videos, "video-0000002.json"), "{ not json");
    await w.library.reloadVideoRecords(w.avatar.id);

    const error = await failureOf(montageRig(w).service.create({ avatarId: w.avatar.id, photoIds: [a] }));

    expect(error).toMatchObject({ code: "PHOTO_UNAVAILABLE", photoReason: "log-needs-repair" });
  });
});
