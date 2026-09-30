import { MONTAGE_ISSUE_MESSAGES_RU, montageIssues, type ExportStatus, type MontageDraft, type MontageIssue, type MontageIssueCode, type PhotoSummary } from "../../../shared/engine";
import { notYetSupportedIssues } from "../../../shared/montage";
import { sameJson } from "./json";

// Why «Рендер» is disabled (3d.2 shows it; 3d.6 adds the queue and the job states). Only the FIRST reason is
// shown, left of the button, in the order of the reconciliation doc's 3d.6 checklist: the export folder, no
// clips, the length, an empty cell, an unusable photo (with its cells to highlight), a caption, a layer past the
// end, the track, a part whose slice has not landed. The structural half is judged here on the window's CURRENT
// spec (it answers at once, while the edit is still being saved); the referential half is the engine's verdict
// from `montages.get`, which judged the spec as last saved.

/** Why a scene photo cannot go into a video, from the photos list: one photo → one video (the owner, Q1). */
export type PhotoProblem = "used" | "reserved" | "rejected" | "unavailable";

/** `montages.get`'s answer: the spec it judged and its issues. */
export interface EngineVerdict {
  readonly spec: MontageDraft;
  readonly issues: readonly MontageIssue[];
}

export interface RenderBlockInput {
  /** The window's current spec. */
  readonly spec: MontageDraft;
  /** The export folder as the engine last reported it; null before the first snapshot (the render checks it anyway). */
  readonly exportStatus: ExportStatus | null;
  readonly avatarActive: boolean;
  readonly verdict: EngineVerdict | null;
  /** The avatar's photos by id (`photos.list`): why the engine refused one. Null until they are read. */
  readonly photos: ReadonlyMap<string, PhotoSummary> | null;
  /**
   * The video that holds the used photos: made from this very draft, or another one by its file name in «Готовые
   * видео» (the video's own title, K12, comes with 3e.2); null while unknown.
   */
  readonly usedVideo: UsedVideo | null;
}

export type UsedVideo = "this-draft" | { readonly file: string };

export interface RenderBlock {
  readonly text: string;
  /** The export folder is the reason: «· Настройки» follows the text. */
  readonly settings: boolean;
  /** Clip indexes the reason is about (the timeline highlights them, 3d.3a). */
  readonly clips?: readonly number[];
}

/** A cell of the current spec whose scene photo the engine refused. */
export interface FlaggedCell {
  readonly clip: number;
  /** 0 for a photo clip; the cell's index in a collage. */
  readonly cell: number;
  readonly photoId: string;
  readonly problem: PhotoProblem;
  /** The video holding it, for a used photo. */
  readonly videoId?: string;
}

/** Walks the scene photos of `spec` in timeline order. */
function forEachScenePhoto(spec: MontageDraft, visit: (photoId: string, clip: number, cell: number) => void): void {
  spec.clips.forEach((clip, i) => {
    if (clip.kind === "photo") {
      if (clip.cell.photo?.source === "scene") visit(clip.cell.photo.photoId, i, 0);
    } else if (clip.kind === "collage") {
      clip.cells.forEach((cell, j) => {
        if (cell.photo?.source === "scene") visit(cell.photo.photoId, i, j);
      });
    }
  });
}

/** The scene photo an issue path points at in `spec`: `["clips", i, "cell"]` or `["clips", i, "cells", j]`. */
function photoAt(spec: MontageDraft, path: MontageIssue["path"]): string | null {
  const [root, i, part, j] = path;
  if (root !== "clips" || typeof i !== "number") return null;
  const clip = spec.clips[i];
  if (clip === undefined) return null;
  const photo = clip.kind === "photo" && part === "cell" ? clip.cell.photo : clip.kind === "collage" && part === "cells" && typeof j === "number" ? (clip.cells[j]?.photo ?? null) : null;
  return photo?.source === "scene" ? photo.photoId : null;
}

function classify(photo: PhotoSummary | undefined): { problem: PhotoProblem; videoId?: string } {
  if (photo === undefined) return { problem: "unavailable" };
  if (photo.rejected) return { problem: "rejected" };
  const videoId = photo.usedIn[0];
  if (photo.used || videoId !== undefined) return videoId === undefined ? { problem: "used" } : { problem: "used", videoId };
  if (photo.reserved) return { problem: "reserved" };
  return { problem: "unavailable" };
}

/**
 * The cells of `spec` whose photo the engine flagged `photo-unavailable`, in timeline order. The verdict names
 * cells of the spec IT judged, so each is matched by its photo: a flagged photo stays flagged wherever the owner
 * moved it since, and one he removed flags nothing.
 */
export function photoProblems(spec: MontageDraft, verdict: EngineVerdict | null, photos: ReadonlyMap<string, PhotoSummary>): FlaggedCell[] {
  if (verdict === null) return [];
  const flagged = new Set<string>();
  for (const issue of verdict.issues) {
    if (issue.code !== "photo-unavailable") continue;
    const photoId = photoAt(verdict.spec, issue.path);
    if (photoId !== null) flagged.add(photoId);
  }
  const cells: FlaggedCell[] = [];
  forEachScenePhoto(spec, (photoId, clip, cell) => {
    if (flagged.has(photoId)) cells.push({ clip, cell, photoId, ...classify(photos.get(photoId)) });
  });
  return cells;
}

/** «Кадр 2»: clips are counted from 1. */
const clipName = (i: number): string => `Кадр ${i + 1}`;

/** «Текст 2» / «Стикер 1»: a layer counted among the layers of its own kind. */
function layerName(spec: MontageDraft, index: number): string {
  const layer = spec.layers[index];
  if (layer === undefined) return "Слой";
  const place = spec.layers.slice(0, index + 1).filter((l) => l.kind === layer.kind).length;
  return layer.kind === "text" ? `Текст ${place}` : `Стикер ${place}`;
}

const numberAt = (path: MontageIssue["path"], i: number): number => {
  const value = path[i];
  return typeof value === "number" ? value : 0;
};

function photoText(first: FlaggedCell, usedVideo: UsedVideo | null): string {
  switch (first.problem) {
    case "used":
      if (usedVideo === "this-draft") return "Фото уже в видео из этого черновика — замените их или удалите то видео";
      return usedVideo === null ? "Фото уже в видео — замените их или удалите то видео" : `Фото уже в видео «${usedVideo.file}» — замените их или удалите то видео`;
    case "rejected":
      return `${clipName(first.clip)}: фото отклонено — замените его`;
    case "reserved":
      return `${clipName(first.clip)}: фото уже в очереди на рендер`;
    case "unavailable":
      return `${clipName(first.clip)}: фото недоступно — замените его`;
  }
}

/** «скоро» for a part whose slice has not landed (N9), by where the engine would refuse it. */
function notYetText(spec: MontageDraft, issue: MontageIssue): string {
  const [root, i] = issue.path;
  if (root === "music") return "Музыка в видео — скоро";
  if (root === "layers") return spec.layers[numberAt(issue.path, 1)]?.kind === "sticker" ? "Стикеры в видео — скоро" : "Текст в видео — скоро";
  if (root === "clips" && typeof i === "number" && spec.clips[i]?.kind === "video") return "Своё видео — скоро";
  return "Свои фото — скоро";
}

function engineText(spec: MontageDraft, issue: MontageIssue): string {
  switch (issue.code) {
    case "caption-invalid":
      return `${layerName(spec, numberAt(issue.path, 1))}: надпись не проходит проверку`;
    case "track-unavailable":
      return "Трек больше недоступен";
    case "track-too-short":
      return "Трек короче ролика с выбранного места";
    case "sticker-unavailable":
      return `${layerName(spec, numberAt(issue.path, 1))} больше недоступен`;
    case "media-unavailable": {
      const [root] = issue.path;
      if (root === "music") return "Трек: файла больше нет";
      if (root === "layers") return `${layerName(spec, numberAt(issue.path, 1))}: файла больше нет`;
      return `${clipName(numberAt(issue.path, 1))}: файла больше нет`;
    }
    default:
      return plainMessage(issue.code);
  }
}

/** A contract message without its closing full stop, for the short line left of the button. */
const plainMessage = (code: MontageIssueCode): string => MONTAGE_ISSUE_MESSAGES_RU[code].replace(/\.$/, "");

const reason = (text: string, clips?: readonly number[]): RenderBlock => (clips === undefined ? { text, settings: false } : { text, settings: false, clips });

/** The first reason «Рендер» is disabled, or null when nothing is in the way. */
export function renderBlock(input: RenderBlockInput): RenderBlock | null {
  const { spec, verdict } = input;
  if (input.exportStatus?.status === "unavailable") return { text: "Папка «Готовые видео» недоступна", settings: true };
  if (!input.avatarActive) return reason("Аватар в архиве — новые видео для него не собираются");

  const structural = montageIssues(spec, "spec");
  const find = (...codes: MontageIssueCode[]): MontageIssue | undefined => structural.find((issue) => codes.includes(issue.code));
  // The engine's referential issues other than photos count only for the spec it judged: once the owner edited
  // it, their paths may point elsewhere, and the next `montages.get` (after the save) judges again.
  const current = verdict !== null && sameJson(verdict.spec, spec) ? verdict.issues : [];
  const engine = (...codes: MontageIssueCode[]): MontageIssue | undefined => current.find((issue) => codes.includes(issue.code));

  if (find("no-clips")) return reason("Добавьте хотя бы один кадр");
  if (find("duration-too-short")) return reason("Ролик короче 4 с");
  if (find("duration-too-long")) return reason("Ролик длиннее 15 с");
  const empty = find("cell-empty");
  if (empty) {
    const clip = numberAt(empty.path, 1);
    return reason(`${clipName(clip)}: пустая ячейка`, [clip]);
  }

  const flagged = photoProblems(spec, verdict, input.photos ?? new Map());
  const first = flagged[0];
  if (first !== undefined) {
    // Until the photos are read, why is not known: the button is blocked all the same, without a guess.
    if (input.photos === null) return reason("Проверяем фото…", [first.clip]);
    const clips = first.problem === "used" ? [...new Set(flagged.map((f) => f.clip))] : [first.clip];
    return reason(photoText(first, input.usedVideo), clips);
  }

  const caption = engine("caption-invalid");
  if (caption) return reason(engineText(spec, caption));
  const layer = find("layer-too-short", "layer-outside-timeline");
  if (layer) {
    const name = layerName(spec, numberAt(layer.path, 1));
    return reason(layer.code === "layer-too-short" ? `${name} короче 0.3 с` : `${name} заканчивается после конца ролика`);
  }
  const track = engine("track-unavailable", "track-too-short");
  if (track) return reason(engineText(spec, track));
  const missing = engine("sticker-unavailable", "media-unavailable");
  if (missing) return reason(engineText(spec, missing));

  const notYet = notYetSupportedIssues(spec)[0];
  if (notYet) return reason(notYetText(spec, notYet));

  const rest = structural[0] ?? current.find((issue) => issue.code !== "photo-unavailable");
  return rest ? reason(engineText(spec, rest)) : null;
}
