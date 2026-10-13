import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClipExport, JobState } from "../../shared/engine";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { formatExportDate } from "../exportName";
import { NODE_COMMIT_FS, type CommitFs } from "../videos/commitFs";
import { CommitTracker } from "../videos/live";
import { partNameOf } from "../videos/record";
import { LockWaitTimeout, withRootLock } from "../videos/rootLock";
import { copyingEncode, createExportRig, NOW, useExportFixtures, type ExportRig, type ExportRigOptions } from "./testing/exportRig";
import { clipFilePath } from "./store";
useNativeGlobals();

// Stage 5, 5b.1, S5.V4c (plan s5b1 §5.13, I5.55): an export COMMITS EXACTLY AS A RENDER DOES. The encode writes `.studio-part-<jobId>.mp4` in the avatar's folder inside the export root
// (never the clips folder, never a copy), the temp and then the placeholder are in the renders' live commits, the root lock is held from the claim to the rename, the rename is the only
// move (EXDEV is a refusal), the number comes from `highestNamedNumber` (which sees every clip record), and the record's export line is written last. The encode itself is played here
// by copying a clean export the real argv made once (export.ffmpeg.test.ts runs real encodes).

setDefaultTimeout(60_000);

const fixtures = useExportFixtures();
const DATE = formatExportDate(new Date(NOW));
const name = (n: number): string => `${DATE}_clip_${String(n).padStart(3, "0")}.mp4`;

let rig: ExportRig | null = null;
afterEach(async () => {
  await rig?.cleanup();
  rig = null;
});

async function world(options: ExportRigOptions = {}): Promise<ExportRig> {
  rig = await createExportRig({ ...options, deps: { encode: copyingEncode(fixtures.cleanExport), ...options.deps } });
  return rig;
}

async function exported(r: ExportRig, clipId = "clip-0000001"): Promise<{ jobId: string; state: JobState }> {
  const jobId = await r.started(clipId);
  return { jobId, state: await r.settled(jobId) };
}

const done = (state: JobState): string => {
  if (state.status !== "done" || state.kind !== "clip" || state.result?.kind !== "clip" || state.result.exported === undefined) throw new Error(`expected a done export, got ${JSON.stringify(state)}`);
  return state.result.exported.relPath;
};

const errorOf = (state: JobState): unknown => (state.status === "failed" ? state.error : `the job ended ${state.status}`);

async function fileStatesOf(r: ExportRig, clipId = "clip-0000001"): Promise<ClipExport["fileState"][]> {
  const { clip } = await r.records.get({ avatarId: r.avatarId, clipId });
  return clip.exports.map((line) => line.fileState);
}

describe("where the encode writes", () => {
  test("the temp is .studio-part-<jobId>.mp4 in the avatar's folder inside the export root, and the clips folder gets nothing", async () => {
    const seen: string[] = [];
    const r = await world({ deps: { encode: copyingEncode(fixtures.cleanExport, { during: (encode) => void seen.push(encode.output) }) } });
    await r.putClip("clip-0000001", await fixtures.kling());
    const clipsBefore = (await readdir(r.clipsDir)).sort();

    const { jobId, state } = await exported(r);

    expect(state.status).toBe("done");
    expect(seen).toEqual([join(r.avatarFolder, partNameOf(jobId))]);
    expect((await readdir(r.clipsDir)).sort()).toEqual(clipsBefore);
  });

  test("the temp the encoder writes into is created empty by the job first (ffmpeg only truncates a file the job made)", async () => {
    const atStart: Array<{ size: number; isFile: boolean }> = [];
    const r = await world({
      deps: {
        encode: copyingEncode(fixtures.cleanExport, {
          during: async (encode) => {
            const info = await lstat(encode.output);
            atStart.push({ size: info.size, isFile: info.isFile() });
          },
        }),
      },
    });
    await r.putClip("clip-0000001", await fixtures.kling());

    await exported(r);

    expect(atStart).toEqual([{ size: 0, isFile: true }]);
  });

  test("the committed file is the temp's own inode, renamed onto the claimed name: no copy anywhere", async () => {
    const renames: Array<[string, string]> = [];
    let tempIno = "";
    const fs: CommitFs = { ...NODE_COMMIT_FS, rename: async (from, to) => (renames.push([from, to]), NODE_COMMIT_FS.rename(from, to)) };
    const r = await world({
      deps: {
        fs,
        hooks: {
          reached: async (step, at) => {
            if (step === "verified") tempIno = (await NODE_COMMIT_FS.lstat(at.temp)).ino;
          },
        },
      },
    });
    await r.putClip("clip-0000001", await fixtures.kling());

    const { jobId, state } = await exported(r);
    const final = join(r.exportRoot, done(state));

    expect(renames).toEqual([[join(r.avatarFolder, partNameOf(jobId)), final]]);
    expect((await NODE_COMMIT_FS.lstat(final)).ino).toBe(tempIno);
    expect(await r.folderNames()).toEqual([name(1)]);
  });
});

describe("the renders' live commits and the recovery", () => {
  test("the temp is live while the encode runs, and a render recovery pass then deletes nothing", async () => {
    let liveDuring = false;
    let removedDuring = -1;
    let r: ExportRig | null = null;
    r = await world({
      deps: {
        hooks: {
          reached: async (step, at) => {
            if (step !== "encoded" || r === null) return;
            liveDuring = r.live.hasTemp(at.temp);
            removedDuring = (await r.recover()).removed.partTemps;
          },
        },
      },
    });
    await r.putClip("clip-0000001", await fixtures.kling());

    const { state } = await exported(r);

    expect(liveDuring).toBe(true);
    expect(removedDuring).toBe(0);
    expect(state.status).toBe("done");
  });

  test("once claimed, the placeholder is live too; both leave the live commits when the export ends", async () => {
    const during: Array<{ temp: boolean; placeholder: boolean }> = [];
    let paths: { temp: string; placeholder: string | null } = { temp: "", placeholder: null };
    let r: ExportRig | null = null;
    r = await world({
      deps: {
        hooks: {
          reached: (step, at) => {
            if (step !== "name-claimed" || r === null) return;
            paths = at;
            during.push({ temp: r.live.hasTemp(at.temp), placeholder: at.placeholder !== null && r.live.hasPlaceholder(at.placeholder) });
          },
        },
      },
    });
    await r.putClip("clip-0000001", await fixtures.kling());

    await exported(r);

    expect(during).toEqual([{ temp: true, placeholder: true }]);
    expect([r.live.hasTemp(paths.temp), paths.placeholder !== null && r.live.hasPlaceholder(paths.placeholder)]).toEqual([false, false]);
  });

  test("the root lock is held from the claim to the rename, and not while the file is encoded", async () => {
    const held: Record<string, boolean> = {};
    let r: ExportRig | null = null;
    const isHeld = async (root: string): Promise<boolean> =>
      withRootLock(NODE_COMMIT_FS, root, async () => false, { waitMs: 50 }).catch((error: unknown) => {
        if (error instanceof LockWaitTimeout) return true;
        throw error;
      });
    r = await world({
      deps: {
        hooks: {
          reached: async (step) => {
            if (r !== null && (step === "encoded" || step === "name-claimed" || step === "renamed" || step === "recorded")) held[step] = await isHeld(r.exportRoot);
          },
        },
      },
    });
    await r.putClip("clip-0000001", await fixtures.kling());

    await exported(r);

    expect(held).toEqual({ encoded: false, "name-claimed": true, renamed: true, recorded: false });
  });

  test("a crash before the rename leaves a full temp and an empty placeholder of the render's pattern, nothing under a final name", async () => {
    const shape: Array<{ name: string; bytes: number }> = [];
    let r: ExportRig | null = null;
    r = await world({
      deps: {
        hooks: {
          reached: async (step) => {
            if (step !== "name-claimed" || r === null) return;
            for (const entry of await r.folderNames()) shape.push({ name: entry, bytes: (await stat(join(r.avatarFolder, entry))).size });
          },
        },
      },
    });
    await r.putClip("clip-0000001", await fixtures.kling());

    const { jobId } = await exported(r);

    expect(shape.map((s) => s.name)).toEqual([partNameOf(jobId), name(1)].sort());
    expect(shape.find((s) => s.name === name(1))?.bytes).toBe(0);
    expect(shape.find((s) => s.name === partNameOf(jobId))?.bytes).toBeGreaterThan(0);
  });

  test("…and the next render recovery (no live commits: a new process) removes that dead temp and the empty placeholder", async () => {
    const r = await world();
    await mkdir(r.avatarFolder, { recursive: true });
    await writeFile(join(r.avatarFolder, partNameOf("job-crashed1")), await readFile(await fixtures.cleanExport()));
    await writeFile(join(r.avatarFolder, name(1)), "");

    const report = await r.recover(new CommitTracker());

    expect(report.removed).toMatchObject({ partTemps: 1, placeholders: 1 });
    expect(await r.folderNames()).toEqual([]);
  });

  test("a crash mid-encode leaves only the temp (never a final name), which the next recovery sweeps", async () => {
    let during: string[] = [];
    let r: ExportRig | null = null;
    r = await world({ deps: { encode: copyingEncode(fixtures.cleanExport, { during: async () => void (during = r === null ? [] : await r.folderNames()) }) } });
    await r.putClip("clip-0000001", await fixtures.kling());

    const { jobId } = await exported(r);
    await writeFile(join(r.avatarFolder, partNameOf("job-crashed2")), "half an encode");
    const report = await r.recover(new CommitTracker());

    expect(during).toEqual([partNameOf(jobId)]);
    expect(report.removed.partTemps).toBe(1);
    expect(await r.folderNames()).toEqual([name(1)]);
  });
});

describe("the name", () => {
  test("is <date>_clip_<NNN>.mp4 in the avatar's folder, and the record's line names it", async () => {
    const r = await world();
    await r.putClip("clip-0000001", await fixtures.kling());

    const { state } = await exported(r);

    expect(done(state)).toBe(`Nini/${name(1)}`);
    expect((await r.record("clip-0000001")).exports.map((line) => line.relPath)).toEqual([`Nini/${name(1)}`]);
  });

  test("an owner's file already at _001 is never touched, and the export takes _002", async () => {
    const r = await world();
    await r.putClip("clip-0000001", await fixtures.kling());
    await mkdir(r.avatarFolder, { recursive: true });
    await writeFile(join(r.avatarFolder, name(1)), "the owner's own file");

    const { state } = await exported(r);

    expect(done(state)).toBe(`Nini/${name(2)}`);
    expect(await readFile(join(r.avatarFolder, name(1)), "utf8")).toBe("the owner's own file");
  });

  test("a record naming _003 whose file is gone: the next export claims _004", async () => {
    const r = await world();
    const rootId = await r.rootId();
    const line = { rootId, relPath: `Nini/${name(3)}`, profile: "1080p30-dup" as const, at: new Date(NOW).toISOString(), bytes: 10, sha256: "c".repeat(64) };
    await r.putClip("clip-0000001", await fixtures.kling(), { exports: [line] });

    const { state } = await exported(r);

    expect(done(state)).toBe(`Nini/${name(4)}`);
  });

  test("another clip's record naming _002 counts too", async () => {
    const r = await world();
    const rootId = await r.rootId();
    await r.putClip("clip-0000002", await fixtures.kling(), { exports: [{ rootId, relPath: `Nini/${name(2)}`, profile: "1080p30-interp", at: new Date(NOW).toISOString(), bytes: 10, sha256: "d".repeat(64) }] });
    await r.putClip("clip-0000001", await fixtures.kling());

    const { state } = await exported(r);

    expect(done(state)).toBe(`Nini/${name(3)}`);
  });

  test("a second export of the same clip makes a second file from the library copy", async () => {
    const r = await world();
    await r.putClip("clip-0000001", await fixtures.kling());

    const first = done((await exported(r)).state);
    const second = done((await exported(r)).state);

    expect([first, second]).toEqual([`Nini/${name(1)}`, `Nini/${name(2)}`]);
    expect(await r.folderNames()).toEqual([name(1), name(2)]);
  });
});

describe("the record's export line", () => {
  test("holds the root's id, the place, the profile, the export time, the size and the sha256 of the committed file", async () => {
    const r = await world();
    await r.putClip("clip-0000001", await fixtures.kling());

    const { state } = await exported(r);
    const file = join(r.exportRoot, done(state));

    expect((await r.record("clip-0000001")).exports).toEqual([
      { rootId: await r.rootId(), relPath: done(state), profile: "1080p30-dup", at: new Date(NOW).toISOString(), bytes: (await stat(file)).size, sha256: await r.sha(file) },
    ]);
  });

  test("the library's mp4 is byte for byte what it was", async () => {
    const r = await world();
    await r.putClip("clip-0000001", await fixtures.kling());
    const before = await r.sha(clipFilePath(r.clipsDir, "clip-0000001"));

    await exported(r);

    expect(await r.sha(clipFilePath(r.clipsDir, "clip-0000001"))).toBe(before);
  });

  test("a clip delete leaves the exported copy where it is", async () => {
    const r = await world();
    await r.putClip("clip-0000001", await fixtures.kling());
    const { state } = await exported(r);

    await r.records.delete({ avatarId: r.avatarId, clipId: "clip-0000001" });

    expect(existsSync(join(r.exportRoot, done(state)))).toBe(true);
  });
});

describe("fileState", () => {
  test("is present after the export", async () => {
    const r = await world();
    await r.putClip("clip-0000001", await fixtures.kling());
    await exported(r);

    expect(await fileStatesOf(r)).toEqual(["present"]);
  });

  test("is missing after a Finder delete", async () => {
    const r = await world();
    await r.putClip("clip-0000001", await fixtures.kling());
    const { state } = await exported(r);

    await rm(join(r.exportRoot, done(state)));

    expect(await fileStatesOf(r)).toEqual(["missing"]);
  });

  test("a Finder-deleted _001 is never reused: the next export takes _002, and the first line reads missing, never present", async () => {
    const r = await world();
    await r.putClip("clip-0000001", await fixtures.kling());
    await r.putClip("clip-0000002", await fixtures.kling());
    const first = done((await exported(r, "clip-0000001")).state);
    await rm(join(r.exportRoot, first));

    const second = done((await exported(r, "clip-0000002")).state);

    expect(second).toBe(`Nini/${name(2)}`);
    expect(await fileStatesOf(r, "clip-0000001")).toEqual(["missing"]);
    expect(await fileStatesOf(r, "clip-0000002")).toEqual(["present"]);
  });

  test("another file put at the old name reads changed (size and sha256), never present", async () => {
    const r = await world();
    await r.putClip("clip-0000001", await fixtures.kling());
    const { state } = await exported(r);
    const file = join(r.exportRoot, done(state));
    const bytes = await readFile(file);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;

    await rm(file);
    await writeFile(file, bytes);

    expect(await fileStatesOf(r)).toEqual(["changed"]);
  });
});

describe("EXDEV at the rename", () => {
  test("is a refusal, never a copy: EXPORT_UNAVAILABLE, and the temp and the placeholder are gone", async () => {
    const fs: CommitFs = { ...NODE_COMMIT_FS, rename: async () => Promise.reject(Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" })) };
    const r = await world({ deps: { fs } });
    await r.putClip("clip-0000001", await fixtures.kling());

    const { state } = await exported(r);

    expect(errorOf(state)).toMatchObject({ code: "EXPORT_UNAVAILABLE", exportReason: "not-writable" });
    expect(await r.folderNames()).toEqual([]);
    expect((await r.record("clip-0000001")).exports).toEqual([]);
  });
});
