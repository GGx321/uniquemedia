import { describe, expect, test } from "bun:test";
import { MAX_REFUSED_FILES } from "../shared/engine";
import { droppedFiles, MAX_DROPPED_FILES } from "./dropped";

// 3f.6 round 2 (M13, the owner's decision of 2026-10-04): files dropped from Finder or Explorer onto «Мои». The page hands the preload `File`
// objects ONLY; the preload asks Electron for each one's path (`webUtils.getPathForFile`) and sends main the paths. A `File` the page made
// itself (`new File([...], "x")`) has no path: it is dropped, so a page cannot forge one. Anything that is not a `File` is dropped too.
// Files beyond the ones a drop's answer can list are never looked at, and are counted for main, which reports them as skipped.

/** A stand-in for Electron's `webUtils`: the path the OS gave each dropped file, by the File object itself. */
function fakeWebUtils(paths: ReadonlyMap<File, unknown>) {
  const asked: File[] = [];
  return {
    asked,
    getPathForFile(file: File): unknown {
      asked.push(file);
      return paths.has(file) ? paths.get(file) : "";
    },
  };
}

describe("the preload's mapping of dropped files to paths", () => {
  test("each File becomes the path the OS gave it, in the order dropped", () => {
    const a = new File(["a"], "beach.jpg", { type: "image/jpeg" });
    const b = new File(["b"], "walk.mp4", { type: "video/mp4" });
    const utils = fakeWebUtils(new Map([[a, "/Users/me/beach.jpg"], [b, "/Users/me/walk.mp4"]]));
    expect(droppedFiles([a, b], utils)).toEqual({ paths: ["/Users/me/beach.jpg", "/Users/me/walk.mp4"], more: 0 });
  });

  test("a File the page made itself has no path and is dropped (an empty path); the others go through", () => {
    const real = new File(["a"], "beach.jpg");
    const forged = new File(["x"], "/etc/passwd");
    const utils = fakeWebUtils(new Map([[real, "/Users/me/beach.jpg"]]));
    expect(droppedFiles([forged, real], utils)).toEqual({ paths: ["/Users/me/beach.jpg"], more: 0 });
  });

  test("anything that is not a File is never asked about: a string path, a plain object, a Blob, null", () => {
    const utils = fakeWebUtils(new Map());
    const notFiles: unknown[] = ["/etc/passwd", { path: "/etc/passwd", name: "x" }, null, undefined, 7, new Blob(["x"])];
    expect(droppedFiles(notFiles, utils)).toEqual({ paths: [], more: 0 });
    expect(utils.asked).toEqual([]);
  });

  test("not an array is nothing", () => {
    const utils = fakeWebUtils(new Map());
    for (const value of [null, undefined, "/etc/passwd", { 0: new File(["a"], "a") }]) expect(droppedFiles(value, utils)).toEqual({ paths: [], more: 0 });
  });

  test("a path that is not a non-empty string is dropped (a broken bridge)", () => {
    const file = new File(["a"], "a.jpg");
    for (const odd of [42, null, undefined, "", { path: "/x" }]) expect(droppedFiles([file], fakeWebUtils(new Map([[file, odd]])))).toEqual({ paths: [], more: 0 });
  });

  test("the preload looks at as many files as a pick's answer lists (the contract's MAX_REFUSED_FILES)", () => {
    expect(MAX_DROPPED_FILES).toBe(MAX_REFUSED_FILES);
  });

  test("at most MAX_DROPPED_FILES are looked at; the rest are counted, never dropped silently", () => {
    const files = Array.from({ length: MAX_DROPPED_FILES + 3 }, (_, i) => new File(["a"], `f${i}.jpg`));
    const utils = fakeWebUtils(new Map(files.map((f, i) => [f, `/drop/f${i}.jpg`])));
    const dropped = droppedFiles(files, utils);
    expect(dropped.paths).toHaveLength(MAX_DROPPED_FILES);
    expect(dropped.more).toBe(3);
    expect(utils.asked).toHaveLength(MAX_DROPPED_FILES);
  });
});
