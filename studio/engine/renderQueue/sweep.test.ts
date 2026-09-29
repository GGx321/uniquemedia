import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepPartFiles, sweepRenderTmp } from "./sweep";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "studio-sweep-"));
  dirs.push(dir);
  return dir;
}

const locked = (code: string): Error => Object.assign(new Error(`${code}: locked`), { code });
const noSleep = (): Promise<void> => Promise.resolve();

describe("sweepRenderTmp", () => {
  test("removes every job folder and stray file, and keeps the render-tmp folder itself", async () => {
    const root = join(tempDir(), "render-tmp");
    mkdirSync(join(root, "job-00000001"), { recursive: true });
    writeFileSync(join(root, "job-00000001", "clip-00.mkv"), "x");
    mkdirSync(join(root, "job-00000002"));
    writeFileSync(join(root, "stray.tmp"), "x");

    const result = await sweepRenderTmp(root);

    expect(readdirSync(root)).toEqual([]);
    expect(result.removed.sort()).toEqual([join(root, "job-00000001"), join(root, "job-00000002"), join(root, "stray.tmp")]);
    expect(result.skipped).toEqual([]);
  });

  test("does nothing, and does not throw, when the folder does not exist yet", async () => {
    const root = join(tempDir(), "render-tmp");

    await expect(sweepRenderTmp(root)).resolves.toEqual({ removed: [], skipped: [] });
    expect(existsSync(root)).toBe(false);
  });

  test("retries an entry that is locked for a moment, as Windows does after a crash (EBUSY, EPERM)", async () => {
    const root = join(tempDir(), "render-tmp");
    mkdirSync(join(root, "job-00000001"), { recursive: true });
    const attempts: string[] = [];
    let failures = 2;

    const result = await sweepRenderTmp(root, {
      remove: async (path) => {
        attempts.push(path);
        if (failures-- > 0) throw locked(failures === 1 ? "EBUSY" : "EPERM");
        rmSync(path, { recursive: true, force: true });
      },
      sleep: noSleep,
    });

    expect(attempts).toHaveLength(3);
    expect(result.removed).toEqual([join(root, "job-00000001")]);
    expect(result.skipped).toEqual([]);
  });

  test("skips an entry that stays locked, reports it, and still removes the rest", async () => {
    const root = join(tempDir(), "render-tmp");
    mkdirSync(join(root, "job-00000001"), { recursive: true });
    mkdirSync(join(root, "job-00000002"));
    const stuck = join(root, "job-00000001");

    const result = await sweepRenderTmp(root, {
      remove: async (path) => {
        if (path === stuck) throw locked("EBUSY");
        rmSync(path, { recursive: true, force: true });
      },
      sleep: noSleep,
    });

    expect(result.removed).toEqual([join(root, "job-00000002")]);
    expect(result.skipped).toEqual([{ path: stuck, code: "EBUSY" }]);
    expect(existsSync(stuck)).toBe(true);
  });

  test("gives up on a locked entry after a bounded number of tries", async () => {
    const root = join(tempDir(), "render-tmp");
    mkdirSync(join(root, "job-00000001"), { recursive: true });
    let tries = 0;

    await sweepRenderTmp(root, {
      remove: async () => {
        tries++;
        throw locked("EPERM");
      },
      sleep: noSleep,
    });

    expect(tries).toBe(5);
  });

  test("reports an entry that fails for any other reason instead of throwing out of startup", async () => {
    const root = join(tempDir(), "render-tmp");
    mkdirSync(join(root, "job-00000001"), { recursive: true });
    let tries = 0;

    const result = await sweepRenderTmp(root, {
      remove: async () => {
        tries++;
        throw locked("EIO");
      },
      sleep: noSleep,
    });

    expect(tries).toBe(1); // not a lock: nothing to wait for
    expect(result.skipped).toEqual([{ path: join(root, "job-00000001"), code: "EIO" }]);
  });

  test("reports a folder that cannot be listed instead of throwing", async () => {
    const root = join(tempDir(), "render-tmp");
    writeFileSync(root, "not a folder");

    const result = await sweepRenderTmp(root);

    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([{ path: root, code: "ENOTDIR" }]);
  });

  test("removes a symlink without following it", async () => {
    const base = tempDir();
    const root = join(base, "render-tmp");
    const outside = join(base, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "x");
    symlinkSync(outside, join(root, "job-00000001"));

    await sweepRenderTmp(root);

    expect(readdirSync(root)).toEqual([]);
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
  });
});

describe("sweeps and symlinks (review round 1)", () => {
  test("sweepRenderTmp refuses a render-tmp that is itself a symlink, and empties nothing behind it", async () => {
    const base = tempDir();
    const target = join(base, "precious");
    mkdirSync(target);
    writeFileSync(join(target, "keep.txt"), "x");
    const root = join(base, "render-tmp");
    symlinkSync(target, root);

    const result = await sweepRenderTmp(root);

    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([{ path: root, code: "SYMLINK" }]);
    expect(existsSync(join(target, "keep.txt"))).toBe(true);
  });

  test("sweepPartFiles checks a folder again right before going into it, and leaves one that is no longer a real folder", async () => {
    const root = tempDir();
    mkdirSync(join(root, "Mia"));
    const part = join(root, "Mia", ".studio-part-job-00000001.mp4");
    writeFileSync(part, "x");

    // Between the listing and the descent, Mia was swapped for a symlink.
    const result = await sweepPartFiles(root, { isRealDirectory: async (path) => path !== join(root, "Mia") });

    expect(result.removed).toEqual([]);
    expect(existsSync(part)).toBe(true);
  });

  test("sweepPartFiles goes into a real folder when the check says so", async () => {
    const root = tempDir();
    mkdirSync(join(root, "Mia"));
    writeFileSync(join(root, "Mia", ".studio-part-job-00000001.mp4"), "x");

    const result = await sweepPartFiles(root);

    expect(result.removed).toHaveLength(1);
  });
});

describe("sweepPartFiles", () => {
  const PART = ".studio-part-job-00000001.mp4";

  test("removes the .studio-part temps inside <SafeName>/ folders, and nothing else: the root itself is not where renders write", async () => {
    const root = tempDir();
    mkdirSync(join(root, "Mia"));
    mkdirSync(join(root, "Mia", "deep"));
    writeFileSync(join(root, PART), "x");
    writeFileSync(join(root, "Mia", PART), "x");
    writeFileSync(join(root, "Mia", "2026-09-29_photo_001.mp4"), "the video");
    writeFileSync(join(root, "Mia", ".studio-export.json"), "{}");
    writeFileSync(join(root, "Mia", "notes.studio-part-1.mp4"), "x");
    writeFileSync(join(root, "Mia", "deep", PART), "too deep to be ours");
    writeFileSync(join(root, ".studio-export.json"), "{}");

    const result = await sweepPartFiles(root);

    expect(result.removed).toEqual([join(root, "Mia", PART)]);
    expect(existsSync(join(root, PART))).toBe(true);
    expect(readdirSync(join(root, "Mia")).sort()).toEqual([".studio-export.json", "2026-09-29_photo_001.mp4", "deep", "notes.studio-part-1.mp4"]);
    expect(existsSync(join(root, "Mia", "deep", PART))).toBe(true);
    expect(existsSync(join(root, ".studio-export.json"))).toBe(true);
  });

  test("keeps the temps of jobs still running", async () => {
    const root = tempDir();
    mkdirSync(join(root, "Mia"));
    const live = join(root, "Mia", ".studio-part-job-00000002.mp4");
    const dead = join(root, "Mia", PART);
    writeFileSync(live, "x");
    writeFileSync(dead, "x");

    const result = await sweepPartFiles(root, { except: new Set([live]) });

    expect(result.removed).toEqual([dead]);
    expect(existsSync(live)).toBe(true);
  });

  test("does not touch a symlink named like a temp, nor enter a symlinked folder", async () => {
    const base = tempDir();
    const root = join(base, "export");
    const outside = join(base, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, PART), "not ours");
    symlinkSync(join(outside, PART), join(root, ".studio-part-job-00000009.mp4"));
    symlinkSync(outside, join(root, "Linked"));

    const result = await sweepPartFiles(root);

    expect(result.removed).toEqual([]);
    expect(existsSync(join(outside, PART))).toBe(true);
    expect(readdirSync(root).sort()).toEqual([".studio-part-job-00000009.mp4", "Linked"]);
  });

  test("never removes a folder that happens to carry a temp's name", async () => {
    const root = tempDir();
    mkdirSync(join(root, PART));
    writeFileSync(join(root, PART, "inside.txt"), "x");

    const result = await sweepPartFiles(root);

    expect(result.removed).toEqual([]);
    expect(existsSync(join(root, PART, "inside.txt"))).toBe(true);
  });

  test("skips a locked temp, reports it, and still removes the others", async () => {
    const root = tempDir();
    mkdirSync(join(root, "Mia"));
    mkdirSync(join(root, "Ivy"));
    const stuck = join(root, "Ivy", PART);
    const other = join(root, "Mia", PART);
    writeFileSync(stuck, "x");
    writeFileSync(other, "x");

    const result = await sweepPartFiles(root, {
      remove: async (path) => {
        if (path === stuck) throw locked("EBUSY");
        rmSync(path, { force: true });
      },
      sleep: noSleep,
    });

    expect(result.removed).toEqual([other]);
    expect(result.skipped).toEqual([{ path: stuck, code: "EBUSY" }]);
  });

  test("does nothing, and does not throw, when the export root is gone (an unplugged drive)", async () => {
    const root = join(tempDir(), "unplugged");

    await expect(sweepPartFiles(root)).resolves.toEqual({ removed: [], skipped: [] });
  });
});
