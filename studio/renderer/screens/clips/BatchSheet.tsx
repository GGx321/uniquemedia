import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PRICE_SCOPES_RU, type ClipBatchOptions, type ClipMotionId, type ClipQuality, type ClipReason, type ClipSeconds, type EngineError, type PhotoSummary } from "../../../shared/engine";
import { useEngine, useEngineView } from "../../engine/react";
import { errorText } from "../../lib/errors";
import { nbDash } from "../../lib/format";
import { useNavigate } from "../../navigation";
import { FocusEdge } from "../../ui/FocusEdge";
import { Icon, Spin } from "../../ui/Icon";
import { Notice } from "../../ui/Notice";
import { Portrait } from "../../ui/Portrait";
import { useModalDialog } from "../../ui/useModalDialog";
import { useMounted } from "../photos/shared";
import { animateBlock } from "./animate";
import { batchRowNote, batchSheetView, itemRefusal, itemRefusedAlert, type BatchSheetView } from "./batchModel";
import { upUsd } from "./clipModel";
import { AUTO_NOTE, LENGTHS, NO_FALLBACK_NOTE, PRO_NOTE, QUALITIES } from "./ClipSheet";

// 5b.2, S5.WB4: the sheet «Оживить N фото» (mockups 59, 59a, 59b, 59c and #item-refused, #after-click; plan s5b2 §5.2.1; README §S5.WBD decisions 4–6, 13–14). Nothing is paid without it: the picked photos
// in turn order, each with its motion (the engine's list for that photo), the options for the whole batch, and the engine's sums (`clips.batchOptions`, free). «Оживить N» sends exactly the engine's worst for the
// option on show as the accepted worst — the SUM of the members' worst cases (I5.62). A refusal after the click is said ONCE, as an alert, and the focus goes to «Отмена» so Enter never confirms a new sum:
// PRICE_CHANGED and BUDGET_EXCEEDED ask the engine again; a refused item (VALIDATION at `["items", i]`) is struck with its own reason and the sum is asked again without it.

const QUEUE_NOTE = "Клипы снимаются по очереди и появятся во вкладке «Клипы».";

/** One picked photo as the gallery knows it: «Фото 7 · Дом», and its summary when a page read holds it. */
export interface BatchPick {
  readonly photoId: string;
  readonly label: string;
  readonly photo: PhotoSummary | null;
}

export interface BatchSheetProps {
  readonly avatarId: string;
  /** The photos picked «для клипов», in the order picked: the batch's turn order. */
  readonly picks: readonly BatchPick[];
  readonly onClose: () => void;
  /** The engine took the batch: its id and its member jobs, in turn order. */
  readonly onStarted: (batchId: string, jobIds: readonly string[]) => void;
  readonly returnFocus?: () => HTMLElement | null;
}

type Options =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly options: ClipBatchOptions; readonly asked: string; readonly refreshing: boolean }
  | { readonly status: "failed"; readonly error: EngineError };

/** What the last click was answered, said once as an alert until the choice changes. */
type After = { readonly kind: "price"; readonly way: "main" | "alone" } | { readonly kind: "budget"; readonly way: "main" | "alone" } | { readonly kind: "item"; readonly text: string };

export function BatchSheet({ avatarId, picks, onClose, onStarted, returnFocus }: BatchSheetProps) {
  const { client, store } = useEngine();
  const view = useEngineView();
  const navigate = useNavigate();
  const mounted = useMounted();
  const ids = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useModalDialog({ dialog: dialogRef, initialFocus: closeRef, onClose, returnFocus });

  /** Rows the engine refused after a click, with their own reason: struck, and left out of the next ask. */
  const [refused, setRefused] = useState<ReadonlyMap<string, ClipReason>>(new Map());
  const asked = picks.map((p) => p.photoId).filter((photoId) => !refused.has(photoId));
  const askedKey = asked.join(",");
  const [again, setAgain] = useState(0);
  const [options, setOptions] = useState<Options>({ status: "loading" });
  const [motions, setMotions] = useState<ReadonlyMap<string, ClipMotionId>>(new Map());
  const [quality, setQuality] = useState<ClipQuality>("std");
  const [seconds, setSeconds] = useState<ClipSeconds>(5);
  const sending = useRef(false);
  const [busy, setBusy] = useState<"main" | "alone" | null>(null);
  const [after, setAfter] = useState<After | null>(null);
  const [error, setError] = useState<EngineError | null>(null);
  /** The focus goes to «Отмена» once the answer that needs a new click is on show. */
  const [toCancel, setToCancel] = useState(0);

  useEffect(() => {
    if (askedKey === "") return;
    let alive = true;
    setOptions((now) => (now.status === "ready" ? { ...now, refreshing: true } : { status: "loading" }));
    void client.request("clips.batchOptions", { avatarId, photoIds: askedKey.split(",") }).then((reply) => {
      if (!alive) return;
      setOptions(reply.ok ? { status: "ready", options: reply.result, asked: askedKey, refreshing: false } : { status: "failed", error: reply.error });
    });
    return () => {
      alive = false;
    };
  }, [client, avatarId, askedKey, again]);

  useEffect(() => {
    if (toCancel > 0) cancelRef.current?.focus();
  }, [toCancel]);

  const ready = options.status === "ready" ? options : null;
  const refreshing = ready?.refreshing === true;
  // Every row refused after the click: there is nothing left to ask the engine about, nor to send.
  const sheet: BatchSheetView | null = askedKey === "" || ready === null || ready.options.items.every((item) => !item.suitable) ? null : batchSheetView(ready.options, { quality, seconds });
  const unpriced = options.status === "failed" && options.error.code === "PRICE_UNAVAILABLE" && options.error.priceScope === "video";
  const block = animateBlock(view, view.avatars.find((a) => a.avatarId === avatarId)?.status !== "archived");
  const blockText = block === null ? null : block.kind === "nokey" ? "Нужен ключ OpenRouter — добавьте его в Настройках." : block.text;
  const waiting = options.status === "loading" || refreshing || busy !== null || blockText !== null;
  const itemOf = (photoId: string) => ready?.options.items.find((item) => item.photoId === photoId);
  const motionOf = (photoId: string): ClipMotionId | null => {
    const item = itemOf(photoId);
    if (item === undefined || !item.suitable) return null;
    const chosen = motions.get(photoId);
    return item.motions.find((m) => m.id === chosen)?.id ?? item.motions[0]?.id ?? null;
  };

  /** A change of the choice ends what was said about the last click. */
  const choose = (change: () => void): void => {
    change();
    setAfter(null);
    setError(null);
  };

  async function send(way: "main" | "alone"): Promise<void> {
    if (sending.current || sheet === null || ready === null || waiting) return;
    const button = way === "main" ? (sheet.fits ? sheet.main : null) : sheet.noFallback;
    if (button === null) return;
    const items = ready.options.items.flatMap((item) => {
      const motionId = item.suitable ? motionOf(item.photoId) : null;
      return motionId === null ? [] : [{ photoId: item.photoId, motionId }];
    });
    if (items.length === 0) return;
    sending.current = true;
    setBusy(way);
    setAfter(null);
    setError(null);
    store.setPaidInFlight(avatarId, true);
    const reply = await client.request("clips.createBatch", { avatarId, items, quality, seconds, fallback: way === "main" ? "auto" : "none", acceptedWorstMicros: button.worstMicros });
    store.setPaidInFlight(avatarId, false);
    sending.current = false;
    if (reply.ok) {
      onStarted(reply.result.batchId, reply.result.jobIds);
      return;
    }
    if (!mounted.current) return;
    setBusy(null);
    const code = reply.error.code;
    const item = itemRefusal(
      reply.error,
      items.map((i) => i.photoId),
    );
    if (code === "PRICE_CHANGED" || code === "BUDGET_EXCEEDED") {
      // 59a, 59b #after-click: the engine's figures are asked again (the remaining room, the Kling-only sum, L12) and need a new click.
      setAfter({ kind: code === "PRICE_CHANGED" ? "price" : "budget", way });
      setOptions((now) => (now.status === "ready" ? { ...now, refreshing: true } : now));
      setAgain((n) => n + 1);
    } else if (item !== null) {
      // 59 #item-refused: the row is struck with its OWN reason, and the sum is asked again without it.
      const label = picks.find((p) => p.photoId === item.photoId)?.label ?? "Фото";
      setRefused((now) => new Map(now).set(item.photoId, item.reason));
      setAfter({ kind: "item", text: itemRefusedAlert(label, item.reason) });
    } else {
      setError(reply.error);
      return;
    }
    setToCancel((n) => n + 1);
  }

  const whyId = `${ids}-why`;
  const budgetId = `${ids}-budget`;
  const title = `Оживить ${picks.length} фото`;
  const shownAfter = after !== null && !refreshing && options.status === "ready" ? after : null;
  // The month's notice: a status when `monthFits` says it at open, an alert when `tryHold` said it after the click (59b #after-click).
  const budgetAlert = shownAfter?.kind === "budget";
  const budgetShown = sheet !== null && (sheet.budgetNeed !== null || budgetAlert);
  const budgetNeed = sheet === null ? "" : shownAfter?.kind === "budget" && shownAfter.way === "alone" && sheet.noFallback !== null ? upUsd(sheet.noFallback.worstMicros) : upUsd(sheet.main.worstMicros);
  const mainOff = sheet === null || !sheet.fits || waiting || sheet.count === 0;

  const rows = (
    <ul className="batch-rows" aria-label="Фото пакета">
      {picks.map((pick) => {
        const item = itemOf(pick.photoId);
        const bare = unpriced || (options.status !== "ready" && !refused.has(pick.photoId));
        const note = bare ? null : batchRowNote(pick.photo, item, refused.get(pick.photoId));
        const struck = note?.struck === true;
        const motionId = struck || bare ? null : motionOf(pick.photoId);
        const choices = item?.suitable === true ? item.motions : [];
        return (
          <li key={pick.photoId} className={struck ? "batch-row batch-row-off" : bare || motionId === null ? "batch-row batch-row-bare" : "batch-row"}>
            <span className="ph batch-thumb" aria-hidden="true">
              <Portrait avatarId={avatarId} photoId={pick.photoId} label={pick.label} />
            </span>
            <span className="batch-what">
              <span className="batch-label">{pick.label}</span>
              {note !== null && <span className={note.bold ? "batch-note batch-note-bold" : "batch-note"}>{note.text}</span>}
            </span>
            {motionId !== null && (
              <select
                className="row-select batch-motion"
                aria-label={`Движение · ${pick.label}`}
                value={motionId}
                onChange={(event) => {
                  const next = choices.find((m) => m.id === event.target.value)?.id;
                  if (next !== undefined) choose(() => setMotions((now) => new Map(now).set(pick.photoId, next)));
                }}
              >
                {choices.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            )}
          </li>
        );
      })}
    </ul>
  );

  return createPortal(
    <div className="cat-scrim cat-scrim-center clip-sheet-scrim" role="presentation">
      <section
        ref={dialogRef}
        className="cat-dlg clip-sheet batch-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${ids}-title`}
        aria-describedby={unpriced ? whyId : undefined}
        aria-busy={options.status === "loading" || undefined}
        tabIndex={-1}
      >
        <FocusEdge edge="start" />
        <header className="cat-dlg-head clip-sheet-head">
          <div className="cat-dlg-titles">
            <h2 id={`${ids}-title`} className="cat-dlg-title" tabIndex={-1}>
              {title}
            </h2>
          </div>
          <button ref={closeRef} type="button" className="ibtn" aria-label="Закрыть" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </header>

        <div className="cat-dlg-body batch-sheet-body">
          {rows}
          {options.status === "failed" ? (
            <div className="batch-unpriced" id={whyId}>
              {unpriced ? (
                <Notice tone="warn" role="status">
                  {nbDash(PRICE_SCOPES_RU.video)}
                </Notice>
              ) : (
                <Notice
                  tone="danger"
                  actions={
                    <button type="button" className="btn btn-s" onClick={() => setAgain((n) => n + 1)}>
                      Повторить
                    </button>
                  }
                >
                  {errorText(options.error)}
                </Notice>
              )}
            </div>
          ) : (
            <div className="clip-rows batch-opts">
              <div className="clip-row" role="radiogroup" aria-labelledby={`${ids}-q`}>
                <span id={`${ids}-q`} className="lbl">
                  Качество
                </span>
                <div className="choice-options seg seg-l clip-seg">
                  {QUALITIES.map(([value, label]) => (
                    <label key={value} className="choice-option">
                      <input type="radio" className="choice-input" name={`${ids}-q-choice`} value={value} checked={quality === value} onChange={() => choose(() => setQuality(value))} />
                      <span className={quality === value ? "choice-face on" : "choice-face"}>{label}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="clip-row" role="radiogroup" aria-labelledby={`${ids}-s`}>
                <span id={`${ids}-s`} className="lbl">
                  Длина
                </span>
                <div className="choice-options seg seg-l clip-seg">
                  {LENGTHS.map(([value, label]) => (
                    <label key={value} className="choice-option">
                      <input type="radio" className="choice-input" name={`${ids}-s-choice`} value={value} checked={seconds === value} onChange={() => choose(() => setSeconds(value))} />
                      <span className={seconds === value ? "choice-face on" : "choice-face"}>{label}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="clip-row">
                <span className="lbl">Модель</span>
                <span className="clip-model">{quality === "pro" ? "Kling 3.0 · 1080p" : "Kling 3.0 · 720p"}</span>
                {sheet?.proNote === true && <p className="clip-note clip-note-quiet clip-row-note">{PRO_NOTE}</p>}
              </div>
            </div>
          )}
        </div>

        <footer className="clip-sheet-foot">
          {/* One live region at a time (README decision 13): the click's answer, else the month's notice, else the engine's error, else why paid work waits. */}
          {shownAfter !== null && shownAfter.kind === "price" && sheet !== null && (
            <Notice tone="warn" role="alert">
              Цена изменилась: теперь не больше <span className="mono">{shownAfter.way === "alone" && sheet.noFallback !== null ? upUsd(sheet.noFallback.worstMicros) : sheet.worst}</span>. Подтвердите ещё раз.
            </Notice>
          )}
          {shownAfter !== null && shownAfter.kind === "item" && (
            <Notice tone="warn" role="alert">
              {shownAfter.text}
            </Notice>
          )}
          {budgetShown && sheet !== null && (
            <div id={budgetId}>
              <Notice tone="warn" role={budgetAlert ? "alert" : "status"}>
                Не хватает месячного бюджета: пакету нужно до <span className="mono">{budgetNeed}</span>, осталось <span className="mono">{sheet.room}</span>. Уберите часть фото или поднимите бюджет в{" "}
                <button type="button" className="viewer-why-link" onClick={() => navigate({ name: "settings", focus: "money" })}>
                  Настройках
                </button>
                .
              </Notice>
            </div>
          )}
          {error !== null && <Notice tone="danger">{errorText(error)}</Notice>}
          {blockText !== null && ready !== null && (
            <Notice tone="warn" role="status">
              {nbDash(blockText)}
            </Notice>
          )}
          <div className="clip-price">
            <span className="lbl">Цена</span>
            {sheet === null ? (
              <span className="clip-price-line clip-price-none">—</span>
            ) : (
              <span className="clip-price-line">
                Обычно <span className="mono">{sheet.expected}</span> · не больше <span className="mono">{sheet.worst}</span>
              </span>
            )}
          </div>
          {sheet !== null && (
            <p className="batch-room">
              Осталось в месяце <span className="mono">{sheet.room}</span>
            </p>
          )}
          {sheet?.auto === true && <p className="clip-note">{nbDash(AUTO_NOTE)}</p>}
          {sheet !== null && <p className="clip-note clip-note-quiet">{QUEUE_NOTE}</p>}
          {sheet?.noFallback != null && <p className="clip-note">{NO_FALLBACK_NOTE}</p>}
          <div className="clip-sheet-btns">
            <button
              type="button"
              className="btn btn-p"
              aria-busy={busy === "main" || options.status === "loading" || undefined}
              aria-disabled={mainOff || undefined}
              aria-describedby={unpriced ? whyId : sheet !== null && !sheet.fits && budgetShown ? budgetId : undefined}
              onClick={() => void send("main")}
            >
              {(busy === "main" || options.status === "loading") && <Spin />}
              Оживить
              {sheet !== null && (
                <>
                  {" "}
                  {sheet.count} · <span className="mono">{sheet.main.label}</span>
                </>
              )}
            </button>
            {sheet?.noFallback != null && (
              <button type="button" className="btn" aria-busy={busy === "alone" || undefined} aria-disabled={waiting || undefined} onClick={() => void send("alone")}>
                {busy === "alone" && <Spin />}
                Оживить без запасной модели · <span className="mono">{sheet.noFallback.label}</span>
              </button>
            )}
            <button ref={cancelRef} type="button" className="btn" onClick={onClose}>
              Отмена
            </button>
          </div>
        </footer>
        <FocusEdge edge="end" />
      </section>
    </div>,
    document.body,
  );
}
