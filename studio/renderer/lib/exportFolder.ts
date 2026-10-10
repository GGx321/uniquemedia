import { EXPORT_UNAVAILABLE_REASONS_RU, type EngineError, type ExportUnavailableReason, type LaunchView } from "../../shared/engine";
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
export function pickedNotice(counts: { resolved: number; elsewhere: number; incomplete: boolean }): PickedNotice {
  const { resolved, elsewhere, incomplete } = counts;
  const behind = "Они снова откроются, когда вы выберете прежнюю папку ещё раз.";
  // Some record files could not be read: the numbers may be short, so «все» is never said and the owner is told why.
  const partial = "Часть записей о видео прочитать не удалось, поэтому числа могут быть неполными.";
  if (elsewhere > 0) {
    return {
      tone: "warn",
      text: `Папка выбрана: ${countOf(resolved, VIDEOS)} на месте, ${countOf(elsewhere, VIDEOS)} ${stayedVerb(elsewhere)} в прежней папке.`,
      hint: incomplete ? `${behind} ${partial}` : behind,
    };
  }
  const tone = incomplete ? "warn" : "ok";
  const hint = incomplete ? partial : null;
  if (resolved === 0) return { tone, text: "Папка выбрана.", hint };
  const holds = resolved === 1 || incomplete ? countOf(resolved, VIDEOS) : `все ${countOf(resolved, VIDEOS)}`;
  return { tone, text: `Папка выбрана: ${holds} на месте.`, hint };
}

/** «Библиотека · Изменить» refused while renders are queued or running: the generic IN_FLIGHT text talks about paid requests, which is not the reason then. */
export const LIBRARY_RENDER_BUSY_TEXT = "Пока идут рендеры, папку библиотеки менять нельзя: дождитесь их конца или отмените их.";

/**
 * S4.10 fix C (M1): «Библиотека · Изменить» refused while the library's launch runs, pauses or stops (HostStates «Другие экраны»). Cancelling renders does not
 * help then: the launch holds the folder by its own check, and a pause lets it go.
 */
export const LIBRARY_AUTOPILOT_BUSY_TEXT = "Идёт автопилот — сменить библиотеку можно на паузе или после конца запуска.";

/** Whether the library's launch holds the library folder (plan §3.8, A12): while it runs, pauses or stops. A paused launch, or one that ended, lets it go. */
export function launchHoldsLibrary(launch: LaunchView | null): boolean {
  return launch !== null && (launch.status === "running" || launch.status === "pausing" || launch.status === "stopping");
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
