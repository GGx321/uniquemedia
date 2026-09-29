/**
 * What a failed smoke check may print about its evidence. A recorded mock
 * request holds its Authorization header, every header and whole bodies (a
 * prompt, a descriptor): none of that belongs in a log, so those keys are
 * dropped at any depth, and every string and the whole text are cut short.
 * What is left says what kind of request it was and where it went.
 */
const NEVER_PRINTED = new Set(["headers", "authorization", "body", "bodytext"]);
const MAX_STRING_CHARS = 200;
const MAX_TEXT_CHARS = 600;

export function failureDetail(detail: unknown): string {
  if (detail === undefined) return "";
  const text =
    JSON.stringify(detail, (key, value: unknown) => {
      if (NEVER_PRINTED.has(key.toLowerCase())) return undefined;
      return typeof value === "string" && value.length > MAX_STRING_CHARS ? `${value.slice(0, MAX_STRING_CHARS)}…` : value;
    }) ?? "";
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS - 1)}…` : text;
}
