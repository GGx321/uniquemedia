import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PRICE_SCOPES_RU, type ClipMotionId, type ClipOptions, type ClipQuality, type ClipSeconds, type EngineError } from "../../../shared/engine";
import { useEngine, useEngineView } from "../../engine/react";
import { errorText } from "../../lib/errors";
import { useNavigate } from "../../navigation";
import { FocusEdge } from "../../ui/FocusEdge";
import { Icon, Spin } from "../../ui/Icon";
import { Notice } from "../../ui/Notice";
import { Portrait } from "../../ui/Portrait";
import { useModalDialog } from "../../ui/useModalDialog";
import { useMounted } from "../photos/shared";
import { animateBlock, batchHoldsUnit, clipSlotTaken } from "./animate";
import { upUsd } from "./clipModel";
import { frameNotesNews, MOTION_BUSY, motionGoneNews, motionRowLabel, showsEnglish, SUGGESTED_TAG } from "./motionModel";
import { FrameNotes, MotionActions, MotionGuard, MotionNews, MotionStatus, QuietNotice, useMotionCalls, type MotionBlock } from "./MotionSuggest";
import { OwnIdea } from "./OwnIdea";
import { sheetView, type SuitableOptions } from "./sheetModel";

// Stage 5, 5b.1, S5.V8: the sheet «Оживить фото» (mockups 38, 38b, 38c, 38e, 38f; plan s5b1 §6, §5.14 «Before money»). Nothing is paid without it: it shows the frame, the motion, the
// quality, the length, the model and the price line, and «Оживить» sends exactly the engine's worst for the option on show as the accepted worst (I5.46), once. PRICE_CHANGED asks the
// engine again and needs a new click (38b). The month's fit is the engine's (`monthFits`): when it holds Kling alone, «Оживить» waits beside «Оживить без запасной модели» (38c). A
// dialog over the photo viewer (or the «Клипы» tab), with its own focus and Escape; the viewer under it waits.
// 5b.2 part C (S5.WC5; mockups 62–63c): the «Движение» group grows the photo's stored suggestions («предложено») and own ideas («Своя идея: …»), each with its English muted (I5.67: seen before any video
// money), «Предложить движения» and «Своя идея…» under the list (MotionSuggest.tsx, OwnIdea.tsx), and the frame's notes under the frame. The group is the sheet's one scroll region and the sheet is a
// little denser than 38 (README §S5.WCD decision 5). While a part C call runs «Оживить» waits beside the guard; a click the engine refused `motion-busy` says so once, the focus on «Отмена» (62a #after-click).

// 5b.2 (S5.WB4): the batch sheet (59) says the same lines and offers the same options.
export const AUTO_NOTE = "Если Kling откажет бесплатно, клип снимет Grok — поэтому «не больше». Оплаченный отказ сам не переснимается.";
const BOLD_NOTE = "Для кадров «Смелой» запасной модели нет: если Kling откажет, клип не снимется — отказ бесплатный.";
const SOUND_NOTE = "Звука нет. Клип появится во вкладке «Клипы» через 1–3 минуты.";
export const PRO_NOTE = "Запасная модель (Grok) снимает в 720p";
export const NO_FALLBACK_NOTE = "Если Kling откажет, Grok снимать не будем";

export const QUALITIES: readonly [ClipQuality, string][] = [
  ["std", "Обычное · 720p"],
  ["pro", "Чётче · 1080p"],
];
export const LENGTHS: readonly [ClipSeconds, string][] = [
  [5, "5 секунд"],
  [10, "10 секунд"],
];

export interface ClipSheetProps {
  readonly avatarId: string;
  readonly photoId: string;
  /** «Фото 7 из 46 · Дом»: where the photo stands and its category; null when the window does not know. */
  readonly subtitle: string | null;
  /** The frame's accessible name. */
  readonly frameLabel: string;
  readonly onClose: () => void;
  /** The engine took the clip: its job, and what this window knows of it. */
  readonly onStarted: (jobId: string) => void;
  /** Where the focus goes when the sheet closes: the button that opened it; else what had the focus then. */
  readonly returnFocus?: () => HTMLElement | null;
}

/** `refreshing`: the engine is asked again (38b) and the options read before stay on show meanwhile — the buttons keep their place and the focus on them. */
/** `asked`: which ask of the engine the answer is for, so a row awaited after a call is looked for only in the list read after it. */
type Options =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly options: ClipOptions; readonly photoId: string; readonly refreshing: boolean; readonly asked: number }
  | { readonly status: "failed"; readonly error: EngineError; readonly asked: number };

export function ClipSheet({ avatarId, photoId, subtitle, frameLabel, onClose, onStarted, returnFocus }: ClipSheetProps) {
  const { client, store } = useEngine();
  const view = useEngineView();
  const navigate = useNavigate();
  const mounted = useMounted();
  const ids = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const suggestRef = useRef<HTMLButtonElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollInRef = useRef<HTMLDivElement>(null);
  useModalDialog({ dialog: dialogRef, initialFocus: closeRef, onClose, returnFocus });

  const [asked, setAsked] = useState(0);
  const [options, setOptions] = useState<Options>({ status: "loading" });
  const [motionId, setMotionId] = useState<ClipMotionId | null>(null);
  const [quality, setQuality] = useState<ClipQuality>("std");
  const [seconds, setSeconds] = useState<ClipSeconds>(5);
  /** The click on its way; a second one sends nothing. */
  const sending = useRef(false);
  const [busy, setBusy] = useState<"main" | "alone" | null>(null);
  /** 38b: the way whose price the engine refused as changed, until the choice changes. */
  const [priceChanged, setPriceChanged] = useState<"main" | "alone" | null>(null);
  const [error, setError] = useState<EngineError | null>(null);
  /** 62a #after-click: the engine refused the click `motion-busy` (a part C call this window did not know of); said once, until the next click or choice. */
  const [motionBusyAfter, setMotionBusyAfter] = useState(false);
  /**
   * 62b, 63a: a new row to focus — and select, an own idea — once the list read AFTER the call (`after`: the last ask before it) holds it; `last`, the last new row, is scrolled into view first.
   */
  const [pending, setPending] = useState<{ readonly id: ClipMotionId; readonly select: boolean; readonly last: ClipMotionId | null; readonly after: number } | null>(null);
  const [toCancel, setToCancel] = useState(0);
  const askedRef = useRef(asked);
  askedRef.current = asked;
  /** Round 2 (L1): the row the owner chose, as its title read, while the list holds it. */
  const chosen = useRef<{ readonly id: ClipMotionId; readonly title: string } | null>(null);

  useEffect(() => {
    let alive = true;
    setOptions((now) => (now.status === "ready" && now.photoId === photoId ? { ...now, refreshing: true } : { status: "loading" }));
    void client.request("clips.options", { avatarId, photoId }).then((reply) => {
      if (!alive) return;
      setOptions(reply.ok ? { status: "ready", options: reply.result, photoId, refreshing: false, asked } : { status: "failed", error: reply.error, asked });
    });
    return () => {
      alive = false;
    };
  }, [client, avatarId, photoId, asked]);

  const suitable: SuitableOptions | null = options.status === "ready" && options.options.suitable ? options.options : null;
  const motion = suitable === null ? null : (suitable.motions.find((m) => m.id === motionId) ?? suitable.motions[0] ?? null);
  const sheet = suitable === null || motion === null ? null : sheetView(suitable, { motionId: motion.id, quality, seconds });
  // An avatar the list no longer holds (a race with a delete) is left to the engine, which refuses it on its own.
  const block = animateBlock(view, view.avatars.find((a) => a.avatarId === avatarId)?.status !== "archived");
  const blockText = block === null ? null : block.kind === "nokey" ? "Нужен ключ OpenRouter — добавьте его в Настройках." : block.text;
  const refreshing = options.status === "ready" && options.refreshing;

  const calls = useMotionCalls({
    avatarId,
    photoId,
    view,
    offered: suitable !== null,
    relist: () => setAsked((n) => n + 1),
    reveal: (id, select, last) => setPending({ id, select, last: last ?? null, after: askedRef.current }),
    toCancel: () => setToCancel((n) => n + 1),
    toIdeaToggle: () => toggleRef.current?.focus(),
  });
  const waiting = options.status === "loading" || refreshing || busy !== null || blockText !== null || calls.anyRunning;

  // The new options are in: a button that had the focus and is gone or turned off (Chromium drops the focus of a control that turns disabled to the page) hands it to the main button, else
  // to the sheet's heading, so the next key is never typed into the page.
  useEffect(() => {
    if (refreshing || priceChanged === null) return;
    const root = dialogRef.current;
    if (root === null) return;
    const active = document.activeElement;
    const lost = !root.contains(active) || (active instanceof HTMLButtonElement && active.disabled);
    if (!lost) return;
    const main = mainRef.current;
    (main !== null && !main.disabled ? main : titleRef.current)?.focus();
  }, [refreshing, priceChanged, options]);

  /** Round 3 (R1): where the focus goes when what held it is gone — «Повторить» when the failure offers it, else «Отмена» (every state has it), else the heading. */
  const keepFocus = (): void => (retryRef.current ?? cancelRef.current ?? titleRef.current)?.focus();

  // Round 2 (L1): the row the owner chose left the list read again (only the newest suggestions and ideas are listed) — the first row is chosen, and the drop alone is said (round 3, R2:
  // the call's result line was said already), never a silent jump.
  const picked = motionId === null || suitable === null ? undefined : suitable.motions.find((m) => m.id === motionId);
  const dropGone = (): void => {
    if (suitable === null || motionId === null || picked !== undefined) return;
    const first = suitable.motions[0];
    const gone = chosen.current !== null && chosen.current.id === motionId ? chosen.current.title : null;
    setMotionId(null);
    if (gone !== null && first !== undefined) calls.announce("polite", motionGoneNews(gone, motionRowLabel(first)));
  };

  // 62b / 63a: the list read after the call is in — the row the call made is focused (and chosen, for his idea), the group brought down to the last new row first (62b). A row the list
  // does not hold (only the newest are listed) leaves the focus on «Своя идея…», and a list that could not be read on what the failure offers: never on the page (round 2, M2; round 3, R1).
  useEffect(() => {
    if (pending === null || options.status === "loading" || refreshing) return;
    if (options.asked <= pending.after) return;
    setPending(null);
    if (options.status === "failed") {
      keepFocus();
      return;
    }
    const inputOf = (id: ClipMotionId | null) => (id === null ? null : dialogRef.current?.querySelector<HTMLInputElement>(`input[name="${ids}-motion-choice"][value="${id}"]`));
    const input = inputOf(pending.id);
    if (input === null || input === undefined) {
      // Round 3 (R3): his new idea is not listed, so nothing replaces the choice the effect below left alone for it: a dropped choice is said here.
      if (pending.select) dropGone();
      (toggleRef.current ?? titleRef.current)?.focus();
      return;
    }
    if (pending.select) choose(() => setMotionId(pending.id));
    inputOf(pending.last)?.closest("label")?.scrollIntoView?.({ block: "nearest" });
    input.focus();
  }, [pending, options, refreshing]);

  useEffect(() => {
    if (suitable === null || refreshing) return;
    // His new idea is about to be chosen (63a, the effect above): what it replaces needs no word — unless it is not listed, which that effect says itself.
    if (pending?.select === true) return;
    dropGone();
  }, [suitable, refreshing]);

  // Round 3 (R1): the list read again failed, or the photo is no longer one to bring to life: the form is gone, and with it a focus it held — it goes to what the sheet offers now.
  const formGone = options.status === "failed" || (options.status === "ready" && !options.options.suitable);
  useEffect(() => {
    if (!formGone) return;
    const root = dialogRef.current;
    const active = document.activeElement;
    if (root !== null && (active === null || !active.isConnected || !root.contains(active))) keepFocus();
  }, [formGone, options]);
  useEffect(() => {
    if (picked !== undefined) chosen.current = { id: picked.id, title: motionRowLabel(picked) };
  }, [picked]);

  useEffect(() => {
    if (toCancel > 0) cancelRef.current?.focus();
  }, [toCancel]);

  // 62d: the frame's notes of an earlier suggestion are said once the sheet has read them (with a new suggestion they are said with its result).
  const notes = calls.reading ?? suitable?.reading?.notes ?? [];
  const notesSaid = useRef(false);
  useEffect(() => {
    if (notesSaid.current || suitable === null || refreshing) return;
    notesSaid.current = true;
    const said = frameNotesNews(suitable.reading?.notes ?? []);
    if (said !== null) calls.announce("polite", said);
  }, [suitable, refreshing]);

  // The group's edges fade where it goes on (README §S5.WCD decision 5): on a scroll, and when the group or what is in it changes size (round 2, L9).
  const hasGroup = suitable !== null;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!hasGroup || el === null) return;
    const edges = (): void => {
      el.classList.toggle("mc-less", el.scrollTop > 2);
      el.classList.toggle("mc-more", el.scrollTop + el.clientHeight < el.scrollHeight - 2);
    };
    edges();
    el.addEventListener("scroll", edges);
    const sizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(edges);
    sizes?.observe(el);
    if (scrollInRef.current !== null) sizes?.observe(scrollInRef.current);
    return () => {
      el.removeEventListener("scroll", edges);
      sizes?.disconnect();
    };
  }, [hasGroup]);

  /** A change of the choice ends what was said about the last price. */
  const choose = (change: () => void): void => {
    change();
    setPriceChanged(null);
    setError(null);
    setMotionBusyAfter(false);
  };

  async function send(way: "main" | "alone"): Promise<void> {
    if (sending.current || sheet === null || suitable === null || motion === null || waiting) return;
    const button = way === "main" ? (sheet.fits ? sheet.main : null) : sheet.noFallback;
    if (button === null) return;
    sending.current = true;
    setBusy(way);
    setError(null);
    setMotionBusyAfter(false);
    store.setPaidInFlight(avatarId, true);
    const reply = await client.request("clips.create", {
      avatarId,
      photoId,
      motionId: motion.id,
      model: "kling",
      quality,
      seconds,
      fallback: way === "main" ? "auto" : "none",
      acceptedWorstMicros: button.worstMicros,
    });
    store.setPaidInFlight(avatarId, false);
    sending.current = false;
    if (reply.ok) {
      onStarted(reply.result.jobId);
      return;
    }
    if (!mounted.current) return;
    setBusy(null);
    if (reply.error.code === "PRICE_CHANGED") {
      // 38b: the price the click accepted is gone; the engine's new one is asked, shown, and needs its own click.
      setPriceChanged(way);
      // Refreshing now, in this very update: no click may reach the old handler (and its old accepted worst) before the effect that asks again has run.
      setOptions((now) => (now.status === "ready" ? { ...now, refreshing: true } : now));
      setAsked((n) => n + 1);
      return;
    }
    if (reply.error.code === "IN_FLIGHT" && reply.error.clipReason === "motion-busy") {
      // 62a #after-click: a part C call runs that this window did not know of. One alert, the focus on «Отмена»; «Оживить» stays — once the call ends, the same click goes through.
      setMotionBusyAfter(true);
      calls.announce("alert", MOTION_BUSY);
      setToCancel((n) => n + 1);
      return;
    }
    setError(reply.error);
  }

  const unpriced = options.status === "failed" && options.error.code === "PRICE_UNAVAILABLE" && options.error.priceScope === "video";
  const whyId = `${ids}-why`;
  const guardId = `${ids}-guard`;
  const blockId = `${ids}-block`;
  const unitHeld = clipSlotTaken(view) || batchHoldsUnit(view);
  // Round 2 (L4): this sheet's own clip on its way holds the clip money unit as much as a running one.
  const clipBusy = unitHeld || busy !== null;
  const motionBlock: MotionBlock = { clipBusy, otherId: blockText !== null && !clipBusy ? blockId : null };
  const actionIds = { panel: `${ids}-idea`, guard: guardId, clipBusy: `${ids}-clip-busy`, suggestPrice: `${ids}-suggest-price` };
  const goWhy = suitable !== null && calls.anyRunning ? guardId : undefined;

  return createPortal(
    <div className="cat-scrim cat-scrim-center clip-sheet-scrim" role="presentation">
      <section
        ref={dialogRef}
        className={suitable !== null ? "cat-dlg clip-sheet mc-sheet" : "cat-dlg clip-sheet"}
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
            <h2 ref={titleRef} id={`${ids}-title`} className="cat-dlg-title" tabIndex={-1}>
              Оживить фото
            </h2>
            {subtitle !== null && <p className="cat-dlg-sub muted">{subtitle}</p>}
          </div>
          <button ref={closeRef} type="button" className="ibtn" aria-label="Закрыть" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </header>

        <div className={suitable !== null ? "cat-dlg-body clip-sheet-body mc-body" : "cat-dlg-body clip-sheet-body"}>
          <div className="mc-frame-col">
            <figure className="clip-sheet-frame">
              <div className="ph clip-sheet-photo">
                <Portrait avatarId={avatarId} photoId={photoId} label={frameLabel} />
                <span className="pill clip-frame-pill">первый кадр</span>
              </div>
              <figcaption className="faint clip-sheet-cap">Фото станет первым кадром клипа · 9:16</figcaption>
            </figure>
            {suitable !== null && <FrameNotes notes={notes} />}
          </div>

          {options.status === "failed" ? (
            <div className="clip-sheet-form clip-sheet-unpriced" id={whyId}>
              {unpriced ? (
                <Notice tone="warn">{PRICE_SCOPES_RU.video}</Notice>
              ) : (
                <Notice
                  tone="danger"
                  actions={
                    <button ref={retryRef} type="button" className="btn btn-s" onClick={() => setAsked((n) => n + 1)}>
                      Повторить
                    </button>
                  }
                >
                  {errorText(options.error)}
                </Notice>
              )}
            </div>
          ) : options.status === "ready" && !options.options.suitable ? (
            <div className="clip-sheet-form clip-sheet-unpriced" id={whyId}>
              <Notice tone="warn" role="status">
                {errorText({ code: "VALIDATION", clipReason: options.options.reason })}
              </Notice>
            </div>
          ) : (
            <div className="clip-sheet-form mc-form">
              <div className="clip-group mc-group">
                <div className="mc-group-head">
                  <span id={`${ids}-motion`} className="lbl">
                    Движение
                  </span>
                  <MotionStatus line={calls.status} />
                </div>
                <div ref={scrollRef} className="mc-scroll">
                  <div ref={scrollInRef} className="mc-scroll-in">
                    <div className="clip-opts" role="radiogroup" aria-labelledby={`${ids}-motion`}>
                      {(suitable?.motions ?? []).map((m) => {
                        const on = motion?.id === m.id;
                        const mine = m.source === "vision" || m.source === "own";
                        return (
                          <label key={m.id} className={["ap-opt", "clip-opt", on ? "ap-opt-on" : "", mine ? "mc-opt" : ""].filter((c) => c !== "").join(" ")}>
                            <input type="radio" className="choice-input" name={`${ids}-motion-choice`} value={m.id} checked={on} onChange={() => choose(() => setMotionId(m.id))} />
                            <span className="ap-radio" aria-hidden="true" />
                            <span className="ap-opt-text">
                              <span className="mc-opt-head">
                                <b>{motionRowLabel(m)}</b>
                                {m.source === "vision" && <span className="tag mc-tag">{SUGGESTED_TAG}</span>}
                              </span>
                              {showsEnglish(m) && (
                                <span className="ap-opt-sub clip-en" lang="en">
                                  {m.text}
                                </span>
                              )}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                    {suitable !== null && (
                      <>
                        <MotionActions calls={calls} block={motionBlock} ids={actionIds} suggestRef={suggestRef} toggleRef={toggleRef} />
                        <OwnIdea calls={calls} block={motionBlock} ids={actionIds} />
                      </>
                    )}
                  </div>
                </div>
              </div>
              <div className="clip-rows">
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
                  <span className="clip-model">{sheet?.modelLine ?? (quality === "pro" ? "Kling 3.0 · 1080p" : "Kling 3.0 · 720p")}</span>
                  {sheet?.proNote === true && <p className="clip-note clip-note-quiet clip-row-note">{PRO_NOTE}</p>}
                </div>
              </div>
            </div>
          )}
        </div>

        <footer className="clip-sheet-foot">
          {priceChanged !== null && sheet !== null && options.status === "ready" && !refreshing && (
            <Notice tone="warn">
              Цена изменилась: теперь не больше <span className="mono">{upUsd(priceChanged === "alone" && sheet.noFallback !== null ? sheet.noFallback.worstMicros : sheet.main.worstMicros)}</span>. Подтвердите ещё раз.
            </Notice>
          )}
          {sheet !== null && sheet.budgetNeed !== null && (
            <Notice tone="warn">
              Не хватает месячного бюджета: клипу нужно до <span className="mono">{sheet.budgetNeed}</span>. Бюджет — в{" "}
              <button type="button" className="viewer-why-link" onClick={() => navigate({ name: "settings", focus: "money" })}>
                Настройках
              </button>
              .
            </Notice>
          )}
          {error !== null && <Notice tone="danger">{errorText(error)}</Notice>}
          {motionBusyAfter && <QuietNotice tone="info">{MOTION_BUSY}</QuietNotice>}
          {blockText !== null && suitable !== null && (
            <div id={blockId}>
              <Notice tone="warn" role="status">
                {blockText}
              </Notice>
            </div>
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
          {sheet?.autoNote === true && <p className="clip-note">{AUTO_NOTE}</p>}
          {sheet?.boldNote === true && <p className="clip-note">{BOLD_NOTE}</p>}
          {sheet !== null && <p className="clip-note clip-note-quiet">{SOUND_NOTE}</p>}
          {sheet?.noFallback !== null && sheet?.noFallback !== undefined && <p className="clip-note">{NO_FALLBACK_NOTE}</p>}
          <div className="clip-sheet-btns">
            {sheet === null ? (
              <button type="button" className="btn btn-p" disabled aria-describedby={options.status === "loading" ? undefined : whyId}>
                {options.status === "loading" && <Spin />}
                Оживить
              </button>
            ) : (
              <button
                ref={mainRef}
                type="button"
                className="btn btn-p"
                disabled={!sheet.fits || blockText !== null}
                aria-busy={busy === "main" || undefined}
                aria-disabled={(sheet.fits && blockText === null && waiting) || undefined}
                aria-describedby={goWhy}
                onClick={() => void send("main")}
              >
                {busy === "main" && <Spin />}
                Оживить · <span className="mono">{sheet.main.label}</span>
              </button>
            )}
            {sheet?.noFallback != null && (
              <button
                type="button"
                className="btn"
                disabled={blockText !== null}
                aria-busy={busy === "alone" || undefined}
                aria-disabled={(blockText === null && waiting) || undefined}
                aria-describedby={goWhy}
                onClick={() => void send("alone")}
              >
                {busy === "alone" && <Spin />}
                Оживить без запасной модели · <span className="mono">{sheet.noFallback.label}</span>
              </button>
            )}
            <button ref={cancelRef} type="button" className="btn" onClick={onClose}>
              Отмена
            </button>
            <MotionGuard id={guardId} busy={suitable !== null && calls.anyRunning} />

          </div>
          <MotionNews news={calls.news} />
        </footer>
        <FocusEdge edge="end" />
      </section>
    </div>,
    document.body,
  );
}
