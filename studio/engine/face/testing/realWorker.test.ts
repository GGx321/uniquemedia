import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { locateRealWorker, REPO_ROOT } from "./realWorker";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
useNativeGlobals();

describe("locateRealWorker: source or bundle is read from the module, not from the environment", () => {
  test("a .ts source finds the repo from its own place and the .ts worker, whatever STUDIO_ROOT says", () => {
    const root = join(import.meta.dirname, "a-repo");
    const url = pathToFileURL(join(root, "studio", "engine", "face", "testing", "realWorker.ts")).href;
    const worker = pathToFileURL(join(root, "studio", "engine", "face", "worker", "faceWorker.ts")).href;
    for (const studioRoot of [undefined, "", "/somewhere/else"]) {
      const found = locateRealWorker(url, studioRoot);
      expect({ repoRoot: found.repoRoot, workerUrl: found.workerUrl.href }).toEqual({ repoRoot: root, workerUrl: worker });
    }
  });

  test("a .mjs bundle takes the repo from STUDIO_ROOT and the worker built next to it", () => {
    const found = locateRealWorker("file:///tmp/bundle/workerGate.real.node-test.mjs", "/the/repo");
    expect(found.repoRoot).toBe("/the/repo");
    expect(found.workerUrl.href).toBe("file:///tmp/bundle/faceWorker.js");
  });

  test("a bundle without STUDIO_ROOT throws, empty included: it must not look for the repo in a temp folder", () => {
    for (const studioRoot of [undefined, ""]) {
      expect(() => locateRealWorker("file:///tmp/bundle/x.mjs", studioRoot)).toThrow(/STUDIO_ROOT/);
    }
  });

  test("a .js or .cjs bundle counts as a bundle too", () => {
    expect(() => locateRealWorker("file:///tmp/bundle/x.js", undefined)).toThrow(/STUDIO_ROOT/);
    expect(() => locateRealWorker("file:///tmp/bundle/x.cjs", undefined)).toThrow(/STUDIO_ROOT/);
  });

  test("under bun test this module is the source: the repo root is the real one", () => {
    expect(REPO_ROOT).toBe(join(import.meta.dirname, "..", "..", "..", ".."));
  });
});
