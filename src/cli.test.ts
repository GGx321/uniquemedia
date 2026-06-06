import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeTestClip } from "./node/testClip";

let dir: string;
let input: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "uniq-cli-"));
  input = join(dir, "in.mp4");
  makeTestClip(input);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("CLI produces N output files", () => {
  const outDir = join(dir, "out");
  const r = spawnSync(
    "bun",
    ["run", "src/cli.ts", input, "--count", "2", "--preset", "aggressive",
     "--out", outDir, "--format", "square", "--seed", "1"],
    { encoding: "utf8" }
  );
  expect(r.status).toBe(0);
  expect(existsSync(join(outDir, "copy_1.mp4"))).toBe(true);
  expect(existsSync(join(outDir, "copy_2.mp4"))).toBe(true);
  expect(r.stdout).toContain("copy 2/2");
}, 60000);
