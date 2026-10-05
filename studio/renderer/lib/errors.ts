import {
  DRAFT_CHANGING_DETAIL,
  DRAFT_TOO_NEW_DETAIL,
  ERROR_MESSAGES_RU,
  EXPORT_CHANGING_DETAIL,
  EXPORT_UNAVAILABLE_REASONS_RU,
  MONTAGE_ISSUE_MESSAGES_RU,
  MUSIC_UNAVAILABLE_REASONS_RU,
  NO_ANSWER_DETAIL_PREFIX,
  PHOTO_UNAVAILABLE_REASONS_RU,
  RENDER_TIMEOUT_DETAIL_PREFIX,
  RENDER_NOT_QUEUED_DETAIL,
  renderQueueLimitOf,
  type EngineError,
  type ErrorCode,
} from "../../shared/engine";
import type { SettingsFocus } from "../navigation";
import { countOf, waitLabel } from "./format";

/**
 * 3d.2 (the 3d.1a review): two INTERNAL answers of `montages.get` the owner can act on, told apart by their shared
 * detail. A draft from a newer Studio is not broken, the app is old; a draft replaced while it was read opens on
 * a retry. Neither may read as «Внутренняя ошибка движка».
 */
const DRAFT_TOO_NEW_RU = "Этот черновик сохранён более новой версией Studio. Обновите приложение, чтобы открыть его: сам черновик цел.";
const DRAFT_CHANGING_RU = "Черновик как раз сохранялся, и его не удалось прочитать. Повторите — он откроется.";

/**
 * 3d.6: what a render says when it is refused or fails. The general texts of IN_FLIGHT and of an answer that never came are
 * about paid requests and OpenRouter; a render touches neither, and each of these says what happened to the job.
 */
const EXPORT_CHANGING_RU = "Папку «Готовые видео» как раз меняют. Ничего не сделано и не потрачено — повторите через секунду.";
const RENDER_NOT_QUEUED_RU = "Движок не успел поставить рендер в очередь. Ничего не поставлено и не потрачено — повторите.";
const NO_ANSWER_RU = "Движок не ответил вовремя. Команда могла выполниться: посмотрите на экран и в очередь слева, и повторите, только если ничего не изменилось.";
const RENDER_TIMEOUT_RU = "Рендер не уложился во время: диск с библиотекой или ffmpeg не ответили. Ничего не потрачено — повторите; если библиотека на внешнем диске, проверьте его.";
const RENDER_FORMS = ["рендер", "рендера", "рендеров"] as const;

function baseText(error: EngineError): string {
  if (error.code === "IN_FLIGHT" && error.detail === EXPORT_CHANGING_DETAIL) return EXPORT_CHANGING_RU;
  if (error.code === "INTERNAL" && error.detail === RENDER_NOT_QUEUED_DETAIL) return RENDER_NOT_QUEUED_RU;
  if (error.code === "INTERNAL" && error.detail?.startsWith(NO_ANSWER_DETAIL_PREFIX) === true) return NO_ANSWER_RU;
  if (error.code === "TIMEOUT" && error.detail?.startsWith(RENDER_TIMEOUT_DETAIL_PREFIX) === true) return RENDER_TIMEOUT_RU;
  if (error.code === "RENDER_QUEUE_FULL") {
    const limit = renderQueueLimitOf(error.detail);
    if (limit !== null) return `В очереди уже ${countOf(limit, RENDER_FORMS)}: это предел. Дождитесь, пока часть из них соберётся, или отмените лишние, и повторите. Ничего не потрачено и не сохранено.`;
  }
  // A refused photo says why: one photo goes into one video, a render holds its photos, a broken record refuses the whole avatar.
  if (error.code === "PHOTO_UNAVAILABLE" && error.photoReason !== undefined) return PHOTO_UNAVAILABLE_REASONS_RU[error.photoReason];
  if (error.code === "INTERNAL" && error.detail === DRAFT_TOO_NEW_DETAIL) return DRAFT_TOO_NEW_RU;
  if (error.code === "INTERNAL" && error.detail === DRAFT_CHANGING_DETAIL) return DRAFT_CHANGING_RU;
  // 3c.6: music that could not be fetched says why, and whether the request counted; «позже» only where waiting helps.
  if (error.code === "MUSIC_UNAVAILABLE" && error.musicReason !== undefined) return MUSIC_UNAVAILABLE_REASONS_RU[error.musicReason];
  return ERROR_MESSAGES_RU[error.code];
}

/** The Russian text for an engine error, plus the wait when the engine gave one. */
export function errorText(error: EngineError): string {
  let base = baseText(error);
  // 3e.3: an unusable export folder says why (the engine's closed list of reasons), after the general text.
  if (error.code === "EXPORT_UNAVAILABLE" && error.exportReason !== undefined) base = `${base} ${EXPORT_UNAVAILABLE_REASONS_RU[error.exportReason]}`;
  // 3d.6: a montage the engine refused says what is wrong with it first.
  const firstIssue = error.code === "MONTAGE_INVALID" ? error.issues?.[0] : undefined;
  if (firstIssue !== undefined) base = `${base} ${MONTAGE_ISSUE_MESSAGES_RU[firstIssue.code]}`;
  if (error.retryAfterMs !== undefined && error.retryAfterMs > 0) return `${base} Повторите через ${waitLabel(error.retryAfterMs)}.`;
  return base;
}

/** Where in Settings the user fixes this error, if anywhere. */
export function errorSettingsFocus(code: ErrorCode): SettingsFocus | null {
  switch (code) {
    case "AUTH_INVALID":
    case "ENCRYPTION_UNAVAILABLE":
      return "key";
    case "BUDGET_EXCEEDED":
    case "RECONCILE_REQUIRED":
    case "LEDGER_CORRUPT":
    case "SETTLE_ABOVE_WORST":
    case "LEDGER_WRITE_FAILED":
      return "money";
    case "EXPORT_UNAVAILABLE":
      return "export";
    case "MUSIC_KEY_MISSING":
    case "MUSIC_KEY_REJECTED":
    case "MUSIC_QUOTA_EXHAUSTED":
    case "MUSIC_UNAVAILABLE":
      return "music";
    default:
      return null;
  }
}

const SETTINGS_LINK_LABELS: Record<SettingsFocus, string> = {
  key: "Открыть ключ в Настройках",
  money: "Открыть деньги в Настройках",
  export: "Открыть папку в Настройках",
  music: "Открыть музыку в Настройках",
};

export function settingsLinkLabel(focus: SettingsFocus): string {
  return SETTINGS_LINK_LABELS[focus];
}
