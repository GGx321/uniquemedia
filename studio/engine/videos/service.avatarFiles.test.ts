import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { NODE_COMMIT_FS } from "./commitFs";
import { commitIntent, writeIntent } from "./intents";
import { videoPaths } from "./record";
import { fakeVideoBytes, sampleRecord, useWorld, type World } from "./testing/kit";
import { serviceRig } from "./testing/serviceKit";
useNativeGlobals();

// «Удалить аватар»: which of an avatar's video files are in the export folder now, resolved by the ENGINE from the records (never from a path a
// caller names), so main can move exactly those to the Trash. A file that is not provably the one Studio wrote stays where it is.

const world = useWorld();

/** A committed video: its file in the export folder and its record in the library. */
async function committed(w: World, over: Parameters<typeof sampleRecord>[1] = {}, bytes: Uint8Array = fakeVideoBytes(2048)): Promise<{ path: string }> {
  const record = sampleRecord(w, { bytes, ...over });
  const path = join(w.exportRoot, ...record.file.relPath.split("/"));
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, bytes);
  await writeIntent(NODE_COMMIT_FS, w.libraryRoot, record);
  await commitIntent(NODE_COMMIT_FS, w.libraryRoot, w.avatar.id, record.id);
  await w.library.reloadVideoRecords(w.avatar.id);
  return { path };
}

describe("avatarFiles", () => {
  test("lists the absolute path of each video file that is present in the export folder", async () => {
    const w = world();
    const r = serviceRig(w);
    const a = await committed(w, { videoId: "video-0000000a", jobId: "job-0000000a", relPath: "Mia/2026-09-29_photo_001.mp4" });
    const b = await committed(w, { videoId: "video-0000000b", jobId: "job-0000000b", relPath: "Mia/2026-09-29_photo_002.mp4" });

    const found = await r.service.avatarFiles(w.libraryRoot, w.avatar.id);

    expect([...found.files].sort()).toEqual([a.path, b.path].sort());
    expect(found.exportRoot).toBe(w.exportRoot);
    expect(found.unlisted).toBe(0);
  });

  test("every listed path is inside the export folder", async () => {
    const w = world();
    const r = serviceRig(w);
    await committed(w);

    const found = await r.service.avatarFiles(w.libraryRoot, w.avatar.id);

    expect(found.files.length).toBe(1);
    for (const file of found.files) expect(file.startsWith(`${w.exportRoot}${sep}`)).toBe(true);
  });

  test("leaves out a file the owner already removed", async () => {
    const w = world();
    const r = serviceRig(w);
    const kept = await committed(w, { videoId: "video-0000000a", jobId: "job-0000000a", relPath: "Mia/2026-09-29_photo_001.mp4" });
    const gone = await committed(w, { videoId: "video-0000000b", jobId: "job-0000000b", relPath: "Mia/2026-09-29_photo_002.mp4" });
    const { rmSync } = await import("node:fs");
    rmSync(gone.path);

    expect((await r.service.avatarFiles(w.libraryRoot, w.avatar.id)).files).toEqual([kept.path]);
  });

  test("leaves out a file whose size is no longer the one Studio wrote: it is not provably Studio's", async () => {
    const w = world();
    const r = serviceRig(w);
    const changed = await committed(w);
    writeFileSync(changed.path, fakeVideoBytes(4096, 5));

    expect((await r.service.avatarFiles(w.libraryRoot, w.avatar.id)).files).toEqual([]);
  });

  test("leaves out a record made for another export folder", async () => {
    const w = world();
    const r = serviceRig(w);
    await committed(w, { rootId: "another-root-01" });

    expect((await r.service.avatarFiles(w.libraryRoot, w.avatar.id)).files).toEqual([]);
  });

  test("leaves out a file reached through a link: the link is not followed out of the export folder", async () => {
    const w = world();
    const r = serviceRig(w);
    const outside = join(w.dir, "outside");
    mkdirSync(outside);
    const bytes = fakeVideoBytes(2048);
    writeFileSync(join(outside, "2026-09-29_photo_001.mp4"), bytes);
    // `Mia` in the export folder is a link to a folder elsewhere, where the file of the record is.
    symlinkSync(outside, join(w.exportRoot, "Mia"));
    const record = sampleRecord(w, { bytes });
    await writeIntent(NODE_COMMIT_FS, w.libraryRoot, record);
    await commitIntent(NODE_COMMIT_FS, w.libraryRoot, w.avatar.id, record.id);
    await w.library.reloadVideoRecords(w.avatar.id);

    expect((await r.service.avatarFiles(w.libraryRoot, w.avatar.id)).files).toEqual([]);
  });

  test("an export folder that cannot be used lists no file and no root", async () => {
    const w = world();
    const r = serviceRig(w, { deps: { checkExport: async () => ({ ok: false, reason: "missing" }) } });
    await committed(w);

    const found = await r.service.avatarFiles(w.libraryRoot, w.avatar.id);

    expect(found).toEqual({ files: [], exportRoot: null, unlisted: 0 });
  });

  test("an export folder that does not answer lists no file either: nothing is guessed", async () => {
    const w = world();
    const r = serviceRig(w, { deps: { checkExport: async () => ({ ok: false, reason: "missing", unanswered: true }) } });
    await committed(w);

    expect((await r.service.avatarFiles(w.libraryRoot, w.avatar.id)).files).toEqual([]);
  });

  test("lists at most `max` files and counts the rest as unlisted", async () => {
    const w = world();
    const r = serviceRig(w);
    await committed(w, { videoId: "video-0000000a", jobId: "job-0000000a", relPath: "Mia/2026-09-29_photo_001.mp4" });
    await committed(w, { videoId: "video-0000000b", jobId: "job-0000000b", relPath: "Mia/2026-09-29_photo_002.mp4" });
    await committed(w, { videoId: "video-0000000c", jobId: "job-0000000c", relPath: "Mia/2026-09-29_photo_003.mp4" });

    const found = await r.service.avatarFiles(w.libraryRoot, w.avatar.id, { max: 2 });

    expect(found.files).toHaveLength(2);
    expect(found.unlisted).toBe(1);
  });

  test("an avatar with no videos lists nothing", async () => {
    const w = world();
    const r = serviceRig(w);

    expect(await r.service.avatarFiles(w.libraryRoot, w.avatar.id)).toEqual({ files: [], exportRoot: w.exportRoot, unlisted: 0 });
  });

  test("changes nothing on disk: the records stay where they are", async () => {
    const w = world();
    const r = serviceRig(w);
    await committed(w);
    const record = videoPaths(w.libraryRoot, w.avatar.id).record("video-00000001");
    const { existsSync } = await import("node:fs");

    await r.service.avatarFiles(w.libraryRoot, w.avatar.id);

    expect(existsSync(record)).toBe(true);
  });
});
