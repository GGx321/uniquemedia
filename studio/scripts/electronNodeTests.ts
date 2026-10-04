#!/usr/bin/env bun
/**
 * Runs the REAL-worker test files under Electron's Node, the product's own runtime (3b.2, round 3).
 *
 * Why not `bun test`: in Bun, `worker.terminate()` does not interrupt running wasm, so a deadline test measures
 * Bun rather than the product (a 200 ms deadline on a multi-second render answered after 712 ms locally and
 * 2015 ms on CI, against 202 ms under Electron's Node), and terminating a worker that runs wasm crashes Bun in
 * a few percent of runs. Electron's Node has neither problem, so there is nothing to retry here.
 *
 * Each suite is a `*.node-test.ts` (or `.mts`, `.tsx`) written against `node:test` and `node:assert`. This script
 * bundles it, and every worker entry it spawns, with `bun build --target=node` into a temp directory, then runs
 *   ELECTRON_RUN_AS_NODE=1 <electron binary> --test --test-reporter=spec <bundle>
 * with `STUDIO_ROOT` (the repo) in the environment. The reporter is named, not left to node's default, because the
 * summary check below reads the spec reporter's lines. No retries. The run fails when Electron's exit code is not 0, and
 * also when its summary does not show a real run: `electron --test` exits 0 with zero tests, and with every test
 * behind `describe.skip`, so the summary (`ℹ tests N`, `ℹ pass N`, `ℹ skipped N`, `ℹ todo N`) is read from the
 * output, which is copied through as it arrives. Zero tests, a file that registered none, any skipped or todo test or
 * suite, a pass count below the test count, or no summary at all is a failure.
 *
 *   bun run test:studio:electron-node
 *
 * The face worker's real tests (`face/testing/workerGate.real.node-test.ts`) run here too: they need the face models (CI fetches
 * them; a run without them fails, it never skips), onnxruntime-web and a library folder, all of which work under Node.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import { type Tier, tierOf, tierPattern } from "../testing/tiers";
import { electronBinary } from "./electronBinary";

export interface NodeTestSuite {
  name: string;
  /** Repo-relative path of the `*.node-test.ts` entry. */
  entry: string;
  /**
   * How many tests the blocking run (STUDIO_TEST_TIER unset) has: a run that reports fewer lost tests (a deleted or
   * unregistered one) and fails. Raise it with the suite. Tests that only another tier registers are not in this count.
   */
  minTests: number;
  /**
   * How many tests a tier run (STUDIO_TEST_TIER set) of this suite has, by tier: those tagged with the tier's tag in
   * their name (studio/testing/tiers.ts). A tier absent here means the suite has nothing in that tier and is skipped
   * by that tier's run. The same loss check as `minTests`, per tier.
   */
  tierTests?: Readonly<Partial<Record<Tier, number>>>;
  /** Worker bundles the test spawns next to itself: output file name -> repo-relative source. */
  workers: Readonly<Record<string, string>>;
}

const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * Why the output of a `node --test` run does not show a run that tested something, or undefined when it does.
 * Reads the reporter's summary lines (`ℹ tests 10`); an output with no `tests` line is a problem too, so a change of
 * reporter or of format fails loudly instead of passing quietly.
 */
export function nodeTestSummaryProblem(output: string, minTests = 1): string | undefined {
  const plain = output.replace(ANSI, "");
  // The LAST such line: the reporter prints the run's summary at the very end, and a test that logs a line shaped like one must not be read instead.
  const count = (name: string): number | undefined => {
    const matches = [...plain.matchAll(new RegExp(`^ℹ ${name} (\\d+)\\s*$`, "gm"))];
    const last = matches.at(-1)?.[1];
    return last === undefined ? undefined : Number(last);
  };
  // A file that registers no test of its own is counted by node as ONE passing test named after the file (`tests 1`), whose path may hold spaces.
  if (/^[✔✖﹣]\s+[^\n]*\.(?:mjs|cjs|js)\s+\(\d/m.test(plain)) return "a test file registered no tests: node counted the file itself as the one test";
  // A skipped or todo suite is not always in the counts (`describe.skip` reports `tests 0`, `skipped 0`), but it always marks its line.
  if (/ # (?:SKIP|TODO)\b/.test(plain)) return "a test or suite is marked SKIP or TODO: every test must run";
  const tests = count("tests");
  if (tests === undefined) return "the output has no `ℹ tests N` summary, so nothing shows that a test ran";
  if (tests === 0) return "the run reported 0 tests";
  if (tests < minTests) return `the run reported ${tests} tests, fewer than the ${minTests} the suite has: a test was lost`;
  const skipped = count("skipped") ?? 0;
  const todo = count("todo") ?? 0;
  if (skipped > 0 || todo > 0) return `the run skipped ${skipped} and left ${todo} as todo: every test must run`;
  const passed = count("pass");
  if (passed !== tests) return `${passed ?? "no"} tests passed of ${tests}`;
  return undefined;
}

export const NODE_TEST_SUITES: readonly NodeTestSuite[] = [
  {
    name: "text worker",
    entry: "studio/engine/text/worker/textGate.real.node-test.ts",
    // 10 before CI-4, and 10 again: the deadline-headroom measurement moved to the perf tier, a plain "the worst shadow caption renders"
    // test took its correctness half (the event-loop gap test stays blocking, with a wide criterion). The perf tier has the
    // cut-at-the-deadline test, the gap and the headroom.
    minTests: 10,
    tierTests: { perf: 3 },
    workers: { "textWorker.js": "studio/engine/text/worker/textWorker.ts" },
  },
  {
    name: "face worker",
    entry: "studio/engine/face/testing/workerGate.real.node-test.ts",
    // The event-loop gap test blocks with a wide criterion (0.8 x the in-thread control) and holds the tight one in the perf tier.
    minTests: 18,
    tierTests: { perf: 1 },
    workers: { "faceWorker.js": "studio/engine/face/worker/faceWorker.ts" },
  },
  {
    name: "caption rules",
    entry: "studio/engine/text/captionRules.node-test.ts",
    minTests: 64,
    tierTests: { perf: 9 },
    workers: {},
  },
  {
    name: "caption worker",
    entry: "studio/engine/text/worker/textCaption.real.node-test.ts",
    minTests: 8,
    tierTests: { perf: 1 },
    workers: { "textWorker.js": "studio/engine/text/worker/textWorker.ts" },
  },
  {
    // 3a.9: what each OS's disk answers when something is already at the export name (a folder, a link), under the product's runtime.
    name: "export name claim",
    entry: "studio/engine/exportClaim.node-test.ts",
    // 7 claim tests plus 1 from decode/decodeGate.retention.node-cases.ts (the entry imports it: a suite of its own would exceed the workflow steps'
    // timeout-minutes, which are bound to the number of suites).
    minTests: 8,
    workers: {},
  },
];

/** One suite's bound; a run that takes longer is hung, not slow (the suite takes a few seconds). */
export const SUITE_TIMEOUT_MS = 5 * 60 * 1000;

/** The plain-Node environment: the Electron binary acts as `node`, `STUDIO_ROOT` says where the repo is, and NODE_OPTIONS of the caller is dropped. */
export function electronNodeEnv(parent: Readonly<Record<string, string | undefined>>, root: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value !== undefined && key !== "NODE_OPTIONS") env[key] = value;
  }
  return { ...env, ELECTRON_RUN_AS_NODE: "1", STUDIO_ROOT: root };
}

/** `tier` set: only the tests tagged for it run (node leaves the others out of the counts, so the summary check reads the tier's own tests). */
export function electronNodeArgs(bundle: string, tier?: Tier): string[] {
  return ["--test", "--test-reporter=spec", ...(tier === undefined ? [] : [`--test-name-pattern=${tierPattern(tier)}`]), bundle];
}

/** The suites a run of `tier` covers (every suite for the blocking run, undefined), each with the test count its summary must reach. */
export function suitesForTier(suites: readonly NodeTestSuite[], tier: Tier | undefined): { suite: NodeTestSuite; minTests: number }[] {
  if (tier === undefined) return suites.map((suite) => ({ suite, minTests: suite.minTests }));
  return suites.flatMap((suite) => {
    const minTests = suite.tierTests?.[tier];
    return minTests === undefined ? [] : [{ suite, minTests }];
  });
}

/** `bun build <source> --target=node`, as a child process: the same command a person would run, and it behaves the same under `bun test`. */
function bundle(root: string, source: string, outDir: string, outName: string): Promise<string> {
  const outfile = join(outDir, outName);
  return new Promise((resolveBuild, reject) => {
    const child = spawn(process.execPath, ["build", resolve(root, source), "--target=node", "--format=esm", "--outfile", outfile], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d) => (output += String(d)));
    child.stderr.on("data", (d) => (output += String(d)));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolveBuild(outfile) : reject(new Error(`bundling ${source} failed (exit ${code}):\n${output}`))));
  });
}

/** Bundles a suite's test and its workers into `outDir`; returns the test bundle's path. Throws when any bundle fails. */
export async function buildSuite(root: string, suite: NodeTestSuite, outDir: string): Promise<string> {
  const testBundle = await bundle(root, suite.entry, outDir, `${parse(suite.entry).name}.mjs`);
  for (const [outName, source] of Object.entries(suite.workers)) await bundle(root, source, outDir, outName);
  return testBundle;
}

function runElectronNode(electron: string, testBundle: string, env: Record<string, string>, tier?: Tier): Promise<{ code: number; output: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(electron, electronNodeArgs(testBundle, tier), { env, stdio: ["ignore", "pipe", "pipe"] });
    // Copied through as it arrives, and kept: the summary is read from it. Decoded per stream, so a multi-byte
    // character (the reporter's `✔`, `ℹ`) split across two chunks is not turned into replacement characters.
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      output += d;
      process.stdout.write(d);
    });
    child.stderr.on("data", (d: string) => {
      output += d;
      process.stderr.write(d);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`the suite ran past ${SUITE_TIMEOUT_MS} ms and was killed`));
    }, SUITE_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    // `close`, not `exit`: the output is complete once the pipes have closed.
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code: code ?? (signal === null ? 1 : 128), output });
    });
  });
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, "../..");
  const electron = await electronBinary();
  let failed = false;
  const tier = tierOf(process.env);
  const planned = suitesForTier(NODE_TEST_SUITES, tier);
  if (tier !== undefined && planned.length === 0) console.log(`::notice::electronNodeTests: no suite has tests in the ${tier} tier, so there is nothing to run`);
  for (const { suite, minTests } of planned) {
    const out = await mkdtemp(join(tmpdir(), "studio-node-tests-"));
    try {
      console.log(`\n== ${suite.name} (Electron's Node${tier === undefined ? "" : `, ${tier} tier`}) ==`);
      const testBundle = await buildSuite(root, suite, out);
      const { code, output } = await runElectronNode(electron, testBundle, electronNodeEnv(process.env, root), tier);
      if (code !== 0) {
        console.error(`${suite.name}: exit code ${code}`);
        failed = true;
      } else {
        const problem = nodeTestSummaryProblem(output, minTests);
        if (problem !== undefined) {
          console.error(`${suite.name}: exit code 0, but ${problem}`);
          failed = true;
        }
      }
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }
  process.exit(failed ? 1 : 0);
}
