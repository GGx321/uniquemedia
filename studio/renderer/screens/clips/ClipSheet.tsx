import { useEffect, useId, useRef, useState } from "react";
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
import { animateBlock } from "./animate";
import { upUsd } from "./clipModel";
import type { ClipIntent } from "./clipsContext";
import { sheetView, type SuitableOptions } from "./sheetModel";

// Stage 5, 5b.1, S5.V8: the sheet «Оживить фото» (mockups 38, 38b, 38c, 38e, 38f; plan s5b1 §6, §5.14 «Before money»). Nothing is paid without it: it shows the frame, the motion, the
// quality, the length, the model and the price line, and «Оживить» sends exactly the engine's worst for the option on show as the accepted worst (I5.46), once. PRICE_CHANGED asks the
// engine again and needs a new click (38b). The month's fit is the engine's (`monthFits`): when it holds Kling alone, «Оживить» waits beside «Оживить без запасной модели» (38c). A
// dialog over the photo viewer (or the «Клипы» tab), with its own focus and Escape; the viewer under it waits.

const AUTO_NOTE = "Если Kling откажет бесплатно, клип снимет Grok — поэтому «не больше». Оплаченный отказ сам не переснимается.";
const BOLD_NOTE = "Для кадров «Смелой» запасной модели нет: если Kling откажет, клип не снимется — отказ бесплатный.";
const SOUND_NOTE = "Звука нет. Клип появится во вкладке «Клипы» через 1–3 минуты.";
const PRO_NOTE = "Запасная модель (Grok) снимает в 720p";
const NO_FALLBACK_NOTE = "Если Kling откажет, Grok снимать не будем";

const QUALITIES: readonly [ClipQuality, string][] = [
  ["std", "Обычное · 720p"],
  ["pro", "Чётче · 1080p"],
];
const LENGTHS: readonly [ClipSeconds, string][] = [
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
  readonly onStarted: (jobId: string, intent: ClipIntent) => void;
  /** Where the focus goes when the sheet closes: the button that opened it; else what had the focus then. */
  readonly returnFocus?: () => HTMLElement | null;
}

/** `refreshing`: the engine is asked again (38b) and the options read before stay on show meanwhile — the buttons keep their place and the focus on them. */
type Options =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly options: ClipOptions; readonly photoId: string; readonly refreshing: boolean }
  | { readonly status: "failed"; readonly error: EngineError };

export function ClipSheet({ avatarId, photoId, subtitle, frameLabel, onClose, onStarted, returnFocus }: ClipSheetProps) {
  const { client, store } = useEngine();
  const view = useEngineView();
  const navigate = useNavigate();
  const mounted = useMounted();
  const ids = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
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

  useEffect(() => {
    let alive = true;
    setOptions((now) => (now.status === "ready" && now.photoId === photoId ? { ...now, refreshing: true } : { status: "loading" }));
    void client.request("clips.options", { avatarId, photoId }).then((reply) => {
      if (!alive) return;
      setOptions(reply.ok ? { status: "ready", options: reply.result, photoId, refreshing: false } : { status: "failed", error: reply.error });
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
  const waiting = options.status === "loading" || refreshing || busy !== null || blockText !== null;

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

  /** A change of the choice ends what was said about the last price. */
  const choose = (change: () => void): void => {
    change();
    setPriceChanged(null);
    setError(null);
  };

  async function send(way: "main" | "alone"): Promise<void> {
    if (sending.current || sheet === null || suitable === null || motion === null || waiting) return;
    const button = way === "main" ? (sheet.fits ? sheet.main : null) : sheet.noFallback;
    if (button === null) return;
    sending.current = true;
    setBusy(way);
    setError(null);
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
      onStarted(reply.result.jobId, {
        clipId: reply.result.jobId,
        avatarId,
        photoId,
        motionLabel: motion.label,
        requestModel: "kling",
        seconds,
        acceptedWorstMicros: button.worstMicros,
        klingWorstMicros: suitable.noFallbackPrices[sheet.key].worstMicros,
        grokWorstMicros: (seconds === 10 ? suitable.prices.grok10 : suitable.prices.grok5).worstMicros,
      });
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
    setError(reply.error);
  }

  const unpriced = options.status === "failed" && options.error.code === "PRICE_UNAVAILABLE" && options.error.priceScope === "video";
  const whyId = `${ids}-why`;

  return createPortal(
    <div className="cat-scrim cat-scrim-center clip-sheet-scrim" role="presentation">
      <section
        ref={dialogRef}
        className="cat-dlg clip-sheet"
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

        <div className="cat-dlg-body clip-sheet-body">
          <figure className="clip-sheet-frame">
            <div className="ph clip-sheet-photo">
              <Portrait avatarId={avatarId} photoId={photoId} label={frameLabel} />
              <span className="pill clip-frame-pill">первый кадр</span>
            </div>
            <figcaption className="faint clip-sheet-cap">Фото станет первым кадром клипа · 9:16</figcaption>
          </figure>

          {options.status === "failed" ? (
            <div className="clip-sheet-form clip-sheet-unpriced" id={whyId}>
              {unpriced ? (
                <Notice tone="warn">{PRICE_SCOPES_RU.video}</Notice>
              ) : (
                <Notice
                  tone="danger"
                  actions={
                    <button type="button" className="btn btn-s" onClick={() => setAsked((n) => n + 1)}>
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
            <div className="clip-sheet-form">
              <div className="clip-group" role="radiogroup" aria-labelledby={`${ids}-motion`}>
                <span id={`${ids}-motion`} className="lbl">
                  Движение
                </span>
                <div className="clip-opts">
                  {(suitable?.motions ?? []).map((m) => {
                    const on = motion?.id === m.id;
                    return (
                      <label key={m.id} className={on ? "ap-opt clip-opt ap-opt-on" : "ap-opt clip-opt"}>
                        <input type="radio" className="choice-input" name={`${ids}-motion-choice`} value={m.id} checked={on} onChange={() => choose(() => setMotionId(m.id))} />
                        <span className="ap-radio" aria-hidden="true" />
                        <span className="ap-opt-text">
                          <b>{m.label}</b>
                          {m.source === "scene" && (
                            <span className="ap-opt-sub clip-en" lang="en">
                              {m.text}
                            </span>
                          )}
                        </span>
                      </label>
                    );
                  })}
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
          {blockText !== null && suitable !== null && (
            <Notice tone="warn" role="status">
              {blockText}
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
                onClick={() => void send("alone")}
              >
                {busy === "alone" && <Spin />}
                Оживить без запасной модели · <span className="mono">{sheet.noFallback.label}</span>
              </button>
            )}
            <button type="button" className="btn" onClick={onClose}>
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
