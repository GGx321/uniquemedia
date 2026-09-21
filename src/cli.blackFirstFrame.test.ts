import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import { makeTestClip, makeTestPhoto } from "./node/testClip";

/**
 * Exercised as a process, for the same reason `--edges` is: a flag the parser
 * never looks at does not fail, it is silently ignored, and the run ships a
 * copy that opens on the picture as if nothing had been asked for. Only the
 * first frame of the file the CLI wrote can say whether the flag arrived.
 */

const CLI = join(dirname(import.meta.dir), "src", "cli.ts");
const FFMPEG = ffmpegPath as string;
const SIDE = 64;

let dir: string;
let clip: string;
let still: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "uniq-cli-bff-"));
  clip = join(dir, "in.mp4");
  still = join(dir, "in.jpg");
  makeTestClip(clip);
  makeTestPhoto(still, 320, 240);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function runCli(args: string[]): { status: number | null; output: string } {
  const r = spawnSync("bun", ["run", CLI, ...args], { encoding: "utf8" });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

/** Peak luma of the first frame, read back as a 64x64 gray plane. */
function firstFrameMax(file: string): number {
  const r = spawnSync(
    FFMPEG,
    ["-v", "error", "-i", file, "-frames:v", "1",
     "-vf", `scale=${SIDE}:${SIDE},format=gray`, "-f", "rawvideo", "-"],
    { encoding: "buffer", maxBuffer: 1 << 24 }
  );
  if (r.status !== 0) throw new Error(`gray read failed: ${r.stderr.toString().slice(-300)}`);
  return new Uint8Array(r.stdout.subarray(0, SIDE * SIDE)).reduce((m, v) => (v > m ? v : m), 0);
}

test("the usage text tells the user the option exists", () => {
  const { output } = runCli([]);
  expect(output).toContain("--black-first-frame");
});

test("--black-first-frame reaches the options: the copy opens on a black frame", () => {
  // The flag goes last on purpose. It takes no value, and a parser that reads
  // the token after a flag as its value sees nothing there and treats the flag
  // as absent — so a bare trailing flag is the case that has to work.
  const out = join(dir, "on");
  const { status, output } = runCli([
    clip, "--count", "1", "--out", out, "--target", "1", "--seed", "1", "--no-spoof",
    "--black-first-frame",
  ]);
  expect(`${status} ${output.slice(-200)}`).toStartWith("0 ");
  expect(firstFrameMax(join(out, "copy_1.mp4"))).toBeLessThanOrEqual(1);
});

test("without the flag the copy opens on the picture", () => {
  const out = join(dir, "off");
  const { status, output } = runCli([
    clip, "--count", "1", "--out", out, "--target", "1", "--seed", "1", "--no-spoof",
  ]);
  expect(`${status} ${output.slice(-200)}`).toStartWith("0 ");
  expect(firstFrameMax(join(out, "copy_1.mp4"))).toBeGreaterThan(32);
});

test("a still accepts the flag and ignores it, because it has one frame", () => {
  const out = join(dir, "still");
  const { status, output } = runCli([
    still, "--count", "1", "--out", out, "--target", "1", "--no-spoof",
    "--black-first-frame",
  ]);
  expect(`${status} ${output.slice(-200)}`).toStartWith("0 ");
});
