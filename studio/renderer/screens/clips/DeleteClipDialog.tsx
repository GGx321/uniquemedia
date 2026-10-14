import { useId, useRef } from "react";
import { createPortal } from "react-dom";
import { FocusEdge } from "../../ui/FocusEdge";
import { Icon, Spin } from "../../ui/Icon";
import { useModalDialog } from "../../ui/useModalDialog";

// Stage 5, 5b.1, S5.V8: «Удалить клип?» (mockup 44; README §S5.VD decisions 3 and 4), asked for a ready clip only. Its text follows whether a copy is in «Готовые видео»: the copy stays
// (I5.55), and the money is spent either way. The focus opens on «Отмена», Escape cancels, and the focus goes back to «Удалить» in the viewer.

export const DELETE_SAVED_TEXT = "Файл клипа удалится из Studio. Копия в «Готовые видео» останется. Деньги за него уже потрачены.";
export const DELETE_UNSAVED_TEXT = "Файл клипа удалится из Studio. Копии в «Готовые видео» нет — если клип нужен, сначала сохраните его в папку. Деньги за него уже потрачены.";

export function DeleteClipDialog({ saved, busy, onCancel, onDelete }: { saved: boolean; busy: boolean; onCancel: () => void; onDelete: () => void }) {
  const ids = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useModalDialog({
    dialog: dialogRef,
    initialFocus: cancelRef,
    onClose: () => {
      if (!busy) onCancel();
    },
  });
  return createPortal(
    <div className="cat-scrim cat-scrim-center clip-sheet-scrim" role="presentation">
      <section ref={dialogRef} className="cat-dlg ap-del" role="alertdialog" aria-modal="true" aria-labelledby={`${ids}-title`} aria-describedby={`${ids}-lead`} tabIndex={-1}>
        <FocusEdge edge="start" />
        <div className="ap-del-body">
          <div className="ap-del-head">
            <h2 id={`${ids}-title`} className="cat-dlg-title">
              Удалить клип?
            </h2>
          </div>
          <p id={`${ids}-lead`} className="ap-del-lead">
            {saved ? DELETE_SAVED_TEXT : DELETE_UNSAVED_TEXT}
          </p>
        </div>
        <footer className="ap-del-foot">
          <button type="button" className="btn btn-s btn-d" aria-busy={busy || undefined} aria-disabled={busy || undefined} onClick={() => !busy && onDelete()}>
            {busy ? <Spin /> : <Icon name="trash" size={13} />}
            Удалить
          </button>
          <button ref={cancelRef} type="button" className="btn btn-s" disabled={busy} onClick={onCancel}>
            Отмена
          </button>
        </footer>
        <FocusEdge edge="end" />
      </section>
    </div>,
    document.body,
  );
}
