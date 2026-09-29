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
 * with `STUDIO_ROOT` (the repo) in the environment. Exit code: the run's own. No retries.
 *
 *   bun run test:studio:electron-node
 *
 * The face worker's real tests (`workerGate.real.test.ts`) stay on Bun's retry runner (realWorkerTests.ts): they
 * need the face models, onnxruntime-web and a library, and porting them is a job of its own.
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

export const NODE_TEST_SUITES: readonly NodeTestSuite[] = [
  {
    name: "text worker",
    entry: "studio/engine/text/worker/textGate.real.node-test.ts",
    workers: { "textWorker.js": "studio/engine/text/worker/textWorker.ts" },
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

function runElectronNode(electron: string, testBundle: string, env: Record<string, string>): Promise<number> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(electron, electronNodeArgs(testBundle), { env, stdio: "inherit" });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`the suite ran past ${SUITE_TIMEOUT_MS} ms and was killed`));
    }, SUITE_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolveRun(code ?? (signal === null ? 1 : 128));
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
      const code = await runElectronNode(electron, testBundle, electronNodeEnv(process.env, root));
      if (code !== 0) {
        console.error(`${suite.name}: exit code ${code}`);
        failed = true;
      }
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }
  process.exit(failed ? 1 : 0);
}
