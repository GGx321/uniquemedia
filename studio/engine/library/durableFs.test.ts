import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { appendJsonLine, readJsonl, writeJsonAtomic } from "./durableFs";
import { expectLibraryError, rejectionOf, tempFilesIn, useTempDir } from "./testing/helpers";

const dir = useTempDir("studio-durable-");
const Entry = z.object({ n: z.int() });

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

describe("writeJsonAtomic", () => {
  test("writes a value that reads back equal and leaves no temp file", async () => {
    const path = join(dir(), "doc.json");
    await writeJsonAtomic(path, { a: 1, b: ["x"] });
    expect(await readJson(path)).toEqual({ a: 1, b: ["x"] });
    expect(await tempFilesIn(dir())).toEqual([]);
  });

  test("replaces an existing file", async () => {
    const path = join(dir(), "doc.json");
    await writeJsonAtomic(path, { v: 1 });
    await writeJsonAtomic(path, { v: 2 });
    expect(await readJson(path)).toEqual({ v: 2 });
  });

  test("a crash between the temp write and the rename leaves the old file intact", async () => {
    const path = join(dir(), "doc.json");
    await writeJsonAtomic(path, { v: 1 });
    const crash = new Error("simulated crash");

    const error = await rejectionOf(
      writeJsonAtomic(path, { v: 2 }, { beforeRename: () => { throw crash; } })
    );

    expect(error).toBe(crash);
    expect(await readJson(path)).toEqual({ v: 1 });
    // A real crash would leave the fully written temp file behind.
    const temps = await tempFilesIn(dir());
    expect(temps).toHaveLength(1);
    expect(await readJson(join(dir(), temps[0]))).toEqual({ v: 2 });
  });
});

describe("readJsonl", () => {
  test("a missing file reads as no entries and no torn line", async () => {
    expect(await readJsonl(join(dir(), "none.jsonl"), Entry)).toEqual({ entries: [], torn: null });
  });

  test("returns entries in file order", async () => {
    const path = join(dir(), "log.jsonl");
    await writeFile(path, '{"n":1}\n{"n":2}\n{"n":3}\n');
    expect(await readJsonl(path, Entry)).toEqual({ entries: [{ n: 1 }, { n: 2 }, { n: 3 }], torn: null });
  });

  test("reports a torn last line without a newline and does not return it", async () => {
    const path = join(dir(), "log.jsonl");
    await writeFile(path, '{"n":1}\n{"n":2}\n{"n":');
    expect(await readJsonl(path, Entry)).toEqual({ entries: [{ n: 1 }, { n: 2 }], torn: '{"n":' });
  });

  test("a complete line that is not JSON throws corrupt-log naming the line", async () => {
    const path = join(dir(), "log.jsonl");
    await writeFile(path, '{"n":1}\nnot json\n{"n":3}\n');
    const error = await expectLibraryError(readJsonl(path, Entry), "corrupt-log");
    expect(error.message).toContain(":2");
  });

  test("a complete line that fails the schema throws corrupt-log", async () => {
    const path = join(dir(), "log.jsonl");
    await writeFile(path, '{"n":1}\n{"n":"two"}\n');
    await expectLibraryError(readJsonl(path, Entry), "corrupt-log");
  });
});

describe("appendJsonLine", () => {
  test("appends newline-terminated lines that read back in order", async () => {
    const path = join(dir(), "log.jsonl");
    await appendJsonLine(path, { n: 1 });
    await appendJsonLine(path, { n: 2 });
    expect(await readFile(path, "utf8")).toBe('{"n":1}\n{"n":2}\n');
  });

  test("moves a torn tail to <file>.torn before appending, so the new line stays intact", async () => {
    const path = join(dir(), "log.jsonl");
    await writeFile(path, '{"n":1}\n{"n":');

    await appendJsonLine(path, { n: 2 });

    expect(await readJsonl(path, Entry)).toEqual({ entries: [{ n: 1 }, { n: 2 }], torn: null });
    expect(await readFile(`${path}.torn`, "utf8")).toBe('{"n":\n');
  });

  test("a read issued while an append is in flight sees that append, never a half line", async () => {
    const path = join(dir(), "log.jsonl");
    await appendJsonLine(path, { n: 0 });

    const pending = appendJsonLine(path, { n: 1 });
    const read = await readJsonl(path, Entry);
    await pending;

    expect(read).toEqual({ entries: [{ n: 0 }, { n: 1 }], torn: null });
  });

  test("concurrent appends onto a torn tail all land and the tail is moved exactly once", async () => {
    const path = join(dir(), "log.jsonl");
    await writeFile(path, '{"n":0}\n{"n":');

    await Promise.all(Array.from({ length: 20 }, (_, i) => appendJsonLine(path, { n: i + 1 })));

    const { entries, torn } = await readJsonl(path, Entry);
    expect(torn).toBeNull();
    expect(entries.map((e) => e.n).sort((a, b) => a - b)).toEqual(Array.from({ length: 21 }, (_, i) => i));
    expect(await readFile(`${path}.torn`, "utf8")).toBe('{"n":\n');
  });
});
