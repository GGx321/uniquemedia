import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// 3f.6 round 2 (N20): the window-wide guard against files dropped anywhere but the «Мои» drop zone is installed by the renderer's entry
// (main.tsx), on the window, at the module's top level: not behind a condition, and not only in a component that may never mount. main.tsx
// renders the App when imported, so its source is read instead (as main.test.ts reads main.ts).

const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "main.tsx"), "utf8");

/** The top-level statements of `source` that are a plain call `installFileDropGuard(window)`. */
function guardCalls(source: string): ts.CallExpression[] {
  const file = ts.createSourceFile("main.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return file.statements.flatMap((statement) => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return [];
    const call = statement.expression;
    const [arg] = call.arguments;
    const named = ts.isIdentifier(call.expression) && call.expression.text === "installFileDropGuard";
    return named && call.arguments.length === 1 && arg !== undefined && ts.isIdentifier(arg) && arg.text === "window" ? [call] : [];
  });
}

test("main.tsx installs the drop guard on the window, once, at its top level", () => {
  expect(guardCalls(SOURCE)).toHaveLength(1);
  expect(SOURCE.includes('import { installFileDropGuard } from "./screens/montage/mine";')).toBe(true);
});

test("the check finds the call only where it counts: not behind a condition, not in a function", () => {
  expect(guardCalls("if (x) installFileDropGuard(window);")).toHaveLength(0);
  expect(guardCalls("function f() { installFileDropGuard(window); }")).toHaveLength(0);
  expect(guardCalls("installFileDropGuard(document);")).toHaveLength(0);
  expect(guardCalls("installFileDropGuard(window);")).toHaveLength(1);
});
