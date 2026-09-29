/**
 * T7c: runs `workerGate.real.test.ts` — the tests that spin up the REAL face
 * worker (real models, ORT with its own threads) and terminate it — alone, in
 * its own CI step, with a bounded retry for one known cause.
 *
 *   bun run test:studio:real-worker
 *
 * Why apart: Bun itself segfaults ("Segmentation fault at address 0x18", exit
 * 133) while tearing down a worker that runs WASM — measured ~2% of runs of
 * that file alone, ~11% of full `bun test ./studio` suites while the file was
 * part of them (0 of 10 on the merge-base, which has no worker). Node/Electron
 * are not affected (the worker gate's own stress and the packaged smoke run
 * clean). The file therefore skips itself unless STUDIO_REAL_WORKER_TESTS=1,
 * which only this script sets, and the rest of the suite stays deterministic.
 *
 * The retry (at most 3 attempts) fires ONLY when the output shows the Bun
 * crash and no failed test (no `(fail)` line, no red cross, no `N fail`
 * summary with N above zero; the child also runs with colour off): a real test
 * failure fails the step at once and is never retried into a pass.
 */
export const REAL_WORKER_TEST_FILE = "studio/engine/face/worker/workerGate.real.test.ts";
export const MAX_ATTEMPTS = 3;

const ANSI = /\u001b\[[0-9;]*m/g;

/** True when `output` shows Bun crashing itself and not a single failed test. A failure is read three ways, so colour cannot hide one: the literal `(fail)` line, a red cross, and a `N fail` summary with N above zero. */
export function isBunCrashOnly(output: string): boolean {
  const plain = output.replace(ANSI, "");
  const crashed = /Bun has crashed|Segmentation fault|^panic:/m.test(plain);
  const failedATest = /^\s*\(fail\)|^\s*✗/m.test(plain) || /^\s*[1-9]\d*\s+fail\b/m.test(plain);
  return crashed && !failedATest;
}

/** The child's environment: colour off (FORCE_COLOR dropped), so a failure prints as the literal `(fail)` this file's detector reads, and the real-worker tests enabled. */
export function childEnv(parent: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  const { FORCE_COLOR: _dropped, ...rest } = parent;
  return { ...rest, NO_COLOR: "1", STUDIO_REAL_WORKER_TESTS: "1" };
}

async function runOnce(): Promise<{ exitCode: number; output: string }> {
  const child = Bun.spawn([process.execPath, "--no-env-file", "test", REAL_WORKER_TEST_FILE], {
    env: childEnv(process.env),
    stdout: "pipe",
    stderr: "pipe",
  });
  let output = "";
  const pump = async (stream: ReadableStream<Uint8Array>, sink: (text: string) => void): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      output += text;
      sink(text);
    }
  };
  await Promise.all([pump(child.stdout, (t) => process.stdout.write(t)), pump(child.stderr, (t) => process.stderr.write(t))]);
  return { exitCode: await child.exited, output };
}

if (import.meta.main) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { exitCode, output } = await runOnce();
    if (exitCode === 0) process.exit(0);
    if (attempt < MAX_ATTEMPTS && isBunCrashOnly(output)) {
      console.warn(`\nrealWorkerTests: Bun crashed (its known worker-teardown segfault) with no failed test — attempt ${attempt} of ${MAX_ATTEMPTS}, retrying\n`);
      continue;
    }
    process.exit(exitCode === 0 ? 1 : exitCode);
  }
}
