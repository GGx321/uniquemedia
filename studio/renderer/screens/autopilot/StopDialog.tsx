import { useId, useRef } from "react";
import { createPortal } from "react-dom";
import type { LaunchView } from "../../../shared/engine";
import { FocusEdge } from "../../ui/FocusEdge";
import { useModalDialog } from "../../ui/useModalDialog";
import { stopTexts } from "./planModel";

// S4.9a: «Остановить запуск?» in its short form (ApStopConfirm; the design's decision 9: «Стоп» asks, «Пауза» does not). It says that nothing new starts and
// nothing in flight is cut off, what stays (the finished videos, the new photos) and what was spent; the per-set lines come with the live card (S4.9b).
// An alertdialog: the destructive «Остановить» first, the focus on «Отмена»; Escape cancels and the focus goes back to «Стоп» (the design's keyboard table).

export interface StopDialogProps {
  readonly launch: LaunchView;
  /** Closed without stopping: the focus goes back to «Стоп». */
  readonly onCancel: () => void;
  /** «Остановить» clicked: the row sends the stop and takes the focus. */
  readonly onStop: () => void;
  /** Where the focus goes when the dialog closes, by how it closed. */
  readonly returnFocus: (stopped: boolean) => HTMLElement | null;
}

export function StopDialog({ launch, onCancel, onStop, returnFocus }: StopDialogProps) {
  const titleId = useId();
  const textId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const stopped = useRef(false);
  useModalDialog({ dialog: dialogRef, initialFocus: cancelRef, onClose: onCancel, returnFocus: () => returnFocus(stopped.current) });
  const texts = stopTexts(launch);

  return createPortal(
    <div className="cat-scrim cat-scrim-center" role="presentation">
      <section ref={dialogRef} className="cat-dlg ap-stop" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={textId} tabIndex={-1}>
        <FocusEdge edge="start" />
        <div className="ap-stop-body">
          <h2 id={titleId} className="cat-dlg-title">
            Остановить запуск?
          </h2>
          <div id={textId} className="ap-stop-text">
            <p>{texts.lead}</p>
            <div className="ap-stop-stays">
              <span className="lbl">Останется</span>
              <ul>
                {texts.stays.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
            {texts.spent !== null && <p>{texts.spent}</p>}
          </div>
        </div>
        <footer className="ap-stop-foot">
          <button
            type="button"
            className="btn btn-s btn-d"
            onClick={() => {
              stopped.current = true;
              onStop();
            }}
          >
            Остановить
          </button>
          <button ref={cancelRef} type="button" className="btn btn-s" onClick={onCancel}>
            Отмена
          </button>
        </footer>
        <FocusEdge edge="end" />
      </section>
    </div>,
    document.body,
  );
}
