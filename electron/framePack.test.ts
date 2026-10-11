import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractFramePack } from "./framePack";

let root: string;
let source: string;
let dest: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uniq-extract-"));
  source = join(root, "asar-side");
  dest = join(root, "user-data", "frame-backgrounds");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "a.jpg"), "AAAA");
  writeFileSync(join(source, "b.jpg"), "BBBBBB");
  writeFileSync(join(source, "CREDITS.json"), "[]");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("copies the pack's images out to the destination folder, creating it", async () => {
  await extractFramePack(source, dest);
  expect(readdirSync(dest).sort()).toEqual(["CREDITS.json", "a.jpg", "b.jpg"]);
  expect(readFileSync(join(dest, "b.jpg"), "utf8")).toBe("BBBBBB");
});

test("a second run leaves the files that are already there untouched", async () => {
  await extractFramePack(source, dest);
  writeFileSync(join(dest, "a.jpg"), "AAAA"); // same size, same name
  const before = readFileSync(join(dest, "a.jpg"));
  await extractFramePack(source, dest);
  expect(readFileSync(join(dest, "a.jpg")).equals(before)).toBe(true);
});

test("a file whose size differs from the shipped one is replaced", async () => {
  await extractFramePack(source, dest);
  writeFileSync(join(dest, "a.jpg"), "truncated-by-a-crash".slice(0, 2));
  await extractFramePack(source, dest);
  expect(readFileSync(join(dest, "a.jpg"), "utf8")).toBe("AAAA");
});

test("a missing source folder is refused with the folder named", async () => {
  const missing = join(root, "nope");
  await expect(extractFramePack(missing, dest)).rejects.toThrow(missing);
});
