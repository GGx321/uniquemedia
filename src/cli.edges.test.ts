import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { makeTestPhoto } from "./node/testClip";

/**
 * The CLI is exercised as a process, because the thing worth checking is that
 * the flag is wired in at all. A `--edges` that the argument parser never looks
 * at does not fail — it is silently ignored, and the run crops as if nothing
 * had been asked for. Only a run that rejects a bad value proves otherwise.
 */

const CLI = join(dirname(import.meta.dir), "src", "cli.ts");

let dir: string;
let input: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "uniq-cli-edges-"));
  input = join(dir, "in.jpg");
  makeTestPhoto(input, 320, 240);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function runCli(args: string[]): { status: number | null; output: string } {
  const r = spawnSync("bun", ["run", CLI, ...args], { encoding: "utf8" });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

test("the CLI rejects an --edges mode it does not know, naming what was asked for", () => {
  const { status, output } = runCli([
    input, "--count", "1", "--out", join(dir, "bad"), "--edges", "pad", "--no-spoof",
  ]);
  expect(status).not.toBe(0);
  expect(output).toContain("pad");
});

test("the CLI accepts every mode the option allows", () => {
  for (const mode of ["crop", "fit", "auto"]) {
    const { status, output } = runCli([
      input, "--count", "1", "--out", join(dir, mode), "--edges", mode,
      "--target", "1", "--no-spoof",
    ]);
    expect(`${mode}: ${status} ${output.slice(-200)}`).toContain(`${mode}: 0`);
  }
}, 120_000);

test("the usage text tells the user the option exists", () => {
  // An option nobody is told about is one nobody uses; the other two flags
  // that change what the output looks like are both listed.
  const { output } = runCli([]);
  expect(output).toContain("--edges");
});
