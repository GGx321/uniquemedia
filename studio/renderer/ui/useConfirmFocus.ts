import { type KeyboardEvent, type RefObject, useCallback, useEffect, useRef, useState } from "react";

// The keyboard's way through an inline confirmation (a delete asked on the card itself), as Settings' own confirmations work (the key's
// «Заменить», the trending list's «Обновить»; slice review 5-M4): opening it puts the focus on its safe answer («Отмена»), Escape cancels,
// and a cancel puts the focus back on the button that asked, so the next Tab goes on from there rather than from the top of the window.
// The focus moves after the screen shows the change (an effect), since the button it goes to may only just be mounted.

export interface ConfirmFocus {
  /** The confirmation's safe answer: «Отмена» (or «Понятно» when it only reports). */
  readonly cancelRef: RefObject<HTMLButtonElement | null>;
  /** The confirmation opened (or now shows something new to answer): the focus goes to `cancelRef`. */
  opened(): void;
  /** The confirmation closed without its action, or its action ended elsewhere: the focus goes to what `target` finds then. */
  moveTo(target: () => HTMLElement | null): void;
}

export function useConfirmFocus(): ConfirmFocus {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [next, setNext] = useState<{ readonly target: () => HTMLElement | null } | null>(null);
  useEffect(() => {
    if (next === null) return;
    next.target()?.focus();
    setNext(null);
  }, [next]);
  const opened = useCallback(() => setNext({ target: () => cancelRef.current }), []);
  const moveTo = useCallback((target: () => HTMLElement | null) => setNext({ target }), []);
  return { cancelRef, opened, moveTo };
}

/** Escape on a confirmation (anywhere in it) cancels it, unless its action is on its way. */
export function cancelOnEscape(event: KeyboardEvent<HTMLElement>, cancel: () => void, busy = false): void {
  if (event.key !== "Escape" || busy) return;
  event.preventDefault();
  event.stopPropagation();
  cancel();
}
