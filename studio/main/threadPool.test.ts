import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createMediaGates, MEDIA_DISK_SLOTS, SHARED_MEDIA_GATES } from "./mediaProtocol";
import { MAIN_RESERVED_THREADS, THREADPOOL_SIZE } from "./threadPool";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Round 2 follow-up L-1: libuv's pool has four threads, and every file, DNS (OpenRouter) and crypto call of main goes through it. A dead NAS holding the media
// protocol's library and export slots (3) would leave main ONE thread. The pool is made bigger, once, before anything uses it: `UV_THREADPOOL_SIZE` is read when
// the pool is first used (measured on Electron 43: eight parallel pbkdf2 took 2.0x one with the default, 1.15x with the variable set on the entry's first line).

const MAIN_DIR = dirname(fileURLToPath(import.meta.url));

describe("the thread pool of main", () => {
  test("is at least twice libuv's default, so a dead share cannot leave main one thread", () => {
    expect(THREADPOOL_SIZE).toBeGreaterThanOrEqual(8);
  });

  test("the media protocol's slots, all held, leave main at least its reserve of threads", () => {
    const held = MEDIA_DISK_SLOTS.library + MEDIA_DISK_SLOTS.export + MEDIA_DISK_SLOTS.local;
    expect(held + MAIN_RESERVED_THREADS).toBeLessThanOrEqual(THREADPOOL_SIZE);
  });

  test("importing the module sets UV_THREADPOOL_SIZE in the environment of the process", () => {
    const run = Bun.spawnSync([process.execPath, "-e", `delete process.env.UV_THREADPOOL_SIZE; await import(${JSON.stringify(join(MAIN_DIR, "threadPool.ts"))}); console.log(process.env.UV_THREADPOOL_SIZE);`], {
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(run.stdout.toString().trim()).toBe(String(THREADPOOL_SIZE));
  });

  test("a larger size the owner already asked for is kept, never lowered", () => {
    const run = Bun.spawnSync([process.execPath, "-e", `process.env.UV_THREADPOOL_SIZE = "32"; await import(${JSON.stringify(join(MAIN_DIR, "threadPool.ts"))}); console.log(process.env.UV_THREADPOOL_SIZE);`], {
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(run.stdout.toString().trim()).toBe("32");
  });
});

/** Why the entry does not load `./threadPool` before every other module: it must be the FIRST import, as a bare side-effect import. */
function threadPoolProblems(source: string): string[] {
  const file = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const first = file.statements[0];
  if (first === undefined || !ts.isImportDeclaration(first)) return ["the first statement of the entry is not an import"];
  if (first.importClause !== undefined) return ["the first import is not a bare side-effect import"];
  if (!ts.isStringLiteral(first.moduleSpecifier) || first.moduleSpecifier.text !== "./threadPool") return ["the first import is not ./threadPool"];
  return [];
}

describe("threadPoolProblems: the entry imports ./threadPool first", () => {
  test("passes the clean shape", () => {
    expect(threadPoolProblems('import "./threadPool";\nimport { app } from "electron";')).toEqual([]);
  });

  test("fails when another import comes first (its top level could already use the pool)", () => {
    expect(threadPoolProblems('import { app } from "electron";\nimport "./threadPool";')).toEqual(["the first import is not a bare side-effect import"]);
  });

  test("fails when it is imported for a name, or is not there", () => {
    expect(threadPoolProblems('import { THREADPOOL_SIZE } from "./threadPool";')).toEqual(["the first import is not a bare side-effect import"]);
    expect(threadPoolProblems("const x = 1;")).toEqual(["the first statement of the entry is not an import"]);
    expect(threadPoolProblems('import "./other";')).toEqual(["the first import is not ./threadPool"]);
  });
});

test("the real studio/main/main.ts imports ./threadPool first, before electron and every other module", () => {
  expect(threadPoolProblems(readFileSync(join(MAIN_DIR, "main.ts"), "utf8"))).toEqual([]);
});

describe("the production gates", () => {
  test("library, export and userData each have a gate of their own: one shared object would let a dead share starve the others", () => {
    const { library, export: exported, local } = SHARED_MEDIA_GATES;
    expect(new Set([library, exported, local]).size).toBe(3);
  });

  test("each gate lets exactly its own number of operations hold a thread at once (MEDIA_DISK_SLOTS), however many are asked", async () => {
    // A fresh set from the same factory the production one comes from: operations that never end must not be left on the gates the other tests use.
    const never = new Promise<void>(() => undefined);
    const fresh = createMediaGates();
    for (const key of ["library", "export", "local"] as const) {
      const gate = fresh[key];
      for (let i = 0; i < MEDIA_DISK_SLOTS[key] + 3; i++) void gate.run(() => never).catch(() => undefined);
      expect([key, gate.inFlight]).toEqual([key, MEDIA_DISK_SLOTS[key]]);
    }
  });
});
