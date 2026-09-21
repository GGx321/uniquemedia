import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { makeTestPhoto } from "./node/testClip";

/**
 * The CLI is exercised as a process, because the thing worth checking is that
 * the flag is wired in at all: an `--identity` the parser never looked at
 * would not fail, it would ship the default and say nothing.
 */

const CLI = join(dirname(import.meta.dir), "src", "cli.ts");

let dir: string;
let input: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "uniq-cli-identity-"));
  input = join(dir, "in.jpg");
  makeTestPhoto(input, 320, 240);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function runCli(args: string[]): { status: number | null; output: string } {
  const r = spawnSync("bun", ["run", CLI, ...args], { encoding: "utf8" });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

test("the usage text tells the user the option exists and that --no-spoof still works", () => {
  const { output } = runCli([]);
  expect(output).toContain("--identity");
  expect(output).toContain("engine|iphone|clean");
  expect(output).toContain("--no-spoof");
});

test("the CLI rejects an --identity mode it does not know, naming what was asked for", () => {
  const { status, output } = runCli([
    input, "--count", "1", "--out", join(dir, "bad"), "--identity", "apple",
  ]);
  expect(status).not.toBe(0);
  expect(output).toContain("apple");
  expect(output).toContain("engine, iphone, clean");
});

test("--identity clean ships a still with no JFIF segment and no encoder comment", () => {
  const out = join(dir, "clean");
  const { status, output } = runCli([
    input, "--count", "1", "--out", out, "--target", "1", "--identity", "clean",
  ]);
  expect(`${status} ${output.slice(-200)}`).toContain("0 ");
  const bytes = readFileSync(join(out, "copy_1.jpg"));
  expect(bytes.includes("JFIF")).toBe(false);
  expect(bytes.includes("Lavc")).toBe(false);
  expect(bytes.includes("Exif")).toBe(false);
}, 60_000);

test("--no-spoof still ships the engine file, comment and all", () => {
  const out = join(dir, "engine");
  const { status } = runCli([
    input, "--count", "1", "--out", out, "--target", "1", "--no-spoof",
  ]);
  expect(status).toBe(0);
  const bytes = readFileSync(join(out, "copy_1.jpg"));
  expect(bytes.includes("JFIF")).toBe(true);
  expect(bytes.includes("Lavc")).toBe(true);
}, 60_000);
