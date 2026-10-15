import { CLIP_REASONS_RU, type ClipSummary, type EngineError, type MediaOrigin, mediaReasonRu, type MontageDraft, type PhotoSummary } from "../../../shared/engine";
import { errorText } from "../../lib/errors";
import { NBSP } from "../../lib/format";
import { photoCategoryLabel } from "../photos/runForm";
import { clipLength, readyTags } from "../clips/clipModel";
import { type AddRefusal, framesKnown, type OriginOf, type Refusal, scenePhotoIds } from "./clipOps";
import { actionWhyLabel, FRAMES_FAILED_TEXT, FRAMES_UNKNOWN_TITLE, VIDEO_TAG_TEXTS } from "./labels";
import type { FillTarget } from "./mine";

// 5b.2 part A (S5.WA4; plan §5.1, I5.59, I5.60; mockups 57–57d, README §S5.WAD «Состояния», «Тексты»): the editor's «Клипы» tab as pure data. The draft
// avatar's READY clips, in the list's order (newest first), each with the state its frame allows under Q-F = 1 (a photo and every clip made from it are one
// frame): its copy is a kadr of this draft (`placed`, a click selects it); its copy is being made (`busy`, «Готовим для монтажа…», an import job read from
// the job list); taken — the clip itself or its frame is in a finished video (`use.inVideo`), its photo is rejected or in a render, the photo or a sibling
// clip is a kadr of this draft; this window met a file that will not prepare (`damaged`) or a try that failed (`failed`, pressable again); else `free`.
// S5.WA4 round 2: the photo is taken too when the engine would refuse it (not eligible, or gone while every page of the photos is read: review M1), and a
// clip that would be free waits (`unknown`) while a video of the draft is not known yet, since it may be a copy of this frame (review M3: fail closed).
// A tile is called by its motion, its length and «Фото N» — the «Фото» tab's number — or, for a photo with none, its category.

type Ready = Extract<ClipSummary, { status: "ready" }>;

/** Why a frame is taken (57b; `photo-gone` and `ineligible`: S5.WA4 round 2), in the order the tile tells them. */
export type TakenWhy = "used-clip" | "used-photo" | "photo-gone" | "rejected" | "ineligible" | "reserved" | "photo-in" | "sibling-in";

export type ClipTileState =
  | { readonly kind: "free" }
  | { readonly kind: "placed"; readonly slot: number }
  | { readonly kind: "busy" }
  | { readonly kind: "failed" }
  | { readonly kind: "damaged" }
  | { readonly kind: "taken"; readonly why: TakenWhy }
  /** A video of the draft is not known yet: this clip may not be placed until it is (fail closed); `failed`: its read failed (round 3). */
  | { readonly kind: "unknown"; readonly failed?: true };

export interface ClipTile {
  readonly clip: Ready;
  readonly state: ClipTileState;
  /** «Фото N» by the bin's numbering, the photo's category when it has no number, null when the photo is not among those read. */
  readonly source: string | null;
  /** «0:05», «0:10». */
  readonly length: string;
  /** 5b.1's pills beside the length: «Grok», «1080p». */
  readonly tags: readonly string[];
}

export interface ClipTilesInput {
  /** `clips.list` of the draft's avatar. */
  readonly clips: readonly ClipSummary[];
  readonly spec: MontageDraft;
  /** Which of the draft's own videos are clip copies (their records' `origin`). */
  readonly originOf: OriginOf;
  /** The avatar's photos read so far, by id; null until the first answer. */
  readonly photos: ReadonlyMap<string, PhotoSummary> | null;
  /** Every page of the avatar's photos is read: a photo `photos` does not hold is gone (a ready clip outlives its photo). */
  readonly photosComplete: boolean;
  /** The clips whose copy is on its way: an import job of theirs is queued or running, or this window's ask is out. */
  readonly busy: ReadonlySet<string>;
  /** What this window met when it last tried a clip: a failure to tell (`failed`), or a file that will not prepare (`damaged`). */
  readonly failed: ReadonlyMap<string, "failed" | "damaged">;
  /** Round 3: the read of the draft's videos failed (a video not known is then not «being read»: it is tried again). */
  readonly framesFailed?: boolean;
}

/** «Фото N»: each eligible photo's place among the bin's photos, as `binTiles` numbers them (the list's order). */
export function binNumbers(photos: readonly PhotoSummary[]): ReadonlyMap<string, number> {
  return new Map(photos.filter((photo) => photo.eligible).map((photo, i) => [photo.photoId, i + 1]));
}

/** The kadr each clip's copy stands at in the draft (its first), by clip id; and the clip of each copy's frame. */
function copiesIn(spec: MontageDraft, originOf: OriginOf): { slots: ReadonlyMap<string, number>; framed: ReadonlyMap<string, string> } {
  const slots = new Map<string, number>();
  const framed = new Map<string, string>();
  spec.clips.forEach((clip, i) => {
    if (clip.kind !== "video") return;
    const origin = originOf(clip.mediaId);
    if (origin === undefined || origin === null) return;
    if (!slots.has(origin.clipId)) slots.set(origin.clipId, i + 1);
    if (!framed.has(origin.photoId)) framed.set(origin.photoId, origin.clipId);
  });
  return { slots, framed };
}

/** The tiles: the ready clips in the list's order, each with its state, its photo's name, its length and its pills. */
export function clipTiles(input: ClipTilesInput): ClipTile[] {
  const { clips, spec, originOf, photos, busy, failed } = input;
  const { slots, framed } = copiesIn(spec, originOf);
  const known = framesKnown(spec, originOf);
  const complete = photos !== null && input.photosComplete;
  const scenes = scenePhotoIds(spec);
  const numbers = photos === null ? new Map<string, number>() : binNumbers([...photos.values()]);
  const ready = clips.filter((clip): clip is Ready => clip.status === "ready");
  return ready.map((clip): ClipTile => {
    const photo = photos?.get(clip.photoId);
    const n = numbers.get(clip.photoId);
    const source = n !== undefined ? `Фото ${n}` : photo !== undefined ? photoCategoryLabel(photo) : null;
    const state = stateOf(clip, photo, { slots, framed, scenes, busy, failed, known, complete });
    return { clip, state: state.kind === "unknown" && input.framesFailed === true ? { kind: "unknown", failed: true } : state, source, length: clipLength(clip.durationMs), tags: readyTags(clip) };
  });
}

function stateOf(
  clip: Ready,
  photo: PhotoSummary | undefined,
  draft: {
    slots: ReadonlyMap<string, number>;
    framed: ReadonlyMap<string, string>;
    scenes: ReadonlySet<string>;
    busy: ReadonlySet<string>;
    failed: ReadonlyMap<string, "failed" | "damaged">;
    known: boolean;
    complete: boolean;
  },
): ClipTileState {
  const slot = draft.slots.get(clip.clipId);
  if (slot !== undefined) return { kind: "placed", slot };
  if (draft.busy.has(clip.clipId)) return { kind: "busy" };
  const why = takenWhy(clip, photo, draft);
  if (why !== null) return { kind: "taken", why };
  const met = draft.failed.get(clip.clipId);
  if (met === "damaged") return { kind: "damaged" };
  // A video of the draft not known yet may be a copy of this very frame: nothing is placed until it is (fail closed).
  if (!draft.known) return { kind: "unknown" };
  return met === undefined ? { kind: "free" } : { kind: met };
}

function takenWhy(clip: Ready, photo: PhotoSummary | undefined, draft: { framed: ReadonlyMap<string, string>; scenes: ReadonlySet<string>; complete: boolean }): TakenWhy | null {
  // The clip list says how a finished video uses the frame; a photo the photo list already calls used marks its clips too, before the clips are read again.
  const inVideo = clip.use?.inVideo ?? (photo !== undefined && (photo.used || photo.usedIn.length > 0) ? "photo" : undefined);
  if (inVideo === "clip") return "used-clip";
  if (inVideo === "photo") return "used-photo";
  // The engine admits only an eligible, unused photo's frame (`eligibleUnusedPhotos`): a photo gone (a ready clip outlives it) or not eligible is refused.
  if (photo === undefined && draft.complete) return "photo-gone";
  if (photo?.rejected === true) return "rejected";
  if (photo !== undefined && !photo.eligible) return "ineligible";
  if (photo?.reserved === true) return "reserved";
  if (draft.scenes.has(clip.photoId)) return "photo-in";
  const sibling = draft.framed.get(clip.photoId);
  if (sibling !== undefined && sibling !== clip.clipId) return "sibling-in";
  return null;
}

// ---------- words ----------

/** «Готовим для монтажа…» (§6 57a): the tile's one live line while its copy is made. */
export const PREPARING = "Готовим для монтажа…";

/** S5.WAR: the tab's live region — a clip being prepared, after a colon (lowercase), and where a clip just went. */
export const preparingNews = (motion: string): string => `Клип «${motion}»: готовим для монтажа…`;
export const placedNews = (motion: string, slot: number): string => `Клип «${motion}» — в кадре ${slot}`;

/** The state's words at the tile's head (57b) and on its `li`. */
export const TAKEN_LABELS: Record<TakenWhy, string> = {
  "used-clip": "в видео",
  "used-photo": "в видео",
  "photo-gone": "фото не найдено",
  rejected: "фото отклонено",
  ineligible: "фото не подходит",
  reserved: "в рендере",
  "photo-in": "это фото уже в ролике",
  "sibling-in": "клип этого фото уже в ролике",
};

/** Which taken states are a band (their words do not fit the bin's pill). */
export const TAKEN_BAND: ReadonlySet<TakenWhy> = new Set<TakenWhy>(["photo-in", "sibling-in"]);

/** The titles, capitalised (README L9); a frame held by a render has none, as the bin's «в рендере». */
const TAKEN_TITLES: Record<TakenWhy, string | null> = {
  "used-clip": "Этот клип уже в готовом видео — второй раз не ставится",
  "used-photo": "Это фото или другой его клип уже в готовом видео — кадр второй раз не ставится",
  "photo-gone": "Фото этого клипа нет в галерее — в монтаж не ставится",
  rejected: "Фото этого клипа отклонено — в монтаж не ставится",
  ineligible: "Фото этого клипа не подходит — в монтаж не ставится",
  reserved: null,
  "photo-in": "Это фото уже в ролике",
  "sibling-in": "Клип этого фото уже в ролике",
};

/** Round 3: the state and the action of a clip that waits after the read of the draft's videos failed. */
export const FAILED_WORDS = "не удалось прочитать видео в кадрах";

/** S5.WAR M3: why nothing can be added now: the draft's videos are being read, or their read failed; null when they are known. */
export type FramesWait = "reading" | "failed" | null;

/** S5.WAR M3: the action of a clip or a photo that waits while the draft's videos are read. */
export const WAIT_WORDS = "подождите, читаем видео в кадрах";

/** «Клип «Поправляет прядь», 0:05»: what a tile is. */
const clipName = (tile: ClipTile): string => `Клип «${tile.clip.motion.label}», ${tile.length}`;

function stateWords(state: ClipTileState): string {
  switch (state.kind) {
    case "placed":
      return `в кадре ${state.slot}`;
    case "busy":
      return PREPARING;
    case "damaged":
      return "файл повреждён";
    case "taken":
      return TAKEN_LABELS[state.why];
    case "unknown":
      return state.failed === true ? FAILED_WORDS : "читаем видео в кадрах";
    case "failed":
    case "free":
      return "не использован";
  }
}

/** The `li`'s name, the state on it (README L5): «Клип «<движение>», 0:05, Фото N · <состояние>». */
export function clipTileAria(tile: ClipTile): string {
  return `${clipName(tile)}${tile.source === null ? "" : `, ${tile.source}`} · ${stateWords(tile.state)}`;
}

/**
 * What a click does now: select the placed clip's kadr; nothing for a taken frame or a damaged file, nor while a video of the draft is not known (`wait`);
 * else a kadr at the end, unless no kadr fits.
 */
export type ClipAction = "select" | "taken" | "damaged" | "wait" | "full" | "append";

export function clipAction(tile: ClipTile, addBlock: AddRefusal | null): ClipAction {
  switch (tile.state.kind) {
    case "placed":
      return "select";
    case "taken":
      return "taken";
    case "damaged":
      return "damaged";
    case "unknown":
      return "wait";
    default:
      return addBlock === null ? "append" : "full";
  }
}

/** The button's name, what a click does (README L5): «…: добавить кадр в конец ролика», «…: выбрать кадр 3», «…: уже занято», «…: не подготовить». */
export function pickAria(tile: ClipTile, addBlock: AddRefusal | null): string {
  const action = clipAction(tile, addBlock);
  const words =
    tile.state.kind === "busy"
      ? // S5.WAR L4: what is going on, not what a click would do.
        "готовим для монтажа"
      : action === "select" && tile.state.kind === "placed"
      ? `выбрать кадр ${tile.state.slot}`
      : action === "taken"
        ? "уже занято"
        : action === "damaged"
          ? "не подготовить"
          : action === "wait"
            ? tile.state.kind === "unknown" && tile.state.failed === true
              ? FAILED_WORDS
              : WAIT_WORDS
            : action === "full"
            ? "кадров больше не добавить"
            : "добавить кадр в конец ролика";
  return `${clipName(tile)}: ${words}`;
}

/** The tile's title: «Мои»'s for a video (`visualTitle`), the frame's reason when taken, the preparation's or the damage's words. */
export function clipTileTitle(tile: ClipTile, addBlock: AddRefusal | null): string | null {
  const { state } = tile;
  switch (state.kind) {
    case "placed":
      return `Уже в кадре ${state.slot} — клик выберет его`;
    case "taken":
      return TAKEN_TITLES[state.why];
    case "busy":
      return PREPARING;
    case "damaged":
      return CLIP_REASONS_RU["file-damaged"];
    case "unknown":
      return state.failed === true ? FRAMES_FAILED_TEXT : FRAMES_UNKNOWN_TITLE;
    default:
      return addBlock === null ? `Клик — видео с начала, до 2${NBSP}с, в конец ролика` : "Кадров больше не добавить";
  }
}

/**
 * The line under the tiles (57; `#cell`, `#full`): «Мои»'s hint for a video; with a collage cell chosen, a clip still goes to the end; at the caps, the
 * bin's words said of a clip (the 15 s one ends «…чтобы добавить клип», WAD re-review N5).
 */
export function clipsHint(fillTarget: FillTarget, addBlock: AddRefusal | null, frames: FramesWait = null): string {
  // S5.WAR M3: while the draft's videos are read (or after the read failed) nothing can be added: the line says that.
  if (frames === "reading") return FRAMES_UNKNOWN_TITLE;
  if (frames === "failed") return FRAMES_FAILED_TEXT;
  const drag = "Перетащите на «Кадры», чтобы вставить между кадрами.";
  if (addBlock === "clip-cap") return "Не больше 20 кадров в одном видео. Клик по клипу в панели ничего не добавит.";
  if (addBlock === "no-room") return "В ролике уже 15 с: на новый кадр нет места. Укоротите кадр, чтобы добавить клип.";
  if (fillTarget !== null) return `Клик — клип в конец ролика, в ячейку коллажа — только фото. ${drag}`;
  return `Клик — кадр в конец ролика. ${drag}`;
}

/** A clip's copy as the draft calls it (57f; README M6): its clip's motion and its photo, never the copy's file name. */
export interface CopyLabel {
  readonly origin: MediaOrigin;
  /** The clip's motion; null while the clip list is not read (or no longer holds the clip). */
  readonly motion: string | null;
  /** «Фото N», or the photo's category; null while the photo is not among those read. */
  readonly source: string | null;
}

/** Whether an own video is a clip's copy, and what to call it; null for the owner's own video. */
export type CopyOf = (mediaId: string) => CopyLabel | null;

export function copyLabeller(originOf: OriginOf, clips: readonly ClipSummary[] | null, photos: ReadonlyMap<string, PhotoSummary> | null): CopyOf {
  const byId = new Map((clips ?? []).map((clip) => [clip.clipId, clip]));
  const numbers = photos === null ? new Map<string, number>() : binNumbers([...photos.values()]);
  return (mediaId) => {
    const origin = originOf(mediaId);
    if (origin === undefined || origin === null) return null;
    const n = numbers.get(origin.photoId);
    const photo = photos?.get(origin.photoId);
    return { origin, motion: byId.get(origin.clipId)?.motion.label ?? null, source: n !== undefined ? `Фото ${n}` : photo !== undefined ? photoCategoryLabel(photo) : null };
  };
}

/**
 * Why a copy did not go in where it was asked for (review L3: a deferred placement the draft no longer takes): the 57b words when its frame is in the draft
 * (the photo itself, or a sibling clip), the toolbar's cap words (`actionWhyLabel`), the wait while a video is not known, and the own video's too-short words.
 */
export function placementRefusalText(reason: Refusal, spec: MontageDraft, photoId: string): string {
  switch (reason) {
    case "photo-in-draft":
      return scenePhotoIds(spec).has(photoId) ? TAKEN_TITLES["photo-in"] ?? "" : TAKEN_TITLES["sibling-in"] ?? "";
    case "clip-cap":
    case "no-room":
      return actionWhyLabel(reason);
    case "frame-unknown":
      return FRAMES_UNKNOWN_TITLE;
    default:
      return VIDEO_TAG_TEXTS["video-under-min"];
  }
}

/** A no-break space before a dash, so a wrapped line never starts with «—» (README L3). */
const nbDash = (text: string): string => text.replace(/ — /g, `${NBSP}— `);

/**
 * What a refused preparation says (57c; README «57c — один текст на причину»): any importer failure is 57c's own line and the tile can be pressed again; a
 * full disk is the video's no-space text; the contract's `file-damaged` (the tile no longer pressable) and `job-running`; NOT_FOUND says nothing (the clip is
 * gone: its tile goes with the next list); anything else in the engine's own words.
 */
export function clipImportFailure(error: EngineError): { text: string; damaged: boolean } | null {
  if (error.code === "NOT_FOUND") return null;
  if (error.code === "VALIDATION" && error.clipReason === "file-damaged") return { text: nbDash(CLIP_REASONS_RU["file-damaged"]), damaged: true };
  if (error.code === "IN_FLIGHT" && error.clipReason === "job-running") return { text: nbDash(CLIP_REASONS_RU["job-running"]), damaged: false };
  if (error.code === "MEDIA_UNSUPPORTED" && error.mediaReason === "no-space") return { text: nbDash(mediaReasonRu("no-space", "video")), damaged: false };
  if (error.code === "INTERNAL" || error.code === "MEDIA_UNSUPPORTED") return { text: nbDash("Не удалось подготовить клип — файл в Studio цел. Попробуйте ещё раз."), damaged: false };
  return { text: nbDash(errorText(error)), damaged: false };
}
