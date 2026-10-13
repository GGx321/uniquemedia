import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// S5.9g (plan s5a3 gap C, §14 «S5.9g»): the card's «Seedream 2K — до $X за попытку по прайсу» reads `Estimate.boldAttemptMicros`, the engine's price of one
// Seedream attempt; the window never knows that price itself. A static guard over the renderer's sources (tests, test kits and the mock engine left out:
// the mock stands in for the engine and prices like it): no 93 000 µ$ figure in any spelling — `93`, `0.093`, `93000`, `93_000`, `93 000` — as a number or
// inside a string. Comments are taken out first: they may tell where a figure comes from.

const RENDERER = join(import.meta.dir, "..");

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:'"`\\])\/\/.*$/gm, "$1");
}

/** The 2K price's spellings in `source`: a whole number or decimal, never a part of a longer one (`930`, `1.093`, `0.0935`, `193` are other numbers). */
export function boldPriceLiterals(source: string): string[] {
  const code = withoutComments(source);
  return Array.from(code.matchAll(/(?<![\w.])(?:0?\.093|93(?:[_    ]?000)?)(?![\w]|\.\d)/g), (m) => m[0]);
}

async function sources(): Promise<{ file: string; text: string }[]> {
  const files = Array.from(new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: RENDERER }))
    .map((f) => f.replaceAll("\\", "/"))
    .filter((f) => !/\.test\.tsx?$/.test(f) && !/(^|\/)engine\/mock[^/]*$/.test(f) && !/[Kk]it\.tsx?$/.test(f) && !f.endsWith("testing.tsx"));
  return Promise.all(files.sort().map(async (file) => ({ file, text: await Bun.file(join(RENDERER, file)).text() })));
}

describe("the detector", () => {
  test("sees the 2K price in every spelling, as a number or in a string", () => {
    expect(boldPriceLiterals("const a = 93_000; const b = 93000; const c = 0.093; const d = .093;")).toEqual(["93_000", "93000", "0.093", ".093"]);
    expect(boldPriceLiterals('const line = "до $0.093 за попытку"; const t = `${93} 000`;')).toEqual(["0.093", "93"]);
    expect(boldPriceLiterals("const s = '93 000 µ$'; const n = '93 000';")).toEqual(["93 000", "93 000"]);
  });

  test("leaves other numbers and comments alone", () => {
    expect(boldPriceLiterals("const a = 930; const b = 1.093; const c = 193; const d = 0.0935; const e = 9300; const id = 'x93';")).toEqual([]);
    expect(boldPriceLiterals("// 93 000 µ$ at list\n/* $0.093 */\nconst x = 1;")).toEqual([]);
  });
});

describe("the renderer", () => {
  test("the guard reads the card and the strip", async () => {
    const files = (await sources()).map((s) => s.file);
    expect(files).toEqual(expect.arrayContaining(["screens/photos/GenerateCard.tsx", "screens/photos/SceneStrip.tsx", "screens/photos/level.ts"]));
    expect(files.some((f) => f.startsWith("engine/mock"))).toBe(false);
  });

  test("holds no 2K price of its own: the Seedream line reads the engine's figure", async () => {
    const found: Record<string, string[]> = {};
    for (const { file, text } of await sources()) {
      const hits = boldPriceLiterals(text);
      if (hits.length > 0) found[file] = hits;
    }
    expect(found).toEqual({});
  });
});
