import ffmpegStaticPath from "ffmpeg-static";

// Matches a whole "app.asar" path segment on either separator style — not a
// prefix or suffix of a longer segment name, e.g. "myapp.asarchive" or
// "app.asarchive", which must be left alone.
const ASAR_SEGMENT = /(^|[\\/])app\.asar(?=[\\/]|$)/;

/**
 * Rewrites an `app.asar`-relative path to its `app.asar.unpacked` sibling —
 * Electron unpacks native binaries there because asar archives are not
 * executable (see src/node/ffmpegExecutor.ts for the same rewrite on the
 * uniquifier's side). Exported on its own, test-only and not part of the
 * documented API, so the rewrite can be unit-tested against posix and
 * Windows paths without depending on what `ffmpeg-static` actually resolves
 * on the machine running the tests.
 */
export function unpackAsarSegment(path: string): string {
  return path.replace(ASAR_SEGMENT, "$1app.asar.unpacked");
}

// TEST-ONLY seam (the `__..ForTests` name is deliberate) for pointing
// `ffmpegPath()` at a nonexistent binary, to exercise runFfmpeg's
// spawn-error handling. `bun:test`'s `mock.module("ffmpeg-static", ...)` was
// tried first and rejected: it patches the module process-wide, and `bun
// test` runs every file in one process, so a mock left active by this file
// leaks into any other file that resolves `ffmpeg-static` afterwards —
// confirmed by running the full suite with such a mock in place, which broke
// 24 unrelated tests in src/node that spawn the real binary. This module-
// local variable is scoped to whichever test sets it, is always reset in a
// `finally`, and never touches any other file's view of `ffmpeg-static`.
let ffmpegPathOverrideForTests: string | undefined;

/** Sets or clears the override above. Does not change `ffmpegPath`'s own
 *  signature or return type — callers of the real API see nothing of this. */
export function __setFfmpegPathOverrideForTests(path: string | undefined): void {
  ffmpegPathOverrideForTests = path;
}

/**
 * Resolves the bundled ffmpeg binary path. `ffmpeg-static` can also resolve
 * to `null` on a platform/architecture it has no binary for, which is worth
 * a clear error rather than a confusing spawn ENOENT.
 */
export function ffmpegPath(): string {
  if (ffmpegPathOverrideForTests !== undefined) return ffmpegPathOverrideForTests;
  if (!ffmpegStaticPath) {
    throw new Error("ffmpeg-static did not resolve a binary for this platform/architecture.");
  }
  return unpackAsarSegment(ffmpegStaticPath);
}
