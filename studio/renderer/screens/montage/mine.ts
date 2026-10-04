import { Id, MAX_LISTED_MEDIA, type EngineError, type MediaKind, type MediaRefusal, type MediaSummary, type MontageDraft, mediaReasonRu } from "../../../shared/engine";
import { FPS, MIN_CLIP_MS } from "../../../shared/montage";
import type { MediaStoreChange } from "../../engine/store";
import { type ImportView, importPercent, isActiveImport } from "../../engine/importJobs";
import { errorText } from "../../lib/errors";
import { afterColon, countOf, NBSP, plural } from "../../lib/format";
import { type AddRefusal, ownSlots, totalMs, videoClipLimitMs } from "./clipOps";
import { addBlockedLabel, secondsLabel, trackClock } from "./labels";
import { ownTrackTooShort } from "./musicOps";

// 3f.6: the «Мои» tab (EditorMine.dc.html; the reconciliation's M1–M12, M14, M15), as pure data. The owner's own files in three sections,
// newest first: «Фото и видео» (photo and video tiles, M2–M7), «Музыка» (track rows, M8–M11) and «Стикеры» (M12). The imports on their
// way head their kind's section (M6). Each tile knows its state in this draft and what a click does, by the «Фото» tab's rules (P12,
// AM7); the words are here so the screen says them one way. A refusal is told in the words of the file's KIND (`mediaReasonRu(reason,
// kind)`): the job knows its kind; a pick's refusal does not, so it gets the neutral text.

/** The library as the tab lists it: `media.list`'s newest records (at most 500) and how many there are in all. */
export interface MineLibrary {
  readonly media: readonly MediaSummary[];
  readonly total: number;
}

/**
 * The listing after one `media.changed`: a record stored anew goes first and counts, one stored again is replaced in place, one removed
 * leaves. An unknown id removed drops the count only when the listing was cut (it may be one of the older records). Never more than the
 * 500 newest; the same object when nothing changes.
 */
export function applyLibraryChange(library: MineLibrary, change: MediaStoreChange): MineLibrary {
  if (change.change === "removed") {
    if (library.media.some((m) => m.mediaId === change.mediaId)) return { media: library.media.filter((m) => m.mediaId !== change.mediaId), total: Math.max(0, library.total - 1) };
    return library.total > library.media.length ? { media: library.media, total: library.total - 1 } : library;
  }
  const at = library.media.findIndex((m) => m.mediaId === change.media.mediaId);
  if (at >= 0) return { media: library.media.map((m, i) => (i === at ? change.media : m)), total: library.total };
  return { media: [change.media, ...library.media].slice(0, MAX_LISTED_MEDIA), total: library.total + 1 };
}

/**
 * What a click on a photo or video tile does (the «Фото» tab's rules, P12): `select` the clip a placed file is in; a photo `fill`s the
 * empty cell waiting for it; else `append` a clip at the end; `full` when no clip can be added; `too-short` for a video under the shortest
 * clip (0.5 s on the 100 ms grid), which is never placed.
 */
export type VisualAction = "select" | "fill" | "append" | "full" | "too-short";

/** An empty cell of the selected clip that a click fills (the bin's own). */
export type FillTarget = { readonly clip: number; readonly cell: number } | null;

export type VisualTile =
  | { readonly kind: "record"; readonly media: MediaSummary; readonly slot: number | null; readonly action: VisualAction }
  | { readonly kind: "import"; readonly view: ImportView };

export type TrackTile = { readonly kind: "record"; readonly media: MediaSummary; readonly inDraft: boolean; readonly tooShort: boolean } | { readonly kind: "import"; readonly view: ImportView };

export type StickerTile = { readonly kind: "record"; readonly media: MediaSummary; readonly uses: number; readonly on: boolean } | { readonly kind: "import"; readonly view: ImportView };

export interface MineSections {
  readonly visual: readonly VisualTile[];
  readonly tracks: readonly TrackTile[];
  readonly stickers: readonly StickerTile[];
  /** «Фото и видео · N», «Музыка · N», «Стикеры · N»: what each section shows, the imports on their way included. */
  readonly counts: { readonly visual: number; readonly tracks: number; readonly stickers: number };
}

export interface SectionOptions {
  readonly fillTarget: FillTarget;
  readonly addBlock: AddRefusal | null;
  /** The selected layer's own sticker (its media id), ringed; null when none is selected. */
  readonly selectedSticker: string | null;
}

const isVisual = (kind: MediaKind): boolean => kind === "photo" || kind === "video";

function visualAction(media: MediaSummary, slot: number | null, options: SectionOptions): VisualAction {
  if (slot !== null) return "select";
  if (media.kind === "video" && videoClipLimitMs(media.durationMs ?? 0) < MIN_CLIP_MS) return "too-short";
  if (media.kind === "photo" && options.fillTarget !== null) return "fill";
  return options.addBlock === null ? "append" : "full";
}

/** The tab's three sections: the imports on their way (queued or running) first, then the records, newest first. */
export function mineSections(library: MineLibrary, imports: readonly ImportView[], spec: MontageDraft, options: SectionOptions): MineSections {
  const active = imports.filter(isActiveImport);
  const slots = ownSlots(spec);
  const total = totalMs(spec);
  const ownTrack = spec.music?.source === "own" ? spec.music.mediaId : null;
  const stickerUses = new Map<string, number>();
  for (const layer of spec.layers) if (layer.kind === "sticker" && layer.sticker.source === "own") stickerUses.set(layer.sticker.mediaId, (stickerUses.get(layer.sticker.mediaId) ?? 0) + 1);

  const visual: VisualTile[] = [
    ...active.filter((v) => isVisual(v.mediaKind)).map((view): VisualTile => ({ kind: "import", view })),
    ...library.media
      .filter((m) => isVisual(m.kind))
      .map((media): VisualTile => {
        const slot = slots.get(media.mediaId) ?? null;
        return { kind: "record", media, slot, action: visualAction(media, slot, options) };
      }),
  ];
  const tracks: TrackTile[] = [
    ...active.filter((v) => v.mediaKind === "audio").map((view): TrackTile => ({ kind: "import", view })),
    ...library.media.filter((m) => m.kind === "audio").map((media): TrackTile => ({ kind: "record", media, inDraft: media.mediaId === ownTrack, tooShort: ownTrackTooShort({ durationMs: media.durationMs ?? 0 }, total) })),
  ];
  const stickers: StickerTile[] = [
    ...active.filter((v) => v.mediaKind === "sticker").map((view): StickerTile => ({ kind: "import", view })),
    ...library.media.filter((m) => m.kind === "sticker").map((media): StickerTile => ({ kind: "record", media, uses: stickerUses.get(media.mediaId) ?? 0, on: media.mediaId === options.selectedSticker })),
  ];
  return { visual, tracks, stickers, counts: { visual: visual.length, tracks: tracks.length, stickers: stickers.length } };
}

// ---------- words ----------

/** «0:06», «0:42»: a length in whole seconds, as the artboard writes a video's and a track's. */
export const lengthClock = (ms: number): string => trackClock(Math.floor(Math.max(0, ms) / 1000) * 1000);

const KIND_WORD: Record<MediaKind, string> = { photo: "Фото", video: "Видео", audio: "Трек", sticker: "Стикер" };

/** «Видео latte-pour.mov, 0:06 · в кадре 3»: what a photo or video tile is and where it stands. */
function visualName(tile: Extract<VisualTile, { kind: "record" }>): string {
  const { media } = tile;
  const head = media.kind === "video" ? `${KIND_WORD.video} ${media.name}, ${lengthClock(media.durationMs ?? 0)}` : `${KIND_WORD.photo} ${media.name}`;
  return tile.slot === null ? head : `${head} · в кадре ${tile.slot}`;
}

function actionWords(tile: Extract<VisualTile, { kind: "record" }>, fillTarget: FillTarget): string {
  switch (tile.action) {
    case "select":
      return `выбрать кадр ${tile.slot ?? ""}`;
    case "fill":
      return fillTarget === null ? "в ячейку" : `в ячейку ${fillTarget.cell + 1} кадра ${fillTarget.clip + 1}`;
    case "append":
      return "добавить кадр в конец ролика";
    case "full":
      return "кадров больше не добавить";
    case "too-short":
      return `короче ${secondsLabel(MIN_CLIP_MS)}, в ролик не поставить`;
  }
}

/** A photo or video tile's accessible name: what it is, where it stands, and what a click does («…: добавить кадр в конец ролика»). */
export function visualAria(tile: Extract<VisualTile, { kind: "record" }>, fillTarget: FillTarget): string {
  return `${visualName(tile)}: ${actionWords(tile, fillTarget)}`;
}

/** The line under the photos and videos: what a click does now (the «Фото» tab's `binHint`, for own files). */
export function mineHint(fillTarget: FillTarget, addBlock: AddRefusal | null): string {
  const drag = "Перетащите на «Кадры», чтобы вставить между кадрами.";
  if (fillTarget !== null) return `Клик — фото в ячейку ${fillTarget.cell + 1} кадра ${fillTarget.clip + 1}, видео — в конец. ${drag}`;
  if (addBlock !== null) return addBlockedLabel(addBlock);
  return `Клик — кадр в конец ролика. ${drag}`;
}

/** A tile's tooltip: what a click does, with how much of a video goes in (AM7: from its start, up to 2 s). */
export function visualTitle(tile: Extract<VisualTile, { kind: "record" }>): string {
  switch (tile.action) {
    case "select":
      return `Уже в кадре ${tile.slot ?? ""} — клик выберет его`;
    case "fill":
      return "Клик — в выбранную ячейку";
    case "append":
      return tile.media.kind === "video" ? `Клик — видео с начала, до 2${NBSP}с, в конец ролика` : "Клик — кадр в конец ролика";
    case "full":
      return "Кадров больше не добавить";
    case "too-short":
      return `Видео короче ${secondsLabel(MIN_CLIP_MS)} — в ролик не поставить`;
  }
}

/** A track row's second line: «0:42 · свой трек», «0:42 · ✓ в ролике», «0:05 · короче ролика». */
export function trackRowNote(row: Extract<TrackTile, { kind: "record" }>): string {
  const length = lengthClock(row.media.durationMs ?? 0);
  return `${length} · ${row.inDraft ? "✓ в ролике" : row.tooShort ? "короче ролика" : "свой трек"}`;
}

/** A track row's accessible name, with why a short one cannot be chosen. */
export function trackRowAria(row: Extract<TrackTile, { kind: "record" }>, montageMs: number): string {
  const parts = [row.media.name, lengthClock(row.media.durationMs ?? 0), "свой трек"];
  if (row.inDraft) parts.push("в ролике");
  else if (row.tooShort) parts.push(`короче ролика (${secondsLabel(montageMs)}), не выбрать`);
  return parts.join(", ");
}

/** A sticker tile's accessible name: «Стикер underline.gif: в плейхед, в ролике 2, у выбранного слоя». */
export function stickerAria(tile: Extract<StickerTile, { kind: "record" }>): string {
  return `${KIND_WORD.sticker} ${tile.media.name}: в плейхед${tile.uses > 0 ? `, в ролике ${tile.uses}` : ""}${tile.on ? ", у выбранного слоя" : ""}`;
}

/** The word on a tile whose import is on its way (M6): «в очереди», «40 %», «отменяем». */
export function importTileLabel(view: ImportView): string {
  if (view.cancelRequested) return "отменяем";
  if (view.status === "queued") return "в очереди";
  return `${importPercent(view)}${NBSP}%`;
}

/** «60», «59.94»: a frame rate as the owner knows it (two decimals at most, no trailing zeros). */
const fpsText = (fps: number): string => String(Math.round(fps * 100) / 100);

/**
 * The status card of the import that runs now (M14), under the drop zone: «Копируем street-walk.mp4 · 40 %», or while a video is
 * prepared, «Готовим street-walk.mp4 · HDR → SDR, 60 → 30 fps · 40 %» (only what the engine says it changes), and how many more wait.
 */
export function importCard(view: ImportView, queued: number): { title: string; detail: string; percent: number } {
  const percent = importPercent(view);
  if (view.cancelRequested) return { title: `Отменяем ${view.name}`, detail: "ничего не сохранится", percent };
  const changes: string[] = [];
  if (view.stage === "prepare" && view.prepare !== null) {
    if (view.prepare.hdrToSdr) changes.push("HDR → SDR");
    if (view.prepare.fromFps !== null) changes.push(`${fpsText(view.prepare.fromFps)} → ${FPS}${NBSP}fps`);
  }
  const parts = [...(changes.length > 0 ? [changes.join(", ")] : []), `${percent}${NBSP}%`, ...(queued > 0 ? [`ещё ${queued} в очереди`] : [])];
  return { title: `${view.stage === "prepare" ? "Готовим" : "Копируем"} ${view.name}`, detail: parts.join(" · "), percent };
}

/**
 * What a finished import has to tell, or null: a refusal inside the job in the KIND's words (`mediaReasonRu(reason, kind)`), another
 * failure by its error, a cancel the engine made on its own. The owner's own cancel tells nothing.
 */
export function importFailure(view: ImportView): { title: string; body: string } | null {
  if (view.status === "failed" && view.error !== null) {
    const { error } = view;
    if (error.code === "MEDIA_UNSUPPORTED" && error.mediaReason !== undefined) return { title: `${view.name} не подходит`, body: mediaReasonRu(error.mediaReason, view.mediaKind) };
    return { title: `Не удалось добавить ${view.name}`, body: errorText(error) };
  }
  if (view.status === "cancelled" && !view.cancelRequested) return { title: `${view.name} не добавлен`, body: mediaReasonRu("cancelled", view.mediaKind) };
  return null;
}

/** What a pick answered (`media.pickImport`, K29): the jobs started, the files refused by name and reason, and the ones never looked at. */
export interface PickOutcome {
  readonly jobIds: readonly string[];
  readonly refused: readonly MediaRefusal[];
  readonly skipped: number;
}

const FILE_FORMS = ["файл", "файла", "файлов"] as const;

/** What became of the accepted files of a pick, as the imports say now. A job this window no longer knows is not counted as added. */
function restOf(jobIds: readonly string[], imports: readonly ImportView[]): string | null {
  const n = jobIds.length;
  if (n === 0) return null;
  const views = jobIds.map((id) => imports.find((v) => v.jobId === id));
  const active = views.filter((v) => v !== undefined && isActiveImport(v)).length;
  const added = views.filter((v) => v?.status === "done").length;
  if (active > 0) return n === 1 ? "Другой файл добавляем." : `Остальные ${countOf(n, FILE_FORMS)} добавляем.`;
  if (added === n) return n === 1 ? "Другой файл добавлен." : `Остальные ${countOf(n, FILE_FORMS)} добавлены.`;
  return n === 1 ? "Другой файл не добавлен." : `Из остальных ${n} добавлено: ${added}.`;
}

/**
 * The result card of a pick (M15): «track.wma не подходит» with its reason, several refused by name, and the files never looked at
 * (`skipped`, all of them over the 20 a pick takes): said, never dropped. The pick's refusals carry no kind, so their reason is the
 * neutral text. Null when nothing was refused or skipped (the tiles show the rest).
 */
export function pickOutcomeText(outcome: PickOutcome, imports: readonly ImportView[]): { title: string; lines: string[]; rest: string | null } | null {
  const { refused, skipped } = outcome;
  if (refused.length === 0 && skipped === 0) return null;
  const [first] = refused;
  const single = refused.length === 1 && skipped === 0 && first !== undefined;
  const title = single ? `${first.name} не подходит` : `${countOf(refused.length + skipped, FILE_FORMS)} не добавлено`;
  const lines = single ? [mediaReasonRu(first.reason)] : refused.map((r) => `${r.name}: ${afterColon(mediaReasonRu(r.reason))}`);
  if (skipped > 0) lines.push(`Ещё ${countOf(skipped, FILE_FORMS)} не ${plural(skipped, ["просмотрен", "просмотрены", "просмотрены"])}. ${mediaReasonRu("too-many")}`);
  return { title, lines, rest: restOf(outcome.jobIds, imports) };
}

/** The confirmation before a file is deleted: what goes (the copy in Studio, never the owner's original), and what this montage loses. */
export function deleteConfirmText(media: MediaSummary, spec: MontageDraft): { title: string; body: string } {
  const head = "Удалится копия в Studio, ваш исходный файл останется.";
  let here = "";
  if (media.kind === "photo" || media.kind === "video") {
    const slot = ownSlots(spec).get(media.mediaId);
    if (slot !== undefined) here = ` В этом ролике он в кадре ${slot} — кадр будет помечен, пока его не замените.`;
  } else if (media.kind === "audio") {
    if (spec.music?.source === "own" && spec.music.mediaId === media.mediaId) here = " Это музыка ролика — она будет помечена, пока её не замените.";
  } else {
    const uses = spec.layers.filter((l) => l.kind === "sticker" && l.sticker.source === "own" && l.sticker.mediaId === media.mediaId).length;
    if (uses > 0) here = ` В ролике он стоит ${countOf(uses, ["раз", "раза", "раз"])} — ${uses === 1 ? "слой будет помечен" : "слои будут помечены"}, пока его не замените.`;
  }
  return { title: `Удалить «${media.name}»?`, body: `${head}${here}` };
}

/** Why `media.delete` refused, said honestly: a file a render uses is not deleted (IN_FLIGHT); one already gone; anything else by its error. */
export function deleteRefusalText(error: EngineError, name: string): string {
  if (error.code === "IN_FLIGHT") return `«${name}» используется в рендере — его нельзя удалить, пока рендер не закончится. Ничего не удалено.`;
  if (error.code === "NOT_FOUND") return `«${name}» уже нет в библиотеке.`;
  return errorText(error);
}

/** One track plays at a time (M9): a row starts its own (stopping another); the same row again stops it. */
export function nextListening(current: string | null, mediaId: string): string | null {
  return current === mediaId ? null : mediaId;
}

// ---------- a drag out of the panel ----------

/**
 * What a drag out of the media panel carries to the timeline («Кадры») and the preview's empty cells: a scene photo (the «Фото» tab's,
 * by its id), or an own photo or video (3f.6; a video with its stored length, to size its clip). The timeline and the preview pass the
 * key back untouched; the editor reads it here.
 */
export type BinDrag =
  | { readonly source: "scene"; readonly photoId: string }
  | { readonly source: "own"; readonly kind: "photo"; readonly mediaId: string }
  | { readonly source: "own"; readonly kind: "video"; readonly mediaId: string; readonly durationMs: number };

/** The drag's key: a scene photo's id as it is (an `Id` has no colon), an own file as `own-photo:<id>` / `own-video:<id>:<ms>`. */
export function dragKey(drag: BinDrag): string {
  if (drag.source === "scene") return drag.photoId;
  return drag.kind === "photo" ? `own-photo:${drag.mediaId}` : `own-video:${drag.mediaId}:${drag.durationMs}`;
}

/** The drag a key names, or null for one that is not ours. */
export function parseDragKey(key: string): BinDrag | null {
  const parts = key.split(":");
  const [head, id, ms] = parts;
  if (parts.length === 1 && head !== undefined && Id.safeParse(head).success) return { source: "scene", photoId: head };
  if (head === "own-photo" && parts.length === 2 && id !== undefined && Id.safeParse(id).success) return { source: "own", kind: "photo", mediaId: id };
  if (head === "own-video" && parts.length === 3 && id !== undefined && Id.safeParse(id).success && ms !== undefined && /^\d{1,9}$/.test(ms)) {
    return { source: "own", kind: "video", mediaId: id, durationMs: Number(ms) };
  }
  return null;
}
