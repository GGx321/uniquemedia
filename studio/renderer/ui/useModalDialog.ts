import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";

/** What Tab can reach inside a dialog, in document order. */
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
  /** The dialog's own element: Tab and Shift+Tab go round inside it. */
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
 * A modal dialog's keyboard, the same in every dialog of the window (the video player, the photo viewer): the focus moves in
 * when it opens, Tab and Shift+Tab go round inside it (a focus that strayed out comes back on the next Tab), Escape closes it,
 * and when it closes the focus goes back to the page. The latest `onClose` and `returnFocus` are used, so a parent may pass
 * new ones on every render without the dialog taking the focus again.
 */
export function useModalDialog({ dialog, initialFocus, onClose, returnFocus }: ModalDialogOptions): void {
  const latest = useRef({ onClose, returnFocus });
  useLayoutEffect(() => {
    latest.current = { onClose, returnFocus };
  });

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    initialFocus.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        latest.current.onClose();
      } else if (event.key === "Tab") {
        holdFocus(event, dialog.current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const target = latest.current.returnFocus?.() ?? (opener?.isConnected === true ? opener : null);
      target?.focus();
    };
  }, [dialog, initialFocus]);
}

/** Tab on the dialog's last control goes to its first, Shift+Tab on the first to the last; from outside, back in. */
function holdFocus(event: KeyboardEvent, root: HTMLElement | null): void {
  if (root === null) return;
  const controls = Array.from(root.querySelectorAll<HTMLElement>(TABBABLE));
  const first = controls[0];
  const last = controls.at(-1);
  const active = document.activeElement;
  const inside = active instanceof Node && root.contains(active);
  if (first === undefined || last === undefined) {
    event.preventDefault();
    root.focus();
    return;
  }
  if (!inside) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && (active === first || active === root)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}
