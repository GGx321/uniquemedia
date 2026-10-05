import { describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { SAMPLE_AVATAR } from "../library/testing/helpers";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { RenderFailure } from "../renderQueue/queue";
import type { VerifiedFile } from "../verify";
import { NODE_COMMIT_FS } from "./commitFs";
import { NODE_NUMBER_FS } from "./exportNumbers";
import { commitIntent, writeIntent } from "./intents";
import { commitVideo, mayHaveLeftIntent, VerifyRefusedError, type CommitInput, type CommitStep } from "./commit";
import { videoPaths, VideoRecordSchema } from "./record";
import {
  acceptingVerify,
  errnoError,
  exportFiles,
  failureOf,
  fakeVideoBytes,
  faultyFs,
  FINAL,
  libraryVideoFiles,
  listTree,
  openFolder,
  rig,
  sampleRecord,
  sha256Of,
  useWorld,
  writeTemp,
  type World,
} from "./testing/kit";
useNativeGlobals();

// Task 3a.8b.1: the commit pipeline (Commit row, steps 2-6), on the real disk
// with a fault layer in front of it. Crash windows and recovery are in
// recovery.test.ts; this file is the live path: order, refusals, cancel, and the
// failure modes that must roll back cleanly.

const world = useWorld();

describe("the commit's happy path", () => {
  test("puts the verified bytes under the claimed name, and the temp is gone", async () => {
    const r = await rig(world);
    const out = await r.run();
    expect(out.record.file.relPath).toBe(FINAL);
    expect(readFileSync(join(r.w.exportRoot, FINAL))).toEqual(Buffer.from(r.bytes));
    expect(await exportFiles(r.w)).toEqual([FINAL]);
  });

  test("commits a record that names the file by root id and relative path, with its size, sha256 and mtime", async () => {
    const r = await rig(world);
    const out = await r.run();
    const onDisk = VideoRecordSchema.parse(JSON.parse(readFileSync(videoPaths(r.w.libraryRoot, r.w.avatar.id).record(r.input.videoId), "utf8")));
    expect(onDisk).toEqual(out.record);
    expect(onDisk.file).toMatchObject({ rootId: r.w.rootId, relPath: FINAL, bytes: r.bytes.length, sha256: sha256Of(r.bytes) });
    expect(onDisk.file.mtimeMs).toBe(Math.floor((await r.fs.lstat(join(r.w.exportRoot, FINAL))).mtimeMs));
    expect(onDisk).toMatchObject({ id: r.input.videoId, avatarId: r.w.avatar.id, jobId: r.input.jobId, kind: "photo", frames: 30, durationMs: 1000 });
  });

  test("leaves no intent: the library's videos/ folder holds the record alone", async () => {
    const r = await rig(world);
    await r.run();
    expect(await libraryVideoFiles(r.w)).toEqual([`${r.input.videoId}.json`]);
  });

  test("returns the job's RenderResult: video id, avatar, size, duration, kind and relative path", async () => {
    const r = await rig(world);
    const out = await r.run();
    expect(out.result).toEqual({ kind: "render", videoId: r.input.videoId, avatarId: r.w.avatar.id, bytes: r.bytes.length, durationMs: 1000, videoKind: "photo", relPath: FINAL });
  });

  test("the record it wrote makes the photos used when the library is opened again (invariant 24)", async () => {
    const r = await rig(world);
    await r.run();
    const reopened = await r.w.reopen();
    expect(reopened.photoStates(r.w.avatar.id).get(r.w.photos[0]?.id ?? "")?.usedIn).toEqual([r.input.videoId]);
  });

  test("follows invariant 23's order: fsync the temp, claim, intent, rename, fsync the folder, then the record", async () => {
    const r = await rig(world);
    await r.run();
    const paths = videoPaths(r.w.libraryRoot, r.w.avatar.id);
    const at = (needle: string | RegExp): number => r.fs.calls.findIndex((c) => (typeof needle === "string" ? c.startsWith(needle) : needle.test(c)));
    const order = [
      at(`fsyncFile ${r.temp}`),
      at(`createExclusive ${join(r.w.exportRoot, FINAL)}`),
      at(`writeNew ${paths.pendingDir}`),
      at(`rename ${paths.pendingDir}`), // the intent's own temp into place
      at(`rename ${r.temp} -> ${join(r.w.exportRoot, FINAL)}`),
      at(`fsyncDir ${join(r.w.exportRoot, "Mia")}`),
      at(`link ${paths.intent(r.input.videoId)} -> ${paths.record(r.input.videoId)}`),
    ];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("fsyncs the temp through fsyncFile, which opens it r+, never through a read-only handle (Windows EPERM)", async () => {
    const r = await rig(world);
    await r.run();
    expect(r.fs.calls.filter((c) => c.startsWith("fsyncFile"))).toEqual([`fsyncFile ${r.temp}`]);
  });

  test("hands the verifier the temp, the exact frame count and the forbidden strings", async () => {
    const r = await rig(world, { forbiddenStrings: ["Jane Q. Photographer"] });
    const seen: unknown[] = [];
    await r.run({
      verify: async (path, expected) => {
        seen.push(path, expected);
        return acceptingVerify(path);
      },
    });
    expect(seen).toEqual([r.temp, { frames: 30, forbiddenStrings: ["Jane Q. Photographer"] }]);
  });

  test("takes the sha256 from the verifier's own pass: there is no second read of the file in the commit's disk interface", async () => {
    const r = await rig(world);
    const out = await r.run({ verify: async (path) => ({ ...(await acceptingVerify(path)), sha256: sha256Of(r.bytes) }) });
    expect(out.record.file.sha256).toBe(sha256Of(r.bytes));
    expect(Object.keys(r.fs).some((op) => /^(readFile|hash)/i.test(op))).toBe(false);
  });

  test("moves to the next number when the name is taken, and never touches the owner's file", async () => {
    const r = await rig(world);
    writeFileSync(join(r.w.exportRoot, FINAL), "the owner's own video");
    const out = await r.run();
    expect(out.record.file.relPath).toBe("Mia/2026-09-29_photo_002.mp4");
    expect(readFileSync(join(r.w.exportRoot, FINAL), "utf8")).toBe("the owner's own video");
  });

  test("two commits at once never share a name", async () => {
    const w = world();
    const a = await rig(world, { input: { jobId: "job-00000001", videoId: "video-00000001" } });
    const folder = await openFolder(w);
    writeTemp(folder, "job-00000002", fakeVideoBytes(3000, 9));
    const bInput: CommitInput = { ...a.input, jobId: "job-00000002", videoId: "video-00000002" };
    const [x, y] = await Promise.all([a.run(), commitVideo(a.target(), bInput, { fs: faultyFs(), libraryRoot: w.libraryRoot, library: w.library, verify: acceptingVerify })]);
    expect(new Set([x.record.file.relPath, y.record.file.relPath]).size).toBe(2);
    expect((await exportFiles(w)).sort()).toEqual([x.record.file.relPath, y.record.file.relPath].sort());
  });
});

describe("a number that a record or an intent of the day still names is never reused (stage 3 review 3-M2)", () => {
  /** A record committed for real, whose file the OWNER has since deleted in Finder: only the record is left. */
  async function recordWithoutFile(w: World, n: number, over: { kind?: string; date?: string } = {}): Promise<string> {
    const relPath = `Mia/${over.date ?? "2026-09-29"}_${over.kind ?? "photo"}_${String(n).padStart(3, "0")}.mp4`;
    const record = sampleRecord(w, { videoId: `video-000000a${n}`, jobId: `job-000000a${n}`, relPath });
    await writeIntent(NODE_COMMIT_FS, w.libraryRoot, record);
    await commitIntent(NODE_COMMIT_FS, w.libraryRoot, w.avatar.id, record.id);
    // What the engine's own index update does after a commit (and the open of the library does for every record).
    await w.library.reloadVideoRecords(w.avatar.id);
    return relPath;
  }

  test("a record names _001 though its file is gone: the next video takes _002, never _001", async () => {
    const r = await rig(world);
    const taken = await recordWithoutFile(r.w, 1);

    const out = await r.run();

    expect(out.record.file.relPath).toBe("Mia/2026-09-29_photo_002.mp4");
    expect(out.record.file.relPath).not.toBe(taken);
  });

  test("an intent in .pending names _001 though its file is not there (yet): the next video takes _002", async () => {
    const r = await rig(world);
    await writeIntent(NODE_COMMIT_FS, r.w.libraryRoot, sampleRecord(r.w, { videoId: "video-000000b1", jobId: "job-000000b1" }));

    const out = await r.run();

    expect(out.record.file.relPath).toBe("Mia/2026-09-29_photo_002.mp4");
  });

  test("the numbers go on from the highest one a record names: a gap below it is not filled", async () => {
    const r = await rig(world);
    await recordWithoutFile(r.w, 3);

    const out = await r.run();

    expect(out.record.file.relPath).toBe("Mia/2026-09-29_photo_004.mp4");
  });

  test("a record of another day or another kind does not move the counter", async () => {
    const r = await rig(world);
    await recordWithoutFile(r.w, 5, { date: "2026-09-28" });
    await recordWithoutFile(r.w, 6, { kind: "mix" });

    const out = await r.run();

    expect(out.record.file.relPath).toBe(FINAL);
  });

  test("a record of another export root does not move the counter (its number is another folder's)", async () => {
    const r = await rig(world);
    const other = sampleRecord(r.w, { videoId: "video-000000c1", jobId: "job-000000c1", rootId: "11111111-2222-4333-8444-555555555555", relPath: "Mia/2026-09-29_photo_007.mp4" });
    await writeIntent(NODE_COMMIT_FS, r.w.libraryRoot, other);
    await commitIntent(NODE_COMMIT_FS, r.w.libraryRoot, r.w.avatar.id, other.id);
    await r.w.library.reloadVideoRecords(r.w.avatar.id);

    const out = await r.run();

    expect(out.record.file.relPath).toBe(FINAL);
  });

  test("two avatars share one export folder: the second avatar's video never takes a number the first avatar's record still names (review round 1, M1)", async () => {
    const r = await rig(world);
    const second = await r.w.library.createAvatar({ ...SAMPLE_AVATAR, name: "Mia" });
    const taken = await recordWithoutFile(r.w, 1);

    const out = await commitVideo(r.target(), { ...r.input, avatarId: second.id, videoId: "video-000000e1" }, { fs: r.fs, libraryRoot: r.w.libraryRoot, library: r.w.library, verify: acceptingVerify });

    expect(out.record.file.relPath).toBe("Mia/2026-09-29_photo_002.mp4");
    expect(out.record.file.relPath).not.toBe(taken);
  });

  test("a pending intent of ANOTHER avatar in the same folder counts too", async () => {
    const r = await rig(world);
    const second = await r.w.library.createAvatar({ ...SAMPLE_AVATAR, name: "Mia" });
    await writeIntent(NODE_COMMIT_FS, r.w.libraryRoot, { ...sampleRecord(r.w, { videoId: "video-000000f1", jobId: "job-000000f1" }), avatarId: second.id });

    const out = await r.run();

    expect(out.record.file.relPath).toBe("Mia/2026-09-29_photo_002.mp4");
  });

  test.skipIf(process.platform === "win32")("a pending intent that cannot be read is logged and left out: the commit still succeeds", async () => {
    const r = await rig(world);
    await writeIntent(NODE_COMMIT_FS, r.w.libraryRoot, sampleRecord(r.w, { videoId: "video-000000g1", jobId: "job-000000g1" }));
    const intent = videoPaths(r.w.libraryRoot, r.w.avatar.id).intent("video-000000g1");
    chmodSync(intent, 0o000);

    try {
      const out = await r.run();
      expect(out.record.file.relPath).toBe(FINAL);
      expect(r.logs.some((line) => line.includes("could not be read and are not counted"))).toBe(true);
    } finally {
      chmodSync(intent, 0o600);
    }
  });

  test("a cancel during the scan comes out as the cancel's own reason, not wrapped in a library failure (review round 2, M1)", async () => {
    const r = await rig(world);
    const stop = new AbortController();
    const reason = new Error("the owner cancelled");

    // The cancel lands after the lock was taken: inside the claim's steps, where the scan then finds the signal fired.
    const error = await failureOf(r.run({ signal: stop.signal, beforeClaim: async () => stop.abort(reason) }));

    expect(error).toBe(reason);
    expect(await exportFiles(r.w)).toEqual([]);
  });

  test("a hung read of .pending ends for the signal with its reason, and the root lock is free: a second commit goes through", async () => {
    const r = await rig(world);
    const stop = new AbortController();
    const reason = new Error("deadline");
    const hang = { readdir: () => new Promise<Array<{ name: string; isFile: boolean }>>(() => undefined), lstat: NODE_NUMBER_FS.lstat, readFile: NODE_NUMBER_FS.readFile };
    setTimeout(() => stop.abort(reason), 50);

    const error = await failureOf(r.run({ signal: stop.signal, numberFs: hang }));
    expect(error).toBe(reason);

    writeTemp(r.target().folder, r.input.jobId, r.bytes);
    const out = await r.run();
    expect(out.record.file.relPath).toBe(FINAL);
  });

  test("a .pending folder that cannot be listed is logged and skipped: it does not fail every commit (review round 2, L8)", async () => {
    const r = await rig(world);
    const broken = { ...NODE_NUMBER_FS, readdir: (): Promise<Array<{ name: string; isFile: boolean }>> => Promise.reject(errnoError("EIO")) };

    const out = await r.run({ numberFs: broken });

    expect(out.record.file.relPath).toBe(FINAL);
    expect(r.logs.some((line) => line.includes("could not be listed"))).toBe(true);
  });

  test("an avatar whose used index is stale has its videos/ folder read from disk for the numbers: a record the index missed still counts (review round 2, L1)", async () => {
    const r = await rig(world);
    const record = sampleRecord(r.w, { videoId: "video-000000h1", jobId: "job-000000h1" });
    // The record is on disk but the index never learned of it, and the avatar is flagged.
    await writeIntent(NODE_COMMIT_FS, r.w.libraryRoot, record);
    await commitIntent(NODE_COMMIT_FS, r.w.libraryRoot, r.w.avatar.id, record.id);
    r.w.library.flagVideoIndexStale(r.w.avatar.id, record.id);

    const out = await r.run();

    expect(out.record.file.relPath).toBe("Mia/2026-09-29_photo_002.mp4");
  });

  test("a failure after the intent's rename (the .pending flush fails) still counts as one that may have left an intent: it is marked for the settle (follow-up LOW-5)", async () => {
    const r = await rig(world);
    r.fs.failOnce("fsyncDir", errnoError("EIO"), (args) => args.some((a) => a.includes(".pending")));

    const error = await failureOf(r.run());

    expect(mayHaveLeftIntent(error)).toBe(true);
  });

  test("a failure before any intent was written is not marked", async () => {
    const r = await rig(world);

    const error = await failureOf(r.run({ verify: async () => ({ result: { ok: false, reasons: [{ code: "UUID_BOX", message: "m" }] }, sha256: null, bytes: 1 }) }));

    expect(mayHaveLeftIntent(error)).toBe(false);
  });

  test("the scan stops for the commit's own signal: a cancelled commit claims nothing", async () => {
    const r = await rig(world);
    const stop = new AbortController();
    stop.abort(new Error("stopped"));

    const error = await failureOf(r.run({ signal: stop.signal }));

    expect(error).toBeInstanceOf(Error);
    expect(await exportFiles(r.w)).toEqual([]);
  });

  test("a record file that is not a usable record is left out of the count, and the commit goes on", async () => {
    const r = await rig(world);
    const paths = videoPaths(r.w.libraryRoot, r.w.avatar.id);
    mkdirSync(paths.videosDir, { recursive: true });
    writeFileSync(paths.record("video-000000d1"), "{ not json");

    const out = await r.run();

    expect(out.record.file.relPath).toBe(FINAL);
  });
});

describe("the verifier refuses", () => {
  const refusing =
    (reasons: Array<{ code: string; path?: string; message?: string }>) =>
    async (): Promise<VerifiedFile> => ({
      result: { ok: false, reasons: reasons.map((x) => ({ code: x.code as never, message: x.message ?? "m", ...(x.path === undefined ? {} : { path: x.path }) })) },
      sha256: null,
      bytes: 4096,
    });

  test("fails the job with RENDER_VERIFY_FAILED, keeps nothing and claims no name", async () => {
    const r = await rig(world);
    const error = await failureOf(r.run({ verify: refusing([{ code: "FRAME_COUNT_MISMATCH", path: "moov/trak" }]) }));
    expect(error).toBeInstanceOf(VerifyRefusedError);
    expect(error).toBeInstanceOf(RenderFailure);
    expect(error).toMatchObject({ engineError: { code: "RENDER_VERIFY_FAILED" }, codes: ["FRAME_COUNT_MISMATCH"], autoRetryable: true });
    expect(await exportFiles(r.w)).toEqual([]);
    expect(await libraryVideoFiles(r.w)).toEqual([]);
    expect(r.fs.calls.some((c) => c.startsWith("createExclusive"))).toBe(false);
  });

  test("SOURCE_METADATA_STRING is never retried automatically with the same spec", async () => {
    const r = await rig(world, { forbiddenStrings: ["Jane Q. Photographer"] });
    const error = await failureOf(r.run({ verify: refusing([{ code: "SOURCE_METADATA_STRING", path: "mdat" }]) }));
    expect(error).toMatchObject({ autoRetryable: false, codes: ["SOURCE_METADATA_STRING"] });
  });

  test("logs the reason codes and box paths, and never a forbidden string or a file path", async () => {
    const r = await rig(world, { forbiddenStrings: ["Jane Q. Photographer"] });
    await failureOf(r.run({ verify: refusing([{ code: "SOURCE_METADATA_STRING", path: "moov/udta", message: "caller string #0 found; Jane Q. Photographer" }, { code: "TEXT_IN_INDEX" }]) }));
    const text = r.logs.join("\n");
    expect(text).toContain("SOURCE_METADATA_STRING");
    expect(text).toContain("moov/udta");
    expect(text).toContain("TEXT_IN_INDEX");
    expect(text).not.toContain("Jane");
    expect(text).not.toContain(r.w.dir);
  });

  test("a verifier that could not hash the file (no complete read) is an internal failure, not a pass", async () => {
    const r = await rig(world);
    const error = await failureOf(r.run({ verify: async () => ({ result: { ok: true }, sha256: null, bytes: 4096 }) }));
    expect(error).toMatchObject({ engineError: { code: "INTERNAL" } });
    expect(await exportFiles(r.w)).toEqual([]);
  });

  test("a temp the verifier cannot read fails the job and leaves nothing", async () => {
    const r = await rig(world);
    const error = await failureOf(r.run({ verify: () => Promise.reject(errnoError("EIO")) }));
    expect(error).toMatchObject({ engineError: { code: "INTERNAL" } });
    expect(await exportFiles(r.w)).toEqual([]);
  });

  test("a temp that is a symlink is refused before anything reads it", async () => {
    const r = await rig(world);
    const target = join(r.w.dir, "elsewhere.mp4");
    writeFileSync(target, r.bytes);
    await rename(r.temp, `${r.temp}.real`);
    symlinkSync(target, r.temp);
    const error = await failureOf(r.run({ verify: () => Promise.reject(new Error("the verifier must not be reached")) }));
    expect(error).toMatchObject({ engineError: { code: "INTERNAL" } });
    expect(readFileSync(target)).toEqual(Buffer.from(r.bytes));
  });
});

describe("cancel and \"done wins\" (decision: a cancel is honoured up to the claim and ignored from the claim on)", () => {
  test("a cancel before the commit starts stops it with the abort reason, and removes the temp", async () => {
    const r = await rig(world);
    const controller = new AbortController();
    const reason = new Error("user cancelled");
    controller.abort(reason);
    expect(await failureOf(r.run({ signal: controller.signal }))).toBe(reason);
    expect(await exportFiles(r.w)).toEqual([]);
    expect(r.fs.calls.some((c) => c.startsWith("createExclusive"))).toBe(false);
  });

  test("a cancel that arrives while the file is being verified stops before the claim: no name, no intent, no temp", async () => {
    const r = await rig(world);
    const controller = new AbortController();
    const reason = new Error("user cancelled");
    const error = await failureOf(
      r.run({
        signal: controller.signal,
        verify: async (path) => {
          controller.abort(reason);
          return acceptingVerify(path);
        },
      }),
    );
    expect(error).toBe(reason);
    expect(await exportFiles(r.w)).toEqual([]);
    expect(await libraryVideoFiles(r.w)).toEqual([]);
    expect(r.fs.calls.some((c) => c.startsWith("createExclusive"))).toBe(false);
  });

  test("a cancel between the temp's fsync and the claim still stops cleanly", async () => {
    const r = await rig(world);
    const controller = new AbortController();
    const reason = new Error("user cancelled");
    const error = await failureOf(
      r.run({
        signal: controller.signal,
        hooks: {
          reached: (step) => {
            if (step === "temp-synced") controller.abort(reason);
          },
        },
      }),
    );
    expect(error).toBe(reason);
    expect(await exportFiles(r.w)).toEqual([]);
    expect(await libraryVideoFiles(r.w)).toEqual([]);
  });

  test.each<CommitStep>(["name-claimed", "intent-temp-written", "intent-written", "renamed", "dir-synced", "record-committed"])(
    "a cancel that arrives after %s changes nothing: the commit finishes, the record is committed, no half state",
    async (step) => {
      const r = await rig(world);
      const controller = new AbortController();
      const out = await r.run({
        signal: controller.signal,
        hooks: {
          reached: (reached) => {
            if (reached === step) controller.abort(new Error("user cancelled"));
          },
        },
      });
      expect(out.record.file.relPath).toBe(FINAL);
      expect(await exportFiles(r.w)).toEqual([FINAL]);
      expect(await libraryVideoFiles(r.w)).toEqual([`${r.input.videoId}.json`]);
      expect(readFileSync(join(r.w.exportRoot, FINAL))).toEqual(Buffer.from(r.bytes));
    },
  );
});

describe("failure modes roll back to a clean folder", () => {
  test("a full disk on the export volume when claiming the name fails EXPORT_UNAVAILABLE not-enough-space and removes the temp", async () => {
    const r = await rig(world);
    r.fs.failOnce("createExclusive", errnoError("ENOSPC"));
    const error = await failureOf(r.run());
    expect(error).toMatchObject({ engineError: { code: "EXPORT_UNAVAILABLE", exportReason: "not-enough-space" } });
    expect(await exportFiles(r.w)).toEqual([]);
    expect(await libraryVideoFiles(r.w)).toEqual([]);
  });

  test("a full disk on the intent removes the placeholder and the temp, writes no record, and says INTERNAL, not an export problem", async () => {
    const r = await rig(world);
    r.fs.failOnce("writeNew", errnoError("ENOSPC"));
    const error = await failureOf(r.run());
    expect(error).toMatchObject({ engineError: { code: "INTERNAL" } });
    expect((error as RenderFailure).engineError.detail).toContain("library");
    expect(await exportFiles(r.w)).toEqual([]);
    expect(await libraryVideoFiles(r.w)).toEqual([]);
    expect((await r.w.reopen()).videoCount(r.w.avatar.id)).toBe(0);
  });

  test("the claim running out of numbers fails the job and removes the temp", async () => {
    const r = await rig(world);
    writeFileSync(join(r.w.exportRoot, "Mia", "2026-09-29_photo_999999.mp4"), "the owner's");
    const error = await failureOf(r.run({ claimStartAt: 999_999 }));
    expect(error).toMatchObject({ engineError: { code: "INTERNAL" } });
    expect((error as RenderFailure).engineError.detail).toContain("no free");
    expect(await exportFiles(r.w)).toEqual(["Mia/2026-09-29_photo_999999.mp4"]);
    expect(readFileSync(join(r.w.exportRoot, "Mia", "2026-09-29_photo_999999.mp4"), "utf8")).toBe("the owner's");
  });

  test("the export folder vanishing mid-commit is EXPORT_UNAVAILABLE missing, and nothing is left in the library", async () => {
    const r = await rig(world);
    r.fs.failOnce("rename", errnoError("ENOENT"), (args) => args[0] === r.temp);
    const error = await failureOf(r.run());
    expect(error).toMatchObject({ engineError: { code: "EXPORT_UNAVAILABLE", exportReason: "missing" } });
    expect(await libraryVideoFiles(r.w)).toEqual([]);
  });

  test("a rename failing for another reason rolls the claim and the intent back", async () => {
    const r = await rig(world);
    r.fs.failOnce("rename", errnoError("EACCES"), (args) => args[0] === r.temp);
    const error = await failureOf(r.run());
    expect(error).toMatchObject({ engineError: { code: "EXPORT_UNAVAILABLE", exportReason: "not-writable" } });
    expect(await exportFiles(r.w)).toEqual([]);
    expect(await libraryVideoFiles(r.w)).toEqual([]);
  });

  test("the intent's fsync of the directory failing after the rename removes the file, the intent and leaves no record", async () => {
    const r = await rig(world);
    r.fs.failOnce("fsyncDir", errnoError("EIO"), (args) => args[0] === join(r.w.exportRoot, "Mia"));
    const error = await failureOf(r.run());
    expect(error).toMatchObject({ engineError: { code: "EXPORT_UNAVAILABLE" } });
    expect(await exportFiles(r.w)).toEqual([]);
    expect(await libraryVideoFiles(r.w)).toEqual([]);
  });

  test("the record's own link failing removes the file and the intent: no file without a record survives a failed job", async () => {
    const r = await rig(world);
    const paths = videoPaths(r.w.libraryRoot, r.w.avatar.id);
    r.fs.failOnce("link", errnoError("EIO"), (args) => args[0] === paths.intent(r.input.videoId));
    r.fs.failOnce("rename", errnoError("EIO"), (args) => args[0] === paths.intent(r.input.videoId)); // and so does the exclusive-rename fallback
    const error = await failureOf(r.run());
    expect(error).toMatchObject({ engineError: { code: "INTERNAL" } });
    expect(await exportFiles(r.w)).toEqual([]);
    expect(await libraryVideoFiles(r.w)).toEqual([]);
  });

  test("a file that cannot be removed during the rollback keeps its intent, so recovery adopts it instead of orphaning it", async () => {
    const r = await rig(world);
    const paths = videoPaths(r.w.libraryRoot, r.w.avatar.id);
    r.fs.failOnce("link", errnoError("EIO"), (args) => args[0] === paths.intent(r.input.videoId));
    r.fs.failOnce("rename", errnoError("EIO"), (args) => args[0] === paths.intent(r.input.videoId)); // and so does the exclusive-rename fallback
    r.fs.failOnce("unlink", errnoError("EBUSY"), (args) => args[0] === join(r.w.exportRoot, FINAL));
    await failureOf(r.run());
    expect(await exportFiles(r.w)).toEqual([FINAL]);
    expect(await libraryVideoFiles(r.w)).toEqual([`.pending/${r.input.videoId}.json`]);
  });

  test("a temp that changes after it was verified is refused (RENDER_VERIFY_FAILED) and everything is removed", async () => {
    const r = await rig(world);
    const error = await failureOf(
      r.run({
        hooks: {
          reached: (step) => {
            if (step === "intent-written") appendFileSync(r.temp, "tampered");
          },
        },
      }),
    );
    expect(error).toMatchObject({ engineError: { code: "RENDER_VERIFY_FAILED" } });
    expect(await exportFiles(r.w)).toEqual([]);
    expect(await libraryVideoFiles(r.w)).toEqual([]);
  });
});

describe("containment: the file lands inside the export root, or the commit fails (checked before AND after the rename)", () => {
  /** Swaps `<root>/Mia` for a symlink to `outside`, keeping the real folder under another name: what a racing local user could do. */
  function swapFolderForSymlink(w: World, outside: string): void {
    const folder = join(w.exportRoot, "Mia");
    const moved = `${folder}.moved`;
    renameSync(folder, moved);
    symlinkSync(outside, folder);
  }
  function outsideWithCanary(w: World): { outside: string; canary: string } {
    const outside = join(w.dir, "outside");
    mkdirSync(outside);
    const canary = join(outside, "2026-09-29_photo_001.mp4");
    writeFileSync(canary, "must survive");
    return { outside, canary };
  }

  test("a folder swapped for a symlink BEFORE the rename fails the job, and nothing is deleted or written through the link", async () => {
    const r = await rig(world);
    const { outside, canary } = outsideWithCanary(r.w);
    const error = await failureOf(
      r.run({
        hooks: {
          reached: (step) => {
            if (step === "intent-written") swapFolderForSymlink(r.w, outside);
          },
        },
      }),
    );
    expect(error).toMatchObject({ engineError: { code: "EXPORT_UNAVAILABLE", exportReason: "not-writable" } });
    expect(readFileSync(canary, "utf8")).toBe("must survive");
    expect(await listTree(outside)).toEqual(["2026-09-29_photo_001.mp4"]);
    expect(await libraryVideoFiles(r.w)).toEqual([`.pending/${r.input.videoId}.json`]); // the folder could not be judged: the intent stays for recovery
  });

  test("a folder swapped for a symlink BEFORE the claim never gets a placeholder created through the link", async () => {
    const r = await rig(world);
    const outside = join(r.w.dir, "outside");
    mkdirSync(outside);
    const error = await failureOf(
      r.run({
        hooks: {
          reached: (step) => {
            if (step === "temp-synced") swapFolderForSymlink(r.w, outside);
          },
        },
      }),
    );
    expect(error).toMatchObject({ engineError: { code: "EXPORT_UNAVAILABLE", exportReason: "not-writable" } });
    expect(await listTree(outside)).toEqual([]);
    expect(r.fs.calls.some((c) => c.startsWith("createExclusive"))).toBe(false);
  });

  test("a folder swapped for a symlink AFTER the rename fails the job, keeps the intent for recovery, commits no record, and touches nothing outside", async () => {
    const r = await rig(world);
    const { outside, canary } = outsideWithCanary(r.w);
    const error = await failureOf(
      r.run({
        hooks: {
          reached: (step) => {
            if (step === "renamed") swapFolderForSymlink(r.w, outside);
          },
        },
      }),
    );
    expect(error).toMatchObject({ engineError: { code: "EXPORT_UNAVAILABLE", exportReason: "not-writable" } });
    expect(readFileSync(canary, "utf8")).toBe("must survive");
    expect(await listTree(outside)).toEqual(["2026-09-29_photo_001.mp4"]);
    expect(await libraryVideoFiles(r.w)).toEqual([`.pending/${r.input.videoId}.json`]); // the folder could not be judged: the intent stays for recovery
    expect((await r.w.reopen()).videoCount(r.w.avatar.id)).toBe(0);
  });

  test("a folder that is replaced by another real folder outside the root also fails: the real path is what counts", async () => {
    const r = await rig(world);
    const outside = join(r.w.dir, "outside");
    mkdirSync(outside);
    const error = await failureOf(
      r.run({
        hooks: {
          reached: (step) => {
            if (step === "name-claimed") r.fs.override({ realpath: async (p) => (p.endsWith("Mia") ? outside : p) });
          },
        },
      }),
    );
    expect(error).toMatchObject({ engineError: { code: "EXPORT_UNAVAILABLE", exportReason: "not-writable" } });
    expect(await libraryVideoFiles(r.w)).toEqual([`.pending/${r.input.videoId}.json`]); // the folder could not be judged: the intent stays for recovery
  });
});
