import { describe, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import type { Library } from "../library";
import type { CommitStep } from "./commit";
import { NODE_COMMIT_FS } from "./commitFs";
import { CommitTracker } from "./live";
import { writeIntent } from "./intents";
import { partNameOf, videoPaths } from "./record";
import { recoverVideos, type ExportRootRef, type RecoverInput } from "./recovery";
import {
  CrashError,
  errnoError,
  exportFiles,
  failureOf,
  fakeVideoBytes,
  FINAL,
  libraryVideoFiles,
  listTree,
  MARKER,
  rig,
  sampleRecord,
  useWorld,
  type Rig,
  type World,
} from "./testing/kit";
useNativeGlobals();

// Task 3a.8b.1: every crash window of the Commit row, played for real. A commit
// is killed after a given step (the fault layer makes every later disk call fail,
// so no cleanup runs: the disk is exactly what a dead process leaves), then the
// library is reopened and `recoverVideos` settles it. Each test asserts the disk
// before recovery (the window is what we say it is) and the state after it.

const world = useWorld();
const rootRef = (w: World): ExportRootRef => ({ root: w.exportRoot, rootId: w.rootId, caseInsensitive: false });
const PART = `Mia/${partNameOf("job-00000001")}`;
const RECORD = "video-00000001.json";
const INTENT = ".pending/video-00000001.json";
/** Intent temps carry a random suffix: `.<id>.json.<hex>.tmp`. */
const plain = (files: string[]): string[] => files.map((f) => f.replace(/\.[0-9a-f]{12}\.tmp$/, ".TMP"));

/** Runs a commit that dies right after `point`. Returns the rig; the disk is left as the crash left it. */
async function killedAt(point: CommitStep): Promise<Rig> {
  const r = await rig(world);
  await failureOf(
    r.run({
      hooks: {
        reached: (step) => {
          if (step === point) {
            r.fs.die();
            throw new CrashError(step);
          }
        },
      },
    }),
  );
  return r;
}

/** The library reopened (an engine restart) and the recovery run on it. */
async function recover(w: World, over: Partial<RecoverInput> = {}) {
  const library = await w.reopen();
  const report = await recoverVideos({ library, exportRoot: rootRef(w), ...over });
  return { library, report };
}

const usedIn = (library: Library, w: World): string[] => library.photoStates(w.avatar.id).get(w.photos[0]?.id ?? "")?.usedIn ?? [];

describe("crash windows: what the disk holds after the kill, and what recovery makes of it", () => {
  test("killed after verify (before the claim, step 2): only the temp exists, and it is swept", async () => {
    const r = await killedAt("verified");
    expect(await exportFiles(r.w)).toEqual([PART]);
    expect(await libraryVideoFiles(r.w)).toEqual([]);
    const { library, report } = await recover(r.w);
    expect(await exportFiles(r.w)).toEqual([]);
    expect(await libraryVideoFiles(r.w)).toEqual([]);
    expect(usedIn(library, r.w)).toEqual([]);
    expect(report.removed.partTemps).toBe(1);
  });

  test("killed after the temp's fsync: the same, only the temp", async () => {
    const r = await killedAt("temp-synced");
    expect(await exportFiles(r.w)).toEqual([PART]);
    await recover(r.w);
    expect(await exportFiles(r.w)).toEqual([]);
  });

  test("killed between the claim and the intent (3 and 4): an empty placeholder with no intent is deleted, and the temp swept", async () => {
    const r = await killedAt("name-claimed");
    expect(await exportFiles(r.w)).toEqual([PART, FINAL]);
    expect((await stat(join(r.w.exportRoot, FINAL))).size).toBe(0);
    expect(await libraryVideoFiles(r.w)).toEqual([]);
    const { library, report } = await recover(r.w);
    expect(await exportFiles(r.w)).toEqual([]);
    expect(usedIn(library, r.w)).toEqual([]);
    expect(report.removed).toMatchObject({ placeholders: 1, partTemps: 1 });
  });

  test("killed in the middle of writing the intent: the half-made intent temp is removed with the placeholder and the temp", async () => {
    const r = await killedAt("intent-temp-written");
    expect(plain(await libraryVideoFiles(r.w))).toEqual([".pending/.video-00000001.json.TMP"]);
    const { library, report } = await recover(r.w);
    expect(await exportFiles(r.w)).toEqual([]);
    expect(await libraryVideoFiles(r.w)).toEqual([]);
    expect(usedIn(library, r.w)).toEqual([]);
    expect(report.removed.intentTemps).toBe(1);
  });

  test("killed between the intent and the rename (4 and 5): an intent whose file is still 0 bytes; the intent and the placeholder go, the temp is swept", async () => {
    const r = await killedAt("intent-written");
    expect(await exportFiles(r.w)).toEqual([PART, FINAL]);
    expect(await libraryVideoFiles(r.w)).toEqual([INTENT]);
    const { library, report } = await recover(r.w);
    expect(await exportFiles(r.w)).toEqual([]);
    expect(await libraryVideoFiles(r.w)).toEqual([]);
    expect(usedIn(library, r.w)).toEqual([]);
    expect(report.dropped).toEqual([{ videoId: "video-00000001", reason: "empty-placeholder" }]);
  });

  test("killed after the rename (5 and 6): the file matches its intent's size and sha256, so the intent is ADOPTED as the record and the used index is updated", async () => {
    const r = await killedAt("renamed");
    expect(await exportFiles(r.w)).toEqual([FINAL]);
    expect(await libraryVideoFiles(r.w)).toEqual([INTENT]);
    const { library, report } = await recover(r.w);
    expect(await exportFiles(r.w)).toEqual([FINAL]);
    expect(readFileSync(join(r.w.exportRoot, FINAL))).toEqual(Buffer.from(r.bytes));
    expect(await libraryVideoFiles(r.w)).toEqual([RECORD]);
    expect(usedIn(library, r.w)).toEqual(["video-00000001"]);
    expect(report.adopted).toEqual(["video-00000001"]);
  });

  test("killed after the directory fsync, before the record: adopted the same way", async () => {
    const r = await killedAt("dir-synced");
    const { library } = await recover(r.w);
    expect(await libraryVideoFiles(r.w)).toEqual([RECORD]);
    expect(usedIn(library, r.w)).toEqual(["video-00000001"]);
  });

  test("killed after the record was committed: nothing to settle, and the record stands", async () => {
    const r = await killedAt("record-committed");
    expect(await libraryVideoFiles(r.w)).toEqual([RECORD]);
    const before = await readFile(videoPaths(r.w.libraryRoot, r.w.avatar.id).record("video-00000001"), "utf8");
    const { library, report } = await recover(r.w);
    expect(await readFile(videoPaths(r.w.libraryRoot, r.w.avatar.id).record("video-00000001"), "utf8")).toBe(before);
    expect(await exportFiles(r.w)).toEqual([FINAL]);
    expect(usedIn(library, r.w)).toEqual(["video-00000001"]);
    expect(report.adopted).toEqual([]);
  });

  test("a second recovery over a settled disk changes nothing (idempotent)", async () => {
    const r = await killedAt("renamed");
    await recover(r.w);
    const files = [await exportFiles(r.w), await libraryVideoFiles(r.w)];
    const { report } = await recover(r.w);
    expect([await exportFiles(r.w), await libraryVideoFiles(r.w)]).toEqual(files);
    expect(report.adopted).toEqual([]);
    expect(report.dropped).toEqual([]);
  });

  test("a record that was never adopted keeps the photos free: the intent alone does not count as used (before recovery)", async () => {
    const r = await killedAt("renamed");
    const library = await r.w.reopen();
    expect(usedIn(library, r.w)).toEqual([]);
  });
});

describe("intents recovery must not settle", () => {
  /** Plants an intent for `bytes` at `relPath`, as a commit killed after step 4 would. */
  async function plantIntent(w: World, over: Parameters<typeof sampleRecord>[1] = {}) {
    const record = sampleRecord(w, over);
    await writeIntent(NODE_COMMIT_FS, w.libraryRoot, record);
    return record;
  }
  function plantFile(w: World, relPath: string, bytes: Uint8Array | string): string {
    const path = join(w.exportRoot, ...relPath.split("/"));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, bytes);
    return path;
  }

  test("a file whose size matches the intent but whose bytes differ is NOT adopted: the intent is dropped and the file is left alone", async () => {
    const w = world();
    const record = await plantIntent(w);
    const other = fakeVideoBytes(2048, 99);
    const path = plantFile(w, record.file.relPath, other);
    const { library, report } = await recover(w);
    expect(readFileSync(path)).toEqual(Buffer.from(other));
    expect(await libraryVideoFiles(w)).toEqual([]);
    expect(usedIn(library, w)).toEqual([]);
    expect(report.dropped).toEqual([{ videoId: record.id, reason: "mismatch" }]);
  });

  test("a file of another size than the intent's, with no temp to prove it ours, is left alone and the intent dropped", async () => {
    const w = world();
    const record = await plantIntent(w);
    const path = plantFile(w, record.file.relPath, "half of something else");
    await recover(w);
    expect(readFileSync(path, "utf8")).toBe("half of something else");
    expect(await libraryVideoFiles(w)).toEqual([]);
  });

  test("a shorter file that is NOT a prefix of the surviving temp is not ours to delete", async () => {
    const w = world();
    const record = await plantIntent(w);
    const path = plantFile(w, record.file.relPath, fakeVideoBytes(500, 77));
    plantFile(w, `Mia/${partNameOf(record.jobId)}`, fakeVideoBytes(2048));
    await recover(w);
    expect(existsSync(path)).toBe(true);
    expect(await libraryVideoFiles(w)).toEqual([]);
  });

  test("a shorter file that is a prefix of a temp that is NOT the verified file is not ours to delete either", async () => {
    const w = world();
    const record = await plantIntent(w);
    const impostor = fakeVideoBytes(2048, 5); // the size of the verified file, other bytes
    const path = plantFile(w, record.file.relPath, impostor.subarray(0, 500));
    plantFile(w, `Mia/${partNameOf(record.jobId)}`, impostor);
    await recover(w);
    expect(existsSync(path)).toBe(true);
    expect(await libraryVideoFiles(w)).toEqual([]);
  });

  test("an intent whose file is gone is dropped", async () => {
    const w = world();
    const record = await plantIntent(w);
    const { report } = await recover(w);
    expect(await libraryVideoFiles(w)).toEqual([]);
    expect(report.dropped).toEqual([{ videoId: record.id, reason: "no-file" }]);
  });

  test("an intent whose folder is a symlink is dropped and nothing outside the export root is touched", async () => {
    const w = world();
    const outside = join(w.dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "2026-09-29_photo_001.mp4"), "");
    await plantIntent(w);
    symlinkSync(outside, join(w.exportRoot, "Mia"));
    await recover(w);
    expect(await listTree(outside)).toEqual(["2026-09-29_photo_001.mp4"]);
    expect(await libraryVideoFiles(w)).toEqual([]);
  });

  test("an intent whose file is a symlink is dropped, and its target is not touched", async () => {
    const w = world();
    await plantIntent(w);
    const target = join(w.dir, "target.mp4");
    writeFileSync(target, "");
    mkdirSync(join(w.exportRoot, "Mia"));
    symlinkSync(target, join(w.exportRoot, "Mia", "2026-09-29_photo_001.mp4"));
    await recover(w);
    expect(existsSync(target)).toBe(true);
    expect(await libraryVideoFiles(w)).toEqual([]);
  });

  test("an intent for a file in ANOTHER export root is kept for later: its file cannot be judged here, and nothing is dropped", async () => {
    const w = world();
    const record = await plantIntent(w, { rootId: "root-99999999" });
    const path = plantFile(w, record.file.relPath, "a file of this root, not the intent's");
    const { report } = await recover(w);
    expect(await libraryVideoFiles(w)).toEqual([INTENT]);
    expect(existsSync(path)).toBe(true);
    expect(report.deferred).toEqual([{ videoId: record.id, reason: "other-root" }]);
  });

  test("with no usable export folder, intents are kept and nothing in the export folder is touched", async () => {
    const w = world();
    await plantIntent(w);
    const { report } = await recover(w, { exportRoot: null });
    expect(await libraryVideoFiles(w)).toEqual([INTENT]);
    expect(report.deferred).toEqual([{ videoId: "video-00000001", reason: "export-unavailable" }]);
  });

  test("an intent that is not valid JSON is left in place and reported, never guessed at", async () => {
    const w = world();
    const paths = videoPaths(w.libraryRoot, w.avatar.id);
    await mkdir(paths.pendingDir, { recursive: true });
    await writeFile(paths.intent("video-00000001"), "{ not json");
    const { report } = await recover(w);
    expect(await readFile(paths.intent("video-00000001"), "utf8")).toBe("{ not json");
    expect(report.left).toEqual([{ file: `avatars/${w.avatar.id}/videos/.pending/video-00000001.json`, reason: "unreadable" }]);
  });

  test("an intent from a NEWER Studio is left in place: this build cannot judge it", async () => {
    const w = world();
    const paths = videoPaths(w.libraryRoot, w.avatar.id);
    await mkdir(paths.pendingDir, { recursive: true });
    await writeFile(paths.intent("video-00000001"), JSON.stringify({ schemaVersion: 2, id: "video-00000001" }));
    const { report } = await recover(w);
    expect(existsSync(paths.intent("video-00000001"))).toBe(true);
    expect(report.left).toMatchObject([{ reason: "too-new" }]);
  });

  test("an intent filed under another video id than its name says is left in place", async () => {
    const w = world();
    const record = sampleRecord(w, { videoId: "video-00000002" });
    const paths = videoPaths(w.libraryRoot, w.avatar.id);
    await mkdir(paths.pendingDir, { recursive: true });
    await writeFile(paths.intent("video-00000001"), JSON.stringify(record));
    const { report } = await recover(w);
    expect(existsSync(paths.intent("video-00000001"))).toBe(true);
    expect(report.left).toMatchObject([{ reason: "unreadable" }]);
  });

  test("an intent next to a record with the same id (a rename that was not flushed) is dropped, and the record stands", async () => {
    const w = world();
    const record = await plantIntent(w);
    const path = plantFile(w, record.file.relPath, fakeVideoBytes(2048));
    const paths = videoPaths(w.libraryRoot, w.avatar.id);
    await writeFile(paths.record(record.id), await readFile(paths.intent(record.id)));
    const { library } = await recover(w);
    expect(await libraryVideoFiles(w)).toEqual([RECORD]);
    expect(existsSync(path)).toBe(true);
    expect(usedIn(library, w)).toEqual([record.id]);
  });
});

describe("hands off: Studio deletes only what it can name", () => {
  const plant = (w: World, relPath: string, content: Uint8Array | string): string => {
    const path = join(w.exportRoot, ...relPath.split("/"));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
    return path;
  };

  test("the owner's files are all still there after a recovery: notes, real videos, empty files that are not our placeholders, files where we never write", async () => {
    const w = world();
    const keep: Array<[string, Uint8Array | string]> = [
      ["Mia/notes.txt", "my notes"],
      ["Mia/2026-09-29_photo_007.mp4", fakeVideoBytes(100)], // ours by name, but not empty
      ["Mia/holiday.mp4", ""], // empty, not our name
      ["Mia/2026-09-29_photo_8.mp4", ""], // a counter of one digit is not our name
      ["Mia/2026-09-29_Photo_009.mp4", ""], // a capital in the kind is not our name
      ["2026-09-29_photo_001.mp4", ""], // in the root itself, not in a <SafeName>/ folder
      ["My Videos/2026-09-29_photo_001.mp4", ""], // a folder that is not a SafeName
      ["Mia/deeper/2026-09-29_photo_001.mp4", ""], // one level too deep
      ["Mia/.studio-part-x.txt", ""], // not our temp's name
      [".studio-part-job-1.mp4.bak", "x"],
      ["Mia/.studio-probe-owner.txt", "content"], // a probe with content is not a probe
    ];
    const paths = keep.map(([rel, content]) => plant(w, rel, content));
    await recover(w);
    for (const [i, path] of paths.entries()) expect(existsSync(path), keep[i]?.[0]).toBe(true);
  });

  test("only zero-byte placeholders of our name in a real <SafeName>/ folder go, whichever of them are there", async () => {
    const w = world();
    plant(w, "Mia/2026-09-29_photo_001.mp4", "");
    plant(w, "Mia/2026-09-29_collage3_002.mp4", "");
    plant(w, "Ivy_2/2026-09-29_mix_123456.mp4", "");
    await recover(w);
    expect(await exportFiles(w)).toEqual([]);
  });

  test("a folder that is a symlink is never entered: a placeholder-looking file behind it stays", async () => {
    const w = world();
    const outside = join(w.dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "2026-09-29_photo_001.mp4"), "");
    writeFileSync(join(outside, ".studio-part-job-00000001.mp4"), "x");
    symlinkSync(outside, join(w.exportRoot, "Mia"));
    await recover(w);
    expect(await listTree(outside)).toEqual([".studio-part-job-00000001.mp4", "2026-09-29_photo_001.mp4"]);
  });

  test("a placeholder and a temp that belong to a job running right now are kept", async () => {
    const w = world();
    const placeholder = plant(w, "Mia/2026-09-29_photo_001.mp4", "");
    const temp = plant(w, `Mia/${partNameOf("job-00000005")}`, "x");
    const dead = plant(w, `Mia/${partNameOf("job-00000006")}`, "x");
    const live = new CommitTracker();
    live.addPlaceholder(placeholder);
    live.addTemp(temp);
    await recover(w, { live });
    expect(existsSync(placeholder)).toBe(true);
    expect(existsSync(temp)).toBe(true);
    expect(existsSync(dead)).toBe(false);
  });

  test("an export root that has vanished since it was checked defers its intents: the drive may only be unplugged", async () => {
    const w = world();
    const record = sampleRecord(w);
    await writeIntent(NODE_COMMIT_FS, w.libraryRoot, record);
    const { report } = await recover(w, { exportRoot: { ...rootRef(w), root: join(w.dir, "gone") } });
    expect(await libraryVideoFiles(w)).toEqual([INTENT]);
    expect(report.deferred).toEqual([{ videoId: record.id, reason: "export-unavailable" }]);
  });
});

describe("the root's own leftovers", () => {
  const MARKER_TMP = ".studio-export.json.tmp-2f9f5b0e-7a53-4c3e-9d0a-3c1f7b1d2e44";

  test("a marker temp from an interrupted publish (before the link) is swept, and the marker is untouched", async () => {
    const w = world();
    const before = readFileSync(join(w.exportRoot, MARKER), "utf8");
    writeFileSync(join(w.exportRoot, MARKER_TMP), "half a marker");
    await recover(w);
    expect(existsSync(join(w.exportRoot, MARKER_TMP))).toBe(false);
    expect(readFileSync(join(w.exportRoot, MARKER), "utf8")).toBe(before);
  });

  test("a marker with nlink > 1 whose same-inode .tmp sibling remains is healed: the sibling is removed, the marker keeps its content and has one link", async () => {
    const w = world();
    const before = readFileSync(join(w.exportRoot, MARKER), "utf8");
    linkSync(join(w.exportRoot, MARKER), join(w.exportRoot, MARKER_TMP));
    expect((await stat(join(w.exportRoot, MARKER))).nlink).toBe(2);
    await recover(w);
    expect(existsSync(join(w.exportRoot, MARKER_TMP))).toBe(false);
    expect((await stat(join(w.exportRoot, MARKER))).nlink).toBe(1);
    expect(readFileSync(join(w.exportRoot, MARKER), "utf8")).toBe(before);
  });

  test("a .tmp sibling that is hard-linked to something ELSE is not ours to remove", async () => {
    const w = world();
    writeFileSync(join(w.dir, "someone-elses"), "x");
    linkSync(join(w.dir, "someone-elses"), join(w.exportRoot, MARKER_TMP));
    await recover(w);
    expect(existsSync(join(w.exportRoot, MARKER_TMP))).toBe(true);
  });

  test("a 0-byte .studio-probe-* is swept, one with content is not", async () => {
    const w = world();
    writeFileSync(join(w.exportRoot, ".studio-probe-2f9f5b0e-7a53-4c3e-9d0a-3c1f7b1d2e44"), "");
    writeFileSync(join(w.exportRoot, ".studio-probe-case-abc123z"), "");
    writeFileSync(join(w.exportRoot, ".studio-probe-full"), "data");
    await recover(w);
    expect((await exportFiles(w)).sort()).toEqual([".studio-probe-full"]);
  });

  test("a temp with a name that only looks like the marker's is left alone", async () => {
    const w = world();
    writeFileSync(join(w.exportRoot, ".studio-export.json.tmp-not-a-uuid"), "x");
    writeFileSync(join(w.exportRoot, ".studio-export.json.bak"), "x");
    await recover(w);
    expect((await exportFiles(w)).sort()).toEqual([".studio-export.json.bak", ".studio-export.json.tmp-not-a-uuid"]);
  });

  test("the old timestamps do not matter: a temp is swept whatever its age", async () => {
    const w = world();
    const path = join(w.exportRoot, MARKER_TMP);
    writeFileSync(path, "x");
    utimesSync(path, new Date(0), new Date(0));
    await recover(w);
    expect(existsSync(path)).toBe(false);
  });
});
