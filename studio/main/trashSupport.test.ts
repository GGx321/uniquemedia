import { describe, expect, test } from "bun:test";
import { trashableOn } from "./trashSupport";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Windows: `shell.trashItem` runs SHFileOperation-style with no prompt, and on a place that has no Recycle Bin (a network share or a mapped
// network drive) such a call may delete for good. «Удалить аватар» promises the Trash, so a place that cannot be shown to have one is refused up front.
// macOS and Linux answer a refusal with an error, so nothing is pre-judged there.

describe("trashableOn", () => {
  test("macOS and Linux leave it to the Trash's own answer", async () => {
    const exists = async () => {
      throw new Error("must not be asked");
    };
    expect(await trashableOn("darwin", "/Volumes/Library/avatars/a", exists)).toBe(true);
    expect(await trashableOn("linux", "/home/a/library/avatars/a", exists)).toBe(true);
  });

  test("a Windows drive that has a Recycle Bin takes it", async () => {
    const asked: string[] = [];
    const exists = async (path: string) => {
      asked.push(path);
      return true;
    };

    expect(await trashableOn("win32", "C:\\Users\\a\\library\\avatars\\a", exists)).toBe(true);
    expect(asked).toEqual(["C:\\$Recycle.Bin"]);
  });

  test("a Windows drive with no Recycle Bin is refused", async () => {
    expect(await trashableOn("win32", "Z:\\library\\avatars\\a", async () => false)).toBe(false);
  });

  test("a network share is refused without looking", async () => {
    const exists = async () => {
      throw new Error("must not be asked");
    };
    expect(await trashableOn("win32", "\\\\server\\share\\library\\avatars\\a", exists)).toBe(false);
    expect(await trashableOn("win32", "\\\\?\\UNC\\server\\share\\library", exists)).toBe(false);
  });

  test("a place that cannot be looked at is refused", async () => {
    const exists = async () => {
      throw new Error("EIO");
    };
    expect(await trashableOn("win32", "D:\\library", exists)).toBe(false);
  });

  test("a path with no drive is refused", async () => {
    expect(await trashableOn("win32", "library\\avatars\\a", async () => true)).toBe(false);
  });

  test("the drive letter is read in either case", async () => {
    const asked: string[] = [];
    await trashableOn("win32", "d:\\library", async (path) => {
      asked.push(path);
      return true;
    });
    expect(asked).toEqual(["d:\\$Recycle.Bin"]);
  });
});
