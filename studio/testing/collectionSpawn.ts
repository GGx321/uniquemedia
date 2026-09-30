import ts from "typescript";

// A test file's collection phase runs its module scope and the bodies of its `describe` blocks before any test starts. A process
// spawned there (`spawnSync(ffmpeg)`, a helper that shells out) fails as "Unhandled error between tests", which names no test and
// prints no `(fail)` line, and it runs even for a test that was filtered out. Work of that kind belongs in a hook or a test.

/** Callees that start a process and wait for it, or (the helpers) call ffmpeg through one. */
export const SPAWNING_CALLEES: readonly string[] = [
  "spawnSync",
  "execSync",
  "execFileSync",
  "Bun.spawnSync",
  "childProcess.spawnSync",
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
  const DEFERRED = /^(test|it|beforeAll|beforeEach|afterAll|afterEach)(\.|\(|$)/;

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
      visit(node.expression);
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
