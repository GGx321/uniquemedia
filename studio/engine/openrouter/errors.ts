import type { FailureKind } from "./types";

/**
 * NO_API_KEY, INVALID_API_KEY, BASE_URL_NOT_ALLOWED: thrown when the client is
 * created, before any request. A FailureKind: thrown by `fetchCredits`.
 */
export type OpenRouterErrorCode = "NO_API_KEY" | "INVALID_API_KEY" | "BASE_URL_NOT_ALLOWED" | FailureKind;

/** Messages are redacted: they never carry the key. */
export class OpenRouterError extends Error {
  readonly code: OpenRouterErrorCode;
  readonly httpStatus: number | null;

  constructor(code: OpenRouterErrorCode, message: string, options: { httpStatus?: number | null } = {}) {
    super(message);
    this.name = "OpenRouterError";
    this.code = code;
    this.httpStatus = options.httpStatus ?? null;
  }
}
