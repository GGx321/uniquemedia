import { createContext, type ReactNode, useCallback, useContext, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { plural } from "../lib/format";
import { handOffFocusAfterRemoval } from "./focusHandoff";
import { Icon } from "./Icon";

// Where the window's own notices (the engine's, a render that ended elsewhere) are drawn (slice review 5, L1). On most screens they stand on top of
// the page, as the components sheet draws the engine's bar. A screen that cannot spare the room (the montage editor, whose preview a row of notices
// squeezed by a quarter at the window's floor) offers a dock instead: they are drawn in it, over its content, next to its own notices. Only their
// picture moves: the components that decide which notices exist stay where they are, so nothing they track is lost when the dock comes or goes.
//
// Review r1: the dock keeps its cards out of the owner's way (MEDIUM-2): the newest card shows and the others fold behind «Ещё N»; any card, one
// that cannot be closed too, folds to a chip until its condition changes (its key: the condition and its code). A window notice drawn again in
// another place (it moved into or out of the dock) is not an alert again (LOW-2): its key was seen in this window, so it is said politely.

/** The dock's cards: in the order they came, the ones folded to chips, and whether the stack is unfolded. */
interface Cards {
  readonly order: readonly string[];
  readonly minimized: ReadonlySet<string>;
  readonly expanded: boolean;
  register(key: string): () => void;
  minimize(key: string): void;
  restore(key: string): void;
  setExpanded(expanded: boolean): void;
}

interface Dock {
  readonly node: HTMLElement | null;
  readonly offer: (node: HTMLElement | null) => void;
  /** The keys of the window's notices shown so far in this window. */
  readonly seen: Set<string>;
  readonly cards: Cards;
}

const DockContext = createContext<Dock | null>(null);
/** Inside the dock: a notice there is one of its cards. */
const InDockContext = createContext(false);
/** Drawn by `Docked`: a window notice, which a dock may draw again elsewhere. */
const DockedContext = createContext(false);

/** One per window (App). */
export function NoticeDockProvider({ children }: { children: ReactNode }) {
  const [node, offer] = useState<HTMLElement | null>(null);
  const [seen] = useState(() => new Set<string>());
  const [order, setOrder] = useState<readonly string[]>([]);
  const [minimized, setMinimized] = useState<ReadonlySet<string>>(() => new Set());
  const [expanded, setExpanded] = useState(false);
  const register = useCallback((key: string) => {
    setOrder((now) => (now.includes(key) ? now : [...now, key]));
    return () => {
      setOrder((now) => now.filter((k) => k !== key));
      // A card that goes takes its fold with it (review r2 MEDIUM): its condition ended, so the same condition coming back is news, a card again. A
      // folded card stays mounted as its chip, so folding never gets here.
      setMinimized((now) => {
        if (!now.has(key)) return now;
        const next = new Set(now);
        next.delete(key);
        return next;
      });
    };
  }, []);
  const minimize = useCallback((key: string) => setMinimized((now) => new Set(now).add(key)), []);
  const restore = useCallback((key: string) => {
    setMinimized((now) => {
      const next = new Set(now);
      next.delete(key);
      return next;
    });
  }, []);
  // With fewer than two cards shown the stack has nothing to unfold: it is folded again, so the next pair opens folded (review r2 LOW-2).
  const shown = order.filter((k) => !minimized.has(k)).length;
  useLayoutEffect(() => {
    if (expanded && shown < 2) setExpanded(false);
  }, [expanded, shown]);
  const value = useMemo(() => ({ node, offer, seen, cards: { order, minimized, expanded, register, minimize, restore, setExpanded } }), [node, seen, order, minimized, expanded, register, minimize, restore]);
  return <DockContext.Provider value={value}>{children}</DockContext.Provider>;
}

/** The window's notices: in the dock a screen offers while it is mounted, else where they stand. */
export function Docked({ children }: { children: ReactNode }) {
  const node = useContext(DockContext)?.node ?? null;
  const own = <DockedContext.Provider value={true}>{children}</DockedContext.Provider>;
  return node === null ? own : createPortal(<InDockContext.Provider value={true}>{own}</InDockContext.Provider>, node);
}

/** A screen's own notices drawn in its dock: cards of it, as the window's are. */
export function InDock({ children }: { children: ReactNode }) {
  return <InDockContext.Provider value={true}>{children}</InDockContext.Provider>;
}

const noOffer = (): void => undefined;

/** A callback ref for the element a screen offers as the dock: set while it is mounted, withdrawn when it goes. */
export function useNoticeDock(): (node: HTMLElement | null) => void {
  return useContext(DockContext)?.offer ?? noOffer;
}

/**
 * A window notice's role (review r1 LOW-2): its own the first time it shows in this window; drawn again (moved into the dock or back out, which
 * remounts it), polite (`status`), so a screen reader does not take it for a new alert. Notices with no key, and the screens' own, keep theirs.
 */
export function useNoticeRole(key: string | undefined, role: "alert" | "status"): "alert" | "status" {
  const dock = useContext(DockContext);
  const docked = useContext(DockedContext);
  const seenBefore = (k: string | undefined): boolean => docked && k !== undefined && dock !== null && dock.seen.has(k);
  // Decided per key (review r2 LOW-1): a key that changes in place (the notice happened again) is judged anew, before it is marked seen.
  const [judged, setJudged] = useState(() => ({ key, again: seenBefore(key) }));
  let again = judged.again;
  if (judged.key !== key) {
    again = seenBefore(key);
    setJudged({ key, again });
  }
  useLayoutEffect(() => {
    if (docked && key !== undefined) dock?.seen.add(key);
  }, [dock, docked, key]);
  return again ? "status" : role;
}

/** How a card shows: in full, folded behind «Ещё N», or as a chip. */
export type CardState = "full" | "hidden" | "chip";

export interface DockCard {
  readonly state: CardState;
  minimize(): void;
  restore(): void;
}

/** What a notice is in the dock: null outside it. `key` is its condition and code; one without a key is a card of its own while it is mounted. */
export function useDockCard(key: string | undefined): DockCard | null {
  const dock = useContext(DockContext);
  const inDock = useContext(InDockContext);
  const fallback = useId();
  const id = key ?? `notice-${fallback}`;
  const cards = inDock ? (dock?.cards ?? null) : null;
  const register = cards?.register;
  useLayoutEffect(() => (register === undefined ? undefined : register(id)), [register, id]);
  const minimizeKey = cards?.minimize;
  const restoreKey = cards?.restore;
  const minimize = useCallback(() => minimizeKey?.(id), [minimizeKey, id]);
  const restore = useCallback(() => restoreKey?.(id), [restoreKey, id]);
  if (cards === null) return null;
  return { state: cardState(cards, id), minimize, restore };
}

/** The newest card not folded to a chip shows; the others only while the stack is unfolded. */
function cardState(cards: Cards, id: string): CardState {
  if (cards.minimized.has(id)) return "chip";
  const shown = cards.order.filter((k) => !cards.minimized.has(k));
  return cards.expanded || shown.at(-1) === id || !shown.includes(id) ? "full" : "hidden";
}

const NOTICE_FORMS = ["уведомление", "уведомления", "уведомлений"] as const;

/** «Ещё N уведомлений» under the newest card, or «Свернуть список уведомлений» once the stack is unfolded; nothing for a single card. */
export function DockMore() {
  const cards = useContext(DockContext)?.cards ?? null;
  if (cards === null) return null;
  const shown = cards.order.filter((k) => !cards.minimized.has(k)).length;
  if (shown < 2) return null;
  return <MoreButton expanded={cards.expanded} folded={shown - 1} onToggle={() => cards.setExpanded(!cards.expanded)} />;
}

/** The toggle itself: going (one card left) with the focus on it, it hands the focus to the card that is left (review r2 LOW-2). */
function MoreButton({ expanded, folded, onToggle }: { expanded: boolean; folded: number; onToggle: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useLayoutEffect(
    () => () => {
      const node = ref.current;
      if (node !== null && node === document.activeElement) handOffFocusAfterRemoval(node);
    },
    [],
  );
  return (
    <button ref={ref} type="button" className="ed-dock-more" aria-expanded={expanded} onClick={onToggle}>
      {expanded ? "Свернуть список уведомлений" : `Ещё ${folded} ${plural(folded, NOTICE_FORMS)}`}
      <Icon name="chevronDown" size={12} strokeWidth={2.4} />
    </button>
  );
}
