/**
 * Runs `bun test` with a bounded retry for one known cause: Bun itself crashing.
 *
 *   bun run test:studio:real-worker                      the real-worker file, alone (T7c)
 *   bun run test:studio:suite ./studio [--randomize]     the main suite, same retry
 *   bun run test:studio:real-worker:canary               the same file, known crashes only
 *   bun run test:studio:suite:canary ./studio --randomize   the suite, known crashes only
 *
 * With no mode argument it runs `workerGate.real.test.ts` — the tests that spin up
 * the REAL face worker (real models, ORT with its own threads) and terminate
 * it. After `--suite` the arguments are handed to `bun test` as they are.
 * `--known-crashes-only`, first, narrows the retry to the worker-teardown
 * segfaults (the canary). Any other argument is a usage error.
 *
 * Why a crash is retried at all: Bun segfaults ("Segmentation fault at address
 * 0x18" or 0xFFFFFFFFFFFFFFF8, exit 133) while tearing down a worker that runs
 * WASM — measured ~2% of runs of the real-worker file alone, ~11% of full
 * `bun test ./studio` suites while that file was part of them. It also
 * happens right after `workerGate.test.ts`'s interruption test terminates its
 * worker, in the main suite: a crash in Bun's teardown, not in any assertion.
 * Node/Electron are not affected (the worker gate's own stress and the
 * packaged smoke run clean). The real-worker file skips itself unless
 * STUDIO_REAL_WORKER_TESTS=1, which only the no-argument mode sets, so it
 * never runs inside the main suite.
 *
 * The retry (at most 3 attempts) fires ONLY when the output shows the Bun
 * crash and no failure (no `(fail)` line, no red cross, no `N fail` or `N error`
 * summary with N above zero, no "Unhandled error between tests" load error; the
 * child also runs with colour off): a real failure fails the step at once and is
 * never retried into a pass. Each retry prints a `::warning::` annotation. An attempt
 * that runs past its own time bound is killed and fails at once too: a hang is
 * not a crash. Each attempt has that bound, so the step's `timeout-minutes` is
 * (attempts x bound) plus slack, and a hang still ends in minutes.
 */
export const REAL_WORKER_TEST_FILE = "studio/engine/face/worker/workerGate.real.test.ts";
/** 3b.2: the text worker terminates a real wasm computation too, so its real-thread tests run here, apart from the main suite, for the same Bun crash. */
export const TEXT_REAL_WORKER_TEST_FILE = "studio/engine/text/worker/textGate.real.test.ts";
export const MAX_ATTEMPTS = 3;
/** One attempt's bound. A suite that takes longer is hung, not slow (the main suite runs in a few minutes). */
export const ATTEMPT_TIMEOUT_MS = 10 * 60 * 1000;

const ANSI = /\u001b\[[0-9;]*m/g;

/** Any crash of Bun itself. */
export const ANY_BUN_CRASH: readonly RegExp[] = [/Bun has crashed/, /Segmentation fault/, /^panic:/m];

/**
 * The one crash that is known and understood: the segfault while a terminated WASM worker is torn down, at
 * address 0x18 (the real-worker file) or 0xFFFFFFFFFFFFFFF8 (right after workerGate.test.ts's interruption
 * test). A crash anywhere else is news, and the canary exists to report it.
 */
export const WORKER_TEARDOWN_CRASHES: readonly RegExp[] = [/Segmentation fault at address 0x18\b/i, /Segmentation fault at address 0xFFFFFFFFFFFFFFF8\b/i];

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

/** The child's environment: colour off (FORCE_COLOR dropped), so a failure prints as the literal `(fail)` this file's detector reads, and the real-worker tests on only when asked (the default). */
export function childEnv(
  parent: Readonly<Record<string, string | undefined>>,
  options: { realWorker: boolean } = { realWorker: true },
): Record<string, string | undefined> {
  const { FORCE_COLOR: _color, STUDIO_REAL_WORKER_TESTS: _gate, ...rest } = parent;
  return options.realWorker ? { ...rest, NO_COLOR: "1", STUDIO_REAL_WORKER_TESTS: "1" } : { ...rest, NO_COLOR: "1" };
}

export interface TestTarget {
  testArgs: string[];
  /** Run with STUDIO_REAL_WORKER_TESTS=1 (the real-worker file's own mode). */
  realWorker: boolean;
  /** Retry only the known worker-teardown crashes (the canary), not any Bun crash. */
  knownCrashesOnly: boolean;
}

const USAGE = "usage: realWorkerTests.ts [--known-crashes-only]   (the real-worker file)  |  realWorkerTests.ts [--known-crashes-only] --suite <bun test arguments...>";

/**
 * What to hand to `bun test`. No mode argument: the real-worker file. `--suite <args...>`: exactly those `bun test`
 * arguments (the main suite). `--known-crashes-only` comes first, in either mode, and narrows the retry. Anything
 * else is a usage error, so an extra flag never quietly turns one mode into the other, and a
 * `--known-crashes-only` after `--suite` (which bun would receive, not this script) is refused too.
 */
export function testTarget(argv: readonly string[]): TestTarget {
  const knownCrashesOnly = argv[0] === "--known-crashes-only";
  const rest = knownCrashesOnly ? argv.slice(1) : argv;
  if (rest.length === 0) return { testArgs: [REAL_WORKER_TEST_FILE, TEXT_REAL_WORKER_TEST_FILE], realWorker: true, knownCrashesOnly };
  if (rest[0] !== "--suite" || rest.length < 2 || rest.includes("--known-crashes-only")) throw new Error(USAGE);
  return { testArgs: rest.slice(1), realWorker: false, knownCrashesOnly };
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
  try {
    target = testTarget(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  const run = () =>
    runOnce({
      command: [process.execPath, "--no-env-file", "test", ...target.testArgs],
      env: childEnv(process.env, { realWorker: target.realWorker }),
      timeoutMs: ATTEMPT_TIMEOUT_MS,
      graceMs: 2_000,
      echo: true,
    });
  process.exit(await runWithCrashRetry(run, target.knownCrashesOnly ? { signatures: WORKER_TEARDOWN_CRASHES } : {}));
}
