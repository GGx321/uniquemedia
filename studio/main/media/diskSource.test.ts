import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, rename, utimes, rm, symlink, truncate, unlink, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { openDiskSource, type DiskTarget } from "./diskSource";
import { canSymlink, countingFs } from "./testing";
useNativeGlobals();

// The disk source is the one place a served file is opened. Its promises, each pinned below:
//   - a file is served only when every step under the root is a plain directory and the last a plain file;
//   - the OPENED file (not the name) is the one checked: same file as the real path inside the root;
//   - no handle is held between reads, so nothing of ours can block a delete on Windows;
//   - a file replaced, shrunk or deleted after the check is an error on the next read, never other bytes.

const HEAD = Buffer.from("MEDIA-OK-");
const sniff = (header: Uint8Array): boolean => Buffer.from(header.subarray(0, HEAD.length)).equals(HEAD);
const body = (n: number): Buffer => Buffer.concat([HEAD, Buffer.alloc(n, 0x61)]);

let root = "";
let outside = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "studio-disksrc-"));
  outside = await mkdtemp(join(tmpdir(), "studio-disksrc-out-"));
  await mkdir(join(root, "dir"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const target = (overrides: Partial<DiskTarget> = {}): DiskTarget => ({ root, segments: ["dir", "file.bin"], maxBytes: 1024 * 1024, sniff, ...overrides });

const ops = countingFs;

const write = (name: string, data: Buffer | string): Promise<void> => writeFile(join(root, "dir", name), data);

describe("openDiskSource: what it serves", () => {
  test("a regular file under the root: its size and the exact bytes of any slice", async () => {
    const data = body(5000);
    await write("file.bin", data);
    const source = await openDiskSource(target());
    expect(source?.size).toBe(data.length);
    expect(Buffer.from((await source?.read(0, 9)) ?? []).toString()).toBe("MEDIA-OK-");
    expect(Buffer.from((await source?.read(100, 50)) ?? []).equals(data.subarray(100, 150))).toBe(true);
    expect(Buffer.from((await source?.read(data.length - 1, 1)) ?? []).equals(data.subarray(data.length - 1))).toBe(true);
  });

  test("a root that is itself a link to a real folder is fine: the owner may point Studio at one", async () => {
    await write("file.bin", body(10));
    const linkedRoot = join(outside, "linked-root");
    await symlink(root, linkedRoot, "junction");
    expect((await openDiskSource(target({ root: linkedRoot })))?.size).toBe(body(10).length);
  });
});

describe("openDiskSource: what it refuses (null, never a throw)", () => {
  test("a missing file", async () => {
    expect(await openDiskSource(target())).toBeNull();
  });

  test("a missing root", async () => {
    expect(await openDiskSource(target({ root: join(root, "nope") }))).toBeNull();
  });

  test("an empty file", async () => {
    await write("file.bin", "");
    expect(await openDiskSource(target())).toBeNull();
  });

  test("a file one byte over the route's limit", async () => {
    await write("file.bin", body(100));
    expect(await openDiskSource(target({ maxBytes: body(100).length - 1 }))).toBeNull();
  });

  test("a file exactly at the route's limit", async () => {
    await write("file.bin", body(100));
    expect((await openDiskSource(target({ maxBytes: body(100).length })))?.size).toBe(body(100).length);
  });

  test("a file whose first bytes are not what the route serves", async () => {
    await write("file.bin", "<html>not media</html>");
    expect(await openDiskSource(target())).toBeNull();
  });

  test("a folder where the file should be", async () => {
    await mkdir(join(root, "dir", "file.bin"));
    expect(await openDiskSource(target())).toBeNull();
  });

  test("a file where a folder should be", async () => {
    await writeFile(join(root, "flat"), body(10));
    expect(await openDiskSource(target({ segments: ["flat", "file.bin"] }))).toBeNull();
  });

  test.skipIf(!canSymlink)("a symlink at the served path, to a file outside the root", async () => {
    await writeFile(join(outside, "secret.bin"), body(10));
    await symlink(join(outside, "secret.bin"), join(root, "dir", "file.bin"), "file");
    expect(await openDiskSource(target())).toBeNull();
  });

  test.skipIf(!canSymlink)("a symlink at the served path, to another file inside the root: no link is followed at all", async () => {
    await write("other.bin", body(10));
    await symlink(join(root, "dir", "other.bin"), join(root, "dir", "file.bin"), "file");
    expect(await openDiskSource(target())).toBeNull();
  });

  test.skipIf(!canSymlink)("a dangling symlink at the served path", async () => {
    await symlink(join(outside, "gone.bin"), join(root, "dir", "file.bin"), "file");
    expect(await openDiskSource(target())).toBeNull();
  });

  test("a folder on the way that is a link to a folder outside the root", async () => {
    await writeFile(join(outside, "file.bin"), body(10));
    await symlink(outside, join(root, "linked"), "junction");
    expect(await openDiskSource(target({ segments: ["linked", "file.bin"] }))).toBeNull();
  });

  test("a folder on the way that is a link to another folder inside the root", async () => {
    await write("file.bin", body(10));
    await symlink(join(root, "dir"), join(root, "alias"), "junction");
    expect(await openDiskSource(target({ segments: ["alias", "file.bin"] }))).toBeNull();
  });

  test.skipIf(process.platform === "win32")("a FIFO at the served path: refused without blocking on it", async () => {
    const made = Bun.spawnSync(["mkfifo", join(root, "dir", "file.bin")]);
    expect(made.exitCode).toBe(0);
    expect(await openDiskSource(target())).toBeNull();
  });

  test("a file swapped for another between the check and the open", async () => {
    await write("file.bin", body(10));
    await writeFile(join(outside, "evil.bin"), body(10));
    const swapping = ops({
      // After EVERY look at the file, so whichever lstat is the one right before the open, the name then leads to a new
      // file. The new file is made before the old one goes (a rename over it), so it cannot reuse the old inode number.
      afterLstat: async (path) => {
        if (!path.endsWith("file.bin")) return;
        await writeFile(`${path}.swap`, body(20));
        await rename(`${path}.swap`, path);
      },
    });
    expect(await openDiskSource(target(), swapping)).toBeNull();
    expect(swapping.closed).toBe(swapping.opened);
  });

  test.skipIf(process.platform === "win32")("a folder swapped for a link out of the root between the open and the real-path check", async () => {
    await write("file.bin", body(10));
    await mkdir(join(outside, "dir"));
    await writeFile(join(outside, "dir", "file.bin"), body(10));
    let swapped = false;
    const swapping = ops({
      beforeRealpath: async (path) => {
        if (swapped || !path.endsWith("file.bin")) return;
        swapped = true;
        await rename(join(root, "dir"), join(root, "dir-moved"));
        await symlink(join(outside, "dir"), join(root, "dir"));
      },
    });
    expect(await openDiskSource(target(), swapping)).toBeNull();
    expect(swapping.closed).toBe(swapping.opened);
  });

  // The two checks after the open, each alone, on every platform. They cannot use a renamed folder (Windows will not
  // rename a folder with a file open inside it); they retarget a JUNCTION that is the root itself instead, between the
  // open and the real-path look. A junction needs no privilege, and on macOS and Linux it is a symlink to a folder.
  const retarget = async (linkPath: string, to: string): Promise<void> => {
    await rm(linkPath, { recursive: false, force: true });
    await symlink(to, linkPath, "junction");
  };

  test("the real-path check alone: the root's link moved to a folder outside, where a hard link to the very same file lives", async () => {
    await write("file.bin", body(10));
    await mkdir(join(outside, "dir"));
    await link(join(root, "dir", "file.bin"), join(outside, "dir", "file.bin"));
    const via = join(outside, "via");
    await symlink(root, via, "junction");
    let moved = false;
    const swapping = ops({
      beforeRealpath: async (path) => {
        if (moved || !path.endsWith("file.bin")) return;
        moved = true;
        await retarget(via, outside);
      },
    });
    // Same inode, size and times either way: only "is the real path inside the real root" can say no.
    expect(await openDiskSource(target({ root: via }), swapping)).toBeNull();
    expect(moved).toBe(true);
    expect(swapping.closed).toBe(swapping.opened);
  });

  test("the identity check alone: the root's link moved inside the root to another file of the same name and size", async () => {
    await write("file.bin", body(10));
    await mkdir(join(root, "alt", "dir"), { recursive: true });
    await writeFile(join(root, "alt", "dir", "file.bin"), body(10));
    const via = join(outside, "via");
    await symlink(root, via, "junction");
    let moved = false;
    const swapping = ops({
      beforeRealpath: async (path) => {
        if (moved || !path.endsWith("file.bin")) return;
        moved = true;
        await retarget(via, join(root, "alt"));
      },
    });
    // The real path is inside the real root, so only "is this the file that was opened" can say no.
    expect(await openDiskSource(target({ root: via }), swapping)).toBeNull();
    expect(moved).toBe(true);
    expect(swapping.closed).toBe(swapping.opened);
  });

  test("every handle it opened is closed after a refusal", async () => {
    await write("file.bin", "<html></html>");
    const counted = ops();
    expect(await openDiskSource(target(), counted)).toBeNull();
    expect(counted.closed).toBe(counted.opened);
  });
});

describe("openDiskSource: reads", () => {
  test("no handle is open once it has answered, and none between reads", async () => {
    await write("file.bin", body(1000));
    const counted = ops();
    const source = await openDiskSource(target(), counted);
    expect(counted.closed).toBe(counted.opened);
    await source?.read(0, 10);
    expect(counted.closed).toBe(counted.opened);
    await source?.read(500, 10);
    expect(counted.closed).toBe(counted.opened);
  });

  test("a file replaced by another after the check is an error on the next read, never the other file's bytes", async () => {
    await write("file.bin", body(1000));
    const source = await openDiskSource(target());
    await write("swap.bin", body(1000));
    await rename(join(root, "dir", "swap.bin"), join(root, "dir", "file.bin"));
    await expect(source?.read(0, 10)).rejects.toThrow();
  });

  test("a rewrite in place with the same size and the modification time put back is still an error: ctime cannot be put back", async () => {
    await write("file.bin", body(1000));
    const path = join(root, "dir", "file.bin");
    // A whole-millisecond time, so that `utimes` (which takes a Date) can put back exactly what the file had.
    const fixed = new Date(Date.now() - 60_000);
    fixed.setMilliseconds(0);
    await utimes(path, fixed, fixed);
    const source = await openDiskSource(target());
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(path, Buffer.concat([HEAD, Buffer.alloc(1000, 0x62)]));
    await utimes(path, fixed, fixed);
    await expect(source?.read(0, 10)).rejects.toThrow();
  });

  test("a file shrunk after the check is an error on a read past its new end", async () => {
    await write("file.bin", body(1000));
    const source = await openDiskSource(target());
    await truncate(join(root, "dir", "file.bin"), 100);
    await expect(source?.read(500, 10)).rejects.toThrow();
  });

  test("a file grown after the check is an error on the next read: what was promised was the size it had", async () => {
    await write("file.bin", body(1000));
    const source = await openDiskSource(target());
    await appendFile(join(root, "dir", "file.bin"), "tail");
    expect(source?.size).toBe(body(1000).length);
    await expect(source?.read(0, 10)).rejects.toThrow();
  });

  test("a read that reaches past the checked size is refused", async () => {
    await write("file.bin", body(100));
    const source = await openDiskSource(target());
    await expect(source?.read(body(100).length - 1, 2)).rejects.toThrow();
  });

  test("a file deleted after the check can be deleted (nothing of ours holds it) and the next read fails", async () => {
    await write("file.bin", body(1000));
    const counted = ops();
    const source = await openDiskSource(target(), counted);
    await source?.read(0, 10);
    // On Windows this is the lock case: a handle held for the whole stream would make this unlink fail or leave it pending.
    await unlink(join(root, "dir", "file.bin"));
    await expect(source?.read(10, 10)).rejects.toThrow();
    expect(counted.closed).toBe(counted.opened);
  });

  test("a file with a second hard link is served: the owner's own copy of a file is not an attack", async () => {
    await write("file.bin", body(10));
    await link(join(root, "dir", "file.bin"), join(root, "dir", "copy.bin"));
    expect((await openDiskSource(target()))?.size).toBe(body(10).length);
  });
});
