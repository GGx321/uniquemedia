import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { claimExportName, exportFileName, NODE_EXPORT_FOLDER_FS, prepareExportFolder, type PreparedFolder } from "./exportName";
import { NODE_COMMIT_FS } from "./videos/commitFs";

// The export name claim on the REAL disk, under ELECTRON'S NODE, the product's own runtime, on both CI OSes (plan 3a.9, from the
// 3a.8a and 3a.8b.2 reviews). The claim creates an empty file with `wx`; what a disk answers when something is already at the
// name (a folder, a link, a dangling link) differs, and Windows is the one that differs. These tests PIN what the engine does
// about each, and print what the raw calls answer (the lines starting `FACT`) for the plan's notes.
// Bundled and run by studio/scripts/electronNodeTests.ts; named `.node-test.ts` so `bun test` never loads it.

const DATE = "2026-09-29";
const KIND = "photo";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "studio-claim-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const codeOf = (error: unknown): string => (error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "no code");

/** What a call rejects with, as a code; fails the test when it does not reject. */
async function rejection(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
  } catch (error) {
    return codeOf(error);
  }
  throw new Error("the call did not reject");
}

async function folder(): Promise<PreparedFolder> {
  return prepareExportFolder({ fs: NODE_EXPORT_FOLDER_FS, root, safeName: "Mia", avatarId: "avatar-0001", caseInsensitive: process.platform !== "linux" });
}

/** A symlink, or null where this account may not make one (Windows without developer mode or admin). */
async function tryLink(target: string, path: string, type: "file" | "dir"): Promise<boolean> {
  try {
    await symlink(target, path, type);
    return true;
  } catch (error) {
    console.log(`FACT symlink creation on ${process.platform}: ${codeOf(error)} (the link cases below cannot run here)`);
    return false;
  }
}

describe("a folder at the name the claim wants", () => {
  test("records what the bare `open(dir, 'wx')` answers on this OS", async () => {
    const dir = join(root, "a-folder");
    await mkdir(dir);

    const code = await rejection(() => open(dir, "wx"));

    console.log(`FACT open(<directory>, 'wx') on ${process.platform}: ${code}`);
    assert.match(code, /^E[A-Z]+$/);
  });

  test("the commit's claim answers EEXIST for it, whatever the bare call said", async () => {
    const dir = join(root, "a-folder");
    await mkdir(dir);

    assert.equal(await rejection(() => NODE_COMMIT_FS.createExclusive(dir)), "EEXIST");
  });

  test("the claim skips a folder that holds the first name and takes the next number, leaving the folder alone", async () => {
    const target = await folder();
    await mkdir(join(target.path, exportFileName(DATE, KIND, 1)));

    const claim = await claimExportName({ fs: { createExclusive: async (path) => void (await NODE_COMMIT_FS.createExclusive(path)) }, folder: target, date: DATE, kind: KIND });

    assert.equal(claim.n, 2);
    assert.equal(claim.relPath, `${target.name}/${exportFileName(DATE, KIND, 2)}`);
    assert.equal((await lstat(join(target.path, exportFileName(DATE, KIND, 1)))).isDirectory(), true);
    assert.equal((await lstat(claim.absPath)).isFile(), true);
  });
});

describe("a link at the name the claim wants (skipped where this account cannot make one)", () => {
  test("an existing file's link is EEXIST, and the file behind it is not opened or changed", async () => {
    const real = join(root, "real.mp4");
    await (await open(real, "wx")).close();
    if (!(await tryLink(real, join(root, "link.mp4"), "file"))) return;

    assert.equal(await rejection(() => NODE_COMMIT_FS.createExclusive(join(root, "link.mp4"))), "EEXIST");
    assert.equal((await lstat(real)).size, 0);
  });

  test("a dangling link is EEXIST, and its target is NOT created (where a bare `wx` on Windows would create it)", async () => {
    const target = join(root, "nowhere.mp4");
    if (!(await tryLink(target, join(root, "dangling.mp4"), "file"))) return;

    assert.equal(await rejection(() => NODE_COMMIT_FS.createExclusive(join(root, "dangling.mp4"))), "EEXIST");
    assert.equal((await readdir(root)).includes("nowhere.mp4"), false);
  });
});

describe("the identity of a file just created", () => {
  test("`fstat` of the open handle and `lstat` of the name agree on device and inode, or the claim's own check would refuse every name", async () => {
    const path = join(root, `${randomUUID()}.mp4`);
    const handle = await open(path, "wx");
    try {
      const viaHandle = await handle.stat({ bigint: true });
      const viaName = await lstat(path, { bigint: true });
      console.log(`FACT fstat ino/dev on ${process.platform}: ${viaHandle.ino}/${viaHandle.dev}; lstat: ${viaName.ino}/${viaName.dev}`);
      assert.equal(viaName.ino, viaHandle.ino);
      assert.equal(viaName.dev, viaHandle.dev);
    } finally {
      await handle.close();
    }
  });

  test("a fresh name is claimed, and the identity it reports is the one the name has", async () => {
    const path = join(root, `${randomUUID()}.mp4`);

    const identity = await NODE_COMMIT_FS.createExclusive(path);

    const named = await lstat(path, { bigint: true });
    assert.deepEqual(identity, { dev: String(named.dev), ino: String(named.ino) });
  });
});
