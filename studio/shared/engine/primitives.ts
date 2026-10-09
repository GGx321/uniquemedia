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

/**
 * The RapidAPI key as typed or pasted: trimmed, then 8 to 256 printable ASCII
 * chars with no whitespace or control character inside (the trim runs first, so
 * a pasted trailing newline is fine). Eight is the floor because the status
 * shows the last four; the key's own format is RapidAPI's to change, so nothing
 * finer is checked.
 */
export const MusicKey = z
  .string()
  .max(1024)
  .trim()
  .min(8)
  .max(256)
  .regex(/^[\x21-\x7e]+$/, "must be printable ASCII without spaces");

const SECRET_PATTERNS: [RegExp, string][] = [
  [/\b(Bearer)\s+\S+/gi, "$1 [redacted]"],
  [/sk-or-\S*/gi, "[redacted]"],
  [/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g, "[redacted]"],
  // A backstop for the RapidAPI key (the flashapi client redacts the exact key itself). The shape is the one RapidAPI's
  // public docs show: ten chars, `msh`, twelve, `p1`, six, `jsn`, twelve. The counts are loose on purpose (a slightly
  // different key is still caught), and the run must be alone, so ordinary words and hyphenated text are left alone.
  [/(?<![A-Za-z0-9])[A-Za-z0-9]{8,14}msh[A-Za-z0-9]{8,20}p1[A-Za-z0-9]{4,10}jsn[A-Za-z0-9]{8,20}(?![A-Za-z0-9])/g, "[redacted]"],
  // The header that carries it, in a header dump or a JSON echo of one: whatever follows the name goes.
  [/(x-rapidapi-key["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, "$1[redacted]"],
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

/**
 * A batch launch of the autopilot (Stage 4): `launch-` and a body of 8 to 57 characters of a-z, 0-9 and `-`, starting with a letter or a digit. It names a
 * file in the library (`autopilot/<launchId>.json`), so like every id it can carry no separator, dot or case. Issued by the engine, never by the renderer.
 */
export const LaunchId = z.string().regex(/^launch-[a-z0-9][a-z0-9-]{7,56}$/, "must be launch- and 8-57 chars of a-z, 0-9 or -");

/**
 * A video's place in its launch: the avatar's number in the launch (0 to 49) and the video's number (1 to 50), `<avatarIndex>-<n>`. Deterministic,
 * so a render submitted before a crash is found again by it (plan §3.4). Not an id of any file.
 */
export const LaunchVideoKey = z.string().regex(/^(?:[0-9]|[1-4][0-9])-(?:[1-9]|[1-4][0-9]|50)$/, "must be <avatar 0-49>-<video 1-50>");
