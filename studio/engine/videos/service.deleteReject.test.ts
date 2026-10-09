import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { EngineFailure } from "../engineFailure";
import { LibraryError } from "../library";
import type { EngineError } from "../../shared/engine";
import { NODE_COMMIT_FS } from "./commitFs";
import { commitIntent, writeIntent } from "./intents";
import { videoPaths, type VideoRecord } from "./record";
import { errnoError, faultyFs, fakeVideoBytes, sampleRecord, useWorld, type World } from "./testing/kit";
import { serviceRig, withOverrides } from "./testing/serviceKit";
useNativeGlobals();

// S4.5c (plan §8.5): `videos.delete { rejectPhotos: true }`, «Удалить видео и отклонить фото». The order is: the export folder must answer (and the file be reachable), as for any
// delete; then every scene photo of the record is marked rejected; then the video goes. So a refusal changes nothing, a delete that fails after the marks leaves a video whose
// photos are rejected (harmless: delete it again), and no order can leave free, unrejected photos for the next launch to take.

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

const photoId = (w: World, i: number): string => w.photos[i]?.id ?? "";

/** A committed video over the given photos: its file in the export folder and its record in the library, then the library re-read. */
async function committed(w: World, photoIds: readonly string[], over: Parameters<typeof sampleRecord>[1] = {}): Promise<{ record: VideoRecord; path: string }> {
  const bytes = fakeVideoBytes(2048);
  const record = sampleRecord(w, { bytes, photoIds, ...over });
  const path = join(w.exportRoot, ...record.file.relPath.split("/"));
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, bytes);
  await writeIntent(NODE_COMMIT_FS, w.libraryRoot, record);
  await commitIntent(NODE_COMMIT_FS, w.libraryRoot, w.avatar.id, record.id);
  await w.library.reloadVideoRecords(w.avatar.id);
  return { record, path };
}

const rejectedIds = (w: World): string[] =>
  w.photos
    .map((p) => p.id)
    .filter((id) => w.library.photoStates(w.avatar.id).get(id)?.rejected === true)
    .sort();
const recordExists = (w: World, videoId: string): boolean => existsSync(videoPaths(w.libraryRoot, w.avatar.id).record(videoId));

describe("videos.delete with rejectPhotos", () => {
  test("rejects every scene photo of the video, deletes it, and lists the photos it rejected", async () => {
    const w = world();
    const r = serviceRig(w);
    const { record, path } = await committed(w, [photoId(w, 0), photoId(w, 1)]);

    const answer = await r.service.delete(record.id, "video", { rejectPhotos: true });

    expect(answer).toEqual({ videoId: record.id, fileDeleted: true, fileState: "present", rejectedPhotoIds: [photoId(w, 0), photoId(w, 1)] });
    expect(rejectedIds(w)).toEqual([photoId(w, 0), photoId(w, 1)].sort());
    expect(recordExists(w, record.id)).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  test("the photos stay unavailable after the video is gone: rejected, not free", async () => {
    const w = world();
    const r = serviceRig(w);
    const { record } = await committed(w, [photoId(w, 0)]);

    await r.service.delete(record.id, "video", { rejectPhotos: true });

    const free = new Set(w.library.eligibleUnusedPhotos(w.avatar.id).map((p) => p.id));
    expect(free.has(photoId(w, 0))).toBe(false);
    expect(free.has(photoId(w, 2))).toBe(true);
  });

  test("the marks land BEFORE the video is deleted: at each mark the record and its file are still there", async () => {
    const w = world();
    const { record, path } = await committed(w, [photoId(w, 0), photoId(w, 1)]);
    const seen: Array<{ photo: string; record: boolean; file: boolean }> = [];
    const library = withOverrides(w.library, {
      setRejected: async (avatarId: string, id: string, rejected: boolean) => {
        seen.push({ photo: id, record: recordExists(w, record.id), file: existsSync(path) });
        return w.library.setRejected(avatarId, id, rejected);
      },
    });
    const r = serviceRig(w, { library });

    await r.service.delete(record.id, "video", { rejectPhotos: true });

    expect(seen).toEqual([
      { photo: photoId(w, 0), record: true, file: true },
      { photo: photoId(w, 1), record: true, file: true },
    ]);
  });

  test("a photo that was already rejected is still listed, and the others are rejected", async () => {
    const w = world();
    const r = serviceRig(w);
    const { record } = await committed(w, [photoId(w, 0), photoId(w, 1)]);
    await w.library.setRejected(w.avatar.id, photoId(w, 0), true);

    const answer = await r.service.delete(record.id, "video", { rejectPhotos: true });

    expect(answer.rejectedPhotoIds).toEqual([photoId(w, 0), photoId(w, 1)]);
    expect(rejectedIds(w)).toEqual([photoId(w, 0), photoId(w, 1)].sort());
  });

  test("a photo no longer in the library is skipped, not an error, and is not listed", async () => {
    const w = world();
    const r = serviceRig(w);
    const { record } = await committed(w, [photoId(w, 0), "photo-vanished-1"]);

    const answer = await r.service.delete(record.id, "video", { rejectPhotos: true });

    expect(answer.rejectedPhotoIds).toEqual([photoId(w, 0)]);
    expect(recordExists(w, record.id)).toBe(false);
  });

  test("works for the record-only delete too: the record goes, the file stays, the photos are rejected", async () => {
    const w = world();
    const r = serviceRig(w);
    const { record, path } = await committed(w, [photoId(w, 0)]);

    const answer = await r.service.delete(record.id, "record", { rejectPhotos: true });

    expect(answer).toEqual({ videoId: record.id, fileDeleted: false, fileState: "present", rejectedPhotoIds: [photoId(w, 0)] });
    expect(existsSync(path)).toBe(true);
    expect(rejectedIds(w)).toEqual([photoId(w, 0)]);
  });

  test("without the flag nothing is rejected and the answer has no rejectedPhotoIds", async () => {
    const w = world();
    const r = serviceRig(w);
    const { record } = await committed(w, [photoId(w, 0)]);

    const answer = await r.service.delete(record.id, "video");

    expect("rejectedPhotoIds" in answer).toBe(false);
    expect(rejectedIds(w)).toEqual([]);
  });
});

describe("videos.delete with rejectPhotos, when something refuses", () => {
  test("an export folder that does not answer is EXPORT_UNAVAILABLE and changes NOTHING: no photo rejected, the video in place", async () => {
    const w = world();
    const r = serviceRig(w, { deps: { checkExport: async () => ({ ok: false, reason: "not-writable" }) } });
    const { record, path } = await committed(w, [photoId(w, 0), photoId(w, 1)]);

    const error = await failureOf(r.service.delete(record.id, "video", { rejectPhotos: true }));

    expect(error).toMatchObject({ code: "EXPORT_UNAVAILABLE", exportReason: "not-writable" });
    expect(rejectedIds(w)).toEqual([]);
    expect(recordExists(w, record.id)).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(r.events).toEqual([]);
  });

  test("a file in another export folder is EXPORT_UNAVAILABLE `missing` and changes nothing", async () => {
    const w = world();
    const r = serviceRig(w);
    const { record, path } = await committed(w, [photoId(w, 0)], { rootId: "another-root-01" });

    const error = await failureOf(r.service.delete(record.id, "video", { rejectPhotos: true }));

    expect(error).toMatchObject({ code: "EXPORT_UNAVAILABLE", exportReason: "missing" });
    expect(rejectedIds(w)).toEqual([]);
    expect(recordExists(w, record.id)).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  test("an unknown video is NOT_FOUND and rejects nothing", async () => {
    const w = world();
    const r = serviceRig(w);
    await committed(w, [photoId(w, 0)]);

    const error = await failureOf(r.service.delete("video-nobody-0404", "video", { rejectPhotos: true }));

    expect(error.code).toBe("NOT_FOUND");
    expect(rejectedIds(w)).toEqual([]);
  });

  test("a delete that fails AFTER the marks leaves the photos rejected and the video in place, and a second try finishes it", async () => {
    const w = world();
    const fs = faultyFs();
    const r = serviceRig(w, { deps: { fs } });
    const { record, path } = await committed(w, [photoId(w, 0), photoId(w, 1)]);
    fs.failOnce("unlink", errnoError("EIO"), (args) => args[0]?.endsWith(".mp4") === true);

    const error = await failureOf(r.service.delete(record.id, "video", { rejectPhotos: true }));

    expect(error.code).toBe("INTERNAL");
    expect(rejectedIds(w)).toEqual([photoId(w, 0), photoId(w, 1)].sort());
    expect(recordExists(w, record.id)).toBe(true);
    expect(existsSync(path)).toBe(true);

    const again = await r.service.delete(record.id, "video", { rejectPhotos: true });

    expect(again.rejectedPhotoIds).toEqual([photoId(w, 0), photoId(w, 1)]);
    expect(recordExists(w, record.id)).toBe(false);
  });

  test("a reject log that needs repair refuses the whole delete: nothing is deleted and the answer names no path", async () => {
    const w = world();
    const library = withOverrides(w.library, {
      setRejected: async () => {
        throw new LibraryError("log-needs-repair", `rejected.jsonl of avatar ${w.avatar.id} needs repair at ${w.libraryRoot}`);
      },
    });
    const r = serviceRig(w, { library });
    const { record, path } = await committed(w, [photoId(w, 0)]);

    const error = await failureOf(r.service.delete(record.id, "video", { rejectPhotos: true }));

    expect(error.code).toBe("INTERNAL");
    expect(JSON.stringify(error)).not.toContain(w.libraryRoot);
    expect(recordExists(w, record.id)).toBe(true);
    expect(existsSync(path)).toBe(true);
  });
});
