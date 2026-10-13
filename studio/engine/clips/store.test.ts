import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tempDirFor } from "../../testing/tempDir";
import { relativePosix } from "../../testing/posixPath";
import { isTempName } from "../library/durableFs";
import { CLIPS_DIR } from "../library/layout";
import type { ClipRecord } from "./schemas";
import { clipsDirOf, ensureClipsDir, journalOf, posterTempPath, readClipRecord, removeJournal, writeClipRecord } from "./store";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.1, S5.V4a1 (plan s5b1 §5.3, I5.53): where a clip's files live and how the record and the journal reach the disk. The record is the commit, written atomically (a temp
// sibling, an fsync, a rename, a folder flush) and checked by the strict schema BEFORE it is written; the journal is removed once the record stands.

const dir = tempDirFor({ beforeEach, afterEach }, "studio-clip-store-");
const AT = "2026-10-13T10:00:00.000Z";
const ID = "clip-0000001";

function record(overrides: Partial<ClipRecord> = {}): ClipRecord {
  return {
    schemaVersion: 1,
    id: ID,
    avatarId: "avatar-aaaa-0001",
    sourcePhotoId: "photo-0001",
    createdAt: AT,
    seen: false,
    motion: { source: "code", label: "Моргает и улыбается", text: "she slowly blinks and gives a small smile" },
    request: { model: "kling", quality: "std", seconds: 5, fallback: "auto" },
    provider: { model: "kling-std", attempts: [{ attemptId: `${ID}:video#1`, outcome: "refused", providerCostMicros: 0, costSource: "proof" }] },
    recovered: false,
    exports: [],
    outcome: { status: "failed", reason: "refused-free" },
    ...overrides,
  };
}

describe("clipsDirOf", () => {
  test("is the avatar's own `clips` folder, by the library's own naming", () => {
    const library = { avatarDirPath: (avatarId: string) => join(dir(), "avatars", avatarId) };
    expect(relativePosix(dir(), clipsDirOf(library, "avatar-aaaa-0001"))).toBe(`avatars/avatar-aaaa-0001/${CLIPS_DIR}`);
  });
});

describe("ensureClipsDir", () => {
  test("makes the folder, and a second call is a no-op", async () => {
    const clips = join(dir(), "avatar", CLIPS_DIR);
    await mkdir(join(dir(), "avatar"));
    await ensureClipsDir(clips);
    await ensureClipsDir(clips);
    expect(await readdir(join(dir(), "avatar"))).toEqual([CLIPS_DIR]);
  });
});

describe("writeClipRecord", () => {
  test("writes `<clipId>.json` and leaves no temp file behind", async () => {
    await writeClipRecord(dir(), record());
    expect(await readdir(dir())).toEqual([`${ID}.json`]);
    expect(JSON.parse(await readFile(join(dir(), `${ID}.json`), "utf8"))).toEqual(record());
  });

  test("refuses a record that breaks the schema, and writes nothing", async () => {
    const broken = { ...record(), outcome: { status: "failed", reason: "no-such-reason" } } as unknown as ClipRecord;
    await expect(writeClipRecord(dir(), broken)).rejects.toThrow();
    expect(await readdir(dir())).toEqual([]);
  });

  test("a rewrite replaces the record whole (the `seen` flag, say)", async () => {
    await writeClipRecord(dir(), record());
    await writeClipRecord(dir(), record({ seen: true }));
    expect(JSON.parse(await readFile(join(dir(), `${ID}.json`), "utf8"))).toMatchObject({ seen: true });
    expect(await readdir(dir())).toEqual([`${ID}.json`]);
  });
});

describe("readClipRecord", () => {
  test("answers the record it wrote", async () => {
    await writeClipRecord(dir(), record());
    expect(await readClipRecord(dir(), ID)).toEqual({ kind: "record", record: record() });
  });

  test("answers `missing` when there is none", async () => {
    expect(await readClipRecord(dir(), ID)).toEqual({ kind: "missing" });
  });

  test("answers `invalid` for a file that does not parse, or breaks the strict schema", async () => {
    await writeFile(join(dir(), `${ID}.json`), "{ not json");
    expect(await readClipRecord(dir(), ID)).toEqual({ kind: "invalid" });
    await writeFile(join(dir(), `${ID}.json`), JSON.stringify({ ...record(), extra: 1 }));
    expect(await readClipRecord(dir(), ID)).toEqual({ kind: "invalid" });
  });
});

describe("the journal", () => {
  test("lives at `<clipId>.journal.jsonl`, and its lines read back", async () => {
    const journal = journalOf(dir(), ID);
    await journal.requested({ clipId: ID, photoId: "photo-0001", request: record().request, motion: record().motion, acceptedWorstMicros: 850_000, at: AT });
    expect(await readdir(dir())).toEqual([`${ID}.journal.jsonl`]);
    expect((await journal.read()).map((line) => line.type)).toEqual(["requested"]);
  });

  test("removeJournal removes it, and a journal that is not there is fine", async () => {
    const journal = journalOf(dir(), ID);
    await journal.requested({ clipId: ID, photoId: "photo-0001", request: record().request, motion: record().motion, acceptedWorstMicros: 850_000, at: AT });
    await removeJournal(dir(), ID);
    await removeJournal(dir(), ID);
    expect(await readdir(dir())).toEqual([]);
  });
});

describe("posterTempPath", () => {
  test("is a fresh temp name in the clips folder, never the poster's own name", () => {
    const first = posterTempPath(dir(), ID);
    const second = posterTempPath(dir(), ID);
    expect(first).not.toBe(second);
    expect(relativePosix(dir(), first).includes("/")).toBe(false);
    expect(isTempName(basename(first))).toBe(true);
    expect(basename(first)).not.toBe(`${ID}.poster.jpg`);
  });
});
