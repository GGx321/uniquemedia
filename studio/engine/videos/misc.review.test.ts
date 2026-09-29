import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { CaseSensitivityProbe, NODE_CASE_PROBE_FS } from "../exportCase";
import { verifyAndHashMp4 } from "../verify";
import { VerifyIoError } from "../verify";
import { hashFile } from "./fileBytes";
import { collectForbiddenStrings, photoMetadataStrings } from "./forbiddenStrings";
import { VideoRecordSchema } from "./record";
import { recoverVideos } from "./recovery";
import { writeIntent } from "./intents";
import { NODE_COMMIT_FS } from "./commitFs";
import { fakeVideoBytes, libraryVideoFiles, sampleRecord, useWorld } from "./testing/kit";
useNativeGlobals();

// Review round 1 of 3a.8b.1, the smaller findings.

const world = useWorld();

describe("photoMetadataStrings is bounded on hostile EXIF (amplification)", () => {
  /** One APP1 segment: IFD0 with 256 Artist entries that all point at ONE 4 KiB field of 1365 distinct NUL-separated pieces. */
  function exifSegment(): number[] {
    const field: number[] = [];
    for (let k = 0; field.length + 3 <= 4096; k++) field.push(0x21 + (k % 90), 0x21 + (Math.floor(k / 90) % 90), 0);
    while (field.length < 4096) field.push(0x41);
    const entries = 256;
    const dataOff = 8 + 2 + entries * 12 + 4;
    const tiff: number[] = [0x49, 0x49, 42, 0, 8, 0, 0, 0, entries & 255, entries >> 8];
    for (let i = 0; i < entries; i++) tiff.push(0x3b, 0x01, 2, 0, 4096 & 255, 4096 >> 8, 0, 0, dataOff & 255, (dataOff >> 8) & 255, 0, 0);
    tiff.push(0, 0, 0, 0, ...field);
    const payload = [...Buffer.from("Exif\0\0", "latin1"), ...tiff];
    const length = payload.length + 2;
    return [0xff, 0xe1, length >> 8, length & 255, ...payload];
  }
  const hostile = (segments: number): Uint8Array => {
    const segment = exifSegment();
    const bytes: number[] = [0xff, 0xd8];
    for (let i = 0; i < segments; i++) for (const b of segment) bytes.push(b);
    bytes.push(0xff, 0xda, 0, 2, 0xff, 0xd9);
    return Uint8Array.from(bytes);
  };

  test("64 segments x 256 entries: fast, no throw, and a bounded number of strings", () => {
    const started = performance.now();
    const strings = photoMetadataStrings(hostile(64));
    expect(performance.now() - started).toBeLessThan(2000);
    expect(strings.length).toBeLessThanOrEqual(4096);
  });

  test("the whole list handed to the verifier stays within its own cap", async () => {
    const list = await collectForbiddenStrings(async () => hostile(64), ["photo-00000001", "photo-00000002"]);
    expect(list.length).toBeLessThanOrEqual(32);
  });

  test("a field that many entries point at is read once", () => {
    const strings = photoMetadataStrings(hostile(1));
    expect(new Set(strings).size).toBe(strings.length);
  });
});

describe("files are opened without following a symlink", () => {
  test("hashFile refuses a symlink", async () => {
    const dir = await mkdtemp(join(tmpdir(), "studio-nofollow-"));
    try {
      writeFileSync(join(dir, "real"), "bytes");
      symlinkSync(join(dir, "real"), join(dir, "link"));
      await expect(hashFile(join(dir, "link"))).rejects.toThrow();
      await expect(hashFile(join(dir, "real"))).resolves.toHaveLength(64);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("hashFile refuses a folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "studio-nofollow-"));
    try {
      await expect(hashFile(dir)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the verifier refuses a symlink to a file before it reads anything", async () => {
    const dir = await mkdtemp(join(tmpdir(), "studio-nofollow-"));
    try {
      writeFileSync(join(dir, "real.mp4"), fakeVideoBytes(100));
      symlinkSync(join(dir, "real.mp4"), join(dir, "link.mp4"));
      await expect(verifyAndHashMp4(join(dir, "link.mp4"), { frames: 30 })).rejects.toBeInstanceOf(VerifyIoError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the case probe never probes outside the root", () => {
  test("a root that does not exist yet is not judged by its parent: the cautious answer, nothing created, and not remembered", async () => {
    const dir = await mkdtemp(join(tmpdir(), "studio-case-"));
    try {
      const root = join(dir, "Movies", "Studio");
      mkdirSync(join(dir, "Movies"));
      const created: string[] = [];
      const probe = new CaseSensitivityProbe({ ...NODE_CASE_PROBE_FS, createExclusive: async (p) => (created.push(p), NODE_CASE_PROBE_FS.createExclusive(p)) });
      expect(await probe.isCaseInsensitive(root)).toBe(true);
      expect(created).toEqual([]);
      expect(await readdir(join(dir, "Movies"))).toEqual([]);
      mkdirSync(root);
      await probe.isCaseInsensitive(root);
      expect(created).toHaveLength(1); // probed once the root exists
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a failed probe logs its code", async () => {
    const logs: string[] = [];
    const probe = new CaseSensitivityProbe({ ...NODE_CASE_PROBE_FS, isDirectory: async () => true, createExclusive: () => Promise.reject(Object.assign(new Error("ro"), { code: "EROFS" })) }, undefined, (line) => logs.push(line));
    expect(await probe.isCaseInsensitive("/somewhere")).toBe(true);
    expect(logs.join("\n")).toContain("EROFS");
  });
});

describe("the record's spec is read loosely", () => {
  test("a field a later build added to the spec, a clip, a cell or a photo does not make a record unreadable, and is kept", () => {
    const w = world();
    const base = sampleRecord(w);
    const spec = JSON.parse(JSON.stringify(base.spec));
    spec.futureSpecField = { a: 1 };
    spec.clips[0].futureClipField = "x";
    spec.clips[0].cell.futureCellField = 2;
    spec.clips[0].cell.photo.futurePhotoField = true;
    const parsed = VideoRecordSchema.parse({ ...base, spec });
    expect(Reflect.get(parsed.spec, "futureSpecField")).toEqual({ a: 1 });
    expect(Reflect.get(parsed.spec.clips[0] ?? {}, "futureClipField")).toBe("x");
  });

  test("recovery adopts such an intent instead of leaving it unreadable", async () => {
    const w = world();
    const bytes = fakeVideoBytes(2048);
    const base = sampleRecord(w, { bytes });
    const record = VideoRecordSchema.parse({ ...base, spec: { ...base.spec, futureSpecField: 1 } });
    await writeIntent(NODE_COMMIT_FS, w.libraryRoot, record);
    mkdirSync(join(w.exportRoot, "Mia"), { recursive: true });
    writeFileSync(join(w.exportRoot, ...record.file.relPath.split("/")), bytes);
    const library = await w.reopen();
    const report = await recoverVideos({ library, exportRoot: { root: w.exportRoot, rootId: w.rootId, caseInsensitive: false } });
    expect(report.adopted).toEqual([record.id]);
    expect(await libraryVideoFiles(w)).toEqual([`${record.id}.json`]);
  });
});

describe("flagVideoIndexStale has its own reason", () => {
  test("the closed avatar says its index is stale, not that a record is broken, and a reload clears it", async () => {
    const w = world();
    w.library.flagVideoIndexStale(w.avatar.id, "video-00000001");
    let message = "";
    try {
      w.library.eligibleUnusedPhotos(w.avatar.id);
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toMatch(/index/i);
    expect(message).not.toMatch(/need repair|unreadable|cannot be read/i);
    await w.library.reloadVideoRecords(w.avatar.id);
    expect(w.library.eligibleUnusedPhotos(w.avatar.id)).toHaveLength(3);
  });

  test("it is not a problem 3e.2's repair could act on: the library reports it apart from unreadable records", () => {
    const w = world();
    w.library.flagVideoIndexStale(w.avatar.id, "video-00000001");
    expect(w.library.videoIndexStale(w.avatar.id)).toEqual(["video-00000001"]);
  });
});
