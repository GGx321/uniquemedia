import type { AvatarSummary, EngineError, ExportStatus, FileState, PhotoSummary, VideoSummary } from "../../../shared/engine";
import type { JobView } from "../../engine/store";
import { countOf, groupNumber, NBSP, plural } from "../../lib/format";
import { secondsLabel } from "../montage/labels";
import { PHOTO_FORMS } from "./shared";

// 3e.2: the Photos screen's own logic, pure, so every state is tested without a screen. The header's counts
// (AvatarVideos.dc.html / Photos.dc.html A1, F1), the gallery's filters (F4), the «Видео» tab's cards, one per render job
// in flight or failed and one per video record in its file state (A15-A31), its filter (A5, AM5), and the words of its
// confirmations and outcomes. The render jobs are the store's (the same model as the editor's button, 3d.6).

// ---------- the header ----------

export interface HeaderCounts {
  readonly photos: string;
  /** «31 не использовано», or «использование неизвестно» while the usage cannot be trusted. */
  readonly unused: string;
  readonly videos: string;
  readonly unknown: boolean;
}

/** «124 фото · 31 не использовано · 18 видео», from the avatar's summary (the one eligibility function; K counts records). */
export function headerCounts(avatar: AvatarSummary): HeaderCounts {
  const unknown = avatar.usage.state === "unknown";
  return {
    photos: `${groupNumber(avatar.photoCount)}${NBSP}фото`,
    unused: unknown ? "использование неизвестно" : `${groupNumber(avatar.eligibleUnusedCount)}${NBSP}не использовано`,
    videos: `${groupNumber(avatar.videoCount)}${NBSP}видео`,
    unknown,
  };
}

// ---------- usage unknown ----------

export interface UsageAction {
  readonly command: "videos.quarantineRecords" | "photos.rebuildRejected";
  readonly label: string;
  /** What the owner agrees to before it runs. */
  readonly confirm: string;
}

const QUARANTINE: UsageAction = {
  command: "videos.quarantineRecords",
  label: "Убрать повреждённую запись",
  confirm:
    "Повреждённые записи о видео переедут в карантин библиотеки: Studio их не удаляет, их можно вернуть вручную. Файлы в «Готовых видео» не трогаются. Фото, которые были только в этих записях, станут свободными.",
};

const REBUILD: UsageAction = {
  command: "photos.rebuildRejected",
  label: "Восстановить отметки",
  confirm:
    "Studio сохранит копию журнала отметок в карантине библиотеки и оставит в журнале все отметки, которые читаются. Отметки из повреждённых строк пропадут: после восстановления проверьте фильтр «Отклонённые».",
};

/** The buttons the «использование неизвестно» notice offers: one per reason the owner can fix himself. */
export function usageActions(usage: AvatarSummary["usage"]): UsageAction[] {
  if (usage.state === "ok") return [];
  return [...(usage.reasons.includes("record-unreadable") ? [QUARANTINE] : []), ...(usage.reasons.includes("rejects-unreadable") ? [REBUILD] : [])];
}

// ---------- the gallery ----------

export type GalleryFilter = "all" | "unused" | "rejected";

/**
 * The gallery's photos under a filter. «Неиспользованные» is what a montage may still take (eligible, in no video, in no
 * render), and nothing while the usage cannot be trusted (a photo that looks free may be in a video nobody can read).
 */
export function galleryPhotos(photos: readonly PhotoSummary[], filter: GalleryFilter, usage: AvatarSummary["usage"]): readonly PhotoSummary[] {
  switch (filter) {
    case "all":
      return photos;
    case "unused":
      return usage.state === "ok" ? photos.filter((p) => p.eligible && !p.used && !p.reserved) : [];
    case "rejected":
      return photos.filter((p) => p.rejected);
  }
}

// ---------- the «Видео» tab ----------

const isActive = (job: JobView): boolean => job.status === "queued" || job.status === "running";

/** This avatar's render jobs the tab draws as cards: queued, running (saving too) and failed (unless dismissed, AM6), newest first. */
export function renderCardsOf(jobs: readonly JobView[], avatarId: string, dismissed: ReadonlySet<string>): JobView[] {
  return jobs.filter((job) => job.kind === "render" && job.avatarId === avatarId && (isActive(job) || (job.status === "failed" && !dismissed.has(job.jobId)))).reverse();
}

export type VideoFilter = "all" | "work" | "failed";

/** «Все 18 · В работе 2 · С ошибкой 1»: «С ошибкой» is failed renders only; a file problem is not one (AM5). */
export function filterCounts(cards: readonly JobView[], videos: readonly VideoSummary[]): Record<VideoFilter, number> {
  return { all: cards.length + videos.length, work: cards.filter(isActive).length, failed: cards.filter((job) => job.status === "failed").length };
}

export type TabItem = { readonly kind: "job"; readonly job: JobView } | { readonly kind: "video"; readonly video: VideoSummary };

/** The cards under a filter: the render jobs first (they are newer than any record), then the records, newest first. */
export function visibleItems(filter: VideoFilter, cards: readonly JobView[], videos: readonly VideoSummary[]): TabItem[] {
  const jobs = cards.filter((job) => filter === "all" || (filter === "work" ? isActive(job) : job.status === "failed")).map((job): TabItem => ({ kind: "job", job }));
  return filter === "all" ? [...jobs, ...videos.map((video): TabItem => ({ kind: "video", video }))] : jobs;
}

/** How many photos a record holds, as a sentence's end: «3 фото считаются занятыми», «1 фото считается занятым». */
function heldLabel(n: number): string {
  return `${countOf(n, PHOTO_FORMS)} ${plural(n, ["считается занятым", "считаются занятыми", "считаются занятыми"])}`;
}

/** «4 фото снова станут свободными», «1 фото снова станет свободным». */
function freedLabel(n: number): string {
  return `${countOf(n, PHOTO_FORMS)} снова ${plural(n, ["станет свободным", "станут свободными", "станут свободными"])}`;
}

export interface VideoCardView {
  /** The pill over the poster: the file's state when it is not plainly there. */
  readonly pill: { readonly text: string; readonly tone: "muted" | "warn" } | null;
  /** The poster is dimmed: the file is not where Studio can show it. */
  readonly dim: boolean;
  readonly status: { readonly text: string; readonly tone: "ok" | "warn" | "faint" };
  readonly canPlay: boolean;
  /** «Открыть в папке»: main shows only a `present` file. */
  readonly canReveal: boolean;
  /** The trash asks «Удалить видео?» (the file too, `mode: "video"`): only a file that is plainly Studio's. */
  readonly trash: boolean;
  /** «Удалить запись» (`mode: "record"`, never the file), with the confirmation it needs first (null: at once). */
  readonly recordDelete: { readonly confirm: string | null } | null;
  /** «Проверить снова»: the look at the file failed, so another look may know. */
  readonly recheck: boolean;
}

/** The owner's own wording for «Удалить запись» of a video whose file lives in another folder (Q6, 2026-09-30). */
const ELSEWHERE_CONFIRM = "Удалить запись? Файл останется в прежней папке, а фото снова станут свободными.";
/** «Удалить запись» of a video whose file nobody could look at: it stays wherever it is (an `unchecked` file, or any file while the export folder is unavailable). */
const UNKNOWN_PLACE_CONFIRM = "Удалить запись? Файл останется там, где он есть, а фото снова станут свободными.";

/**
 * A record's card in its file state. `exportStatus` tells an `elsewhere` that only means "the export folder cannot be looked in"
 * (it is unavailable: «не удалось проверить») from one in another folder: while the folder is unavailable, no file can be judged.
 */
export function videoCardView(video: VideoSummary, exportStatus: ExportStatus | null): VideoCardView {
  const held = heldLabel(video.photoCount);
  const state: FileState = video.fileState;
  const none = { canPlay: false, canReveal: false, trash: false, recheck: false } as const;
  switch (state) {
    case "present":
      return { pill: null, dim: false, status: { text: "✓ в «Готовых видео»", tone: "ok" }, canPlay: true, canReveal: true, trash: true, recordDelete: null, recheck: false };
    case "missing":
      return { ...none, pill: { text: "Файл удалён", tone: "muted" }, dim: true, status: { text: `Файл удалён из «Готовых видео». Пока есть запись, ${held}.`, tone: "faint" }, recordDelete: { confirm: null } };
    case "changed":
      return {
        ...none,
        canPlay: true,
        pill: { text: "Изменён", tone: "warn" },
        dim: false,
        status: { text: `Файл изменён вне Studio: Studio его не удаляет. Пока есть запись, ${held}.`, tone: "warn" },
        recordDelete: { confirm: "Удалить запись? Файл останется в «Готовых видео», а фото снова станут свободными." },
      };
    case "elsewhere":
      if (exportStatus?.status === "unavailable") {
        return { ...none, pill: { text: "Не проверен", tone: "muted" }, dim: true, status: { text: `Не удалось проверить файл: папка «Готовые видео» сейчас недоступна. Пока есть запись, ${held}.`, tone: "faint" }, recordDelete: { confirm: UNKNOWN_PLACE_CONFIRM } };
      }
      return { ...none, pill: { text: "Другая папка", tone: "muted" }, dim: true, status: { text: `Файл в другой папке «Готовые видео». Пока есть запись, ${held}.`, tone: "faint" }, recordDelete: { confirm: ELSEWHERE_CONFIRM } };
    case "unchecked":
      return {
        ...none,
        recheck: true,
        pill: { text: "Не проверен", tone: "muted" },
        dim: true,
        status: { text: `Не удалось проверить файл. Пока есть запись, ${held}.`, tone: "faint" },
        recordDelete: { confirm: UNKNOWN_PLACE_CONFIRM },
      };
  }
}

/** «Удалить видео? Файл в «Готовых видео» тоже удалится, 4 фото снова станут свободными.» (A27) */
export function deleteConfirmText(photoCount: number): string {
  return `Удалить видео? Файл в «Готовых видео» тоже удалится, ${freedLabel(photoCount)}.`;
}

/**
 * What a delete did, as its answer says (`fileDeleted`, `fileState` as found); null when there is nothing to add (the card just
 * goes). `exportStatus` tells an `elsewhere` that only means the export folder could not be looked in (nobody knows where the
 * file is) from one in another folder, as the card does.
 */
export function deleteOutcomeText(mode: "video" | "record", answer: { fileDeleted: boolean; fileState: FileState }, exportStatus: ExportStatus | null): string | null {
  if (mode === "video") {
    if (answer.fileDeleted) return null;
    if (answer.fileState === "changed") return "Запись удалена, а файл оставлен в «Готовых видео»: он изменён вне Studio, и Studio его не трогает. Фото снова свободны.";
    if (answer.fileState === "missing") return "Запись удалена: файла в «Готовых видео» уже не было. Фото снова свободны.";
    return "Запись удалена, а файл оставлен на месте. Фото снова свободны.";
  }
  switch (answer.fileState) {
    case "missing":
      return "Запись удалена, фото снова свободны.";
    case "elsewhere":
      if (exportStatus?.status === "unavailable") return "Запись удалена, фото снова свободны. Файл, если он есть, остался на месте.";
      return "Запись удалена, фото снова свободны. Файл остался в прежней папке.";
    case "unchecked":
      return "Запись удалена, фото снова свободны. Файл, если он есть, остался на месте.";
    case "present":
    case "changed":
      return "Запись удалена, фото снова свободны. Файл остался в «Готовых видео».";
  }
}

/** «0:08»: the length in whole seconds, as the pill on the poster reads it. */
export function durationPill(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** «8.0 с · 3 фото · 2.4 МБ» (A12: the photos the video shows). */
export function videoMeta(video: VideoSummary): string {
  return `${secondsLabel(video.durationMs)} · ${countOf(video.photoCount, PHOTO_FORMS)} · ${(video.bytes / 1_000_000).toFixed(1)}${NBSP}МБ`;
}

/** «52 МБ»: the listed videos' files together, in whole decimal megabytes. */
export function megabytesLabel(videos: readonly VideoSummary[]): string {
  return `${groupNumber(Math.round(videos.reduce((sum, v) => sum + v.bytes, 0) / 1_000_000))}${NBSP}МБ`;
}

/** The record states whose file lives (or lived) in the current export folder: their folder is this folder's. */
const IN_THIS_FOLDER: ReadonlySet<FileState> = new Set(["present", "missing", "changed"]);

/**
 * «~/Studio/export/Mia»: the export folder as main shows it (`settings.exportDisplay`), and the avatar's own folder in it, named by
 * the place of its newest video there (main opens the same one). Only the export folder while the avatar has no video in it.
 */
export function avatarFolderDisplay(rootDisplay: string | null, videos: readonly VideoSummary[]): string | null {
  if (rootDisplay === null) return null;
  const own = videos.find((v) => IN_THIS_FOLDER.has(v.fileState));
  if (own === undefined) return rootDisplay;
  const separator = rootDisplay.includes("\\") && !rootDisplay.includes("/") ? "\\" : "/";
  const folder = own.relPath.slice(0, own.relPath.indexOf("/"));
  return `${rootDisplay.replace(/[\\/]+$/, "")}${separator}${folder}`;
}

/** Why a render failed, in a few words: the card's line (A19), the full text in its tooltip. */
function failedReason(error: EngineError): string {
  switch (error.code) {
    case "MONTAGE_INVALID": {
      const issue = error.issues?.[0]?.code;
      if (issue === "track-unavailable" || issue === "track-too-short") return issue === "track-unavailable" ? "трек больше недоступен" : "трек короче ролика";
      if (issue === "caption-invalid") return "надпись не проходит проверку";
      if (issue === "sticker-unavailable") return "стикера больше нет";
      return "монтаж не готов к рендеру";
    }
    case "EXPORT_UNAVAILABLE":
      return "папка «Готовые видео» недоступна";
    case "PHOTO_UNAVAILABLE":
      return "фото больше нельзя использовать";
    case "TEXT_INVALID":
      return "надпись не проходит проверку";
    case "RENDER_FAILED":
      return "сборка не удалась";
    case "RENDER_VERIFY_FAILED":
      return "видео не прошло проверку";
    default:
      return "внутренняя ошибка";
  }
}

/** «Не собралось: трек больше недоступен. Фото остались свободными.» (A19) */
export function failedRenderLine(error: EngineError): string {
  return `Не собралось: ${failedReason(error)}. Фото остались свободными.`;
}
