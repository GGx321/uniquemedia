import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { EngineFailure } from "../engineFailure";
import { MAX_LISTED_VIDEOS, VideoSummary, type EngineError, type FileState } from "../../shared/engine";
import { NODE_COMMIT_FS } from "./commitFs";
import { FileStateChecker, type HashBudget } from "./fileState";
import { commitIntent, writeIntent } from "./intents";
import { videoPaths, type VideoRecord } from "./record";
import { fakeVideoBytes, sampleRecord, useWorld, type World } from "./testing/kit";
import { serviceRig, withOverrides } from "./testing/serviceKit";
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

  test("a record whose check fails does not fail the list: it reads `unchecked` (K15: not «another folder»), and the others keep their own state", async () => {
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
        ["video-0000000a", "unchecked"],
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

describe("videos.list, what can go wrong around it", () => {
  test("a videos folder that cannot be read is INTERNAL with the errno code only: the library's absolute path never reaches the window", async () => {
    const w = world();
    const r = serviceRig(w);
    const dir = videoPaths(w.libraryRoot, w.avatar.id).videosDir;
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, "not a folder");

    const error = await failureOf(r.service.list(w.avatar.id));

    expect(error.code).toBe("INTERNAL");
    expect(error.detail).toContain("ENOTDIR");
    expect(error.detail).not.toContain(w.libraryRoot);
    expect(error.detail).not.toContain("/var/");
  });

  test("a record whose file check never answers reads `unchecked` after the per-record bound (K15), and the listing goes on", async () => {
    const w = world();
    const checker = new FileStateChecker();
    const stuck: FileStateChecker = Object.assign(Object.create(checker) as FileStateChecker, {
      check: (record: VideoRecord, root: ExportRootRef | null, options: { verify: "cheap" | "full"; budget?: HashBudget }): Promise<FileState> => (record.id === "video-0000000a" ? new Promise<FileState>(() => undefined) : checker.check(record, root, options)),
    });
    const r = serviceRig(w, { deps: { checker: stuck, recordCheckTimeoutMs: 40 } });
    await committed(w, { videoId: "video-0000000a", jobId: "job-0000000a", relPath: "Mia/2026-09-29_photo_001.mp4" });
    await committed(w, { videoId: "video-0000000b", jobId: "job-0000000b", relPath: "Mia/2026-09-29_photo_002.mp4" });

    const videos = await r.service.list(w.avatar.id);

    expect(new Map(videos.map((v) => [v.videoId, v.fileState]))).toEqual(
      new Map([
        ["video-0000000a", "unchecked"],
        ["video-0000000b", "present"],
      ]),
    );
  });

  test("the whole listing has ONE budget: once it is spent the remaining records read `unchecked` without a look at the disk (stage 3 review 4-M4)", async () => {
    const w = world();
    const checker = new FileStateChecker();
    let looked = 0;
    const stuck: FileStateChecker = Object.assign(Object.create(checker) as FileStateChecker, {
      check: (): Promise<FileState> => (looked++, new Promise<FileState>(() => undefined)),
    });
    const r = serviceRig(w, { deps: { checker: stuck, recordCheckTimeoutMs: 150, listBudgetMs: 400 } });
    for (let i = 1; i <= 10; i++) {
      const n = String(i).padStart(2, "0");
      await committed(w, { videoId: `video-000000${n}`, jobId: `job-000000${n}`, relPath: `Mia/2026-09-29_photo_0${n}.mp4` });
    }

    const started = performance.now();
    const videos = await r.service.list(w.avatar.id);

    expect(videos).toHaveLength(10);
    expect(videos.every((v) => v.fileState === "unchecked")).toBe(true);
    // Not every record was looked at: the budget cut the listing (what is asserted is the count of looks, not the clock).
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(looked).toBeLessThan(10);
  });

  test("a read of the records that never returns fails the list within the budget with the engine's own INTERNAL, not main's NO_ANSWER (review round 1, L7)", async () => {
    const w = world();
    const r = serviceRig(w, { deps: { readRecordFiles: () => new Promise(() => undefined), listBudgetMs: 80 } });

    const started = performance.now();
    const error = await failureOf(r.service.list(w.avatar.id));

    expect(error.code).toBe("INTERNAL");
    expect(error.detail).toContain("ETIMEDOUT");
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("once the budget is spent no draft is looked at any more: the record keeps the draft id as written", async () => {
    const w = world();
    let looked = 0;
    const checker = new FileStateChecker();
    const stuck: FileStateChecker = Object.assign(Object.create(checker) as FileStateChecker, { check: (): Promise<FileState> => new Promise<FileState>(() => undefined) });
    const drafts = {
      find: async () => null,
      exists: async () => (looked++, true),
      wasRemoved: () => false,
      exclusive: async <T>(_id: string, work: () => Promise<T>) => work(),
    };
    const r = serviceRig(w, { deps: { checker: stuck, recordCheckTimeoutMs: 400, listBudgetMs: 400, drafts } });
    const record = sampleRecord(w, { videoId: "video-0000000a", jobId: "job-0000000a", relPath: "Mia/2026-09-29_photo_001.mp4" });
    await writeIntent(NODE_COMMIT_FS, w.libraryRoot, { ...record, montageId: "montage-00000001" });
    await commitIntent(NODE_COMMIT_FS, w.libraryRoot, w.avatar.id, record.id);
    await w.library.reloadVideoRecords(w.avatar.id);

    const videos = await r.service.list(w.avatar.id);

    expect(videos.map((v) => v.montageId)).toEqual(["montage-00000001"]);
    expect(looked).toBe(0);
  });

  test("an export check that never answers is cut by the listing's budget: the records come back `unchecked`, not main's NO_ANSWER (review round 2, L7)", async () => {
    const w = world();
    const r = serviceRig(w, { deps: { checkExport: () => new Promise<never>(() => undefined), listBudgetMs: 400 } });
    await committed(w, { videoId: "video-0000000a", jobId: "job-0000000a", relPath: "Mia/2026-09-29_photo_001.mp4" });

    const started = performance.now();
    const videos = await r.service.list(w.avatar.id);

    expect(videos.map((v) => v.fileState)).toEqual(["unchecked"]);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("an export check that fails fast (not a timeout) leaves the records `unchecked` with the whole budget still in hand: a root that could not be judged says nothing about a file", async () => {
    const w = world();
    const r = serviceRig(w, { deps: { checkExport: () => Promise.reject(new Error("boom")), listBudgetMs: 60_000 } });
    await committed(w, { videoId: "video-0000000a", jobId: "job-0000000a", relPath: "Mia/2026-09-29_photo_001.mp4" });

    const videos = await r.service.list(w.avatar.id);

    expect(videos.map((v) => v.fileState)).toEqual(["unchecked"]);
  });

  test("a record check that fails fast (EIO) does not spend the budget: the drafts of the records are still looked at (follow-up L4)", async () => {
    const w = world();
    let looked = 0;
    const checker = new FileStateChecker();
    const failing: FileStateChecker = Object.assign(Object.create(checker) as FileStateChecker, { check: (): Promise<FileState> => Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" })) });
    const drafts = { find: async () => null, exists: async () => (looked++, true), wasRemoved: () => false, exclusive: async <T>(_id: string, work: () => Promise<T>) => work() };
    const r = serviceRig(w, { deps: { checker: failing, drafts, listBudgetMs: 60_000, recordCheckTimeoutMs: 60_000 } });
    for (const n of [1, 2]) {
      const record = sampleRecord(w, { videoId: `video-0000000${n}`, jobId: `job-0000000${n}`, relPath: `Mia/2026-09-29_photo_00${n}.mp4` });
      await writeIntent(NODE_COMMIT_FS, w.libraryRoot, { ...record, montageId: `montage-0000000${n}` });
      await commitIntent(NODE_COMMIT_FS, w.libraryRoot, w.avatar.id, record.id);
    }
    await w.library.reloadVideoRecords(w.avatar.id);

    const videos = await r.service.list(w.avatar.id);

    expect(videos.map((v) => v.fileState)).toEqual(["unchecked", "unchecked"]);
    expect(looked).toBe(2);
  });

  test("a listing inside its budget is unchanged: every record is checked", async () => {
    const w = world();
    const r = serviceRig(w, { deps: { listBudgetMs: 60_000 } });
    await committed(w, { videoId: "video-0000000a", jobId: "job-0000000a", relPath: "Mia/2026-09-29_photo_001.mp4" });
    await committed(w, { videoId: "video-0000000b", jobId: "job-0000000b", relPath: "Mia/2026-09-29_photo_002.mp4" });

    const videos = await r.service.list(w.avatar.id);

    expect(videos.map((v) => v.fileState)).toEqual(["present", "present"]);
  });

  test("a stale used index is read again on demand before the list is answered", async () => {
    const w = world();
    let reloads = 0;
    const library = withOverrides(w.library, {
      reloadVideoRecords: (avatarId: string) => {
        reloads++;
        return w.library.reloadVideoRecords(avatarId);
      },
    });
    const r = serviceRig(w, { library });
    w.library.flagVideoIndexStale(w.avatar.id, "video-committed-1");

    await r.service.list(w.avatar.id);

    expect(reloads).toBe(1);
    expect(w.library.videoIndexStale(w.avatar.id)).toEqual([]);
  });
});

describe("videos.get: one video by id (3e.2: «Открыть в папке» for any video, without listing them)", () => {
  test("answers the record as `videos.list` shows it, its file looked at now, whichever avatar it belongs to", async () => {
    const w = world();
    const r = serviceRig(w);
    const { record } = await committed(w);

    const video = await r.service.get(record.id);

    expect(VideoSummary.safeParse(video).success).toBe(true);
    expect(video).toEqual((await r.service.list(w.avatar.id))[0] ?? null);
    expect(video.fileState).toBe("present");
  });

  test("finds a video the list cannot show any more: the listing stops at its bound, a read by id does not", async () => {
    const w = world();
    const r = serviceRig(w);
    const { record } = await committed(w, { videoId: "video-00000000", jobId: "job-00000000" });
    // 500 newer records: the listing answers those, and the first one is past its bound.
    const dir = videoPaths(w.libraryRoot, w.avatar.id).videosDir;
    for (let i = 1; i <= MAX_LISTED_VIDEOS; i++) {
      const id = `video-${String(i).padStart(8, "0")}`;
      writeFileSync(join(dir, `${id}.json`), JSON.stringify({ ...record, id, jobId: `job-${String(i).padStart(8, "0")}`, createdAt: "2026-09-30T10:00:00.000Z" }));
    }
    expect((await r.service.list(w.avatar.id)).some((v) => v.videoId === record.id)).toBe(false);

    expect((await r.service.get(record.id)).videoId).toBe(record.id);
  });

  test("an unknown video, and an id that breaks the pattern, are NOT_FOUND", async () => {
    const w = world();
    const r = serviceRig(w);
    await committed(w);
    expect((await failureOf(r.service.get("video-0000ffff"))).code).toBe("NOT_FOUND");
    expect((await failureOf(r.service.get("../video"))).code).toBe("NOT_FOUND");
  });

  test("with no library open it is NOT_FOUND", async () => {
    const w = world();
    const r = serviceRig(w, { deps: { openLibrary: () => null } });
    expect((await failureOf(r.service.get("video-00000001"))).code).toBe("NOT_FOUND");
  });

  test("a record that cannot be read is INTERNAL with a fixed detail; one from a newer Studio is LIBRARY_TOO_NEW", async () => {
    const w = world();
    const r = serviceRig(w);
    const dir = videoPaths(w.libraryRoot, w.avatar.id).videosDir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "video-0000000b.json"), "{ not json");
    writeFileSync(join(dir, "video-0000000c.json"), JSON.stringify({ schemaVersion: 2, id: "video-0000000c", avatarId: w.avatar.id }));

    const unreadable = await failureOf(r.service.get("video-0000000b"));
    expect(unreadable).toEqual({ code: "INTERNAL", detail: "the video's record cannot be read" });
    expect((await failureOf(r.service.get("video-0000000c"))).code).toBe("LIBRARY_TOO_NEW");
  });

  test("a file check that fails reads `unchecked` and names the code in the log, never the path", async () => {
    const w = world();
    const checker = new FileStateChecker();
    const flaky: FileStateChecker = Object.assign(Object.create(checker) as FileStateChecker, {
      check: (): Promise<FileState> => Promise.reject(Object.assign(new Error(`EIO: i/o error, lstat '${w.exportRoot}/Mia'`), { code: "EIO" })),
    });
    const r = serviceRig(w, { deps: { checker: flaky } });
    const { record } = await committed(w);

    expect((await r.service.get(record.id)).fileState).toBe("unchecked");
    expect(r.logs.join("\n")).toContain("EIO");
    expect(r.logs.join("\n")).not.toContain(w.exportRoot);
  });

  test("a file check that never answers reads `unchecked` after the per-record bound", async () => {
    const w = world();
    const checker = new FileStateChecker();
    const stuck: FileStateChecker = Object.assign(Object.create(checker) as FileStateChecker, { check: (): Promise<FileState> => new Promise<FileState>(() => undefined) });
    const r = serviceRig(w, { deps: { checker: stuck, recordCheckTimeoutMs: 40 } });
    const { record } = await committed(w);

    expect((await r.service.get(record.id)).fileState).toBe("unchecked");
  });

  test("an unusable export root reads `elsewhere`, as the list does", async () => {
    const w = world();
    const r = serviceRig(w, { deps: { checkExport: async () => ({ ok: false, reason: "missing" }) } });
    const { record } = await committed(w);

    expect((await r.service.get(record.id)).fileState).toBe("elsewhere");
  });
});

describe("the export root that is refused and the one that did not answer are told apart (follow-up M2)", () => {
  const refusedRoot = { ok: false, reason: "missing" } as const;
  const unansweredRoot = { ok: false, reason: "not-writable", unanswered: true } as const;

  test("videos.list: a root that was looked at and refused reads «elsewhere»; one that did not answer reads `unchecked`", async () => {
    const w = world();
    await committed(w, { videoId: "video-0000000a", jobId: "job-0000000a", relPath: "Mia/2026-09-29_photo_001.mp4" });

    const refused = serviceRig(w, { deps: { checkExport: async () => refusedRoot } });
    expect((await refused.service.list(w.avatar.id)).map((v) => v.fileState)).toEqual(["elsewhere"]);
    const unanswered = serviceRig(w, { deps: { checkExport: async () => unansweredRoot } });
    expect((await unanswered.service.list(w.avatar.id)).map((v) => v.fileState)).toEqual(["unchecked"]);
  });

  test("videos.get says the same two things", async () => {
    const w = world();
    const { record } = await committed(w, { videoId: "video-0000000a", jobId: "job-0000000a", relPath: "Mia/2026-09-29_photo_001.mp4" });

    const refused = serviceRig(w, { deps: { checkExport: async () => refusedRoot } });
    expect((await refused.service.get(record.id)).fileState).toBe("elsewhere");
    const unanswered = serviceRig(w, { deps: { checkExport: async () => unansweredRoot } });
    expect((await unanswered.service.get(record.id)).fileState).toBe("unchecked");
  });

  test("an unanswered root is still `null` for a «Удалить запись»: the record goes, the file is never touched", async () => {
    const w = world();
    const { record, path } = await committed(w, { videoId: "video-0000000a", jobId: "job-0000000a", relPath: "Mia/2026-09-29_photo_001.mp4" });
    const r = serviceRig(w, { deps: { checkExport: async () => unansweredRoot } });

    const answer = await r.service.delete(record.id, "record");

    expect(answer).toMatchObject({ fileDeleted: false });
    expect(existsSync(path)).toBe(true);
  });
});

describe("videos.delete, the case probe", () => {
  test("a case probe that never answers is cut at its bound and the cautious answer is used: the delete still goes through (review round 1, L9)", async () => {
    const w = world();
    const r = serviceRig(w, { deps: { caseProbe: { isCaseInsensitive: () => new Promise<boolean>(() => undefined) }, caseProbeTimeoutMs: 60 } });
    const { record, path } = await committed(w);

    const started = performance.now();
    const answer = await r.service.delete(record.id, "video");

    expect(answer).toMatchObject({ videoId: record.id, fileDeleted: true });
    expect(existsSync(path)).toBe(false);
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});

describe("videos.delete", () => {
  test("deletes a present file and its record, frees the photos, and announces the removal", async () => {
    const w = world();
    const r = serviceRig(w);
    const { record, path } = await committed(w);
    expect(w.library.photoStates(w.avatar.id).get(w.photos[0]?.id ?? "")?.usedIn).toEqual([record.id]);

    const answer = await r.service.delete(record.id, "video");

    expect(answer).toEqual({ videoId: record.id, fileDeleted: true, fileState: "present" });
    expect(existsSync(path)).toBe(false);
    expect(existsSync(videoPaths(w.libraryRoot, w.avatar.id).record(record.id))).toBe(false);
    expect(w.library.photoStates(w.avatar.id).get(w.photos[0]?.id ?? "")?.usedIn).toEqual([]);
    const changed = r.stamped().find((e) => e.type === "video.changed");
    expect(changed?.type === "video.changed" ? changed.payload : null).toEqual({ change: "removed", videoId: record.id, avatarId: w.avatar.id });
    expect(r.announced).toEqual([w.avatar.id]); // eligibleUnusedCount and videoCount moved
  });

  test("«Удалить запись» for `elsewhere`: only the record goes and the photos are freed, while the file lives on in the other folder", async () => {
    const w = world();
    const r = serviceRig(w);
    const { record, path } = await committed(w, { rootId: "another-root-01" });

    const answer = await r.service.delete(record.id, "record");

    expect(answer).toEqual({ videoId: record.id, fileDeleted: false, fileState: "elsewhere" });
    expect(existsSync(path)).toBe(true); // the file is not ours to reach for: another root
    expect(existsSync(videoPaths(w.libraryRoot, w.avatar.id).record(record.id))).toBe(false);
    expect(w.library.photoStates(w.avatar.id).get(w.photos[0]?.id ?? "")?.usedIn).toEqual([]);
  });

  test("«Удалить запись» NEVER deletes the file: not one that is present, not when the check is transiently wrong about the root", async () => {
    const w = world();
    const r = serviceRig(w);
    const { record, path } = await committed(w);

    const answer = await r.service.delete(record.id, "record");

    expect(answer).toEqual({ videoId: record.id, fileDeleted: false, fileState: "present" });
    expect(existsSync(path)).toBe(true);
    expect(existsSync(videoPaths(w.libraryRoot, w.avatar.id).record(record.id))).toBe(false);
  });

  test("«Удалить» with the export root unavailable answers EXPORT_UNAVAILABLE and deletes NOTHING: no file, no record, photos still used, no event", async () => {
    const w = world();
    const r = serviceRig(w, { deps: { checkExport: async () => ({ ok: false, reason: "not-writable" }) } });
    const { record, path } = await committed(w);

    const error = await failureOf(r.service.delete(record.id, "video"));

    expect(error).toMatchObject({ code: "EXPORT_UNAVAILABLE", exportReason: "not-writable" });
    expect(existsSync(path)).toBe(true);
    expect(existsSync(videoPaths(w.libraryRoot, w.avatar.id).record(record.id))).toBe(true);
    expect(w.library.photoStates(w.avatar.id).get(w.photos[0]?.id ?? "")?.usedIn).toEqual([record.id]);
    expect(r.events).toEqual([]);
  });

  test("«Удалить» with the record's file in another root answers EXPORT_UNAVAILABLE `missing` and deletes nothing", async () => {
    const w = world();
    const r = serviceRig(w);
    const { record, path } = await committed(w, { rootId: "another-root-01" });

    const error = await failureOf(r.service.delete(record.id, "video"));

    expect(error).toMatchObject({ code: "EXPORT_UNAVAILABLE", exportReason: "missing" });
    expect(existsSync(path)).toBe(true);
    expect(existsSync(videoPaths(w.libraryRoot, w.avatar.id).record(record.id))).toBe(true);
  });

  test("«Удалить запись» whose look at the file fails says so (`unchecked`, K15), removes the record and leaves the file", async () => {
    const w = world();
    const checker = new FileStateChecker();
    const flaky: FileStateChecker = Object.assign(Object.create(checker) as FileStateChecker, {
      check: (): Promise<FileState> => Promise.reject(Object.assign(new Error("EIO: i/o error"), { code: "EIO" })),
    });
    const r = serviceRig(w, { deps: { checker: flaky } });
    const { record, path } = await committed(w);

    const answer = await r.service.delete(record.id, "record");

    expect(answer).toEqual({ videoId: record.id, fileDeleted: false, fileState: "unchecked" });
    expect(existsSync(path)).toBe(true);
    expect(existsSync(videoPaths(w.libraryRoot, w.avatar.id).record(record.id))).toBe(false);
  });

  test("«Удалить запись» with the export root unavailable still removes the record and leaves the file", async () => {
    const w = world();
    const r = serviceRig(w, { deps: { checkExport: async () => ({ ok: false, reason: "missing" }) } });
    const { record, path } = await committed(w);

    const answer = await r.service.delete(record.id, "record");

    expect(answer).toEqual({ videoId: record.id, fileDeleted: false, fileState: "elsewhere" });
    expect(existsSync(path)).toBe(true);
    expect(existsSync(videoPaths(w.libraryRoot, w.avatar.id).record(record.id))).toBe(false);
  });

  test("a file that is `missing` goes with only the record under «Удалить», and the answer says the file was already gone", async () => {
    const w = world();
    const r = serviceRig(w);
    const { record, path } = await committed(w);
    const { rmSync } = await import("node:fs");
    rmSync(path);

    const answer = await r.service.delete(record.id, "video");

    expect(answer).toEqual({ videoId: record.id, fileDeleted: false, fileState: "missing" });
  });

  test("looks at the export root afresh for the delete", async () => {
    const w = world();
    const r = serviceRig(w);
    const { record } = await committed(w);

    await r.service.delete(record.id, "video");

    expect(r.checks).toHaveLength(1);
  });

  test("an unknown video is NOT_FOUND, and no event is emitted", async () => {
    const w = world();
    const r = serviceRig(w);

    const error = await failureOf(r.service.delete("video-nobody-01", "video"));

    expect(error.code).toBe("NOT_FOUND");
    expect(r.events).toEqual([]);
  });

  test("a record that cannot be read is INTERNAL with a fixed detail, the record is kept, and nothing names a path", async () => {
    const w = world();
    const r = serviceRig(w);
    const dir = videoPaths(w.libraryRoot, w.avatar.id).videosDir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "video-0000000c.json"), "{ not json");

    const error = await failureOf(r.service.delete("video-0000000c", "video"));

    expect(error).toEqual({ code: "INTERNAL", detail: "the video's record cannot be read" });
    expect(existsSync(join(dir, "video-0000000c.json"))).toBe(true);
  });

  test("a record from a newer Studio answers LIBRARY_TOO_NEW and is kept", async () => {
    const w = world();
    const r = serviceRig(w);
    const dir = videoPaths(w.libraryRoot, w.avatar.id).videosDir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "video-0000000d.json"), JSON.stringify({ schemaVersion: 99, id: "video-0000000d", avatarId: w.avatar.id }));

    const error = await failureOf(r.service.delete("video-0000000d", "video"));

    expect(error.code).toBe("LIBRARY_TOO_NEW");
    expect(existsSync(join(dir, "video-0000000d.json"))).toBe(true);
  });

  test("a disk that fails is INTERNAL with the disk's code and no path", async () => {
    const w = world();
    const failing = { ...NODE_COMMIT_FS, unlink: () => Promise.reject(Object.assign(new Error(`EBUSY: resource busy, unlink '${w.exportRoot}/Mia/x.mp4'`), { code: "EBUSY" })) };
    const r = serviceRig(w, { deps: { fs: failing } });
    const { record } = await committed(w);

    const error = await failureOf(r.service.delete(record.id, "video"));

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

    const error = await failureOf(r.service.delete(record.id, "video"));

    expect(error).toEqual({ code: "INTERNAL", detail: "the video could not be deleted (EIO)" });
    expect(r.logs.join("\n")).not.toContain(w.exportRoot);
  });

  test("a file check that never answers ends the delete at its bound, so the library is not held (a switch can go on) for ever", async () => {
    const w = world();
    const checker = new FileStateChecker();
    const stuck: FileStateChecker = Object.assign(Object.create(checker) as FileStateChecker, { check: () => new Promise<FileState>(() => undefined) });
    let held = 0;
    let released = 0;
    const r = serviceRig(w, {
      deps: {
        checker: stuck,
        deleteTimeoutMs: 40,
        withLibrary: async (work) => {
          held++;
          try {
            return await work(w.library);
          } finally {
            released++;
          }
        },
      },
    });
    // Its own id: the abandoned delete keeps this video's mutex (`video-delete:<id>`, process-wide) until its call wakes, which it never does here.
    const { record } = await committed(w, { videoId: "video-stuck-0001", jobId: "job-stuck-0001", relPath: "Mia/2026-09-29_photo_009.mp4" });

    const started = Date.now();
    const error = await failureOf(r.service.delete(record.id, "video"));

    expect(error).toMatchObject({ code: "EXPORT_UNAVAILABLE", exportReason: "not-writable" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect([held, released]).toEqual([1, 1]);
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

    expect((await failureOf(r.service.delete("video-0000000a", "video"))).code).toBe("LIBRARY_UNAVAILABLE");
  });

  test("a library error other than too-new is not disguised as one", async () => {
    const w = world();
    const library = withOverrides(w.library, {
      listAvatars: () => {
        throw new LibraryError("invalid-record", "x");
      },
    });
    const r = serviceRig(w, { library });

    const error = await failureOf(r.service.delete("video-0000000a", "video"));

    expect(error.code).toBe("INTERNAL");
  });
});
