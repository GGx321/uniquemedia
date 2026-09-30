/**
 * Runs `bun test` with a bounded retry for one known cause: Bun itself crashing.
 *
 *   bun run test:studio:suite ./studio [--randomize]     the main suite, sharded, with the retry
 *   bun run test:studio:suite:canary ./studio --randomize   the suite, known crashes only
 *
 * After `--suite` the arguments are handed to `bun test` as they are. `--known-crashes-only`, first, narrows the
 * retry to the worker-teardown segfaults (the canary). Any other argument is a usage error.
 *
 * Why a crash is retried at all: Bun segfaults ("Segmentation fault at address 0x18" or 0xFFFFFFFFFFFFFFF8, exit
 * 133) while tearing down a worker that runs WASM, in about one of nine full `bun test ./studio` suites while the
 * real face worker tests were part of them, and right after `workerGate.test.ts`'s interruption test terminates
 * its worker: a crash in Bun's teardown, not in any assertion. Node/Electron are not affected. The tests that
 * really terminate a worker running WASM (the face worker's, the text worker's) no longer run under Bun at all:
 * they are `*.node-test.ts` files run under Electron's Node by electronNodeTests.ts, so nothing there is retried.
 *
 * The retry (at most 3 attempts) fires ONLY when the output shows the Bun
 * crash and no failure (no `(fail)` line, no red cross, no `N fail` or `N error`
 * summary with N above zero, no "Unhandled error between tests" load error; the
 * child also runs with colour off): a real failure fails the step at once and is
 * never retried into a pass. Each retry prints a `::warning::` annotation. An attempt
 * that runs past its own time bound is killed and fails at once too: a hang is
 * not a crash. Each attempt has that bound, so the step's `timeout-minutes` is
 * (shards x attempts x bound) plus slack, and a hang still ends in minutes.
 *
 * Why the main suite is sharded (`--shards=N`, before `--suite`): the per-attempt bound exists to kill a HUNG
 * Bun, not a slow legitimate run, and the suite on Windows grows with every stage (7.5, 7.6, 9.9 and over 10
 * minutes in four consecutive CI runs; the last one was killed by a 10-minute bound). One bound for the whole
 * suite would have to grow with it, and one Bun crash would rerun all of it. So the test files are found, sorted
 * and dealt round-robin into N groups (the heavy real-ffmpeg files sit next to each other in the sort order,
 * so round-robin spreads them), each group is its own `bun test` process with its own bound and its own
 * crash retry, and a retry reruns one shard. Shards run one after another, never in parallel (the suite has
 * timing-sensitive tests). Every shard runs even after one has failed, so a red run shows all its failures;
 * the exit code is the first failing shard's. In this mode the arguments after `--suite` are flags, written as
 * `--flag=value` (a value in its own argument would be read as a path), and paths to test directories or files.
 */
import { existsSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export const MAX_ATTEMPTS = 3;
/**
 * One attempt's bound for a suite shard. Measured: the whole suite takes 7.5 to over 10 minutes on Windows CI
 * (the slowest runner), so a third of it is 2.5 to 4 minutes and this bound is about four times the slowest shard
 * seen. Raise the `--shards=` count in package.json before raising this: a shard past it is treated as hung and fails at once.
 */
export const ATTEMPT_TIMEOUT_MS = 15 * 60 * 1000;

const ANSI = /\u001b\[[0-9;]*m/g;

/** Any crash of Bun itself. */
export const ANY_BUN_CRASH: readonly RegExp[] = [/Bun has crashed/, /Segmentation fault/, /^panic:/m, /^mprotect failed: \d+\s*$/m];

/**
 * The one crash that is known and understood: the segfault while a terminated WASM worker is torn down, at
 * address 0x18 (the former real-worker file) or 0xFFFFFFFFFFFFFFF8 (right after workerGate.test.ts's interruption
 * test). A crash anywhere else is news, and the canary exists to report it.
 */
export const WORKER_TEARDOWN_CRASHES: readonly RegExp[] = [
  /Segmentation fault at address 0x18\b/i,
  /Segmentation fault at address 0xFFFFFFFFFFFFFFF8\b/i,
  // Windows: the same teardown dies with `mprotect failed: 487` (VirtualProtect, ERROR_INVALID_ADDRESS), exit code 3, no panic line.
  /^mprotect failed: 487\s*$/m,
];

/**
 * True when `output` shows Bun crashing itself (one of `signatures`, any crash by default) and not a single
 * failure. A failure is read five ways, so neither colour nor a load error can hide one: the literal `(fail)`
 * line, a red cross, a `N fail` summary with N above zero, Bun's `# Unhandled error between tests` block (a file
 * that failed to load prints no `(fail)` line), and a `N error(s)` summary with N above zero.
 */
export function isBunCrashOnly(output: string, signatures: readonly RegExp[] = ANY_BUN_CRASH): boolean {
  const plain = output.replace(ANSI, "");
  const crashed = signatures.some((signature) => signature.test(plain));
  const failed =
    /^\s*\(fail\)|^\s*✗/m.test(plain) ||
    /^\s*[1-9]\d*\s+fail\b/m.test(plain) ||
    /^# Unhandled error between tests/m.test(plain) ||
    /^\s*[1-9]\d*\s+errors?\b/m.test(plain);
  return crashed && !failed;
}

/** The child's environment: colour off (FORCE_COLOR dropped), so a failure prints as the literal `(fail)` this file's detector reads. */
export function childEnv(parent: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  const { FORCE_COLOR: _color, ...rest } = parent;
  return { ...rest, NO_COLOR: "1" };
}

export interface TestTarget {
  testArgs: string[];
  /** Retry only the known worker-teardown crashes (the canary), not any Bun crash. */
  knownCrashesOnly: boolean;
  /** Split the suite's test files into this many `bun test` processes; 1 hands `testArgs` to one process as they are. */
  shards: number;
}

const USAGE = "usage: realWorkerTests.ts [--known-crashes-only] [--shards=N] --suite <bun test arguments...>";

/**
 * What to hand to `bun test`: `--suite <args...>`, exactly those `bun test` arguments (the main suite).
 * `--known-crashes-only` and `--shards=N` come first, in either order, and narrow the retry and split the suite.
 * Anything else is a usage error, and so is a `--known-crashes-only` or `--shards` after `--suite` (which bun
 * would receive, not this script).
 */
export function testTarget(argv: readonly string[]): TestTarget {
  let rest = argv;
  let knownCrashesOnly = false;
  let shards = 1;
  let shardsGiven = false;
  // Our own options come first, in either order, each at most once.
  for (;;) {
    const head = rest[0];
    if (head === "--known-crashes-only" && !knownCrashesOnly) knownCrashesOnly = true;
    else if (head !== undefined && /^--shards=/.test(head) && !shardsGiven) {
      const count = /^--shards=([1-9]\d?)$/.exec(head)?.[1];
      if (count === undefined) throw new Error(`${USAGE}\n--shards takes a whole number from 1 to 99`);
      shards = Number(count);
      shardsGiven = true;
    } else break;
    rest = rest.slice(1);
  }
  if (rest[0] !== "--suite" || rest.length < 2 || rest.includes("--known-crashes-only") || rest.some((a) => a.startsWith("--shards"))) throw new Error(USAGE);
  return { testArgs: rest.slice(1), knownCrashesOnly, shards };
}

/** The file names `bun test` picks up on its own: `*.test.*`, `*_test.*`, `*.spec.*`, `*_spec.*` in a JS or TS extension. */
const TEST_FILE_GLOB = "**/*{.test,_test,.spec,_spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}";

/**
 * The test files `bun test` would run for these paths (directories, searched without node_modules, or files),
 * sorted, as `./`-prefixed forward-slash paths that `bun test` reads as paths, not name filters. A path that
 * does not exist, or a set of paths with no test file at all, throws: sharding must never quietly run nothing.
 */
export async function listTestFiles(paths: readonly string[], cwd: string): Promise<string[]> {
  const found = new Set<string>();
  for (const path of paths) {
    const absolute = resolve(cwd, path);
    if (!existsSync(absolute)) throw new Error(`realWorkerTests: no such test path: ${path}`);
    if (statSync(absolute).isFile()) {
      found.add(relative(cwd, absolute));
      continue;
    }
    for await (const file of new Bun.Glob(TEST_FILE_GLOB).scan({ cwd: absolute, onlyFiles: true })) {
      if (file.split(/[\\/]/).includes("node_modules")) continue;
      found.add(relative(cwd, join(absolute, file)));
    }
  }
  if (found.size === 0) throw new Error(`realWorkerTests: no test files under ${paths.join(" ")}`);
  return [...found].map((file) => `./${file.split(sep).join("/")}`).sort();
}

/** Deals `files` round-robin into `count` groups, none empty (there are never more groups than files). */
export function shardFiles(files: readonly string[], count: number): string[][] {
  const groups: string[][] = Array.from({ length: Math.min(count, files.length) }, () => []);
  files.forEach((file, index) => groups[index % groups.length]?.push(file));
  return groups;
}

/** The `bun test` argument lists of a run: the arguments as they are for one shard, otherwise one list per group of files (the flags, then its files). */
export async function shardedTestArgs(testArgs: readonly string[], shards: number, cwd: string): Promise<string[][]> {
  if (shards <= 1) return [[...testArgs]];
  const flags = testArgs.filter((arg) => arg.startsWith("-"));
  const paths = testArgs.filter((arg) => !arg.startsWith("-"));
  return shardFiles(await listTestFiles(paths, cwd), shards).map((group) => [...flags, ...group]);
}

export interface AttemptResult {
  exitCode: number;
  output: string;
  /** The attempt was killed for running past its bound. */
  timedOut?: boolean;
}

/**
 * Runs `attempt` until it passes, fails for real, or has crashed `maxAttempts` times. Returns the exit code
 * for the process: 0 for a pass, otherwise the failing attempt's own (never 0 for a failure). Every retry is
 * announced through `warn` as a GitHub `::warning::` annotation, so the crash rate stays visible in the run.
 */
export async function runWithCrashRetry(
  attempt: () => Promise<AttemptResult>,
  options: { maxAttempts?: number; warn?: (line: string) => void; signatures?: readonly RegExp[] } = {},
): Promise<number> {
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  // stdout, where the runner reads a workflow command (a `::warning::` written to stderr is easy to lose).
  const warn = options.warn ?? ((line: string) => console.log(line));
  for (let n = 1; ; n++) {
    const result = await attempt();
    if (result.exitCode === 0 && result.timedOut !== true) return 0;
    const retry = n < maxAttempts && result.timedOut !== true && isBunCrashOnly(result.output, options.signatures);
    if (!retry) return result.exitCode === 0 ? 1 : result.exitCode;
    warn(`::warning::realWorkerTests: Bun crashed with no failed test: attempt ${n} of ${maxAttempts}, retrying`);
  }
}

export interface RunOnceOptions {
  command: readonly string[];
  env: Record<string, string | undefined>;
  /** The attempt is killed after this long. */
  timeoutMs: number;
  /** After the child is gone, how long its output pipes may stay open (a grandchild can hold them) before they are cut. */
  graceMs: number;
  /** Copy the child's output to this process's own. */
  echo: boolean;
}

/** One attempt: the command, its output collected, bounded by `timeoutMs`; a hung child is killed with SIGKILL. */
export async function runOnce(options: RunOnceOptions): Promise<AttemptResult> {
  const child = Bun.spawn([...options.command], { env: options.env, stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, options.timeoutMs);
  // One buffer per stream: two streams interleaved in one buffer could glue a partial stdout line onto a `(fail)` line.
  const collected = { stdout: "", stderr: "" };
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const pump = async (stream: ReadableStream<Uint8Array>, into: "stdout" | "stderr", sink: (text: string) => void): Promise<void> => {
    const reader = stream.getReader();
    readers.push(reader);
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true as const, value: undefined }));
      if (done) return;
      const text = decoder.decode(value, { stream: true });
      collected[into] += text;
      if (options.echo) sink(text);
    }
  };
  const pumps = Promise.all([pump(child.stdout, "stdout", (t) => process.stdout.write(t)), pump(child.stderr, "stderr", (t) => process.stderr.write(t))]);
  try {
    const exitCode = await child.exited;
    // The child is gone; whatever it wrote is in the pipes already. A grandchild that inherited them would keep them open: cut them after the grace.
    let grace: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([pumps, new Promise<void>((resolve) => (grace = setTimeout(resolve, options.graceMs)))]);
    clearTimeout(grace);
    for (const reader of readers) await reader.cancel().catch(() => undefined);
    if (timedOut && options.echo) console.error(`\nrealWorkerTests: the attempt ran past ${options.timeoutMs / 1000} s and was killed; not retried\n`);
    // A newline between the two, so neither stream's unfinished last line runs into the other's first.
    return { exitCode, output: `${collected.stdout}\n${collected.stderr}`, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

if (import.meta.main) {
  let target: TestTarget;
  let plan: string[][];
  try {
    target = testTarget(process.argv.slice(2));
    plan = await shardedTestArgs(target.testArgs, target.shards, process.cwd());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  let exitCode = 0;
  for (const [index, args] of plan.entries()) {
    if (plan.length > 1) console.log(`\n== shard ${index + 1} of ${plan.length}: ${args.filter((a) => !a.startsWith("-")).length} test files ==`);
    const run = () =>
      runOnce({
        command: [process.execPath, "--no-env-file", "test", ...args],
        env: childEnv(process.env),
        timeoutMs: ATTEMPT_TIMEOUT_MS,
        graceMs: 2_000,
        echo: true,
      });
    const code = await runWithCrashRetry(run, target.knownCrashesOnly ? { signatures: WORKER_TEARDOWN_CRASHES } : {});
    if (code !== 0 && exitCode === 0) exitCode = code;
  }
  process.exit(exitCode);
}
