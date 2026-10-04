import { describe, expect, test } from "bun:test";
import {
  SIZE_LIMIT_BYTES,
  blobsToDelete,
  buildLatest,
  checkDowngrade,
  checkSize,
  classifyAsset,
  classifyAssets,
  currentVersionOf,
  parseVersion,
  staleBeforeUpload,
} from "./downloads";

describe("classifyAssets", () => {
  test("picks exactly one dmg and one exe, ignoring other files", () => {
    expect(classifyAssets(["a.dmg", "b.exe", "latest.yml", "a.dmg.blockmap"])).toEqual({ mac: "a.dmg", win: "b.exe" });
  });
  test("fails when an installer is missing", () => {
    expect(() => classifyAssets(["a.dmg"])).toThrow(/\.exe/);
    expect(() => classifyAssets(["b.exe"])).toThrow(/\.dmg/);
    expect(() => classifyAssets([])).toThrow();
  });
  test("fails on more than one of a kind, before anything is uploaded", () => {
    expect(() => classifyAssets(["a.dmg", "c.dmg", "b.exe"])).toThrow(/more than one/i);
    expect(() => classifyAssets(["a.dmg", "b.exe", "c.exe"])).toThrow(/more than one/i);
  });
});

describe("currentVersionOf", () => {
  test("reads a valid latest.json", () => {
    expect(currentVersionOf({ version: "0.6.0", mac: "m", win: "w", publishedAt: "t" })).toBe("0.6.0");
  });
  test("rejects anything else rather than guessing", () => {
    for (const bad of [null, "x", {}, { version: 6 }, { version: "v0.6.0" }, { version: "0.6" }]) {
      expect(() => currentVersionOf(bad)).toThrow();
    }
  });
});

describe("checkDowngrade", () => {
  test("allows newer and equal versions", () => {
    expect(() => checkDowngrade("0.6.1", "0.6.0", false)).not.toThrow();
    expect(() => checkDowngrade("0.6.0", "0.6.0", false)).not.toThrow();
    expect(() => checkDowngrade("0.6.0", null, false)).not.toThrow();
  });
  test("compares numerically, not as strings", () => {
    expect(() => checkDowngrade("0.10.0", "0.9.0", false)).not.toThrow();
    expect(() => checkDowngrade("0.9.0", "0.10.0", false)).toThrow(/downgrade/i);
  });
  test("refuses an older tag unless forced", () => {
    expect(() => checkDowngrade("0.5.9", "0.6.0", false)).toThrow(/downgrade/i);
    expect(() => checkDowngrade("0.5.9", "0.6.0", true)).not.toThrow();
  });
});

describe("staleBeforeUpload", () => {
  const all = [
    "uniquemedia/latest.json",
    "uniquemedia/0.4.0/a.dmg",
    "uniquemedia/0.5.0/a.dmg",
    "uniquemedia/0.5.0/b.exe",
    "other/x",
  ];
  test("keeps only the version latest.json points to (and latest.json)", () => {
    expect(staleBeforeUpload(all, "0.5.0")).toEqual(["uniquemedia/0.4.0/a.dmg"]);
  });
  test("without a current version nothing but latest.json is kept", () => {
    expect(staleBeforeUpload(all, null)).toEqual([
      "uniquemedia/0.4.0/a.dmg",
      "uniquemedia/0.5.0/a.dmg",
      "uniquemedia/0.5.0/b.exe",
    ]);
  });
});

describe("checkSize", () => {
  const MB = 1024 * 1024;
  test("passes when kept blobs plus new files fit", () => {
    expect(() => checkSize([{ pathname: "uniquemedia/0.5.0/a.dmg", size: 220 * MB }], "0.6.0", 440 * MB)).not.toThrow();
  });
  test("fails with a clear message when the total would exceed the limit", () => {
    expect(() => checkSize([{ pathname: "uniquemedia/0.5.0/a.dmg", size: 600 * MB }], "0.6.0", 400 * MB)).toThrow(
      /950 MB/,
    );
  });
  test("one byte over the limit fails, exactly the limit passes", () => {
    expect(() => checkSize([], "0.6.0", SIZE_LIMIT_BYTES)).not.toThrow();
    expect(() => checkSize([], "0.6.0", SIZE_LIMIT_BYTES + 1)).toThrow();
  });
  test("an existing copy of the version being uploaded is overwritten, not counted twice", () => {
    expect(() =>
      checkSize([{ pathname: "uniquemedia/0.6.0/a.dmg", size: 500 * MB }], "0.6.0", 500 * MB),
    ).not.toThrow();
  });
});

describe("parseVersion", () => {
  test("strips the leading v", () => {
    expect(parseVersion("v0.6.0")).toBe("0.6.0");
    expect(parseVersion("v10.20.30")).toBe("10.20.30");
  });
  test("rejects anything that is not vX.Y.Z", () => {
    for (const bad of ["", "0.6.0", "v0.6", "v0.6.0-rc1", "v0.6.0.1", "studio-v0.1.0", "v-1.0.0", "vx.y.z"]) {
      expect(() => parseVersion(bad)).toThrow();
    }
  });
});

describe("classifyAsset", () => {
  test("recognises the installers by extension", () => {
    expect(classifyAsset("uniquemedia-0.6.0-arm64.dmg")).toBe("mac");
    expect(classifyAsset("uniquemedia.Setup.0.6.0.exe")).toBe("win");
    expect(classifyAsset("UNIQUEMEDIA.EXE")).toBe("win");
  });
  test("ignores everything else", () => {
    expect(classifyAsset("latest.yml")).toBeNull();
    expect(classifyAsset("uniquemedia.dmg.blockmap")).toBeNull();
  });
});

describe("buildLatest", () => {
  test("has exactly the shape the landing page validates", () => {
    const latest = buildLatest({
      version: "0.6.0",
      mac: "https://x.public.blob.vercel-storage.com/uniquemedia/0.6.0/a.dmg",
      win: "https://x.public.blob.vercel-storage.com/uniquemedia/0.6.0/b.exe",
      now: new Date("2026-10-04T12:00:00.000Z"),
    });
    expect(latest).toEqual({
      version: "0.6.0",
      mac: "https://x.public.blob.vercel-storage.com/uniquemedia/0.6.0/a.dmg",
      win: "https://x.public.blob.vercel-storage.com/uniquemedia/0.6.0/b.exe",
      publishedAt: "2026-10-04T12:00:00.000Z",
    });
  });
});

describe("blobsToDelete", () => {
  const all = [
    "uniquemedia/latest.json",
    "uniquemedia/0.5.0/uniquemedia-0.5.0-arm64.dmg",
    "uniquemedia/0.5.0/uniquemedia.Setup.0.5.0.exe",
    "uniquemedia/0.6.0/uniquemedia-0.6.0-arm64.dmg",
    "uniquemedia/0.6.0/uniquemedia.Setup.0.6.0.exe",
    "uniquemedia/0.6.10/old.dmg",
    "other/keep.txt",
  ];
  test("keeps the new version and latest.json, deletes older versions", () => {
    expect(blobsToDelete(all, "0.6.0")).toEqual([
      "uniquemedia/0.5.0/uniquemedia-0.5.0-arm64.dmg",
      "uniquemedia/0.5.0/uniquemedia.Setup.0.5.0.exe",
      "uniquemedia/0.6.10/old.dmg",
    ]);
  });
  test("a version that is a string prefix of another is not confused with it", () => {
    expect(blobsToDelete(["uniquemedia/0.6.10/a.dmg"], "0.6.1")).toEqual(["uniquemedia/0.6.10/a.dmg"]);
  });
  test("never touches blobs outside uniquemedia/", () => {
    expect(blobsToDelete(["other/keep.txt", "uniquemedia-extra/x"], "0.6.0")).toEqual([]);
  });
  test("empty store deletes nothing", () => {
    expect(blobsToDelete([], "0.6.0")).toEqual([]);
  });
});
