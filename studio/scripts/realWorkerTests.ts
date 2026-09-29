/**
 * Runs `bun test` with a bounded retry for one known cause: Bun itself crashing.
 *
 *   bun run test:studio:real-worker                      the real-worker file, alone (T7c)
 *   bun studio/scripts/realWorkerTests.ts ./studio       the main suite, same retry
 *   bun studio/scripts/realWorkerTests.ts ./studio --randomize
 *
 * With no arguments it runs `workerGate.real.test.ts` — the tests that spin up
 * the REAL face worker (real models, ORT with its own threads) and terminate
 * it. With arguments they are handed to `bun test` as they are.
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
 * crash and no failed test (no `(fail)` line, no red cross, no `N fail`
 * summary with N above zero; the child also runs with colour off): a real test
 * failure fails the step at once and is never retried into a pass. An attempt
 * that runs past its own time bound is killed and fails at once too: a hang is
 * not a crash. Each attempt has that bound, so the step's `timeout-minutes` is
 * (attempts x bound) plus slack, and a hang still ends in minutes.
 */
export const REAL_WORKER_TEST_FILE = "studio/engine/face/worker/workerGate.real.test.ts";
export const MAX_ATTEMPTS = 3;
/** One attempt's bound. A suite that takes longer is hung, not slow (the main suite runs in a few minutes). */
export const ATTEMPT_TIMEOUT_MS = 10 * 60 * 1000;

const ANSI = /\u001b\[[0-9;]*m/g;

/** True when `output` shows Bun crashing itself and not a single failed test. A failure is read three ways, so colour cannot hide one: the literal `(fail)` line, a red cross, and a `N fail` summary with N above zero. */
export function isBunCrashOnly(output: string): boolean {
  const plain = output.replace(ANSI, "");
  const crashed = /Bun has crashed|Segmentation fault|^panic:/m.test(plain);
  const failedATest = /^\s*\(fail\)|^\s*✗/m.test(plain) || /^\s*[1-9]\d*\s+fail\b/m.test(plain);
  return crashed && !failedATest;
}

/** The child's environment: colour off (FORCE_COLOR dropped), so a failure prints as the literal `(fail)` this file's detector reads, and the real-worker tests on only when asked (the default). */
export function childEnv(
  parent: Readonly<Record<string, string | undefined>>,
  options: { realWorker: boolean } = { realWorker: true },
): Record<string, string | undefined> {
  const { FORCE_COLOR: _color, STUDIO_REAL_WORKER_TESTS: _gate, ...rest } = parent;
  return options.realWorker ? { ...rest, NO_COLOR: "1", STUDIO_REAL_WORKER_TESTS: "1" } : { ...rest, NO_COLOR: "1" };
}

/** What to hand to `bun test`: the script's own arguments, or the real-worker file when there are none. */
export function testTarget(argv: readonly string[]): { testArgs: string[]; realWorker: boolean } {
  return argv.length === 0 ? { testArgs: [REAL_WORKER_TEST_FILE], realWorker: true } : { testArgs: [...argv], realWorker: false };
}

export interface AttemptResult {
  exitCode: number;
  output: string;
  /** The attempt was killed for running past its bound. */
  timedOut?: boolean;
}

/**
 * Runs `attempt` until it passes, fails for real, or has crashed `maxAttempts` times. Returns the exit code
 * for the process: 0 for a pass, otherwise the failing attempt's own (never 0 for a failure).
 */
export async function runWithCrashRetry(
  attempt: () => Promise<AttemptResult>,
  options: { maxAttempts?: number; warn?: (line: string) => void } = {},
): Promise<number> {
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  const warn = options.warn ?? (() => undefined);
  for (let n = 1; ; n++) {
    const result = await attempt();
    if (result.exitCode === 0 && result.timedOut !== true) return 0;
    const retry = n < maxAttempts && result.timedOut !== true && isBunCrashOnly(result.output);
    if (!retry) return result.exitCode === 0 ? 1 : result.exitCode;
    warn(`\nrealWorkerTests: Bun crashed (its known worker-teardown segfault) with no failed test: attempt ${n} of ${maxAttempts}, retrying\n`);
  }
}

async function runOnce(testArgs: readonly string[], realWorker: boolean): Promise<AttemptResult> {
  const child = Bun.spawn([process.execPath, "--no-env-file", "test", ...testArgs], {
    env: childEnv(process.env, { realWorker }),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, ATTEMPT_TIMEOUT_MS);
  let output = "";
  const pump = async (stream: ReadableStream<Uint8Array>, sink: (text: string) => void): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      output += text;
      sink(text);
    }
  };
  try {
    await Promise.all([pump(child.stdout, (t) => process.stdout.write(t)), pump(child.stderr, (t) => process.stderr.write(t))]);
    const exitCode = await child.exited;
    if (timedOut) console.error(`\nrealWorkerTests: the attempt ran past ${ATTEMPT_TIMEOUT_MS / 1000} s and was killed; not retried\n`);
    return { exitCode, output, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

if (import.meta.main) {
  const { testArgs, realWorker } = testTarget(process.argv.slice(2));
  process.exit(await runWithCrashRetry(() => runOnce(testArgs, realWorker), { warn: (line) => console.warn(line) }));
}
