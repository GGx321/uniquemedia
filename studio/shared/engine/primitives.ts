import { z } from "zod";

/**
 * Every id in the contract (message, avatar, draft, candidate, job, run, photo).
 * Lowercase only and no path characters, so an id can never escape a folder
 * when main or the engine builds a path from it (invariant 12).
 */
export const Id = z.string().regex(/^[a-z0-9-]{8,64}$/, "must be 8-64 chars of a-z, 0-9 or -");

/** Money: integer micro-dollars ($1 = 1_000_000). Never a float (invariant 2). */
export const Micros = z.number().int().nonnegative();

/** A non-negative integer count. */
export const Count = z.number().int().nonnegative();

/** An OpenRouter model id such as `x-ai/grok-4.3`. */
export const ModelId = z
  .string()
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/, "must look like vendor/model");

const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC = /^\\\\[^\\]/;

/**
 * An absolute filesystem path (POSIX, Windows drive or UNC) without `..` segments.
 * main still resolves it with `realpath`; this only rejects the obviously wrong.
 */
export const AbsolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => !p.includes("\0"), "must not contain a NUL byte")
  .refine((p) => p.startsWith("/") || WINDOWS_DRIVE.test(p) || WINDOWS_UNC.test(p), "must be absolute")
  .refine((p) => !p.split(/[\\/]/).includes(".."), "must not contain a .. segment");

/** An API key as typed by the user: printable ASCII, no whitespace. */
export const ApiKey = z
  .string()
  .min(8)
  .max(256)
  .regex(/^[\x21-\x7e]+$/, "must be printable ASCII without spaces");

const SECRET_PATTERNS: [RegExp, string][] = [
  [/\b(Bearer)\s+\S+/gi, "$1 [redacted]"],
  [/sk-or-\S*/gi, "[redacted]"],
  [/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g, "[redacted]"],
];

/** Replaces anything that looks like an API key or a bearer token with `[redacted]`. */
export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

/**
 * Free diagnostic text that may reach the renderer. Keys and bearer tokens are
 * stripped on parse, so a provider error cannot carry them out (invariant 10).
 */
export const SafeText = z.string().max(500).transform(redactSecrets);
