import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FfmpegExecutor } from "./ffmpegExecutor";
import { makeTestClip } from "./testClip";

let dir: string;
let input: string;
const exec = new FfmpegExecutor();

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "uniq-thumb-"));
  input = join(dir, "in.mp4");
  makeTestClip(input);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("extractThumbnail returns a non-empty jpeg data url", async () => {
  const url = await exec.extractThumbnail(input);
  expect(url.startsWith("data:image/jpeg;base64,")).toBe(true);
  expect(url.length).toBeGreaterThan(200);
}, 60000);
