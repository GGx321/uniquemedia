import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// 3f.6 round 3 (the drag-and-drop security review, LOW): preload.ts is a thin wire. Its `importDropped` must be the tested bridge
// (dropBridge.ts) over the real `ipcRenderer`, the gate on the preload's own window and the real `webUtils`; nothing else in it may reach the
// drop channel. preload.ts needs Electron to run, so its source is read instead (as mainDropGuard.test.ts reads main.tsx).

const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "preload.ts"), "utf8");

const parse = (source: string): ts.SourceFile => ts.createSourceFile("preload.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

/** Whether `node` is the call `callee(...args)`, each argument a plain identifier of that name. */
function isCall(node: ts.Node | undefined, callee: string, args: readonly string[]): boolean {
  if (node === undefined || !ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== callee) return false;
  return node.arguments.length === args.length && node.arguments.every((arg, i) => ts.isIdentifier(arg) && arg.text === args[i]);
}

/** The top-level `const name = <initializer>` declarations of `file`. */
function topConsts(file: ts.SourceFile, name: string): ts.Expression[] {
  return file.statements.flatMap((statement) => {
    if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) return [];
    return statement.declarationList.declarations.flatMap((d) => (ts.isIdentifier(d.name) && d.name.text === name && d.initializer !== undefined ? [d.initializer] : []));
  });
}

/** Whether the source wires the drop as it must: one top-level gate on the window, and the bridge as the exposed object's `importDropped`. */
function wiredThroughGate(source: string): boolean {
  const file = parse(source);
  const gates = topConsts(file, "dropGate");
  const [studio] = topConsts(file, "studio");
  if (gates.length !== 1 || !isCall(gates[0], "trustedDropGate", ["window"]) || studio === undefined) return false;
  const object = ts.isSatisfiesExpression(studio) || ts.isAsExpression(studio) ? studio.expression : studio;
  if (!ts.isObjectLiteralExpression(object)) return false;
  const doors = object.properties.filter((p) => !ts.isSpreadAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "importDropped");
  const [door] = doors;
  return doors.length === 1 && door !== undefined && ts.isPropertyAssignment(door) && isCall(door.initializer, "dropBridge", ["ipcRenderer", "dropGate", "webUtils"]);
}

/** Whether the source names the drop channel or the path mapping itself (a way to main around the bridge). */
function reachesDropChannel(source: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "CH" && node.name.text === "importDropped") found = true;
    if (ts.isIdentifier(node) && node.text === "droppedFiles") found = true;
    ts.forEachChild(node, visit);
  };
  visit(parse(source));
  return found;
}

test("preload.ts exposes importDropped as the bridge over ipcRenderer, the window's drop gate and webUtils, and nothing else reaches the drop channel", () => {
  expect(wiredThroughGate(SOURCE)).toBe(true);
  expect(reachesDropChannel(SOURCE)).toBe(false);
  expect(SOURCE.includes('import { dropBridge } from "./dropBridge";')).toBe(true);
  expect(SOURCE.includes("contextBridge.exposeInMainWorld(\"studio\", studio);")).toBe(true);
});

test("the check finds the wiring only where it counts", () => {
  const gate = "const dropGate = trustedDropGate(window);\n";
  const exposed = (door: string): string => `${gate}const studio: StudioApi = { version: () => ipcRenderer.invoke(CH.version), importDropped: ${door} };`;
  expect(wiredThroughGate(exposed("dropBridge(ipcRenderer, dropGate, webUtils)"))).toBe(true);
  // The gate left out (the round 3 finding), the bridge handed something else, no gate on the window, a second door.
  expect(wiredThroughGate(exposed("(files) => ipcRenderer.invoke(CH.importDropped, droppedFiles(files, webUtils))"))).toBe(false);
  expect(wiredThroughGate(exposed("dropBridge(ipcRenderer, { take: (f) => f }, webUtils)"))).toBe(false);
  expect(wiredThroughGate(exposed("dropBridge(ipcRenderer, dropGate, webUtils)").replace("trustedDropGate(window)", "trustedDropGate(document)"))).toBe(false);
  expect(wiredThroughGate(`${exposed("dropBridge(ipcRenderer, dropGate, webUtils)").slice(0, -2)}, importDropped: (f) => f };`)).toBe(false);
  expect(wiredThroughGate(`function f() { ${gate} }\nconst studio = { importDropped: dropBridge(ipcRenderer, dropGate, webUtils) };`)).toBe(false);
  expect(reachesDropChannel("ipcRenderer.invoke(CH.importDropped, x);")).toBe(true);
  expect(reachesDropChannel("const x = droppedFiles(files, webUtils);")).toBe(true);
  expect(reachesDropChannel("ipcRenderer.invoke(CH.version);")).toBe(false);
});
