import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

// The contract is imported by the renderer, main and the engine, so its
// production modules must run anywhere: no Bun, no Node, no environment, and
// nothing outside this folder but zod.
const ENGINE_DIR = import.meta.dir;
const SHARED_TSCONFIG = resolve(ENGINE_DIR, "../tsconfig.json");
const TSC = resolve(ENGINE_DIR, "../../../node_modules/typescript/bin/tsc");

type Loader = "ts" | "tsx" | "js" | "jsx";
const LOADERS: Record<string, Loader> = {
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".jsx": "jsx",
};

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const productionFiles = walk(ENGINE_DIR).filter((f) => !/\.test\.[cm]?[jt]sx?$/.test(f));

function allowedImport(specifier: string, fromFile: string): boolean {
  if (specifier === "zod") return true;
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return false;
  const target = resolve(dirname(fromFile), specifier);
  return target === ENGINE_DIR || target.startsWith(ENGINE_DIR + sep);
}

const FORBIDDEN = /\b(?:process|Buffer|Bun|require)\b|globalThis\s*\[/g;

describe("shared engine contract", () => {
  test(
    "typechecks with no Node or Bun types (studio/shared/tsconfig.json)",
    () => {
      const r = spawnSync(process.execPath, [TSC, "-p", SHARED_TSCONFIG], { encoding: "utf8" });
      expect(`${r.stdout}${r.stderr}`).toBe("");
      expect(r.status).toBe(0);
    },
    60_000,
  );

  // Each probe must fail under the shared tsconfig: DOM globals would crash the
  // engine (a utilityProcess has no window), Node and Bun globals the renderer.
  const PROBES: [string, string][] = [
    ["window", "export const probe = window.location.href;"],
    ["document", "export const probe = document.title;"],
    ["process", "export const probe = process.env.HOME;"],
    ["Buffer", 'export const probe = Buffer.from("x");'],
    ["Bun", "export const probe = Bun.version;"],
    ["require", 'export const probe = require("node:fs");'],
  ];

  test(
    "the shared tsconfig rejects DOM, Node and Bun globals",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "shared-purity-"));
      try {
        for (const [name, code] of PROBES) writeFileSync(join(dir, `${name}.ts`), code);
        writeFileSync(
          join(dir, "tsconfig.json"),
          JSON.stringify({ extends: SHARED_TSCONFIG, include: ["*.ts"], exclude: [] }),
        );
        const r = spawnSync(process.execPath, [TSC, "-p", join(dir, "tsconfig.json")], { encoding: "utf8" });
        const output = `${r.stdout}${r.stderr}`;
        const passed = PROBES.map(([name]) => name).filter((name) => !output.includes(`${name}.ts(`));
        expect(passed).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );

  test("has production modules", () => {
    expect(productionFiles.length).toBeGreaterThan(0);
  });

  describe.each(productionFiles.map((f) => [relative(ENGINE_DIR, f), f]))("%s", (_name, file) => {
    const loader = LOADERS[extname(file)];

    test("is a TypeScript or JavaScript module", () => {
      expect(loader).toBeDefined();
    });

    test("imports only zod and modules inside studio/shared/engine", () => {
      const imports = new Bun.Transpiler({ loader: loader ?? "ts" }).scanImports(readFileSync(file, "utf8"));
      const foreign = imports.map((i) => i.path).filter((p) => !allowedImport(p, file));
      expect(foreign).toEqual([]);
    });

    test("uses no process, Buffer, Bun, require or globalThis[...]", () => {
      const code = new Bun.Transpiler({ loader: loader ?? "ts" }).transformSync(readFileSync(file, "utf8"));
      expect(code.match(FORBIDDEN) ?? []).toEqual([]);
    });
  });
});
