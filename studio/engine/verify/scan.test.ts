import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { scanForNeedles, type Needle } from "./scan";
useNativeGlobals();

// The streaming string scan: a needle must be found wherever it falls
// relative to the chunk boundaries, and only where it is whole.

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "studio-verify-scan-"));
});
afterAll(() => dir && rmSync(dir, { recursive: true, force: true }));

const needle = (label: string, text: string): Needle => ({ label, bytes: Uint8Array.from(text, (c) => c.charCodeAt(0)) });

async function scan(content: string, needles: readonly Needle[], chunk: number) {
  const path = join(dir, `f-${Math.random().toString(36).slice(2)}.bin`);
  writeFileSync(path, content, "latin1");
  const handle = await open(path, "r");
  try {
    return await scanForNeedles(handle, path, content.length, needles, chunk);
  } finally {
    await handle.close();
  }
}

describe("scanForNeedles", () => {
  test("finds a needle in the middle of one chunk, with its offset", async () => {
    expect(await scan("....FINDME....", [needle("a", "FINDME")], 1024)).toEqual([{ label: "a", offset: 4 }]);
  });

  test("finds a needle that straddles a chunk boundary", async () => {
    // FINDME spans bytes 6..11; with 8-byte chunks the boundary is inside it.
    expect(await scan("......FINDME......", [needle("a", "FINDME")], 8)).toEqual([{ label: "a", offset: 6 }]);
  });

  test.each([1, 2, 3, 5, 6, 7])("finds the needle wherever the boundary falls (chunk of %i bytes)", async (chunk) => {
    expect(await scan("xxFINDMExx", [needle("a", "FINDME")], chunk)).toEqual([{ label: "a", offset: 2 }]);
  });

  test("finds a needle at the very start and at the very end of the file", async () => {
    const hits = await scan("STARTxxxxxxEND", [needle("s", "START"), needle("e", "END")], 4);
    expect(hits).toEqual([{ label: "s", offset: 0 }, { label: "e", offset: 11 }]);
  });

  test("does not report a needle the file ends in the middle of", async () => {
    expect(await scan("xxxxFIND", [needle("a", "FINDME")], 3)).toEqual([]);
  });

  test("reports each needle once, at its first occurrence", async () => {
    expect(await scan("ab..ab..ab", [needle("a", "ab")], 4)).toEqual([{ label: "a", offset: 0 }]);
  });

  test("reports nothing for a file that holds no needle", async () => {
    expect(await scan("nothing to see", [needle("a", "FINDME")], 4)).toEqual([]);
  });

  test("reports nothing for an empty file", async () => {
    expect(await scan("", [needle("a", "FINDME")], 4)).toEqual([]);
  });

  test("finds a needle whose bytes include NUL", async () => {
    expect(await scan("ab\u0000\u0000cd", [needle("a", "b\u0000\u0000c")], 3)).toEqual([{ label: "a", offset: 1 }]);
  });
});
