import { describe, expect, test } from "bun:test";
import type { MontageDraft, MontageIssue, PhotoSummary } from "../../../shared/engine";
import { photoProblems, renderBlock, type RenderBlockInput } from "./renderBlock";
import { AVATAR_ID, draftSpec, photoClip } from "./testkit";

// Why «Рендер» is disabled (3d.2; the 3d.6 checklist's order): the export folder, then no clips, the length, an
// empty cell, a photo that cannot go into a video (one photo → one video, the owner's Q1), a caption, a layer
// past the end, the track, a part that is not supported yet. The first reason wins and is shown left of the button.

const photo = (n: number, patch: Partial<PhotoSummary> = {}): PhotoSummary => ({
  photoId: `photo-mia-${String(n).padStart(4, "0")}`,
  avatarId: AVATAR_ID,
  runId: null,
  category: "home",
  createdAt: "2026-09-30T10:00:00.000Z",
  used: false,
  usedIn: [],
  rejected: false,
  reserved: false,
  eligible: true,
  ...patch,
});

const photosOf = (...list: PhotoSummary[]): ReadonlyMap<string, PhotoSummary> => new Map(list.map((p) => [p.photoId, p]));

/** Four 2 s photo clips of photos 1-4: 8 s, renderable. */
const READY = draftSpec(4);

function input(patch: Partial<RenderBlockInput> = {}): RenderBlockInput {
  return { spec: READY, exportStatus: { status: "ok" }, avatarActive: true, verdict: { spec: READY, issues: [] }, photos: photosOf(), usedVideo: null, ...patch };
}

const unavailableAt = (...clips: number[]): MontageIssue[] => clips.map((i) => ({ code: "photo-unavailable", path: ["clips", i, "cell"] }));

describe("nothing in the way", () => {
  test("a complete draft with a usable export folder can be rendered", () => {
    expect(renderBlock(input())).toBeNull();
  });

  test("before the first snapshot the export folder is not a reason: the engine checks it at render", () => {
    expect(renderBlock(input({ exportStatus: null }))).toBeNull();
  });
});

describe("the reasons, each on its own", () => {
  test("the export folder, with the link to Settings", () => {
    expect(renderBlock(input({ exportStatus: { status: "unavailable", reason: "missing" } }))).toEqual({ text: "Папка «Готовые видео» недоступна", settings: true });
  });

  test("an archived avatar", () => {
    expect(renderBlock(input({ avatarActive: false }))?.text).toBe("Аватар в архиве — новые видео для него не собираются");
  });

  test("no clips: the empty draft of «Новый монтаж»", () => {
    expect(renderBlock(input({ spec: draftSpec(0), verdict: null }))).toEqual({ text: "Добавьте хотя бы один кадр", settings: false });
  });

  test("too short and too long", () => {
    expect(renderBlock(input({ spec: draftSpec([photoClip(0, "photo-mia-0001", 3_900)]) }))?.text).toBe("Ролик короче 4 с");
    const long = draftSpec(Array.from({ length: 8 }, (_, i) => photoClip(i, `photo-mia-${String(i + 1).padStart(4, "0")}`, 2_000)));
    expect(renderBlock(input({ spec: long }))?.text).toBe("Ролик длиннее 15 с");
  });

  test("an empty collage cell names its clip", () => {
    const spec: MontageDraft = draftSpec([
      photoClip(0, "photo-mia-0001", 2_000),
      { clipId: "clip-002", durationMs: 3_000, transitionIn: "cut", kind: "collage", layout: "collage2", cells: [{ photo: { source: "scene", photoId: "photo-mia-0002" }, focus: null }, { photo: null, focus: null }], motion: "kenburns", stagger: true },
    ]);
    expect(renderBlock(input({ spec }))).toEqual({ text: "Кадр 2: пустая ячейка", settings: false, clips: [1] });
  });

  test("one photo → one video: a photo already in a video blocks with the owner's own words, naming that video by its file", () => {
    const r = renderBlock(input({ verdict: { spec: READY, issues: unavailableAt(0, 1, 2, 3) }, photos: photosOf(photo(1, { used: true, usedIn: ["video-0000001"] }), photo(2, { used: true, usedIn: ["video-0000001"] })), usedVideo: { file: "2026-09-30_collage3_001" } }));
    expect(r).toEqual({ text: "Фото уже в видео «2026-09-30_collage3_001» — замените их или удалите то видео", settings: false, clips: [0, 1, 2, 3] });
  });

  test("a video made from this very draft is called so, not by the draft's name (which may have changed since)", () => {
    const r = renderBlock(input({ verdict: { spec: READY, issues: unavailableAt(0) }, photos: photosOf(photo(1, { used: true, usedIn: ["video-0000001"] })), usedVideo: "this-draft" }));
    expect(r?.text).toBe("Фото уже в видео из этого черновика — замените их или удалите то видео");
  });

  test("before the photos are read, a refused photo blocks without guessing why", () => {
    const r = renderBlock(input({ verdict: { spec: READY, issues: unavailableAt(1) }, photos: null }));
    expect(r).toEqual({ text: "Проверяем фото…", settings: false, clips: [1] });
  });

  test("the used-photo reason without a known title still says what to do", () => {
    const r = renderBlock(input({ verdict: { spec: READY, issues: unavailableAt(2) }, photos: photosOf(photo(3, { used: true, usedIn: ["video-0000009"] })) }));
    expect(r?.text).toBe("Фото уже в видео — замените их или удалите то видео");
  });

  test("a rejected photo, a photo a queued render holds, and one the engine will not take for another reason", () => {
    expect(renderBlock(input({ verdict: { spec: READY, issues: unavailableAt(1) }, photos: photosOf(photo(2, { rejected: true, eligible: false })) }))).toEqual({ text: "Кадр 2: фото отклонено — замените его", settings: false, clips: [1] });
    expect(renderBlock(input({ verdict: { spec: READY, issues: unavailableAt(2) }, photos: photosOf(photo(3, { reserved: true })) }))?.text).toBe("Кадр 3: фото уже в очереди на рендер");
    expect(renderBlock(input({ verdict: { spec: READY, issues: unavailableAt(3) }, photos: photosOf() }))?.text).toBe("Кадр 4: фото недоступно — замените его");
  });

  test("a caption the engine refuses names the text layer by its place among the texts", () => {
    const spec = draftSpec(4, {
      layers: [
        { layerId: "layer-001", kind: "sticker", startMs: 0, endMs: 1_000, sticker: { source: "builtin", stickerId: "sticker-sparkle" }, x: 0.5, y: 0.5, size: 0.2 },
        { layerId: "layer-002", kind: "text", startMs: 0, endMs: 1_000, value: "ok", font: "manrope", style: "plaque", color: "#ffffff", x: 0.5, y: 0.2, scale: 1 },
        { layerId: "layer-003", kind: "text", startMs: 0, endMs: 1_000, value: "Привет", font: "manrope", style: "plaque", color: "#ffffff", x: 0.5, y: 0.3, scale: 1 },
      ],
    });
    const issues: MontageIssue[] = [{ code: "caption-invalid", path: ["layers", 2, "value"] }];
    expect(renderBlock(input({ spec, verdict: { spec, issues } }))?.text).toBe("Текст 2: надпись не проходит проверку");
  });

  test("a layer past the end of the clips, a missing track, a track too short", () => {
    const withText = draftSpec(4, { layers: [{ layerId: "layer-001", kind: "text", startMs: 7_000, endMs: 9_000, value: "hi", font: "manrope", style: "plaque", color: "#ffffff", x: 0.5, y: 0.5, scale: 1 }] });
    expect(renderBlock(input({ spec: withText, verdict: null }))?.text).toBe("Текст 1 заканчивается после конца ролика");

    const withMusic = draftSpec(4, { music: { source: "trending", trackId: "track-0000001", startMs: 0 } });
    expect(renderBlock(input({ spec: withMusic, verdict: { spec: withMusic, issues: [{ code: "track-unavailable", path: ["music"] }] } }))?.text).toBe("Трек больше недоступен");
    expect(renderBlock(input({ spec: withMusic, verdict: { spec: withMusic, issues: [{ code: "track-too-short", path: ["music"] }] } }))?.text).toBe("Трек короче ролика с выбранного места");
  });

  test("a text layer and a built-in sticker block nothing since 3b.6", () => {
    const text = { layerId: "layer-001", kind: "text" as const, startMs: 0, endMs: 1_000, value: "hi", font: "manrope" as const, style: "plaque" as const, color: "#ffffff", x: 0.5, y: 0.5, scale: 1 };
    const sticker = { layerId: "layer-002", kind: "sticker" as const, startMs: 0, endMs: 1_000, sticker: { source: "builtin" as const, stickerId: "heart-pulse" }, x: 0.5, y: 0.5, size: 0.2 };
    expect(renderBlock(input({ spec: draftSpec(4, { layers: [text, sticker] }), verdict: null }))).toBeNull();
  });

  test("a part whose slice has not landed yet says «скоро» for that part", () => {
    const withOwnSticker = draftSpec(4, { layers: [{ layerId: "layer-001", kind: "sticker", startMs: 0, endMs: 1_000, sticker: { source: "own", mediaId: "media-0000001" }, x: 0.5, y: 0.5, size: 0.2 }] });
    expect(renderBlock(input({ spec: withOwnSticker, verdict: null }))?.text).toBe("Свои стикеры — скоро");
    // A trending track is supported since 3c.5; an own track waits for 3f.4.
    const withMusic = draftSpec(4, { music: { source: "own", mediaId: "media-0000001", startMs: 0 } });
    expect(renderBlock(input({ spec: withMusic, verdict: null }))?.text).toBe("Музыка в видео — скоро");
    const withTrack = draftSpec(4, { music: { source: "trending", trackId: "track-0000001", startMs: 0 } });
    expect(renderBlock(input({ spec: withTrack, verdict: null }))).toBeNull();
    const withVideo = draftSpec([photoClip(0, "photo-mia-0001", 2_000), { clipId: "clip-002", durationMs: 3_000, transitionIn: "cut", kind: "video", mediaId: "media-0000001", trimStartMs: 0, focus: null }]);
    expect(renderBlock(input({ spec: withVideo, verdict: null }))?.text).toBe("Своё видео — скоро");
  });
});

describe("the first reason wins", () => {
  test("the export folder comes before an empty draft; an empty draft before an unusable photo", () => {
    expect(renderBlock(input({ spec: draftSpec(0), exportStatus: { status: "unavailable", reason: "not-writable" } }))?.text).toBe("Папка «Готовые видео» недоступна");
    const short = draftSpec([photoClip(0, "photo-mia-0001", 2_000)]);
    expect(renderBlock(input({ spec: short, verdict: { spec: short, issues: unavailableAt(0) }, photos: photosOf(photo(1, { rejected: true })) }))?.text).toBe("Ролик короче 4 с");
  });

  test("a rejected photo in an earlier clip comes before a used one in a later clip", () => {
    const r = renderBlock(input({ verdict: { spec: READY, issues: unavailableAt(1, 2) }, photos: photosOf(photo(2, { rejected: true }), photo(3, { used: true, usedIn: ["video-0000001"] })) }));
    expect(r?.text).toBe("Кадр 2: фото отклонено — замените его");
  });
});

describe("the engine's verdict against the window's newer spec", () => {
  test("a flagged photo stays flagged wherever the owner moved it since", () => {
    const moved = draftSpec([photoClip(0, "photo-mia-0004"), photoClip(1, "photo-mia-0001"), photoClip(2, "photo-mia-0002"), photoClip(3, "photo-mia-0003")]);
    const r = renderBlock(input({ spec: moved, verdict: { spec: READY, issues: unavailableAt(3) }, photos: photosOf(photo(4, { rejected: true })) }));
    expect(r).toEqual({ text: "Кадр 1: фото отклонено — замените его", settings: false, clips: [0] });
  });

  test("a flagged photo the owner removed since blocks nothing", () => {
    const three = draftSpec([photoClip(0, "photo-mia-0001"), photoClip(1, "photo-mia-0002"), photoClip(2, "photo-mia-0003", 2_000)]);
    expect(renderBlock(input({ spec: three, verdict: { spec: READY, issues: unavailableAt(3) }, photos: photosOf(photo(4, { rejected: true })) }))).toBeNull();
  });

  test("an engine-only issue elsewhere (a caption, the track) counts only while the spec is still the one it judged", () => {
    const withMusic = draftSpec(4, { music: { source: "trending", trackId: "track-0000001", startMs: 0 } });
    const changed = { ...withMusic, seed: 2 };
    const verdict = { spec: withMusic, issues: [{ code: "track-unavailable", path: ["music"] }] satisfies MontageIssue[] };
    // A trending track is supported since 3c.5, so once the verdict is stale there is no reason left to show.
    expect(renderBlock(input({ spec: changed, verdict }))).toBeNull();
    // While the spec is the one the engine judged, its answer shows.
    expect(renderBlock(input({ spec: withMusic, verdict }))?.text).toBe("Трек больше недоступен");
  });
});

describe("photoProblems: the cells whose photo cannot go into a video", () => {
  test("each flagged cell with its clip, cell and the photo's state", () => {
    const spec: MontageDraft = draftSpec([
      photoClip(0, "photo-mia-0001"),
      { clipId: "clip-002", durationMs: 3_000, transitionIn: "cut", kind: "collage", layout: "collage2", cells: [{ photo: { source: "scene", photoId: "photo-mia-0002" }, focus: null }, { photo: { source: "scene", photoId: "photo-mia-0003" }, focus: null }], motion: "kenburns", stagger: true },
    ]);
    const issues: MontageIssue[] = [{ code: "photo-unavailable", path: ["clips", 1, "cells", 1] }];
    expect(photoProblems(spec, { spec, issues }, photosOf(photo(3, { used: true, usedIn: ["video-0000002"] })))).toEqual([{ clip: 1, cell: 1, photoId: "photo-mia-0003", problem: "used", videoId: "video-0000002" }]);
  });

  test("no verdict yet: nothing is flagged", () => {
    expect(photoProblems(READY, null, photosOf())).toEqual([]);
  });
});
