import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { writeIntent } from "./intents";
import { videoPaths, VideoRecordSchema, VideoRecordWriteSchema } from "./record";
import { fakeVideoBytes, faultyFs, readText, sampleRecord, sha256Of, specOf, useWorld } from "./testing/kit";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 4, S4.1 (plan §8.3, D5): a video record gains `origin`, `launchId` and `launchVideoKey` WITHOUT a schema bump. The record is loose and write-once, so a record
// from before Stage 4 stays valid, an older build ignores the new fields, and the intent (the same JSON, held at `.pending/` until its commit) carries them too. They are
// informational: a value this build cannot read must never make the record, and so the avatar's usage, unreadable.

const good = () => ({
  schemaVersion: 1,
  id: "video-00000001",
  avatarId: "avatar-00000001",
  jobId: "job-00000001",
  createdAt: "2026-10-08T10:00:00.000Z",
  kind: "photo",
  durationMs: 1000,
  frames: 30,
  montageId: null,
  music: null,
  file: { rootId: "root-00000001", relPath: "Mia/2026-10-08_photo_001.mp4", bytes: 10, sha256: sha256Of(fakeVideoBytes(10)) },
  spec: specOf("avatar-00000001", ["photo-00000001"]),
});
const provenance = { origin: "autopilot" as const, launchId: "launch-0a1b2c3d4e5f", launchVideoKey: "1-5" };

describe("the record's provenance", () => {
  test("a record from before Stage 4 is valid and gains no provenance", () => {
    const parsed = VideoRecordSchema.parse(good());
    expect(parsed.origin).toBeUndefined();
    expect(parsed.launchId).toBeUndefined();
    expect(parsed.launchVideoKey).toBeUndefined();
  });

  test("an autopilot record keeps its origin, its launch and its video key", () => {
    const parsed = VideoRecordSchema.parse({ ...good(), ...provenance });
    expect(parsed.origin).toBe("autopilot");
    expect(parsed.launchId).toBe("launch-0a1b2c3d4e5f");
    expect(parsed.launchVideoKey).toBe("1-5");
  });

  test("the schema version is not bumped: a record with provenance is still version 1", () => {
    expect(VideoRecordSchema.safeParse({ ...good(), ...provenance }).success).toBe(true);
    expect(VideoRecordSchema.safeParse({ ...good(), ...provenance, schemaVersion: 2 }).success).toBe(false);
  });

  test("each provenance field is optional on its own", () => {
    for (const key of Object.keys(provenance)) {
      const partial = Object.fromEntries(Object.entries(provenance).filter(([k]) => k === key));
      expect(VideoRecordSchema.safeParse({ ...good(), ...partial }).success).toBe(true);
    }
  });

  test.each([
    ["an origin this build does not know", { origin: "scheduler" }],
    ["an origin that is not a string", { origin: 7 }],
    ["a launch id that is a path", { launchId: "../launch" }],
    ["a launch id of another kind", { launchId: "run-0a1b2c3d4e5f" }],
    ["a video key out of range", { launchVideoKey: "3-51" }],
    ["a video key that is a number", { launchVideoKey: 12 }],
  ])("a record with %s is unreadable: usage then becomes unknown, the existing safe path (a dropped key would let a second video be made for it)", (_name, patch) => {
    expect(VideoRecordSchema.safeParse(good()).success).toBe(true);
    expect(VideoRecordSchema.safeParse({ ...good(), ...patch }).success).toBe(false);
  });

  test("a good field beside a bad one does not rescue the record", () => {
    expect(VideoRecordSchema.safeParse({ ...good(), origin: "autopilot", launchId: "../launch", launchVideoKey: "0-1" }).success).toBe(false);
  });
});

describe("what is written", () => {
  test("provenance is all three fields or none", () => {
    expect(VideoRecordWriteSchema.safeParse(good()).success).toBe(true);
    expect(VideoRecordWriteSchema.safeParse({ ...good(), ...provenance }).success).toBe(true);
    for (const key of Object.keys(provenance)) {
      const partial = Object.fromEntries(Object.entries(provenance).filter(([k]) => k !== key));
      expect(VideoRecordWriteSchema.safeParse({ ...good(), ...partial }).success).toBe(false);
    }
  });

  const world = useWorld();

  test("an intent whose key is malformed is refused and leaves no file", async () => {
    const w = world();
    const record = { ...sampleRecord(w), ...provenance, launchVideoKey: "3-51" };
    await expect(writeIntent(faultyFs(), w.libraryRoot, record)).rejects.toBeDefined();
    const paths = videoPaths(w.libraryRoot, w.avatar.id);
    expect(await readdir(paths.pendingDir).catch(() => [])).toEqual([]);
  });

  test("an intent with partial provenance is refused; with all three it is written and keeps them", async () => {
    const w = world();
    const base = sampleRecord(w);
    await expect(writeIntent(faultyFs(), w.libraryRoot, { ...base, origin: "autopilot" })).rejects.toBeDefined();
    await writeIntent(faultyFs(), w.libraryRoot, { ...base, ...provenance });
    const paths = videoPaths(w.libraryRoot, w.avatar.id);
    expect(JSON.parse(await readText(paths.intent(base.id)))).toMatchObject(provenance);
  });
});
