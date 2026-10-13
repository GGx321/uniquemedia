import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClipExportLine } from "../../shared/engine";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { clipFilePath, writeClipRecord } from "../clips/store";
import { readyRecord } from "../clips/testing/recordsRig";
import type { AvatarManifest } from "../library";
import { CLIP_EXPORT_KIND, highestNamedNumber, NODE_NUMBER_FS, type ExportNumberLibrary, type ExportNumberScope, type NumberFs } from "./exportNumbers";
useNativeGlobals();

// Stage 5, 5b.1, S5.V4c (plan s5b1 I5.55, §5.13 step 3): a clip's export is numbered like a render's file, and a number a clip record names is never reused, even when the owner has
// deleted that file in Finder. For the kind `clip` the scan also reads the clip records of EVERY avatar of the library (two avatars can share one export folder). For every render kind
// the numbering is byte-equal with and without clip records: the clips folders are not even read.

const ROOT_ID = "root-0000001";
const NINI = "avatar-aaaa-0001";
const MIA = "avatar-bbbb-0002";
const DAY = "2026-10-13";
const CLIP_SCOPE: ExportNumberScope = { rootId: ROOT_ID, folderName: "Nini", date: DAY, kind: CLIP_EXPORT_KIND, caseInsensitive: true };

let dir = "";
afterEach(async () => {
  if (dir !== "") await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  dir = "";
});

function libraryOf(...avatarIds: string[]): ExportNumberLibrary {
  return { listAvatars: () => avatarIds.map((id) => ({ id }) as AvatarManifest), namedVideoFiles: () => [], usageReasons: () => [] };
}

const line = (relPath: string, overrides: Partial<ClipExportLine> = {}): ClipExportLine => ({
  rootId: ROOT_ID,
  relPath,
  profile: "1080p30-interp",
  at: "2026-10-13T11:00:00.000Z",
  bytes: 2_000,
  sha256: "b".repeat(64),
  ...overrides,
});

/** A ready clip record of `avatarId` whose exports are `lines`; the files they name are NOT in any export folder (deleted in Finder, or never looked at). */
async function clipWith(avatarId: string, clipId: string, lines: ClipExportLine[]): Promise<void> {
  const clipsDir = join(dir, "avatars", avatarId, "clips");
  await mkdir(clipsDir, { recursive: true });
  await writeClipRecord(clipsDir, readyRecord({ id: clipId, avatarId, exports: lines }));
}

async function library(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "studio-export-numbers-clips-"));
  return dir;
}

const silent = (): void => undefined;

/** The real disk, with every folder it is asked to list written down. */
function listing(asked: string[]): NumberFs {
  return { ...NODE_NUMBER_FS, readdir: (path) => (asked.push(path), NODE_NUMBER_FS.readdir(path)) };
}

describe("the kind clip sees every avatar's clip exports", () => {
  test("a record naming …_clip_003.mp4 whose file is gone: the next number starts above it", async () => {
    const root = await library();
    await clipWith(NINI, "clip-0000001", [line(`Nini/${DAY}_clip_001.mp4`), line(`Nini/${DAY}_clip_003.mp4`)]);

    expect(await highestNamedNumber(libraryOf(NINI), root, CLIP_SCOPE, undefined, silent)).toBe(3);
  });

  test("another avatar's clip exporting into the same folder counts too", async () => {
    const root = await library();
    await clipWith(NINI, "clip-0000001", [line(`Nini/${DAY}_clip_002.mp4`)]);
    await clipWith(MIA, "clip-0000002", [line(`Nini/${DAY}_clip_007.mp4`)]);

    expect(await highestNamedNumber(libraryOf(NINI, MIA), root, CLIP_SCOPE, undefined, silent)).toBe(7);
  });

  test("a folder name is compared without letter case on such a volume", async () => {
    const root = await library();
    await clipWith(NINI, "clip-0000001", [line(`nini/${DAY}_clip_004.mp4`)]);

    expect(await highestNamedNumber(libraryOf(NINI), root, CLIP_SCOPE, undefined, silent)).toBe(4);
    expect(await highestNamedNumber(libraryOf(NINI), root, { ...CLIP_SCOPE, caseInsensitive: false }, undefined, silent)).toBe(0);
  });

  test("another export root, another folder or another day is not this scope's number", async () => {
    const root = await library();
    await clipWith(NINI, "clip-0000001", [
      line(`Nini/${DAY}_clip_009.mp4`, { rootId: "root-0000002" }),
      line(`Mia/${DAY}_clip_008.mp4`),
      line(`Nini/2026-10-12_clip_006.mp4`),
      line(`Nini/${DAY}_clip_002.mp4`),
    ]);

    expect(await highestNamedNumber(libraryOf(NINI), root, CLIP_SCOPE, undefined, silent)).toBe(2);
  });

  test("a clip record that does not read as one names nothing, and the others still count", async () => {
    const root = await library();
    await clipWith(NINI, "clip-0000001", [line(`Nini/${DAY}_clip_002.mp4`)]);
    await writeFile(join(dir, "avatars", NINI, "clips", "clip-0000009.json"), JSON.stringify({ exports: [line(`Nini/${DAY}_clip_050.mp4`)] }));

    expect(await highestNamedNumber(libraryOf(NINI), root, CLIP_SCOPE, undefined, silent)).toBe(2);
  });

  test("an avatar with no clips folder is no error", async () => {
    const root = await library();
    await clipWith(NINI, "clip-0000001", [line(`Nini/${DAY}_clip_001.mp4`)]);

    expect(await highestNamedNumber(libraryOf(NINI, MIA), root, CLIP_SCOPE, undefined, silent)).toBe(1);
  });

  test("only the records are read: the clip's mp4, poster and journal in the folder are not opened", async () => {
    const root = await library();
    await clipWith(NINI, "clip-0000001", [line(`Nini/${DAY}_clip_001.mp4`)]);
    const clipsDir = join(dir, "avatars", NINI, "clips");
    await writeFile(clipFilePath(clipsDir, "clip-0000001"), "not json");
    await writeFile(join(clipsDir, "clip-0000001.journal.jsonl"), `${JSON.stringify({ exports: [line(`Nini/${DAY}_clip_040.mp4`)] })}\n`);
    const read: string[] = [];
    const fs: NumberFs = { ...NODE_NUMBER_FS, readFile: (path) => (read.push(path), NODE_NUMBER_FS.readFile(path)) };

    expect(await highestNamedNumber(libraryOf(NINI), root, CLIP_SCOPE, undefined, silent, fs)).toBe(1);
    expect(read.every((path) => path.endsWith(".json"))).toBe(true);
  });
});

describe("every render kind numbers byte-equal, with or without clip records", () => {
  test.each(["photo", "collage3", "mix"])("%s: a clip record, even one naming a %s file, moves nothing, and no clips folder is read", async (kind) => {
    const root = await library();
    const scope: ExportNumberScope = { ...CLIP_SCOPE, kind };
    const without: string[] = [];
    const before = await highestNamedNumber(libraryOf(NINI, MIA), root, scope, undefined, silent, listing(without));
    await clipWith(NINI, "clip-0000001", [line(`Nini/${DAY}_${kind}_009.mp4`), line(`Nini/${DAY}_clip_003.mp4`)]);
    const withClips: string[] = [];

    expect(await highestNamedNumber(libraryOf(NINI, MIA), root, scope, undefined, silent, listing(withClips))).toBe(before);
    expect(withClips).toEqual(without);
    expect(withClips.some((path) => path.endsWith("clips"))).toBe(false);
  });
});

describe("the signal", () => {
  test("a cancel while the clips are read comes out as the signal's reason", async () => {
    const root = await library();
    await clipWith(NINI, "clip-0000001", [line(`Nini/${DAY}_clip_001.mp4`)]);
    const stop = new AbortController();
    const reason = new Error("the deadline");
    const fs: NumberFs = {
      ...NODE_NUMBER_FS,
      readdir: async (path) => {
        if (path.endsWith("clips")) stop.abort(reason);
        return NODE_NUMBER_FS.readdir(path);
      },
    };

    await expect(highestNamedNumber(libraryOf(NINI), root, CLIP_SCOPE, stop.signal, silent, fs)).rejects.toBe(reason);
  });
});
