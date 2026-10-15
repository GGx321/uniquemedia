import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import type { ClipUse } from "../../../shared/engine";
import { FocusEdge } from "../../ui/FocusEdge";
import { Icon, Spin } from "../../ui/Icon";
import { useModalDialog } from "../../ui/useModalDialog";
import { deleteUseLines, IN_RENDER_LINE } from "./clipUse";

// Stage 5, 5b.1, S5.V8: «Удалить клип?» (mockup 44; README §S5.VD decisions 3 and 4), asked for a ready clip only. Its text follows whether a copy is in «Готовые видео»: the copy stays
// (I5.55), and the money is spent either way. The focus opens on «Отмена», Escape cancels, and the focus goes back to «Удалить» in the viewer.
// 5b.2 (S5.WA4; mockup 44b, README §S5.WAD decision 9): under 44's text, what holds the clip (`ClipSummary.use`): a finished video that holds THIS clip (it will not change) and the
// drafts that hold its copy (their kadr will be marked), each part of the dialog's description. A render holding the copy is told only after «Удалить» is refused `in-use`: an alert,
// left out of the description; the focus goes to «Отмена», and «Удалить» stays, since a try after the render is harmless.

export const DELETE_SAVED_TEXT = "Файл клипа удалится из Studio. Копия в «Готовые видео» останется. Деньги за него уже потрачены.";
export const DELETE_UNSAVED_TEXT = "Файл клипа удалится из Studio. Копии в «Готовые видео» нет — если клип нужен, сначала сохраните его в папку. Деньги за него уже потрачены.";

export interface DeleteClipDialogProps {
  readonly saved: boolean;
  readonly busy: boolean;
  /** 5b.2: what uses the clip (44b's lines); absent for an unused clip. */
  readonly use?: ClipUse | undefined;
  /** 5b.2: how many times «Удалить» was refused `in-use` (a render holds the clip's copy); 0 while it was not. Each refusal is said again (S5.WAR L7). */
  readonly inRender?: number;
  readonly onCancel: () => void;
  readonly onDelete: () => void;
}

export function DeleteClipDialog({ saved, busy, use, inRender = 0, onCancel, onDelete }: DeleteClipDialogProps) {
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
  // 44b `#in-render`: the refusal came; the focus goes to «Отмена» (README M3) — again on a repeated refusal (S5.WAR L7).
  useEffect(() => {
    if (inRender > 0) cancelRef.current?.focus();
  }, [inRender]);
  const lines = deleteUseLines(use);
  const described = [`${ids}-lead`, ...(lines.video === null ? [] : [`${ids}-video`]), ...(lines.draft === null ? [] : [`${ids}-draft`])].join(" ");
  return createPortal(
    <div className="cat-scrim cat-scrim-center clip-sheet-scrim" role="presentation">
      <section ref={dialogRef} className="cat-dlg ap-del" role="alertdialog" aria-modal="true" aria-labelledby={`${ids}-title`} aria-describedby={described} tabIndex={-1}>
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
          {lines.video !== null && (
            <p id={`${ids}-video`} className="del-note">
              <Icon name="info" size={15} strokeWidth={2} />
              <span>{lines.video}</span>
            </p>
          )}
          {lines.draft !== null && (
            <p id={`${ids}-draft`} className="del-note del-note-warn">
              <Icon name="film" size={15} strokeWidth={2} />
              <span>{lines.draft}</span>
            </p>
          )}
          {inRender > 0 && (
            // A new alert per refusal (its key), so a repeated one is announced again (S5.WAR L7).
            <p key={inRender} className="del-note del-note-alert" role="alert">
              <Icon name="alert" size={15} strokeWidth={2} />
              <span>{IN_RENDER_LINE}</span>
            </p>
          )}
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
