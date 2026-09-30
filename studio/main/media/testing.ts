import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "bun:test";
import { EXPORT_MARKER_FILE } from "../../engine/exportRoot";
import { parseRecordSpec, type VideoRecord } from "../../engine/videos/record";
import { specOf } from "../../engine/videos/testing/kit";
import { RelativePath } from "../../shared/engine";

// Test-only: the smallest world the media route tests need, made of plain folders. `useWorld()` (the video kit) opens a
// real library and adds photos with fsyncs, which on a Windows runner can pass the 5 s a hook is given; nothing under
// ./media needs a library, only its folder layout, an export folder with a marker, and a record.

export const AVATAR_ID = "avatar-0001";
export const ROOT_ID = "root-00000001";

export interface MediaWorld {
  readonly dir: string;
  readonly libraryRoot: string;
  readonly exportRoot: string;
  readonly avatarId: string;
  readonly rootId: string;
}

/** A fresh temp world per test: `library/avatars/<avatar>/{photos,videos}`, and `export/` holding a valid marker. */
export function useMediaWorld(): () => MediaWorld {
  let world: MediaWorld | undefined;
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "studio-media-world-"));
    const libraryRoot = join(dir, "library");
    const exportRoot = join(dir, "export");
    await mkdir(join(libraryRoot, "avatars", AVATAR_ID, "photos"), { recursive: true });
    await mkdir(join(libraryRoot, "avatars", AVATAR_ID, "videos"), { recursive: true });
    await mkdir(exportRoot, { recursive: true });
    await writeFile(join(exportRoot, EXPORT_MARKER_FILE), JSON.stringify({ schemaVersion: 1, rootId: ROOT_ID, createdAt: "2026-09-29T10:00:00.000Z" }));
    world = { dir, libraryRoot, exportRoot, avatarId: AVATAR_ID, rootId: ROOT_ID };
  });
  afterEach(async () => {
    world = undefined;
    await rm(dir, { recursive: true, force: true });
  });
  return () => {
    if (world === undefined) throw new Error("the world exists only inside a test");
    return world;
  };
}

export interface RecordOptions {
  videoId: string;
  relPath: string;
  bytes: Uint8Array;
  rootId?: string;
}

/** A complete video record for `bytes` at `relPath`, valid per the record schema. */
export function recordFor(world: MediaWorld, options: RecordOptions): VideoRecord {
  return {
    schemaVersion: 1,
    id: options.videoId,
    avatarId: world.avatarId,
    jobId: "job-00000001",
    createdAt: "2026-09-29T10:00:00.000Z",
    kind: "photo",
    durationMs: 1000,
    frames: 30,
    montageId: null,
    music: null,
    file: {
      rootId: options.rootId ?? world.rootId,
      relPath: RelativePath.parse(options.relPath),
      bytes: options.bytes.length,
      sha256: createHash("sha256").update(options.bytes).digest("hex"),
    },
    spec: parseRecordSpec(specOf(world.avatarId, ["photo-00000001"])),
  };
}
