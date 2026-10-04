import { Id, MAX_LISTED_MEDIA, MAX_PICKED_FILES, type EngineError, type MediaKind, type MediaRefusal, type MediaSummary, type MontageDraft, mediaReasonRu } from "../../../shared/engine";
import { FPS, MIN_CLIP_MS } from "../../../shared/montage";
import type { Scheduler } from "../../engine/scheduler";
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

export type TrackTile =
  | {
      readonly kind: "record";
      readonly media: MediaSummary;
      readonly inDraft: boolean;
      /** Shorter than the montage: from its start for a track not in it, from the montage's own start for the montage's track (round 1, L4). */
      readonly tooShort: boolean;
      /** A click on it does something: any track not too short, and the montage's own track always (it selects the music, whose start can move). */
      readonly pickable: boolean;
    }
  | { readonly kind: "import"; readonly view: ImportView };

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
  const ownTrack = spec.music?.source === "own" ? spec.music : null;
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
    ...library.media
      .filter((m) => m.kind === "audio")
      .map((media): TrackTile => {
        const inDraft = media.mediaId === ownTrack?.mediaId;
        // The montage's own track is judged from where it starts (the engine's `track-too-short`); another from 0, where a pick puts it.
        const tooShort = ownTrackTooShort({ durationMs: (media.durationMs ?? 0) - (inDraft ? (ownTrack?.startMs ?? 0) : 0) }, total);
        return { kind: "record", media, inDraft, tooShort, pickable: inDraft || !tooShort };
      }),
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

/** A track row's second line: «0:42 · свой трек», «0:42 · ✓ в ролике», «0:05 · короче ролика», «0:42 · ✓ в ролике · короче ролика». */
export function trackRowNote(row: Extract<TrackTile, { kind: "record" }>): string {
  const length = lengthClock(row.media.durationMs ?? 0);
  if (row.inDraft) return `${length} · ✓ в ролике${row.tooShort ? " · короче ролика" : ""}`;
  return `${length} · ${row.tooShort ? "короче ролика" : "свой трек"}`;
}

/** A track row's accessible name, with why a short one cannot be chosen, or what to do when the montage's own track runs out (L4). */
export function trackRowAria(row: Extract<TrackTile, { kind: "record" }>, montageMs: number): string {
  const parts = [row.media.name, lengthClock(row.media.durationMs ?? 0), "свой трек"];
  if (row.inDraft) {
    parts.push("в ролике");
    if (row.tooShort) parts.push(`короче ролика (${secondsLabel(montageMs)}) с этого начала: сдвиньте начало трека раньше или укоротите ролик`);
  } else if (row.tooShort) parts.push(`короче ролика (${secondsLabel(montageMs)}), не выбрать`);
  return parts.join(", ");
}

/** A track row's tooltip: what a click does, or why it does nothing. */
export function trackRowTitle(row: Extract<TrackTile, { kind: "record" }>): string {
  if (row.inDraft) return row.tooShort ? "Трек короче ролика с этого начала — клик откроет музыку: сдвиньте начало раньше или укоротите ролик" : "Этот трек уже в ролике — клик откроет музыку";
  return row.tooShort ? "Трек короче ролика — его не выбрать" : "Клик — трек в ролик, с начала";
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

// ---------- video posters (round 1, M1) ----------

/**
 * The most video tiles that hold a live `<video>` at once. Measured in Electron 43 (the round 1 review): a `<video>` per tile costs the renderer
 * about 8 MB each (50 tiles 422 MB, 300 tiles 827 MB), and a detached player lingers until it is collected. The rest draw the film placeholder.
 */
export const MAX_LIVE_POSTERS = 24;

/**
 * The video tiles that hold a live poster (round 2): EVERY visible tile (`visible`), even past the cap, since a blank tile in view is a bug; then
 * the tiles in the margins (`near`), nearest to the visible ones first (by their places in the list; the list's order breaks a tie), until `cap`.
 * With nothing visible yet, the margins alone, from the top of the list.
 */
export function livePosters(order: readonly string[], visible: ReadonlySet<string>, near: ReadonlySet<string>, cap: number): ReadonlySet<string> {
  const live = new Set(order.filter((id) => visible.has(id)));
  const seen = order.flatMap((id, i) => (visible.has(id) ? [i] : []));
  const first = seen[0] ?? 0;
  const last = seen.at(-1) ?? 0;
  const distance = (i: number): number => (seen.length === 0 ? i : i < first ? first - i : i > last ? i - last : 0);
  const margin = order.flatMap((id, i) => (near.has(id) && !visible.has(id) ? [{ id, i }] : [])).sort((a, b) => distance(a.i) - distance(b.i) || a.i - b.i);
  for (const { id } of margin) {
    if (live.size >= cap) break;
    live.add(id);
  }
  return live;
}

/** How long the poster zones wait after applying a report before they apply the next (round 2): a fast scroll does not churn players. */
export const POSTER_REPORT_MS = 150;

/** One observer's word on one tile: inside its zone or not. */
export interface ZoneEntry {
  readonly id: string;
  readonly isIntersecting: boolean;
}

/**
 * The two zones the poster observers report (round 2): `visible` (the tab's own view) and `near` (a screen of margin around it). The reports of
 * one tick land together at once (a microtask); after that, the reports of the next `POSTER_REPORT_MS` wait and land once, as the latest state, at
 * its end, so a fast scroll mounts and drops players at most every 150 ms rather than on every frame.
 */
export class PosterZones {
  readonly #scheduler: Scheduler;
  readonly #apply: (visible: ReadonlySet<string>, near: ReadonlySet<string>) => void;
  readonly #visible = new Set<string>();
  readonly #near = new Set<string>();
  #queued = false;
  #cooling = false;
  #dirty = false;
  #disposed = false;
  #cancel: () => void = () => undefined;

  constructor(scheduler: Scheduler, apply: (visible: ReadonlySet<string>, near: ReadonlySet<string>) => void) {
    this.#scheduler = scheduler;
    this.#apply = apply;
  }

  report(zone: "visible" | "near", entries: readonly ZoneEntry[]): void {
    if (this.#disposed) return;
    const set = zone === "visible" ? this.#visible : this.#near;
    for (const entry of entries) {
      if (entry.isIntersecting) set.add(entry.id);
      else set.delete(entry.id);
    }
    if (this.#cooling) {
      this.#dirty = true;
      return;
    }
    if (this.#queued) return;
    this.#queued = true;
    queueMicrotask(() => {
      this.#queued = false;
      this.#flush();
    });
  }

  #flush(): void {
    if (this.#disposed) return;
    this.#dirty = false;
    this.#apply(new Set(this.#visible), new Set(this.#near));
    this.#cooling = true;
    this.#cancel = this.#scheduler.schedule(POSTER_REPORT_MS, () => {
      this.#cooling = false;
      if (this.#dirty) this.#flush();
    });
  }

  dispose(): void {
    this.#disposed = true;
    this.#cancel();
  }
}

// ---------- files dropped from Finder or Explorer (M13, round 2) ----------

/** A drag carries files (Finder, Explorer), not text or a link from a page. */
export function isFileDrag(types: readonly string[]): boolean {
  return types.includes("Files");
}

/** What the kinds the zone takes are called on it, in its order, for a count of each («2 фото, 1 видео, 2 трека, 1 стикер»). */
const DROP_KINDS: readonly { kind: MediaKind; forms: readonly [string, string, string] }[] = [
  { kind: "photo", forms: ["фото", "фото", "фото"] },
  { kind: "video", forms: ["видео", "видео", "видео"] },
  { kind: "audio", forms: ["трек", "трека", "треков"] },
  { kind: "sticker", forms: ["стикер", "стикера", "стикеров"] },
];

/** The kind a dragged item's type says (only a guess for the zone's words: the engine reads the bytes); null when it cannot tell. */
function kindOfType(type: string): MediaKind | null {
  if (type === "image/gif") return "sticker";
  if (type.startsWith("image/")) return "photo";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  return null;
}

/**
 * The drop zone while files are dragged over it (M13: «Отпустите — добавим 3 файла · 2 фото, 1 видео»). During a drag only the items' kinds
 * and types are known: counted by type when every one says it, else the kinds the zone takes; over 20, only 20 go in. Null for a drag
 * that holds no file.
 */
export function dropSummary(items: readonly { readonly kind: string; readonly type: string }[]): { count: number; title: string; detail: string } | null {
  const files = items.filter((item) => item.kind === "file");
  const count = files.length;
  if (count === 0) return null;
  if (count > MAX_PICKED_FILES) return { count, title: `Отпустите — добавим ${MAX_PICKED_FILES} из ${countOf(count, FILE_FORMS)}`, detail: `за раз — не больше ${MAX_PICKED_FILES}, остальные не добавятся` };
  const title = `Отпустите — добавим ${countOf(count, FILE_FORMS)}`;
  const kinds = files.map((item) => kindOfType(item.type));
  if (kinds.some((kind) => kind === null)) return { count, title, detail: "фото, видео, музыка, стикеры" };
  const parts = DROP_KINDS.flatMap(({ kind, forms }) => {
    const n = kinds.filter((k) => k === kind).length;
    return n === 0 ? [] : [`${n} ${plural(n, forms)}`];
  });
  return { count, title, detail: parts.join(", ") };
}

/** The part of a drag event the window-wide guard reads and sets. */
export interface FileDragEvent {
  readonly defaultPrevented: boolean;
  readonly dataTransfer: { readonly types: readonly string[]; dropEffect: string } | null;
  preventDefault(): void;
}

/**
 * The window's own guard against files dropped anywhere but the drop zone (`dragover` and `drop` on the window): the browser's default (open the
 * file) is prevented and the cursor says no. A drag the zone took (it prevented the default first) and a drag that holds no file are left alone.
 */
export function guardFileDrop(event: FileDragEvent): void {
  const transfer = event.dataTransfer;
  if (event.defaultPrevented || transfer === null || !isFileDrag(transfer.types)) return;
  event.preventDefault();
  transfer.dropEffect = "none";
}

/** Whether an event carries a drag's transfer the guard can read (a `DragEvent`, or a test's stand-in). */
function isFileDragEvent(event: Event): event is Event & FileDragEvent {
  const transfer: unknown = Reflect.get(event, "dataTransfer");
  return transfer === null || (typeof transfer === "object" && transfer !== null && "types" in transfer && "dropEffect" in transfer);
}

/** Puts `guardFileDrop` on the window's `dragover` and `drop` (main.tsx); returns the function that takes it off. */
export function installFileDropGuard(target: Pick<EventTarget, "addEventListener" | "removeEventListener">): () => void {
  const guard = (event: Event): void => {
    if (isFileDragEvent(event)) guardFileDrop(event);
  };
  target.addEventListener("dragover", guard);
  target.addEventListener("drop", guard);
  return () => {
    target.removeEventListener("dragover", guard);
    target.removeEventListener("drop", guard);
  };
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
