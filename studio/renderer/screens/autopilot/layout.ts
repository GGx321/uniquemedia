import { type RefObject, useEffect, useLayoutEffect, useState } from "react";
import { observeSize } from "../../ui/observeSize";

// S4.9a: the two window sizes the «Автопилот» artboards are drawn at (1440 and 1200) and the design's scroll rule (decision 1, round 1 M6): a scrolling area
// shows its bottom fade only while its content is longer than it is. CSS lays the columns out for both sizes; these hooks carry the few words that differ.

const WIDE = "(min-width: 1440px)";

/** Whether the window is as wide as the 1440 artboards (the shorter words and the folded plan card are the 1200 ones). Wide where it cannot be told. */
export function useWide(): boolean {
  const [wide, setWide] = useState(() => matches());
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(WIDE);
    const onChange = (): void => setWide(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return wide;
}

function matches(): boolean {
  try {
    return typeof window.matchMedia === "function" ? window.matchMedia(WIDE).matches : true;
  } catch {
    return true;
  }
}

/**
 * Whether `scroller`'s content is longer than the scroller itself: its fade shows then, and only then. Followed by size alone (the scroller and its content,
 * `content`), with no timer: notes appearing over «Запустить» or a window resize move it.
 */
export function useOverflows(scroller: RefObject<HTMLElement | null>, content: RefObject<HTMLElement | null>): boolean {
  const [over, setOver] = useState(false);
  useLayoutEffect(() => {
    const outer = scroller.current;
    const inner = content.current;
    if (outer === null || inner === null) return;
    const judge = (): void => setOver(outer.scrollHeight > outer.clientHeight + 2);
    judge();
    const stopOuter = observeSize(outer, judge);
    const stopInner = observeSize(inner, judge);
    return () => {
      stopOuter();
      stopInner();
    };
  }, [scroller, content]);
  return over;
}
