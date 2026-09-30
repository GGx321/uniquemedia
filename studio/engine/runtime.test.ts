import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// The engine runs under Electron's Node while tests run under bun, so every
// module reachable from the engine entry may use only node:* APIs and must
// never read the environment (plan: "Engine runtime", invariant 1). The money
// and library folders pin this for themselves; this test follows the real
// import graph from the entry, so a new import cannot slip past it.
const ENGINE_DIR = dirname(fileURLToPath(import.meta.url));
const STUDIO_DIR = resolve(ENGINE_DIR, "..");
const ENTRY = join(ENGINE_DIR, "main.ts");
/**
 * T7c: the face worker thread is a second built entry (engine/faceWorker,
 * electron.studio.vite.config.ts) that main.ts reaches only by URL, never by
 * import — so the walk from ENTRY never sees it. It runs inside the same
 * utilityProcess and holds the same rules (no `electron`, no environment).
 */
const WORKER_ENTRY = join(ENGINE_DIR, "face", "worker", "faceWorker.ts");
/** 3b.2: the text worker thread, likewise reached by URL only (main.ts's TEXT_WORKER_URL), holding the same rules. */
const TEXT_WORKER_ENTRY = join(ENGINE_DIR, "text", "worker", "textWorker.ts");

/**
 * Bare packages the engine may bundle: the contract's validator, the ffmpeg
 * locator, onnxruntime-web (T7b, the face gate) and — security review, T7b
 * section A: the engine decodes candidate/master images itself now instead
 * of asking Electron's main process — the two WASM JPEG/PNG decoders
 * (studio/engine/decode/realBackend.ts). All are pure JS/WASM (no native
 * addon) and, like the others, never themselves read `process.env` or touch
 * `Bun`/`import.meta.dir` on the paths this module graph reaches.
 * studio/engine/face/*.ts and decode/realBackend.ts take model/codec bytes
 * and wasmPaths as parameters rather than resolving them itself, for exactly
 * this rule. The two `@jsquash/*` entries are subpath imports (`/decode.js`,
 * for the `init()` export the bare package's own index.js does not
 * re-export) rather than bare package names — the exact specifiers
 * decode/realBackend.ts actually imports, deliberately listed in full rather
 * than matched by a prefix. The explicit `.js` is required, not optional:
 * neither package declares a package.json "exports" map, so plain Node ESM
 * (the packaged app's actual runtime) never auto-appends it the way bun's
 * own resolver — and CommonJS `require()` — do; this was caught by the E2E
 * smoke against a real build, not by `bun test`.
 *
 * `@resvg/resvg-wasm` (3b.2, the text rasteriser) is the same kind of package: pure
 * JS glue over a `.wasm` that text/rasteriser.ts reads, hash-checks and compiles
 * itself (no `fetch`, no path of its own). It is a devDependency, so it is bundled,
 * and only into `textWorker.js`: only the text worker's graph imports it (a test
 * below and bundleChecks.ts's `textWorkerProblems` keep it out of `engine/main.js`).
 * Its `.wasm` is copied to out-studio/engine/wasm at build time.
 */
const ALLOWED_PACKAGES = new Set(["zod", "ffmpeg-static", "onnxruntime-web", "@jsquash/jpeg/decode.js", "@jsquash/png/decode.js", "@resvg/resvg-wasm"]);

/**
 * Where engine code may live: its own tree, studio/node, the pure contract, the pure montage and sticker modules,
 * and the uniquifier's src/core and src/node, which Studio may import (never
 * edit) — held to the same rules below.
 */
const ALLOWED_ROOTS = [
  ...["engine", "node", join("shared", "engine"), join("shared", "montage"), join("shared", "stickers")].map((d) => join(STUDIO_DIR, d)),
  ...[join("src", "core"), join("src", "node")].map((d) => join(STUDIO_DIR, "..", d)),
];

/**
 * The only members of `process` engine code may touch: the utilityProcess
 * port, exiting, and the platform (read by T2's ledger). Everything else —
 * `env` above all — is out, however it is spelled.
 */
const ALLOWED_PROCESS_MEMBERS = new Set(["parentPort", "exit", "platform"]);

interface ModuleScan {
  imports: string[];
  problems: string[];
}

function isModuleSpecifier(node: ts.Node): boolean {
  const parent = node.parent;
  return parent !== undefined && (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node;
}

/**
 * Scans one module's syntax tree, so comments and string contents never
 * count. Flags every `process` identifier except `process.<allowed member>`,
 * a string literal "process", `Bun`, `require`, `import.meta.dir`, a dynamic
 * import of a computed specifier, and every import other than node:* (but
 * node:process), a relative path or an allowed package.
 */
function scan(source: string): ModuleScan {
  const file = ts.createSourceFile("module.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imports: string[] = [];
  const problems: string[] = [];
  const at = (node: ts.Node) => `line ${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;

  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [arg] = node.arguments;
      if (arg !== undefined && ts.isStringLiteralLike(arg)) imports.push(arg.text);
      else problems.push(`${at(node)}: dynamic import of a computed specifier`);
    } else if (ts.isImportEqualsDeclaration(node)) {
      problems.push(`${at(node)}: import = require`);
    } else if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const allowedProcess =
        parent !== undefined && ts.isPropertyAccessExpression(parent) && parent.expression === node && ALLOWED_PROCESS_MEMBERS.has(parent.name.text);
      if (node.text === "process" && !allowedProcess) problems.push(`${at(node)}: process (only .parentPort, .exit, .platform)`);
      if (node.text === "Bun") problems.push(`${at(node)}: Bun`);
      if (node.text === "require") problems.push(`${at(node)}: require`);
    } else if (ts.isStringLiteralLike(node) && node.text === "process" && !isModuleSpecifier(node)) {
      problems.push(`${at(node)}: "process" as a string`);
    } else if (ts.isMetaProperty(node) && node.parent !== undefined && ts.isPropertyAccessExpression(node.parent) && node.parent.name.text === "dir") {
      problems.push(`${at(node)}: import.meta.dir`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  for (const specifier of imports) {
    const allowed =
      (specifier.startsWith("node:") && specifier !== "node:process") ||
      specifier.startsWith("./") ||
      specifier.startsWith("../") ||
      ALLOWED_PACKAGES.has(specifier);
    if (!allowed) problems.push(`imports ${specifier}`);
  }
  return { imports, problems };
}

function problemsIn(source: string): string[] {
  return scan(source).problems;
}

function resolveRelative(from: string, specifier: string): string {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [`${base}.ts`, join(base, "index.ts"), base]) {
    if (candidate.endsWith(".ts") && existsSync(candidate)) return candidate;
  }
  throw new Error(`${relative(STUDIO_DIR, from)}: cannot resolve ${specifier}`);
}

interface Graph {
  files: string[];
  problems: string[];
}

function walkFromEntry(entry: string = ENTRY): Graph {
  const seen = new Set<string>();
  const problems: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    const name = relative(STUDIO_DIR, file);
    if (!ALLOWED_ROOTS.some((root) => file.startsWith(root + sep))) problems.push(`${name}: outside the engine's allowed folders`);
    const result = scan(readFileSync(file, "utf8"));
    problems.push(...result.problems.map((p) => `${name}: ${p}`));
    for (const specifier of result.imports) {
      if (specifier.startsWith("./") || specifier.startsWith("../")) queue.push(resolveRelative(file, specifier));
    }
  }
  return { files: [...seen].map((f) => relative(STUDIO_DIR, f)).sort(), problems };
}

describe("the checker itself catches every way to reach the environment", () => {
  const mutants: [string, string][] = [
    ["process.env", "export const a = process.env.OPENROUTER_API_KEY;"],
    ["destructuring", "const { env } = process;\nexport const a = env.X;"],
    ["computed access", 'export const a = process["env"];'],
    ["an alias", "const p = process;\nexport const a = p.env;"],
    ["globalThis", "export const a = globalThis.process.env;"],
    ["a string lookup", 'export const a = Reflect.get(globalThis, "process");'],
    ["node:process", 'import { env } from "node:process";\nexport const a = env;'],
    ["bare process module", 'import proc from "process";\nexport const a = proc.env;'],
    ["require", 'export const a = require("node:process");'],
    ["Bun", "export const a = Bun.env;"],
    ["import.meta.dir", "export const a = import.meta.dir;"],
    ["an electron import", 'import { app } from "electron";\nexport const a = app;'],
  ];
  for (const [name, source] of mutants) {
    test(`flags ${name}`, () => {
      expect(problemsIn(source)).not.toEqual([]);
    });
  }

  test("allows process.parentPort, process.exit and process.platform, and ignores comments and strings", () => {
    const source = [
      "// process.env is never read here",
      "/* const { env } = process; */",
      'const message = "the process exited";',
      "export const port = process.parentPort;",
      "export const platform = process.platform;",
      "export function stop(): never { return process.exit(1); }",
    ].join("\n");
    expect(problemsIn(source)).toEqual([]);
  });
});

test("the walk reaches the engine's dispatcher, the control schema, money and the contract", () => {
  const { files } = walkFromEntry();
  expect(files).toContain(join("engine", "main.ts"));
  expect(files).toContain(join("engine", "engine.ts"));
  expect(files).toContain(join("engine", "control.ts"));
  expect(files).toContain(join("engine", "buildFlags.ts"));
  expect(files).toContain(join("engine", "money", "budget.ts"));
  expect(files).toContain(join("engine", "library", "library.ts"));
  expect(files).toContain(join("shared", "engine", "index.ts"));
});

test("every module reachable from the engine entry uses only node:* APIs and never reads the environment", () => {
  expect(walkFromEntry().problems).toEqual([]);
});

test("the walk from the face worker entry reaches its gate, decoder and protocol", () => {
  const { files } = walkFromEntry(WORKER_ENTRY);
  expect(files).toContain(join("engine", "face", "worker", "faceWorker.ts"));
  expect(files).toContain(join("engine", "face", "worker", "protocol.ts"));
  expect(files).toContain(join("engine", "face", "gate.ts"));
  expect(files).toContain(join("engine", "decode", "realBackend.ts"));
});

test("every module reachable from the face worker entry uses only node:* APIs and never reads the environment", () => {
  expect(walkFromEntry(WORKER_ENTRY).problems).toEqual([]);
});

test("the walk from the text worker entry reaches its rasteriser, fonts and protocol, and only there does resvg come in", () => {
  const { files } = walkFromEntry(TEXT_WORKER_ENTRY);
  expect(files).toContain(join("engine", "text", "rasteriser.ts"));
  expect(files).toContain(join("engine", "text", "fonts.ts"));
  expect(files).toContain(join("engine", "text", "worker", "protocol.ts"));
  // The engine's own graph holds the gate and the shared types, never the rasteriser that imports resvg.
  expect(walkFromEntry().files).not.toContain(join("engine", "text", "rasteriser.ts"));
  expect(walkFromEntry().files).toContain(join("engine", "text", "worker", "textGate.ts"));
});

test("every module reachable from the text worker entry uses only node:* APIs and never reads the environment", () => {
  expect(walkFromEntry(TEXT_WORKER_ENTRY).problems).toEqual([]);
});

// S8: the focus resolver is not wired into main.ts yet (slice 3d does that), so
// the walk from the engine entry cannot see it. It runs in the engine, so it is
// held to the same rules on its own, including the pure montage geometry it uses
// for the fallback point (`shared/montage` is an allowed root for that reason).
const FOCUS_ENTRY = join(ENGINE_DIR, "focus", "focusResolver.ts");

test("the walk from the focus resolver reaches its cache and the montage geometry", () => {
  const { files } = walkFromEntry(FOCUS_ENTRY);
  expect(files).toContain(join("engine", "focus", "focusCache.ts"));
  expect(files).toContain(join("shared", "montage", "crop.ts"));
});

test("every module reachable from the focus resolver uses only node:* APIs and never reads the environment", () => {
  expect(walkFromEntry(FOCUS_ENTRY).problems).toEqual([]);
});
