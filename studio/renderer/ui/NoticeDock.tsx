import { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import { createPortal } from "react-dom";

// Where the window's own notices (the engine's, a render that ended elsewhere) are drawn (slice review 5, L1). On most screens they stand on top of
// the page, as the components sheet draws the engine's bar. A screen that cannot spare the room (the montage editor, whose preview a row of notices
// squeezed by a quarter at the window's floor) offers a dock instead: they are drawn in it, over its content, next to its own notices. Only their
// picture moves: the components that decide which notices exist stay where they are, so nothing they track is lost when the dock comes or goes.

interface Dock {
  readonly node: HTMLElement | null;
  readonly offer: (node: HTMLElement | null) => void;
}

const DockContext = createContext<Dock | null>(null);

/** One per window (App). */
export function NoticeDockProvider({ children }: { children: ReactNode }) {
  const [node, offer] = useState<HTMLElement | null>(null);
  const value = useMemo(() => ({ node, offer }), [node]);
  return <DockContext.Provider value={value}>{children}</DockContext.Provider>;
}

/** The window's notices: in the dock a screen offers while it is mounted, else where they stand. */
export function Docked({ children }: { children: ReactNode }) {
  const node = useContext(DockContext)?.node ?? null;
  return node === null ? children : createPortal(children, node);
}

const noOffer = (): void => undefined;

/** A callback ref for the element a screen offers as the dock: set while it is mounted, withdrawn when it goes. */
export function useNoticeDock(): (node: HTMLElement | null) => void {
  return useContext(DockContext)?.offer ?? noOffer;
}
