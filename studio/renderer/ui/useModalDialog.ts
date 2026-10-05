import { type MouseEvent, type PointerEvent, type RefObject, useEffect, useLayoutEffect, useRef } from "react";

/** What Tab can reach inside a dialog, in document order (the dialog's own focus edges aside). */
const TABBABLE = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "video[controls]",
  "audio[controls]",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

export interface ModalDialogOptions {
  /** The dialog's own element, a FocusEdge (ui/FocusEdge.tsx) its first and its last child. */
  readonly dialog: RefObject<HTMLElement | null>;
  /** What takes the focus when the dialog opens (its «Закрыть»). */
  readonly initialFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  /**
   * Where the focus goes when the dialog closes. Null, or none given: back to what had it when the dialog opened, if it is
   * still on the page.
   */
  readonly returnFocus?: () => HTMLElement | null;
}

/**
 * A modal dialog's keyboard, the same in every dialog of the window (the video player, the photo viewer), for a dialog
 * portalled to `body`: the focus moves in when it opens, and everything else in `body` is `inert` while it is open; Tab moves
 * as the browser moves it, and a focus that reaches a FocusEdge or strays out of the dialog comes round to its first control
 * (to its last after Shift+Tab); Escape closes it; when it closes the focus goes back to the page. The latest `onClose` and
 * `returnFocus` are used, so a parent may pass new ones on every render without the dialog taking the focus again.
 */
export function useModalDialog({ dialog, initialFocus, onClose, returnFocus }: ModalDialogOptions): void {
  const latest = useRef({ onClose, returnFocus });
  useLayoutEffect(() => {
    latest.current = { onClose, returnFocus };
  });

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const inerted = dialog.current === null ? [] : inertOutside(dialog.current);
    initialFocus.current?.focus();
    let backward = false;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        latest.current.onClose();
      } else if (event.key === "Tab") {
        backward = event.shiftKey;
      }
    };
    const onFocusIn = (event: FocusEvent): void => {
      const root = dialog.current;
      const target = event.target;
      if (root === null || !(target instanceof HTMLElement)) return;
      const inside = root.contains(target);
      if (inside && target.dataset.focusEdge === undefined) return;
      const controls = Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter((el) => el.dataset.focusEdge === undefined);
      // By the direction of the last Tab alone, never by which edge was reached: from the dialog's own element (a press on
      // its photo focuses it) Tab reaches the start edge first, and in Electron Shift+Tab comes round to the end edge.
      ((backward ? controls.at(-1) : controls[0]) ?? root).focus({ preventScroll: true });
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocusIn);
      for (const el of inerted) el.removeAttribute("inert");
      const target = latest.current.returnFocus?.() ?? (opener?.isConnected === true ? opener : null);
      target?.focus();
    };
  }, [dialog, initialFocus]);
}

/** Makes every other child of `body` inert while the dialog (inside one of them, its portal) is open; answers those it changed. */
function inertOutside(root: HTMLElement): HTMLElement[] {
  let top: HTMLElement = root;
  while (top.parentElement !== null && top.parentElement !== document.body) top = top.parentElement;
  if (top.parentElement !== document.body) return [];
  const changed: HTMLElement[] = [];
  for (const el of Array.from(document.body.children)) {
    if (el === top || !(el instanceof HTMLElement) || el.hasAttribute("inert")) continue;
    el.setAttribute("inert", "");
    changed.push(el);
  }
  return changed;
}

export interface BackdropHandlers {
  readonly onPointerDown: (event: PointerEvent) => void;
  readonly onPointerUp: (event: PointerEvent) => void;
  readonly onClick: (event: MouseEvent) => void;
}

/**
 * Closing a dialog on the dark around it (`backdrops`: the scrim, and any empty part of the dialog that looks like it): only a
 * press that both starts and ends there, so a drag that selects text in the dialog and is let go over the dark, or the other
 * way round, never closes it. Spread on the scrim.
 */
export function useBackdropClose(onClose: () => void, backdrops: readonly RefObject<HTMLElement | null>[]): BackdropHandlers {
  const down = useRef(false);
  const up = useRef(false);
  const isBackdrop = (target: EventTarget): boolean => backdrops.some((ref) => ref.current !== null && ref.current === target);
  return {
    onPointerDown: (event) => {
      down.current = isBackdrop(event.target);
      up.current = false;
    },
    onPointerUp: (event) => {
      up.current = isBackdrop(event.target);
    },
    onClick: (event) => {
      const close = down.current && up.current && isBackdrop(event.target);
      down.current = false;
      up.current = false;
      if (close) onClose();
    },
  };
}
