import { describe, expect, test } from "bun:test";
import { MediaPickKind } from "../shared/engine";
import { MEDIA_DIALOG_FILTERS } from "./mediaFilters";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// The dialog's filters are a convenience, never a check: the engine reads the bytes. They still must not offer what no importer takes.

const extensionsOf = (kind: MediaPickKind): string[] => (MEDIA_DIALOG_FILTERS[kind] ?? []).flatMap((f) => f.extensions);

describe("the dialog's per-kind filters", () => {
  test("every pick kind has at least one filter", () => {
    for (const kind of MediaPickKind.options) expect((MEDIA_DIALOG_FILTERS[kind] ?? []).length).toBeGreaterThan(0);
  });

  test("a photo offers JPEG, PNG, WebP and HEIC (so the owner is told how to convert it)", () => {
    expect(extensionsOf("photo").sort()).toEqual(["heic", "heif", "jpeg", "jpg", "png", "webp"]);
  });

  test("a video offers MP4 and MOV only (3f.3a)", () => {
    expect(extensionsOf("video").sort()).toEqual(["m4v", "mov", "mp4"]);
  });

  test("music offers the seven formats of 3f.4", () => {
    expect(extensionsOf("audio").sort()).toEqual(["aac", "flac", "m4a", "mp3", "ogg", "opus", "wav"]);
  });

  test("a sticker offers GIF and PNG (3f.5)", () => {
    expect(extensionsOf("sticker").sort()).toEqual(["gif", "png"]);
  });

  test("`any` offers every kind's extensions and nothing else", () => {
    const all = new Set(["photo", "video", "audio", "sticker"].flatMap((k) => extensionsOf(k as MediaPickKind)));
    expect(new Set(extensionsOf("any"))).toEqual(all);
  });

  test("no filter is a wildcard, has a dot or capital letters, and none lists an executable or a script", () => {
    for (const kind of MediaPickKind.options) {
      for (const extension of extensionsOf(kind)) {
        expect(extension).toMatch(/^[a-z0-9]+$/);
        expect(["exe", "dll", "bat", "cmd", "sh", "app", "js", "ps1", "msi", "com", "scr"]).not.toContain(extension);
      }
    }
  });
});
