import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listFrameBackgrounds, readFramePackNames } from "./framePack";

let dir: string;

const credits = (...files: string[]): string => JSON.stringify(files.map((file) => ({ file })));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "uniquemedia-pack-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function pack(listed: string[], onDisk: string[] = listed): void {
  writeFileSync(join(dir, "CREDITS.json"), credits(...listed));
  for (const name of onDisk) writeFileSync(join(dir, name), "x");
}

test("lists the images CREDITS.json names, by name, as absolute paths", async () => {
  pack(["b.jpg", "a.jpg", "c.jpg"]);
  expect(await listFrameBackgrounds(dir)).toEqual([join(dir, "a.jpg"), join(dir, "b.jpg"), join(dir, "c.jpg")]);
});

test("an image on disk that CREDITS.json does not name is not in the rotation", async () => {
  pack(["a.jpg"], ["a.jpg", "stale.jpg"]);
  expect(await listFrameBackgrounds(dir)).toEqual([join(dir, "a.jpg")]);
});

test("a folder named like an image is not an image", async () => {
  pack(["a.jpg", "sub.jpg"], ["a.jpg"]);
  mkdirSync(join(dir, "sub.jpg"));
  await expect(listFrameBackgrounds(dir)).rejects.toThrow("sub.jpg");
});

test("an image CREDITS.json names but the folder lacks is refused with its name", async () => {
  pack(["a.jpg", "gone.jpg"], ["a.jpg"]);
  await expect(listFrameBackgrounds(dir)).rejects.toThrow("gone.jpg");
});

test("a pack with no CREDITS.json is refused with the folder named", async () => {
  writeFileSync(join(dir, "a.jpg"), "x");
  await expect(listFrameBackgrounds(dir)).rejects.toThrow(dir);
});

test("a pack whose credits list nothing is refused with the folder named", async () => {
  pack([]);
  await expect(listFrameBackgrounds(dir)).rejects.toThrow(dir);
});

test("a pack folder that does not exist is refused with the folder named", async () => {
  const missing = join(dir, "nope");
  await expect(listFrameBackgrounds(missing)).rejects.toThrow(missing);
});

test.each(["../escape.jpg", "sub/a.jpg", "a.png", ""])("a credit naming %p is refused", async (name) => {
  writeFileSync(join(dir, "CREDITS.json"), credits(name));
  await expect(readFramePackNames(dir)).rejects.toThrow();
});

test("credits that are not a list of objects with a file are refused", async () => {
  writeFileSync(join(dir, "CREDITS.json"), JSON.stringify({ file: "a.jpg" }));
  await expect(readFramePackNames(dir)).rejects.toThrow(dir);
  writeFileSync(join(dir, "CREDITS.json"), JSON.stringify([{ nope: 1 }]));
  await expect(readFramePackNames(dir)).rejects.toThrow(dir);
});

test("the error texts are Russian, since the app shows them as they are", async () => {
  await expect(listFrameBackgrounds(join(dir, "nope"))).rejects.toThrow(/фон/i);
});
