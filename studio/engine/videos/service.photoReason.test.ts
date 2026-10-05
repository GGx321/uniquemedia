import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { EngineFailure } from "../engineFailure";
import type { EngineError } from "../../shared/engine";
import { LibraryError } from "../library";
import { sceneSpec, writeVideoRecord } from "../library/testing/videoRecords";
import { specOf, useWorld, type World } from "./testing/kit";
import { serviceRig, until, withOverrides } from "./testing/serviceKit";
useNativeGlobals();

// `videos.render` says WHY a scene photo was refused (`photoReason`), so the window can tell «уже в видео», «держит рендер» and «записи нельзя
// доверять» apart. A refusal whose cells have different causes, or a cause the window cannot act on (a rejected photo), carries none.

const world = useWorld();
const photoId = (w: World, i: number): string => w.photos[i]?.id ?? "";

async function failureOf(work: Promise<unknown>): Promise<EngineError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof EngineFailure) return error.error;
    throw error;
  }
  throw new Error("expected the call to fail");
}

describe("videos.render: photoReason of PHOTO_UNAVAILABLE", () => {
  test("a photo already in a video is in-video", async () => {
    const w = world();
    await writeVideoRecord(w.libraryRoot, "video-0000001", sceneSpec(w.avatar.id, [photoId(w, 0)]));
    await w.library.reloadVideoRecords(w.avatar.id);
    const r = serviceRig(w);

    const error = await failureOf(r.service.render({ spec: specOf(w.avatar.id, [photoId(w, 0)], 4_000) }));

    expect(error).toMatchObject({ code: "PHOTO_UNAVAILABLE", photoReason: "in-video" });
  });

  test("a photo another render holds is held-by-render", async () => {
    const w = world();
    let wake: () => void = () => undefined;
    const release = new Promise<void>((resolve) => {
      wake = resolve;
    });
    const r = serviceRig(w, { size: 2, deps: { renderOverrides: { commitDeadlineMs: 50, hooks: { reached: async (step) => (step === "name-claimed" ? release : undefined) } } } });
    const first = await r.service.render({ spec: specOf(w.avatar.id, [photoId(w, 0)], 4_000) });
    await until(() => r.jobs.stateOf(first.jobId)?.status === "running" && r.tracker.placeholderPaths().size === 1, "the first commit to claim its name");

    const error = await failureOf(r.service.render({ spec: specOf(w.avatar.id, [photoId(w, 0)], 4_000) }));

    wake();
    await r.queue.idle();
    expect(error).toMatchObject({ code: "PHOTO_UNAVAILABLE", photoReason: "held-by-render" });
  });

  test("a photo only an unfinished video's intent holds is pending-video, not held-by-render", async () => {
    const w = world();
    w.library.holdPendingPhotos(w.avatar.id, "video-unfinished-1", [photoId(w, 0)]);
    const r = serviceRig(w);

    const error = await failureOf(r.service.render({ spec: specOf(w.avatar.id, [photoId(w, 0)], 4_000) }));

    expect(error).toMatchObject({ code: "PHOTO_UNAVAILABLE", photoReason: "pending-video" });
  });

  test("a rejected photo carries no reason: nothing the owner can wait out", async () => {
    const w = world();
    await w.library.setRejected(w.avatar.id, photoId(w, 0), true);
    const r = serviceRig(w);

    const error = await failureOf(r.service.render({ spec: specOf(w.avatar.id, [photoId(w, 0)], 4_000) }));

    expect(error.code).toBe("PHOTO_UNAVAILABLE");
    expect(error.photoReason).toBeUndefined();
  });

  test("cells refused for different causes carry no single reason", async () => {
    const w = world();
    await writeVideoRecord(w.libraryRoot, "video-0000001", sceneSpec(w.avatar.id, [photoId(w, 0)]));
    await w.library.reloadVideoRecords(w.avatar.id);
    await w.library.setRejected(w.avatar.id, photoId(w, 1), true);
    const r = serviceRig(w);

    const error = await failureOf(r.service.render({ spec: specOf(w.avatar.id, [photoId(w, 0), photoId(w, 1)], 4_000) }));

    expect(error.issues).toHaveLength(2);
    expect(error.photoReason).toBeUndefined();
  });

  test("an avatar whose used index cannot be read again is index-stale", async () => {
    const w = world();
    w.library.flagVideoIndexStale(w.avatar.id, "video-committed-1");
    const library = withOverrides(w.library, { reloadVideoRecords: () => Promise.reject(new Error("EIO")) });
    const r = serviceRig(w, { library });

    const error = await failureOf(r.service.render({ spec: specOf(w.avatar.id, [photoId(w, 0)], 4_000) }));

    expect(error).toMatchObject({ code: "PHOTO_UNAVAILABLE", photoReason: "index-stale" });
  });

  test("an avatar whose records need repair is log-needs-repair", async () => {
    const w = world();
    const library = withOverrides(w.library, {
      eligibleUnusedPhotos: () => {
        throw new LibraryError("log-needs-repair", "the video records need repair");
      },
    });
    const r = serviceRig(w, { library });

    const error = await failureOf(r.service.render({ spec: specOf(w.avatar.id, [photoId(w, 0)], 4_000) }));

    expect(error).toMatchObject({ code: "PHOTO_UNAVAILABLE", photoReason: "log-needs-repair" });
  });
});
