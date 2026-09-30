#!/usr/bin/env bun
/**
 * Runs the REAL-worker test files under Electron's Node, the product's own runtime (3b.2, round 3).
 *
 * Why not `bun test`: in Bun, `worker.terminate()` does not interrupt running wasm, so a deadline test measures
 * Bun rather than the product (a 200 ms deadline on a multi-second render answered after 712 ms locally and
 * 2015 ms on CI, against 202 ms under Electron's Node), and terminating a worker that runs wasm crashes Bun in
 * a few percent of runs. Electron's Node has neither problem, so there is nothing to retry here.
 *
 * Each suite is a `*.node-test.ts` written against `node:test` and `node:assert`. This script bundles it, and
 * every worker entry it spawns, with `bun build --target=node` into a temp directory, then runs
 *   ELECTRON_RUN_AS_NODE=1 <electron binary> --test <bundle>
 * with `STUDIO_ROOT` (the repo) in the environment. No retries. The run fails when Electron's exit code is not 0, and
 * also when its summary does not show a real run: `electron --test` exits 0 with zero tests, and with every test
 * behind `describe.skip`, so the summary (`ℹ tests N`, `ℹ pass N`, `ℹ skipped N`, `ℹ todo N`) is read from the
 * output, which is copied through as it arrives. Zero tests, a file that registered none, any skipped or todo test or
 * suite, a pass count below the test count, or no summary at all is a failure.
 *
 *   bun run test:studio:electron-node
 *
 * The face worker's real tests (`workerGate.real.node-test.ts`) run here too: they need the face models (CI fetches
 * them; a run without them fails, it never skips), onnxruntime-web and a library folder, all of which work under Node.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { electronBinary } from "./electronBinary";

export interface NodeTestSuite {
  name: string;
  /** Repo-relative path of the `*.node-test.ts` entry. */
  entry: string;
  /** Worker bundles the test spawns next to itself: output file name -> repo-relative source. */
  workers: Readonly<Record<string, string>>;
}

const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * Why the output of a `node --test` run does not show a run that tested something, or undefined when it does.
 * Reads the reporter's summary lines (`ℹ tests 10`); an output with no `tests` line is a problem too, so a change of
 * reporter or of format fails loudly instead of passing quietly.
 */
export function nodeTestSummaryProblem(output: string): string | undefined {
  const plain = output.replace(ANSI, "");
  const count = (name: string): number | undefined => {
    const match = new RegExp(`^ℹ ${name} (\\d+)\\s*$`, "m").exec(plain);
    return match?.[1] === undefined ? undefined : Number(match[1]);
  };
  // A file that registers no test of its own is counted by node as ONE passing test named after the file (`tests 1`).
  if (/^[✔✖﹣]\s+\S+\.(?:mjs|cjs|js)\s+\(/m.test(plain)) return "a test file registered no tests: node counted the file itself as the one test";
  // A skipped or todo suite is not always in the counts (`describe.skip` reports `tests 0`, `skipped 0`), but it always marks its line.
  if (/ # (?:SKIP|TODO)\b/.test(plain)) return "a test or suite is marked SKIP or TODO: every test must run";
  const tests = count("tests");
  if (tests === undefined) return "the output has no `ℹ tests N` summary, so nothing shows that a test ran";
  if (tests === 0) return "the run reported 0 tests";
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
    workers: { "textWorker.js": "studio/engine/text/worker/textWorker.ts" },
  },
  {
    name: "face worker",
    entry: "studio/engine/face/worker/workerGate.real.node-test.ts",
    workers: { "faceWorker.js": "studio/engine/face/worker/faceWorker.ts" },
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

export function electronNodeArgs(bundle: string): string[] {
  return ["--test", bundle];
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
  const testBundle = await bundle(root, suite.entry, outDir, `${basename(suite.entry, ".ts")}.mjs`);
  for (const [outName, source] of Object.entries(suite.workers)) await bundle(root, source, outDir, outName);
  return testBundle;
}

function runElectronNode(electron: string, testBundle: string, env: Record<string, string>): Promise<{ code: number; output: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(electron, electronNodeArgs(testBundle), { env, stdio: ["ignore", "pipe", "pipe"] });
    // Copied through as it arrives, and kept: the summary is read from it.
    let output = "";
    child.stdout.on("data", (d: Buffer) => {
      output += String(d);
      process.stdout.write(d);
    });
    child.stderr.on("data", (d: Buffer) => {
      output += String(d);
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
  for (const suite of NODE_TEST_SUITES) {
    const out = await mkdtemp(join(tmpdir(), "studio-node-tests-"));
    try {
      console.log(`\n== ${suite.name} (Electron's Node) ==`);
      const testBundle = await buildSuite(root, suite, out);
      const { code, output } = await runElectronNode(electron, testBundle, electronNodeEnv(process.env, root));
      if (code !== 0) {
        console.error(`${suite.name}: exit code ${code}`);
        failed = true;
      } else {
        const problem = nodeTestSummaryProblem(output);
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
