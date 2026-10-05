import { describe, expect, test } from "bun:test";
import { ERROR_MESSAGES_RU, type EngineError, type MediaSummary, mediaReasonRu } from "../../../shared/engine";
import type { ImportView } from "../../engine/importJobs";
import { ManualScheduler } from "../../engine/scheduler";
import { NBSP } from "../../lib/format";
import {
  applyLibraryChange,
  deleteConfirmText,
  deleteRefusalText,
  dragKey,
  dropSummary,
  guardFileDrop,
  importCard,
  installFileDropGuard,
  isFileDrag,
  livePosters,
  MAX_LIVE_POSTERS,
  MAX_POSTERS,
  POSTER_REPORT_MS,
  PosterZones,
  importFailure,
  importTileLabel,
  type MineLibrary,
  mineHint,
  mineSections,
  nextListening,
  parseDragKey,
  pickOutcomeText,
  stickerAria,
  trackRowAria,
  trackRowNote,
  visualAria,
  visualTitle,
} from "./mine";
import { collageClip, draftSpec, photoClip, videoClip } from "./testkit";

// 3f.6: the «Мои» tab (EditorMine.dc.html; the reconciliation's M1–M12, M14, M15) as pure data: the owner's own files in three sections
// (photos and videos, music, stickers), each with its state in this draft and what a click does, the imports on their way, the result of
// a pick, a refusal in the kind's own words (`mediaReasonRu(reason, kind)`, never the neutral table directly), and deleting a file.

/** Russian typography: a number keeps its unit on the same line (a no-break space between them). */
const s = (text: string): string => text.replace(/(\d) (с|%|fps|файл|файла|файлов|раз|раза)(?=[\s.,)]|$)/g, `$1${NBSP}$2`);

let n = 0;
function media(kind: MediaSummary["kind"], name: string, patch: Partial<MediaSummary> = {}): MediaSummary {
  n += 1;
  const base = { mediaId: `media-${kind}-${String(n).padStart(4, "0")}`, kind, name, bytes: 1_000, createdAt: "2026-10-04T10:00:00.000Z", width: null, height: null, durationMs: null, sourceFps: null, hdrToSdr: false, loopFrames: null, delayFrames: null };
  if (kind === "photo") return { ...base, width: 1080, height: 1440, ...patch };
  if (kind === "video") return { ...base, width: 1080, height: 1920, durationMs: 6_400, sourceFps: 60, ...patch };
  if (kind === "audio") return { ...base, durationMs: 42_000, ...patch };
  return { ...base, width: 240, height: 240, loopFrames: 6, delayFrames: [2, 2, 2], ...patch };
}

function importing(patch: Partial<ImportView> & Pick<ImportView, "jobId" | "name" | "mediaKind">): ImportView {
  return { status: "running", stage: "copy", done: 400, total: 1_000, prepare: null, mediaId: null, error: null, cancelRequested: false, ...patch };
}

const PHOTO = media("photo", "croissant.jpg");
const VIDEO = media("video", "latte-pour.mov");
const BLINK = media("video", "blink.mov", { durationMs: 499 });
const SONG = media("audio", "summer-edit.mp3");
const NOTE = media("audio", "voice-note.m4a", { durationMs: 5_000 });
const STICKER = media("sticker", "underline.gif");
const LIBRARY: MineLibrary = { media: [STICKER, NOTE, SONG, BLINK, VIDEO, PHOTO], total: 6 };

/** 9.6 s: the video in clip 3 (as the artboard draws it). */
const SPEC = draftSpec([photoClip(0, "photo-mia-0001", 2_400), photoClip(1, "photo-mia-0002", 2_400), { ...videoClip(2, 2_400), mediaId: VIDEO.mediaId }, photoClip(3, "photo-mia-0003", 2_400)]);

const NO_TARGET = { fillTarget: null, addBlock: null, selectedSticker: null } as const;

describe("the library listing, kept current by media.changed", () => {
  test("a new record goes first (newest first) and counts; a stored one is replaced in place", () => {
    const fresh = media("photo", "new.jpg");
    const added = applyLibraryChange(LIBRARY, { change: "upserted", media: fresh });
    expect(added.media.map((m) => m.name)[0]).toBe("new.jpg");
    expect(added.total).toBe(7);
    const renamed = applyLibraryChange(added, { change: "upserted", media: { ...PHOTO, bytes: 9 } });
    expect(renamed.total).toBe(7);
    expect(renamed.media.find((m) => m.mediaId === PHOTO.mediaId)?.bytes).toBe(9);
    expect(renamed.media.at(-1)?.mediaId).toBe(PHOTO.mediaId);
  });

  test("a removed record leaves and the count drops; one not listed drops the count only when the listing was cut", () => {
    const removed = applyLibraryChange(LIBRARY, { change: "removed", mediaId: SONG.mediaId });
    expect(removed.media.some((m) => m.mediaId === SONG.mediaId)).toBe(false);
    expect(removed.total).toBe(5);
    expect(applyLibraryChange(LIBRARY, { change: "removed", mediaId: "media-unknown-01" })).toBe(LIBRARY);
    const cut: MineLibrary = { media: LIBRARY.media, total: 900 };
    expect(applyLibraryChange(cut, { change: "removed", mediaId: "media-unknown-01" }).total).toBe(899);
  });

  test("the listing never holds more than the 500 newest", () => {
    const full: MineLibrary = { media: Array.from({ length: 500 }, (_, i) => ({ ...PHOTO, mediaId: `media-full-${String(i).padStart(4, "0")}` })), total: 500 };
    const after = applyLibraryChange(full, { change: "upserted", media: media("photo", "501.jpg") });
    expect(after.media).toHaveLength(500);
    expect(after.media[0]?.name).toBe("501.jpg");
    expect(after.total).toBe(501);
  });
});

describe("the sections (M2, M8, M12): newest first, the imports on their way at the front of their kind's section", () => {
  test("photos and videos together, then music, then stickers; the counts include what is on its way", () => {
    const imports = [importing({ jobId: "job-imp-0001", name: "street-walk.mp4", mediaKind: "video" }), importing({ jobId: "job-imp-0002", name: "beat.mp3", mediaKind: "audio", status: "queued" })];
    const sections = mineSections(LIBRARY, imports, SPEC, NO_TARGET);
    expect(sections.visual.map((t) => (t.kind === "import" ? `↻ ${t.view.name}` : t.media.name))).toEqual(["↻ street-walk.mp4", "blink.mov", "latte-pour.mov", "croissant.jpg"]);
    expect(sections.tracks.map((t) => (t.kind === "import" ? `↻ ${t.view.name}` : t.media.name))).toEqual(["↻ beat.mp3", "voice-note.m4a", "summer-edit.mp3"]);
    expect(sections.stickers.map((t) => (t.kind === "import" ? `↻ ${t.view.name}` : t.media.name))).toEqual(["underline.gif"]);
    expect(sections.counts).toEqual({ visual: 4, tracks: 3, stickers: 1 });
  });

  test("finished imports are not tiles: a done one is its record, a refused one is told apart", () => {
    const imports = [importing({ jobId: "job-imp-0001", name: "a.jpg", mediaKind: "photo", status: "done", mediaId: "media-x-000001" }), importing({ jobId: "job-imp-0002", name: "b.jpg", mediaKind: "photo", status: "failed" })];
    expect(mineSections(LIBRARY, imports, SPEC, NO_TARGET).visual.some((t) => t.kind === "import")).toBe(false);
  });

  test("a tile's badge is the clip holding it (M5); what a click does follows the bin's rules (P12)", () => {
    const { visual } = mineSections(LIBRARY, [], SPEC, NO_TARGET);
    const byName = new Map(visual.flatMap((t) => (t.kind === "record" ? [[t.media.name, t] as const] : [])));
    expect(byName.get("latte-pour.mov")).toMatchObject({ slot: 3, action: "select" });
    expect(byName.get("croissant.jpg")).toMatchObject({ slot: null, action: "append" });
    // A video under 0.5 s on the grid is never placed (M7: the engine refuses it at import; this holds anyway).
    expect(byName.get("blink.mov")).toMatchObject({ slot: null, action: "too-short" });
  });

  test("an empty cell waiting: a photo fills it, a video (no cells) is still a new clip at the end; full: neither adds", () => {
    const withCell = draftSpec([collageClip(0, ["photo-mia-0001", null])]);
    const fill = mineSections(LIBRARY, [], withCell, { fillTarget: { clip: 0, cell: 1 }, addBlock: null, selectedSticker: null }).visual;
    const action = (name: string, tiles: typeof fill) => tiles.flatMap((t) => (t.kind === "record" && t.media.name === name ? [t.action] : []))[0];
    expect(action("croissant.jpg", fill)).toBe("fill");
    expect(action("latte-pour.mov", fill)).toBe("append");
    const full = mineSections(LIBRARY, [], withCell, { fillTarget: null, addBlock: "clip-cap", selectedSticker: null }).visual;
    expect(action("croissant.jpg", full)).toBe("full");
    expect(action("latte-pour.mov", full)).toBe("full");
  });

  test("a track: in this montage, or shorter than the montage (dimmed, not selectable: M10)", () => {
    const withSong = { ...SPEC, music: { source: "own" as const, mediaId: SONG.mediaId, startMs: 0 } };
    const { tracks } = mineSections(LIBRARY, [], withSong, NO_TARGET);
    const rows = tracks.flatMap((t) => (t.kind === "record" ? [[t.media.name, t.inDraft, t.tooShort]] : []));
    expect(rows).toEqual([
      ["voice-note.m4a", false, true],
      ["summer-edit.mp3", true, false],
    ]);
  });

  test("a sticker: how often this montage uses it, and the ring on the selected layer's", () => {
    const layer = (i: number) => ({ layerId: `layer-00${i}`, startMs: 0, endMs: 1_000, kind: "sticker" as const, sticker: { source: "own" as const, mediaId: STICKER.mediaId }, x: 0.5, y: 0.5, size: 0.2 });
    const spec = { ...SPEC, layers: [layer(1), layer(2)] };
    const [tile] = mineSections(LIBRARY, [], spec, { fillTarget: null, addBlock: null, selectedSticker: STICKER.mediaId }).stickers;
    expect(tile?.kind === "record" && [tile.uses, tile.on]).toEqual([2, true]);
  });
});

describe("the words on the tiles and rows", () => {
  test("a photo or video tile's name says what it is, how long a video runs, where it stands and what a click does", () => {
    const { visual } = mineSections(LIBRARY, [], SPEC, NO_TARGET);
    const labels = visual.flatMap((t) => (t.kind === "record" ? [visualAria(t, null)] : []));
    expect(labels).toEqual([s("Видео blink.mov, 0:00: короче 0.5 с, в ролик не поставить"), "Видео latte-pour.mov, 0:06 · в кадре 3: выбрать кадр 3", "Фото croissant.jpg: добавить кадр в конец ролика"]);
    const fill = mineSections(LIBRARY, [], draftSpec([collageClip(0, ["photo-mia-0001", null])]), { fillTarget: { clip: 0, cell: 1 }, addBlock: null, selectedSticker: null }).visual;
    const [photo] = fill.flatMap((t) => (t.kind === "record" && t.media.kind === "photo" ? [t] : []));
    expect(photo === undefined ? "" : visualAria(photo, { clip: 0, cell: 1 })).toBe("Фото croissant.jpg: в ячейку 2 кадра 1");
  });

  test("a track row: «0:42 · свой трек», «✓ в ролике», «короче ролика», and the reason in its name", () => {
    const withSong = { ...SPEC, music: { source: "own" as const, mediaId: SONG.mediaId, startMs: 0 } };
    const { tracks } = mineSections(LIBRARY, [], withSong, NO_TARGET);
    const [note, song] = tracks;
    if (note?.kind !== "record" || song?.kind !== "record") throw new Error("rows");
    expect(trackRowNote(note)).toBe("0:05 · короче ролика");
    expect(trackRowNote(song)).toBe("0:42 · ✓ в ролике");
    expect(trackRowNote({ ...song, inDraft: false })).toBe("0:42 · свой трек");
    expect(trackRowAria(note, 9_600)).toBe(s("voice-note.m4a, 0:05, свой трек, короче ролика (9.6 с), не выбрать"));
    expect(trackRowAria(song, 9_600)).toBe("summer-edit.mp3, 0:42, свой трек, в ролике");
  });

  test("the montage's own track that became shorter than the montage from its start (round 1, L4): «✓ в ролике · короче ролика», still selectable, with what to do", () => {
    // summer-edit.mp3 is 42 s; started at 35 s it holds 7 s of the 9.6 s montage.
    const late = { ...SPEC, music: { source: "own" as const, mediaId: SONG.mediaId, startMs: 35_000 } };
    const rows = mineSections(LIBRARY, [], late, NO_TARGET).tracks.flatMap((t) => (t.kind === "record" && t.media.mediaId === SONG.mediaId ? [t] : []));
    const [row] = rows;
    if (row === undefined) throw new Error("no row");
    expect([row.inDraft, row.tooShort, row.pickable]).toEqual([true, true, true]);
    expect(trackRowNote(row)).toBe("0:42 · ✓ в ролике · короче ролика");
    expect(trackRowAria(row, 9_600)).toBe(s("summer-edit.mp3, 0:42, свой трек, в ролике, короче ролика (9.6 с) с этого начала: сдвиньте начало трека раньше или укоротите ролик"));
    // From 0 it holds the whole montage.
    const fromStart = mineSections(LIBRARY, [], { ...late, music: { source: "own" as const, mediaId: SONG.mediaId, startMs: 0 } }, NO_TARGET).tracks.find((t) => t.kind === "record" && t.media.mediaId === SONG.mediaId);
    expect(fromStart?.kind === "record" && [fromStart.tooShort, fromStart.pickable]).toEqual([false, true]);
    // Another short track is not selectable at all.
    const note = mineSections(LIBRARY, [], late, NO_TARGET).tracks.find((t) => t.kind === "record" && t.media.mediaId === NOTE.mediaId);
    expect(note?.kind === "record" && [note.tooShort, note.pickable]).toEqual([true, false]);
  });

  test("a sticker tile's name", () => {
    const [tile] = mineSections(LIBRARY, [], SPEC, NO_TARGET).stickers;
    if (tile?.kind !== "record") throw new Error("tile");
    expect(stickerAria(tile)).toBe("Стикер underline.gif: в плейхед");
    expect(stickerAria({ ...tile, uses: 2, on: true })).toBe("Стикер underline.gif: в плейхед, в ролике 2, у выбранного слоя");
  });

  test("the hint under the photos and videos says what a click does now", () => {
    expect(mineHint(null, null)).toBe("Клик — кадр в конец ролика. Перетащите на «Кадры», чтобы вставить между кадрами.");
    expect(mineHint({ clip: 0, cell: 1 }, null)).toBe("Клик — фото в ячейку 2 кадра 1, видео — в конец. Перетащите на «Кадры», чтобы вставить между кадрами.");
    expect(mineHint(null, "clip-cap")).toBe("Не больше 20 кадров в одном видео. Клик по фото в панели ничего не добавит.");
  });

  test("a tile's tooltip says how much of a video a click puts in", () => {
    const { visual } = mineSections(LIBRARY, [], SPEC, NO_TARGET);
    const titles = visual.flatMap((t) => (t.kind === "record" ? [visualTitle(t)] : []));
    expect(titles).toEqual([s("Видео короче 0.5 с — в ролик не поставить"), "Уже в кадре 3 — клик выберет его", "Клик — кадр в конец ролика"]);
    const fresh = mineSections({ media: [media("video", "fresh.mov")], total: 1 }, [], SPEC, NO_TARGET).visual[0];
    expect(fresh?.kind === "record" ? visualTitle(fresh) : "").toBe(s("Клик — видео с начала, до 2 с, в конец ролика"));
  });
});

describe("an import on its way (M6, M14): the tile's word, and the status card's line", () => {
  test("queued, copying, preparing (with what is changed, when the engine says), cancelling", () => {
    expect(importTileLabel(importing({ jobId: "j-0000001", name: "a.mp4", mediaKind: "video", status: "queued" }))).toBe("в очереди");
    // 400 of 1000 bytes copied: the copy is the first 30 % of one bar over both stages (L8).
    expect(importTileLabel(importing({ jobId: "j-0000001", name: "a.mp4", mediaKind: "video" }))).toBe(s("12 %"));
    expect(importTileLabel(importing({ jobId: "j-0000001", name: "a.mp4", mediaKind: "video", cancelRequested: true }))).toBe("отменяем");

    const copy = importCard(importing({ jobId: "j-0000001", name: "street-walk.mp4", mediaKind: "video" }), 0);
    expect(copy).toEqual({ title: "Копируем street-walk.mp4", detail: s("12 %"), percent: 12 });
    const prepare = importCard(importing({ jobId: "j-0000001", name: "street-walk.mp4", mediaKind: "video", stage: "prepare", prepare: { hdrToSdr: true, fromFps: 60 } }), 2);
    expect(prepare).toEqual({ title: "Готовим street-walk.mp4", detail: s("HDR → SDR, 60 → 30 fps · 58 % · ещё 2 в очереди"), percent: 58 });
    expect(importCard(importing({ jobId: "j-0000001", name: "a.mov", mediaKind: "video", stage: "prepare", prepare: { hdrToSdr: false, fromFps: 59.94 } }), 0).detail).toBe(s("59.94 → 30 fps · 58 %"));
    expect(importCard(importing({ jobId: "j-0000001", name: "a.mov", mediaKind: "video", stage: "prepare", prepare: null }), 0).detail).toBe(s("58 %"));
    expect(importCard(importing({ jobId: "j-0000001", name: "a.mov", mediaKind: "video", cancelRequested: true }), 0)).toEqual({ title: "Отменяем a.mov", detail: "ничего не сохранится", percent: 12 });
  });

  test("a refusal inside the job is told in the KIND's words (mediaReasonRu with the job's kind); another failure by its error", () => {
    const codec: EngineError = { code: "MEDIA_UNSUPPORTED", mediaReason: "codec", detail: "x" };
    expect(importFailure(importing({ jobId: "j-0000001", name: "clip.webm", mediaKind: "video", status: "failed", error: codec }))).toEqual({ title: "clip.webm не подходит", body: mediaReasonRu("codec", "video") });
    expect(importFailure(importing({ jobId: "j-0000001", name: "song.ogg", mediaKind: "audio", status: "failed", error: { ...codec } }))?.body).toBe(mediaReasonRu("codec", "audio"));
    const internal: EngineError = { code: "INTERNAL" };
    expect(importFailure(importing({ jobId: "j-0000001", name: "a.jpg", mediaKind: "photo", status: "failed", error: internal }))).toEqual({ title: "Не удалось добавить a.jpg", body: ERROR_MESSAGES_RU.INTERNAL });
    // Cancelled by the engine (the window was not asked): said; the owner's own cancel: nothing to tell.
    expect(importFailure(importing({ jobId: "j-0000001", name: "a.jpg", mediaKind: "photo", status: "cancelled" }))).toEqual({ title: "a.jpg не добавлен", body: mediaReasonRu("cancelled", "photo") });
    expect(importFailure(importing({ jobId: "j-0000001", name: "a.jpg", mediaKind: "photo", status: "cancelled", cancelRequested: true }))).toBeNull();
    expect(importFailure(importing({ jobId: "j-0000001", name: "a.jpg", mediaKind: "photo" }))).toBeNull();
  });
});

describe("a pick's result (M15): a refused file is said with its reason, the skipped are said, never dropped", () => {
  const jobs = ["job-imp-0001", "job-imp-0002"];
  const running = jobs.map((jobId) => importing({ jobId, name: jobId, mediaKind: "photo" }));
  const done = running.map((v) => ({ ...v, status: "done" as const }));

  test("one file refused, two on their way, then added", () => {
    const outcome = { refused: [{ name: "track.wma", reason: "format" as const }], skipped: 0, jobIds: jobs };
    expect(pickOutcomeText(outcome, running)).toEqual({ title: "track.wma не подходит", lines: [mediaReasonRu("format")], rest: s("Остальные 2 файла добавляем.") });
    expect(pickOutcomeText(outcome, done)?.rest).toBe(s("Остальные 2 файла добавлены."));
    expect(pickOutcomeText({ ...outcome, jobIds: ["job-imp-0001"] }, done)?.rest).toBe("Другой файл добавлен.");
    const mixed = [importing({ jobId: "job-imp-0001", name: "a.jpg", mediaKind: "photo", status: "done" }), importing({ jobId: "job-imp-0002", name: "b.mov", mediaKind: "video", status: "failed" })];
    expect(pickOutcomeText(outcome, mixed)?.rest).toBe("Из остальных 2 добавлено: 1.");
    expect(pickOutcomeText({ ...outcome, jobIds: ["job-imp-0002"] }, mixed)?.rest).toBe("Другой файл не добавлен.");
    // A job this window no longer knows (dismissed, or dropped from the newest finished) is not counted as added.
    expect(pickOutcomeText(outcome, [])?.rest).toBe("Из остальных 2 добавлено: 0.");
  });

  test("several refused: each by name, the reason after a colon; the skipped files with the 20-file rule", () => {
    const outcome = { refused: [{ name: "IMG_2041.heic", reason: "heic" as const }, { name: "track.wma", reason: "format" as const }], skipped: 3, jobIds: [] };
    const text = pickOutcomeText(outcome, []);
    expect(text?.title).toBe(s("5 файлов не добавлено"));
    expect(text?.lines).toEqual([
      "IMG_2041.heic: формат HEIC не читается — сохраните как JPEG и добавьте снова.",
      `track.wma: ${mediaReasonRu("format").replace(/^Ф/, "ф")}`,
      `${s("Ещё 3 файла не просмотрены.")} ${mediaReasonRu("too-many")}`,
    ]);
    expect(text?.rest).toBeNull();
  });

  test("nothing refused and nothing skipped: no card", () => {
    expect(pickOutcomeText({ refused: [], skipped: 0, jobIds: jobs }, running)).toBeNull();
  });
});

describe("deleting a file", () => {
  test("the confirmation names the file, says the owner's original stays, and what this montage loses", () => {
    expect(deleteConfirmText(PHOTO, SPEC)).toEqual({ title: "Удалить «croissant.jpg»?", body: "Удалится копия в Studio, ваш исходный файл останется." });
    expect(deleteConfirmText(VIDEO, SPEC).body).toBe("Удалится копия в Studio, ваш исходный файл останется. В этом ролике он в кадре 3 — кадр будет помечен, пока его не замените.");
    const withSong = { ...SPEC, music: { source: "own" as const, mediaId: SONG.mediaId, startMs: 0 } };
    expect(deleteConfirmText(SONG, withSong).body).toBe("Удалится копия в Studio, ваш исходный файл останется. Это музыка ролика — она будет помечена, пока её не замените.");
    const layer = { layerId: "layer-001", startMs: 0, endMs: 1_000, kind: "sticker" as const, sticker: { source: "own" as const, mediaId: STICKER.mediaId }, x: 0.5, y: 0.5, size: 0.2 };
    expect(deleteConfirmText(STICKER, { ...SPEC, layers: [layer] }).body).toBe(s("Удалится копия в Studio, ваш исходный файл останется. В ролике он стоит 1 раз — слой будет помечен, пока его не замените."));
  });

  test("a refusal is said honestly: in a render's use nothing is deleted; gone already; anything else by its error", () => {
    expect(deleteRefusalText({ code: "IN_FLIGHT", detail: "x" }, "latte-pour.mov")).toBe("«latte-pour.mov» используется в рендере — его нельзя удалить, пока рендер не закончится. Ничего не удалено.");
    expect(deleteRefusalText({ code: "NOT_FOUND" }, "a.jpg")).toBe("«a.jpg» уже нет в библиотеке.");
    expect(deleteRefusalText({ code: "INTERNAL" }, "a.jpg")).toBe(ERROR_MESSAGES_RU.INTERNAL);
  });
});

describe("one track plays at a time (M9)", () => {
  test("a row starts its own track (stopping another); the same row again stops it", () => {
    expect(nextListening(null, "media-a-000001")).toBe("media-a-000001");
    expect(nextListening("media-a-000001", "media-b-000001")).toBe("media-b-000001");
    expect(nextListening("media-b-000001", "media-b-000001")).toBeNull();
  });
});

describe("video posters (rounds 1–3, M1): the VISIBLE tiles are live up to MAX_POSTERS; the tiles near the view fill the rest up to MAX_LIVE_POSTERS", () => {
  const ids = Array.from({ length: 80 }, (_, i) => `media-video-${String(i).padStart(4, "0")}`);
  const range = (from: number, to: number): string[] => ids.slice(from, to);

  test("scrolled to the middle: the visible tiles are all live, whatever lies above them; the nearest of the margins fill the rest", () => {
    // 20 visible (30–49), a screen of margin above (10–29) and below (50–69).
    const visible = new Set(range(30, 50));
    const near = new Set(range(10, 70));
    const live = livePosters(ids, visible, near, MAX_LIVE_POSTERS, MAX_POSTERS);
    expect(range(30, 50).every((id) => live.has(id))).toBe(true);
    expect(live.size).toBe(MAX_LIVE_POSTERS);
    // The 4 left go to the margin tiles nearest the view: 28, 29 above and 50, 51 below, never 10 or 69.
    expect([...live].filter((id) => !visible.has(id)).sort()).toEqual([ids[28], ids[29], ids[50], ids[51]].sort());
    expect(MAX_LIVE_POSTERS).toBe(24);
  });

  test("more visible tiles than the cap: every visible one is still live (the cap yields to what is seen)", () => {
    const visible = new Set(range(0, 30));
    expect(livePosters(ids, visible, new Set(range(0, 50)), MAX_LIVE_POSTERS, MAX_POSTERS).size).toBe(30);
  });

  test("a tall window (1180×2160: 73 tiles in view): the hard ceiling holds, the first 48 visible in the list's order are live, the rest are not", () => {
    const live = livePosters(ids, new Set(range(0, 73)), new Set(ids), MAX_LIVE_POSTERS, MAX_POSTERS);
    expect(MAX_POSTERS).toBe(48);
    expect([...live]).toEqual(range(0, 48));
    // Scrolled down the same tall window: still the first 48 of what is seen, from where the view starts.
    expect([...livePosters(ids, new Set(range(20, 80)), new Set(ids), MAX_LIVE_POSTERS, MAX_POSTERS)]).toEqual(range(20, 68));
    // Exactly at the ceiling every visible tile is live; one past it, the last one in the list waits.
    expect(livePosters(ids, new Set(range(0, 48)), new Set(), MAX_LIVE_POSTERS, MAX_POSTERS).size).toBe(48);
    expect(livePosters(ids, new Set(range(0, 49)), new Set(), MAX_LIVE_POSTERS, MAX_POSTERS).has(ids[48] ?? "")).toBe(false);
  });

  test("the ceiling bounds the margins too: they never fill past it, whatever the fill cap", () => {
    expect(livePosters(ids, new Set(), new Set(ids), 24, 10).size).toBe(10);
    expect(livePosters(ids, new Set(range(0, 5)), new Set(ids), 24, 10).size).toBe(10);
  });

  test("nothing visible yet (the observer has not reported): the near tiles, nearest first in the list's order, up to the cap", () => {
    expect([...livePosters(ids, new Set(), new Set(range(5, 12)), MAX_LIVE_POSTERS, MAX_POSTERS)]).toEqual(range(5, 12));
    expect(livePosters(ids, new Set(), new Set(ids), MAX_LIVE_POSTERS, MAX_POSTERS).size).toBe(MAX_LIVE_POSTERS);
  });

  test("the observers' reports are coalesced (round 2): one tick's reports land together at once, and a fast scroll's flood lands once at the end of each 150 ms", async () => {
    const scheduler = new ManualScheduler();
    const applied: [string[], string[]][] = [];
    const zones = new PosterZones(scheduler, (visible, near) => applied.push([[...visible].sort(), [...near].sort()]));
    zones.report("visible", [{ id: "a", isIntersecting: true }]);
    zones.report("near", [{ id: "a", isIntersecting: true }, { id: "b", isIntersecting: true }]);
    expect(applied).toHaveLength(0);
    await Promise.resolve();
    expect(applied).toEqual([[["a"], ["a", "b"]]]);
    // A flood while cooling down: nothing more until the 150 ms are over, then the latest state, once.
    for (const id of ["c", "d", "e"]) zones.report("visible", [{ id, isIntersecting: true }]);
    zones.report("visible", [{ id: "a", isIntersecting: false }]);
    await Promise.resolve();
    expect(applied).toHaveLength(1);
    expect(POSTER_REPORT_MS).toBe(150);
    scheduler.next();
    expect(applied.at(-1)).toEqual([["c", "d", "e"], ["a", "b"]]);
    expect(applied).toHaveLength(2);
    // Quiet again: the cool-down ends with nothing to apply, and the next report lands at once.
    scheduler.runAll();
    expect(applied).toHaveLength(2);
    zones.report("near", [{ id: "b", isIntersecting: false }]);
    await Promise.resolve();
    expect(applied.at(-1)).toEqual([["c", "d", "e"], ["a"]]);
    zones.dispose();
    zones.report("near", [{ id: "z", isIntersecting: true }]);
    await Promise.resolve();
    scheduler.runAll();
    expect(applied).toHaveLength(3);
  });

  test("a tile that left the zone lets go of its poster; an id the list does not hold is never live", () => {
    expect(livePosters(ids, new Set(), new Set(), MAX_LIVE_POSTERS, MAX_POSTERS).size).toBe(0);
    expect([...livePosters(range(0, 2), new Set(["media-gone-0001"]), new Set(["media-gone-0002", ids[1] ?? ""]), MAX_LIVE_POSTERS, MAX_POSTERS)]).toEqual([ids[1]]);
  });
});

describe("files dragged from Finder over the drop zone (M13): what the zone says before the drop", () => {
  const item = (type: string, kind = "file") => ({ kind, type });

  test("a drag of files only: text or a link dragged from a page is not a drop of files", () => {
    expect(isFileDrag(["Files"])).toBe(true);
    expect(isFileDrag(["text/plain", "Files"])).toBe(true);
    expect(isFileDrag(["text/plain"])).toBe(false);
    expect(isFileDrag(["text/uri-list", "text/html"])).toBe(false);
    expect(isFileDrag([])).toBe(false);
  });

  test("«Отпустите — добавим 3 файла · 2 фото, 1 видео»: counted by the type each item says (a GIF is a sticker)", () => {
    expect(dropSummary([item("image/jpeg"), item("image/png"), item("video/quicktime")])).toEqual({ count: 3, title: s("Отпустите — добавим 3 файла"), detail: "2 фото, 1 видео" });
    expect(dropSummary([item("audio/mpeg"), item("audio/x-m4a"), item("image/gif"), item("video/mp4"), item("image/webp")])?.detail).toBe("1 фото, 1 видео, 2 трека, 1 стикер");
    expect(dropSummary([item("image/gif")])).toEqual({ count: 1, title: s("Отпустите — добавим 1 файл"), detail: "1 стикер" });
  });

  test("a type it cannot tell (a folder, an unknown file): «N файлов», with the kinds the zone takes", () => {
    expect(dropSummary([item("image/jpeg"), item("")])).toEqual({ count: 2, title: s("Отпустите — добавим 2 файла"), detail: "фото, видео, музыка, стикеры" });
    expect(dropSummary([item("application/pdf")])?.detail).toBe("фото, видео, музыка, стикеры");
  });

  test("more than 20: the zone says only 20 go in", () => {
    expect(dropSummary(Array.from({ length: 25 }, () => item("image/jpeg")))).toEqual({ count: 25, title: s("Отпустите — добавим 20 из 25 файлов"), detail: "за раз — не больше 20, остальные не добавятся" });
  });

  test("items that are not files (a string beside them) are not counted; none at all is no summary", () => {
    expect(dropSummary([item("text/plain", "string"), item("image/jpeg")])?.count).toBe(1);
    expect(dropSummary([item("text/plain", "string")])).toBeNull();
    expect(dropSummary([])).toBeNull();
  });
});

describe("files dropped anywhere but the drop zone do nothing, and the window never opens them", () => {
  function dragEvent(types: string[], prevented = false) {
    const transfer = { types, dropEffect: "copy" as string };
    const event = { defaultPrevented: prevented, dataTransfer: transfer, prevented: false, preventDefault() { this.prevented = true; } };
    return { event, transfer };
  }

  test("a file drag the zone did not take is refused: the default (open the file) is prevented and the cursor says no", () => {
    const { event, transfer } = dragEvent(["Files"]);
    guardFileDrop(event);
    expect(event.prevented).toBe(true);
    expect(transfer.dropEffect).toBe("none");
  });

  test("the window's guard listens to dragover and drop, and is taken off again", () => {
    const target = new EventTarget();
    const stop = installFileDropGuard(target);
    const fire = (type: string) => {
      const transfer = { types: ["Files"], dropEffect: "copy" };
      const event = Object.assign(new Event(type, { cancelable: true }), { dataTransfer: transfer });
      target.dispatchEvent(event);
      return [event.defaultPrevented, transfer.dropEffect];
    };
    expect(fire("dragover")).toEqual([true, "none"]);
    expect(fire("drop")).toEqual([true, "none"]);
    stop();
    expect(fire("drop")).toEqual([false, "copy"]);
  });

  test("the zone's own drag is left as the zone set it; a drag that is not of files is left alone", () => {
    const zone = dragEvent(["Files"], true);
    guardFileDrop(zone.event);
    expect([zone.event.prevented, zone.transfer.dropEffect]).toEqual([false, "copy"]);
    const text = dragEvent(["text/plain"]);
    guardFileDrop(text.event);
    expect([text.event.prevented, text.transfer.dropEffect]).toEqual([false, "copy"]);
    guardFileDrop({ defaultPrevented: false, dataTransfer: null, preventDefault() {} });
  });
});

describe("what a drag out of the panel carries", () => {
  test("a scene photo is its id (as the «Фото» tab has it); an own photo or video says so, and a video its length", () => {
    expect(dragKey({ source: "scene", photoId: "photo-mia-0001" })).toBe("photo-mia-0001");
    const photo = { source: "own" as const, kind: "photo" as const, mediaId: PHOTO.mediaId };
    const video = { source: "own" as const, kind: "video" as const, mediaId: VIDEO.mediaId, durationMs: 6_400 };
    for (const drag of [photo, video, { source: "scene" as const, photoId: "photo-mia-0001" }]) expect(parseDragKey(dragKey(drag))).toEqual(drag);
  });

  test("a key that is not one of ours is nothing", () => {
    for (const key of ["", "own-photo:", "own-video:media-x-000001", "own-video:media-x-000001:abc", "own-video:media-x-000001:-5", "own-sound:media-x-000001", "a b"]) expect(parseDragKey(key)).toBeNull();
  });
});
