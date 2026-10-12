import { type ReactNode, useLayoutEffect, useRef } from "react";

/**
 * The screen's h1. It takes focus when the screen opens, so keyboard and screen-reader users land on the new screen. A layout effect, not a passive one: a screen
 * that swaps its loading title for the loaded one removes the h1 that held the focus, and a passive effect would leave the focus on the body until after the paint.
 */
export function ScreenTitle({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  return (
    <h1 ref={ref} className="screen-title" tabIndex={-1}>
      {children}
    </h1>
  );
}
