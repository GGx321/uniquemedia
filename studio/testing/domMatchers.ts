import ts from "typescript";

/**
 * Why a DOM node must never be the received value of a failing `expect`: when `expect(node).toBeNull()` (or `toBe`, `toEqual`,
 * `toBeUndefined`, ...) FAILS, Bun prints the received node, and a happy-dom node's printout is its whole graph (parent,
 * children, window, document, listeners...), without end. The process then keeps printing until it is killed, so one red
 * assertion turns into a shard that hangs to its bound (found in 3c.6: a failing EditorScreen.render.test.tsx never exited).
 *
 * The fix is to assert on a boolean or on text with the same meaning: `expect(screen.queryByText("x") === null).toBe(true)`.
 * This module finds the assertions that still hand a node to a matcher that prints its received value; domMatchers.test.ts
 * fails the run on any, so none comes back.
 */

/** Calls that return a DOM node, or a collection of nodes, as the last step of the expression. */
const NODE_CALLS = /^(?:(?:query|get|find)(?:All)?By\w+|querySelector(?:All)?|closest|getElementById|getElementsBy\w+|elementFromPoint|cloneNode)$/;

/** Properties that hold a DOM node (or a collection of them) as the last step of the expression. */
const NODE_PROPERTIES = new Set([
  "activeElement",
  "parentElement",
  "parentNode",
  "firstElementChild",
  "lastElementChild",
  "firstChild",
  "lastChild",
  "nextElementSibling",
  "previousElementSibling",
  "nextSibling",
  "previousSibling",
  "childNodes",
  "children",
  "ownerDocument",
  "documentElement",
]);

/**
 * Matchers that are safe on a node: when they fail, the received value is null, undefined or a boolean, not a node
 * (`toBeDefined` and `toBeTruthy` fail only on undefined/null/false; `not.toBeNull` and `not.toBeUndefined` only on null/undefined;
 * `toHaveLength` prints the two lengths, not the collection: checked on Bun 1.3.12 against a happy-dom NodeList).
 */
const SAFE_MATCHERS = new Set(["toBeDefined", "toBeTruthy", "not.toBeNull", "not.toBeUndefined", "not.toBeFalsy", "toHaveLength", "not.toHaveLength"]);

export interface DomMatcherUse {
  line: number;
  text: string;
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current) || ts.isAsExpression(current) || ts.isAwaitExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}

/** Whether the value of `node` is a DOM node (or a list of them) by its last step. A `?.textContent`, a `=== null`, a `.length` are not. */
export function isNodeValued(node: ts.Expression, bindings: ReadonlyMap<string, ts.Expression> = new Map(), seen: ReadonlySet<string> = new Set()): boolean {
  const expression = unwrap(node);
  // `const again = screen.getByRole(...)` and then `expect(again)`: the variable is as much a node as its initializer (same file, any scope: a name
  // reused for something else in another scope is flagged too, and is cheap to rename).
  if (ts.isIdentifier(expression)) {
    const init = bindings.get(expression.text);
    return init !== undefined && !seen.has(expression.text) && isNodeValued(init, bindings, new Set([...seen, expression.text]));
  }
  if (ts.isCallExpression(expression)) {
    const callee = unwrap(expression.expression);
    const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : undefined;
    return name !== undefined && NODE_CALLS.test(name);
  }
  if (ts.isPropertyAccessExpression(expression)) {
    // `document.body`, and only that one: a request's or a response's `.body` is not a node.
    if (expression.name.text === "body") return ts.isIdentifier(expression.expression) && expression.expression.text === "document";
    return NODE_PROPERTIES.has(expression.name.text);
  }
  if (ts.isElementAccessExpression(expression)) return isNodeValued(expression.expression, bindings, seen);
  return false;
}

/**
 * The `expect(<node>).<matcher>(...)` calls in `source` whose matcher prints the received value. `expect(x).not.toBe(...)`
 * and `expect(x).resolves...` are read through their chain. A custom matcher chain is judged by its dotted name.
 */
export function domNodeMatcherUses(source: string, fileName = "test.tsx"): DomMatcherUse[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: DomMatcherUse[] = [];
  const bindings = new Map<string, ts.Expression>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) bindings.set(node.name.text, node.initializer);
    ts.forEachChild(node, collect);
  };
  collect(file);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      // Walk down the matcher chain (`.not.toBe`) to the `expect(...)` call at its root.
      const names: string[] = [node.expression.name.text];
      let inner: ts.Expression = node.expression.expression;
      while (ts.isPropertyAccessExpression(inner)) {
        names.unshift(inner.name.text);
        inner = inner.expression;
      }
      if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression) && inner.expression.text === "expect" && inner.arguments.length === 1) {
        const [received] = inner.arguments;
        const matcher = names.join(".");
        if (received !== undefined && isNodeValued(received, bindings) && !SAFE_MATCHERS.has(matcher)) {
          found.push({ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, text: node.getText(file).split("\n")[0] ?? "" });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}
