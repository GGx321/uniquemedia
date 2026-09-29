import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { buildSuite, electronNodeArgs, electronNodeEnv, NODE_TEST_SUITES } from "./electronNodeTests";
useNativeGlobals();

const ROOT = join(import.meta.dir, "..", "..");
const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("the registered suites", () => {
  test("name test entries and worker sources that exist", () => {
    expect(NODE_TEST_SUITES.length).toBeGreaterThan(0);
    for (const suite of NODE_TEST_SUITES) {
      expect(existsSync(join(ROOT, suite.entry))).toBe(true);
      for (const source of Object.values(suite.workers)) expect(existsSync(join(ROOT, source))).toBe(true);
    }
  });

  test("keep their entries out of `bun test`, which would load node:test files and crash on the real workers", () => {
    for (const suite of NODE_TEST_SUITES) expect(suite.entry).toMatch(/\.node-test\.ts$/);
  });
});

describe("electronNodeEnv", () => {
  test("makes the Electron binary act as plain Node and says where the repo is", () => {
    const env = electronNodeEnv({ PATH: "/bin", HOME: "/h" }, "/repo");
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(env.STUDIO_ROOT).toBe("/repo");
    expect(env.PATH).toBe("/bin");
  });

  test("drops NODE_OPTIONS, so a debugger or a loader of the caller cannot change the run", () => {
    expect(electronNodeEnv({ NODE_OPTIONS: "--inspect" }, "/repo").NODE_OPTIONS).toBeUndefined();
  });

  test("does not pass on undefined values", () => {
    const env = electronNodeEnv({ PATH: undefined }, "/repo");
    expect("PATH" in env).toBe(false);
  });
});

describe("electronNodeArgs", () => {
  test("runs node's own test runner on the bundle", () => {
    expect(electronNodeArgs("/out/x.mjs")).toEqual(["--test", "/out/x.mjs"]);
  });
});

describe("buildSuite", () => {
  test("bundles the test and each worker for Node, with no bun:* import left", async () => {
    const suite = NODE_TEST_SUITES[0];
    if (suite === undefined) throw new Error("no suite");
    const out = await mkdtemp(join(tmpdir(), "studio-node-tests-"));
    scratch.push(out);
    const bundle = await buildSuite(ROOT, suite, out);
    expect(existsSync(bundle)).toBe(true);
    const files = await readdir(out);
    for (const worker of Object.keys(suite.workers)) expect(files).toContain(worker);
    for (const file of files) expect(await readFile(join(out, file), "utf8")).not.toMatch(/from\s*["']bun:/);
  });

  test("fails loudly when an entry does not exist", async () => {
    const out = await mkdtemp(join(tmpdir(), "studio-node-tests-"));
    scratch.push(out);
    await expect(buildSuite(ROOT, { name: "x", entry: "studio/nope.node-test.ts", workers: {} }, out)).rejects.toThrow();
  });
});
