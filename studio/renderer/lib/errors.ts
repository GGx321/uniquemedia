import { AGE_CHECK_ALREADY_REFUSED_DETAIL, ERROR_MESSAGES_RU, type EngineError, type ErrorCode } from "../../shared/engine";
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

/** The Russian text for an engine error, plus the wait when the engine gave one. */
export function errorText(error: EngineError): string {
  const base = error.code === "AGE_CHECK_FAILED" && error.detail === AGE_CHECK_ALREADY_REFUSED_DETAIL ? AGE_CHECK_ALREADY_REFUSED_RU : ERROR_MESSAGES_RU[error.code];
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
    default:
      return null;
  }
}

export function settingsLinkLabel(focus: SettingsFocus): string {
  return focus === "key" ? "Открыть ключ в Настройках" : "Открыть деньги в Настройках";
}
