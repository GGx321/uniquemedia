import { type KeyboardEvent, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FocusEdge } from "../../ui/FocusEdge";
import { Spin } from "../../ui/Icon";
import { useModalDialog } from "../../ui/useModalDialog";
import { deleteButtonText, deleteDialogText, type DeleteChoice } from "./deleteVideo";

// S4.9c: «Удалить видео» with two ways (README decision 11; ApDeletePublished, LaunchStates «Удалить видео») — «Удалить видео и отклонить фото» or «Только
// удалить видео». Q4 = A (plan §17, pending the owner): a published video starts on «и отклонить фото», any other on the plain delete, as today; the other way
// is one key away. An alertdialog whose choice is a radiogroup: the focus is on the chosen way, ↑ ↓ change it and the button's words follow, Escape and
// «Отмена» cancel with the focus back on the trash (the design's keyboard table). The delete is the button's alone, reached by Tab: Enter on a way does nothing.

export interface DeleteVideoDialogProps {
  /** «видео 3 · Mia», «видео «утро дома»»: what the title names. */
  readonly label: string;
  readonly published: boolean;
  /**
   * The avatar's «Опубликовано» marks could not be read (fix round 1): the video shows unmarked, so the dialog cannot start on «и отклонить фото» for it
   * (Q4) and says why, for the owner to choose.
   */
  readonly marksUnknown?: boolean;
  /** The photos the video holds: what each way does to them. */
  readonly photos: number;
  /** The delete is on its way: the buttons wait. */
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onDelete: (choice: DeleteChoice) => void;
  /** Where the focus goes when the dialog closes: the trash that asked when nothing was deleted; the screen's choice after a delete was sent. */
  readonly returnFocus: (deleted: boolean) => HTMLElement | null;
}

const CHOICES: readonly DeleteChoice[] = ["reject", "plain"];

/** Said when the marks cannot be read: the plain delete is chosen, and an owner who did publish the video picks the other way himself. */
export const MARKS_UNKNOWN = "Отметка «Опубликовано» не читается: если видео уже опубликовано, выберите «Удалить видео и отклонить фото».";

export function DeleteVideoDialog({ label, published, marksUnknown = false, photos, busy, onCancel, onDelete, returnFocus }: DeleteVideoDialogProps) {
  const ids = useId();
  const text = deleteDialogText(label, published, photos);
  const [choice, setChoice] = useState<DeleteChoice>(text.preselect);
  const dialogRef = useRef<HTMLElement>(null);
  const optionRefs = useRef<Record<DeleteChoice, HTMLButtonElement | null>>({ reject: null, plain: null });
  const firstFocus = useRef<HTMLButtonElement | null>(null);
  const deleting = useRef(false);
  useModalDialog({
    dialog: dialogRef,
    initialFocus: firstFocus,
    onClose: () => {
      if (!busy) onCancel();
    },
    returnFocus: () => returnFocus(deleting.current),
  });

  const go = (): void => {
    if (busy) return;
    deleting.current = true;
    onDelete(choice);
  };
  const pick = (next: DeleteChoice): void => {
    setChoice(next);
    optionRefs.current[next]?.focus();
  };
  // ↑ ↓ (and ← →) move the choice; nothing else is the radio group's. Enter on a way never deletes (fix round 1): the Enter that opened the dialog from the
  // trash, held or pressed twice, lands here — so it only keeps the way chosen, and the delete is the button's, reached by Tab.
  const onOptionKey = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const at = CHOICES.indexOf(choice);
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      pick(CHOICES[(at + 1) % CHOICES.length] ?? choice);
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      pick(CHOICES[(at + CHOICES.length - 1) % CHOICES.length] ?? choice);
    } else if (event.key === "Enter") {
      // A radio is a button underneath: without this its Enter would click it, which only re-picks the same way, but keeps the key away from anything else.
      event.preventDefault();
    }
  };

  return createPortal(
    <div className="cat-scrim cat-scrim-center" role="presentation">
      <section ref={dialogRef} className="cat-dlg ap-del" role="alertdialog" aria-modal="true" aria-labelledby={`${ids}-title`} aria-describedby={`${ids}-lead`} tabIndex={-1}>
        <FocusEdge edge="start" />
        <div className="ap-del-body">
          <div className="ap-del-head">
            <h2 id={`${ids}-title`} className="cat-dlg-title">
              {text.title}
            </h2>
            {published && <span className="tag ap-st ap-st-ok">опубликовано</span>}
          </div>
          <p id={`${ids}-lead`} className="ap-del-lead">
            {text.lead}
            {marksUnknown && !published && <span className="ap-del-marks"> {MARKS_UNKNOWN}</span>}
          </p>
          <div role="radiogroup" aria-labelledby={`${ids}-title`} className="ap-del-opts">
            {CHOICES.map((way) => {
              const on = way === choice;
              const words = way === "reject" ? text.reject : text.plain;
              return (
                <button
                  key={way}
                  ref={(el) => {
                    optionRefs.current[way] = el;
                    if (way === text.preselect) firstFocus.current = el;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  tabIndex={on ? 0 : -1}
                  className={on ? "ap-opt ap-opt-on" : "ap-opt"}
                  onClick={() => setChoice(way)}
                  onKeyDown={onOptionKey}
                >
                  <span className="ap-radio" aria-hidden="true" />
                  <span className="ap-opt-text">
                    <b>{words.title}</b>
                    <span className="muted ap-opt-sub">{words.sub}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        <footer className="ap-del-foot">
          <button type="button" className="btn btn-s btn-d" aria-busy={busy || undefined} aria-disabled={busy || undefined} onClick={go}>
            {busy && <Spin />}
            {deleteButtonText(choice)}
          </button>
          <button type="button" className="btn btn-s" disabled={busy} onClick={onCancel}>
            Отмена
          </button>
        </footer>
        <FocusEdge edge="end" />
      </section>
    </div>,
    document.body,
  );
}
