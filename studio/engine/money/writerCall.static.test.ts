import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { tempDirFor } from "../../testing/tempDir";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.4 (S5.BA5, plan s5a4 r2.1 L2, §5.3.4 «The static test»): the writer's money has one door. No production module reads the money fields of WRITER_CALL
// or WRITER_BOLD_CALL (model, maxTokens, inputTokens, images, typicalPerScene, reasoningTokens), spreads them, hands them on whole or aliases them: it asks
// `writerCallOf(mode)` (money/estimate.ts) for the shape, so the day a site prices the writer it prices it by mode. The chunk size and the attempts a
// chunk may use (`slotsPerCall`, `maxAttempts`) may be read anywhere: they are pinned equal in both shapes (estimate.writerCall.test.ts). Comments do not
// count (the scan reads the syntax tree). And every writer ceiling of the scene sets and of a resume is `writerAttemptWorstMicros`, the one price of an
// attempt that adds the reasoning allowance (r2.1 N1).

const STUDIO = resolve(import.meta.dir, "../..");
const GUARDED = new Set(["WRITER_CALL", "WRITER_BOLD_CALL"]);
const ALLOWED_FIELDS = new Set(["slotsPerCall", "maxAttempts"]);
const DOOR_FILE = "engine/money/estimate.ts";
const DOOR = "writerCallOf";

interface Use {
  file: string;
  line: number;
  text: string;
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(path);
    return [path];
  });
}

/** Production source under `root`: no tests, no test kits, no `testing/` helper folders; paths relative to `root`, with forward slashes. */
function productionOf(root: string): { path: string; code: string }[] {
  return walk(root)
    .filter((file) => /\.tsx?$/.test(file) && !/\.(test|testkit)\.tsx?$/.test(file) && !/[\\/]testing[\\/]/.test(file))
    .map((file) => ({ path: relative(root, file).split("\\").join("/"), code: readFileSync(file, "utf8") }));
}

function insideDoor(node: ts.Node): boolean {
  for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
    if (ts.isFunctionDeclaration(at) && at.name?.text === DOOR) return true;
  }
  return false;
}

/** Every use of a guarded call in one file, split into the allowed ones (a chunk-size or attempts read, the door itself) and the rest. */
function usesOf(path: string, code: string): { allowed: Use[]; violations: Use[] } {
  const source = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const names = new Set(GUARDED);
  // An import under another name binds that name too.
  source.forEachChild(function bind(node): void {
    if (ts.isImportSpecifier(node) && GUARDED.has((node.propertyName ?? node.name).text)) names.add(node.name.text);
    node.forEachChild(bind);
  });
  const allowed: Use[] = [];
  const violations: Use[] = [];
  source.forEachChild(function visit(node): void {
    node.forEachChild(visit);
    if (!ts.isIdentifier(node) || !names.has(node.text)) return;
    const { parent } = node;
    // Not a read: the import or export of the name, its declaration, or a property key named like it.
    if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return;
    if (ts.isVariableDeclaration(parent) && parent.name === node) return;
    if (ts.isPropertyAssignment(parent) && parent.name === node) return;
    // `ns.WRITER_CALL`: the reference is the whole access.
    const ref: ts.Expression = ts.isPropertyAccessExpression(parent) && parent.name === node ? parent : node;
    if (ref !== node && !GUARDED.has(node.text)) return; // `x.foo` where `foo` only shares an alias's name
    const use: Use = { file: path, line: source.getLineAndCharacterOfPosition(ref.getStart(source)).line + 1, text: ref.parent.getText(source) };
    const outer = ref.parent;
    if (ts.isPropertyAccessExpression(outer) && outer.expression === ref && ALLOWED_FIELDS.has(outer.name.text)) allowed.push(use);
    else if (path === DOOR_FILE && insideDoor(ref)) allowed.push(use);
    else violations.push(use);
  });
  return { allowed, violations };
}

function scan(root: string): { files: number; allowed: Use[]; violations: Use[] } {
  const production = productionOf(root);
  const uses = production.map((f) => usesOf(f.path, f.code));
  return { files: production.length, allowed: uses.flatMap((u) => u.allowed), violations: uses.flatMap((u) => u.violations) };
}

const STUDIO_SCAN = scan(STUDIO);
const where = (uses: Use[]): string[] => uses.map((u) => `${u.file}:${u.line}`);

describe("the writer's money is read only through writerCallOf (static)", () => {
  test("the scan reads the production source and finds the allowed reads (it is not vacuous)", () => {
    expect(STUDIO_SCAN.files).toBeGreaterThan(300);
    const files = new Set(STUDIO_SCAN.allowed.map((u) => u.file));
    for (const file of ["engine/sceneSets/chunks.ts", "engine/sceneSets/reviewWrites.ts", "engine/scenes/writer.ts", "engine/runs/plan.ts", "engine/autopilot/prices.ts", DOOR_FILE]) {
      expect(files.has(file), file).toBe(true);
    }
  });

  test("no production module outside writerCallOf reads a writer call's money fields, spreads it or hands it on", () => {
    expect(STUDIO_SCAN.violations.map((u) => `${u.file}:${u.line}: ${u.text}`)).toEqual([]);
  });

  test("the reads outside the door are of slotsPerCall and maxAttempts alone", () => {
    const fields = new Set(STUDIO_SCAN.allowed.filter((u) => u.file !== DOOR_FILE).map((u) => u.text.slice(u.text.lastIndexOf(".") + 1)));
    expect([...fields].sort()).toEqual(["maxAttempts", "slotsPerCall"]);
  });
});

describe("the scan catches what it is for (planted fixture files)", () => {
  const dir = tempDirFor({ beforeEach, afterEach }, "studio-writer-call-scan-");

  function plant(name: string, code: string): { allowed: Use[]; violations: Use[] } {
    writeFileSync(join(dir(), name), code);
    const { allowed, violations } = scan(dir());
    return { allowed, violations };
  }

  test("a planted `{ ...WRITER_CALL, model }` is caught", () => {
    const { violations } = plant("planted.ts", `import { WRITER_CALL } from "../money/estimate";\nexport const call = (model: string) => ({ ...WRITER_CALL, model });\n`);
    expect(where(violations)).toEqual(["planted.ts:2"]);
  });

  test("a read of each money field is caught, of either shape", () => {
    const fields = ["model", "maxTokens", "inputTokens", "images", "typicalPerScene", "reasoningTokens"];
    const lines = fields.flatMap((f) => [`export const a_${f} = WRITER_CALL.${f};`, `export const b_${f} = WRITER_BOLD_CALL.${f};`]);
    const { violations } = plant("fields.ts", [`import { WRITER_BOLD_CALL, WRITER_CALL } from "../money/estimate";`, ...lines].join("\n"));
    expect(violations).toHaveLength(2 * fields.length);
  });

  test("an alias, a namespace read, an element read, a destructuring, a hand-off and a type query are caught", () => {
    const code = [
      `import { WRITER_CALL as W } from "../money/estimate";`,
      `import * as M from "../money/estimate";`,
      `export const a = W.model;`,
      `export const b = M.WRITER_CALL.inputTokens;`,
      `export const c = M.WRITER_CALL["maxTokens"];`,
      `export const { images } = M.WRITER_CALL;`,
      `export const d = price(M.WRITER_CALL);`,
      `export const e = (): typeof M.WRITER_CALL => M.WRITER_CALL;`,
      `declare function price(x: unknown): number;`,
    ].join("\n");
    const { violations } = plant("forms.ts", code);
    expect(where(violations)).toEqual(["forms.ts:3", "forms.ts:4", "forms.ts:5", "forms.ts:6", "forms.ts:7", "forms.ts:8", "forms.ts:8"]);
  });

  test("slotsPerCall and maxAttempts reads, imports and comments pass", () => {
    const code = [
      `import { WRITER_CALL } from "../money/estimate";`,
      `// WRITER_CALL.model is named in a comment only`,
      `/** WRITER_CALL.inputTokens, in a doc comment */`,
      `export const size = WRITER_CALL.slotsPerCall;`,
      `export const tries = WRITER_CALL.maxAttempts;`,
    ].join("\n");
    const { allowed, violations } = plant("allowed.ts", code);
    expect([where(allowed), violations]).toEqual([["allowed.ts:4", "allowed.ts:5"], []]);
  });

  test("a test file and a testing/ helper are not production", () => {
    expect(productionOf(STUDIO).some((f) => /\.test\.tsx?$|(^|\/)testing\//.test(f.path))).toBe(false);
  });
});

describe("every writer ceiling is writerAttemptWorstMicros (r2.1 N1)", () => {
  const callsOf = (file: string, method: string): string[] => {
    const code = readFileSync(join(STUDIO, file), "utf8");
    const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const found: string[] = [];
    source.forEachChild(function visit(node): void {
      node.forEachChild(visit);
      if (!ts.isCallExpression(node)) return;
      const callee = node.expression;
      const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : null;
      if (name === method) found.push(node.getText(source));
    });
    return found;
  };

  test("a scene set's compose, «Дописать», write and the launch unit price an attempt with it, and nothing else", () => {
    expect(callsOf("engine/sceneSets/estimate.ts", "chatWorstCase")).toEqual([]);
    expect(callsOf("engine/sceneSets/estimate.ts", "writerAttemptWorstMicros").length).toBeGreaterThan(0);
  });

  test("a resume prices its writer chunks with it; its only other chat ceiling is the age check's", () => {
    const others = callsOf("engine/runs/remaining.ts", "chatWorstCase");
    expect(others).toHaveLength(1);
    expect(others[0]).toContain("AGE_CHECK_CALL");
    expect(callsOf("engine/runs/remaining.ts", "writerAttemptWorstMicros")).toHaveLength(1);
  });
});
