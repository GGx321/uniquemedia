import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { CATEGORY_DESCRIPTION_MAX, CATEGORY_NAME_MAX } from "../../../shared/engine";
import { useCategoryLibrary, useEngineView } from "../../engine/react";
import { errorText } from "../../lib/errors";
import { formatUsdTiered } from "../../lib/money";
import { useNavigate } from "../../navigation";
import { FocusEdge } from "../../ui/FocusEdge";
import { Icon, Spin } from "../../ui/Icon";
import { useModalDialog } from "../../ui/useModalDialog";
import { busyElsewhere, categoryPrice, PoolPreview, priceRange, priceSource, useSeconds, worstOf } from "./categoryParts";
import { callFailure, createdTime, descriptionProblem, nameProblem } from "./categoryText";
import { paidBlockedReason } from "./runForm";

// CS.3: «Новая категория» (CatCreate, CatCreateBusy, CatCreateDone, CatCreateRejected, CatCreatePrice; the CategoryStates sheet's checks,
// errors and refusals). A name (only the owner sees it) and a description (any language, what the pool call is written from); the price
// of the pool call on the button, keyed to the text model it runs on; one click sends exactly that worst case. While the model composes,
// the form is locked and the dialog may be hidden («Скрыть», owner decision 1): the call is the window's (categoryLibrary.ts), so its answer
// lands whether the dialog is shown or not. Once made, the pool is shown read-only, and the category is already on in the run (owner
// decision 4). A portal over the window (useModalDialog): Escape closes it while nothing is sent, and hides it while the model works.

/** How the dialog opens: what its fields hold, and where the focus goes (the name for a new one; the description to change it). */
export interface CreateDialogStart {
  readonly name: string;
  readonly description: string;
  readonly focus: "name" | "description";
}

/** How the dialog closed: cancelled (nothing sent, or a failure seen), hidden while the model works, or done. */
export type CreateDialogClose = "cancel" | "hide" | "done";

export function CategoryCreateDialog({
  start,
  onClose,
  onOpenSheet,
  focusAfter,
}: {
  start: CreateDialogStart;
  onClose: (how: CreateDialogClose) => void;
  /** «Мои категории» from the limit's refusal: the dialog closes and the sheet opens. */
  onOpenSheet: () => void;
  /** Where the focus goes once the dialog is gone: the chip with the spinner after «Скрыть», the new chip after «Готово». */
  focusAfter: (how: CreateDialogClose, categoryId: string | null) => HTMLElement | null;
}) {
  const engine = useEngineView();
  const { library, view } = useCategoryLibrary();
  const navigate = useNavigate();
  const ids = useId();
  const titleId = `${ids}-title`;
  const nameId = `${ids}-name`;
  const descId = `${ids}-desc`;
  const hintId = `${ids}-hint`;
  const whyId = `${ids}-why`;

  const call = view.call?.kind === "create" ? view.call : null;
  const regenerating = view.call?.kind === "regenerate" ? view.call : null;
  const outcome = view.outcomes.create;
  const done = outcome?.ok === true ? outcome : null;
  const failure = outcome?.ok === false ? outcome : null;
  const list = view.list;
  const others = list.status === "ready" ? list.categories : [];

  const [name, setName] = useState(start.name);
  const [description, setDescription] = useState(start.description);
  const [touched, setTouched] = useState({ name: start.name.length > 0, description: start.description.length > 0 });

  // While a call is on its way, the fields show what was sent.
  const shownName = call?.name ?? name;
  const shownDescription = call?.description ?? description;
  const nameError = call === null ? nameProblem(name, others, touched.name) : null;
  const descError = call === null ? descriptionProblem(description, touched.description) : null;
  const valid = nameProblem(name, others, true) === null && descriptionProblem(description, true) === null;

  const { estimate, error: priceError } = categoryPrice(engine, view);
  const blocked = paidBlockedReason(engine);
  // PRICE_CHANGED: the refused worst case against the fresh one, which only a new click accepts.
  const priceChanged = failure !== null && failure.error.code === "PRICE_CHANGED" && estimate !== null ? { was: failure.previousWorstMicros ?? 0, now: estimate.worstMicros } : null;
  // One category call at a time (the engine's IN_FLIGHT): this window's own regeneration, another window's call, or a refusal that said so.
  const elsewhere = busyElsewhere(view);
  const waitingFor =
    call !== null || done !== null
      ? null
      : regenerating !== null
        ? regenerating.name
        : elsewhere !== null
          ? elsewhere
          : failure?.error.code === "IN_FLIGHT"
            ? ""
            : null;
  const canSend = call === null && regenerating === null && estimate !== null && valid && blocked === null && elsewhere === null;
  const seconds = useSeconds(call?.startedAt ?? null);

  const nameRef = useRef<HTMLInputElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);
  const hideRef = useRef<HTMLButtonElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closingAs = useRef<CreateDialogClose>("cancel");
  const createdId = done?.category.categoryId ?? null;
  // What takes the focus when the dialog opens: «Скрыть» while the model works, «Готово» once made, else the field it opened for.
  const initialFocus = useMemo<RefObject<HTMLElement | null>>(
    () => ({
      get current(): HTMLElement | null {
        return hideRef.current ?? doneRef.current ?? (start.focus === "description" ? descRef.current : nameRef.current);
      },
    }),
    [start.focus],
  );
  const close = (how: CreateDialogClose): void => {
    closingAs.current = how;
    onClose(how);
  };
  // Escape and × hide it while the model works (the call goes on); otherwise they cancel.
  const dismiss = (): void => close(call !== null ? "hide" : done !== null ? "done" : "cancel");
  useModalDialog({ dialog: dialogRef, initialFocus, onClose: dismiss, returnFocus: () => focusAfter(closingAs.current, createdId) });

  // The focus follows the call: to «Скрыть» once sent (the button it was on is busy now), then to «Готово», or to what went wrong.
  const wasBusy = useRef(call !== null);
  useEffect(() => {
    if (call !== null && !wasBusy.current) hideRef.current?.focus();
    if (call === null && wasBusy.current) (done !== null ? doneRef.current : noticeRef.current)?.focus();
    wasBusy.current = call !== null;
  }, [call, done]);

  const send = (): void => {
    if (!canSend || estimate === null) return;
    void library.create(name, description, estimate);
  };

  const failureText = failure !== null && failure.error.code !== "PRICE_CHANGED" && failure.error.code !== "IN_FLIGHT" ? callFailure(failure.error) : null;
  const textModel = engine.settings?.textModel ?? null;

  return createPortal(
    <div className="cat-scrim cat-scrim-center" role="presentation">
      <section ref={dialogRef} className="cat-dlg" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <FocusEdge edge="start" />
        <header className="cat-dlg-head">
          <div className="cat-dlg-titles">
            <div className="cat-dlg-title-row">
              <h2 id={titleId} className="cat-dlg-title">
                {done !== null ? done.category.name : "Новая категория"}
              </h2>
              {done !== null && <span className="tag cat-done-tag">готово</span>}
            </div>
            {done !== null ? (
              <p className="mono muted cat-dlg-meta">{createdTime(done.category, done.spentMicros)}</p>
            ) : (
              <p className="muted cat-dlg-sub">Общая для всех аватаров. Модель составит места, наряды и кадры по вашему описанию.</p>
            )}
          </div>
          <button type="button" className="ibtn" aria-label="Закрыть" onClick={dismiss}>
            <Icon name="close" size={14} strokeWidth={2.2} />
          </button>
        </header>

        <div className="cat-dlg-body">
          {done !== null ? (
            <PoolPreview pool={done.category.pool} />
          ) : (
            <>
              <fieldset className={call !== null ? "lock cat-form cat-form-busy" : "lock cat-form"} disabled={call !== null}>
                <legend className="sr-only">Новая категория</legend>
                <div className="field">
                  <div className="field-row">
                    <label className="fl" htmlFor={nameId}>
                      Название <span className="faint">· только для вас, в промпты не уходит</span>
                    </label>
                    <span className={shownName.trim().length > CATEGORY_NAME_MAX ? "mono danger-text" : "mono faint"}>
                      {shownName.length}/{CATEGORY_NAME_MAX}
                    </span>
                  </div>
                  <input
                    ref={nameRef}
                    id={nameId}
                    className="in"
                    type="text"
                    autoComplete="off"
                    disabled={call !== null}
                    value={shownName}
                    aria-invalid={nameError !== null}
                    aria-describedby={nameError !== null ? `${nameId}-error` : undefined}
                    onChange={(e) => {
                      setName(e.target.value);
                      setTouched((t) => ({ ...t, name: true }));
                    }}
                    onBlur={() => setTouched((t) => ({ ...t, name: true }))}
                    onKeyDown={(e) => {
                      // Enter that ends an input method's composition belongs to the composition, not to a paid create.
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        send();
                      }
                    }}
                  />
                  {nameError !== null && (
                    <p id={`${nameId}-error`} className="field-error">
                      {nameError}
                    </p>
                  )}
                </div>
                <div className="field">
                  <div className="field-row">
                    <label className="fl" htmlFor={descId}>
                      Описание <span className="faint">· на любом языке</span>
                    </label>
                    <span className={shownDescription.length > CATEGORY_DESCRIPTION_MAX ? "mono danger-text" : "mono faint"}>
                      {shownDescription.length}/{CATEGORY_DESCRIPTION_MAX}
                    </span>
                  </div>
                  <textarea
                    ref={descRef}
                    id={descId}
                    className="in cat-ta"
                    rows={5}
                    disabled={call !== null}
                    value={shownDescription}
                    aria-invalid={descError !== null}
                    aria-describedby={descError !== null ? `${descId}-error ${hintId}` : hintId}
                    onChange={(e) => {
                      setDescription(e.target.value);
                      setTouched((t) => ({ ...t, description: true }));
                    }}
                    onBlur={() => setTouched((t) => ({ ...t, description: true }))}
                  />
                  {descError !== null && (
                    <p id={`${descId}-error`} className="field-error">
                      {descError}
                    </p>
                  )}
                  <p id={hintId} className="field-hint">
                    Где она бывает, что там делает, во что одета. Модель составит 5–7 мест, 3–6 нарядов и набор кадров. Наряды — только неоткровенные, как во всех категориях.
                  </p>
                </div>
              </fieldset>

              {call !== null && (
                <div className="job-progress cat-progress" role="status">
                  <span className="spin cat-progress-spin" aria-hidden="true" />
                  <div className="notice-body">
                    <p className="job-progress-label cat-progress-label">Составляем места, наряды и кадры · {seconds} с</p>
                    <div className="notice-text">Обычно 10–20 с. Окно можно скрыть: категория появится в ряду сама, когда будет готова.</div>
                  </div>
                </div>
              )}

              {waitingFor !== null && (
                <div ref={failure?.error.code === "IN_FLIGHT" ? noticeRef : undefined} className="notice notice-info" role="status" tabIndex={-1}>
                  <span className="notice-icon">
                    <Icon name="info" size={16} />
                  </span>
                  <div className="notice-body">
                    <div className="notice-text">
                      {waitingFor === "" ? "Сейчас составляется другая категория." : `Сейчас составляется «${waitingFor}».`} По одной категории за раз — дождитесь её, потом
                      создайте эту.
                    </div>
                  </div>
                </div>
              )}

              {failureText !== null && (
                <div ref={noticeRef} className="notice notice-danger" role="alert" tabIndex={-1}>
                  <span className="notice-icon">
                    <Icon name="alert" size={16} />
                  </span>
                  <div className="notice-body">
                    <div className="notice-text">{failureText.text}</div>
                    {failureText.code !== null && <p className="mono faint cat-code">{failureText.code}</p>}
                    {failureText.action !== undefined && (
                      <div className="notice-actions">
                        {failureText.action === "sheet" ? (
                          <button type="button" className="btn btn-s" onClick={onOpenSheet}>
                            Мои категории
                          </button>
                        ) : (
                          <button type="button" className="btn btn-s" onClick={() => navigate({ name: "settings" })}>
                            Открыть Настройки
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {priceChanged !== null && (
                <div ref={noticeRef} className="notice notice-warn" role="alert" tabIndex={-1}>
                  <span className="notice-icon">
                    <Icon name="alert" size={16} />
                  </span>
                  <div className="notice-body">
                    <p className="notice-title">{priceChanged.now > priceChanged.was ? "Цена выросла" : "Цена изменилась"}</p>
                    <div className="notice-text">
                      Было не больше <span className="mono">{formatUsdTiered(priceChanged.was, "up")}</span>, теперь не больше{" "}
                      <span className="mono">{formatUsdTiered(priceChanged.now, "up")}</span>. Проверьте новую оценку и подтвердите снова — без подтверждения ничего не
                      отправляется.
                    </div>
                  </div>
                </div>
              )}

              <div className={call !== null ? "cat-cost cat-cost-busy" : "cat-cost"}>
                <div className="mono cat-cost-row">
                  <span className="muted">Стоимость</span>
                  <span>{estimate !== null ? priceRange(estimate) : call !== null ? `до ${formatUsdTiered(call.acceptedWorstMicros, "up")}` : "—"}</span>
                </div>
                {estimate !== null && textModel !== null ? (
                  <span className="mono faint cat-cost-source">{priceSource(estimate, textModel)}</span>
                ) : priceError !== null ? (
                  <span className="cat-cost-error">
                    <span className="danger-text">Цену не узнать: {errorText(priceError)}</span>
                    <button type="button" className="link-btn" onClick={() => library.refreshPrice()}>
                      Повторить
                    </button>
                  </span>
                ) : null}
              </div>
            </>
          )}
        </div>

        <footer className="cat-dlg-foot">
          <span id={whyId} className="faint cat-dlg-foot-note">
            {done !== null ? "Категория уже включена в запуск. Убрать место или наряд — в «Мои категории»." : call === null && blocked !== null ? blocked : ""}
          </span>
          {done !== null ? (
            <button ref={doneRef} type="button" className="btn btn-p btn-s" onClick={() => close("done")}>
              Готово
            </button>
          ) : (
            <>
              {call !== null ? (
                <button ref={hideRef} type="button" className="btn btn-s" onClick={() => close("hide")}>
                  Скрыть
                </button>
              ) : (
                <button type="button" className="btn btn-s" onClick={() => close("cancel")}>
                  Отмена
                </button>
              )}
              <button
                type="button"
                className="btn btn-p btn-s"
                disabled={!canSend}
                aria-busy={call !== null}
                aria-describedby={call === null && blocked !== null ? whyId : undefined}
                onClick={send}
              >
                {call !== null && <Spin />}
                {call !== null ? "Создаём…" : priceChanged !== null ? "Подтвердить новую цену" : "Создать"} ·{" "}
                {call !== null ? `до ${formatUsdTiered(call.acceptedWorstMicros, "up")}` : worstOf(estimate)}
              </button>
            </>
          )}
        </footer>
        <FocusEdge edge="end" />
      </section>
    </div>,
    document.body,
  );
}
