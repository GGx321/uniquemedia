import ts from "typescript";

// A test file's collection phase runs its module scope and the bodies of its `describe` blocks before any test starts. A process
// spawned there (`spawnSync(ffmpeg)`, a helper that shells out) fails as "Unhandled error between tests", which names no test and
// prints no `(fail)` line, and it runs even for a test that was filtered out. Work of that kind belongs in a hook or a test.
//
// THIS IS A HEURISTIC, by callee NAME: it reads the syntax, not the types, so it cannot see a spawn behind a helper it has not
// been told about (add the helper to SPAWNING_CALLEES), an aliased import (`import { spawnSync as run }`), or a call through a
// variable. It does follow the immediately-invoked function (an IIFE at module scope runs at collection) and the callbacks of
// describe blocks, `.map` and the like, which also run at once.
// Known gaps: static class blocks (`class X { static { spawnSync(..) } }` run at collection and are skipped like any class body),
// a spawn behind a namespace alias (`import * as proc from "node:child_process"; proc.spawnSync(..)`), and the ones above.

/** The child_process functions, by the names they are called under: bare (from an import), or on the usual module aliases. */
const CHILD_PROCESS_FUNCTIONS = ["spawnSync", "execSync", "execFileSync", "spawn", "exec", "execFile", "fork"];
const CHILD_PROCESS_OBJECTS = ["cp", "childProcess", "child_process"];

/** Callees that start a process (and, for the helpers, call ffmpeg through one). */
export const SPAWNING_CALLEES: readonly string[] = [
  ...CHILD_PROCESS_FUNCTIONS,
  ...CHILD_PROCESS_OBJECTS.flatMap((object) => CHILD_PROCESS_FUNCTIONS.map((name) => `${object}.${name}`)),
  "Bun.spawn",
  "Bun.spawnSync",
  "facePoolImagePng",
  "facePoolNoFacePng",
  "letterboxedMasterJpeg",
  "twoKJpeg",
  "twelveMegapixelJpeg",
];

export interface CollectionCall {
  callee: string;
  line: number;
}

/** The calls evaluated while the file is collected: module scope, and the callbacks of describe blocks (and of anything else that runs its callback at once, `.map` included). Test and hook bodies, and every function that is only declared, are left out. */
export function collectionTimeCalls(source: string, fileName = "test.ts"): CollectionCall[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found: CollectionCall[] = [];
  // bun:test's and node:test's own hooks (`before` and `after` are node:test's names for beforeAll and afterAll).
  const DEFERRED = /^(test|it|beforeAll|beforeEach|afterAll|afterEach|before|after)(\.|\(|$)/;

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(file);
      found.push({ callee, line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1 });
      const deferred = DEFERRED.test(callee);
      for (const argument of node.arguments) {
        if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) {
          if (!deferred) ts.forEachChild(argument, visit);
        } else visit(argument);
      }
      // An immediately-invoked function, `(() => { ... })()`, runs its body right here.
      let invoked: ts.Expression = node.expression;
      while (ts.isParenthesizedExpression(invoked)) invoked = invoked.expression;
      if (ts.isArrowFunction(invoked) || ts.isFunctionExpression(invoked)) ts.forEachChild(invoked, visit);
      else visit(node.expression);
      return;
    }
    // A function that is only declared runs later, when something calls it.
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node)) return;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return found;
}

/** The collection-time calls in `source` that start a process (`SPAWNING_CALLEES`). */
export function collectionTimeSpawns(source: string, fileName = "test.ts"): CollectionCall[] {
  return collectionTimeCalls(source, fileName).filter((call) => SPAWNING_CALLEES.includes(call.callee));
}
