import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, stat, symlink, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { createExclusiveNoFollow, openRegularNoFollow, type OpenRegularOps } from "./openRegular";
useNativeGlobals();

// The owner-file-safety guarantee on EVERY platform. `O_NOFOLLOW` does not exist on Windows (it is
// undefined there, so OR-ing it in adds nothing): the guarantee cannot rest on the flag. It rests on
// an lstat before the open and a same-inode check on the open handle; the flag is one more layer
// where it exists. Most tests here run with `noFollow: 0`, which is what Windows gives, so macOS and
// Linux exercise the Windows path.

const NODE_OPS: OpenRegularOps = { lstat: (path) => lstat(path, { bigint: true }), open: (path, flags) => open(path, flags) };

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "studio-openregular-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

/** Makes a symlink; false when the platform will not make one for this user (Windows without the privilege), and the test then has nothing to say. */
async function tryLink(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path);
    return true;
  } catch (error) {
    if (process.platform === "win32" && error instanceof Error && Reflect.get(error, "code") === "EPERM") return false;
    throw error;
  }
}

describe("openRegularNoFollow", () => {
  test("opens a regular file and hands back a handle that reads it", async () => {
    await writeFile(join(dir, "f"), "bytes");
    const handle = await openRegularNoFollow(join(dir, "f"));
    try {
      expect((await handle.readFile()).toString()).toBe("bytes");
    } finally {
      await handle.close();
    }
  });

  test("refuses a symlink to a file with ELOOP, with the platform's own flags", async () => {
    await writeFile(join(dir, "real"), "bytes");
    if (!(await tryLink(join(dir, "real"), join(dir, "link")))) return;
    await expect(openRegularNoFollow(join(dir, "link"))).rejects.toMatchObject({ code: "ELOOP" });
  });

  test("refuses a symlink to a file with ELOOP where there is no O_NOFOLLOW (the Windows case)", async () => {
    await writeFile(join(dir, "real"), "bytes");
    if (!(await tryLink(join(dir, "real"), join(dir, "link")))) return;
    await expect(openRegularNoFollow(join(dir, "link"), { noFollow: 0 })).rejects.toMatchObject({ code: "ELOOP" });
  });

  test("refuses a dangling symlink with ELOOP", async () => {
    if (!(await tryLink(join(dir, "nowhere"), join(dir, "dangling")))) return;
    await expect(openRegularNoFollow(join(dir, "dangling"), { noFollow: 0 })).rejects.toMatchObject({ code: "ELOOP" });
  });

  test("refuses a folder with ENOTREG, and never opens it", async () => {
    await mkdir(join(dir, "folder"));
    let opened = 0;
    const ops: OpenRegularOps = { ...NODE_OPS, open: (path, flags) => (opened++, NODE_OPS.open(path, flags)) };
    await expect(openRegularNoFollow(join(dir, "folder"), { noFollow: 0, ops })).rejects.toMatchObject({ code: "ENOTREG" });
    expect(opened).toBe(0);
  });

  test("passes a missing file through as ENOENT, so an absent file is told from a bad one", async () => {
    await expect(openRegularNoFollow(join(dir, "nope"), { noFollow: 0 })).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a different file swapped in between the lstat and the open is refused with ECHANGED, and its handle is closed", async () => {
    await writeFile(join(dir, "f"), "ours");
    await writeFile(join(dir, "other"), "theirs");
    let opened: FileHandle | undefined;
    const ops: OpenRegularOps = {
      lstat: NODE_OPS.lstat,
      open: async (path, flags) => {
        await rename(join(dir, "other"), path);
        opened = await open(path, flags);
        return opened;
      },
    };
    await expect(openRegularNoFollow(join(dir, "f"), { noFollow: 0, ops })).rejects.toMatchObject({ code: "ECHANGED" });
    expect(opened?.fd).toBe(-1);
  });

  test("a symlink swapped in between the lstat and the open, on a platform that follows it, is refused with ECHANGED", async () => {
    await writeFile(join(dir, "f"), "ours");
    await writeFile(join(dir, "secret"), "theirs");
    if (!(await tryLink(join(dir, "secret"), join(dir, "probe-link")))) return;
    const ops: OpenRegularOps = {
      lstat: NODE_OPS.lstat,
      open: async (path, flags) => {
        await rm(path);
        await symlink(join(dir, "secret"), path);
        return open(path, flags);
      },
    };
    await expect(openRegularNoFollow(join(dir, "f"), { noFollow: 0, ops })).rejects.toMatchObject({ code: "ECHANGED" });
  });

  test("asks the open for O_NOFOLLOW where the platform has it, and for nothing extra where it does not", async () => {
    await writeFile(join(dir, "f"), "x");
    const seen: (string | number)[] = [];
    const ops: OpenRegularOps = { lstat: NODE_OPS.lstat, open: (path, flags) => (seen.push(flags), NODE_OPS.open(path, constants.O_RDONLY)) };
    await (await openRegularNoFollow(join(dir, "f"), { noFollow: 0x40000, nonBlock: 0x800, ops })).close();
    await (await openRegularNoFollow(join(dir, "f"), { noFollow: 0, nonBlock: 0, ops })).close();
    expect(seen).toEqual([constants.O_RDONLY | 0x40000 | 0x800, constants.O_RDONLY]);
  });
});

describe("createExclusiveNoFollow", () => {
  test("creates an empty file and reports the identity of the file it created, from the open handle", async () => {
    const identity = await createExclusiveNoFollow(join(dir, "a"));
    const info = await stat(join(dir, "a"), { bigint: true });
    expect(identity).toEqual({ dev: String(info.dev), ino: String(info.ino) });
    expect(info.size).toBe(0n);
  });

  test("EEXIST for an existing file, which is left as it was", async () => {
    await writeFile(join(dir, "file"), "mine");
    await expect(createExclusiveNoFollow(join(dir, "file"))).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(join(dir, "file"), "utf8")).toBe("mine");
  });

  test("EEXIST for a folder, even where the open would answer with another code (Windows: EPERM)", async () => {
    await mkdir(join(dir, "folder"));
    const ops: OpenRegularOps = { lstat: NODE_OPS.lstat, open: () => Promise.reject(Object.assign(new Error("operation not permitted"), { code: "EPERM" })) };
    await expect(createExclusiveNoFollow(join(dir, "folder"), ops)).rejects.toMatchObject({ code: "EEXIST" });
  });

  test("EEXIST for a dangling symlink, and nothing is created at its target, even where the open follows links (Windows)", async () => {
    if (!(await tryLink(join(dir, "nowhere"), join(dir, "dangling")))) return;
    let opened = 0;
    const following: OpenRegularOps = { lstat: NODE_OPS.lstat, open: (path) => (opened++, open(path, "w")) };
    await expect(createExclusiveNoFollow(join(dir, "dangling"), following)).rejects.toMatchObject({ code: "EEXIST" });
    expect(opened).toBe(0);
    await expect(stat(join(dir, "nowhere"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a symlink that appears between the lstat and the open is reported as EEXIST, not taken for a claim on the name", async () => {
    if (!(await tryLink(join(dir, "x"), join(dir, "y")))) return;
    let looks = 0;
    const ops: OpenRegularOps = {
      lstat: (path) => (looks++ === 0 ? Promise.reject(Object.assign(new Error("no such file"), { code: "ENOENT" })) : NODE_OPS.lstat(path)),
      open: async (path) => {
        await symlink(join(dir, "target"), path);
        return open(path, "w"); // follows the link and creates the target: what Windows does
      },
    };
    await expect(createExclusiveNoFollow(join(dir, "name"), ops)).rejects.toMatchObject({ code: "EEXIST" });
  });
});
