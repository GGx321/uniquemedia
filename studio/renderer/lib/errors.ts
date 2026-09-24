import { ERROR_MESSAGES_RU, type EngineError, type ErrorCode } from "../../shared/engine";
import type { SettingsFocus } from "../navigation";
import { waitLabel } from "./format";

/** The Russian text for an engine error, plus the wait when the engine gave one. */
export function errorText(error: EngineError): string {
  const base = ERROR_MESSAGES_RU[error.code];
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
