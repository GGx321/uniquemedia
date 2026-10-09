import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// S4.6p: the renderer never computes money. A static guard over `screens/**`: no source file there adds or subtracts a `…Micros` figure and another identifier. The engine answers every
// figure the window shows (`runs.estimateImages` for the price of drawing photos); a window that works one out from others shows a number nobody priced. What the guard sees is
// narrow, and it says so: only `+` and `-` between two identifiers (a property chain, optional `?.`), one of them named `…Micros`. It does NOT see multiplication or division, a figure
// copied into a variable with another name first, or arithmetic whose operands are not named `…Micros`. So it keeps honest code honest, not a determined bypass; the structural fix is a
// branded `EngineMicros` type that `about`, `ceiling` and `formatUsd*` alone accept (backlog, plan §33). The sites below are the ones that remain, each with why: the list may only
// shrink, and a new site needs the engine's figure instead (the guard fails on it, and on an entry whose code is gone).

const SCREENS = join(import.meta.dir);

/** `+` or `-` between two identifiers one of which is named `…Micros`: `a.expectedMicros - b.expectedMicros`, `credits - result.ledgerDeltaMicros`. Comments are taken out first. */
function moneyArithmetic(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:'"`])\/\/.*$/gm, "$1");
  const found: string[] = [];
  for (const match of code.matchAll(/([A-Za-z_][\w.?]*)\s*([-+])\s*([A-Za-z_][\w.?]*)/g)) {
    const [, left = "", op = "", right = ""] = match;
    if (left.endsWith("Micros") || right.endsWith("Micros")) found.push([left, op, right].join(" "));
  }
  return found;
}

/** What remains, by file under `screens/`, and why it is not money shown. */
const REMAINING: Record<string, string[]> = {
  // Bar geometry too: the settled part of the launch's spend is `spentMicros - open`, a percentage of the bar's width; the amounts printed are the engine's (`spent`, `open`).
  "autopilot/liveModel.ts": ["launch.spentMicros - open"],
  // Open for the engine (plan §33): the reconcile's «расхождение $X» is the window's |/credits − журнал|, compared with a tolerance. The engine should answer the discrepancy itself.
  "SettingsScreen.tsx": ["credits - result.ledgerDeltaMicros"],
  // Bar geometry: the sum and the difference only become percentages of the budget (`pctOf`) for the widths of the plan card's bar; no amount is printed from them.
  "autopilot/planModel.ts": ["committedMicros + expectedMicros", "worstMicros - expectedMicros"],
  // Open for the engine (plan §33): the strip's totals «Весь запуск» / «Дальше» add the images' figure to the write's. The engine has no combined price of a write and a draw.
  "photos/SceneStrip.tsx": [
    "images.expectedMicros + note.price.expectedMicros",
    "images.worstMicros + note.price.worstMicros",
    "images.expectedMicros + write.expectedMicros",
    "images.worstMicros + write.worstMicros",
  ],
};

async function sources(): Promise<{ file: string; text: string }[]> {
  // The glob answers with the platform's separator; the list names files with "/", so a Windows path is normalised before it is compared.
  const files = Array.from(new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: SCREENS }))
    .map((f) => f.replaceAll("\\", "/"))
    .filter((f) => !/\.test\.tsx?$/.test(f));
  return Promise.all(files.sort().map(async (file) => ({ file, text: await Bun.file(join(SCREENS, file)).text() })));
}

describe("the detector", () => {
  test("sees a subtraction of two figures", () => {
    expect(moneyArithmetic("const w = Math.max(0, r.expectedMicros - w.expectedMicros);")).toEqual(["r.expectedMicros - w.expectedMicros"]);
  });

  test("sees an addition of two figures, however the operands are reached", () => {
    expect(moneyArithmetic("about(images?.expectedMicros + write.expectedMicros)")).toEqual(["images?.expectedMicros + write.expectedMicros"]);
  });

  test("sees it across a line break and without spaces", () => {
    expect(moneyArithmetic("a.worstMicros\n  -b.worstMicros")).toEqual(["a.worstMicros - b.worstMicros"]);
  });

  test("leaves a comment alone", () => {
    expect(moneyArithmetic("// the run's worstMicros - the writer's worstMicros\n/* a.expectedMicros + b.expectedMicros */\nconst x = 1;")).toEqual([]);
  });

  test("sees a figure beside any identifier, not only another figure", () => {
    expect(moneyArithmetic("const diff = Math.abs(credits - result.ledgerDeltaMicros);")).toEqual(["credits - result.ledgerDeltaMicros"]);
  });

  test("leaves arithmetic that names no figure alone", () => {
    expect(moneyArithmetic("const n = count + 1; const m = a.length - b.length; const per = photos * unitMicros;")).toEqual([]);
  });
});

describe("the screens", () => {
  test("add or subtract two engine figures only where the list says why", async () => {
    const found: Record<string, string[]> = {};
    for (const { file, text } of await sources()) {
      const hits = moneyArithmetic(text);
      if (hits.length > 0) found[file] = hits;
    }
    expect(found).toEqual(REMAINING);
  });

  test("the list names files that exist", async () => {
    const files = new Set((await sources()).map((s) => s.file));
    for (const file of Object.keys(REMAINING)) expect(files.has(file)).toBe(true);
  });
});
