import { expect, spyOn } from "bun:test";

// Test-only helpers for "the key never appears here" checks. A check for the whole key misses a mutation that
// prints a prefix, a slice or the decrypted text with padding, so these look for any fragment of the key.

/** Every window of `minLen` chars of the key without its last four (the part a status may show). Any longer shared substring contains one. */
export function keyFragments(key: string, minLen = 6): string[] {
  const head = key.slice(0, -4);
  const windows = new Set<string>();
  for (let i = 0; i + minLen <= head.length; i++) windows.add(head.slice(i, i + minLen));
  return [...windows];
}

/** Fails when any `minLen`-char substring of `key.slice(0, -4)` appears in `text` (case-sensitive). */
export function expectNoKeyFragment(text: string, key: string, minLen = 6): void {
  expect(keyFragments(key, minLen).filter((fragment) => text.includes(fragment))).toEqual([]);
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

/** Captures every console level until `restore()`; `text()` is what was printed. */
export function captureConsole() {
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) => spyOn(console, level).mockImplementation(() => {}));
  return {
    text: () => JSON.stringify(spies.flatMap((spy) => spy.mock.calls)),
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}
