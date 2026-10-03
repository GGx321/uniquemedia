import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_APP_NAME, e2eIdentityProblem } from "./e2eIdentity";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

describe("e2eIdentityProblem", () => {
  test("accepts a packaged E2E build that carries the E2E identity", () => {
    expect(e2eIdentityProblem({ e2e: true, packaged: true, appName: E2E_APP_NAME })).toBeNull();
  });

  test("refuses a packaged E2E build that carries Studio's own identity: it would share Studio's userData and its real data", () => {
    expect(e2eIdentityProblem({ e2e: true, packaged: true, appName: "uniquemedia-studio" })).toContain("identity");
  });

  test("accepts an unpackaged E2E run: it has no identity of its own, and main.ts gives it a userData folder of its own", () => {
    expect(e2eIdentityProblem({ e2e: true, packaged: false, appName: "Electron" })).toBeNull();
  });

  test("asks nothing of a build that is not an E2E build, whatever its name", () => {
    expect(e2eIdentityProblem({ e2e: false, packaged: true, appName: "uniquemedia-studio" })).toBeNull();
    expect(e2eIdentityProblem({ e2e: false, packaged: false, appName: "Electron" })).toBeNull();
  });
});

const MAIN_SOURCE = readFileSync(join(import.meta.dirname, "main.ts"), "utf8");

describe("main.ts wires the E2E identity", () => {
  test("an unpackaged E2E run keeps its userData in a folder of its own, chosen inline behind the build flag", () => {
    expect(MAIN_SOURCE).toContain('STUDIO_E2E ? "uniquemedia-studio-e2e-dev" : "uniquemedia-studio-dev"');
  });

  test("a refused identity stops the process: process.exit(1) follows app.exit(1), so nothing after it runs on Studio's userData", () => {
    const refusal = /if \(identityProblem !== null\) \{([\s\S]*?)\n  \}\n\}/.exec(MAIN_SOURCE)?.[1] ?? "";
    expect(refusal.indexOf("app.exit(1)")).toBeGreaterThanOrEqual(0);
    expect(refusal.indexOf("process.exit(1)")).toBeGreaterThan(refusal.indexOf("app.exit(1)"));
  });
});

describe("the E2E identity matches what the E2E packages are built with", () => {
  test("both dist:studio:*:e2e scripts set the productName the guard expects", () => {
    const scripts: Record<string, string> = JSON.parse(readFileSync(join(import.meta.dirname, "../../package.json"), "utf8")).scripts;
    for (const name of ["dist:studio:mac:e2e", "dist:studio:win:e2e"]) {
      expect(scripts[name]).toContain(`-c.extraMetadata.productName="${E2E_APP_NAME}"`);
    }
  });
});
