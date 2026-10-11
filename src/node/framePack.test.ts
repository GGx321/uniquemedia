import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listFrameBackgrounds } from "./framePack";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "uniq-pack-"));
  for (const name of ["b.jpg", "a.jpg", "c.JPG", "CREDITS.json", "notes.txt"]) {
    writeFileSync(join(dir, name), "x");
  }
  mkdirSync(join(dir, "sub.jpg"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("lists the jpg files of the pack by name, as absolute paths", async () => {
  expect(await listFrameBackgrounds(dir)).toEqual([join(dir, "a.jpg"), join(dir, "b.jpg"), join(dir, "c.JPG")]);
});

test("ignores the credits file, other files and folders named like images", async () => {
  const names = (await listFrameBackgrounds(dir)).map((p) => p.slice(dir.length + 1));
  expect(names).not.toContain("CREDITS.json");
  expect(names).not.toContain("notes.txt");
  expect(names).not.toContain("sub.jpg");
});

test("a pack folder with no image is refused with the folder named", async () => {
  const empty = mkdtempSync(join(tmpdir(), "uniq-pack-empty-"));
  try {
    await expect(listFrameBackgrounds(empty)).rejects.toThrow(empty);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("a pack folder that does not exist is refused with the folder named", async () => {
  const missing = join(dir, "nope");
  await expect(listFrameBackgrounds(missing)).rejects.toThrow(missing);
});
