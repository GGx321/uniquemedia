import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { link, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { CopyMismatchError, NODE_COMMIT_FS } from "./commitFs";
import { fakeVideoBytes, sha256Of } from "./testing/kit";
useNativeGlobals();

// The EXDEV fallback's copy (Commit row, step 5): into the claimed placeholder
// and nowhere else, and checked against the verified size and sha256.

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "studio-copyover-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const expectedOf = (bytes: Uint8Array) => ({ bytes: bytes.length, sha256: sha256Of(bytes) });

describe("copyOver", () => {
  test("copies a multi-chunk file into an empty placeholder, byte for byte", async () => {
    const bytes = fakeVideoBytes(2 * 1024 * 1024 + 123);
    await writeFile(join(dir, "src"), bytes);
    await writeFile(join(dir, "dst"), "");
    await NODE_COMMIT_FS.copyOver(join(dir, "src"), join(dir, "dst"), expectedOf(bytes));
    expect(sha256Of(await readFile(join(dir, "dst")))).toBe(sha256Of(bytes));
  });

  test("refuses a destination that already holds bytes: it is not our placeholder", async () => {
    const bytes = fakeVideoBytes(100);
    await writeFile(join(dir, "src"), bytes);
    await writeFile(join(dir, "dst"), "someone else's data");
    await expect(NODE_COMMIT_FS.copyOver(join(dir, "src"), join(dir, "dst"), expectedOf(bytes))).rejects.toBeInstanceOf(CopyMismatchError);
    expect(await readFile(join(dir, "dst"), "utf8")).toBe("someone else's data");
  });

  test("refuses a destination that is a symlink, and writes nothing through it", async () => {
    const bytes = fakeVideoBytes(100);
    await writeFile(join(dir, "src"), bytes);
    await writeFile(join(dir, "elsewhere"), "");
    await symlink(join(dir, "elsewhere"), join(dir, "dst"));
    await expect(NODE_COMMIT_FS.copyOver(join(dir, "src"), join(dir, "dst"), expectedOf(bytes))).rejects.toThrow();
    expect(await readFile(join(dir, "elsewhere"), "utf8")).toBe("");
  });

  test("refuses a destination with a second hard link: the bytes would appear under another name too", async () => {
    const bytes = fakeVideoBytes(100);
    await writeFile(join(dir, "src"), bytes);
    await writeFile(join(dir, "dst"), "");
    await link(join(dir, "dst"), join(dir, "other-name"));
    await expect(NODE_COMMIT_FS.copyOver(join(dir, "src"), join(dir, "dst"), expectedOf(bytes))).rejects.toBeInstanceOf(CopyMismatchError);
    expect(await readFile(join(dir, "other-name"), "utf8")).toBe("");
  });

  test("rejects when the source is not the verified bytes (it changed after the hash), size or content", async () => {
    const bytes = fakeVideoBytes(5000);
    await writeFile(join(dir, "src"), bytes);
    await writeFile(join(dir, "dst"), "");
    const flipped = Uint8Array.from(bytes);
    flipped[4000] = (flipped[4000] ?? 0) ^ 1;
    await expect(NODE_COMMIT_FS.copyOver(join(dir, "src"), join(dir, "dst"), expectedOf(flipped))).rejects.toBeInstanceOf(CopyMismatchError);
    await writeFile(join(dir, "dst2"), "");
    await expect(NODE_COMMIT_FS.copyOver(join(dir, "src"), join(dir, "dst2"), { bytes: 4999, sha256: sha256Of(bytes) })).rejects.toBeInstanceOf(CopyMismatchError);
  });

  test("a missing source rejects with ENOENT and leaves the placeholder empty", async () => {
    await writeFile(join(dir, "dst"), "");
    await expect(NODE_COMMIT_FS.copyOver(join(dir, "nope"), join(dir, "dst"), { bytes: 1, sha256: sha256Of("x") })).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readFile(join(dir, "dst"))).length).toBe(0);
  });
});
