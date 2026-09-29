import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { createTempExclusive } from "./tempFile";
useNativeGlobals();

// The render's output file is created by the job itself, exclusively and without following a link, right before pass 2
// writes it by path. The mechanics (identity by handle, the Windows dangling-link case) are `openRegular.ts`'s own tests;
// these pin what the render relies on.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "studio-tempfile-"));
  dirs.push(dir);
  return dir;
};

describe("createTempExclusive", () => {
  test("creates an empty regular file with one link", async () => {
    const path = join(scratch(), ".studio-part-x.mp4");

    await createTempExclusive(path);

    expect(statSync(path).size).toBe(0);
    expect(statSync(path).nlink).toBe(1);
  });

  test("refuses a name that is already there, and leaves what was there alone", async () => {
    const path = join(scratch(), ".studio-part-x.mp4");
    writeFileSync(path, "not ours");

    await expect(createTempExclusive(path)).rejects.toMatchObject({ code: "EEXIST" });
    expect(statSync(path).size).toBe(8);
  });

  test("refuses a symlink at the name, even a dangling one, and never creates its target", async () => {
    const dir = scratch();
    const path = join(dir, ".studio-part-x.mp4");
    const target = join(dir, "outside", "victim.mp4");
    mkdirSync(join(dir, "outside"));
    symlinkSync(target, path);

    await expect(createTempExclusive(path)).rejects.toMatchObject({ code: "EEXIST" });
    expect(existsSync(target)).toBe(false);
  });

  test("refuses a symlink to an existing file too, and leaves that file as it was", async () => {
    const dir = scratch();
    const path = join(dir, ".studio-part-x.mp4");
    const target = join(dir, "victim.mp4");
    writeFileSync(target, "the owner's file");
    symlinkSync(target, path);

    await expect(createTempExclusive(path)).rejects.toMatchObject({ code: "EEXIST" });
    expect(statSync(target).size).toBe(16);
  });
});
