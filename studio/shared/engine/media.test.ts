import { describe, expect, test } from "bun:test";
import { STICKER_LIMITS } from "../stickers/apng";
import {
  MAX_PICKED_FILES,
  MEDIA_BYTE_CAPS,
  MediaFileName,
  MediaKind,
  MediaPickImportPayload,
  MediaPickKind,
  MediaPickResult,
  MediaUnsupportedReason,
  mediaByteCap,
} from "./media";

// The own-media import boundary's contract (3f.1, invariant 34): the window names a KIND and nothing else.

describe("media.pickImport payload", () => {
  test("takes a kind and nothing else", () => {
    expect(MediaPickImportPayload.safeParse({ kind: "photo" }).success).toBe(true);
    expect(MediaPickImportPayload.safeParse({ kind: "any" }).success).toBe(true);
  });

  test("refuses a path next to the kind, however it is spelled", () => {
    for (const extra of [{ path: "/etc/passwd" }, { filePath: "C:\\x.jpg" }, { paths: ["/a"] }, { bytes: [1, 2, 3] }, { file: "x" }]) {
      expect(MediaPickImportPayload.safeParse({ kind: "photo", ...extra }).success).toBe(false);
    }
  });

  test("refuses a missing, unknown or non-string kind", () => {
    expect(MediaPickImportPayload.safeParse({}).success).toBe(false);
    expect(MediaPickImportPayload.safeParse({ kind: "document" }).success).toBe(false);
    expect(MediaPickImportPayload.safeParse({ kind: 3 }).success).toBe(false);
    expect(MediaPickImportPayload.safeParse({ kind: null }).success).toBe(false);
  });

  test("refuses a bare path as the payload", () => {
    expect(MediaPickImportPayload.safeParse("/etc/passwd").success).toBe(false);
    expect(MediaPickImportPayload.safeParse(null).success).toBe(false);
  });

  test("`any` is a pick kind and not a media kind", () => {
    expect(MediaPickKind.safeParse("any").success).toBe(true);
    expect(MediaKind.safeParse("any").success).toBe(false);
  });
});

describe("media.pickImport result", () => {
  test("a cancel carries nothing else", () => {
    expect(MediaPickResult.safeParse({ picked: false }).success).toBe(true);
    expect(MediaPickResult.safeParse({ picked: false, jobIds: [] }).success).toBe(false);
  });

  test("an accepted pick lists job ids and refusals by name and reason", () => {
    const ok = { picked: true, jobIds: ["job-00000001"], refused: [{ name: "notes.txt", reason: "format" }], skipped: 0 };
    expect(MediaPickResult.safeParse(ok).success).toBe(true);
  });

  test("a refusal has a name and a reason and no path", () => {
    const withPath = { picked: true, jobIds: [], refused: [{ name: "a.jpg", reason: "format", path: "/home/me/a.jpg" }], skipped: 0 };
    expect(MediaPickResult.safeParse(withPath).success).toBe(false);
    expect(MediaPickResult.safeParse({ picked: true, jobIds: [], refused: [{ name: "a.jpg", reason: "heic?" }], skipped: 0 }).success).toBe(false);
  });

  test("an answer carries no field a path could ride in", () => {
    expect(MediaPickResult.safeParse({ picked: true, jobIds: [], refused: [], path: "/x" }).success).toBe(false);
  });

  test("says how many picked files were not even looked at, and that is a count and not a negative one", () => {
    const base = { picked: true, jobIds: [], refused: [] };
    expect(MediaPickResult.safeParse({ ...base, skipped: 50 }).success).toBe(true);
    expect(MediaPickResult.safeParse({ ...base, skipped: -1 }).success).toBe(false);
    expect(MediaPickResult.safeParse({ ...base }).success).toBe(false);
  });

  test("at most MAX_PICKED_FILES jobs are listed", () => {
    const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `job-${String(i).padStart(8, "0")}`);
    expect(MediaPickResult.safeParse({ picked: true, jobIds: ids(MAX_PICKED_FILES), refused: [], skipped: 0 }).success).toBe(true);
    expect(MediaPickResult.safeParse({ picked: true, jobIds: ids(MAX_PICKED_FILES + 1), refused: [], skipped: 0 }).success).toBe(false);
  });
});

describe("MediaFileName", () => {
  test("accepts an ordinary name, an empty one is refused, and the 120 character limit is exact", () => {
    expect(MediaFileName.safeParse("summer edit (1).mp3").success).toBe(true);
    expect(MediaFileName.safeParse("").success).toBe(false);
    expect(MediaFileName.safeParse("a".repeat(120)).success).toBe(true);
    expect(MediaFileName.safeParse("a".repeat(121)).success).toBe(false);
  });

  test("refuses the characters that make a name read as another: bidi marks and overrides, isolates and C1 controls", () => {
    for (const bad of ["\u200e", "\u200f", "\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069", "\u0085", "\u009f"]) {
      expect(MediaFileName.safeParse(`photo${bad}gpj.exe`).success).toBe(false);
    }
  });

  test("takes Cyrillic, emoji and CJK names, and an ordinary space", () => {
    for (const name of ["лето 2026.jpg", "🌅 sunset.png", "写真 1.jpeg"]) expect(MediaFileName.safeParse(name).success).toBe(true);
  });

  test("refuses control characters, a newline included", () => {
    expect(MediaFileName.safeParse("a\nb.jpg").success).toBe(false);
    expect(MediaFileName.safeParse("a\u0000b.jpg").success).toBe(false);
    expect(MediaFileName.safeParse("a\u007fb.jpg").success).toBe(false);
  });
});

describe("byte caps", () => {
  test("hold the plan's numbers: photo 30 MiB, video 2 GiB, music 100 MiB", () => {
    expect(MEDIA_BYTE_CAPS.photo).toBe(30 * 1024 * 1024);
    expect(MEDIA_BYTE_CAPS.video).toBe(2 * 1024 ** 3);
    expect(MEDIA_BYTE_CAPS.audio).toBe(100 * 1024 * 1024);
  });

  test("the sticker cap is the built-in set's", () => {
    expect(MEDIA_BYTE_CAPS.sticker).toBe(STICKER_LIMITS.maxBytes);
  });

  test("`any` is held to the largest cap and a kind to its own", () => {
    expect(mediaByteCap("any")).toBe(MEDIA_BYTE_CAPS.video);
    expect(mediaByteCap("sticker")).toBe(MEDIA_BYTE_CAPS.sticker);
  });
});

describe("refusal reasons", () => {
  test("name the boundary's own reasons, then the photo importer's (3f.2), then the music importer's (3f.4)", () => {
    expect(MediaUnsupportedReason.options).toEqual([
      "not-a-file",
      "empty",
      "too-large",
      "format",
      "heic",
      "changed",
      "unreadable",
      "no-space",
      "too-many",
      "failed",
      "cancelled",
      "not-yet-supported",
      "too-small",
      "dimensions",
      "animated-webp",
      // 3f.4 (music), one per line:
      "too-long",
      "codec",
    ]);
  });
});
