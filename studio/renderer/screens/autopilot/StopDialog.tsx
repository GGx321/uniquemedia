import { useId, useRef } from "react";
import { createPortal } from "react-dom";
import type { LaunchView } from "../../../shared/engine";
import { FocusEdge } from "../../ui/FocusEdge";
import { useModalDialog } from "../../ui/useModalDialog";
import { stopSetLines } from "./liveModel";
import { stopTexts, type Words } from "./planModel";

// S4.9a/b: «Остановить запуск?» (ApStopConfirm; the design's decision 9: «Стоп» asks, «Пауза» does not). It says that nothing new starts and nothing in
// flight is cut off, what stays (the finished videos, the new photos), what becomes of each avatar's scene set by the phase it is in (LaunchStates «Наборы
// сцен», round 1 M2: from the view's `undrawnScenes` and `resumableSlots`), and what was spent. An alertdialog: the destructive «Остановить» first, the
// focus on «Отмена»; Escape cancels and the focus goes back to «Стоп» (the design's keyboard table).

export interface StopDialogProps {
  readonly launch: LaunchView;
  readonly nameOf: (avatarId: string) => string;
  /** Closed without stopping: the focus goes back to «Стоп». */
  readonly onCancel: () => void;
  /** «Остановить» clicked: the card sends the stop and takes the focus. */
  readonly onStop: () => void;
  /** Where the focus goes when the dialog closes, by how it closed. */
  readonly returnFocus: (stopped: boolean) => HTMLElement | null;
}

export function StopDialog({ launch, nameOf, onCancel, onStop, returnFocus }: StopDialogProps) {
  const titleId = useId();
  const textId = useId();
  const setsId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const stopped = useRef(false);
  useModalDialog({ dialog: dialogRef, initialFocus: cancelRef, onClose: onCancel, returnFocus: () => returnFocus(stopped.current) });
  const texts = stopTexts(launch);
  // S4.9b L4 (ApStopConfirm): the sets «Стоп» changes first, then the avatars it leaves as they are; the figures drawn mono.
  const sets = stopSetLines(launch, nameOf);

  return createPortal(
    <div className="cat-scrim cat-scrim-center" role="presentation">
      <section ref={dialogRef} className="cat-dlg ap-stop" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={textId} tabIndex={-1}>
        <FocusEdge edge="start" />
        <div className="ap-stop-body">
          <h2 id={titleId} className="cat-dlg-title">
            Остановить запуск?
          </h2>
          <div className="ap-stop-text">
            <p id={textId}>
              <WordsView words={texts.lead} />
            </p>
            <div className="ap-stop-stays">
              <span className="lbl">Останется</span>
              <ul>
                {texts.stays.map((line, i) => (
                  <li key={i}>
                    <WordsView words={line} />
                  </li>
                ))}
              </ul>
            </div>
            {sets.length > 0 && (
              <div className="ap-stop-sets">
                <span id={setsId} className="lbl">
                  Наборы сцен
                </span>
                <ul className="ap-stop-set-list" aria-labelledby={setsId}>
                  {sets.map((line) => (
                    <li key={line.avatarId} className="ap-stop-set">
                      <span className="ap-stop-set-who">
                        <b>{line.name}</b>
                        <span className="muted ap-stop-set-phase">{line.phase}</span>
                      </span>
                      <span className="ap-stop-set-what">{line.what}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {texts.spent !== null && (
              <p className="ap-stop-spent">
                <WordsView words={texts.spent} />
              </p>
            )}
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

/** A sentence of runs: the figures in the mono face, the words around them as they are. */
function WordsView({ words }: { words: Words }) {
  return (
    <>
      {words.map((run, i) =>
        typeof run === "string" ? (
          run
        ) : (
          <span key={i} className="mono">
            {run.mono}
          </span>
        ),
      )}
    </>
  );
}
