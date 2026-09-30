import { EXPORT_UNAVAILABLE_REASONS_RU, type EngineError, type ExportUnavailableReason } from "../../shared/engine";
import { errorText } from "./errors";
import { countOf } from "./format";

// What the «Готовые видео» card says (3e.3): after a pick, when a pick is refused, and when the folder in use cannot be used. Text
// only, from the engine's counts and its closed list of reasons.

/** The title of the notice for an unusable export folder; the same words as the Render button's reason in the design. */
export const EXPORT_UNAVAILABLE_TITLE = "Папка «Готовые видео» недоступна";

const VIDEOS = ["видео", "видео", "видео"] as const;

/** «остался», «остались»: the verb agrees with the number it follows (1, 21 → осталось; 11 → остались). */
function stayedVerb(count: number): string {
  return count % 10 === 1 && count % 100 !== 11 ? "осталось" : "остались";
}

export interface PickedNotice {
  tone: "ok" | "warn";
  text: string;
  /** What to do about the videos left behind, when any were. */
  hint: string | null;
}

/**
 * The notice after the owner picked a folder: how many videos are there now (`resolved`: they name that folder's marker) and how
 * many stayed in the previous one (`elsewhere`). A moved folder and the first folder chosen again resolve everything; another folder
 * leaves the old videos behind until the old folder is chosen again.
 */
export function pickedNotice(counts: { resolved: number; elsewhere: number }): PickedNotice {
  const { resolved, elsewhere } = counts;
  if (elsewhere > 0) {
    return {
      tone: "warn",
      text: `Папка выбрана: ${countOf(resolved, VIDEOS)} на месте, ${countOf(elsewhere, VIDEOS)} ${stayedVerb(elsewhere)} в прежней папке.`,
      hint: "Они снова откроются, когда вы выберете прежнюю папку ещё раз.",
    };
  }
  if (resolved === 0) return { tone: "ok", text: "Папка выбрана.", hint: null };
  return { tone: "ok", text: `Папка выбрана: ${resolved === 1 ? countOf(1, VIDEOS) : `все ${countOf(resolved, VIDEOS)}`} на месте.`, hint: null };
}

/** Why a pick was refused, and that nothing changed: the old folder is still the export folder. */
export function refusedPickText(error: EngineError): string {
  if (error.code === "IN_FLIGHT") return "Пока идут рендеры, папку менять нельзя: дождитесь их конца или отмените их.";
  if (error.code === "EXPORT_UNAVAILABLE") {
    const why = error.exportReason === undefined ? "" : `${EXPORT_UNAVAILABLE_REASONS_RU[error.exportReason]} `;
    return `Эту папку выбрать нельзя. ${why}Прежняя папка осталась.`;
  }
  return errorText(error);
}

/** Why the folder in use cannot take a video now. The text of a damaged marker in a library with records never advises touching the file. */
export function unavailableText(reason: ExportUnavailableReason): string {
  return EXPORT_UNAVAILABLE_REASONS_RU[reason];
}
