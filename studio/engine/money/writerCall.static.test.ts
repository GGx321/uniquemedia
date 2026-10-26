import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.4 (S5.BA5, plan s5a4 r2.1 N1 and L2, §5.3.4 «The static test»; round 2, M2): the writer's money has one door and three readers, held by the
// TypeScript checker over every production module (.ts, .tsx, .mts, .cts, .js, .mjs, .cjs, .jsx; no tests, test kits or `testing/` helpers), so a
// value is followed through variables, helpers, spreads and aliases, and comments never count.
// - The door (L2): WRITER_CALL and WRITER_BOLD_CALL are read only inside `writerCallOf` (money/estimate.ts), under any alias, re-export or element
//   access. Elsewhere only their `slotsPerCall` and `maxAttempts` may be read (pinned equal in both shapes).
// - The readers (N1, M2): a writer call or a phase call shape (a value with `maxTokens`, `inputTokens` and `maxAttempts`) has its money fields
//   (`maxTokens`, `inputTokens`, `reasoningTokens`, `images`, `typicalPerScene`, `typicalPerCall`) read only by `writerAttemptWorstMicros` and
//   `writerExpectedMicros` (money/estimate.ts) and by `writerCallShape` and `ask` (runs/writerPhase.ts); none is handed whole, or spread, to a price
//   function (`chatWorstCase`, `ceilingMicros`, `chatAttemptWorstMicros`, `chatCost`); none is written into such a value or cast to one, except where
//   the two shapes are declared and in `writerCallShape`. So no site can price a writer attempt without its reasoning allowance, or reserve one.

const STUDIO = resolve(import.meta.dir, "../..");
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const GUARDED = new Set(["WRITER_CALL", "WRITER_BOLD_CALL"]);
const FREE_FIELDS = new Set(["slotsPerCall", "maxAttempts"]);
const MONEY_FIELDS = new Set(["maxTokens", "inputTokens", "reasoningTokens", "images", "typicalPerScene", "typicalPerCall"]);
const PRICERS = new Set(["chatWorstCase", "ceilingMicros", "chatAttemptWorstMicros", "chatCost"]);
const ESTIMATE = "engine/money/estimate.ts";
const PHASE = "engine/runs/writerPhase.ts";
type Place = { file: string; fn: string };
const DOOR: Place[] = [{ file: ESTIMATE, fn: "writerCallOf" }];
const READERS: Place[] = [
  { file: ESTIMATE, fn: "writerAttemptWorstMicros" },
  { file: ESTIMATE, fn: "writerExpectedMicros" },
  { file: PHASE, fn: "writerCallShape" },
  { file: PHASE, fn: "ask" },
];
const PRICER_CALLERS: Place[] = [{ file: ESTIMATE, fn: "writerAttemptWorstMicros" }];
const SHAPE_MAKER: Place[] = [{ file: PHASE, fn: "writerCallShape" }];

type Rule = "door" | "read" | "hand-off" | "write" | "cast";
interface Finding {
  rule: Rule;
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

/** Production source under `root`: every script extension, no declaration files, tests, test kits or `testing/` helper folders. */
function productionOf(root: string): string[] {
  return walk(root).filter((file) => SOURCE.test(file) && !file.endsWith(".d.ts") && !/\.(test|testkit)\.[cm]?[jt]sx?$/.test(file) && !/[\\/]testing[\\/]/.test(file));
}

/** The names of the functions around `node`, innermost first (a function declaration, a method, or a function bound to a const). */
function functionsAround(node: ts.Node): string[] {
  const names: string[] = [];
  for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
    if ((ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) && at.name !== undefined) names.push(at.name.getText());
    else if ((ts.isArrowFunction(at) || ts.isFunctionExpression(at)) && ts.isVariableDeclaration(at.parent)) names.push(at.parent.name.getText());
  }
  return names;
}

const inPlace = (file: string, node: ts.Node, places: readonly Place[]): boolean => places.some((p) => p.file === file && functionsAround(node).includes(p.fn));

/** Inside the declaration of WRITER_CALL or WRITER_BOLD_CALL in money/estimate.ts. */
function inShapeDeclaration(file: string, node: ts.Node): boolean {
  if (file !== ESTIMATE) return false;
  for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
    if (ts.isVariableDeclaration(at) && ts.isIdentifier(at.name) && GUARDED.has(at.name.text)) return true;
  }
  return false;
}

/**
 * Scans the production source of the Studio, plus `extra` files (planted fixtures; shown relative to `extraRoot`), with one TypeScript program, so
 * types and aliases cross module boundaries.
 */
function scan(extra: readonly string[] = [], extraRoot = STUDIO): { files: number; findings: Finding[]; allowedDoorReads: Finding[] } {
  const production = productionOf(STUDIO);
  const program = ts.createProgram([...production, ...extra], {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    allowJs: true,
    allowImportingTsExtensions: true,
    jsx: ts.JsxEmit.ReactJSX,
    types: [],
  });
  const checker = program.getTypeChecker();
  const shown = new Map<string, string>([
    ...production.map((f) => [resolve(f), relative(STUDIO, f).split("\\").join("/")] as const),
    ...extra.map((f) => [resolve(f), `planted/${relative(extraRoot, f).split("\\").join("/")}`] as const),
  ]);

  const estimateFile = program.getSourceFile(join(STUDIO, ESTIMATE));
  if (estimateFile === undefined) throw new Error(`${ESTIMATE} is not in the program`);
  const guardedSymbols = new Set<ts.Symbol>();
  estimateFile.forEachChild(function find(node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && GUARDED.has(node.name.text)) {
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol !== undefined) guardedSymbols.add(symbol);
    }
    node.forEachChild(find);
  });
  const resolved = (symbol: ts.Symbol | undefined): ts.Symbol | undefined => (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);

  /** A writer call or a phase call shape: its ceilings and the attempts a chunk may use, in one value. */
  const isWriterMoney = (type: ts.Type): boolean => {
    const t = checker.getNonNullableType(type);
    if (t.isUnion()) return t.types.some(isWriterMoney);
    return ["maxTokens", "inputTokens", "maxAttempts"].every((name) => t.getProperty(name) !== undefined);
  };
  const typeOf = (node: ts.Node): ts.Type => checker.getTypeAtLocation(node);

  const sources = program.getSourceFiles().filter((sf) => shown.has(resolve(sf.fileName)));
  // Every local name an import or re-export gives a guarded constant.
  const aliasNames = new Set(GUARDED);
  for (const sf of sources) {
    sf.forEachChild(function specifiers(node): void {
      if ((ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) && guardedSymbols.has(resolved(checker.getSymbolAtLocation(node.name)) as ts.Symbol)) aliasNames.add(node.name.text);
      node.forEachChild(specifiers);
    });
  }

  const findings: Finding[] = [];
  const allowedDoorReads: Finding[] = [];
  for (const sf of sources) {
    const file = shown.get(resolve(sf.fileName)) ?? sf.fileName;
    const at = (rule: Rule, node: ts.Node, text = node.getText(sf)): Finding => ({ rule, file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text });
    const fieldOf = (access: ts.Node): string | null =>
      ts.isPropertyAccessExpression(access) ? access.name.text : ts.isElementAccessExpression(access) && ts.isStringLiteralLike(access.argumentExpression) ? access.argumentExpression.text : null;

    sf.forEachChild(function visit(node): void {
      node.forEachChild(visit);

      // The door: a reference to a guarded constant, by any name.
      const guardedName = (ts.isIdentifier(node) && aliasNames.has(node.text)) || (ts.isStringLiteralLike(node) && GUARDED.has(node.text) && ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node);
      if (guardedName && guardedSymbols.has(resolved(checker.getSymbolAtLocation(node)) as ts.Symbol)) {
        const { parent } = node;
        const notARead =
          ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent) || (ts.isVariableDeclaration(parent) && parent.name === node) || (ts.isPropertyAssignment(parent) && parent.name === node);
        if (!notARead) {
          const ref = (ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) ? parent : node;
          const outer = ref.parent;
          const field = (ts.isPropertyAccessExpression(outer) || ts.isElementAccessExpression(outer)) && outer.expression === ref ? fieldOf(outer) : null;
          const use = at("door", ref, outer.getText(sf));
          if ((field !== null && FREE_FIELDS.has(field)) || inPlace(file, ref, DOOR)) allowedDoorReads.push(use);
          else findings.push(use);
        }
      }

      // A read of a money field of a writer call or a shape.
      const field = fieldOf(node);
      if (field !== null && MONEY_FIELDS.has(field) && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) {
        if (isWriterMoney(typeOf(node.expression)) && !inPlace(file, node, READERS) && !inShapeDeclaration(file, node)) findings.push(at("read", node));
      }
      if (ts.isObjectBindingPattern(node)) {
        const source = ts.isVariableDeclaration(node.parent) && node.parent.initializer !== undefined ? node.parent.initializer : node.parent;
        const takes = node.elements.some((e) => e.dotDotDotToken !== undefined || MONEY_FIELDS.has((e.propertyName ?? e.name).getText(sf)));
        if (takes && isWriterMoney(typeOf(source)) && !inPlace(file, node, READERS)) findings.push(at("read", node.parent));
      }

      // A writer call or a shape handed whole, or spread, to a price function.
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : null;
        if (name !== null && PRICERS.has(name) && !inPlace(file, node, PRICER_CALLERS)) {
          for (const arg of node.arguments) {
            const spread = ts.isObjectLiteralExpression(arg) && arg.properties.some((p) => ts.isSpreadAssignment(p) && isWriterMoney(typeOf(p.expression)));
            if (spread || (!ts.isObjectLiteralExpression(arg) && isWriterMoney(typeOf(arg)))) findings.push(at("hand-off", node));
          }
        }
      }

      // A money field written into a writer call or a shape: only where the two shapes are declared and in writerCallShape.
      if (ts.isObjectLiteralExpression(node)) {
        const written = node.properties.filter((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && MONEY_FIELDS.has(p.name.getText(sf)));
        if (written.length > 0) {
          const context = checker.getContextualType(node);
          if ((isWriterMoney(typeOf(node)) || (context !== undefined && isWriterMoney(context))) && !inShapeDeclaration(file, node) && !inPlace(file, node, SHAPE_MAKER)) {
            for (const p of written) findings.push(at("write", p));
          }
        }
      }

      // A cast to a writer call or a shape: only writerCallShape brands one.
      if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && !(ts.isTypeReferenceNode(node.type) && node.type.typeName.getText(sf) === "const")) {
        if (isWriterMoney(checker.getTypeFromTypeNode(node.type)) && !inPlace(file, node, SHAPE_MAKER)) findings.push(at("cast", node));
      }
    });
  }
  return { files: production.length, findings, allowedDoorReads };
}

const STUDIO_SCAN = scan();
const show = (fs: readonly Finding[]): string[] => fs.map((f) => `${f.rule} ${f.file}:${f.line}: ${f.text}`);

describe("the writer's money has one door and three readers (static, typed)", () => {
  test("the scan reads the production source and finds the allowed door reads (it is not vacuous)", () => {
    expect(STUDIO_SCAN.files).toBeGreaterThan(300);
    const files = new Set(STUDIO_SCAN.allowedDoorReads.map((u) => u.file));
    for (const file of ["engine/sceneSets/chunks.ts", "engine/sceneSets/reviewWrites.ts", "engine/scenes/writer.ts", "engine/runs/plan.ts", "engine/autopilot/prices.ts", ESTIMATE]) {
      expect(files.has(file), file).toBe(true);
    }
  });

  test("no production module breaks a rule", () => {
    expect(show(STUDIO_SCAN.findings)).toEqual([]);
  });

  test("the door reads outside writerCallOf are of slotsPerCall and maxAttempts alone", () => {
    const fields = new Set(STUDIO_SCAN.allowedDoorReads.filter((u) => u.file !== ESTIMATE).map((u) => u.text.replace(/^.*[.[]["']?|["']?\]$/g, "")));
    expect([...fields].sort()).toEqual(["maxAttempts", "slotsPerCall"]);
  });
});

describe("the scan catches what it is for (planted fixture files)", () => {
  let dir = "";
  let planted: { findings: Finding[]; allowedDoorReads: Finding[] } = { findings: [], allowedDoorReads: [] };
  const estimate = JSON.stringify(join(STUDIO, ESTIMATE));
  const phase = JSON.stringify(join(STUDIO, PHASE));
  const prices = JSON.stringify(join(STUDIO, "engine/money/prices.ts"));
  const FIXTURES: Record<string, string> = {
    // r2.1 L2: a spread of the ordinary shape outside the door.
    "spread.ts": `import { WRITER_CALL } from ${estimate};\nexport const call = (model: string) => ({ ...WRITER_CALL, model });\n`,
    // Round 2, M2 (a): the bold shape priced whole by the book drops its reasoning (41 250 µ$).
    "bold-whole.ts": `import { writerCallOf } from ${estimate};\nimport type { PriceBook } from ${prices};\nexport const f = (book: PriceBook) => book.chatWorstCase(writerCallOf("bold"));\n`,
    // The same through a helper and a spread.
    "bold-spread.ts": [
      `import { writerCallOf, type WriterCall } from ${estimate};`,
      `import type { PriceBook } from ${prices};`,
      `const bold = (model: string): WriterCall => ({ ...writerCallOf("bold"), model });`,
      `export const f = (book: PriceBook) => book.chatWorstCase({ ...bold("m") });`,
    ].join("\n"),
    // The old ceilingOf: field by field, so the reasoning is left behind.
    "field-by-field.ts": [
      `import { writerCallOf } from ${estimate};`,
      `import type { PriceBook } from ${prices};`,
      `export function ceiling(book: PriceBook): number {`,
      `  const call = writerCallOf("bold");`,
      `  return book.chatWorstCase({ model: call.model, maxTokens: call.maxTokens, inputTokens: call["inputTokens"], images: call.images });`,
      `}`,
    ].join("\n"),
    "destructure.ts": `import { writerCallOf } from ${estimate};\nexport const { maxTokens, ...rest } = writerCallOf("bold");\n`,
    // Round 2, M2 (b): a phase shape built or rebuilt by hand under-reserves (41 250 µ$ under a 48 750 estimate).
    "forged-shape.ts": [
      `import type { WriterCallShape } from ${phase};`,
      `export const call = { maxTokens: 8_000, inputTokens: 17_000, maxAttempts: 2 } as WriterCallShape;`,
      `export const typed: WriterCallShape = { maxTokens: 8_000, inputTokens: 17_000, maxAttempts: 2 } as never;`,
    ].join("\n"),
    "override.ts": `import { writerCallOf } from ${estimate};\nimport { writerCallShape } from ${phase};\nexport const shape = { ...writerCallShape(writerCallOf("bold")), reasoningTokens: 0 };\n`,
    // Aliases, re-exports, namespaces and element access, in .ts, .mts and .js.
    "alias-reexport.ts": `export { WRITER_BOLD_CALL as B } from ${estimate};\n`,
    "alias-use.ts": `import { B as Bold } from "./alias-reexport";\nexport const size = Bold.slotsPerCall;\nexport const model = Bold.model;\n`,
    "namespace.ts": `import * as M from ${estimate};\nexport const a = M["WRITER_CALL"].slotsPerCall;\nexport const b = M.WRITER_BOLD_CALL["model"];\nexport const c = M["WRITER_CALL"];\n`,
    "module.mts": `import { WRITER_CALL } from ${estimate};\nexport const copy = { ...WRITER_CALL };\n`,
    "script.js": `import { WRITER_BOLD_CALL } from ${estimate};\nexport const tokens = WRITER_BOLD_CALL.inputTokens;\n`,
    // Controls: what the rules allow.
    "allowed.ts": [
      `import { WRITER_CALL, writerAttemptWorstMicros, writerCallOf, type WriterCall } from ${estimate};`,
      `import type { PriceBook } from ${prices};`,
      `// WRITER_CALL.model and writerCallOf("bold").maxTokens, in a comment only`,
      `export const size = WRITER_CALL.slotsPerCall;`,
      `export const tries = writerCallOf("bold").maxAttempts;`,
      `export const ordinary = (model: string): WriterCall => ({ ...writerCallOf("ordinary"), model });`,
      `export const ceiling = (book: PriceBook) => writerAttemptWorstMicros(book, ordinary("m"));`,
    ].join("\n"),
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "studio-writer-money-scan-"));
    for (const [name, code] of Object.entries(FIXTURES)) writeFileSync(join(dir, name), code);
    const scanned = scan(
      Object.keys(FIXTURES).map((name) => join(dir, name)),
      dir,
    );
    planted = { findings: scanned.findings.filter((f) => f.file.startsWith("planted/")), allowedDoorReads: scanned.allowedDoorReads.filter((f) => f.file.startsWith("planted/")) };
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const of = (name: string): string[] =>
    planted.findings
      .filter((f) => f.file === `planted/${name}`)
      .map((f) => `${f.rule}:${f.line}`)
      .sort();

  test("a spread of WRITER_CALL outside the door is caught", () => {
    expect(of("spread.ts")).toEqual(["door:2"]);
  });

  test("the bold shape handed whole to chatWorstCase is caught (M2 a)", () => {
    expect(of("bold-whole.ts")).toEqual(["hand-off:3"]);
  });

  test("the bold shape spread into chatWorstCase through a helper is caught", () => {
    expect(of("bold-spread.ts")).toEqual(["hand-off:4"]);
  });

  test("a field-by-field ceiling of the bold shape is caught at each money field, by dot or by element", () => {
    expect(of("field-by-field.ts")).toEqual(["read:5", "read:5", "read:5"]);
  });

  test("a destructuring that takes a money field or the rest is caught", () => {
    expect(of("destructure.ts")).toEqual(["read:2"]);
  });

  test("a phase shape built by hand and cast is caught, its fields and the cast (M2 b)", () => {
    // Line 3 casts to `never`, not to a writer type: its literal is caught by its fields.
    expect(of("forged-shape.ts")).toEqual(["cast:2", "write:2", "write:2", "write:3", "write:3"]);
  });

  test("a phase shape rebuilt without its reasoning is caught", () => {
    expect(of("override.ts")).toEqual(["write:3"]);
  });

  test("an aliased re-export, a namespace and an element access are followed; slotsPerCall stays allowed", () => {
    expect([of("alias-reexport.ts"), of("alias-use.ts"), of("namespace.ts")]).toEqual([[], ["door:3"], ["door:3", "door:4"]]);
    expect(planted.allowedDoorReads.filter((f) => f.file === "planted/alias-use.ts" || f.file === "planted/namespace.ts").map((f) => `${f.file}:${f.line}`)).toEqual([
      "planted/alias-use.ts:2",
      "planted/namespace.ts:2",
    ]);
  });

  test(".mts and .js files are scanned too", () => {
    expect([of("module.mts"), of("script.js")]).toEqual([["door:2"], ["door:2", "read:2"]]);
  });

  test("the allowed forms pass: the free fields, the door's spread, the one attempt price, comments", () => {
    expect(of("allowed.ts")).toEqual([]);
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
