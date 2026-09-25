import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// The bundle-level scan in bundleChecks.ts reads compiled JS by text markers,
// which is cheap but blind to the difference between "a top-level statement"
// and "a statement one indentation level deeper". This test reads
// studio/main/main.ts's own source with the TypeScript compiler API instead,
// the same approach as studio/engine/runtime.test.ts and
// studio/engine/avatars/prompts.test.ts: it checks the real syntax tree.
//
// Threat model: these rules guard against an ACCIDENTAL regression — gating
// the refusal on `app.isPackaged`, moving it into a helper, reopening a
// switch for local convenience. They do not guard against a malicious
// committer, who could edit this file too. So each rule below is a strict
// whitelist for the one shape the refusal is allowed to take, not a hunt for
// every way a determined author could disguise a bypass. A harmless refactor
// — the switch names moved into a named const, `app.commandLine` given a
// shorter alias — fails these checks on purpose: the rule matches one
// literal shape, and anything else, harmless or not, is unexpected.
const MAIN_DIR = dirname(fileURLToPath(import.meta.url));
const SWITCH_NAMES = ["remote-debugging-port", "remote-debugging-pipe", "remote-debugging-address"] as const;

// The real shape of studio/main/main.ts's refusal, trimmed to what the rules care about.
const CLEAN_SOURCE = `
if (!DEBUGGABLE) {
  for (const name of ["remote-debugging-port", "remote-debugging-pipe", "remote-debugging-address"]) app.commandLine.removeSwitch(name);
  if (process.argv.some((arg) => arg.startsWith("--remote-debugging-"))) {
    console.warn("studio: ignoring --remote-debugging-port/--remote-debugging-pipe/--remote-debugging-address (production build)");
  }
}
const userDataSwitch = app.commandLine.getSwitchValue("user-data-dir");
`;

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** `app.commandLine.<method>(...)`, however the call expression is written. */
function isCommandLineCall(node: ts.Node, method: string): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== method) return false;
  const target = callee.expression;
  return ts.isPropertyAccessExpression(target) && target.name.text === "commandLine" && ts.isIdentifier(target.expression) && target.expression.text === "app";
}

function stringArg(call: ts.CallExpression): string | undefined {
  const [arg] = call.arguments;
  return arg !== undefined && ts.isStringLiteralLike(arg) ? arg.text : undefined;
}

function loopVariableName(loop: ts.ForOfStatement): string | undefined {
  const init = loop.initializer;
  if (!ts.isVariableDeclarationList(init) || init.declarations.length !== 1) return undefined;
  const [decl] = init.declarations;
  return decl !== undefined && ts.isIdentifier(decl.name) ? decl.name.text : undefined;
}

function isNotDebuggable(expr: ts.Expression): boolean {
  return ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken && ts.isIdentifier(expr.operand) && expr.operand.text === "DEBUGGABLE";
}

/** `for (const name of [<the three switch names, in any order>]) app.commandLine.removeSwitch(name);` — the one allowed loop shape. */
function isRefusalLoop(node: ts.Statement): node is ts.ForOfStatement {
  if (!ts.isForOfStatement(node) || !ts.isArrayLiteralExpression(node.expression)) return false;
  const names = node.expression.elements.filter(ts.isStringLiteralLike).map((el) => el.text);
  if (names.length !== SWITCH_NAMES.length || !SWITCH_NAMES.every((n) => names.includes(n))) return false;
  const body = ts.isBlock(node.statement) ? node.statement.statements[0] : node.statement;
  const loopVar = loopVariableName(node);
  if (body === undefined || !ts.isExpressionStatement(body) || !isCommandLineCall(body.expression, "removeSwitch")) return false;
  const [arg] = body.expression.arguments;
  return loopVar !== undefined && arg !== undefined && ts.isIdentifier(arg) && arg.text === loopVar;
}

/**
 * The whitelist, as a function over source text: the refusal loop must be
 * the FIRST statement of the `then` block of a module-top-level
 * `if (!DEBUGGABLE)` — nothing else. This alone rules out every wrapper
 * (function, arrow, method, class, extra loop, wrong condition, an else
 * branch) and the reviewer's labeled-block bypass (`refusal: { if (cond)
 * break refusal; for (...) ... }`), because a `LabeledStatement` is not a
 * `ForOfStatement`: whatever sits first under the `if` that is not literally
 * the loop fails, without this rule needing to know what it is.
 */
function refusalProblems(source: string): string[] {
  const file = parse(source);
  const ifStmt = file.statements.find((s): s is ts.IfStatement => ts.isIfStatement(s) && isNotDebuggable(s.expression));
  if (ifStmt === undefined) return ["no module-top-level `if (!DEBUGGABLE)` statement was found"];
  if (!ts.isBlock(ifStmt.thenStatement)) return ["the `if (!DEBUGGABLE)` body is not a block"];
  const first = ifStmt.thenStatement.statements[0];
  if (first === undefined) return ["the `if (!DEBUGGABLE)` block is empty"];
  if (!isRefusalLoop(first)) return [`the first statement under \`if (!DEBUGGABLE)\` is not the refusal loop over the three switch names (found ${ts.SyntaxKind[first.kind]})`];
  return [];
}

/** Every `LabeledStatement` in the file. Main never uses one: a label lets a runtime `break`/`continue` skip part of a block without that decision showing up as an `if` anywhere nearby. */
function labeledStatementProblems(source: string, label: string): string[] {
  const file = parse(source);
  const problems: string[] = [];
  const at = (node: ts.Node) => `${label}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;
  const visit = (node: ts.Node): void => {
    if (ts.isLabeledStatement(node)) problems.push(`${at(node)}: a labeled statement (${node.label.text}:)`);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return problems;
}

/** True when accessing `commandLine` (the node just before it in the chain) leads straight into a further `.member(...)` call, never into a variable, argument, or anything else it could be reused from. */
function isImmediateCallChain(access: ts.Node): boolean {
  const next = access.parent;
  if (next === undefined) return false;
  const isFurtherAccess = (ts.isPropertyAccessExpression(next) && next.expression === access) || (ts.isElementAccessExpression(next) && next.expression === access);
  if (!isFurtherAccess) return false;
  const call = next.parent;
  return call !== undefined && ts.isCallExpression(call) && call.expression === next;
}

/**
 * Every access to `commandLine` — `.commandLine`, `["commandLine"]`, or a
 * bare `"commandLine"` string — that is not immediately followed by a
 * `.member(...)` call. `app.commandLine.getSwitchValue(...)` and the
 * refusal's own `app.commandLine.removeSwitch(...)` both pass: they call
 * straight through. `const cl = app.commandLine;` fails: `commandLine` is
 * handed to a variable instead, and nothing here can tell a harmless alias
 * from one that gets `.appendSwitch`ed later — so neither is allowed.
 */
function commandLineAccessProblems(source: string, label: string): string[] {
  const file = parse(source);
  const problems: string[] = [];
  const at = (node: ts.Node) => `${label}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === "commandLine" && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) {
      if (!isImmediateCallChain(node.parent)) problems.push(`${at(node)}: .commandLine is not used as an immediate app.commandLine.<member>(...) call`);
    } else if (ts.isStringLiteralLike(node) && node.text === "commandLine") {
      if (ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node) {
        if (!isImmediateCallChain(node.parent)) problems.push(`${at(node)}: ["commandLine"] is not used as an immediate call`);
      } else {
        problems.push(`${at(node)}: a "commandLine" string literal outside a direct property/element access`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return problems;
}

/** Every `appendSwitch` identifier or string anywhere: main only ever removes switches, never appends one, so the word itself is the problem, whatever it is trying to append and however `commandLine` was reached. */
function appendSwitchProblems(source: string, label: string): string[] {
  const file = parse(source);
  const problems: string[] = [];
  const at = (node: ts.Node) => `${label}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;
  const visit = (node: ts.Node): void => {
    if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isPrivateIdentifier(node)) && node.text === "appendSwitch") {
      problems.push(`${at(node)}: appendSwitch`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return problems;
}

/** A literal, duplicate `removeSwitch("<a switch name>")` call outside the canonical loop (whose own call passes a variable, never a literal). */
function duplicateRemoveSwitchProblems(source: string, label: string): string[] {
  const file = parse(source);
  const problems: string[] = [];
  const at = (node: ts.Node) => `${label}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;
  const visit = (node: ts.Node): void => {
    if (isCommandLineCall(node, "removeSwitch")) {
      const name = stringArg(node);
      if (name !== undefined && (SWITCH_NAMES as readonly string[]).includes(name)) {
        problems.push(`${at(node)}: app.commandLine.removeSwitch(${JSON.stringify(name)}) outside the canonical loop`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return problems;
}

describe("refusalProblems: the refusal loop must be the first statement of a module-top-level `if (!DEBUGGABLE)`", () => {
  test("passes the clean shape (the real main.ts's, trimmed)", () => {
    expect(refusalProblems(CLEAN_SOURCE)).toEqual([]);
  });

  test("fails when the refusal is missing entirely", () => {
    expect(refusalProblems("const x = 1;")).toEqual(["no module-top-level `if (!DEBUGGABLE)` statement was found"]);
  });

  test("fails the round-1 bypass: declared as a function, called only conditionally elsewhere", () => {
    const mutated = `
function closeDebugDoors() {
  if (!DEBUGGABLE) {
    for (const name of ["remote-debugging-port", "remote-debugging-pipe", "remote-debugging-address"]) app.commandLine.removeSwitch(name);
  }
}
if (process.env.STUDIO_SKIP_HARDENING !== "1") closeDebugDoors();
`;
    expect(refusalProblems(mutated)).toEqual(["no module-top-level `if (!DEBUGGABLE)` statement was found"]);
  });

  test("fails the round-2 bypass: a labeled block a runtime check can `break` out of", () => {
    // `refusal: { if (cond) break refusal; for (...) ... }` — the loop is no
    // longer the first statement under `if (!DEBUGGABLE)`; a LabeledStatement is.
    const mutated = `
if (!DEBUGGABLE) {
  refusal: {
    if (process.env.STUDIO_SNEAK === "1") break refusal;
    for (const name of ["remote-debugging-port", "remote-debugging-pipe", "remote-debugging-address"]) app.commandLine.removeSwitch(name);
  }
}
`;
    const problems = refusalProblems(mutated);
    expect(problems.some((p) => p.includes("is not the refusal loop"))).toBe(true);
  });

  test("fails when the guard is `if (app.isPackaged)` instead of `if (!DEBUGGABLE)`", () => {
    const mutated = CLEAN_SOURCE.replace("if (!DEBUGGABLE)", "if (app.isPackaged)");
    expect(refusalProblems(mutated)).toEqual(["no module-top-level `if (!DEBUGGABLE)` statement was found"]);
  });

  test("fails when the guard is a process.env check", () => {
    const mutated = CLEAN_SOURCE.replace("if (!DEBUGGABLE)", 'if (process.env.STUDIO_ALLOW_DEBUG === "1")');
    expect(refusalProblems(mutated)).toEqual(["no module-top-level `if (!DEBUGGABLE)` statement was found"]);
  });

  test("fails when the refusal sits in the else branch of `if (!DEBUGGABLE)` (runs only when DEBUGGABLE is true — inverted)", () => {
    const mutated = `
if (!DEBUGGABLE) {
} else {
  for (const name of ["remote-debugging-port", "remote-debugging-pipe", "remote-debugging-address"]) app.commandLine.removeSwitch(name);
}
`;
    expect(refusalProblems(mutated)).toEqual(["the `if (!DEBUGGABLE)` block is empty"]);
  });

  test("fails when nested in an extra loop", () => {
    const mutated = `
if (!DEBUGGABLE) {
  for (let i = 0; i < 1; i++) {
    for (const name of ["remote-debugging-port", "remote-debugging-pipe", "remote-debugging-address"]) app.commandLine.removeSwitch(name);
  }
}
`;
    const problems = refusalProblems(mutated);
    expect(problems.some((p) => p.includes("is not the refusal loop"))).toBe(true);
  });
});

describe("labeledStatementProblems: main.ts never uses a label", () => {
  test("the clean source has none", () => {
    expect(labeledStatementProblems(CLEAN_SOURCE, "main.ts")).toEqual([]);
  });

  test("flags the round-2 labeled-block bypass even if it were placed correctly otherwise", () => {
    const source = 'refusal: {\n  if (x) break refusal;\n  doSomething();\n}';
    expect(labeledStatementProblems(source, "main.ts")).toEqual(["main.ts:1: a labeled statement (refusal:)"]);
  });
});

describe("commandLineAccessProblems: commandLine is only ever accessed as an immediate app.commandLine.<member>(...) call", () => {
  test("the clean source has none (getSwitchValue and the loop's removeSwitch are both immediate chains)", () => {
    expect(commandLineAccessProblems(CLEAN_SOURCE, "main.ts")).toEqual([]);
  });

  test("fails the round-2 alias bypass: `const cl = app.commandLine;`", () => {
    const source = 'const cl = app.commandLine;\nif (x) cl.appendSwitch("remote-debugging-port", "9222");';
    const problems = commandLineAccessProblems(source, "evil.ts");
    expect(problems).toEqual(["evil.ts:1: .commandLine is not used as an immediate app.commandLine.<member>(...) call"]);
  });

  test("fails a computed-access alias too: `const cl = app[\"commandLine\"];`", () => {
    const source = 'const cl = app["commandLine"];';
    const problems = commandLineAccessProblems(source, "evil.ts");
    expect(problems).toEqual(['evil.ts:1: ["commandLine"] is not used as an immediate call']);
  });

  test("fails a bare commandLine string used as data, e.g. Reflect.get(app, \"commandLine\")", () => {
    const problems = commandLineAccessProblems('Reflect.get(app, "commandLine");', "evil.ts");
    expect(problems).toEqual(['evil.ts:1: a "commandLine" string literal outside a direct property/element access']);
  });
});

describe("appendSwitchProblems: no file may mention appendSwitch at all", () => {
  test("the clean source has none", () => {
    expect(appendSwitchProblems(CLEAN_SOURCE, "main.ts")).toEqual([]);
  });

  test("fails the round-2 alias bypass even though `commandLine` itself never appears on the same line", () => {
    const problems = appendSwitchProblems('cl.appendSwitch("remote-debugging-port", "9222");', "evil.ts");
    expect(problems).toEqual(["evil.ts:1: appendSwitch"]);
  });

  test("fails appendSwitch spelled as a string, e.g. through a computed call", () => {
    const problems = appendSwitchProblems('app.commandLine["appendSwitch"]("remote-debugging-port");', "evil.ts");
    expect(problems).toEqual(["evil.ts:1: appendSwitch"]);
  });
});

describe("duplicateRemoveSwitchProblems: no second, literal removeSwitch call for a switch name", () => {
  test("the clean source has none (the loop's own call passes a variable, not a literal)", () => {
    expect(duplicateRemoveSwitchProblems(CLEAN_SOURCE, "main.ts")).toEqual([]);
  });

  test("flags a duplicate literal removeSwitch call outside the canonical loop", () => {
    const problems = duplicateRemoveSwitchProblems('app.commandLine.removeSwitch("remote-debugging-pipe");', "evil.ts");
    expect(problems).toEqual(['evil.ts:1: app.commandLine.removeSwitch("remote-debugging-pipe") outside the canonical loop']);
  });
});

// Applies every rule above, each a pure function over source text as tested
// above, to the real file and, for the file-wide rules, to every other file
// under studio/main.
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("the real studio/main/main.ts", () => {
  const mainSource = readFileSync(join(MAIN_DIR, "main.ts"), "utf8");

  test("the refusal loop is the first statement of a module-top-level `if (!DEBUGGABLE)`", () => {
    expect(refusalProblems(mainSource)).toEqual([]);
  });

  test("main.ts uses no labeled statement", () => {
    expect(labeledStatementProblems(mainSource, "main.ts")).toEqual([]);
  });

  test("every file under studio/main accesses commandLine only as an immediate call, never appends a switch, and never duplicates the refusal's removeSwitch call", () => {
    const files = sourceFiles(MAIN_DIR);
    expect(files.length).toBeGreaterThan(5); // the scan is not vacuous
    const problems = files.flatMap((path) => {
      const source = readFileSync(path, "utf8");
      const label = relative(MAIN_DIR, path);
      return [...commandLineAccessProblems(source, label), ...appendSwitchProblems(source, label), ...duplicateRemoveSwitchProblems(source, label)];
    });
    expect(problems).toEqual([]);
  });
});
