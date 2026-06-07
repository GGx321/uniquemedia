import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { FfmpegExecutor } from "./ffmpegExecutor";
import { makeTestClip } from "./testClip";
import { sampleRecipe } from "../core/sampler";
import { sampleDeviceProfile } from "../core/deviceProfile";
import { exiftool } from "exiftool-vendored";
import ffprobeStatic from "ffprobe-static";

const FFPROBE = ffprobeStatic.path.replace("app.asar", "app.asar.unpacked");

function ffprobeFormat(path: string): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFPROBE, [
      "-v", "quiet", "-print_format", "json", "-show_format", path,
    ]);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exited ${code}: ${Buffer.concat(err).toString().slice(-300)}`));
      const parsed = JSON.parse(Buffer.concat(out).toString());
      resolve(parsed.format?.tags ?? {});
    });
  });
}

let dir: string;
let input: string;
let output: string;
const exec = new FfmpegExecutor();

const SEED = 42;
const NOW_MS = 1_748_000_000_000; // fixed for determinism
const profile = sampleDeviceProfile(SEED, NOW_MS);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "uniq-meta-"));
  input = join(dir, "in.mp4");
  output = join(dir, "out.mov");
  makeTestClip(input);

  const info = await exec.probe(input);
  const recipe = sampleRecipe(
    {
      strength: 1.0,
      exportFormat: "square",
      keepTrendAudio: false,
      allowMirror: false,
      targetDistance: 90,
      spoofMetadata: true,
      keepResolution: false,
    },
    SEED,
    1
  );
  await exec.render(input, info, recipe, output);
  await exec.applyDeviceMetadata!(output, profile);
}, 60_000);

afterAll(async () => {
  await exiftool.end();
  rmSync(dir, { recursive: true, force: true });
});

test("rendered output has Apple QuickTime make tag", async () => {
  const tags = await ffprobeFormat(output);
  const makeTag =
    tags["com.apple.quicktime.make"] ??
    tags["make"] ??
    tags["Make"] ??
    "";
  expect(makeTag.toLowerCase()).toContain("apple");
}, 30_000);

test("rendered output has Apple QuickTime model tag", async () => {
  const tags = await ffprobeFormat(output);
  const modelTag =
    tags["com.apple.quicktime.model"] ??
    tags["model"] ??
    tags["Model"] ??
    "";
  expect(modelTag.toLowerCase()).toContain("iphone");
}, 30_000);

test("rendered output has Apple QuickTime software tag", async () => {
  const tags = await ffprobeFormat(output);
  const softwareTag =
    tags["com.apple.quicktime.software"] ??
    tags["software"] ??
    tags["Software"] ??
    "";
  expect(softwareTag.length).toBeGreaterThan(0);
}, 30_000);

test("rendered output has Apple QuickTime creationdate tag", async () => {
  const tags = await ffprobeFormat(output);
  const creationTag =
    tags["com.apple.quicktime.creationdate"] ??
    tags["creation_time"] ??
    tags["date"] ??
    "";
  expect(creationTag.length).toBeGreaterThan(0);
}, 30_000);

test("rendered output has spoofed GPS location tag", async () => {
  const tags = await ffprobeFormat(output);
  // Keys:GPSCoordinates → com.apple.quicktime.location.ISO6709
  // ItemList:GPSCoordinates → top-level "location"
  const locationTag =
    tags["com.apple.quicktime.location.ISO6709"] ??
    tags["location"] ??
    "";
  expect(locationTag.length).toBeGreaterThan(0);
  // Should encode the lat/lon of the profile city — check it starts with a signed coord
  expect(locationTag).toMatch(/^[+-]\d{2}\.\d+[+-]\d{3}\.\d+/);
}, 30_000);
