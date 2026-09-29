import { describe, expect, test } from "bun:test";
import { mkdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { hashFile } from "./fileBytes";
import { FileStateChecker, newHashBudget } from "./fileState";
import type { VideoRecord } from "./record";
import type { ExportRootRef } from "./recovery";
import { fakeVideoBytes, sampleRecord, useWorld, type World } from "./testing/kit";
useNativeGlobals();

// Task 3a.8b.1: where a record's file stands, derived on read and never stored.
// Cost: a listing is one lstat per record. A hash is taken only when a stat
// cannot tell (the record's mtime does not match, or was never stored), at most
// `budget` bytes per listing; `delete` always asks for the full check.

const world = useWorld();
const rootRef = (w: World): ExportRootRef => ({ root: w.exportRoot, rootId: w.rootId, caseInsensitive: false });

function place(w: World, record: VideoRecord, bytes: Uint8Array): string {
  const path = join(w.exportRoot, ...record.file.relPath.split("/"));
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

/** A checker that counts the hashes it takes. */
function counting() {
  const hashed: string[] = [];
  const checker = new FileStateChecker({
    hashFile: (path) => {
      hashed.push(path);
      return hashFile(path);
    },
  });
  return { checker, hashed };
}

describe("cheap check: one stat, no hash when the record's mtime matches", () => {
  test("present: the file's size and mtime are what the record stored, and nothing is hashed", async () => {
    const w = world();
    const bytes = fakeVideoBytes(2048);
    const path = place(w, sampleRecord(w, { bytes }), bytes);
    const mtimeMs = Math.floor((await Bun.file(path).stat()).mtimeMs);
    const record = sampleRecord(w, { bytes, mtimeMs });
    const { checker, hashed } = counting();
    expect(await checker.check(record, rootRef(w), { verify: "cheap" })).toBe("present");
    expect(hashed).toEqual([]);
  });

  test("changed: a different size is caught by the stat alone", async () => {
    const w = world();
    const record = sampleRecord(w, { mtimeMs: 1 });
    place(w, record, fakeVideoBytes(2049));
    const { checker, hashed } = counting();
    expect(await checker.check(record, rootRef(w), { verify: "cheap" })).toBe("changed");
    expect(hashed).toEqual([]);
  });

  test("missing: no file where the record says", async () => {
    const w = world();
    const { checker } = counting();
    expect(await checker.check(sampleRecord(w), rootRef(w), { verify: "cheap" })).toBe("missing");
  });

  test("missing: not even the avatar's folder", async () => {
    const w = world();
    const record = sampleRecord(w);
    place(w, record, fakeVideoBytes(2048));
    rmSync(join(w.exportRoot, "Mia"), { recursive: true });
    expect(await new FileStateChecker().check(record, rootRef(w), { verify: "cheap" })).toBe("missing");
  });
});

describe("when a stat cannot tell, a hash decides, within a budget", () => {
  test("a record with no stored mtime is hashed once; a later check is answered from the cache", async () => {
    const w = world();
    const bytes = fakeVideoBytes(2048);
    const record = sampleRecord(w, { bytes });
    place(w, record, bytes);
    const { checker, hashed } = counting();
    expect(await checker.check(record, rootRef(w), { verify: "cheap" })).toBe("present");
    expect(await checker.check(record, rootRef(w), { verify: "cheap" })).toBe("present");
    expect(hashed).toHaveLength(1);
  });

  test("a file moved by the owner (other mtime, same bytes) is present after one hash", async () => {
    const w = world();
    const bytes = fakeVideoBytes(2048);
    const record = sampleRecord(w, { bytes, mtimeMs: 1_000 });
    place(w, record, bytes);
    expect(await new FileStateChecker().check(record, rootRef(w), { verify: "cheap" })).toBe("present");
  });

  test("changed: the same size and another mtime with other bytes is caught by the hash", async () => {
    const w = world();
    const record = sampleRecord(w, { mtimeMs: 1_000 });
    place(w, record, fakeVideoBytes(2048, 42));
    expect(await new FileStateChecker().check(record, rootRef(w), { verify: "cheap" })).toBe("changed");
  });

  test("a cached verdict is dropped when the file's mtime moves: the hash is taken again", async () => {
    const w = world();
    const bytes = fakeVideoBytes(2048);
    const record = sampleRecord(w, { bytes });
    const path = place(w, record, bytes);
    const { checker, hashed } = counting();
    await checker.check(record, rootRef(w), { verify: "cheap" });
    utimesSync(path, new Date(2_000_000_000_000), new Date(2_000_000_000_000));
    await checker.check(record, rootRef(w), { verify: "cheap" });
    expect(hashed).toHaveLength(2);
  });

  test("the budget bounds a listing: past it a size match reads as present without a hash", async () => {
    const w = world();
    const bytes = fakeVideoBytes(2 * 1024 * 1024);
    const records = ["a", "b", "c"].map((letter, i) => sampleRecord(w, { bytes, videoId: `video-0000000${i + 1}`, relPath: `Mia/2026-09-29_photo_00${i + 1}.mp4`, jobId: `job-0000000${letter === "a" ? 1 : 2}` }));
    for (const record of records) place(w, record, bytes);
    const { checker, hashed } = counting();
    const budget = newHashBudget(3 * 1024 * 1024);
    const states = [];
    for (const record of records) states.push(await checker.check(record, rootRef(w), { verify: "cheap", budget }));
    expect(states).toEqual(["present", "present", "present"]);
    expect(hashed).toHaveLength(1); // 2 MiB fits in 3 MiB; the next 2 MiB does not
  });

  test("a budget-limited check that finds a size mismatch still says changed: the stat does not need the budget", async () => {
    const w = world();
    const record = sampleRecord(w);
    place(w, record, fakeVideoBytes(2049));
    const state = await new FileStateChecker().check(record, rootRef(w), { verify: "cheap", budget: newHashBudget(0) });
    expect(state).toBe("changed");
  });
});

describe("full check (what delete asks for)", () => {
  test("catches a same-size edit that kept the mtime, which the cheap check cannot see", async () => {
    const w = world();
    const bytes = fakeVideoBytes(2048);
    const path = place(w, sampleRecord(w, { bytes }), bytes);
    const mtimeMs = Math.floor((await Bun.file(path).stat()).mtimeMs);
    const record = sampleRecord(w, { bytes, mtimeMs });
    const edited = Uint8Array.from(bytes);
    edited[7] = (edited[7] ?? 0) ^ 0xff;
    writeFileSync(path, edited);
    utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
    const checker = new FileStateChecker();
    expect(await checker.check(record, rootRef(w), { verify: "cheap" })).toBe("present");
    expect(await checker.check(record, rootRef(w), { verify: "full" })).toBe("changed");
  });

  test("hashes every time, whatever the cache holds", async () => {
    const w = world();
    const bytes = fakeVideoBytes(2048);
    const record = sampleRecord(w, { bytes });
    place(w, record, bytes);
    const { checker, hashed } = counting();
    await checker.check(record, rootRef(w), { verify: "full" });
    await checker.check(record, rootRef(w), { verify: "full" });
    expect(hashed).toHaveLength(2);
  });
});

describe("where the record's root is not this root", () => {
  test("elsewhere: the record names another export root", async () => {
    const w = world();
    const record = sampleRecord(w, { rootId: "root-99999999" });
    place(w, record, fakeVideoBytes(2048));
    expect(await new FileStateChecker().check(record, rootRef(w), { verify: "full" })).toBe("elsewhere");
  });

  test("elsewhere: no usable export root at all (the folder cannot be judged, so the file is not called deleted)", async () => {
    const w = world();
    expect(await new FileStateChecker().check(sampleRecord(w), null, { verify: "cheap" })).toBe("elsewhere");
  });
});

describe("links are never followed", () => {
  test("changed: the avatar's folder is a symlink now, even if the file is reachable through it", async () => {
    const w = world();
    const bytes = fakeVideoBytes(2048);
    const record = sampleRecord(w, { bytes });
    place(w, record, bytes);
    renameSync(join(w.exportRoot, "Mia"), join(w.dir, "moved"));
    symlinkSync(join(w.dir, "moved"), join(w.exportRoot, "Mia"));
    expect(await new FileStateChecker().check(record, rootRef(w), { verify: "full" })).toBe("changed");
  });

  test("changed: the file is a symlink to a file with the right bytes", async () => {
    const w = world();
    const bytes = fakeVideoBytes(2048);
    const record = sampleRecord(w, { bytes });
    writeFileSync(join(w.dir, "real.mp4"), bytes);
    mkdirSync(join(w.exportRoot, "Mia"));
    symlinkSync(join(w.dir, "real.mp4"), join(w.exportRoot, "Mia", "2026-09-29_photo_001.mp4"));
    expect(await new FileStateChecker().check(record, rootRef(w), { verify: "full" })).toBe("changed");
  });

  test("changed: a folder where the file should be", async () => {
    const w = world();
    mkdirSync(join(w.exportRoot, "Mia", "2026-09-29_photo_001.mp4"), { recursive: true });
    expect(await new FileStateChecker().check(sampleRecord(w), rootRef(w), { verify: "full" })).toBe("changed");
  });
});
