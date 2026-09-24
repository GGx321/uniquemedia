import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { folderIdentity, type FolderFs } from "./folderIdentity";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "studio-folder-id-"));
  await mkdir(join(dir, "library"));
  await mkdir(join(dir, "holiday-photos"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A volume that reports the same file id for every folder: 0 (some SMB/WebDAV redirectors, FUSE) or a non-unique one. */
function volumeWithIds(dev: bigint, ino: bigint): FolderFs {
  return {
    stat: async (path) => {
      const info = await stat(path, { bigint: true });
      return { isDirectory: () => info.isDirectory(), dev, ino };
    },
    realpath: (path) => realpath(path),
  };
}

async function same(a: string, b: string, fs?: FolderFs): Promise<boolean> {
  const [x, y] = await Promise.all([folderIdentity(a, fs), folderIdentity(b, fs)]);
  return x !== null && x === y;
}

describe("folderIdentity: two folders are one only when nothing says otherwise", () => {
  test("two different folders on a volume without file ids (dev 0, ino 0) are not the same", async () => {
    expect(await same(join(dir, "library"), join(dir, "holiday-photos"), volumeWithIds(0n, 0n))).toBe(false);
  });

  test("two different folders with the same non-zero file id (ids not unique on the volume) are not the same", async () => {
    expect(await same(join(dir, "library"), join(dir, "holiday-photos"), volumeWithIds(42n, 7n))).toBe(false);
  });

  test("a different folder mounted at the same path (another id there now) is not the same", async () => {
    const before = await folderIdentity(join(dir, "library"), volumeWithIds(42n, 7n));
    const after = await folderIdentity(join(dir, "library"), volumeWithIds(43n, 7n));
    expect(before === after).toBe(false);
  });

  test("the same folder through a trailing slash, a symlink and another letter case is the same", async () => {
    await symlink(join(dir, "library"), join(dir, "link"));
    const library = join(dir, "library");
    expect(await same(library, `${library}/`)).toBe(true);
    expect(await same(library, join(dir, "link"))).toBe(true);
    // Only where the disk ignores case (APFS and NTFS by default) is another case the same folder.
    const caseInsensitive = (await folderIdentity(join(dir, "LIBRARY"))) !== null;
    if (caseInsensitive) expect(await same(library, join(dir, "LIBRARY"))).toBe(true);
  });

  test("on a volume without file ids the same folder through a trailing slash or a symlink is still the same", async () => {
    await symlink(join(dir, "library"), join(dir, "link"));
    const fs = volumeWithIds(0n, 0n);
    expect(await same(join(dir, "library"), `${join(dir, "library")}/`, fs)).toBe(true);
    expect(await same(join(dir, "library"), join(dir, "link"), fs)).toBe(true);
  });

  test("a folder whose canonical path cannot be read (realpath unsupported by the driver) still has an identity", async () => {
    const fs: FolderFs = { stat: (path) => stat(path, { bigint: true }), realpath: async () => Promise.reject(new Error("EISDIR: realpath")) };
    expect(await folderIdentity(join(dir, "library"), fs)).not.toBeNull();
    expect(await same(join(dir, "library"), `${join(dir, "library")}/`, fs)).toBe(true);
    expect(await same(join(dir, "library"), join(dir, "holiday-photos"), fs)).toBe(false);
  });

  test("without realpath and without file ids, two different folders are still not the same", async () => {
    const fs: FolderFs = { ...volumeWithIds(0n, 0n), realpath: async () => Promise.reject(new Error("EISDIR: realpath")) };
    expect(await same(join(dir, "library"), join(dir, "holiday-photos"), fs)).toBe(false);
  });

  test("there is no identity without a folder: a missing path or a file", async () => {
    await writeFile(join(dir, "beach.jpg"), "x");
    expect(await folderIdentity(join(dir, "missing"))).toBeNull();
    expect(await folderIdentity(join(dir, "beach.jpg"))).toBeNull();
  });
});
