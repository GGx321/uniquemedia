import { expect, spyOn } from "bun:test";
import { format, inspect } from "node:util";

// Test-only helpers for "the key never appears here" checks. A check for the whole key misses a mutation that
// prints a prefix, a slice or the decrypted text with padding, so these look for any fragment of the key.
//
// Test keys must be obviously fake AND free of words that legitimately appear in the code, the domains or the
// file names around them (rapidapi, secrets, key, flashapi ...), and must not be hex only (a hex fragment collides
// with random hex in scanned files). `Zq7-vKt9-Wm2x-Lp4s-0000` is the shape to use.

/**
 * Every window of `minLen` chars over the WHOLE key. A window never lies inside the last four chars alone (a status
 * may show those), so each one holds at least two chars the status never shows, and "a few chars plus the last
 * four" (`key.slice(-9)`) still contains one. A key shorter than `minLen` cannot be checked and throws, so an
 * assertion can never pass by checking nothing.
 */
export function keyFragments(key: string, minLen = 6): string[] {
  if (key.length < minLen) throw new Error(`a key of ${key.length} chars is too short to check for fragments (minimum ${minLen})`);
  const windows = new Set<string>();
  for (let i = 0; i + minLen <= key.length; i++) windows.add(key.slice(i, i + minLen));
  return [...windows];
}

/**
 * The text a fragment turns into when something prints its bytes as hex (either case) or base64 (standard and URL
 * alphabets). Base64 depends on where the fragment sits in the printed bytes, so it is rendered at all three
 * alignments, and the characters that also hold bits of the unknown neighbours (the first ones at an offset, the last
 * partial one) are cut off, leaving the part any placement must contain. The raw windows of a key hold `-`, which
 * neither form has, so only these forms can see an encoded key.
 */
export function encodedTextForms(fragment: string): string[] {
  const bytes = Buffer.from(fragment, "utf8");
  const forms = [bytes.toString("hex"), bytes.toString("hex").toUpperCase()];
  for (const pad of [0, 1, 2]) {
    const padded = Buffer.concat([Buffer.alloc(pad), bytes]);
    for (const encoding of ["base64", "base64url"] as const) {
      const text = padded.toString(encoding).replace(/=+$/, "");
      const lead = pad === 0 ? 0 : pad + 1;
      const partialTail = padded.length % 3 === 0 ? 0 : 1;
      forms.push(text.slice(lead, text.length - partialTail));
    }
  }
  return forms;
}

/** Fails when any `minLen`-char window of `key` appears in `text` (case-sensitive), raw or as hex or base64 text. */
export function expectNoKeyFragment(text: string, key: string, minLen = 6): void {
  const fragments = keyFragments(key, minLen);
  expect(fragments.filter((fragment) => text.includes(fragment))).toEqual([]);
  expect(fragments.filter((fragment) => encodedTextForms(fragment).some((form) => text.includes(form)))).toEqual([]);
}

/** The key's fragments as bytes in the forms a file or a stream could hold them: UTF-8, UTF-16 (both orders), base64 and hex. */
export function fragmentForms(key: string, minLen = 6): { name: string; bytes: Buffer }[] {
  return keyFragments(key, minLen).flatMap((fragment) => [
    { name: "utf8", bytes: Buffer.from(fragment, "utf8") },
    { name: "utf16le", bytes: Buffer.from(fragment, "utf16le") },
    { name: "utf16be", bytes: Buffer.from(fragment, "utf16le").swap16() },
    { name: "base64", bytes: Buffer.from(Buffer.from(fragment).toString("base64").replace(/=+$/, "")) },
    { name: "hex", bytes: Buffer.from(Buffer.from(fragment).toString("hex")) },
  ]);
}

const MAX_DEPTH = 6;

/** Everything a value could print, in the text forms the console would show and the ones it would not (`JSON.stringify(new Error(x))` is `{}`). */
function renderValue(value: unknown, depth: number, seen: Set<unknown>): string[] {
  if (typeof value === "string") return [value];
  if (typeof value !== "object" || value === null) return [String(value)];
  if (seen.has(value) || depth > MAX_DEPTH) return [];
  seen.add(value);
  const parts: string[] = [];
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
    const bytes = ArrayBuffer.isView(value) ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : Buffer.from(value);
    parts.push(bytes.toString("utf8"), bytes.toString("utf16le"), bytes.toString("latin1"), bytes.toString("hex"), bytes.toString("base64"));
    return parts;
  }
  if (value instanceof Error) parts.push(value.name, value.message, value.stack ?? "");
  if (value instanceof Map) for (const [k, v] of value) parts.push(...renderValue(k, depth + 1, seen), ...renderValue(v, depth + 1, seen));
  else if (value instanceof Set) for (const v of value) parts.push(...renderValue(v, depth + 1, seen));
  for (const name of Reflect.ownKeys(value)) {
    parts.push(String(name));
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor !== undefined && "value" in descriptor) parts.push(...renderValue(descriptor.value, depth + 1, seen));
  }
  return parts;
}

/** What one console call prints, and what is inside its arguments. */
export function renderConsoleCall(args: readonly unknown[]): string {
  const parts = [format(...args), inspect(args, { depth: MAX_DEPTH, showHidden: true })];
  for (const arg of args) parts.push(...renderValue(arg, 0, new Set()));
  return parts.join("\n");
}

const LEVELS = ["log", "info", "warn", "error", "debug", "trace", "dir", "table"] as const;

/** Captures every console level until `restore()`; `text()` is everything printed, each call rendered as the console prints it and as its arguments hold it. */
export function captureConsole() {
  const spies = LEVELS.map((level) => spyOn(console, level).mockImplementation(() => {}));
  return {
    text: () => spies.flatMap((spy) => spy.mock.calls.map((args: unknown[]) => renderConsoleCall(args))).join("\n"),
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}
