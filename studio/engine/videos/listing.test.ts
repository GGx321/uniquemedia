import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { VideoSummary } from "../../shared/engine";
import { NODE_COMMIT_FS } from "./commitFs";
import { commitIntent, writeIntent } from "./intents";
import { MAX_RECORD_FILES_READ, readVideoRecordFile, readVideoRecordFiles, videoSummaryOf } from "./listing";
import { videoPaths, type VideoRecord } from "./record";
import { sampleRecord, useWorld, type World } from "./testing/kit";
useNativeGlobals();

// `videos.list` reads the records from disk (the library keeps only what "used" needs): newest first, and a record
// that cannot be read is left out, never a failure of the whole listing.

const world = useWorld();

async function commit(w: World, record: VideoRecord): Promise<void> {
  await writeIntent(NODE_COMMIT_FS, w.libraryRoot, record);
  await commitIntent(NODE_COMMIT_FS, w.libraryRoot, record.avatarId, record.id);
}

const at = (record: VideoRecord, createdAt: string): VideoRecord => ({ ...record, createdAt });

describe("readVideoRecordFiles", () => {
  test("reads an avatar's records newest first, ties broken by id", async () => {
    const w = world();
    await commit(w, at(sampleRecord(w, { videoId: "video-0000000a", jobId: "job-0000000a" }), "2026-09-29T10:00:00.000Z"));
    await commit(w, at(sampleRecord(w, { videoId: "video-0000000b", jobId: "job-0000000b" }), "2026-09-29T12:00:00.000Z"));
    await commit(w, at(sampleRecord(w, { videoId: "video-0000000c", jobId: "job-0000000c" }), "2026-09-29T12:00:00.000Z"));

    const read = await readVideoRecordFiles(w.libraryRoot, w.avatar.id);

    expect(read.records.map((r) => r.id)).toEqual(["video-0000000c", "video-0000000b", "video-0000000a"]);
    expect(read.skipped).toBe(0);
  });

  test("an avatar with no videos folder has no records", async () => {
    const w = world();

    expect(await readVideoRecordFiles(w.libraryRoot, w.avatar.id)).toEqual({ records: [], skipped: 0, truncated: false });
  });

  test("leaves out, and counts, a file that is not a usable record: garbage, another avatar's, a newer version's, a name that does not match its id", async () => {
    const w = world();
    await commit(w, sampleRecord(w, { videoId: "video-0000000a", jobId: "job-0000000a" }));
    const dir = videoPaths(w.libraryRoot, w.avatar.id).videosDir;
    writeFileSync(`${dir}/video-0000000b.json`, "{ not json");
    writeFileSync(`${dir}/video-0000000c.json`, JSON.stringify({ ...sampleRecord(w, { videoId: "video-0000000c" }), avatarId: "someone-else-1" }));
    writeFileSync(`${dir}/video-0000000d.json`, JSON.stringify({ schemaVersion: 99, id: "video-0000000d" }));
    writeFileSync(`${dir}/video-0000000e.json`, JSON.stringify(sampleRecord(w, { videoId: "video-0000000f" })));

    const read = await readVideoRecordFiles(w.libraryRoot, w.avatar.id);

    expect(read.records.map((r) => r.id)).toEqual(["video-0000000a"]);
    expect(read.skipped).toBe(4);
  });

  test("ignores what is not a record's name: notes, temp files and the pending folder", async () => {
    const w = world();
    await commit(w, sampleRecord(w, { videoId: "video-0000000a", jobId: "job-0000000a" }));
    const paths = videoPaths(w.libraryRoot, w.avatar.id);
    writeFileSync(`${paths.videosDir}/notes.txt`, "hello");
    writeFileSync(`${paths.videosDir}/.video-0000000b.json.tmp-1`, "half");
    mkdirSync(paths.pendingDir, { recursive: true });
    writeFileSync(paths.intent("video-0000000b"), JSON.stringify(sampleRecord(w, { videoId: "video-0000000b" })));

    const read = await readVideoRecordFiles(w.libraryRoot, w.avatar.id);

    expect(read.records.map((r) => r.id)).toEqual(["video-0000000a"]);
    expect(read.skipped).toBe(0);
  });

  test("reads at most MAX_RECORD_FILES_READ files and says it stopped", async () => {
    const w = world();
    const dir = videoPaths(w.libraryRoot, w.avatar.id).videosDir;
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 5; i++) writeFileSync(`${dir}/video-${String(i).padStart(8, "0")}.json`, JSON.stringify(sampleRecord(w, { videoId: `video-${String(i).padStart(8, "0")}` })));

    const read = await readVideoRecordFiles(w.libraryRoot, w.avatar.id, { maxFiles: 3 });

    expect(read.records).toHaveLength(3);
    expect(read.truncated).toBe(true);
    expect(MAX_RECORD_FILES_READ).toBeGreaterThan(500); // more than the contract lists, so the newest of a full listing are all considered
  });
});

describe("readVideoRecordFile", () => {
  test("reads one record by its id", async () => {
    const w = world();
    await commit(w, sampleRecord(w, { videoId: "video-0000000a", jobId: "job-0000000a" }));

    expect((await readVideoRecordFile(w.libraryRoot, w.avatar.id, "video-0000000a"))?.id).toBe("video-0000000a");
  });

  test("is null for a record that is not there, and for one that cannot be used", async () => {
    const w = world();
    const dir = videoPaths(w.libraryRoot, w.avatar.id).videosDir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/video-0000000b.json`, "{ not json");

    expect(await readVideoRecordFile(w.libraryRoot, w.avatar.id, "video-0000000a")).toBeNull();
    expect(await readVideoRecordFile(w.libraryRoot, w.avatar.id, "video-0000000b")).toBeNull();
  });
});

describe("videoSummaryOf", () => {
  test("builds the contract's summary from a record and its file state, with the photo count, the music and no poster yet", () => {
    const w = world();
    const record: VideoRecord = { ...sampleRecord(w, { photoIds: [w.photos[0]?.id ?? "", w.photos[1]?.id ?? ""] }), montageId: "montage-0000001", music: { title: "Song", artist: null } };

    const summary = videoSummaryOf(record, "missing");

    expect(VideoSummary.safeParse(summary).success).toBe(true);
    expect(summary).toEqual({
      videoId: record.id,
      avatarId: w.avatar.id,
      kind: "photo",
      durationMs: 2000,
      bytes: record.file.bytes,
      createdAt: record.createdAt,
      relPath: record.file.relPath,
      fileState: "missing",
      montageId: "montage-0000001",
      photoCount: 2,
      music: { title: "Song", artist: null },
      hasPoster: false,
    });
  });
});
