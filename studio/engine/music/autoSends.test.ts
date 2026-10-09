import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { AUTO_REFRESH_MAX_AUTO_SENDS, AUTO_REFRESH_WINDOW_MS } from "./autoRefresh";
import { AUTO_SENDS_FILE, AutoSendsLog } from "./autoSends";
useNativeGlobals();

// `userData/music/auto-sends.jsonl` (Stage 4, S4.5d; plan §7): one `{ id, at }` line per automatic refresh, written and fsynced BEFORE the request goes to the quota ledger.
// The count of automatic sends is the lines in the rolling 31 days. A torn or unreadable file counts as 10: the safe side, no automatic refresh.

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const HOUR = 3600 * 1000;

let dir = "";
let path = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "studio-auto-sends-"));
  path = join(dir, "music", AUTO_SENDS_FILE);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const log = () => new AutoSendsLog(path);
const seed = async (text: string): Promise<void> => {
  await mkdir(join(dir, "music"), { recursive: true });
  await writeFile(path, text);
};
const lineOf = (id: string, at: number) => `${JSON.stringify({ id, at })}\n`;

describe("the file's name", () => {
  test("is auto-sends.jsonl", () => {
    expect(AUTO_SENDS_FILE).toBe("auto-sends.jsonl");
  });
});

describe("counting", () => {
  test("no file: no automatic send, none last", async () => {
    expect(await log().summary(NOW)).toEqual({ count: 0, lastAt: null, damaged: false });
  });

  test("the lines in the window are counted and the latest time is told", async () => {
    await seed(lineOf("a", NOW - 5 * HOUR) + lineOf("b", NOW - 2 * HOUR) + lineOf("c", NOW - 9 * HOUR));
    expect(await log().summary(NOW)).toEqual({ count: 3, lastAt: NOW - 2 * HOUR, damaged: false });
  });

  test("a line leaves the window after 31 days: one just inside counts, one exactly 31 days old does not", async () => {
    await seed(lineOf("old", NOW - AUTO_REFRESH_WINDOW_MS) + lineOf("edge", NOW - AUTO_REFRESH_WINDOW_MS + 1));
    expect(await log().summary(NOW)).toEqual({ count: 1, lastAt: NOW - AUTO_REFRESH_WINDOW_MS + 1, damaged: false });
  });

  test("a line out of the window still reads, but is not the latest automatic send", async () => {
    await seed(lineOf("old", NOW - 40 * 24 * HOUR));
    expect(await log().summary(NOW)).toEqual({ count: 0, lastAt: null, damaged: false });
  });
});

describe("a torn tail means no request was sent (the line is fsynced before the reserve)", () => {
  test("is moved to .torn and the whole lines are counted", async () => {
    await seed(`${lineOf("a", NOW - 5 * HOUR)}${lineOf("b", NOW - 2 * HOUR)}{"id":"c","at":17`);
    expect(await log().summary(NOW)).toEqual({ count: 2, lastAt: NOW - 2 * HOUR, damaged: false });
    expect(await readFile(`${path}.torn`, "utf8")).toContain('{"id":"c","at":17');
    expect((await readFile(path, "utf8")).endsWith("\n")).toBe(true);
  });

  test("a torn tail alone (nothing whole before it) counts as none", async () => {
    await seed('{"id":"c","at":17');
    expect(await log().summary(NOW)).toEqual({ count: 0, lastAt: null, damaged: false });
  });
});

describe("a damaged file counts as the limit (10), the safe side", () => {
  test("a broken whole line followed by a torn tail", async () => {
    await seed(`${lineOf("a", NOW - HOUR)}nonsense\n{"id":"b","at":17`);
    expect(await log().summary(NOW)).toEqual({ count: AUTO_REFRESH_MAX_AUTO_SENDS, lastAt: null, damaged: true });
  });

  test("a complete line that is not JSON", async () => {
    await seed(`${lineOf("a", NOW - HOUR)}nonsense\n`);
    expect((await log().summary(NOW)).count).toBe(AUTO_REFRESH_MAX_AUTO_SENDS);
  });

  test("a line that breaks the schema: a time outside 2000 to 2100, an extra field, a missing id", async () => {
    for (const bad of [{ id: "a", at: 1 }, { id: "a", at: NOW, extra: true }, { at: NOW }]) {
      await seed(`${JSON.stringify(bad)}\n`);
      expect(await log().summary(NOW)).toEqual({ count: AUTO_REFRESH_MAX_AUTO_SENDS, lastAt: null, damaged: true });
    }
  });

  test("a file that cannot be read (a folder in its place)", async () => {
    await mkdir(path, { recursive: true });
    expect(await log().summary(NOW)).toEqual({ count: AUTO_REFRESH_MAX_AUTO_SENDS, lastAt: null, damaged: true });
  });
});

describe("recording", () => {
  test("makes the music folder, writes { id, at } and counts it", async () => {
    await log().record("refresh-0001", NOW);
    expect((await readFile(path, "utf8")).split("\n")).toEqual([JSON.stringify({ id: "refresh-0001", at: NOW }), ""]);
    expect(await log().summary(NOW)).toEqual({ count: 1, lastAt: NOW, damaged: false });
  });

  test("appends: two records are two lines, in order", async () => {
    await log().record("one", NOW - HOUR);
    await log().record("two", NOW);
    expect((await readFile(path, "utf8")).split("\n").filter((l) => l !== "")).toEqual([JSON.stringify({ id: "one", at: NOW - HOUR }), JSON.stringify({ id: "two", at: NOW })]);
  });

  test("a record over a torn tail heals it: the tail goes to .torn, the new line is whole, and the whole lines are counted", async () => {
    await seed(`${lineOf("a", NOW - HOUR)}{"id":"b"`);
    await log().record("c", NOW);
    expect((await readFile(path, "utf8")).split("\n")).toEqual([JSON.stringify({ id: "a", at: NOW - HOUR }), JSON.stringify({ id: "c", at: NOW }), ""]);
    expect(await readFile(`${path}.torn`, "utf8")).toContain('{"id":"b"');
    expect(await log().summary(NOW)).toEqual({ count: 2, lastAt: NOW, damaged: false });
  });

  test("a record over a file with a broken WHOLE line refuses and leaves it as it was", async () => {
    const broken = `${lineOf("a", NOW - HOUR)}nonsense\n`;
    await seed(broken);
    await expect(log().record("c", NOW)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(broken);
    expect((await log().summary(NOW)).damaged).toBe(true);
  });

  test("a time that is not a real date is refused and nothing is written", async () => {
    await expect(log().record("a", 0)).rejects.toThrow();
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });
});
