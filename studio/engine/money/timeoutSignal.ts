/**
 * A ref'd alternative to `AbortSignal.timeout(ms)`, built from a plain
 * `AbortController` and a normal `setTimeout` — never `AbortSignal.timeout`
 * itself.
 *
 * `AbortSignal.timeout()`'s own timer is unref'd (it never has to keep a
 * process alive on its own). On Windows, under Bun's NATIVE
 * AbortController/AbortSignal, that left `engine.candidates.test.ts`'s "a
 * hung preflight is bounded" test — and, by the same shape, any real bound
 * on a hung ffmpeg preflight, a live-library re-check, a price fetch, or an
 * image-prepare step — hanging indefinitely once M6 moved engine/main/node/
 * scripts tests off happy-dom's `AbortSignal.timeout()` (plain-setTimeout-
 * based, and never unref'd) onto the native one. macOS and Linux never
 * showed this; production (Electron's Node) was never proven safe from it
 * either — a bound that guards money and claims must not depend on a
 * runtime's own timer semantics.
 *
 * Mirrors what `AbortSignal.timeout()` itself produces: `signal.reason` is a
 * `DOMException` named "TimeoutError", with the same message. Checked by
 * shape (`.name`, `.constructor.name`), never by identity against the bare
 * `DOMException` global — `studio/testing/nativeGlobals.ts`'s
 * `useNativeGlobals()` swaps only AbortController/AbortSignal, so a test
 * file that calls it still has happy-dom's `DOMException` as that bare
 * identifier (see `nativeGlobals.test.ts`'s own note on the same point).
 *
 * `clear()` cancels the timer; every caller must call it, in a `finally`,
 * once its work with `signal` is over — finished, failed, or aborted itself
 * — so the ref'd timer never outlives its own work and never holds a
 * finished process open waiting for it to fire.
 *
 * Dependency-free by design, like every other helper in `studio/node/`:
 * engine code (`studio/engine`, `studio/node`, `studio/scripts`) imports
 * only `node:*` modules, so this uses nothing but the ambient
 * AbortController/AbortSignal/DOMException/setTimeout/clearTimeout the
 * runtime already provides — native under Electron's Node and under Bun,
 * happy-dom's own in a test file that has not called `useNativeGlobals()`.
 *
 * It lives in money/ because money's own import rule (runtime.test.ts) is the
 * strictest: money code may import only node:*, zod and its own siblings. The
 * engine, the avatar jobs and the scripts import it from here, so there is one
 * copy.
 */
export interface TimeoutSignal {
  /** Aborts once `ms` elapses, unless `clear()` runs first. */
  signal: AbortSignal;
  /** Cancels the timer. Idempotent: safe to call whether or not it already fired. */
  clear: () => void;
}

export function timeoutSignal(ms: number): TimeoutSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

/**
 * `work`, or the signal's reason as soon as it fires; a late rejection of the
 * abandoned work is dropped. Bounds `work` even when it ignores `signal`
 * itself (a hung native call, or a test double that does not bother) — the
 * race here is what settles, not `work`'s own cooperation. The partner of
 * `timeoutSignal` above: every bound that guards money or a claim pairs the
 * two, so both live here, where every engine module can import them.
 */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  work.catch(() => {});
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
