import { describe, expect, test } from "bun:test";
import { MAX_MONTAGE_ISSUES, MontageDraft, montageIssues } from "../../shared/engine/montage";
import { sceneSpec, writeVideoRecord } from "../library/testing/videoRecords";
import { PNG_1X1, SAMPLE_SOURCE, samplePhotoMeta } from "../library/testing/helpers";
import { openLibrary } from "../library";
import { useWorld, type World } from "../videos/testing/kit";
import { draftIssues } from "./issues";
import { notYetSupportedIssues } from "../../shared/montage/notYetSupported";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// What the engine adds to the structural verdict of a draft (`montages.get` and `montages.list`): the parts that need the
// library. Only what has data today is checked; the rest is a TODO naming its task (see issues.ts).

const world = useWorld();

const cell = (photoId: string) => ({ photo: { source: "scene" as const, photoId }, focus: null });
const photoClip = (n: number, photoId: string, durationMs = 4_000) => ({ clipId: `clip-${String(n).padStart(3, "0")}`, kind: "photo" as const, cell: cell(photoId), motion: "static" as const, durationMs, transitionIn: "cut" as const });

function draftOf(w: World, over: Partial<MontageDraft> = {}): MontageDraft {
  return { schemaVersion: 1, avatarId: w.avatar.id, clips: [], layers: [], music: null, seed: 1, ...over };
}

const photoId = (w: World, i: number): string => w.photos[i]?.id ?? "";
const logs: string[] = [];
const issuesOf = (w: World, spec: MontageDraft) => draftIssues(w.library, spec, (line) => void logs.push(line));

describe("draftIssues: the structural half", () => {
  test("an empty draft is missing its clips, as a render would say", () => {
    const w = world();
    const spec = draftOf(w);

    expect(issuesOf(w, spec)).toEqual(montageIssues(spec, "spec"));
    expect(issuesOf(w, spec).map((i) => i.code)).toEqual(["no-clips"]);
  });

  test("a draft a render would accept has no issues", () => {
    const w = world();

    expect(issuesOf(w, draftOf(w, { clips: [photoClip(1, photoId(w, 0))] }))).toEqual([]);
  });

  test("a draft with a photo clip shorter than the minimum total lists the structural issue and nothing more", () => {
    const w = world();
    const spec = draftOf(w, { clips: [photoClip(1, photoId(w, 0), 1_000)] });

    expect(issuesOf(w, spec).map((i) => i.code)).toEqual(["duration-too-short"]);
  });
});

describe("draftIssues: a scene photo that cannot be used", () => {
  test("a rejected photo is photo-unavailable at its cell", async () => {
    const w = world();
    await w.library.setRejected(w.avatar.id, photoId(w, 0), true);

    const issues = issuesOf(w, draftOf(w, { clips: [photoClip(1, photoId(w, 0)), photoClip(2, photoId(w, 1))] }));

    expect(issues).toEqual([{ code: "photo-unavailable", path: ["clips", 0, "cell"] }]);
  });

  test("a photo that is already in a video is photo-unavailable: one photo, one video", async () => {
    const w = world();
    await writeVideoRecord(w.libraryRoot, "video-0000001", sceneSpec(w.avatar.id, [photoId(w, 0)]));
    await w.library.reloadVideoRecords(w.avatar.id);

    const issues = issuesOf(w, draftOf(w, { clips: [photoClip(1, photoId(w, 0)), photoClip(2, photoId(w, 1))] }));

    expect(issues).toEqual([{ code: "photo-unavailable", path: ["clips", 0, "cell"] }]);
  });

  test("a photo a queued or running render holds is photo-unavailable", async () => {
    const w = world();
    const { library } = await openLibrary(w.libraryRoot, { reservedPhotos: () => new Set([photoId(w, 1)]) });

    const issues = draftIssues(library, draftOf(w, { clips: [photoClip(1, photoId(w, 0)), photoClip(2, photoId(w, 1))] }), () => undefined);

    expect(issues).toEqual([{ code: "photo-unavailable", path: ["clips", 1, "cell"] }]);
  });

  test("a photo the library does not have is photo-unavailable", () => {
    const w = world();

    const issues = issuesOf(w, draftOf(w, { clips: [photoClip(1, "photo-nobody-1")] }));

    expect(issues).toEqual([{ code: "photo-unavailable", path: ["clips", 0, "cell"] }]);
  });

  test("another avatar's photo is photo-unavailable", async () => {
    const w = world();
    const other = await w.library.createAvatar({ name: "Lena", age: 25, traits: {}, descriptor: "a woman" });
    const foreign = await w.library.addPhoto(other.id, PNG_1X1, samplePhotoMeta({ source: { ...SAMPLE_SOURCE, category: "home" } }));

    const issues = issuesOf(w, draftOf(w, { clips: [photoClip(1, foreign.id)] }));

    expect(issues).toEqual([{ code: "photo-unavailable", path: ["clips", 0, "cell"] }]);
  });

  test("the master portrait is photo-unavailable", () => {
    const w = world();
    const master = w.avatar.masterPhotoId ?? "";

    expect(issuesOf(w, draftOf(w, { clips: [photoClip(1, master)] }))).toEqual([{ code: "photo-unavailable", path: ["clips", 0, "cell"] }]);
  });

  test("every cell of a collage is judged on its own, at its own path", async () => {
    const w = world();
    await w.library.setRejected(w.avatar.id, photoId(w, 1), true);
    const collage = { clipId: "clip-001", kind: "collage" as const, layout: "collage3" as const, cells: [cell(photoId(w, 0)), cell(photoId(w, 1)), cell("photo-nobody-1")], motion: "static" as const, stagger: false, durationMs: 4_000, transitionIn: "cut" as const };

    const issues = issuesOf(w, draftOf(w, { clips: [collage] }));

    expect(issues).toEqual([
      { code: "photo-unavailable", path: ["clips", 0, "cells", 1] },
      { code: "photo-unavailable", path: ["clips", 0, "cells", 2] },
    ]);
  });

  test("an empty cell is the structural issue only: there is no photo to be unavailable", () => {
    const w = world();
    const spec = draftOf(w, { clips: [{ ...photoClip(1, "x"), cell: { photo: null, focus: null }, durationMs: 4_000 }] });

    expect(issuesOf(w, spec).map((i) => i.code)).toEqual(["cell-empty"]);
  });

  const ownClip = (n: number, mediaId: string) => ({ ...photoClip(n, "x"), cell: { photo: { source: "own" as const, mediaId }, focus: null } });
  const withMedia = (w: World, spec: MontageDraft, holds: (mediaId: string) => boolean) => draftIssues(w.library, spec, () => undefined, undefined, undefined, holds);

  test("an own photo that the media store holds is no issue (3f.2 lifted N9 for it)", () => {
    const w = world();

    expect(withMedia(w, draftOf(w, { clips: [ownClip(1, "media-0000001")] }), (mediaId) => mediaId === "media-0000001")).toEqual([]);
  });

  test("an own photo that the media store does not hold is media-unavailable at its cell", () => {
    const w = world();

    expect(withMedia(w, draftOf(w, { clips: [ownClip(1, "media-0000001")] }), () => false)).toEqual([{ code: "media-unavailable", path: ["clips", 0, "cell"] }]);
  });

  test("with no media store wired no own photo is held, as a render with none says", () => {
    const w = world();

    expect(issuesOf(w, draftOf(w, { clips: [ownClip(1, "media-0000001")] }))).toEqual([{ code: "media-unavailable", path: ["clips", 0, "cell"] }]);
  });

  test("scene photos and own photos are judged in clip order, each in its own words", async () => {
    const w = world();
    await w.library.setRejected(w.avatar.id, photoId(w, 0), true);
    const spec = draftOf(w, { clips: [ownClip(1, "media-0000001"), photoClip(2, photoId(w, 0)), ownClip(3, "media-0000002")] });

    expect(withMedia(w, spec, (mediaId) => mediaId === "media-0000001")).toEqual([
      { code: "photo-unavailable", path: ["clips", 1, "cell"] },
      { code: "media-unavailable", path: ["clips", 2, "cell"] },
    ]);
  });

  test("an own photo in a collage cell is judged at that cell", () => {
    const w = world();
    const collage = {
      clipId: "clip-001",
      kind: "collage" as const,
      layout: "collage2" as const,
      cells: [cell(photoId(w, 0)), { photo: { source: "own" as const, mediaId: "media-0000001" }, focus: null }],
      motion: "static" as const,
      stagger: false,
      durationMs: 4_000,
      transitionIn: "cut" as const,
    };

    expect(withMedia(w, draftOf(w, { clips: [collage] }), () => false)).toEqual([{ code: "media-unavailable", path: ["clips", 0, "cells", 1] }]);
  });

  test("when the avatar's usage cannot be trusted every photo is unavailable, as a render would refuse them, and the log says so", async () => {
    logs.length = 0;
    const w = world();
    w.library.flagVideoIndexStale(w.avatar.id, "video-0000001");

    const issues = issuesOf(w, draftOf(w, { clips: [photoClip(1, photoId(w, 0)), photoClip(2, photoId(w, 1))] }));

    expect(issues).toEqual([
      { code: "photo-unavailable", path: ["clips", 0, "cell"] },
      { code: "photo-unavailable", path: ["clips", 1, "cell"] },
    ]);
    expect(logs.join("\n")).toMatch(/usage/);
    expect(logs.join("\n")).not.toContain(w.dir);
  });

  test("a video record from a newer Studio closes the photos the same way", async () => {
    const w = world();
    await writeVideoRecord(w.libraryRoot, "video-0000001", sceneSpec(w.avatar.id, [photoId(w, 2)]), { schemaVersion: 2 });
    await w.library.reloadVideoRecords(w.avatar.id);

    const issues = issuesOf(w, draftOf(w, { clips: [photoClip(1, photoId(w, 0))] }));

    expect(issues).toEqual([{ code: "photo-unavailable", path: ["clips", 0, "cell"] }]);
  });
});

describe("draftIssues: what a render refuses for a part whose slice has not landed", () => {
  const text = { layerId: "layer-001", kind: "text" as const, startMs: 0, endMs: 1_000, value: "hi", font: "manrope" as const, style: "none" as const, color: "#ffffff", x: 0.5, y: 0.5, scale: 1 };

  const builtinSticker = { layerId: "layer-002", kind: "sticker" as const, startMs: 0, endMs: 1_000, sticker: { source: "builtin" as const, stickerId: "heart-pulse" }, x: 0.5, y: 0.5, size: 0.2 };
  const ownSticker = { ...builtinSticker, layerId: "layer-003", sticker: { source: "own" as const, mediaId: "media-0000001" } };

  test("a text layer and a built-in sticker are rendered since 3b.6, so they are not refused", () => {
    const w = world();
    const spec = draftOf(w, { clips: [photoClip(1, photoId(w, 0))], layers: [text, builtinSticker] });

    expect(issuesOf(w, spec)).toEqual([]);
  });

  test("an own sticker is not refused as not-yet-supported since 3f.5: the library is asked, and with no store it is media-unavailable at its layer's sticker", () => {
    const w = world();
    const spec = draftOf(w, { clips: [photoClip(1, photoId(w, 0))], layers: [text, ownSticker] });

    expect(issuesOf(w, spec)).toEqual([{ code: "media-unavailable", path: ["layers", 1, "sticker"] }]);
  });

  test("an own sticker the library holds as a sticker is no issue", () => {
    const w = world();
    const spec = draftOf(w, { clips: [photoClip(1, photoId(w, 0))], layers: [text, ownSticker] });

    expect(draftIssues(w.library, spec, () => undefined, undefined, undefined, undefined, (mediaId) => mediaId === "media-0000001")).toEqual([]);
  });

  test("an own video clip is no longer not-yet-supported (3f.3b): with no media store wired it is media-unavailable at its clip", () => {
    const w = world();
    const video = { clipId: "clip-003", kind: "video" as const, mediaId: "media-0000002", trimStartMs: 0, focus: null, durationMs: 1_000, transitionIn: "cut" as const };
    const spec = draftOf(w, { clips: [photoClip(1, photoId(w, 0)), video] });

    expect(issuesOf(w, spec).map((i) => [i.code, i.path])).toEqual([["media-unavailable", ["clips", 1]]]);
  });

  test("an own track is no longer not-yet-supported: with no media store wired it is media-unavailable at the music, after the clip's own verdict", () => {
    const w = world();
    const video = { clipId: "clip-003", kind: "video" as const, mediaId: "media-0000002", trimStartMs: 0, focus: null, durationMs: 1_000, transitionIn: "cut" as const };
    const spec = draftOf(w, { clips: [photoClip(1, photoId(w, 0)), video], music: { source: "own", mediaId: "media-0000003", startMs: 0 } });

    expect(issuesOf(w, spec).map((i) => [i.code, i.path])).toEqual([
      ["media-unavailable", ["clips", 1]],
      ["media-unavailable", ["music"]],
    ]);
  });

  describe("an own video clip, with the library's answer", () => {
    const video = (over: { mediaId?: string; trimStartMs?: number; durationMs?: number } = {}) => ({ clipId: "clip-003", kind: "video" as const, mediaId: over.mediaId ?? "media-0000002", trimStartMs: over.trimStartMs ?? 0, focus: null, durationMs: over.durationMs ?? 1_000, transitionIn: "cut" as const });
    const withVideo = (stored: (mediaId: string) => { readonly durationMs: number } | null, spec: MontageDraft, w: World) =>
      draftIssues(w.library, spec, () => undefined, undefined, undefined, undefined, undefined, undefined, stored);

    test("a video the library holds, long enough, is no issue", () => {
      const w = world();
      const spec = draftOf(w, { clips: [photoClip(1, photoId(w, 0)), video({ trimStartMs: 500, durationMs: 1_000 })] });

      expect(withVideo((id) => (id === "media-0000002" ? { durationMs: 5_000 } : null), spec, w)).toEqual([]);
    });

    test("a clip that asks past the video's end is video-too-short at its clip; one that ends exactly at it is not", () => {
      const w = world();
      const spec = (durationMs: number) => draftOf(w, { clips: [photoClip(1, photoId(w, 0)), video({ trimStartMs: 1_000, durationMs })] });

      expect(withVideo(() => ({ durationMs: 1_999 }), spec(1_000), w)).toEqual([{ code: "video-too-short", path: ["clips", 1] }]);
      expect(withVideo(() => ({ durationMs: 2_000 }), spec(1_000), w)).toEqual([]);
    });

    test("is judged after the photos and before the stickers and the music", () => {
      const w = world();
      const spec = draftOf(w, {
        clips: [photoClip(1, photoId(w, 0)), { ...photoClip(2, "photo-0000999"), cell: { photo: { source: "own" as const, mediaId: "media-0000007" }, focus: null } }, video()],
        layers: [{ layerId: "layer-001", kind: "sticker" as const, startMs: 0, endMs: 1_000, sticker: { source: "own" as const, mediaId: "media-0000008" }, x: 0.5, y: 0.5, size: 0.2 }],
        music: { source: "own", mediaId: "media-0000009", startMs: 0 },
      });

      expect(withVideo(() => null, spec, w).map((i) => [i.code, i.path])).toEqual([
        ["media-unavailable", ["clips", 1, "cell"]],
        ["media-unavailable", ["clips", 2]],
        ["media-unavailable", ["layers", 0, "sticker"]],
        ["media-unavailable", ["music"]],
      ]);
    });
  });

  test("for the same spec, get's issues cover everything a render would refuse for its structure", () => {
    const w = world();
    const spec = draftOf(w, { clips: [photoClip(1, photoId(w, 0), 1_000)], layers: [text] });
    const renderRefuses = [...montageIssues(spec, "spec"), ...notYetSupportedIssues(spec)];

    const issues = issuesOf(w, spec);

    for (const refusal of renderRefuses) expect(issues).toContainEqual(refusal);
  });
});

describe("draftIssues: a built-in sticker that is gone", () => {
  const sticker = (n: number, stickerId: string) => ({ layerId: `layer-${String(n).padStart(3, "0")}`, kind: "sticker" as const, startMs: 0, endMs: 1_000, sticker: { source: "builtin" as const, stickerId }, x: 0.5, y: 0.5, size: 0.2 });

  test("a sticker id the built-in set does not have is sticker-unavailable at its layer", () => {
    const w = world();
    const spec = draftOf(w, { clips: [photoClip(1, photoId(w, 0))], layers: [sticker(1, "heart-pulse"), sticker(2, "no-such-sticker")] });

    expect(issuesOf(w, spec).filter((i) => i.code === "sticker-unavailable")).toEqual([{ code: "sticker-unavailable", path: ["layers", 1, "sticker"] }]);
  });

  test("an own sticker is judged against the library's stickers, not the built-in set: it is media-unavailable, never sticker-unavailable", () => {
    const w = world();
    const own = { ...sticker(1, "x"), sticker: { source: "own" as const, mediaId: "media-0000001" } };

    expect(issuesOf(w, draftOf(w, { clips: [photoClip(1, photoId(w, 0))], layers: [own] }))).toEqual([{ code: "media-unavailable", path: ["layers", 0, "sticker"] }]);
  });
});

describe("draftIssues: a caption that breaks the caption rules", () => {
  const text = (n: number, value: string) => ({ layerId: `layer-${String(n).padStart(3, "0")}`, kind: "text" as const, startMs: 0, endMs: 1_000, value, font: "manrope" as const, style: "none" as const, color: "#ffffff", x: 0.5, y: 0.5, scale: 1 });
  const sticker = (n: number, stickerId: string) => ({ layerId: `layer-${String(n).padStart(3, "0")}`, kind: "sticker" as const, startMs: 0, endMs: 1_000, sticker: { source: "builtin" as const, stickerId }, x: 0.5, y: 0.5, size: 0.2 });

  test("a valid caption is no issue", () => {
    const w = world();

    expect(issuesOf(w, draftOf(w, { clips: [photoClip(1, photoId(w, 0))], layers: [text(1, "Hello")] }))).toEqual([]);
  });

  test("a caption with a character outside the charset is caption-invalid at its layer's value", () => {
    const w = world();
    const spec = draftOf(w, { clips: [photoClip(1, photoId(w, 0))], layers: [text(1, "\u041f\u0440\u0438\u0432\u0435\u0442")] });

    expect(issuesOf(w, spec)).toEqual([{ code: "caption-invalid", path: ["layers", 0, "value"] }]);
  });

  test("only the bad one of several text layers is reported, at its index among all layers", () => {
    const w = world();
    const spec = draftOf(w, { clips: [photoClip(1, photoId(w, 0))], layers: [text(1, "Fine"), sticker(2, "heart-pulse"), text(3, "a".repeat(61)), text(4, "Also fine")] });

    expect(issuesOf(w, spec)).toEqual([{ code: "caption-invalid", path: ["layers", 2, "value"] }]);
  });

  test("the issues come stickers, captions, track", () => {
    const w = world();
    const spec = draftOf(w, {
      clips: [photoClip(1, photoId(w, 0))],
      layers: [text(1, "a\nb\nc"), sticker(2, "no-such-sticker")],
      music: { source: "trending", trackId: "track-0000001", startMs: 0 },
    });

    expect(issuesOf(w, spec).map((i) => i.code)).toEqual(["sticker-unavailable", "caption-invalid", "track-unavailable"]);
  });
});

describe("draftIssues: the bound", () => {
  /** `n` distinct photos that the library does not have, in collages of 4 and then single clips: every cell is unavailable. */
  function withUnavailableCells(w: World, n: number, durationMs = 500): MontageDraft {
    const clips: MontageDraft["clips"] = [];
    let next = 0;
    let remaining = n;
    while (remaining > 0) {
      const size = Math.min(4, remaining);
      const photos = Array.from({ length: size }, () => `photo-gone-${String(++next).padStart(4, "0")}`);
      const at = clips.length;
      if (size === 1) clips.push(photoClip(at + 1, photos[0] ?? "", durationMs));
      else clips.push({ clipId: `clip-${String(at + 1).padStart(3, "0")}`, kind: "collage", layout: size === 2 ? "collage2" : size === 3 ? "collage3" : "collage4", cells: photos.map(cell), motion: "static", stagger: false, durationMs, transitionIn: "cut" });
      remaining -= size;
    }
    return draftOf(w, { clips });
  }

  test("64 issues are all reported", () => {
    const w = world();
    const spec = withUnavailableCells(w, 64);
    expect(spec.clips.length).toBeLessThanOrEqual(20);

    // 16 collages of 4 at 0.5 s each are 8 s: a complete draft, so only the referential issues are in play
    expect(issuesOf(w, spec)).toHaveLength(64);
  });

  test("65 issues are cut to 64", () => {
    const w = world();
    const spec = withUnavailableCells(w, 65);

    expect(issuesOf(w, spec)).toHaveLength(MAX_MONTAGE_ISSUES);
  });

  test("the structural issues come first when the list is cut", () => {
    const w = world();
    // 17 clips of 1 s are 17 s: too long for a render, and 65 cells are unavailable on top of that
    const spec = withUnavailableCells(w, 65, 1_000);

    const issues = issuesOf(w, spec);

    expect(issues).toHaveLength(MAX_MONTAGE_ISSUES);
    expect(issues[0]).toEqual({ code: "duration-too-long", path: ["clips"] });
    expect(issues.slice(1).every((i) => i.code === "photo-unavailable")).toBe(true);
  });
});

describe("draftIssues: a trending track against the track store (3c.5)", () => {
  const trending = (startMs: number, trackId = "4199287736976977"): MontageDraft["music"] => ({ source: "trending", trackId, startMs });
  const holds = (decodedMs: number) => ({ stored: (trackId: string) => (trackId === "4199287736976977" ? { decodedMs } : null) });
  const withTracks = (w: World, spec: MontageDraft, tracks: { stored(trackId: string): { decodedMs: number } | null } | undefined) => draftIssues(w.library, spec, (line) => void logs.push(line), undefined, tracks);

  test("a track the store holds, long enough, has no issue", () => {
    const w = world();

    expect(withTracks(w, draftOf(w, { clips: [photoClip(1, photoId(w, 0))], music: trending(1_000) }), holds(8_000))).toEqual([]);
  });

  test("a track the store does not hold is track-unavailable at music", () => {
    const w = world();

    expect(withTracks(w, draftOf(w, { clips: [photoClip(1, photoId(w, 0))], music: trending(0, "123") }), holds(8_000))).toEqual([{ code: "track-unavailable", path: ["music"] }]);
  });

  test("with no track store wired no track is held, so any trending track is track-unavailable", () => {
    const w = world();

    expect(withTracks(w, draftOf(w, { clips: [photoClip(1, photoId(w, 0))], music: trending(0) }), undefined)).toEqual([{ code: "track-unavailable", path: ["music"] }]);
  });

  test("a track shorter than startMs plus the montage is track-too-short at music", () => {
    const w = world();

    expect(withTracks(w, draftOf(w, { clips: [photoClip(1, photoId(w, 0))], music: trending(4_001) }), holds(8_000))).toEqual([{ code: "track-too-short", path: ["music"] }]);
  });
});

describe("draftIssues: an own track against the library's media (3f.4)", () => {
  const own = (startMs: number, mediaId = "media-0000001"): MontageDraft["music"] => ({ source: "own", mediaId, startMs });
  const holdsOwn = (durationMs: number) => (mediaId: string) => (mediaId === "media-0000001" ? { durationMs } : null);
  const withOwnTrack = (w: World, spec: MontageDraft, ownTrack: ((mediaId: string) => { durationMs: number } | null) | undefined) =>
    draftIssues(w.library, spec, (line) => void logs.push(line), undefined, undefined, undefined, undefined, ownTrack);

  test("a track the library holds, long enough, has no issue", () => {
    const w = world();

    expect(withOwnTrack(w, draftOf(w, { clips: [photoClip(1, photoId(w, 0))], music: own(1_000) }), holdsOwn(8_000))).toEqual([]);
  });

  test("a track the library does not hold is media-unavailable at music", () => {
    const w = world();

    expect(withOwnTrack(w, draftOf(w, { clips: [photoClip(1, photoId(w, 0))], music: own(0, "media-0000404") }), holdsOwn(8_000))).toEqual([{ code: "media-unavailable", path: ["music"] }]);
  });

  test("with no media store wired no track is held, so any own track is media-unavailable", () => {
    const w = world();

    expect(withOwnTrack(w, draftOf(w, { clips: [photoClip(1, photoId(w, 0))], music: own(0) }), undefined)).toEqual([{ code: "media-unavailable", path: ["music"] }]);
  });

  test("a track shorter than startMs plus the montage is track-too-short at music; one exactly as long is not", () => {
    const w = world();
    const spec = (startMs: number) => draftOf(w, { clips: [photoClip(1, photoId(w, 0))], music: own(startMs) });

    expect(withOwnTrack(w, spec(4_001), holdsOwn(8_000))).toEqual([{ code: "track-too-short", path: ["music"] }]);
    expect(withOwnTrack(w, spec(4_000), holdsOwn(8_000))).toEqual([]);
  });

  test("a trending track is never asked of the media store, and an own track never of the track store", () => {
    const w = world();
    const asked: string[] = [];
    const ownTrack = (mediaId: string): null => (asked.push(mediaId), null);
    const trending = draftOf(w, { clips: [photoClip(1, photoId(w, 0))], music: { source: "trending", trackId: "4199287736976977", startMs: 0 } });
    draftIssues(w.library, trending, () => undefined, undefined, { stored: () => ({ decodedMs: 8_000 }) }, undefined, undefined, ownTrack);
    expect(asked).toEqual([]);
    const storeAsked: string[] = [];
    draftIssues(w.library, draftOf(w, { clips: [photoClip(1, photoId(w, 0))], music: own(0) }), () => undefined, undefined, { stored: (id) => (storeAsked.push(id), null) }, undefined, undefined, holdsOwn(8_000));
    expect(storeAsked).toEqual([]);
  });

  test("the issues keep their order: photos, then stickers, then the track", () => {
    const w = world();
    const spec = draftOf(w, { clips: [photoClip(1, "photo-nobody-1")], layers: [], music: own(0, "media-0000404") });

    expect(withOwnTrack(w, spec, holdsOwn(8_000)).map((i) => i.code)).toEqual(["photo-unavailable", "media-unavailable"]);
  });
});
