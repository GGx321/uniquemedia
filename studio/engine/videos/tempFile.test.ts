import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { createTempExclusive, type TempFacts, type TempOps } from "./tempFile";
useNativeGlobals();

// The render's output file is created by the job itself, exclusively and without following a link, right before pass 2
// writes it by path. POSIX gets that from O_EXCL | O_NOFOLLOW. Windows has no O_NOFOLLOW, and CREATE_NEW without
// FILE_FLAG_OPEN_REPARSE_POINT may follow a DANGLING symlink, so what was created is compared with what the name leads to.

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "studio-tempfile-"));
  return dir;
}

const facts = (over: Partial<TempFacts> = {}): TempFacts => ({ isFile: true, isSymbolicLink: false, nlink: 1n, dev: 7n, ino: 42n, ...over });

/** A fake disk: `open` yields a handle over `created`; the name leads to `named`. */
function ops(created: TempFacts, named: TempFacts): TempOps & { unlinked: string[]; closed: number } {
  const state = { unlinked: [] as string[], closed: 0 };
  return {
    get unlinked() {
      return state.unlinked;
    },
    get closed() {
      return state.closed;
    },
    open: async () => ({
      stat: async () => created,
      close: async () => {
        state.closed++;
      },
    }),
    lstat: async () => named,
    unlink: async (path) => {
      state.unlinked.push(path);
    },
  };
}

describe("createTempExclusive", () => {
  test("creates an empty regular file with one link", () => {
    const dir = scratch();
    const path = join(dir, ".studio-part-x.mp4");

    return createTempExclusive(path).then(() => {
      expect(statSync(path).size).toBe(0);
      expect(statSync(path).nlink).toBe(1);
      rmSync(dir, { recursive: true, force: true });
    });
  });

  test("refuses a name that is already there, and leaves what was there alone", async () => {
    const dir = scratch();
    const path = join(dir, ".studio-part-x.mp4");
    writeFileSync(path, "not ours");

    await expect(createTempExclusive(path)).rejects.toMatchObject({ code: "EEXIST" });
    expect(statSync(path).size).toBe(8);
    rmSync(dir, { recursive: true, force: true });
  });

  test("refuses a symlink at the name, even a dangling one, and never creates its target", async () => {
    const dir = scratch();
    const path = join(dir, ".studio-part-x.mp4");
    const target = join(dir, "outside", "victim.mp4");
    mkdirSync(join(dir, "outside"));
    symlinkSync(target, path);

    await expect(createTempExclusive(path)).rejects.toBeInstanceOf(Error);
    expect(existsSync(target)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a name that leads to another file than the one created is refused; a symlink there is removed (never its target)", async () => {
    const fake = ops(facts(), facts({ isSymbolicLink: true, isFile: false, ino: 99n }));

    await expect(createTempExclusive("/export/Mia/.studio-part-x.mp4", fake)).rejects.toMatchObject({ code: "ELOOP" });

    expect(fake.unlinked).toEqual(["/export/Mia/.studio-part-x.mp4"]);
    expect(fake.closed).toBe(1);
  });

  test("a regular file of another inode under our name is refused and NOT removed: it is not ours", async () => {
    const fake = ops(facts(), facts({ ino: 43n }));

    await expect(createTempExclusive("/export/Mia/.studio-part-x.mp4", fake)).rejects.toMatchObject({ code: "ELOOP" });

    expect(fake.unlinked).toEqual([]);
  });

  test("a second hard link to the created file is refused", async () => {
    const fake = ops(facts(), facts({ nlink: 2n }));

    await expect(createTempExclusive("/export/Mia/.studio-part-x.mp4", fake)).rejects.toMatchObject({ code: "ELOOP" });
  });

  test("the same inode on the same device with one link is accepted, and the handle is closed", async () => {
    const fake = ops(facts(), facts());

    await createTempExclusive("/export/Mia/.studio-part-x.mp4", fake);

    expect(fake.closed).toBe(1);
    expect(fake.unlinked).toEqual([]);
  });
});
