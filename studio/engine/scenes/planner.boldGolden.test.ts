import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { plan, type PlanInput } from "./planner";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.3 (S5.9c, plan s5a3 §15.4): the golden of the two «Смелая» banks' plans, in its own file beside the five's (planner.custom.test.ts, frozen to main 3a9cd498). Each entry hashes the
// plans of a category set at a level, for six seeds, five sizes and the three legs shares, so a change to the bold draw, to a bank's order or to a stream shows up as a changed hash.
//
// 2026-10-26 (5a.4, S5.BA2, plan s5a4 §7.4): the six hashes that hold nightwear (nightwear and nightwear,beach at the three levels) were re-pinned for Q-A2, nightwear always
// underwear on Seedream, its tier retags (r2.2 P6) and its reworded sheet moment (r2.2 P3); the three beach hashes are byte for byte the ones before.
// 2026-10-26 (S5.BA2 review L5, L7): nightwear@flirty, nightwear@bold, nightwear,beach@flirty and nightwear,beach@bold re-pinned once more: the flirty «lies prone, chin on her
// hand» pins the black lace set, and her bedroom's fairy lights became a framed print. The ordinary hashes and the three beach ones did not move.
//
// REGENERATE deliberately, never to turn a red test green: `PLANNER_BOLD_WRITE_GOLDEN=1 bun test --no-env-file studio/engine/scenes/planner.boldGolden.test.ts`, then READ the diff of
// fixtures/planner-bold-s5-9c.json: every changed hash is a plan that moved.

const FIXTURE = join(import.meta.dir, "fixtures", "planner-bold-s5-9c.json");
const SEEDS = [1, 7, 42, 2026, 123456789, 4294967295];
const COUNTS = [1, 7, 20, 33, 100];
const SHARES = [0, 15, 30] as const;
const LEVELS = ["ordinary", "flirty", "bold"] as const;
const SETS = [["nightwear"], ["beach"], ["nightwear", "beach"]] as const;

const sha = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function hashesNow(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const categories of SETS) {
    for (const level of LEVELS) {
      const all: unknown[] = [];
      for (const seed of SEEDS) {
        for (const count of COUNTS) for (const legsShare of SHARES) all.push(plan({ seed, count, categories: [...categories], level, legsShare, impliedNudity: true } satisfies PlanInput));
      }
      out[`${categories.join(",")}@${level}`] = sha(all);
    }
  }
  return out;
}

if (process.env.PLANNER_BOLD_WRITE_GOLDEN === "1") writeFileSync(FIXTURE, `${JSON.stringify({ seeds: SEEDS, counts: COUNTS, legsShares: SHARES, hashes: hashesNow() }, null, 2)}\n`);

describe("the «Смелая» banks' plans are pinned (S5.9c)", () => {
  const fixture: { seeds: number[]; counts: number[]; legsShares: number[]; hashes: Record<string, string> } = JSON.parse(readFileSync(FIXTURE, "utf8"));

  test("the fixture covers the three category sets at the three levels, over the seeds, sizes and legs shares it names", () => {
    expect(Object.keys(fixture.hashes).sort()).toEqual(SETS.flatMap((c) => LEVELS.map((l) => `${c.join(",")}@${l}`)).sort());
    expect({ seeds: fixture.seeds, counts: fixture.counts, legsShares: fixture.legsShares }).toEqual({ seeds: SEEDS, counts: COUNTS, legsShares: [...SHARES] });
  });

  for (const categories of SETS) {
    for (const level of LEVELS) {
      test(`${categories.join(", ")} at ${level}: every seed, size and legs share`, () => {
        const all: unknown[] = [];
        for (const seed of SEEDS) {
          for (const count of COUNTS) for (const legsShare of SHARES) all.push(plan({ seed, count, categories: [...categories], level, legsShare, impliedNudity: true }));
        }
        expect(sha(all)).toBe(fixture.hashes[`${categories.join(",")}@${level}`]);
      });
    }
  }
});
