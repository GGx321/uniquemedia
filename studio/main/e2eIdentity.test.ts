import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_APP_NAME, e2eIdentityProblem, userDataFolderName } from "./e2eIdentity";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

describe("e2eIdentityProblem", () => {
  test("accepts a packaged E2E build that carries the E2E identity", () => {
    expect(e2eIdentityProblem({ e2e: true, packaged: true, appName: E2E_APP_NAME })).toBeNull();
  });

  test("refuses a packaged E2E build that carries Studio's own identity: it would share Studio's userData and its real data", () => {
    expect(e2eIdentityProblem({ e2e: true, packaged: true, appName: "uniquemedia-studio" })).toContain("identity");
  });

  test("accepts an unpackaged E2E run: it has no identity of its own, and its userData folder is separate (userDataFolderName)", () => {
    expect(e2eIdentityProblem({ e2e: true, packaged: false, appName: "Electron" })).toBeNull();
  });

  test("asks nothing of a build that is not an E2E build, whatever its name", () => {
    expect(e2eIdentityProblem({ e2e: false, packaged: true, appName: "uniquemedia-studio" })).toBeNull();
    expect(e2eIdentityProblem({ e2e: false, packaged: false, appName: "Electron" })).toBeNull();
  });
});

describe("userDataFolderName", () => {
  test("an unpackaged E2E run gets a folder of its own, never the one dev runs use", () => {
    expect(userDataFolderName(true)).not.toBe(userDataFolderName(false));
    expect(userDataFolderName(false)).toBe("uniquemedia-studio-dev");
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
