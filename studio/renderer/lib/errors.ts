import {
  AGE_CHECK_ALREADY_REFUSED_DETAIL,
  DRAFT_CHANGING_DETAIL,
  DRAFT_TOO_NEW_DETAIL,
  ERROR_MESSAGES_RU,
  EXPORT_UNAVAILABLE_REASONS_RU,
  type EngineError,
  type ErrorCode,
} from "../../shared/engine";
import type { SettingsFocus } from "../navigation";
import { waitLabel } from "./format";

/**
 * T6c (H2, M2): re-picking a photo already refused by the mandatory
 * one-time age check is refused again for free — unlike the ordinary
 * AGE_CHECK_FAILED (ERROR_MESSAGES_RU's own text), nothing was charged this
 * time, so it needs its own wording rather than claiming the age check was
 * paid for again.
 */
const AGE_CHECK_ALREADY_REFUSED_RU =
  "Это фото уже не подтвердило возраст при прошлой попытке. Импорт отменён, ничего не сохранено и не потрачено — выберите другое фото.";

/**
 * 3d.2 (the 3d.1a review): two INTERNAL answers of `montages.get` the owner can act on, told apart by their shared
 * detail. A draft from a newer Studio is not broken, the app is old; a draft replaced while it was read opens on
 * a retry. Neither may read as «Внутренняя ошибка движка».
 */
const DRAFT_TOO_NEW_RU = "Этот черновик сохранён более новой версией Studio. Обновите приложение, чтобы открыть его: сам черновик цел.";
const DRAFT_CHANGING_RU = "Черновик как раз сохранялся, и его не удалось прочитать. Повторите — он откроется.";

function baseText(error: EngineError): string {
  if (error.code === "AGE_CHECK_FAILED" && error.detail === AGE_CHECK_ALREADY_REFUSED_DETAIL) return AGE_CHECK_ALREADY_REFUSED_RU;
  if (error.code === "INTERNAL" && error.detail === DRAFT_TOO_NEW_DETAIL) return DRAFT_TOO_NEW_RU;
  if (error.code === "INTERNAL" && error.detail === DRAFT_CHANGING_DETAIL) return DRAFT_CHANGING_RU;
  return ERROR_MESSAGES_RU[error.code];
}

/** The Russian text for an engine error, plus the wait when the engine gave one. */
export function errorText(error: EngineError): string {
  let base = baseText(error);
  // 3e.3: an unusable export folder says why (the engine's closed list of reasons), after the general text.
  if (error.code === "EXPORT_UNAVAILABLE" && error.exportReason !== undefined) base = `${base} ${EXPORT_UNAVAILABLE_REASONS_RU[error.exportReason]}`;
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
    default:
      return null;
  }
}

const SETTINGS_LINK_LABELS: Record<SettingsFocus, string> = {
  key: "Открыть ключ в Настройках",
  money: "Открыть деньги в Настройках",
  export: "Открыть папку в Настройках",
};

export function settingsLinkLabel(focus: SettingsFocus): string {
  return SETTINGS_LINK_LABELS[focus];
}
