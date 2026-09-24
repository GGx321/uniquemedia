import { type ReactNode, useEffect, useRef } from "react";

/** The screen's h1. It takes focus when the screen opens, so keyboard and screen-reader users land on the new screen. */
export function ScreenTitle({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  return (
    <h1 ref={ref} className="screen-title" tabIndex={-1}>
      {children}
    </h1>
  );
}
