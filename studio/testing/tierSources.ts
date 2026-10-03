import ts from "typescript";
import { type Tier, tierMarkers, tierTag } from "./tiers";

/**
 * Reading test SOURCES for tier markers, by call site (the TypeScript AST), not by text: a string that merely mentions `perfTest(` (a
 * fixture in a test of the runner, a comment) is not a test of the perf tier. Used by realWorkerTests.ts to open only the files that
 * hold a tier's tests, and by tiers.test.ts to check that the tags, the node suites' tier counts and the budgets agree.
 */

/** The functions that register a test (or a suite) with the name as their first argument. */
const NAMING_CALLEES = new Set(["test", "it", "describe", "perfTest", "perfOnlyTest", "heavyTest"]);

/** The helper names (bunTiers.ts, quarantine.ts) that put a test into a tier, by tier. */
const HELPER_CALLEES: Readonly<Record<Tier, readonly string[]>> = {
  perf: ["perfTest", "perfOnlyTest"],
  heavy: ["heavyTest"],
  quarantine: ["quarantinedTest", "inQuarantineRun"],
};

function parse(source: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

/** The function a call names: `test(...)`, `test.each(...)(...)`, `test.skipIf(c)(...)` are all `test`. */
function calleeName(call: ts.CallExpression): string | undefined {
  let expression: ts.Expression = call.expression;
  for (;;) {
    if (ts.isCallExpression(expression)) expression = expression.expression;
    else if (ts.isPropertyAccessExpression(expression)) expression = expression.expression;
    else break;
  }
  return ts.isIdentifier(expression) ? expression.text : undefined;
}

/** The literal text a test name starts with (a template's head counts), or undefined when the first argument is not a string. */
function nameStart(call: ts.CallExpression): string | undefined {
  const [first] = call.arguments;
  if (first === undefined) return undefined;
  if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) return first.text;
  if (ts.isTemplateExpression(first)) return first.head.text;
  return undefined;
}

function calls(file: ts.SourceFile): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Whether `source` holds a test of `tier`: a call of one of its helpers, `inTier("<tier>", ...)`, or a test whose name starts with its tag. */
export function holdsTierTests(source: string, tier: Tier, fileName = "test.ts"): boolean {
  if (!tierMarkers(tier).some((marker) => source.includes(marker)) && !source.includes("inTier(")) return false;
  return calls(parse(source, fileName)).some((call) => {
    const callee = calleeName(call);
    if (callee === undefined) return false;
    if (HELPER_CALLEES[tier].includes(callee)) return true;
    if (callee === "inTier") return nameStart(call) === tier;
    return NAMING_CALLEES.has(callee) && (nameStart(call) ?? "").startsWith(tierTag(tier));
  });
}

/** The leading `[xxx]` of every test or suite name in `source`: `xxx` should be a tier, or a typo has dropped the test out of every tier run. */
export function nameTags(source: string, fileName = "test.ts"): { line: number; tag: string }[] {
  const file = parse(source, fileName);
  return calls(file).flatMap((call) => {
    const callee = calleeName(call);
    const tag = callee !== undefined && NAMING_CALLEES.has(callee) ? /^\[([^\]]*)\]/.exec(nameStart(call) ?? "")?.[1] : undefined;
    return tag === undefined ? [] : [{ line: file.getLineAndCharacterOfPosition(call.getStart(file)).line + 1, tag }];
  });
}

/** The ids named by `quarantinedTest("<id>", ...)` and `inQuarantineRun("<id>")` calls in `source`. */
export function quarantineIds(source: string, fileName = "test.ts"): string[] {
  return calls(parse(source, fileName)).flatMap((call) => {
    const callee = calleeName(call);
    const [first] = call.arguments;
    return callee !== undefined && HELPER_CALLEES.quarantine.includes(callee) && first !== undefined && ts.isStringLiteral(first) ? [first.text] : [];
  });
}

/** The `assertBudget(...)` calls in `source` that do not sit inside a test the perf run selects (a `perfTest`/`perfOnlyTest`, or a test named `[perf] ...`). */
export function budgetsOutsidePerfTests(source: string, fileName = "test.ts"): number[] {
  const file = parse(source, fileName);
  const outside: number[] = [];
  const visit = (node: ts.Node, inPerf: boolean): void => {
    let perf = inPerf;
    if (ts.isCallExpression(node)) {
      const callee = calleeName(node);
      if (callee === "assertBudget" && !inPerf) outside.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
      if (callee !== undefined && HELPER_CALLEES.perf.includes(callee)) perf = true;
      if (callee !== undefined && NAMING_CALLEES.has(callee) && (nameStart(node) ?? "").startsWith(tierTag("perf"))) perf = true;
    }
    ts.forEachChild(node, (child) => visit(child, perf));
  };
  visit(file, false);
  return outside;
}
