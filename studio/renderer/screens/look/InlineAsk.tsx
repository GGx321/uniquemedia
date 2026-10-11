import { type KeyboardEvent, type RefObject, useEffect, useRef, useState } from "react";
import { Spin } from "../../ui/Icon";

// S5.3d: the question a paid portrait's removal asks first, in place, without a modal (controller decision 5, review M3; mockups 16f and 21b): the app's
// own «Удалить аватар» confirm (`.avatar-confirm`, `.btn-d`). Opening it moves the focus to «Отмена»; closing it gives the focus back to its button.

export interface InlineAsk {
  readonly open: boolean;
  /** The button that opens it: the focus comes back here when it is closed. */
  readonly trigger: RefObject<HTMLButtonElement | null>;
  ask(): void;
  /** Closes it; `refocus` false when what it asked was done and its button is gone too. */
  close(refocus?: boolean): void;
}

export function useInlineAsk(): InlineAsk {
  const [open, setOpen] = useState(false);
  const [back, setBack] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!back) return;
    trigger.current?.focus();
    setBack(false);
  }, [back]);
  return {
    open,
    trigger,
    ask() {
      setOpen(true);
    },
    close(refocus = true) {
      setOpen(false);
      if (refocus) setBack(true);
    },
  };
}

export function InlineAskBox({
  ask,
  question,
  confirm,
  busyLabel,
  busy,
  onConfirm,
}: {
  ask: InlineAsk;
  question: string;
  /** The destructive button's word: «Удалить», «Вернуть». */
  confirm: string;
  busyLabel: string;
  busy: boolean;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape" || busy) return;
    event.preventDefault();
    ask.close();
  };
  return (
    <div className="avatar-confirm revert-confirm" role="alert" tabIndex={-1} onKeyDown={onKeyDown}>
      <span>{question}</span>
      <div className="draft-actions">
        <button type="button" className="btn btn-s btn-d" aria-busy={busy} disabled={busy} onClick={onConfirm}>
          {busy ? (
            <>
              <Spin />
              {busyLabel}
            </>
          ) : (
            confirm
          )}
        </button>
        <button ref={cancelRef} type="button" className="btn btn-s" disabled={busy} onClick={() => ask.close()}>
          Отмена
        </button>
      </div>
    </div>
  );
}
