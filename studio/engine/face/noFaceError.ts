/**
 * Money review N3: `embed()`'s one specific, expected failure — the
 * reference image genuinely has no detectable face — needs to be told apart
 * from every other way `embed()`/`check()` can fail (a decode failure
 * upstream, an ORT/WASM crash, a timeout): those are systemic (the gate
 * itself is broken, not "this master has no face"), and `runJob.ts`'s
 * `prepareGates()` must route them differently — `MASTER_FACE_UNUSABLE`'s
 * own Russian text tells the owner to fix the master; that text is wrong,
 * and possibly the master is fine, for anything else. A dedicated class
 * (not string-matching `error.message`) is the only reliable way to tell
 * the two apart across that boundary.
 */
export class NoFaceInReferenceError extends Error {
  constructor() {
    super("face/gate: embed() found no face in the reference image");
  }
}
