import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PhotoExecutor } from "./photoExecutor";
import { makeTestPhoto } from "./testClip";
import { samplePhotoRecipe } from "../core/photo/sampler";
import { uniquify, type CopyResult } from "../core/pipeline";
import { computePdqHash } from "../core/pdq/pdq";
import { hammingDistance } from "../core/pdq/hamming";
import type { PhotoRecipe, ResolvedPhotoOptions } from "../core/photo/types";

/** Calibrated on the mandelbrot fixture, which is the HARD case: PDQ is close
 *  to invariant under tone and noise on detailed content, so a smooth image
 *  would clear this by a wide margin. Matches the video path's default. */
const TARGET = 38;
const COPIES = 3;
const INTER_THRESHOLD = 8; // the pipeline's own default

const exec = new PhotoExecutor();
let dir: string;
let input: string;
let results: CopyResult<PhotoRecipe>[];
let interCopy: number[];

const opts: ResolvedPhotoOptions = {
  strength: 1.0,
  exportFormat: "original",
  allowMirror: false,
  targetDistance: TARGET,
  identity: "engine",
  // These predate the edge option and pin the crop behaviour they were
  // written against; the fit direction has its own tests.
  edge: { mode: "crop" },
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "uniq-photo-e2e-"));
  input = join(dir, "in.jpg");
  makeTestPhoto(input, 1440, 1080);

  results = await uniquify(input, opts, exec, COPIES, {
    seedBase: 2000,
    // A still has one frame; the executor returns one whatever it is asked for.
    framesPerCopy: 1,
    maxAttempts: 4,
    outputPath: (i) => join(dir, `copy_${i + 1}.jpg`),
    sampleRecipe: samplePhotoRecipe,
  });

  const sigs = await Promise.all(
    results.map(async (r) => computePdqHash((await exec.extractGrayFrames(r.outputPath, 1))[0]))
  );
  interCopy = [];
  for (let i = 0; i < sigs.length; i++) {
    for (let j = i + 1; j < sigs.length; j++) interCopy.push(hammingDistance(sigs[i], sigs[j]));
  }

  console.log(
    `[photo-e2e] target=${TARGET} vsOriginal=${results.map((r) => r.verify.minDistance).join(",")} ` +
      `intensity=${results.map((r) => Number(r.recipe.intensity.toFixed(2))).join(",")} ` +
      `interCopy=${interCopy.join(",")}`
  );
}, 180_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("produces the requested number of copies", () => {
  expect(results.length).toBe(COPIES);
});

test("every copy clears the PDQ target against the original", () => {
  for (const r of results) {
    expect(r.verify.passed).toBe(true);
    expect(r.verify.minDistance).toBeGreaterThanOrEqual(TARGET);
  }
});

test("every copy also differs from every other copy", () => {
  // The whole point of N copies: two that match each other are one copy twice.
  expect(interCopy.length).toBe((COPIES * (COPIES - 1)) / 2);
  for (const d of interCopy) expect(d).toBeGreaterThanOrEqual(INTER_THRESHOLD);
});

test("no two copies are byte-identical", () => {
  const digests = results.map((r) => Bun.hash(readFileSync(r.outputPath)).toString());
  expect(new Set(digests).size).toBe(COPIES);
});

test("every copy is a decodable JPEG at the source size", async () => {
  for (const r of results) {
    const info = await exec.probe(r.outputPath);
    expect(info.kind).toBe("photo");
    expect(info.width).toBe(1440);
    expect(info.height).toBe(1080);
  }
});

test("the pipeline verifies each copy on exactly one frame", () => {
  // `framesPerCopy: 1` and the executor's single-frame contract must agree, or
  // verification silently compares a frame that was never rendered.
  for (const r of results) expect(r.verify.perFrame.length).toBe(1);
});

test("each copy carries its own recipe", () => {
  const seeds = new Set(results.map((r) => r.recipe.seed));
  expect(seeds.size).toBe(COPIES);
});
