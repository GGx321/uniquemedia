import { useCallback, useEffect, useRef, useState } from "react";

/** How long a live region keeps what it said before it is cleared. */
export const ANNOUNCE_MS = 1000;

/**
 * The text of a persistent live region: `say` sets it, and it is cleared `ANNOUNCE_MS` later, so the region is empty between
 * announcements and the same words said again are announced again. The region itself stays in the page (one inserted with
 * its text, or an alert put back on a re-render, would be said again or not at all).
 */
export function useAnnouncer(): readonly [string, (text: string) => void] {
  const [text, setText] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const say = useCallback((next: string): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    setText(next);
    timer.current = setTimeout(() => {
      timer.current = null;
      setText("");
    }, ANNOUNCE_MS);
  }, []);
  return [text, say];
}
