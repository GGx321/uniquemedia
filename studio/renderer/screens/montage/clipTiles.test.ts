import { describe, expect, test } from "bun:test";
import { CLIP_REASONS_RU, ClipSummary, type EngineError, type MediaOrigin, mediaReasonRu, type PhotoSummary } from "../../../shared/engine";
import { scenePhoto } from "../../engine/mockEngine.testkit";
import { NBSP } from "../../lib/format";
import { binNumbers, clipImportFailure, clipTileAria, clipTiles, clipTileTitle, clipsHint, type ClipTile, type ClipTileState, copyLabeller, pickAria } from "./clipTiles";
import type { OriginOf } from "./clipOps";
import { draftSpec, photoClip } from "./testkit";

// 5b.2 part A (S5.WA4; plan §5.1, I5.60; mockups 57–57d, README §S5.WAD): the editor's «Клипы» tab as pure data. The draft avatar's READY clips, newest
// first, each with what its frame allows (Q-F = 1): placed (its copy is a kadr of this draft), on its way («Готовим для монтажа…», an import job), taken
// (in a finished video by the clip itself or by its photo, its photo rejected or in a render, its photo or a sibling clip in this draft), a file that will
// not prepare (`file-damaged`), a try that failed, or free. «Фото N» is the «Фото» tab's number; a photo with none is called by its category.

const AVATAR = "avatar-mia-0001";
const P = (n: number): string => `photo-mia-${String(n).padStart(4, "0")}`;

function ready(clipId: string, photoId: string, patch: Partial<Extract<ClipSummary, { status: "ready" }>> = {}): Extract<ClipSummary, { status: "ready" }> {
  const clip: Extract<ClipSummary, { status: "ready" }> = {
    clipId,
    avatarId: AVATAR,
    photoId,
    createdAt: "2026-10-14T10:00:00.000Z",
    seen: true,
    motion: { source: "code", label: "Как в сцене", text: "she slowly raises her mug" },
    request: { model: "kling", quality: "std", seconds: 5, fallback: "auto" },
    model: "kling-std",
    fallback: false,
    recovered: false,
    cost: { micros: 420_000, kind: "billed" },
    exports: [],
    status: "ready",
    width: 720,
    height: 1280,
    durationMs: 5_000,
    face: { verdict: "match", p75: 0.71, frames: 11 },
    ...patch,
  };
  expect(ClipSummary.safeParse(clip).success).toBe(true);
  return clip;
}

/** The bin's photos, newest first: photo 5 is rejected (no number), photo 6 in a running render; the rest eligible. */
const PHOTOS: PhotoSummary[] = [scenePhoto(1), scenePhoto(2), scenePhoto(3), scenePhoto(4), scenePhoto(5, { rejected: true, eligible: false, category: "shoot" }), scenePhoto(6, { reserved: true }), scenePhoto(7)];
const INDEX = new Map(PHOTOS.map((p) => [p.photoId, p]));

const COPY_3 = "media-copy-0003";
const ORIGIN_3: MediaOrigin = { kind: "clip", avatarId: AVATAR, clipId: "clip-0000003", photoId: P(4) };
const ORIGINS: ReadonlyMap<string, MediaOrigin> = new Map([[COPY_3, ORIGIN_3]]);
const originOf: OriginOf = (mediaId) => ORIGINS.get(mediaId);
const copyClip = (index: number, mediaId: string) => ({ clipId: `clip-${String(index + 1).padStart(3, "0")}`, durationMs: 2_000, transitionIn: "cut" as const, kind: "video" as const, mediaId, trimStartMs: 0, focus: null });

/** README §S5.WAD's one library: clip 1 in a video, 2 free (photo 2 is a kadr), 3 placed, 4 its sibling, 5 a rejected photo's, 6 in a render, 7 a sibling of clip 1. */
const CLIPS: ClipSummary[] = [
  ready("clip-0000001", P(7), { use: { inVideo: "clip" } }),
  ready("clip-0000002", P(2), { motion: { source: "code", label: "Моргает и улыбается", text: "she blinks" } }),
  ready("clip-0000003", P(4), { motion: { source: "code", label: "Поправляет прядь", text: "she tucks her hair" } }),
  ready("clip-0000004", P(4)),
  ready("clip-0000005", P(5), { model: "grok" }),
  ready("clip-0000006", P(6), { width: 1080, height: 1920, model: "kling-pro" }),
  ready("clip-0000007", P(7), { durationMs: 10_000, use: { inVideo: "photo" } }),
  ready("clip-0000008", P(1)),
];
const SPEC = draftSpec([photoClip(0, P(3)), photoClip(1, P(2)), copyClip(2, COPY_3)]);
const NONE = { busy: new Set<string>(), failed: new Map<string, "failed" | "damaged">() };

const states = (tiles: readonly ClipTile[]): [string, ClipTileState][] => tiles.map((t) => [t.clip.clipId, t.state]);

describe("the tiles (57, 57b)", () => {
  const tiles = clipTiles({ clips: CLIPS, spec: SPEC, originOf, photos: INDEX, ...NONE });

  test("ready clips only, in the list's order, each with its frame's state", () => {
    const { status: _status, width: _w, height: _h, durationMs: _d, face: _f, use: _u, ...common } = ready("clip-0000009", P(1));
    const failedClip: ClipSummary = { ...common, status: "failed", failure: { reason: "refused-free" } };
    expect(ClipSummary.safeParse(failedClip).success).toBe(true);
    const withFailed = clipTiles({ clips: [...CLIPS.slice(0, 1), failedClip], spec: SPEC, originOf, photos: INDEX, ...NONE });
    expect(withFailed.map((t) => t.clip.clipId)).toEqual(["clip-0000001"]);
    expect(states(tiles)).toEqual([
      ["clip-0000001", { kind: "taken", why: "used-clip" }],
      ["clip-0000002", { kind: "taken", why: "photo-in" }],
      ["clip-0000003", { kind: "placed", slot: 3 }],
      ["clip-0000004", { kind: "taken", why: "sibling-in" }],
      ["clip-0000005", { kind: "taken", why: "rejected" }],
      ["clip-0000006", { kind: "taken", why: "reserved" }],
      ["clip-0000007", { kind: "taken", why: "used-photo" }],
      ["clip-0000008", { kind: "free" }],
    ]);
  });

  test("«Фото N» by the «Фото» tab's numbering (eligible photos in the list's order); a photo with no number by its category; an unknown one by nothing", () => {
    expect(tiles.map((t) => t.source)).toEqual(["Фото 6", "Фото 2", "Фото 4", "Фото 4", "Улица", "Фото 5", "Фото 6", "Фото 1"]);
    expect(clipTiles({ clips: CLIPS.slice(0, 1), spec: SPEC, originOf, photos: null, ...NONE })[0]?.source).toBeNull();
    expect([...binNumbers(PHOTOS)]).toEqual([
      [P(1), 1],
      [P(2), 2],
      [P(3), 3],
      [P(4), 4],
      [P(6), 5],
      [P(7), 6],
    ]);
  });

  test("the pills of 5b.1: «0:05» or «0:10», «Grok» and «1080p» by the file", () => {
    expect(tiles.map((t) => [t.length, t.tags])).toEqual([
      ["0:05", []],
      ["0:05", []],
      ["0:05", []],
      ["0:05", []],
      ["0:05", ["Grok"]],
      ["0:05", ["1080p"]],
      ["0:10", []],
      ["0:05", []],
    ]);
  });

  test("a photo the list says is used marks its clips used even before the clip list is read again", () => {
    const used = new Map(INDEX).set(P(1), scenePhoto(1, { used: true, usedIn: ["video-0000001"] }));
    expect(clipTiles({ clips: [ready("clip-0000008", P(1))], spec: SPEC, originOf, photos: used, ...NONE })[0]?.state).toEqual({ kind: "taken", why: "used-photo" });
  });

  test("no origins known yet: a copy's clip reads free and its sibling too (the engine still refuses the frame at the render)", () => {
    const blind = clipTiles({ clips: CLIPS, spec: SPEC, originOf: () => undefined, photos: INDEX, ...NONE });
    expect(blind[2]?.state).toEqual({ kind: "free" });
    expect(blind[3]?.state).toEqual({ kind: "free" });
  });
});

describe("preparing, damaged and failed (57a, 57c)", () => {
  test("an import on its way reads busy, before any taken state but a placed one; damaged and failed are this window's", () => {
    const tiles = clipTiles({
      clips: CLIPS,
      spec: SPEC,
      originOf,
      photos: INDEX,
      busy: new Set(["clip-0000003", "clip-0000008", "clip-0000002"]),
      failed: new Map<string, "failed" | "damaged">([
        ["clip-0000001", "damaged"],
        ["clip-0000004", "failed"],
      ]),
    });
    const free = clipTiles({
      clips: [ready("clip-0000008", P(1)), ready("clip-0000009", P(3))],
      spec: draftSpec(0),
      originOf,
      photos: INDEX,
      busy: new Set(),
      failed: new Map<string, "failed" | "damaged">([
        ["clip-0000008", "damaged"],
        ["clip-0000009", "failed"],
      ]),
    });
    expect(states(tiles).filter(([id]) => ["clip-0000002", "clip-0000003", "clip-0000008"].includes(id))).toEqual([
      ["clip-0000002", { kind: "busy" }],
      ["clip-0000003", { kind: "placed", slot: 3 }],
      ["clip-0000008", { kind: "busy" }],
    ]);
    // A taken frame stays taken whatever the window last met; a free one shows what the last try met.
    expect(tiles[0]?.state).toEqual({ kind: "taken", why: "used-clip" });
    expect(tiles[3]?.state).toEqual({ kind: "taken", why: "sibling-in" });
    expect(states(free)).toEqual([
      ["clip-0000008", { kind: "damaged" }],
      ["clip-0000009", { kind: "failed" }],
    ]);
  });
});

describe("the words of a tile (57, 57a, 57b; README «Тексты»)", () => {
  const tiles = clipTiles({ clips: CLIPS, spec: SPEC, originOf, photos: INDEX, ...NONE });
  const at = (i: number): ClipTile => {
    const tile = tiles[i];
    if (tile === undefined) throw new Error(`no tile ${i}`);
    return tile;
  };
  const free = at(7);

  test("the state on the `li`: «Клип «<движение>», 0:05, Фото N · <состояние>»", () => {
    expect(tiles.map((t) => clipTileAria(t))).toEqual([
      "Клип «Как в сцене», 0:05, Фото 6 · в видео",
      "Клип «Моргает и улыбается», 0:05, Фото 2 · это фото уже в ролике",
      "Клип «Поправляет прядь», 0:05, Фото 4 · в кадре 3",
      "Клип «Как в сцене», 0:05, Фото 4 · клип этого фото уже в ролике",
      "Клип «Как в сцене», 0:05, Улица · фото отклонено",
      "Клип «Как в сцене», 0:05, Фото 5 · в рендере",
      "Клип «Как в сцене», 0:10, Фото 6 · в видео",
      "Клип «Как в сцене», 0:05, Фото 1 · не использован",
    ]);
    expect(clipTileAria({ ...free, state: { kind: "busy" } })).toBe("Клип «Как в сцене», 0:05, Фото 1 · Готовим для монтажа…");
    expect(clipTileAria({ ...free, state: { kind: "damaged" } })).toBe("Клип «Как в сцене», 0:05, Фото 1 · файл повреждён");
    expect(clipTileAria({ ...free, source: null })).toBe("Клип «Как в сцене», 0:05 · не использован");
  });

  test("the action on the button: «…: добавить кадр в конец ролика», «…: выбрать кадр 3», «…: уже занято», «…: не подготовить»", () => {
    expect(pickAria(free, null)).toBe("Клип «Как в сцене», 0:05: добавить кадр в конец ролика");
    expect(pickAria(at(2), null)).toBe("Клип «Поправляет прядь», 0:05: выбрать кадр 3");
    expect(pickAria(at(0), null)).toBe("Клип «Как в сцене», 0:05: уже занято");
    expect(pickAria({ ...free, state: { kind: "damaged" } }, null)).toBe("Клип «Как в сцене», 0:05: не подготовить");
    expect(pickAria(free, "clip-cap")).toBe("Клип «Как в сцене», 0:05: кадров больше не добавить");
    // A placed clip is still selected at the cap.
    expect(pickAria(at(2), "no-room")).toBe("Клип «Поправляет прядь», 0:05: выбрать кадр 3");
  });

  test("the titles, capitalised; the two «в видео» told apart by `use.inVideo`", () => {
    expect(clipTileTitle(at(0), null)).toBe("Этот клип уже в готовом видео — второй раз не ставится");
    expect(clipTileTitle(at(6), null)).toBe("Фото этого клипа или другой клип из него уже в готовом видео — второй раз не ставится");
    expect(clipTileTitle(at(1), null)).toBe("Это фото уже в ролике");
    expect(clipTileTitle(at(3), null)).toBe("Клип этого фото уже в ролике");
    expect(clipTileTitle(at(4), null)).toBe("Фото этого клипа отклонено — в монтаж не ставится");
    expect(clipTileTitle(at(5), null)).toBeNull();
    expect(clipTileTitle(at(2), null)).toBe("Уже в кадре 3 — клик выберет его");
    expect(clipTileTitle(free, null)).toBe(`Клик — видео с начала, до 2${NBSP}с, в конец ролика`);
    expect(clipTileTitle({ ...free, state: { kind: "failed" } }, null)).toBe(`Клик — видео с начала, до 2${NBSP}с, в конец ролика`);
    expect(clipTileTitle({ ...free, state: { kind: "busy" } }, null)).toBe("Готовим для монтажа…");
    expect(clipTileTitle({ ...free, state: { kind: "damaged" } }, null)).toBe(CLIP_REASONS_RU["file-damaged"]);
    expect(clipTileTitle(free, "clip-cap")).toBe("Кадров больше не добавить");
  });
});

describe("the line under the tiles (57, `#cell`, `#full`; WAD re-review N5)", () => {
  test("by default the «Мои» hint; with a cell chosen, a clip still goes to the end; at the caps, said of a clip", () => {
    expect(clipsHint(null, null)).toBe("Клик — кадр в конец ролика. Перетащите на «Кадры», чтобы вставить между кадрами.");
    expect(clipsHint({ clip: 0, cell: 1 }, null)).toBe("Клик — клип в конец ролика, в ячейку коллажа — только фото. Перетащите на «Кадры», чтобы вставить между кадрами.");
    expect(clipsHint({ clip: 0, cell: 1, replace: true }, null)).toBe("Клик — клип в конец ролика, в ячейку коллажа — только фото. Перетащите на «Кадры», чтобы вставить между кадрами.");
    expect(clipsHint(null, "clip-cap")).toBe("Не больше 20 кадров в одном видео. Клик по клипу в панели ничего не добавит.");
    expect(clipsHint({ clip: 0, cell: 1 }, "no-room")).toBe(`В ролике уже 15 с: на новый кадр нет места. Укоротите кадр, чтобы добавить клип.`);
  });
});

describe("a copy as the draft calls it (57f; README M6)", () => {
  test("by its clip's motion and its photo («Фото N», else the category), never by the copy's file name; an own video is no copy", () => {
    const copyOf = copyLabeller(originOf, CLIPS, INDEX);
    expect(copyOf(COPY_3)).toEqual({ origin: ORIGIN_3, motion: "Поправляет прядь", source: "Фото 4" });
    expect(copyOf("media-own-0001")).toBeNull();
    // The clip list or the photos not read yet: the copy is still a copy, its words wait.
    expect(copyLabeller(originOf, null, null)(COPY_3)).toEqual({ origin: ORIGIN_3, motion: null, source: null });
  });
});

describe("a refused preparation, one text per reason (57c)", () => {
  const nb = (text: string): string => text.replace(/ — /g, `${NBSP}— `);
  const err = (error: EngineError): EngineError => error;

  test("an importer failure: «Не удалось подготовить клип — файл в Studio цел. Попробуйте ещё раз.», the tile pressable", () => {
    expect(clipImportFailure(err({ code: "INTERNAL", detail: "encode failed" }))).toEqual({ text: nb("Не удалось подготовить клип — файл в Studio цел. Попробуйте ещё раз."), damaged: false });
    expect(clipImportFailure(err({ code: "MEDIA_UNSUPPORTED", mediaReason: "codec" }))).toEqual({ text: nb("Не удалось подготовить клип — файл в Studio цел. Попробуйте ещё раз."), damaged: false });
  });

  test("a full disk: the video's own no-space text", () => {
    expect(clipImportFailure(err({ code: "MEDIA_UNSUPPORTED", mediaReason: "no-space" }))).toEqual({ text: nb(mediaReasonRu("no-space", "video")), damaged: false });
  });

  test("the contract's texts: `file-damaged` (the tile no longer pressable) and `job-running`", () => {
    expect(clipImportFailure(err({ code: "VALIDATION", clipReason: "file-damaged" }))).toEqual({ text: nb(CLIP_REASONS_RU["file-damaged"]), damaged: true });
    expect(clipImportFailure(err({ code: "IN_FLIGHT", clipReason: "job-running" }))).toEqual({ text: nb(CLIP_REASONS_RU["job-running"]), damaged: false });
  });

  test("NOT_FOUND: no card (the tile goes with the next list); anything else in the engine's own words", () => {
    expect(clipImportFailure(err({ code: "NOT_FOUND" }))).toBeNull();
    expect(clipImportFailure(err({ code: "LIBRARY_UNAVAILABLE" }))?.damaged).toBe(false);
    expect(clipImportFailure(err({ code: "LIBRARY_UNAVAILABLE" }))?.text.length).toBeGreaterThan(0);
  });
});
