import { EXPORT_UNAVAILABLE_REASONS_RU, type EngineError, type FileState } from "../../../shared/engine";
import { errorText } from "../../lib/errors";
import { countOf, plural } from "../../lib/format";
import { PHOTO_FORMS } from "./shared";

// S4.9c: the words of «Удалить видео» (README decision 11; LaunchStates «Удалить видео», ApDeletePublished): a dialog with two ways, the same on the launch's
// results and on «Фото»'s «Видео» tab — «Удалить видео и отклонить фото» (`videos.delete { rejectPhotos: true }`, plan §8.5) or «Только удалить видео», the
// delete as it always was. Pure, so every wording is tested without a screen.

export type DeleteChoice = "reject" | "plain";

export interface DeleteDialogText {
  readonly title: string;
  readonly lead: string;
  readonly reject: { readonly title: string; readonly sub: string };
  readonly plain: { readonly title: string; readonly sub: string };
  /** Q4 = A (plan §17, pending the owner): a published video's dialog starts on «и отклонить фото»; any other on the plain delete, as today. */
  readonly preselect: DeleteChoice;
}

const isOne = (n: number): boolean => plural(n, ["one", "few", "many"]) === "one";

/** The dialog of `label` («видео 3 · Mia», «видео «утро дома»»), whose video holds `photos` photos. */
export function deleteDialogText(label: string, published: boolean, photos: number): DeleteDialogText {
  const n = countOf(photos, PHOTO_FORMS);
  return {
    title: `Удалить ${label}?`,
    lead: published
      ? "Файл в «Готовых видео» тоже удалится. Видео уже опубликовано — поэтому выбрано «отклонить фото»: эти кадры не уйдут в новый ролик."
      : "Файл в «Готовых видео» тоже удалится.",
    reject: {
      title: "Удалить видео и отклонить фото",
      sub: isOne(photos) ? `${n} уйдёт в «Отклонённые» — автопилот его больше не возьмёт.` : `${n} уйдут в «Отклонённые» — автопилот их больше не возьмёт.`,
    },
    plain: {
      title: "Только удалить видео",
      sub: isOne(photos) ? `${n} снова станет свободным — из него может собраться новое видео.` : `${n} снова станут свободными — из них может собраться новое видео.`,
    },
    preselect: published ? "reject" : "plain",
  };
}

/** The dialog's button repeats the choice. */
export function deleteButtonText(choice: DeleteChoice): string {
  return choice === "reject" ? "Удалить и отклонить фото" : "Удалить видео";
}

/** «Видео 3 · Mia удалено, 6 фото отклонены.»: what a delete with the photos rejected did, from its answer (`rejectedPhotoIds`, the file as found). */
export function rejectDoneText(label: string, answer: { fileDeleted: boolean; fileState: FileState; rejectedPhotoIds?: readonly string[] }): string {
  const head = `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
  const n = answer.rejectedPhotoIds?.length ?? 0;
  const photos = `${countOf(n, PHOTO_FORMS)} ${plural(n, ["отклонено", "отклонены", "отклонены"])}`;
  if (answer.fileDeleted) return `${head} удалено, ${photos}.`;
  const file = answer.fileState === "missing" ? "файла в «Готовых видео» уже не было" : answer.fileState === "changed" ? "файл изменён вне Studio и оставлен на месте" : "файл оставлен на месте";
  return `${head}: запись удалена, ${file}; ${photos}.`;
}

/** «Видео 3 · Mia удалено, 6 фото снова свободны.»: a plain delete that took the file too. */
export function plainDoneText(label: string, photos: number): string {
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} удалено, ${countOf(photos, PHOTO_FORMS)} снова ${plural(photos, ["свободно", "свободны", "свободны"])}.`;
}

/** The title of a delete that came back refused: never «не удалено» — a delete that timed out reads as refused while its work may still go on. */
export const DELETE_UNCONFIRMED = "Удаление не подтвердилось — списки прочитаны заново";

/**
 * Why a delete did not come back done. The export folder is checked first, so a refusal there changes nothing — but a delete that timed out reads as
 * EXPORT_UNAVAILABLE (`not-writable`) while its work may still go on (the photos already rejected, even the video gone), and a NOT_FOUND may mean it is gone
 * already. So the words promise neither way (fix round 1): the screen reads its lists again, and they show what stands.
 */
export function deleteFailedText(error: EngineError, rejecting: boolean): { readonly title: string; readonly text: string } {
  const photos = rejecting ? "Фото, что успели уйти в «Отклонённые», там и останутся." : null;
  if (error.code === "EXPORT_UNAVAILABLE") {
    const parts = [
      "Папка «Готовые видео» не ответила.",
      error.exportReason === undefined ? null : EXPORT_UNAVAILABLE_REASONS_RU[error.exportReason],
      photos,
      "Если видео осталось в списке, удалите его ещё раз, когда папка вернётся.",
    ];
    return { title: DELETE_UNCONFIRMED, text: parts.filter((part) => part !== null).join(" ") };
  }
  if (error.code === "NOT_FOUND") return { title: DELETE_UNCONFIRMED, text: ["Этого видео уже нет в библиотеке.", photos].filter((part) => part !== null).join(" ") };
  return { title: DELETE_UNCONFIRMED, text: [errorText(error), photos, "Если видео осталось в списке, удалите его ещё раз."].filter((part) => part !== null).join(" ") };
}
