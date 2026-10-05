import { useEffect, useState } from "react";

// `studio-media://` answers 503 when no disk slot came free in time and 504 when the disk ran past its deadline (main/media/diskGate.ts). Both are passing
// conditions (a busy burst, a share that is slow to wake), but an `<img>` or `<video>` can only say that it failed: it cannot read a status or a Retry-After,
// and the page's CSP keeps `fetch` away from the scheme. So an element that failed is given exactly ONE more try after a pause, the way the status asks for,
// and only a second failure becomes the placeholder. This is the one place that policy lives; the components only wire `key`, `onError` and `failed`.

/** The pause before the second try: the `Retry-After` main sends (1 s). */
export const MEDIA_RETRY_DELAY_MS = 1000;

type Phase = "first" | "waiting" | "retrying" | "failed";

export interface MediaRetry {
  /** Put on the element: it changes for the second try, and a new element loads the same address again. */
  readonly key: number;
  /** Both tries failed: draw the placeholder. */
  readonly failed: boolean;
  /**
   * The first try failed and the pause before the second runs. The errored element must not be drawn meanwhile: Chromium paints a broken-image icon and the
   * alt text for it, which for a second would look like a glitch where a real 404 used to show the placeholder at once. Draw the placeholder, or nothing.
   */
  readonly waiting: boolean;
  /** The element's `onError`. */
  onError(): void;
}

/**
 * The retry state of one element showing `src`. The state belongs to the address: another one starts again from its first try. A failure that arrives while the
 * pause runs (or after the verdict) changes nothing.
 */
export function useMediaRetry(src: string | null, delayMs: number = MEDIA_RETRY_DELAY_MS): MediaRetry {
  const [state, setState] = useState<{ src: string | null; phase: Phase }>({ src, phase: "first" });
  const phase: Phase = state.src === src ? state.phase : "first";

  useEffect(() => {
    if (phase !== "waiting") return;
    const timer = setTimeout(() => setState({ src, phase: "retrying" }), delayMs);
    return () => clearTimeout(timer);
  }, [phase, src, delayMs]);

  return {
    key: phase === "retrying" || phase === "failed" ? 1 : 0,
    failed: phase === "failed",
    waiting: phase === "waiting",
    onError: () => {
      setState((current) => {
        const now: Phase = current.src === src ? current.phase : "first";
        if (now === "first") return { src, phase: "waiting" };
        if (now === "retrying") return { src, phase: "failed" };
        return current.src === src ? current : { src, phase: "first" };
      });
    },
  };
}
