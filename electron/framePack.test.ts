import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractFramePack } from "./framePack";

let root: string;
let source: string;
let dest: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uniquemedia-extract-"));
  source = join(root, "asar-side");
  dest = join(root, "user-data", "frame-backgrounds");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "a.jpg"), "AAAA");
  writeFileSync(join(source, "b.jpg"), "BBBBBB");
  writeFileSync(join(source, "CREDITS.json"), JSON.stringify([{ file: "a.jpg" }, { file: "b.jpg" }]));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("copies the credited images and the credits out, creating the folder", async () => {
  await extractFramePack(source, dest);
  expect(readdirSync(dest).sort()).toEqual(["CREDITS.json", "a.jpg", "b.jpg"]);
  expect(readFileSync(join(dest, "b.jpg"), "utf8")).toBe("BBBBBB");
});

test("an image in the destination that the shipped credits do not name is removed", async () => {
  await extractFramePack(source, dest);
  writeFileSync(join(dest, "stale.jpg"), "old");
  await extractFramePack(source, dest);
  expect(readdirSync(dest).sort()).toEqual(["CREDITS.json", "a.jpg", "b.jpg"]);
});

test("an image the source folder holds but the credits do not name is not copied", async () => {
  writeFileSync(join(source, "extra.jpg"), "EEEE");
  await extractFramePack(source, dest);
  expect(readdirSync(dest)).not.toContain("extra.jpg");
});

test("a file with the shipped size but other bytes is replaced", async () => {
  await extractFramePack(source, dest);
  writeFileSync(join(dest, "a.jpg"), "ZZZZ"); // same size as "AAAA"
  await extractFramePack(source, dest);
  expect(readFileSync(join(dest, "a.jpg"), "utf8")).toBe("AAAA");
});

test("a file that already matches is left as it is", async () => {
  await extractFramePack(source, dest);
  const before = readdirSync(dest).sort();
  await extractFramePack(source, dest);
  expect(readdirSync(dest).sort()).toEqual(before);
  expect(readFileSync(join(dest, "a.jpg"), "utf8")).toBe("AAAA");
});

test("no temporary file is left behind", async () => {
  await extractFramePack(source, dest);
  expect(readdirSync(dest).filter((n) => n.includes(".tmp"))).toEqual([]);
});

test("a source folder without credits is refused with the folder named", async () => {
  rmSync(join(source, "CREDITS.json"));
  await expect(extractFramePack(source, dest)).rejects.toThrow(source);
});

test("a source folder that does not exist is refused with the folder named", async () => {
  const missing = join(root, "nope");
  await expect(extractFramePack(missing, dest)).rejects.toThrow(missing);
});
