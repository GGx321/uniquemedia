import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

// Plan §4.2 and the S4.9 acceptance, read off the source: the renderer computes no money. The autopilot's prices, its month fit and its allocation are the
// engine's (`autopilot.estimate`, `autopilot.start`); the screens only show what it answers. So no source under renderer/screens (tests aside) imports the
// shared money modules the engine prices a launch with.

const SCREENS = join(import.meta.dir, "..");
/** Any way of naming the module: `from "…"`, a bare `import "…"`, `import("…")` or `require("…")`, with or without its `.ts` / `.js` suffix. */
const FORBIDDEN = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'][^"']*shared\/autopilot\/(?:estimate|money)(?:\.[cm]?[jt]sx?)?["']/;

/** A path with `/` between its parts on every platform. */
const posix = (path: string): string => path.split(sep).join("/");

function sources(): string[] {
  return readdirSync(SCREENS, { recursive: true, encoding: "utf8" })
    .map(posix)
    .filter((path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path));
}

describe("the screens price nothing themselves", () => {
  test("the guard reads the autopilot screen's sources", () => {
    expect(sources()).toEqual(expect.arrayContaining(["AutopilotScreen.tsx", "autopilot/planModel.ts", "autopilot/useLaunchPlan.ts"]));
  });

  test("no source under renderer/screens imports shared/autopilot/estimate or shared/autopilot/money", () => {
    const found = sources().filter((path) => FORBIDDEN.test(readFileSync(join(SCREENS, path), "utf8")));
    expect(found).toEqual([]);
  });

  test("the pattern catches such an import (the guard is not empty)", () => {
    expect(FORBIDDEN.test('import { launchEstimate } from "../../../shared/autopilot/estimate";')).toBe(true);
    expect(FORBIDDEN.test('import { monthFit } from "../../shared/autopilot/money";')).toBe(true);
    expect(FORBIDDEN.test('import { monthFit } from "../../../shared/autopilot/money.ts";')).toBe(true);
    expect(FORBIDDEN.test("import { launchEstimate } from '../../../shared/autopilot/estimate.js';")).toBe(true);
    expect(FORBIDDEN.test('const money = await import("../../../shared/autopilot/money");')).toBe(true);
    expect(FORBIDDEN.test('import "../../../shared/autopilot/estimate";')).toBe(true);
    expect(FORBIDDEN.test('import { LaunchPreview } from "../../../shared/engine";')).toBe(false);
    expect(FORBIDDEN.test('import { chooseTrack } from "../../../shared/autopilot/track";')).toBe(false);
    expect(FORBIDDEN.test('import { x } from "../../../shared/autopilot/moneyless";')).toBe(false);
  });
});
