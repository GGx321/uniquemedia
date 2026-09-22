import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import { makeTestClip, makeTestPhoto } from "./node/testClip";
import { PhotoExecutor } from "./node/photoExecutor";
import { resolveEdge } from "./node/mediaRoute";
import { samplePhotoRecipe } from "./core/photo/sampler";
import { computePdqHash } from "./core/pdq/pdq";
import { hammingDistance } from "./core/pdq/hamming";

/**
 * Exercised as a process, like `--black-first-frame` is: a flag the parser
 * never looks at does not fail, it is silently ignored, and the run ships a
 * copy that opens on the footage as if nothing had been asked for. Only the
 * first frame of the file the CLI wrote can say whether the cover arrived —
 * and only the exit status can say that a line with no cover was refused
 * rather than run.
 */

const CLI = join(dirname(import.meta.dir), "src", "cli.ts");
const FFMPEG = ffmpegPath as string;
const SIDE = 64;

/** Same bound as the executor's own cover test: frame 0 against the cover
 *  rendered standalone through the SAME recipe is a re-encode apart. */
const SAME_PICTURE_MAX = 16;

let dir: string;
let clip: string;
let still: string;
let cover: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "uniq-cli-cover-"));
  clip = join(dir, "in.mp4");
  still = join(dir, "in.jpg");
  cover = join(dir, "cover.jpg");
  makeTestClip(clip);
  makeTestPhoto(still, 320, 240);
  makeTestPhoto(cover, 320, 240);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function runCli(args: string[]): { status: number | null; output: string } {
  const r = spawnSync("bun", ["run", CLI, ...args], { encoding: "utf8" });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

function gray(file: string, vf: string): Uint8Array {
  const r = spawnSync(
    FFMPEG,
    ["-v", "error", "-i", file, "-frames:v", "1", "-vf", `${vf}scale=${SIDE}:${SIDE},format=gray`,
     "-f", "rawvideo", "-"],
    { encoding: "buffer", maxBuffer: 1 << 24 }
  );
  if (r.status !== 0) throw new Error(`gray read failed: ${r.stderr.toString().slice(-300)}`);
  return new Uint8Array(r.stdout.subarray(0, SIDE * SIDE));
}

const distance = (a: Uint8Array, b: Uint8Array): number =>
  hammingDistance(computePdqHash(a), computePdqHash(b));

test("the usage text tells the user both options exist", () => {
  const { output } = runCli([]);
  expect(output).toContain("--first-frame off|black|photo");
  expect(output).toContain("--cover");
  expect(output).toContain("--black-first-frame");
});

test("--first-frame photo --cover reaches the render: the copy opens on the cover, uniquified", async () => {
  // `--format original` keeps the copy at the clip's 4:3, the cover's own
  // aspect, so the comparison below is picture against picture and not
  // picture against a 9:16 window of it. `--target 1` makes the first
  // attempt pass, so copy 1 is seed 1 at intensity 1 — which is enough to
  // draw the cover's recipe here and render the cover through it on its own.
  const out = join(dir, "photo");
  const { status, output } = runCli([
    clip, "--count", "1", "--out", out, "--target", "1", "--seed", "1", "--no-spoof",
    "--format", "original", "--first-frame", "photo", "--cover", cover,
  ]);
  expect(`${status} ${output.slice(-200)}`).toStartWith("0 ");

  const stills = new PhotoExecutor();
  const coverRecipe = samplePhotoRecipe(
    {
      strength: 1.0,
      exportFormat: "original",
      allowMirror: false,
      targetDistance: 1,
      identity: "engine",
      edge: await resolveEdge(stills, cover, "auto"),
    },
    1,
    1
  );
  const standalone = join(dir, "standalone.jpg");
  await stills.render(cover, await stills.probe(cover), coverRecipe, standalone);

  const frame0 = gray(join(out, "copy_1.mp4"), "");
  const toRecipe = distance(frame0, gray(standalone, ""));
  const toCoverFile = distance(frame0, gray(cover, ""));
  const toFootage = distance(frame0, gray(clip, ""));
  console.log(
    `[cli-cover] frame0: PDQ distance ${toRecipe} to the cover through its recipe, ` +
      `${toCoverFile} to the cover file, ${toFootage} to the footage`
  );
  expect(toRecipe).toBeLessThanOrEqual(SAME_PICTURE_MAX);
  // Uniquified, not pasted: the cover file itself is further off than the
  // recipe's rendition of it, and the footage is nowhere near.
  expect(toCoverFile).toBeGreaterThan(toRecipe);
  expect(toFootage).toBeGreaterThan(toCoverFile);
});

test("--first-frame photo without --cover is refused with the flag to add, and writes nothing", () => {
  const out = join(dir, "refused");
  const { status, output } = runCli([
    clip, "--count", "1", "--out", out, "--target", "1", "--seed", "1", "--no-spoof",
    "--first-frame", "photo",
  ]);
  expect(status).not.toBe(0);
  expect(output).toContain("--cover");
  // Refused before the output directory is made: a run that was never going
  // to render should leave no trace of itself.
  expect(existsSync(out)).toBe(false);
});

test("a cover that is not a still is refused by name", () => {
  const out = join(dir, "refused2");
  const { status, output } = runCli([
    clip, "--count", "1", "--out", out, "--target", "1", "--seed", "1", "--no-spoof",
    "--first-frame", "photo", "--cover", clip,
  ]);
  expect(status).not.toBe(0);
  expect(output).toContain(clip);
  expect(output.toLowerCase()).toContain("still");
});

test("a still accepts the options and ignores them, because it has one frame", () => {
  const out = join(dir, "still");
  const { status, output } = runCli([
    still, "--count", "1", "--out", out, "--target", "1", "--no-spoof",
    "--first-frame", "photo", "--cover", cover,
  ]);
  expect(`${status} ${output.slice(-200)}`).toStartWith("0 ");
});
