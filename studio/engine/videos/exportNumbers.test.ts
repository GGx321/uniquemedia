import { describe, expect, test } from "bun:test";
import type { AvatarManifest, UsageReason } from "../library";
import { highestNamedNumber, type ExportNumberLibrary, type NumberFs } from "./exportNumbers";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// The scan that numbers an export file: what it reads from disk, when, and what it does for a signal.

const SCOPE = { rootId: "root-1", folderName: "Mia", date: "2026-09-29", kind: "photo", caseInsensitive: false } as const;
const AVATAR = { id: "avatar-1" } as AvatarManifest;

function libraryWith(reasons: readonly UsageReason[]): ExportNumberLibrary {
  return { listAvatars: () => [AVATAR], namedVideoFiles: () => [], usageReasons: () => [...reasons] };
}

/** A disk that lists nothing and says which folders it was asked about. */
function spyFs(asked: string[]): NumberFs {
  return {
    readdir: async (path) => (asked.push(path), []),
    lstat: async () => ({ size: 0, isFile: true }),
    readFile: async () => "",
  };
}

describe("which avatars have their videos/ folder read from disk for the numbers", () => {
  test.each<UsageReason>(["index-stale", "record-unreadable", "record-inaccessible"])("%s: its records are not all in the index, so the folder is read", async (reason) => {
    const asked: string[] = [];

    await highestNamedNumber(libraryWith([reason]), "/lib", SCOPE, undefined, () => undefined, spyFs(asked));

    expect(asked.some((path) => path.endsWith("videos"))).toBe(true);
  });

  test.each<UsageReason>(["rejects-unreadable", "library-too-new"])("%s: it says nothing about the records in the index, so the folder is not read", async (reason) => {
    const asked: string[] = [];

    await highestNamedNumber(libraryWith([reason]), "/lib", SCOPE, undefined, () => undefined, spyFs(asked));

    expect(asked.some((path) => path.endsWith("videos"))).toBe(false);
    expect(asked.some((path) => path.endsWith(".pending"))).toBe(true);
  });

  test("an avatar with nothing wrong reads only its .pending", async () => {
    const asked: string[] = [];

    await highestNamedNumber(libraryWith([]), "/lib", SCOPE, undefined, () => undefined, spyFs(asked));

    expect(asked).toHaveLength(1);
    expect(asked[0]?.endsWith(".pending")).toBe(true);
  });
});

describe("the signal's reason", () => {
  test("a disk error that arrives once the signal has fired comes out as the signal's reason, not as the disk's error", async () => {
    const stop = new AbortController();
    const reason = new Error("the deadline");
    const fs: NumberFs = {
      readdir: async () => {
        stop.abort(reason);
        throw Object.assign(new Error("EIO"), { code: "EIO" });
      },
      lstat: async () => ({ size: 0, isFile: true }),
      readFile: async () => "",
    };

    await expect(highestNamedNumber(libraryWith([]), "/lib", SCOPE, stop.signal, () => undefined, fs)).rejects.toBe(reason);
  });

  test("so does a read error of a file", async () => {
    const stop = new AbortController();
    const reason = new Error("the deadline");
    const fs: NumberFs = {
      readdir: async () => [{ name: "video-00000001.json", isFile: true }],
      lstat: async () => ({ size: 10, isFile: true }),
      readFile: async () => {
        stop.abort(reason);
        throw Object.assign(new Error("EIO"), { code: "EIO" });
      },
    };

    await expect(highestNamedNumber(libraryWith([]), "/lib", SCOPE, stop.signal, () => undefined, fs)).rejects.toBe(reason);
  });
});
