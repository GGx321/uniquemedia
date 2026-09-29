import { MIN_CLIP_MS, msToFrames } from "../../shared/montage";
import { RenderGraphError } from "./types";

/**
 * A clip's length in frames, or a `BAD_DURATION` refusal. The shared
 * geometry throws a bare `RangeError` for a time off the 100 ms grid; the
 * builders speak one error model, so it is wrapped here. A clip shorter than
 * the contract's minimum is refused too: a zero-length clip would make
 * `loop=loop=-1` and an endless pass 1.
 */
export function clipFrames(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs < MIN_CLIP_MS) {
    throw new RenderGraphError("BAD_DURATION", `a clip lasts at least ${MIN_CLIP_MS} ms, got ${durationMs}`);
  }
  try {
    return msToFrames(durationMs);
  } catch (e) {
    if (e instanceof RangeError) throw new RenderGraphError("BAD_DURATION", e.message);
    throw e;
  }
}
