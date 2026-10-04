import { MEDIA_REASONS_RU } from "./errorMessagesRu";
import type { MediaUnsupportedReason } from "./media";

// 3f.5: what an owner is told when an OWN STICKER is refused. The reasons are neutral and shared by every kind (`MediaUnsupportedReason`), and the
// neutral texts (`MEDIA_REASONS_RU`) speak of photos where a reason came from a photo (`too-small`, `dimensions`) or list every kind's formats
// (`format`, `too-large`). This map is the sticker's own wording for the reasons it uses; a reason it has no text for falls back to the neutral
// one. It is kept apart on purpose: the per-kind table the video import adds (`MEDIA_REASONS_BY_KIND_RU`, `mediaReasonRu`) is on its own branch,
// and when both are on main this map folds in there as the `sticker` entry, with nothing else to change.

export const STICKER_REASONS_RU: Partial<Record<MediaUnsupportedReason, string>> = {
  format:
    "Для стикера нужен GIF или APNG. Если это APNG, перед анимацией не должно быть отдельной картинки-заставки, а сам файл должен читаться целиком: сохраните анимацию заново и добавьте снова.",
  "too-large": "Стикер слишком тяжёлый: исходный файл и готовая анимация не должны быть больше 5 МБ. Уменьшите размер картинки или число кадров.",
  "too-small": "Стикер слишком маленький: каждая сторона должна быть не короче 2 пикселей.",
  dimensions: "Стикер слишком большой: каждая сторона — не длиннее 720 пикселей. Уменьшите его и добавьте снова.",
  "not-animated": "Это не анимация: нужен GIF или APNG минимум с двумя разными кадрами. Обычную картинку (PNG, JPEG) стикером сделать нельзя.",
  "loop-too-long": "Анимация слишком длинная: стикер — это петля до 300 кадров, то есть 10 секунд при 30 кадрах в секунду. Сократите анимацию и добавьте снова.",
  failed: "Не удалось добавить стикер. Попробуйте ещё раз или сохраните анимацию заново.",
};

/** The text of a sticker's refusal: its own wording where it has one, the neutral text otherwise. */
export function stickerReasonRu(reason: MediaUnsupportedReason): string {
  return STICKER_REASONS_RU[reason] ?? MEDIA_REASONS_RU[reason];
}
