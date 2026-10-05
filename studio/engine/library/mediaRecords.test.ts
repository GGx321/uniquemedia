import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MAX_LISTED_MEDIA, MediaSummary } from "../../shared/engine";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { tempDirFor } from "../../testing/tempDir";
import { MediaCommitError, MediaRecords, type MediaCommitInput, type MediaRecordsOptions } from "./mediaRecords";
import { SimulatedCrash, treatSimulatedCrash } from "./testing/mediaCrash";
useNativeGlobals();

// 3f.1b: the own-media records, `<library>/media/<mediaId>.json` beside the stored file `<mediaId>.<ext>`. Write-once, written atomically,
// recovered on open (the crash windows), and never touching anything outside `<library>/media/`.

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-media-records-");
const root = (): string => join(tmp(), "library");
const mediaDir = (): string => join(root(), "media");
const stagingDir = (): string => join(mediaDir(), ".staging");

beforeEach(async () => {
  await mkdir(stagingDir(), { recursive: true });
});

let ids = 0;
let clock = Date.parse("2026-10-04T10:00:00.000Z");
const PHOTO_FACTS = { width: 3024, height: 4032, durationMs: null, sourceFps: null, hdrToSdr: false, loopFrames: null, delayFrames: null } as const;
const VIDEO_FACTS = { width: 1080, height: 1920, durationMs: 6400, sourceFps: 60, hdrToSdr: true, loopFrames: null, delayFrames: null } as const;

function records(extra: Partial<MediaRecordsOptions> = {}): MediaRecords {
  return new MediaRecords({
    root: root(),
    newId: () => `media-${String(++ids).padStart(8, "0")}`,
    now: () => new Date((clock += 1000)),
    warn: () => undefined,
    ...extra,
  });
}

/** A staged copy, as the staging makes it: `<stagingId>.media` in `.staging`. */
async function staged(bytes: Buffer | string = "photo bytes"): Promise<string> {
  const path = join(stagingDir(), `staged-${String(++ids).padStart(8, "0")}.media`);
  await writeFile(path, bytes);
  return path;
}

async function photoInput(extra: Partial<MediaCommitInput> = {}): Promise<MediaCommitInput> {
  return { sourcePath: await staged(), kind: "photo", format: "jpeg", name: "summer.jpg", facts: PHOTO_FACTS, ...extra };
}

const names = async (dir: string): Promise<string[]> => (await readdir(dir).catch(() => [])).filter((n) => n !== ".staging").sort();

/** The bytes of a file the quarantine holds from `media/`, from whichever open's folder it is in. */
async function quarantinedBytes(name: string): Promise<Buffer | null> {
  for (const stamp of await readdir(join(root(), "quarantine")).catch(() => [])) {
    const bytes = await readFile(join(root(), "quarantine", stamp, "media", name)).catch(() => null);
    if (bytes !== null) return bytes;
  }
  return null;
}

/** Every file the library's quarantine holds from `media/`, by name: set aside, never deleted. */
async function quarantinedMedia(): Promise<string[]> {
  const out: string[] = [];
  for (const stamp of await readdir(join(root(), "quarantine")).catch(() => [])) {
    out.push(...(await readdir(join(root(), "quarantine", stamp, "media")).catch(() => [])));
  }
  return out.sort();
}

describe("a stored file gets its record", () => {
  test("the staged copy moves into media/ under the id and the record is written beside it", async () => {
    const store = records();
    const input = await photoInput();
    const summary = await store.commit(input);
    expect(await names(mediaDir())).toEqual([`${summary.mediaId}.jpg`, `${summary.mediaId}.json`]);
    expect(await readFile(join(mediaDir(), `${summary.mediaId}.jpg`), "utf8")).toBe("photo bytes");
    await expect(lstat(input.sourcePath)).rejects.toThrow();
  });

  test("the summary fits the contract, names the display name and the size of the stored file, and holds no path", async () => {
    const store = records();
    const summary = await store.commit(await photoInput({ sourcePath: await staged("twelve bytes") }));
    expect(MediaSummary.safeParse(summary).success).toBe(true);
    expect(summary).toMatchObject({ kind: "photo", name: "summer.jpg", bytes: 12, width: 3024, height: 4032 });
    expect(JSON.stringify(summary).includes(tmp())).toBe(false);
  });

  test("createdAt is the engine's clock", async () => {
    clock = Date.parse("2026-10-04T12:00:00.000Z") - 1000;
    const summary = await records().commit(await photoInput());
    expect(summary.createdAt).toBe("2026-10-04T12:00:00.000Z");
  });

  test("the record holds the sha256 of the stored file: the hash it was given, or one it computes", async () => {
    const store = records();
    const given = createHash("sha256").update("photo bytes").digest("hex");
    const a = await store.commit(await photoInput({ sha256: given }));
    const b = await store.commit(await photoInput());
    for (const summary of [a, b]) {
      const record: unknown = JSON.parse(await readFile(join(mediaDir(), `${summary.mediaId}.json`), "utf8"));
      expect(record).toMatchObject({ schemaVersion: 1, id: summary.mediaId, sha256: given, format: "jpeg", bytes: 11 });
    }
  });

  test("a video keeps what the importer learned of it", async () => {
    const summary = await records().commit({ sourcePath: await staged("v"), kind: "video", format: "mov", name: "walk.mov", facts: VIDEO_FACTS });
    expect(summary).toMatchObject({ kind: "video", durationMs: 6400, sourceFps: 60, hdrToSdr: true });
    expect(await names(mediaDir())).toContain(`${summary.mediaId}.mov`);
  });

  test("a listing by id holds the records named, newest first, whatever the kind filter lets through, and `total` counts what matched", async () => {
    const store = records();
    const first = await store.commit(await photoInput({ name: "a.jpg" }));
    const second = await store.commit(await photoInput({ name: "b.jpg" }));
    const third = await store.commit(await photoInput({ name: "c.jpg" }));
    const listed = store.list(undefined, [first.mediaId, third.mediaId, "media-00000404"]);
    expect(listed.media.map((m) => m.mediaId)).toEqual([third.mediaId, first.mediaId]);
    expect(listed.total).toBe(2);
    expect(store.list("video", [first.mediaId, second.mediaId])).toEqual({ media: [], total: 0 });
    expect(store.list("photo", [second.mediaId]).media.map((m) => m.mediaId)).toEqual([second.mediaId]);
    expect(store.list(undefined, []).total).toBe(0);
  });

  test("it is listed at once, newest first, and found by id", async () => {
    const store = records();
    const first = await store.commit(await photoInput());
    const second = await store.commit(await photoInput({ name: "b.jpg" }));
    expect(store.list().media.map((m) => m.mediaId)).toEqual([second.mediaId, first.mediaId]);
    expect(store.get(first.mediaId)).toEqual(first);
    expect(store.filePath(first.mediaId)).toBe(join(mediaDir(), `${first.mediaId}.jpg`));
  });
});

describe("what is refused before anything is moved", () => {
  async function untouched(input: MediaCommitInput, store = records()): Promise<MediaCommitError> {
    const error = await store.commit(input).then(
      () => null,
      (e: unknown) => e,
    );
    if (!(error instanceof MediaCommitError)) throw new Error(`expected a MediaCommitError, got ${String(error)}`);
    expect(await names(mediaDir())).toEqual([]);
    expect(store.list().total).toBe(0);
    return error;
  }

  test("facts that do not fit the kind (a photo with no width) leave the staged copy where it is", async () => {
    const input = await photoInput({ facts: { ...PHOTO_FACTS, width: null } });
    expect((await untouched(input)).code).toBe("invalid");
    expect((await lstat(input.sourcePath)).isFile()).toBe(true);
  });

  test("a name with control or bidi characters is refused", async () => {
    expect((await untouched(await photoInput({ name: "a‮gpj.exe" }))).code).toBe("invalid");
  });

  test("a source outside the staging folder is refused, whatever it is", async () => {
    const outside = join(tmp(), "outside.jpg");
    await writeFile(outside, "the owner's file");
    expect((await untouched(await photoInput({ sourcePath: outside }))).code).toBe("unsafe");
    expect(await readFile(outside, "utf8")).toBe("the owner's file");
  });

  test("a source that climbs out of the staging folder by a dot segment is refused", async () => {
    const outside = join(tmp(), "outside.jpg");
    await writeFile(outside, "the owner's file");
    expect((await untouched(await photoInput({ sourcePath: join(stagingDir(), "..", "..", "..", "outside.jpg") }))).code).toBe("unsafe");
  });

  test("a source that is a link is refused: the file moved must be the file that was copied", async () => {
    const outside = join(tmp(), "outside.jpg");
    await writeFile(outside, "the owner's file");
    const link = join(stagingDir(), "linked-00000001.media");
    await symlink(outside, link);
    expect((await untouched(await photoInput({ sourcePath: link }))).code).toBe("unsafe");
    expect(await readFile(outside, "utf8")).toBe("the owner's file");
  });

  test("a source that is a folder is refused", async () => {
    const folder = join(stagingDir(), "folder-00000001.media");
    await mkdir(folder);
    expect((await untouched(await photoInput({ sourcePath: folder }))).code).toBe("unsafe");
  });

  test("an empty file is refused: a record has bytes", async () => {
    expect((await untouched(await photoInput({ sourcePath: await staged("") }))).code).toBe("invalid");
  });

  test("a kind is not stored as a container it cannot be: a video as a JPEG", async () => {
    expect((await untouched({ sourcePath: await staged("v"), kind: "video", format: "jpeg", name: "v.mp4", facts: VIDEO_FACTS })).code).toBe("invalid");
  });

  test("a hash that is not a sha256 is refused", async () => {
    expect((await untouched(await photoInput({ sha256: "not-a-hash" }))).code).toBe("invalid");
  });

  test("a cancel that has already fired moves nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    const store = records();
    const input = await photoInput();
    const error = await store.commit(input, controller.signal).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MediaCommitError);
    expect((error as MediaCommitError).code).toBe("cancelled");
    expect((await lstat(input.sourcePath)).isFile()).toBe(true);
    expect(await names(mediaDir())).toEqual([]);
  });

  test("a media folder that is a link is refused and nothing goes through it", async () => {
    const other = join(tmp(), "other");
    await mkdir(join(other, ".staging"), { recursive: true });
    await writeFile(join(other, ".staging", "x-00000001.media"), "the owner's, in a folder that looks like staging");
    await rename(mediaDir(), join(tmp(), "real-media"));
    await symlink(other, mediaDir());
    const store = records();
    const error = await store.commit({ sourcePath: join(stagingDir(), "x-00000001.media"), kind: "photo", format: "jpeg", name: "a.jpg", facts: PHOTO_FACTS }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MediaCommitError);
    expect((await readdir(other)).sort()).toEqual([".staging"]);
    expect(await readdir(join(other, ".staging"))).toEqual(["x-00000001.media"]);
  });
});

describe("a crash at each point of a commit leaves a library that opens cleanly", () => {
  test("a crash after the file is stored and before the record: the next open sets the file aside, nothing is listed", async () => {
    const crashing = records({
      hooks: {
        treatAsCrash: treatSimulatedCrash,
        beforeRecordRename: () => {
          throw new SimulatedCrash();
        },
      },
    });
    const input = await photoInput();
    await expect(crashing.commit(input)).rejects.toThrow();
    // What the disk holds at that moment: the stored file (a crash cannot clean up), and the record's temp file.
    const before = await names(mediaDir());
    expect(before.some((n) => n.endsWith(".jpg"))).toBe(true);

    const reopened = records();
    const report = await reopened.recover();
    expect(await names(mediaDir())).toEqual([]);
    expect(reopened.list()).toEqual({ media: [], total: 0 });
    expect(report.quarantinedOrphans).toBeGreaterThanOrEqual(1);
    expect((await quarantinedMedia()).some((n) => n.endsWith(".jpg"))).toBe(true);
  });

  test("a failed commit cleans up after itself when it can: nothing is left behind", async () => {
    const failing = records({
      hooks: {
        beforeRecordRename: () => {
          throw new Error("disk full");
        },
      },
    });
    await expect(failing.commit(await photoInput())).rejects.toThrow();
    expect(await names(mediaDir())).toEqual([]);
    expect(failing.list().total).toBe(0);
  });

  test("a crash that left the record's temp file (and no record): the next open sweeps it", async () => {
    await writeFile(join(mediaDir(), ".media-00000009.json.abcdef123456.tmp"), "half a record");
    const reopened = records();
    await reopened.recover();
    expect(await names(mediaDir())).toEqual([]);
  });

  test("a crash after the record: the next open lists the media, untouched", async () => {
    const first = records();
    const summary = await first.commit(await photoInput());
    const reopened = records();
    const report = await reopened.recover();
    expect(reopened.list().media).toEqual([summary]);
    expect(report).toMatchObject({ quarantinedOrphans: 0, quarantinedDangling: 0, problems: [] });
  });

  test("a record whose file is gone is not listed and is set aside at the next open, not deleted", async () => {
    const first = records();
    const summary = await first.commit(await photoInput());
    await rename(join(mediaDir(), `${summary.mediaId}.jpg`), join(tmp(), "taken-away.jpg"));
    const reopened = records();
    const report = await reopened.recover();
    expect(reopened.list().total).toBe(0);
    expect(await names(mediaDir())).toEqual([]);
    expect(report.quarantinedDangling).toBe(1);
    expect(await quarantinedMedia()).toEqual([`${summary.mediaId}.json`]);
  });

  test("a library opened while half of it is missing loses nothing: no piece is deleted over two opens", async () => {
    // The reviewer's two-opens experiment: a record without its file, and a file without its record, then each other half arrives.
    const first = records();
    const kept = await first.commit(await photoInput());
    const other = await first.commit(await photoInput({ name: "other.jpg" }));
    const keptRecord = await readFile(join(mediaDir(), `${kept.mediaId}.json`));
    const otherFile = await readFile(join(mediaDir(), `${other.mediaId}.jpg`));
    // Open 1: the sync has brought kept's record and other's file, but not their partners.
    await rename(join(mediaDir(), `${kept.mediaId}.jpg`), join(tmp(), "kept.jpg"));
    await rename(join(mediaDir(), `${other.mediaId}.json`), join(tmp(), "other.json"));
    const firstOpen = await records().recover();
    expect(firstOpen).toMatchObject({ quarantinedOrphans: 1, quarantinedDangling: 1 });
    // The partners arrive (each beside a piece that was set aside); open 2 must not lose any of the four pieces.
    await rename(join(tmp(), "kept.jpg"), join(mediaDir(), `${kept.mediaId}.jpg`));
    await rename(join(tmp(), "other.json"), join(mediaDir(), `${other.mediaId}.json`));
    await records().recover();
    const all = [...(await names(mediaDir())), ...(await quarantinedMedia())].sort();
    expect(all.filter((n) => n.startsWith(kept.mediaId))).toHaveLength(2);
    expect(all.filter((n) => n.startsWith(other.mediaId))).toHaveLength(2);
    // And what was set aside is the bytes that were there, whichever open set it aside.
    expect(await quarantinedBytes(`${kept.mediaId}.json`)).toEqual(keptRecord);
    expect(await quarantinedBytes(`${other.mediaId}.jpg`)).toEqual(otherFile);
  });

  test("a file the owner dropped into media/ with a name of our shape is set aside, not deleted", async () => {
    await writeFile(join(mediaDir(), "holiday-photo.jpg"), "the owner's own photo");
    const report = await records().recover();
    expect(report.quarantinedOrphans).toBe(1);
    expect(await names(mediaDir())).toEqual([]);
    expect(await quarantinedMedia()).toEqual(["holiday-photo.jpg"]);
  });

  test("setting aside is told in the log, with counts and no path", async () => {
    await writeFile(join(mediaDir(), "holiday-photo.jpg"), "the owner's own photo");
    const lines: string[] = [];
    await records({ warn: (text) => lines.push(text) }).recover();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/1 .*set aside/);
    expect(lines[0]).not.toContain(root());
  });

  test("a file that cannot be set aside stays where it is, and the open still finishes", async () => {
    await writeFile(join(mediaDir(), "holiday-photo.jpg"), "the owner's own photo");
    await writeFile(join(root(), "quarantine"), "a file where the quarantine folder should be");
    const report = await records().recover();
    expect(report.quarantinedOrphans).toBe(0);
    expect(await names(mediaDir())).toEqual(["holiday-photo.jpg"]);
  });

  // L-3 (review M10): only a file that is NOT THERE makes a record dangling; any other disk error says nothing about the file.
  test.each(["EIO", "EACCES", "EBUSY"])("a record whose file cannot be looked at (%s) is kept: the disk's error is not the file's absence", async (code) => {
    const first = records();
    const summary = await first.commit(await photoInput());
    const reopened = records({
      fs: {
        lstat: async (path) => {
          if (path.endsWith(".jpg")) throw Object.assign(new Error("disk"), { code });
          const { lstat } = await import("node:fs/promises");
          return lstat(path);
        },
      },
    });
    const report = await reopened.recover();
    expect(report.quarantinedDangling).toBe(0);
    expect(await names(mediaDir())).toEqual([`${summary.mediaId}.jpg`, `${summary.mediaId}.json`]);
    expect(report.problems).toHaveLength(1);
  });

  test("a record whose file changed size is not listed, and nothing is removed: it may be the owner's tool at work", async () => {
    const first = records();
    const summary = await first.commit(await photoInput());
    await writeFile(join(mediaDir(), `${summary.mediaId}.jpg`), "a different length of bytes");
    const reopened = records();
    const report = await reopened.recover();
    expect(reopened.list().total).toBe(0);
    expect(await names(mediaDir())).toEqual([`${summary.mediaId}.jpg`, `${summary.mediaId}.json`]);
    expect(report.problems).toHaveLength(1);
  });

  test("a cancel after the file is stored and before the record: the stored file is taken back out and no record is written", async () => {
    const controller = new AbortController();
    const store = records({ hooks: { afterFileStored: () => controller.abort() } });
    const error = await store.commit(await photoInput(), controller.signal).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MediaCommitError);
    expect((error as MediaCommitError).code).toBe("cancelled");
    expect(await names(mediaDir())).toEqual([]);
    expect(store.list().total).toBe(0);
  });

  test("a cancel that arrives after the record is durable changes nothing: the media is stored", async () => {
    const controller = new AbortController();
    const store = records();
    const summary = await store.commit(await photoInput(), controller.signal);
    controller.abort();
    expect(store.get(summary.mediaId)).toEqual(summary);
    expect(await names(mediaDir())).toEqual([`${summary.mediaId}.jpg`, `${summary.mediaId}.json`]);
  });

  // M-1 of the 3f.1b review (probe P1): a cleanup whose listing saw the stored file but not yet its record, and whose orphan pass runs
  // after the commit has ended, must not take the file of a record that is now in the index.
  test("a cleanup that listed the file before its record existed, and judges it after the commit ended, keeps it", async () => {
    await writeFile(join(mediaDir(), ".media-00000099.json.abcdef123456.tmp"), "half a record");
    let reachedTemp: () => void = () => undefined;
    const atTemp = new Promise<void>((resolve) => {
      reachedTemp = resolve;
    });
    let letTemp: () => void = () => undefined;
    const tempGate = new Promise<void>((resolve) => {
      letTemp = resolve;
    });
    let stored: () => void = () => undefined;
    const fileStored = new Promise<void>((resolve) => {
      stored = resolve;
    });
    let letCommit: () => void = () => undefined;
    const commitGate = new Promise<void>((resolve) => {
      letCommit = resolve;
    });
    const store = records({
      fs: {
        unlink: async (path) => {
          if (path.includes("media-00000099")) {
            reachedTemp();
            await tempGate;
          }
          const { unlink } = await import("node:fs/promises");
          await unlink(path);
        },
        platform: "linux",
      },
      hooks: {
        afterFileStored: async () => {
          stored();
          await commitGate;
        },
      },
    });
    const commit = store.commit(await photoInput());
    await fileStored;
    const recovering = store.recover();
    await atTemp;
    letCommit();
    const summary = await commit;
    letTemp();
    await recovering;
    expect(await names(mediaDir())).toEqual([`${summary.mediaId}.jpg`, `${summary.mediaId}.json`]);
    expect(store.list().total).toBe(1);
  });

  test("a commit that is in flight is not an orphan: a cleanup running meanwhile leaves its file", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached: () => void = () => undefined;
    const atGate = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const store = records({
      hooks: {
        afterFileStored: async () => {
          reached();
          await gate;
        },
      },
    });
    const commit = store.commit(await photoInput());
    await atGate;
    await store.recover();
    release();
    const summary = await commit;
    expect(await names(mediaDir())).toEqual([`${summary.mediaId}.jpg`, `${summary.mediaId}.json`]);
  });
});

describe("what open will not judge for itself", () => {
  async function planted(name: string, text: string): Promise<void> {
    await writeFile(join(mediaDir(), name), text);
  }
  const record = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({ schemaVersion: 1, id: "media-00000050", kind: "photo", name: "a.jpg", createdAt: "2026-10-04T10:00:00.000Z", bytes: 5, sha256: "a".repeat(64), format: "jpeg", file: "media-00000050.jpg", ...PHOTO_FACTS, ...over });

  test("a record that is not JSON is not listed and not removed, and its file is not an orphan", async () => {
    await planted("media-00000050.json", "{ not json");
    await planted("media-00000050.jpg", "bytes");
    const store = records();
    const report = await store.recover();
    expect(store.list().total).toBe(0);
    expect(await names(mediaDir())).toEqual(["media-00000050.jpg", "media-00000050.json"]);
    expect(report.problems).toEqual([{ file: "media-00000050.json", reason: "unreadable" }]);
  });

  test("a record written by a newer Studio is kept as it is, with its file", async () => {
    await planted("media-00000050.json", record({ schemaVersion: 2 }));
    await planted("media-00000050.jpg", "bytes");
    const store = records();
    const report = await store.recover();
    expect(store.list().total).toBe(0);
    expect(await names(mediaDir())).toEqual(["media-00000050.jpg", "media-00000050.json"]);
    expect(report.problems).toEqual([{ file: "media-00000050.json", reason: "too-new" }]);
  });

  test("a record under another id's name is not trusted", async () => {
    // Everything is sound except the name: the record says id 50 and lies in 51's file; its own file is where it says.
    await planted("media-00000051.json", record());
    await planted("media-00000050.jpg", "bytes");
    const store = records();
    await store.recover();
    expect(store.list().total).toBe(0);
  });

  test("a record that names a file other than its own id and format is not trusted: it could point a delete anywhere", async () => {
    for (const file of ["../../victim.txt", "/etc/passwd", "media-00000099.jpg", "media-00000050.jpg/../x", "..\\victim.txt"]) {
      await planted("media-00000050.json", record({ file }));
      await planted("media-00000050.jpg", "bytes");
      const store = records();
      const report = await store.recover();
      expect(store.list().total).toBe(0);
      expect(report.problems).toHaveLength(1);
    }
  });

  test("a record with facts that do not fit its kind is not listed", async () => {
    await planted("media-00000050.json", record({ width: null }));
    await planted("media-00000050.jpg", "bytes");
    const store = records();
    await store.recover();
    expect(store.list().total).toBe(0);
  });

  test("only files of the shape of ours are ever set aside as orphans, and folders are left", async () => {
    await planted("media-00000060.jpg", "an orphan of ours");
    await planted("notes.txt", "the owner's");
    await planted("MEDIA-00000061.jpg", "capitals are not ours");
    await planted("media-00000062.exe", "not a format of ours");
    await mkdir(join(mediaDir(), "media-00000063.jpg"));
    await records().recover();
    expect(await names(mediaDir())).toEqual(["MEDIA-00000061.jpg", "media-00000062.exe", "media-00000063.jpg", "notes.txt"]);
    expect(await quarantinedMedia()).toEqual(["media-00000060.jpg"]);
  });

  // L-4 (review M14): a temp file that is not a record's own is the owner's or another program's.
  test("a foreign temp file in media/ survives a cleanup, and so does one that only looks like a record's temp", async () => {
    await planted(".foo.tmp", "someone else's");
    await planted(".media-00000009.json.tmp", "no random part, not ours");
    await planted(".media-00000009.json.0123456789ab.bak", "not a temp");
    await records().recover();
    expect(await names(mediaDir())).toEqual([".foo.tmp", ".media-00000009.json.0123456789ab.bak", ".media-00000009.json.tmp"]);
  });

  test("the staging folder is not the records' business: its files are left", async () => {
    await writeFile(join(stagingDir(), "staged-00000001.media"), "a copy an importer owns");
    await records().recover();
    expect(await readdir(stagingDir())).toEqual(["staged-00000001.media"]);
  });

  test("a media folder that is a link is not opened: nothing in it is read or removed", async () => {
    const other = join(tmp(), "other");
    await mkdir(other);
    await writeFile(join(other, "media-00000060.jpg"), "the owner's, with a name like ours");
    await rename(mediaDir(), join(tmp(), "real-media"));
    await symlink(other, mediaDir());
    const store = records();
    const report = await store.recover();
    expect(await readdir(other)).toEqual(["media-00000060.jpg"]);
    expect(store.list().total).toBe(0);
    expect(report.unusable).toBe(true);
  });

  test("no media folder yet is an empty library of own files, and nothing is made", async () => {
    await rename(mediaDir(), join(tmp(), "gone"));
    const store = records();
    const report = await store.recover();
    expect(store.list().total).toBe(0);
    expect(report).toMatchObject({ quarantinedOrphans: 0, quarantinedDangling: 0, problems: [] });
    expect(await readdir(root())).toEqual([]);
  });
});

describe("a record is removed with its file, and nothing else", () => {
  test("the record goes first, then the file; the media is no longer listed", async () => {
    const store = records();
    const summary = await store.commit(await photoInput());
    expect(await store.remove(summary.mediaId)).toBe(true);
    expect(await names(mediaDir())).toEqual([]);
    expect(store.list().total).toBe(0);
    expect(store.get(summary.mediaId)).toBeUndefined();
  });

  test("an id it does not hold is not a removal", async () => {
    const store = records();
    expect(await store.remove("media-00000404")).toBe(false);
  });

  test("an id that is not an id never reaches the disk", async () => {
    const store = records();
    await writeFile(join(tmp(), "victim.txt"), "the owner's");
    expect(await store.remove("../victim")).toBe(false);
    expect(await readFile(join(tmp(), "victim.txt"), "utf8")).toBe("the owner's");
  });

  test("the file replaced by a link to the owner's data: the link goes, the data stays", async () => {
    const store = records();
    const summary = await store.commit(await photoInput());
    const victim = join(tmp(), "victim.txt");
    await writeFile(victim, "the owner's data");
    await rename(join(mediaDir(), `${summary.mediaId}.jpg`), join(tmp(), "old.jpg"));
    await symlink(victim, join(mediaDir(), `${summary.mediaId}.jpg`));
    await store.remove(summary.mediaId);
    expect(await readFile(victim, "utf8")).toBe("the owner's data");
  });

  test("a file that cannot be removed is told once without its path, the record is gone, and the next open sweeps the file", async () => {
    const warned: string[] = [];
    const store = records({
      warn: (text) => warned.push(text),
      fs: {
        unlink: async (path) => {
          if (path.endsWith(".jpg")) throw Object.assign(new Error("busy"), { code: "EBUSY" });
          const { unlink } = await import("node:fs/promises");
          await unlink(path);
        },
        platform: "linux",
      },
    });
    const summary = await store.commit(await photoInput());
    expect(await store.remove(summary.mediaId)).toBe(true);
    expect(store.list().total).toBe(0);
    expect(await names(mediaDir())).toEqual([`${summary.mediaId}.jpg`]);
    expect(warned).toHaveLength(1);
    expect(warned[0]?.includes(tmp())).toBe(false);
    await records().recover();
    expect(await names(mediaDir())).toEqual([]);
  });

  test("a record that cannot be removed leaves everything as it was and says so", async () => {
    const store = records({
      fs: {
        unlink: async (path) => {
          if (path.endsWith(".json")) throw Object.assign(new Error("busy"), { code: "EBUSY" });
          const { unlink } = await import("node:fs/promises");
          await unlink(path);
        },
        platform: "linux",
      },
    });
    const summary = await store.commit(await photoInput());
    await expect(store.remove(summary.mediaId)).rejects.toThrow();
    expect(store.get(summary.mediaId)).toEqual(summary);
    expect(await names(mediaDir())).toEqual([`${summary.mediaId}.jpg`, `${summary.mediaId}.json`]);
  });
});

describe("the listing", () => {
  test("a kind filter lists that kind only, and the total is of that kind", async () => {
    const store = records();
    await store.commit(await photoInput());
    await store.commit({ sourcePath: await staged("v"), kind: "video", format: "mp4", name: "v.mp4", facts: VIDEO_FACTS });
    expect(store.list("video").media.map((m) => m.kind)).toEqual(["video"]);
    expect(store.list("video").total).toBe(1);
    expect(store.list().total).toBe(2);
    expect(store.list("audio")).toEqual({ media: [], total: 0 });
  });

  test("two records made in the same instant list the later one first, whatever their ids sort like", async () => {
    const queue = ["media-00000009", "media-00000008"];
    const store = records({ newId: () => queue.shift() ?? "media-00000001", now: () => new Date("2026-10-04T10:00:00.000Z") });
    const first = await store.commit(await photoInput({ name: "first.jpg" }));
    const second = await store.commit(await photoInput({ name: "second.jpg" }));
    expect(store.list().media.map((m) => m.mediaId)).toEqual([second.mediaId, first.mediaId]);
  });

  test("after a restart the same instant is listed by id, the same way every time", async () => {
    const queue = ["media-00000009", "media-00000008"];
    const store = records({ newId: () => queue.shift() ?? "media-00000001", now: () => new Date("2026-10-04T10:00:00.000Z") });
    await store.commit(await photoInput());
    await store.commit(await photoInput());
    const one = records();
    await one.recover();
    const two = records();
    await two.recover();
    expect(one.list().media.map((m) => m.mediaId)).toEqual(two.list().media.map((m) => m.mediaId));
    expect(one.list().total).toBe(2);
  });

  test("a listing is cut at MAX_LISTED_MEDIA and says how many there are", async () => {
    const store = records();
    const count = MAX_LISTED_MEDIA + 3;
    for (let i = 0; i < count; i++) await store.commit(await photoInput({ sourcePath: await staged(`p${i}`) }));
    const listing = store.list();
    expect(listing.media).toHaveLength(MAX_LISTED_MEDIA);
    expect(listing.total).toBe(count);
  }, 60_000);

  test("a media id is never handed out twice", async () => {
    const store = records({ newId: () => "media-00000001" });
    await store.commit(await photoInput());
    const again = await store.commit(await photoInput()).catch((e: unknown) => e);
    expect(again).toBeInstanceOf(MediaCommitError);
    expect(store.list().total).toBe(1);
  });
});

// Fix round 3, M1: a media that is being deleted is gone for every reader from the first moment of the delete, not from its last.
describe("a record that is being removed", () => {
  /** A store whose first unlink waits: the removal is parked between its start and its end. */
  function parked(): { store: MediaRecords; reached: Promise<void>; release: () => void } {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reach: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      reach = resolve;
    });
    let armed = false;
    const store = records({
      fs: {
        unlink: async (path) => {
          if (armed && path.endsWith(".json")) {
            reach();
            await gate;
          }
          const { unlink } = await import("node:fs/promises");
          await unlink(path);
        },
        platform: "linux",
      },
    });
    const arm = (): void => {
      armed = true;
    };
    return Object.assign({ store, reached, release }, { arm }) as never;
  }

  async function withParkedRemoval() {
    const rig = parked() as unknown as { store: MediaRecords; reached: Promise<void>; release: () => void; arm: () => void };
    const summary = await rig.store.commit(await photoInput());
    rig.arm();
    const removing = rig.store.remove(summary.mediaId);
    await rig.reached;
    return { ...rig, summary, removing };
  }

  test("is no longer found by anyone while its record is still on disk: get, has, lookup data, file path and listing", async () => {
    const { store, summary, release, removing } = await withParkedRemoval();
    expect(store.get(summary.mediaId)).toBeUndefined();
    expect(store.has(summary.mediaId)).toBe(false);
    expect(store.filePath(summary.mediaId)).toBeUndefined();
    expect(store.integrityOf(summary.mediaId)).toBeUndefined();
    expect(store.list()).toEqual({ media: [], total: 0 });
    release();
    expect(await removing).toBe(true);
    expect(await names(mediaDir())).toEqual([]);
  });

  test("is taken out before the removal's first await: a reader in the same tick already misses it", async () => {
    const store = records();
    const summary = await store.commit(await photoInput());
    const removing = store.remove(summary.mediaId);
    expect(store.has(summary.mediaId)).toBe(false);
    await removing;
  });

  test("a cleanup that runs meanwhile does not bring it back from its record on disk", async () => {
    const { store, summary, release, removing } = await withParkedRemoval();
    await store.recover();
    expect(store.get(summary.mediaId)).toBeUndefined();
    release();
    await removing;
    expect(store.list().total).toBe(0);
  });

  test("a media id being removed is not handed out again", async () => {
    const queue = ["media-00000001", "media-00000001", "media-00000002"];
    let armed = false;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reach: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      reach = resolve;
    });
    const store = records({
      newId: () => queue.shift() ?? "media-00000009",
      fs: {
        unlink: async (path) => {
          if (armed && path.endsWith(".json")) {
            reach();
            await gate;
          }
          const { unlink } = await import("node:fs/promises");
          await unlink(path);
        },
        platform: "linux",
      },
    });
    await store.commit(await photoInput());
    armed = true;
    const removing = store.remove("media-00000001");
    await reached;
    const again = await store.commit(await photoInput()).catch((e: unknown) => e);
    expect(again).toBeInstanceOf(MediaCommitError);
    release();
    await removing;
  });

  test("a removal that fails puts the media back as it was: found again, in the same place of the listing", async () => {
    const store = records({
      fs: {
        unlink: async (path) => {
          if (path.endsWith(".json")) throw Object.assign(new Error("busy"), { code: "EBUSY" });
          const { unlink } = await import("node:fs/promises");
          await unlink(path);
        },
        platform: "linux",
      },
    });
    const first = await store.commit(await photoInput({ name: "first.jpg" }));
    const second = await store.commit(await photoInput({ name: "second.jpg" }));
    await expect(store.remove(first.mediaId)).rejects.toThrow();
    expect(store.get(first.mediaId)).toEqual(first);
    expect(store.list().media.map((m) => m.mediaId)).toEqual([second.mediaId, first.mediaId]);
    expect(store.filePath(first.mediaId)).toBeDefined();
  });

  test("a folder that turns out unusable puts it back too", async () => {
    const store = records();
    const summary = await store.commit(await photoInput());
    await rename(mediaDir(), join(tmp(), "real-media"));
    await symlink(join(tmp(), "real-media"), mediaDir());
    await expect(store.remove(summary.mediaId)).rejects.toThrow();
    expect(store.has(summary.mediaId)).toBe(true);
  });

  test("two removals of one id at once: one deletes, the other finds nothing", async () => {
    const store = records();
    const summary = await store.commit(await photoInput());
    const both = await Promise.all([store.remove(summary.mediaId), store.remove(summary.mediaId)]);
    expect(both.sort()).toEqual([false, true]);
  });
});
