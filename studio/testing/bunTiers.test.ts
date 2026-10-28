import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countTo, PUSH_SIZES, sweepVariants } from "./bunTiers";
import { TIER_ENV, tierPattern } from "./tiers";

describe("sweepVariants", () => {
  const params = { push: { seeds: 4, sizes: [1, 2, 12, 30] }, heavy: { seeds: 40, sizes: [1, 2, 3] } };

  test("a push run gets the push parameters under the plain name and skips the heavy variant", () => {
    const [push, heavy] = sweepVariants("planner keeps the rule", params, undefined);
    expect(push).toEqual({ name: "planner keeps the rule", params: params.push, enabled: true });
    expect(heavy).toEqual({ name: "[heavy] planner keeps the rule", params: params.heavy, enabled: false });
  });

  test("the heavy run enables the heavy variant, which carries the heavy tag the runner selects by", () => {
    const [, heavy] = sweepVariants("planner keeps the rule", params, "heavy");
    expect(heavy?.enabled).toBe(true);
    expect(new RegExp(tierPattern("heavy")).test(heavy?.name ?? "")).toBe(true);
  });

  test("the push variant's name is never selected by the heavy tag", () => {
    const [push] = sweepVariants("planner keeps the rule", params, "heavy");
    expect(new RegExp(tierPattern("heavy")).test(push?.name ?? "")).toBe(false);
  });

  test("the perf and quarantine runs do not enable the heavy variant", () => {
    for (const tier of ["perf", "quarantine"] as const) expect(sweepVariants("x", params, tier)[1]?.enabled).toBe(false);
  });
});

describe("the sweep sizes", () => {
  test("a push samples the sizes 1, 2, 12 and 30, and countTo walks every size up to its limit", () => {
    expect([...PUSH_SIZES]).toEqual([1, 2, 12, 30]);
    expect(countTo(30)).toHaveLength(30);
    expect([countTo(3), countTo(0)]).toEqual([[1, 2, 3], []]);
    expect(countTo(30)).toEqual(expect.arrayContaining([...PUSH_SIZES]));
  });
});

describe("sweepTest in a real bun test run", () => {
  const scratch: string[] = [];
  afterEach(async () => {
    for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const bunTiers = join(import.meta.dir, "bunTiers.ts");

  async function run(tier: string | undefined, nameArgs: string[]): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "studio-sweep-"));
    scratch.push(dir);
    const file = join(dir, "sweep.test.ts");
    await writeFile(
      file,
      `import { sweepTest } from ${JSON.stringify(bunTiers)};
sweepTest("walks the seeds", { push: { seeds: 3 }, heavy: { seeds: 30 } }, ({ seeds }) => {
  console.log("ran with seeds=" + seeds);
});
`,
    );
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== TIER_ENV));
    if (tier !== undefined) env[TIER_ENV] = tier;
    const proc = Bun.spawn([process.execPath, "test", "--no-env-file", ...nameArgs, file], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    return `${out}\n${err}`;
  }

  test("the blocking run executes the push parameters once and the heavy ones never", async () => {
    const output = await run(undefined, []);
    expect(output.match(/ran with seeds=3/g)).toHaveLength(1);
    expect(output).not.toContain("seeds=30");
  });

  test("the heavy run, selecting by the heavy tag as the runner does, executes the heavy parameters once and the push ones never", async () => {
    const output = await run("heavy", [`--test-name-pattern=${tierPattern("heavy")}`]);
    expect(output.match(/ran with seeds=30/g)).toHaveLength(1);
    expect(output).not.toContain("seeds=3\n");
  });
});
