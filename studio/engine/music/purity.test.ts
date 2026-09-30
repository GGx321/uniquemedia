import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Invariant 29, statically: the flashapi client takes the key and the base URL as parameters and never reads either
// from anywhere, and the key has one road out (a header). These read the sources, so a later change that reaches for
// the environment, the disk or the console from the client fails here, not in a review.

const dir = import.meta.dirname;
const sources = readdirSync(dir)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
const source = (name: string) => sources.find((s) => s.name === name)?.text ?? "";

/** Source without comments, so a rule is checked against code and not against the prose that explains it. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("the music sources", () => {
  test("there are sources to check", () => {
    expect(sources.map((s) => s.name)).toEqual(expect.arrayContaining(["client.ts", "service.ts", "quotaLedger.ts", "listSchema.ts", "redactKnown.ts"]));
  });

  test("none of them reads the environment or a key store: the key and the base URL arrive as parameters", () => {
    for (const { name, text } of sources) {
      const body = code(text);
      expect(`${name}: ${/process\.env|Bun\.env|import\.meta\.env|safeStorage|secrets\.bin|secrets-rapidapi/.test(body)}`).toBe(`${name}: false`);
    }
  });

  test("the client touches neither the disk nor the console, and calls only the fetch it was given", () => {
    const body = code(source("client.ts"));
    expect(body).not.toMatch(/node:fs|readFile|writeFile|console\./);
    expect(body).not.toMatch(/(?<![.\w])fetch\(/);
    expect(body).not.toMatch(/globalThis\.fetch|Bun\.fetch/);
  });

  test("the service and the ledger never print: they log through the one function they are given", () => {
    for (const name of ["service.ts", "quotaLedger.ts", "refreshReport.ts"]) expect(code(source(name))).not.toMatch(/console\./);
  });

  test("the key's header name appears in the client only, and never in a URL template", () => {
    for (const { name, text } of sources) {
      if (name === "client.ts") continue;
      expect(`${name}: ${/x-rapidapi-key/i.test(code(text))}`).toBe(`${name}: false`);
    }
    expect(code(source("client.ts"))).not.toMatch(/\$\{key\}[^`]*`|`[^`]*\$\{key\}/);
  });

  test("the quota ledger takes a key's last four chars, never a key, a hash or a digest of one", () => {
    const body = code(source("quotaLedger.ts"));
    expect(body).not.toMatch(/createHash|crypto|digest|sha256|Bun\.hash/);
  });

  test("the schema keeps no dash manifest and no preview URL", () => {
    const body = code(source("listSchema.ts"));
    expect(body).not.toMatch(/dashManifest|previewUrl/);
  });
});
