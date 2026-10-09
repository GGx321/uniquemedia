import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { markPublished, PublishedUnreadableError, publishedPath, readPublished } from "./published";
import { useWorld, type World } from "./testing/kit";
useNativeGlobals();

// S4.5c (plan §8.4): the owner's «Опубликовано» marks are an append-only log beside `rejected.jsonl`, `avatars/<avatarId>/published.jsonl`, because the video records are write-once.
// Each line is `{ videoId, published, at }` and the LAST line of a video wins. A log that cannot be read leaves every mark UNKNOWN; nothing else depends on it.

const world = useWorld();
const T1 = "2026-10-09T10:00:00.000Z";
const T2 = "2026-10-09T11:00:00.000Z";
const T3 = "2026-10-09T12:00:00.000Z";
const VIDEO = "video-00000001";
const OTHER = "video-00000002";

const logOf = (w: World): string => publishedPath(w.libraryRoot, w.avatar.id);
const linesOf = async (w: World): Promise<string[]> => (await readFile(logOf(w), "utf8")).split("\n").filter((line) => line !== "");

async function writeRaw(w: World, text: string): Promise<void> {
  await mkdir(join(w.libraryRoot, "avatars", w.avatar.id), { recursive: true });
  await writeFile(logOf(w), text);
}

describe("reading the marks", () => {
  test("an avatar that was never marked has no log, which is not an unreadable one", async () => {
    const w = world();
    expect(await readPublished(w.libraryRoot, w.avatar.id)).toEqual({ state: "absent" });
  });

  test("a mark reads back with the time it was set", async () => {
    const w = world();
    await markPublished(w.libraryRoot, w.avatar.id, VIDEO, true, T1);
    const read = await readPublished(w.libraryRoot, w.avatar.id);
    expect(read.state === "ok" ? Object.fromEntries(read.at) : null).toEqual({ [VIDEO]: T1 });
  });

  test("the last line of a video wins: cleared, then set again, reads as set at the later time", async () => {
    const w = world();
    await markPublished(w.libraryRoot, w.avatar.id, VIDEO, true, T1);
    await markPublished(w.libraryRoot, w.avatar.id, VIDEO, false, T2);
    await markPublished(w.libraryRoot, w.avatar.id, VIDEO, true, T3);
    const read = await readPublished(w.libraryRoot, w.avatar.id);
    expect(read.state === "ok" ? Object.fromEntries(read.at) : null).toEqual({ [VIDEO]: T3 });
  });

  test("a cleared mark reads as no mark, and other videos are untouched", async () => {
    const w = world();
    await markPublished(w.libraryRoot, w.avatar.id, VIDEO, true, T1);
    await markPublished(w.libraryRoot, w.avatar.id, OTHER, true, T1);
    await markPublished(w.libraryRoot, w.avatar.id, VIDEO, false, T2);
    const read = await readPublished(w.libraryRoot, w.avatar.id);
    expect(read.state === "ok" ? [...read.at.keys()] : null).toEqual([OTHER]);
  });

  test("a line a later build added fields to is still read", async () => {
    const w = world();
    await writeRaw(w, `${JSON.stringify({ videoId: VIDEO, published: true, at: T1, photoIds: ["photo-00000001"] })}\n`);
    const read = await readPublished(w.libraryRoot, w.avatar.id);
    expect(read.state === "ok" ? [...read.at.keys()] : null).toEqual([VIDEO]);
  });
});

describe("writing a mark", () => {
  test("setting a mark that is already set appends nothing and keeps the first time", async () => {
    const w = world();
    await markPublished(w.libraryRoot, w.avatar.id, VIDEO, true, T1);
    const again = await markPublished(w.libraryRoot, w.avatar.id, VIDEO, true, T2);
    expect(await linesOf(w)).toHaveLength(1);
    expect(again).toEqual({ changed: false, at: T1 });
  });

  test("clearing a video that was never marked appends nothing", async () => {
    const w = world();
    const result = await markPublished(w.libraryRoot, w.avatar.id, VIDEO, false, T1);
    expect(result).toEqual({ changed: false, at: null });
    expect(await readPublished(w.libraryRoot, w.avatar.id)).toEqual({ state: "absent" });
  });

  test("a change is one more line; earlier lines are never rewritten", async () => {
    const w = world();
    await markPublished(w.libraryRoot, w.avatar.id, VIDEO, true, T1);
    const before = await linesOf(w);
    await markPublished(w.libraryRoot, w.avatar.id, VIDEO, false, T2);
    const after = await linesOf(w);
    expect(after.slice(0, 1)).toEqual(before);
    expect(after.map((line) => JSON.parse(line))).toEqual([
      { videoId: VIDEO, published: true, at: T1 },
      { videoId: VIDEO, published: false, at: T2 },
    ]);
  });

  test("two marks asked together are both written, in the order asked", async () => {
    const w = world();
    await Promise.all([markPublished(w.libraryRoot, w.avatar.id, VIDEO, true, T1), markPublished(w.libraryRoot, w.avatar.id, OTHER, true, T2)]);
    expect((await linesOf(w)).map((line) => JSON.parse(line).videoId)).toEqual([VIDEO, OTHER]);
  });
});

describe("a log that cannot be read", () => {
  test("a torn last line (an append a crash cut short) makes the marks unknown, whatever came before it", async () => {
    const w = world();
    await writeRaw(w, `${JSON.stringify({ videoId: VIDEO, published: true, at: T1 })}\n{"videoId":"video-0000`);
    expect(await readPublished(w.libraryRoot, w.avatar.id)).toEqual({ state: "unknown", reason: "torn" });
  });

  test("a complete line that is not JSON makes the marks unknown", async () => {
    const w = world();
    await writeRaw(w, `${JSON.stringify({ videoId: VIDEO, published: true, at: T1 })}\nnot json\n`);
    expect(await readPublished(w.libraryRoot, w.avatar.id)).toEqual({ state: "unknown", reason: "corrupt" });
  });

  test.each([
    ["a mark that is not a boolean", { videoId: VIDEO, published: "yes", at: T1 }],
    ["a video id that is a path", { videoId: "../video", published: true, at: T1 }],
    ["a time that is not a time", { videoId: VIDEO, published: true, at: "yesterday" }],
  ])("a complete line with %s makes the marks unknown", async (_name, line) => {
    const w = world();
    await writeRaw(w, `${JSON.stringify(line)}\n`);
    expect(await readPublished(w.libraryRoot, w.avatar.id)).toEqual({ state: "unknown", reason: "corrupt" });
  });

  test("a corrupt log refuses a new mark and is left exactly as it was", async () => {
    const w = world();
    await writeRaw(w, "not json\n");
    await expect(markPublished(w.libraryRoot, w.avatar.id, VIDEO, true, T1)).rejects.toBeInstanceOf(PublishedUnreadableError);
    expect(await readFile(logOf(w), "utf8")).toBe("not json\n");
  });

  test("a torn tail is healed by the next mark, as every log of the library is: the tail is kept aside and the earlier marks are read again", async () => {
    const w = world();
    await writeRaw(w, `${JSON.stringify({ videoId: OTHER, published: true, at: T1 })}\n{"videoId":"video-0000`);
    await markPublished(w.libraryRoot, w.avatar.id, VIDEO, true, T2);
    const read = await readPublished(w.libraryRoot, w.avatar.id);
    expect(read.state === "ok" ? Object.fromEntries(read.at) : null).toEqual({ [OTHER]: T1, [VIDEO]: T2 });
    expect(await readFile(`${logOf(w)}.torn`, "utf8")).toContain('{"videoId":"video-0000');
  });

  test("the same mark asked again over a torn tail still heals it: the line is appended with the first time", async () => {
    const w = world();
    await markPublished(w.libraryRoot, w.avatar.id, VIDEO, true, T1);
    await writeFile(logOf(w), `${await readFile(logOf(w), "utf8")}{"videoId":"video-0000`);

    const result = await markPublished(w.libraryRoot, w.avatar.id, VIDEO, true, T2);

    expect(result.at).toBe(T1);
    const read = await readPublished(w.libraryRoot, w.avatar.id);
    expect(read.state === "ok" ? Object.fromEntries(read.at) : null).toEqual({ [VIDEO]: T1 });
    expect(await readFile(`${logOf(w)}.torn`, "utf8")).toContain('{"videoId":"video-0000');
  });

  test("a read that finds a torn tail changes nothing on disk", async () => {
    const w = world();
    const text = `${JSON.stringify({ videoId: OTHER, published: true, at: T1 })}\n{"videoId":"video-0000`;
    await writeRaw(w, text);
    await readPublished(w.libraryRoot, w.avatar.id);
    expect(await readFile(logOf(w), "utf8")).toBe(text);
  });
});
