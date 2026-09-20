import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exiftool, type Tags } from "exiftool-vendored";
import { PhotoExecutor } from "./photoExecutor";
import { makeTestPhoto } from "./testClip";
import { samplePhotoRecipe } from "../core/photo/sampler";
import { uniquify, type CopyResult } from "../core/pipeline";
import type { PhotoRecipe, ResolvedPhotoOptions } from "../core/photo/types";

/**
 * The inter-copy post-pass re-renders a copy that came out too close to an
 * earlier one. On real files, that render used to be the LAST thing to touch
 * the copy: the photo graph passes `-map_metadata -1`, so the file shipped with
 * no EXIF at all, and with the `Lavc…` comment the mjpeg encoder stamps on it —
 * while its neighbours in the same batch claimed to be an iPhone.
 *
 *   copy_1.jpg  Model=iPhone 11 Pro Max  Comment=-
 *   copy_2.jpg  Model=<<MISSING>>        Comment=Lavc60.3.100
 *
 * A batch that contradicts itself is a stronger tell than one that never
 * spoofed. This runs the real executor end to end because the defect was in
 * what reached the disk, not in what the pipeline believed.
 */

/** `readRaw` hands back group-qualified keys ("EXIF:Make") that `Tags` does not
 *  name, so widen it rather than reach past the typings. */
interface RawExif extends Tags {
  [key: string]: unknown;
}

const NOW_MS = 1_748_000_000_000; // fixed, so the capture dates are reproducible
const COPIES = 2;

const opts: ResolvedPhotoOptions = {
  strength: 1.0,
  exportFormat: "original",
  allowMirror: false,
  // Low enough that no copy needs a retry: this test is about the post-pass.
  targetDistance: 10,
  spoofMetadata: true,
  // These predate the edge option and pin the crop behaviour they were
  // written against; the fit direction has its own tests.
  edge: { mode: "crop" },
};

const exec = new PhotoExecutor();
let dir: string;
let results: CopyResult<PhotoRecipe>[];
const tags = new Map<string, RawExif>();

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "uniq-postpass-"));
  const input = join(dir, "in.jpg");
  makeTestPhoto(input, 640, 480);

  results = await uniquify(input, opts, exec, COPIES, {
    seedBase: 4100,
    framesPerCopy: 1,
    nowMs: NOW_MS,
    // 256 is the width of a PDQ hash, so every pair counts as "too close" and
    // the post-pass is guaranteed to fire. At the shipped default it fires on
    // ordinary settings too — 2 of 120 pairs in the reviewer's 16-copy batch —
    // but forcing it keeps this test from depending on which copies collide.
    interThreshold: 256,
    outputPath: (i) => join(dir, `copy_${i + 1}.jpg`),
    sampleRecipe: samplePhotoRecipe,
  });

  for (const r of results) {
    tags.set(r.outputPath, await exiftool.readRaw<RawExif>(r.outputPath, ["-n", "-G0"]));
  }
}, 180_000);

// NOTE: do not call `exiftool.end()` — it is a process-wide singleton shared
// with the other test files and with the executors, and ending it is
// irreversible ("BatchCluster has ended, cannot enqueue").
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const str = (t: RawExif, key: string): string => {
  const v = t[key];
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
};

test("the post-pass actually re-rendered a copy", () => {
  // The premise. Without a regeneration the assertions below would pass on the
  // unfixed code too, and prove nothing.
  expect(results.length).toBe(COPIES);
  const fresh = results.filter((r) => r.recipe.seed >= 7919);
  expect(fresh.length).toBeGreaterThan(0);
});

test("every shipped copy carries the spoofed device identity", () => {
  for (const r of results) {
    const t = tags.get(r.outputPath) ?? {};
    expect(str(t, "EXIF:Make")).toBe("Apple");
    expect(str(t, "EXIF:Model")).toMatch(/^iPhone /);
    expect(str(t, "EXIF:DateTimeOriginal")).toMatch(/^\d{4}:\d{2}:\d{2} /);
  }
});

test("no shipped copy still carries the encoder's own signature", () => {
  for (const r of results) {
    const t = tags.get(r.outputPath) ?? {};
    for (const key of Object.keys(t)) {
      expect(str(t, key)).not.toContain("Lavc");
      expect(str(t, key)).not.toContain("Lavf");
    }
  }
});

test("the copies agree on the batch: one identity each, none missing", () => {
  // The tell is the disagreement, not any single file: a batch is only as
  // convincing as its least convincing member.
  const models = results.map((r) => str(tags.get(r.outputPath) ?? {}, "EXIF:Model"));
  expect(models.filter((m) => m !== "").length).toBe(COPIES);
});
