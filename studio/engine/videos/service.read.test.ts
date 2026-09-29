import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { EngineFailure } from "../engineFailure";
import { VideoSummary, type EngineError, type FileState } from "../../shared/engine";
import { NODE_COMMIT_FS } from "./commitFs";
import { FileStateChecker, type HashBudget } from "./fileState";
import { commitIntent, writeIntent } from "./intents";
import { videoPaths, type VideoRecord } from "./record";
import { fakeVideoBytes, sampleRecord, useWorld, type World } from "./testing/kit";
import { serviceRig } from "./testing/serviceKit";
import { withOverrides } from "./testing/serviceKit";
import { LibraryError } from "../library";
import type { ExportRootRef } from "./recovery";
useNativeGlobals();

// `videos.list` and `videos.delete` (3a.8b.2): records with their file's state from one checker and ONE hash budget per
// listing, against an export root looked at afresh; a record that cannot be checked never fails the list; and every
// failure of a delete becomes a contract code that names no path.

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

/** A committed video: its file in the export folder and its record in the library, then the library re-read (as an engine restart does). */
async function committed(w: World, over: Parameters<typeof sampleRecord>[1] = {}, bytes: Uint8Array = fakeVideoBytes(2048)): Promise<{ record: VideoRecord; path: string }> {
  const record = sampleRecord(w, { bytes, ...over });
  const path = join(w.exportRoot, ...record.file.relPath.split("/"));
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, bytes);
  await writeIntent(NODE_COMMIT_FS, w.libraryRoot, record);
  await commitIntent(NODE_COMMIT_FS, w.libraryRoot, w.avatar.id, record.id);
  await w.library.reloadVideoRecords(w.avatar.id);
  return { record, path };
}

describe("videos.list", () => {
  test("answers the avatar's records, newest first, each with its file's state and the contract's shape", async () => {
    const w = world();
    const r = serviceRig(w);
    await committed(w, { videoId: "video-0000000a", jobId: "job-0000000a", relPath: "Mia/2026-09-29_photo_001.mp4", photoIds: [w.photos[0]?.id ?? ""] });
    const second = await committed(w, { videoId: "video-0000000b", jobId: "job-0000000b", relPath: "Mia/2026-09-29_photo_002.mp4", photoIds: [w.photos[1]?.id ?? ""] });
    // the second one's file is gone, the way an owner deleting it outside Studio leaves it
    const { rmSync } = await import("node:fs");
    rmSync(second.path);
    const rewritten = { ...second.record, createdAt: "2026-09-29T12:00:00.000Z" };
    writeFileSync(videoPaths(w.libraryRoot, w.avatar.id).record(second.record.id), JSON.stringify(rewritten));

    const videos = await r.service.list(w.avatar.id);

    expect(videos.map((v) => [v.videoId, v.fileState])).toEqual([
      ["video-0000000b", "missing"],
      ["video-0000000a", "present"],
    ]);
    for (const video of videos) expect(VideoSummary.safeParse(video).success).toBe(true);
  });

  test("an avatar with no videos has an empty list; an unknown avatar is NOT_FOUND", async () => {
    const w = world();
    const r = serviceRig(w);

    expect(await r.service.list(w.avatar.id)).toEqual([]);
    expect((await failureOf(r.service.list("avatar-nobody-1"))).code).toBe("NOT_FOUND");
  });

  test("looks at the export root once per listing, afresh, and every record is judged against what that look found", async () => {
    const w = world();
    const r = serviceRig(w);
    await committed(w, { videoId: "video-0000000a", jobId: "job-0000000a", relPath: "Mia/2026-09-29_photo_001.mp4" });
    await committed(w, { videoId: "video-0000000b", jobId: "job-0000000b", relPath: "Mia/2026-09-29_photo_002.mp4" });

    await r.service.list(w.avatar.id);
    await r.service.list(w.avatar.id);

    expect(r.checks).toHaveLength(2); // one status look per listing, with no size estimate
    expect(r.checks.every((required) => required === undefined)).toBe(true);
  });

  test("an export root that is unusable reads every record `elsewhere`: never «файл удалён» for a drive that is merely not there", async () => {
    const w = world();
    const r = serviceRig(w, { deps: { checkExport: async () => ({ ok: false, reason: "missing" }) } });
    await committed(w);

    const videos = await r.service.list(w.avatar.id);

    expect(videos.map((v) => v.fileState)).toEqual(["elsewhere"]);
  });

  test("a record made for another export root reads `elsewhere`", async () => {
    const w = world();
    const r = serviceRig(w);
    await committed(w, { rootId: "another-root-01" });

    expect((await r.service.list(w.avatar.id)).map((v) => v.fileState)).toEqual(["elsewhere"]);
  });

  test("ONE hash budget serves the whole listing, and the next listing gets a fresh one", async () => {
    const w = world();
    const budgets: HashBudget[] = [];
    const checker = new FileStateChecker();
    const spy: FileStateChecker = Object.assign(Object.create(checker) as FileStateChecker, {
      check: (record: VideoRecord, root: ExportRootRef | null, options: { verify: "cheap" | "full"; budget?: HashBudget }): Promise<FileState> => {
        if (options.budget !== undefined) budgets.push(options.budget);
        return checker.check(record, root, options);
      },
    });
    const r = serviceRig(w, { deps: { checker: spy } });
    await committed(w, { videoId: "video-0000000a", jobId: "job-0000000a", relPath: "Mia/2026-09-29_photo_001.mp4" });
    await committed(w, { videoId: "video-0000000b", jobId: "job-0000000b", relPath: "Mia/2026-09-29_photo_002.mp4" });

    await r.service.list(w.avatar.id);
    await r.service.list(w.avatar.id);

    expect(budgets).toHaveLength(4);
    expect(budgets[0]).toBe(budgets[1]);
    expect(budgets[2]).toBe(budgets[3]);
    expect(budgets[0]).not.toBe(budgets[2]);
  });

  test("a record whose check fails does not fail the list: it reads `elsewhere`, and the others keep their own state", async () => {
    const w = world();
    const checker = new FileStateChecker();
    const flaky: FileStateChecker = Object.assign(Object.create(checker) as FileStateChecker, {
      check: (record: VideoRecord, root: ExportRootRef | null, options: { verify: "cheap" | "full"; budget?: HashBudget }): Promise<FileState> => {
        if (record.id === "video-0000000a") return Promise.reject(Object.assign(new Error(`EACCES: permission denied, lstat '${w.exportRoot}/Mia'`), { code: "EACCES" }));
        return checker.check(record, root, options);
      },
    });
    const r = serviceRig(w, { deps: { checker: flaky } });
    await committed(w, { videoId: "video-0000000a", jobId: "job-0000000a", relPath: "Mia/2026-09-29_photo_001.mp4" });
    await committed(w, { videoId: "video-0000000b", jobId: "job-0000000b", relPath: "Mia/2026-09-29_photo_002.mp4" });

    const videos = await r.service.list(w.avatar.id);

    expect(new Map(videos.map((v) => [v.videoId, v.fileState]))).toEqual(
      new Map([
        ["video-0000000a", "elsewhere"],
        ["video-0000000b", "present"],
      ]),
    );
    expect(r.logs.join("\n")).toContain("EACCES");
    expect(r.logs.join("\n")).not.toContain(w.exportRoot);
  });

  test("a record file that cannot be read is left out of the list, and the rest is answered", async () => {
    const w = world();
    const r = serviceRig(w);
    await committed(w, { videoId: "video-0000000a", jobId: "job-0000000a" });
    writeFileSync(join(videoPaths(w.libraryRoot, w.avatar.id).videosDir, "video-0000000b.json"), "{ not json");

    const videos = await r.service.list(w.avatar.id);

    expect(videos.map((v) => v.videoId)).toEqual(["video-0000000a"]);
  });
});

describe("videos.delete", () => {
  test("deletes a present file and its record, frees the photos, and announces the removal", async () => {
    const w = world();
    const r = serviceRig(w);
    const { record, path } = await committed(w);
    expect(w.library.photoStates(w.avatar.id).get(w.photos[0]?.id ?? "")?.usedIn).toEqual([record.id]);

    const answer = await r.service.delete(record.id);

    expect(answer).toEqual({ videoId: record.id });
    expect(existsSync(path)).toBe(false);
    expect(existsSync(videoPaths(w.libraryRoot, w.avatar.id).record(record.id))).toBe(false);
    expect(w.library.photoStates(w.avatar.id).get(w.photos[0]?.id ?? "")?.usedIn).toEqual([]);
    const changed = r.stamped().find((e) => e.type === "video.changed");
    expect(changed?.type === "video.changed" ? changed.payload : null).toEqual({ change: "removed", videoId: record.id, avatarId: w.avatar.id });
  });

  test("«Удалить запись» for `elsewhere`: only the record goes and the photos are freed, while the file lives on in the other folder", async () => {
    const w = world();
    const r = serviceRig(w);
    const { record, path } = await committed(w, { rootId: "another-root-01" });

    await r.service.delete(record.id);

    expect(existsSync(path)).toBe(true); // the file is not ours to reach for: another root
    expect(existsSync(videoPaths(w.libraryRoot, w.avatar.id).record(record.id))).toBe(false);
    expect(w.library.photoStates(w.avatar.id).get(w.photos[0]?.id ?? "")?.usedIn).toEqual([]);
  });

  test("with the export root unusable, the record still goes and the file is left", async () => {
    const w = world();
    const r = serviceRig(w, { deps: { checkExport: async () => ({ ok: false, reason: "missing" }) } });
    const { record, path } = await committed(w);

    await r.service.delete(record.id);

    expect(existsSync(path)).toBe(true);
    expect(existsSync(videoPaths(w.libraryRoot, w.avatar.id).record(record.id))).toBe(false);
  });

  test("looks at the export root afresh for the delete", async () => {
    const w = world();
    const r = serviceRig(w);
    const { record } = await committed(w);

    await r.service.delete(record.id);

    expect(r.checks).toHaveLength(1);
  });

  test("an unknown video is NOT_FOUND, and no event is emitted", async () => {
    const w = world();
    const r = serviceRig(w);

    const error = await failureOf(r.service.delete("video-nobody-01"));

    expect(error.code).toBe("NOT_FOUND");
    expect(r.events).toEqual([]);
  });

  test("a record that cannot be read is INTERNAL with a fixed detail, the record is kept, and nothing names a path", async () => {
    const w = world();
    const r = serviceRig(w);
    const dir = videoPaths(w.libraryRoot, w.avatar.id).videosDir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "video-0000000c.json"), "{ not json");

    const error = await failureOf(r.service.delete("video-0000000c"));

    expect(error).toEqual({ code: "INTERNAL", detail: "the video's record cannot be read" });
    expect(existsSync(join(dir, "video-0000000c.json"))).toBe(true);
  });

  test("a record from a newer Studio answers LIBRARY_TOO_NEW and is kept", async () => {
    const w = world();
    const r = serviceRig(w);
    const dir = videoPaths(w.libraryRoot, w.avatar.id).videosDir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "video-0000000d.json"), JSON.stringify({ schemaVersion: 99, id: "video-0000000d", avatarId: w.avatar.id }));

    const error = await failureOf(r.service.delete("video-0000000d"));

    expect(error.code).toBe("LIBRARY_TOO_NEW");
    expect(existsSync(join(dir, "video-0000000d.json"))).toBe(true);
  });

  test("a disk that fails is INTERNAL with the disk's code and no path", async () => {
    const w = world();
    const failing = { ...NODE_COMMIT_FS, unlink: () => Promise.reject(Object.assign(new Error(`EBUSY: resource busy, unlink '${w.exportRoot}/Mia/x.mp4'`), { code: "EBUSY" })) };
    const r = serviceRig(w, { deps: { fs: failing } });
    const { record } = await committed(w);

    const error = await failureOf(r.service.delete(record.id));

    expect(error.code).toBe("INTERNAL");
    expect(error.detail).toContain("EBUSY");
    expect(error.detail).not.toContain(w.exportRoot);
  });

  test("a raw Node error out of the file check is told by its code alone, never its message", async () => {
    const w = world();
    const checker = new FileStateChecker();
    const raw: FileStateChecker = Object.assign(Object.create(checker) as FileStateChecker, {
      check: () => Promise.reject(Object.assign(new Error(`EIO: i/o error, lstat '${w.exportRoot}/Mia/2026-09-29_photo_001.mp4'`), { code: "EIO" })),
    });
    const r = serviceRig(w, { deps: { checker: raw } });
    const { record } = await committed(w);

    const error = await failureOf(r.service.delete(record.id));

    expect(error).toEqual({ code: "INTERNAL", detail: "the video could not be deleted (EIO)" });
    expect(r.logs.join("\n")).not.toContain(w.exportRoot);
  });

  test("an engine refusal (no library, a switch in progress) passes through as it is", async () => {
    const w = world();
    const r = serviceRig(w, {
      deps: {
        withLibrary: () => {
          throw new EngineFailure({ code: "LIBRARY_UNAVAILABLE", detail: "no library is open" });
        },
      },
    });

    expect((await failureOf(r.service.delete("video-0000000a"))).code).toBe("LIBRARY_UNAVAILABLE");
  });

  test("a library error other than too-new is not disguised as one", async () => {
    const w = world();
    const library = withOverrides(w.library, {
      listAvatars: () => {
        throw new LibraryError("invalid-record", "x");
      },
    });
    const r = serviceRig(w, { library });

    const error = await failureOf(r.service.delete("video-0000000a"));

    expect(error.code).toBe("INTERNAL");
  });
});
