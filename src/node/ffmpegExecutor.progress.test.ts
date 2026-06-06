import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FfmpegExecutor } from "./ffmpegExecutor";
import { makeTestClip } from "./testClip";
import { sampleRecipe } from "../core/sampler";

let dir: string;
let input: string;
const exec = new FfmpegExecutor();

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "uniq-prog-"));
  input = join(dir, "in.mp4");
  makeTestClip(input);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("render reports increasing progress ending near 1", async () => {
  const info = await exec.probe(input);
  const recipe = sampleRecipe(
    { strength: 1.0, exportFormat: "square", keepTrendAudio: false, allowMirror: false, targetDistance: 90 },
    7, 1
  );
  const seen: number[] = [];
  await exec.render(input, info, recipe, join(dir, "out.mp4"), (f) => seen.push(f));
  expect(seen.length).toBeGreaterThan(0);
  expect(Math.max(...seen)).toBeGreaterThan(0.5);
  expect(seen[seen.length - 1]).toBe(1);
}, 60000);
