import { describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { VideoSummary } from "../../shared/engine";
import { NODE_COMMIT_FS } from "./commitFs";
import { commitIntent, writeIntent } from "./intents";
import { MAX_RECORD_FILES_READ, readVideoRecordFile, readVideoRecordFiles, videoSummaryOf } from "./listing";
import { videoPaths, type VideoRecord } from "./record";
import { sampleRecord, specOf, useWorld, type World } from "./testing/kit";
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

  test("reads at most MAX_RECORD_FILES_READ files and says it stopped: and the ones it reads are the NEWEST, not the first names", async () => {
    const w = world();
    const dir = videoPaths(w.libraryRoot, w.avatar.id).videosDir;
    mkdirSync(dir, { recursive: true });
    // ids ascend while the files' ages descend: the newest are video-...0 to 2, the oldest the last two
    for (let i = 0; i < 5; i++) {
      const id = `video-${String(4 - i).padStart(8, "0")}`;
      const path = `${dir}/${id}.json`;
      writeFileSync(path, JSON.stringify(sampleRecord(w, { videoId: id })));
      utimesSync(path, new Date(2026, 8, 20 + i), new Date(2026, 8, 20 + i)); // i = 0 is the oldest
    }

    const read = await readVideoRecordFiles(w.libraryRoot, w.avatar.id, { maxFiles: 3 });

    expect(read.records.map((r) => r.id).sort()).toEqual(["video-00000000", "video-00000001", "video-00000002"]);
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
      music: { title: "Song", artist: null, trackId: null },
      hasPoster: false,
      title: null,
      firstClip: specOf(w.avatar.id, [w.photos[0]?.id ?? ""]).clips[0] ?? null,
    });
  });

  test("the title is the draft's name the record kept (K12); a record from before titles reads null", () => {
    const w = world();
    expect(videoSummaryOf({ ...sampleRecord(w), title: "утро дома" }, "present").title).toBe("утро дома");
    expect(videoSummaryOf(sampleRecord(w), "present").title).toBeNull();
  });

  test("a title that is not a montage name never makes the record unusable: it reads null", () => {
    const w = world();
    for (const title of ["", "x".repeat(81), "a\u0007b", 42]) {
      const summary = videoSummaryOf({ ...sampleRecord(w), title } as VideoRecord, "present");
      expect(summary.title).toBeNull();
      expect(VideoSummary.safeParse(summary).success).toBe(true);
    }
  });

  test("the music names its trending track by the spec's id (K13); an own track and a silent video name none", () => {
    const w = world();
    const base = sampleRecord(w);
    const trending = { ...base, music: { title: "Espresso", artist: "Sabrina Carpenter" }, spec: { ...base.spec, music: { source: "trending", trackId: "4199287736976977", startMs: 42_000 } } };
    const own = { ...base, music: { title: "My track", artist: null }, spec: { ...base.spec, music: { source: "own", mediaId: "media-0001", startMs: 0 } } };

    expect(videoSummaryOf(trending, "present").music).toEqual({ title: "Espresso", artist: "Sabrina Carpenter", trackId: "4199287736976977" });
    expect(videoSummaryOf(own, "present").music).toEqual({ title: "My track", artist: null, trackId: null });
    expect(videoSummaryOf(base, "present").music).toBeNull();
  });

  test("a spec's track id that is not an id is never passed on: the tile gets no cover rather than a path", () => {
    const w = world();
    const base = sampleRecord(w);
    const odd = { ...base, music: { title: "t", artist: null }, spec: { ...base.spec, music: { source: "trending", trackId: "../covers/x", startMs: 0 } } };
    expect(videoSummaryOf(odd, "present").music).toEqual({ title: "t", artist: null, trackId: null });
  });

  test("the first clip is the record's own, as the contract's clip: a collage keeps its layout and cells", () => {
    const w = world();
    const base = sampleRecord(w);
    const collage = {
      clipId: "clip-00000001",
      kind: "collage",
      layout: "collage2",
      cells: [
        { photo: { source: "scene", photoId: w.photos[0]?.id ?? "" }, focus: { x: 0.5, y: 0.3 } },
        { photo: { source: "scene", photoId: w.photos[1]?.id ?? "" }, focus: { x: 0.4, y: 0.4 } },
      ],
      motion: "kenburns",
      stagger: true,
      durationMs: 4_000,
      transitionIn: "cut",
    };
    const record = { ...base, spec: { ...base.spec, clips: [collage] } } as VideoRecord;
    expect(videoSummaryOf(record, "present").firstClip).toEqual(collage as VideoSummary["firstClip"]);
  });

  test("a first clip this build cannot read (a later build's field, a broken focus) reads null, and the summary still parses", () => {
    const w = world();
    const base = sampleRecord(w);
    const clip = base.spec.clips[0];
    for (const odd of [{ ...clip, zoom: 1.5 }, { ...clip, cell: { photo: { source: "scene", photoId: w.photos[0]?.id ?? "" }, focus: { x: 2, y: 0 } } }]) {
      const summary = videoSummaryOf({ ...base, spec: { ...base.spec, clips: [odd] } } as VideoRecord, "present");
      expect(summary.firstClip).toBeNull();
      expect(VideoSummary.safeParse(summary).success).toBe(true);
    }
  });
});
