import { z } from "zod";
import {
  CommandMessage,
  CommandType,
  EngineCommandMessage,
  type ErrorResponse,
  ResponseMessage,
} from "./commands";
import { PROTOCOL_VERSION } from "./envelope";
import type { EngineError } from "./errors";
import { EventMessage } from "./events";
import { Id, redactSecrets } from "./primitives";

/** Any message on the wire: a command, its response, or an engine event. */
export const Message = z.discriminatedUnion("kind", [CommandMessage, ResponseMessage, EventMessage]);
export type Message = z.infer<typeof Message>;

export type ParseResult = { ok: true; message: Message } | { ok: false; reason: string };
export type EngineCommandParseResult = { ok: true; command: EngineCommandMessage } | { ok: false; reason: string };

type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Longest reason returned; matches the `detail` limit of an `EngineError`. */
const MAX_REASON = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(reason: string): { ok: false; reason: string } {
  const safe = redactSecrets(reason);
  return { ok: false, reason: safe.length <= MAX_REASON ? safe : `${safe.slice(0, MAX_REASON - 1)}…` };
}

function describeIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.map(String).join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

/**
 * Validates anything received over IPC against `schema`. Never throws: a
 * hostile or broken input yields `{ ok: false, reason }`. The reason names
 * paths and rules, never submitted values, has secrets stripped, and is safe
 * to forward as the `detail` of a VALIDATION error.
 */
function parseWith<T>(schema: z.ZodType<T>, input: unknown): Parsed<T> {
  try {
    if (!isRecord(input)) return fail("message must be an object");
    if (input.v !== PROTOCOL_VERSION) return fail(`v: unsupported protocol version, expected ${PROTOCOL_VERSION}`);
    const parsed = schema.safeParse(input);
    return parsed.success ? { ok: true, value: parsed.data } : fail(describeIssues(parsed.error.issues));
  } catch {
    return fail("message could not be read");
  }
}

/** Parses any contract message (renderer and main side). */
export function parseMessage(input: unknown): ParseResult {
  const r = parseWith(Message, input);
  return r.ok ? { ok: true, message: r.value } : r;
}

/** Parses what the engine may receive: a command, never a main-only key command. */
export function parseEngineCommand(input: unknown): EngineCommandParseResult {
  const r = parseWith(EngineCommandMessage, input);
  return r.ok ? { ok: true, command: r.value } : r;
}

function readField<T>(input: unknown, key: string, schema: z.ZodType<T>): T | null {
  try {
    if (!isRecord(input)) return null;
    const r = schema.safeParse(input[key]);
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/**
 * An error response for a command that failed or could not be parsed, keeping
 * whatever `id` and `type` can be read so the caller is not left waiting.
 * Never throws.
 */
export function errorResponseFor(input: unknown, error: EngineError): ErrorResponse {
  return {
    v: PROTOCOL_VERSION,
    id: readField(input, "id", Id),
    kind: "response",
    type: readField(input, "type", CommandType),
    ok: false,
    error,
  };
}
