import { describe, expect, test } from "bun:test";
import { MAX_MONTAGE_ISSUES, MontageDraft, montageIssues } from "../../shared/engine/montage";
import { sceneSpec, writeVideoRecord } from "../library/testing/videoRecords";
import { PNG_1X1, SAMPLE_SOURCE, samplePhotoMeta } from "../library/testing/helpers";
import { openLibrary } from "../library";
import { useWorld, type World } from "../videos/testing/kit";
import { draftIssues } from "./issues";
import { notYetSupportedIssues } from "./notYetSupported";
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

  test("an own upload is not judged for its media here (the store comes with slice 3f): only the render's own not-yet-supported", () => {
    const w = world();
    const own = { ...photoClip(1, "x"), cell: { photo: { source: "own" as const, mediaId: "media-0000001" }, focus: null } };

    expect(issuesOf(w, draftOf(w, { clips: [own] }))).toEqual([{ code: "not-yet-supported", path: ["clips", 0, "cell"] }]);
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

  test("a layer is not-yet-supported, like videos.render says", () => {
    const w = world();
    const spec = draftOf(w, { clips: [photoClip(1, photoId(w, 0))], layers: [text] });

    expect(issuesOf(w, spec)).toEqual([{ code: "not-yet-supported", path: ["layers", 0] }]);
  });

  test("music, an own video clip and an own photo are too", () => {
    const w = world();
    const own = { ...photoClip(2, "x"), cell: { photo: { source: "own" as const, mediaId: "media-0000001" }, focus: null } };
    const video = { clipId: "clip-003", kind: "video" as const, mediaId: "media-0000002", trimStartMs: 0, focus: null, durationMs: 1_000, transitionIn: "cut" as const };
    const spec = draftOf(w, { clips: [photoClip(1, photoId(w, 0)), own, video], music: { source: "trending", trackId: "track-0000001", startMs: 0 } });

    expect(issuesOf(w, spec).map((i) => [i.code, i.path])).toEqual([
      ["not-yet-supported", ["clips", 1, "cell"]],
      ["not-yet-supported", ["clips", 2]],
      ["not-yet-supported", ["music"]],
    ]);
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

  test("an own sticker is not judged here: 3f.5 brings the store", () => {
    const w = world();
    const own = { ...sticker(1, "x"), sticker: { source: "own" as const, mediaId: "media-0000001" } };

    expect(issuesOf(w, draftOf(w, { clips: [photoClip(1, photoId(w, 0))], layers: [own] })).filter((i) => i.code !== "not-yet-supported")).toEqual([]);
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
