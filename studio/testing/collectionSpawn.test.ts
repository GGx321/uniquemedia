import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { collectionTimeCalls, collectionTimeSpawns, SPAWNING_CALLEES } from "./collectionSpawn";
import { useNativeGlobals } from "./nativeGlobals";
useNativeGlobals();

const ROOT = resolve(import.meta.dirname, "..", "..");

describe("collectionTimeSpawns: what runs while a test file is collected", () => {
  test("flags a spawn at module scope, and one in a describe body, however nested in describes", () => {
    const source = [
      'import { spawnSync } from "node:child_process";',
      'const version = spawnSync("ffmpeg", ["-version"]);',
      'describe("outer", () => {',
      '  const inner = execSync("ls");',
      '  describe("deeper", () => {',
      '    const jpeg = letterboxedMasterJpeg(64, 64);',
      "  });",
      "});",
    ].join("\n");
    expect(collectionTimeSpawns(source)).toEqual([
      { callee: "spawnSync", line: 2 },
      { callee: "execSync", line: 4 },
      { callee: "letterboxedMasterJpeg", line: 6 },
    ]);
  });

  test("flags the member forms and the describe modifiers", () => {
    const source = ['describe.skipIf(false)("x", () => {', '  const out = Bun.spawnSync(["ls"]);', "});", "const list = [1, 2].map(() => twoKJpeg());"].join("\n");
    expect(collectionTimeSpawns(source).map((call) => call.callee)).toEqual(["Bun.spawnSync", "twoKJpeg"]);
  });

  test("leaves test and hook bodies alone, including test.each and describe-level hooks", () => {
    const source = [
      'test("a", () => { spawnSync("ffmpeg"); });',
      'it("b", async () => { execFileSync("ffmpeg"); });',
      'test.each([1, 2])("c %d", () => { spawnSync("ffmpeg"); });',
      'describe("d", () => {',
      '  beforeAll(async () => { facePoolImagePng(0); });',
      '  beforeEach(() => { spawnSync("ffmpeg"); });',
      '  afterEach(() => { spawnSync("ffmpeg"); });',
      '  afterAll(() => { spawnSync("ffmpeg"); });',
      '  test.skipIf(false)("e", () => { spawnSync("ffmpeg"); });',
      "});",
    ].join("\n");
    expect(collectionTimeSpawns(source)).toEqual([]);
  });

  test("leaves a function that is only declared alone: it runs when something calls it", () => {
    const source = [
      'function probe() { return spawnSync("ffmpeg"); }',
      'const probeToo = () => spawnSync("ffmpeg");',
      "class Rig { start() { return spawnSync(\"ffmpeg\"); } }",
      'describe("x", () => {',
      '  const later = async () => execSync("ls");',
      '  test("t", async () => { await later(); });',
      "});",
    ].join("\n");
    expect(collectionTimeSpawns(source)).toEqual([]);
  });

  test("sees a spawn inside a call's own arguments at collection time (a spawn hidden in a helper's argument is still evaluated)", () => {
    const source = 'const value = compute(spawnSync("ffmpeg").stdout);';
    expect(collectionTimeSpawns(source)).toEqual([{ callee: "spawnSync", line: 1 }]);
  });

  test("collectionTimeCalls lists every collection-time call, in source order, for the scan above to filter", () => {
    const source = ['const a = one();', 'describe("d", () => { two(); test("t", () => { three(); }); });'].join("\n");
    expect(collectionTimeCalls(source).map((call) => call.callee)).toEqual(["one", "describe", "two", "test"]);
  });

  test("the list names the process-starting helpers the studio tests use", () => {
    for (const name of ["spawnSync", "execSync", "execFileSync", "Bun.spawnSync", "facePoolImagePng", "letterboxedMasterJpeg"]) expect(SPAWNING_CALLEES).toContain(name);
  });

  test("flags Bun.spawn, the async child_process calls, and the module-alias forms", () => {
    const source = ['const a = Bun.spawn(["ls"]);', 'const b = spawn("ls");', 'const c = exec("ls");', 'const d = cp.execSync("ls");', 'const e = childProcess.execFile("ls");', 'const f = child_process.spawnSync("ls");'].join("\n");
    expect(collectionTimeSpawns(source).map((call) => call.callee)).toEqual(["Bun.spawn", "spawn", "exec", "cp.execSync", "childProcess.execFile", "child_process.spawnSync"]);
  });

  test("does not mistake a regular expression's exec for a process", () => {
    expect(collectionTimeSpawns('const m = /a(b)/.exec("ab");\nconst n = pattern.exec("ab");')).toEqual([]);
  });

  test("follows an immediately-invoked function at module scope, arrow or function expression", () => {
    const source = ['(() => { spawnSync("ffmpeg"); })();', "(function () { execSync(\"ls\"); })();", '(async () => { await Bun.spawn(["ls"]).exited; })();'].join("\n");
    expect(collectionTimeSpawns(source).map((call) => call.callee)).toEqual(["spawnSync", "execSync", "Bun.spawn"]);
  });

  test("a parenthesised function that is not invoked here is deferred", () => {
    expect(collectionTimeSpawns('const later = (() => spawnSync("ffmpeg"));')).toEqual([]);
  });

  test("leaves node:test's before and after hooks alone", () => {
    const source = ['describe("d", () => {', '  before(() => { spawnSync("ffmpeg"); });', '  after(() => { spawnSync("ffmpeg"); });', "});"].join("\n");
    expect(collectionTimeSpawns(source)).toEqual([]);
  });
});

describe("no studio test file starts a process while it is collected", () => {
  test("every studio test file, scanned", () => {
    const offenders: string[] = [];
    let scanned = 0;
    // `*.node-test.ts` (run under Electron's Node by electronNodeTests.ts) count too: a spawn at their module scope fails the same way.
    for (const path of new Bun.Glob("studio/**/*.{test,spec,node-test}.{ts,tsx}").scanSync({ cwd: ROOT })) {
      if (path.includes("node_modules")) continue;
      scanned++;
      const source = readFileSync(resolve(ROOT, path), "utf8");
      for (const call of collectionTimeSpawns(source, path)) offenders.push(`${relative(ROOT, resolve(ROOT, path))}:${call.line}  ${call.callee}`);
    }
    expect(scanned).toBeGreaterThan(100); // the glob found the suite, not an empty folder
    expect(offenders).toEqual([]);
  });
});
