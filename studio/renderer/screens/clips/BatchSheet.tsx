import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PRICE_SCOPES_RU, type ClipBatchOptions, type ClipMotionChoice, type ClipMotionId, type ClipQuality, type ClipReason, type ClipSeconds, type EngineError, type PhotoSummary } from "../../../shared/engine";
import { useEngine, useEngineView } from "../../engine/react";
import { motionCallRunning, motionCallsOf } from "../../engine/store";
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
import { AnimateWhy, useShowBatchClips } from "./AnimateButton";
import { batchRowNote, batchSheetView, itemRefusal, itemRefusedAlert, type BatchSheetView } from "./batchModel";
import { upUsd } from "./clipModel";
import { AUTO_NOTE, LENGTHS, NO_FALLBACK_NOTE, PRO_NOTE, QUALITIES } from "./ClipSheet";
import { batchMotionGoneNews, batchTagOf, GROUP_OWN, GROUP_VISION, MOTION_BUSY, MOTION_UNAVAILABLE } from "./motionModel";
import { MotionGuard } from "./MotionSuggest";

// 5b.2, S5.WB4: the sheet «Оживить N фото» (mockups 59, 59a, 59b, 59c and #item-refused, #after-click; plan s5b2 §5.2.1; README §S5.WBD decisions 4–6, 13–14). Nothing is paid without it: the picked photos
// in turn order, each with its motion (the engine's list for that photo), the options for the whole batch, and the engine's sums (`clips.batchOptions`, free). «Оживить N» sends exactly the engine's worst for the
// option on show as the accepted worst — the SUM of the members' worst cases (I5.62). A refusal after the click is said ONCE, as an alert, and the focus goes to «Отмена» so Enter never confirms a new sum:
// PRICE_CHANGED and BUDGET_EXCEEDED ask the engine again; a refused item (VALIDATION at `["items", i]`) is struck with its own reason and the sum is asked again without it.
// 5b.2 part C (S5.WC5; mockups 59d, 59e): a row's list holds the photo's stored suggestions and own ideas too (groups «Предложено» and «Свои идеи»), and the chosen one shows its mark and its English under
// the photo (I5.67: seen before any video money). The batch sheet makes no paid part C call. While a part C call runs «Оживить N» waits beside the guard; a click the engine refused `motion-busy` (a call
// this window did not know of) says so once, as the sheet's other after-click alerts do (one live region at a time, WBD-13), the focus on «Отмена», and «Оживить N» stays as it was (59e).

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

/**
 * What the last click was answered, said once until the choice changes: as an alert, or — `unpriced`, the video prices that did not read at the click and read again when asked — as a status (S5.WB4c), so
 * the sheet that looks the same is never silent about why the click did nothing.
 */
type After =
  | { readonly kind: "price"; readonly way: "main" | "alone" }
  | { readonly kind: "budget"; readonly way: "main" | "alone" }
  | { readonly kind: "item"; readonly text: string }
  | { readonly kind: "unpriced" }
  | { readonly kind: "motion-busy" };

/** S5.WB4c: the short status after a click the engine refused because the video prices did not read, when asking again read them. */
const UNPRICED_AGAIN = "Цены видео не прочитались при отправке — запросили их снова. Подтвердите ещё раз.";

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
  /** S5.WC5b (M2): rows whose chosen motion the engine no longer knows (`unknown-motion`): they stay, with «Движение больше недоступно — выберите другое.», until their choice changes. */
  const [unavailable, setUnavailable] = useState<ReadonlySet<string>>(new Set());
  /** S5.WC5b (M2): what a list read again took from the rows (a chosen motion pushed out of the newest), said once as a status. */
  const [dropped, setDropped] = useState<string | null>(null);
  /** The title of each row's chosen motion while its list holds it, to say which one left. */
  const chosenTitles = useRef(new Map<string, string>());

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
  // The options on show were asked for other rows (a row refused after the click, before the effect that asks again has run): they wait, so nothing is sent or said on them.
  // With every row refused after the click there is nothing left to ask about: nothing refreshes, and the alert stands (review L7).
  const refreshing = askedKey !== "" && ready !== null && (ready.refreshing || ready.asked !== askedKey);
  // Every row refused after the click: there is nothing left to ask the engine about, nor to send.
  const sheet: BatchSheetView | null = askedKey === "" || ready === null || ready.options.items.every((item) => !item.suitable) ? null : batchSheetView(ready.options, { quality, seconds });
  const unpriced = options.status === "failed" && options.error.code === "PRICE_UNAVAILABLE" && options.error.priceScope === "video";
  // The same words as under «Оживить» (`AnimateWhy`): one wording for a missing key, «Нужен ключ OpenRouter — Настройки.» with its link (S5.WB4c).
  const block = animateBlock(view, view.avatars.find((a) => a.avatarId === avatarId)?.status !== "archived", avatarId);
  const showBatchClips = useShowBatchClips();
  // r2.1 N10: a part C call runs (the window's store, any avatar): the engine would refuse the batch `motion-busy`, so «Оживить N» waits beside the guard.
  const motionRunning = motionCallRunning(view);
  const waiting = options.status === "loading" || refreshing || busy !== null || block !== null || motionRunning;
  const itemOf = (photoId: string) => ready?.options.items.find((item) => item.photoId === photoId);
  /** The row's motion: its choice while its list holds it, else the first. A choice the list lost is never dropped in silence: the effect below says it and takes it back. */
  const motionOf = (photoId: string): ClipMotionId | null => {
    const item = itemOf(photoId);
    if (item === undefined || !item.suitable) return null;
    const chosen = motions.get(photoId);
    return item.motions.find((m) => m.id === chosen)?.id ?? item.motions[0]?.id ?? null;
  };

  // S5.WC5b (M2): a part C call for a listed photo ended (it left the window's `motionCalls`): its stored motions may have changed, so the rows are read again; quality and length stay as chosen.
  const callsKey = picks.map((pick) => `${pick.photoId}:${motionCallsOf(view, avatarId, pick.photoId).join("+")}`).join(",");
  const lastCalls = useRef(callsKey);
  useEffect(() => {
    const before = lastCalls.current;
    lastCalls.current = callsKey;
    const kindsOf = (key: string): Map<string, string[]> => new Map(key.split(",").map((part) => [part.slice(0, part.indexOf(":")), part.slice(part.indexOf(":") + 1).split("+").filter((k) => k !== "")]));
    const now = kindsOf(callsKey);
    const ended = [...kindsOf(before)].some(([photoId, kinds]) => kinds.some((kind) => !(now.get(photoId) ?? []).includes(kind)));
    if (ended) setAgain((n) => n + 1);
  }, [callsKey]);

  // S5.WC5b (M2): a row's chosen motion that the list read again no longer holds (only the newest suggestions and ideas are listed) goes back to the row's first motion, and that is said.
  useEffect(() => {
    if (ready === null || refreshing) return;
    const said: string[] = [];
    const lost: string[] = [];
    for (const pick of picks) {
      const chosen = motions.get(pick.photoId);
      const item = itemOf(pick.photoId);
      if (chosen === undefined || item === undefined || !item.suitable || item.motions.some((m) => m.id === chosen)) continue;
      lost.push(pick.photoId);
      const gone = chosenTitles.current.get(pick.photoId);
      const first = item.motions[0];
      if (gone !== undefined && first !== undefined) said.push(batchMotionGoneNews(pick.label, gone, first.label));
    }
    if (lost.length === 0) return;
    setMotions((now) => {
      const next = new Map(now);
      for (const photoId of lost) next.delete(photoId);
      return next;
    });
    if (said.length > 0) setDropped(said.join(" "));
  }, [ready, refreshing]);
  useEffect(() => {
    for (const pick of picks) {
      const item = itemOf(pick.photoId);
      const chosen = item?.suitable === true ? item.motions.find((m) => m.id === motions.get(pick.photoId)) : undefined;
      if (chosen !== undefined) chosenTitles.current.set(pick.photoId, chosen.label);
    }
  });

  /** A change of the choice ends what was said about the last click. */
  const choose = (change: () => void): void => {
    change();
    setAfter(null);
    setError(null);
    setDropped(null);
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
    setDropped(null);
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
    if (code === "PRICE_CHANGED" || code === "BUDGET_EXCEEDED" || (code === "PRICE_UNAVAILABLE" && reply.error.priceScope === "video")) {
      // 59a, 59b #after-click: the engine's figures are asked again (the remaining room, the Kling-only sum, L12) and need a new click. A price that stopped reading turns the sheet into 59c.
      setAfter(code === "PRICE_UNAVAILABLE" ? { kind: "unpriced" } : { kind: code === "PRICE_CHANGED" ? "price" : "budget", way });
      setOptions((now) => (now.status === "ready" ? { ...now, refreshing: true } : now));
      setAgain((n) => n + 1);
    } else if (code === "IN_FLIGHT" && reply.error.clipReason === "motion-busy") {
      // 59e: nothing was held or priced; once the call ends the same click goes through.
      setAfter({ kind: "motion-busy" });
    } else if (item !== null && item.reason === "unknown-motion") {
      // S5.WC5b (M2): the photo can still be made with another motion, so its row is not struck: it says so, and the rows are read again (the lost choice goes back to the first motion).
      const label = picks.find((p) => p.photoId === item.photoId)?.label ?? "Фото";
      setUnavailable((now) => new Set(now).add(item.photoId));
      setOptions((now) => (now.status === "ready" ? { ...now, refreshing: true } : now));
      setAgain((n) => n + 1);
      setAfter({ kind: "item", text: `${label}: ${MOTION_UNAVAILABLE.charAt(0).toLocaleLowerCase("ru")}${MOTION_UNAVAILABLE.slice(1)}` });
    } else if (item !== null) {
      // 59 #item-refused: the row is struck with its OWN reason, and the sum is asked again without it.
      const label = picks.find((p) => p.photoId === item.photoId)?.label ?? "Фото";
      setRefused((now) => new Map(now).set(item.photoId, item.reason));
      setOptions((now) => (now.status === "ready" ? { ...now, refreshing: true } : now));
      setAfter({ kind: "item", text: itemRefusedAlert(label, item.reason) });
    } else {
      setError(reply.error);
      return;
    }
    setToCancel((n) => n + 1);
  }

  const whyId = `${ids}-why`;
  const noticeId = `${ids}-notice`;
  const title = `Оживить ${picks.length} фото`;
  const shownAfter = after !== null && !refreshing && (options.status === "ready" || askedKey === "") ? after : null;
  // The month's notice: a status when `monthFits` says it at open, an alert when `tryHold` said it after the click (59b #after-click) — while the way clicked still does not fit the room asked again.
  // The figure is what the way clicked needs: Kling alone for «без запасной модели», whether that button is still offered or not (review L6).
  const budgetAlert = shownAfter?.kind === "budget" && sheet !== null && !sheet.fits && (shownAfter.way === "main" || sheet.noFallback === null);
  const budgetShown = sheet !== null && (budgetAlert || sheet.budgetNeed !== null);
  const budgetNeed = sheet === null ? "" : budgetAlert && shownAfter?.way === "alone" ? upUsd(sheet.worstNoFallbackMicros) : upUsd(sheet.main.worstMicros);
  const mainOff = sheet === null || !sheet.fits || waiting || sheet.count === 0;
  const guardId = `${ids}-guard`;
  // S5.WB4c: a new price that leaves the way clicked over the month says so in the same alert — the month's sentence after the price's, and no «Подтвердите ещё раз» for a way that cannot be sent.
  const priceShort = shownAfter?.kind === "price" && sheet !== null && !sheet.fits && (shownAfter.way === "main" || sheet.noFallback === null);
  const priceNeed = sheet === null ? "" : shownAfter?.kind === "price" && shownAfter.way === "alone" ? upUsd(sheet.worstNoFallbackMicros) : sheet.worst;
  // S5.WC5b: what a list read again took from the rows, said once it is in.
  const dropShown = dropped !== null && !refreshing ? dropped : null;
  // One live region at a time (README decision 13): the click's answer, else the engine's error, else why paid work waits, else the month — a drop said in that same status, after the reason it never
  // replaces (round 2, M-2) — else the drop alone.
  const notice: "price" | "item" | "unpriced" | "motion" | "error" | "dropped" | "block" | "budget" | null =
    shownAfter?.kind === "price" && sheet !== null
      ? "price"
      : shownAfter?.kind === "item"
        ? "item"
        : shownAfter?.kind === "unpriced"
          ? "unpriced"
          : shownAfter?.kind === "motion-busy"
            ? "motion"
            : error !== null
              ? "error"
              : block !== null && ready !== null
                ? "block"
                : budgetShown
                  ? "budget"
                  : dropShown !== null
                    ? "dropped"
                    : null;
  const mainWhy = unpriced ? whyId : notice === "block" || notice === "budget" || (notice === "price" && priceShort) ? noticeId : motionRunning && sheet !== null ? guardId : undefined;
  // 59d: the wider list column only when a row lists a suggestion or an idea (59 as approved otherwise).
  const ownRows = ready?.options.items.some((item) => item.suitable && item.motions.some((m) => m.source === "vision" || m.source === "own")) === true;
  const monthShort = (need: string, room: string) => (
    <>
      Не хватает месячного бюджета: пакету нужно до <span className="mono">{need}</span>, осталось <span className="mono">{room}</span>. Уберите часть фото или поднимите бюджет в{" "}
      <button type="button" className="viewer-why-link" onClick={() => navigate({ name: "settings", focus: "money" })}>
        Настройках
      </button>
      .
    </>
  );

  const rows = (
    <ul className="batch-rows" aria-label="Фото пакета">
      {picks.map((pick) => {
        const item = itemOf(pick.photoId);
        const bare = unpriced || (options.status !== "ready" && !refused.has(pick.photoId));
        const note = bare ? null : unavailable.has(pick.photoId) ? { text: MOTION_UNAVAILABLE, struck: false, bold: false } : batchRowNote(pick.photo, item, refused.get(pick.photoId));
        const struck = note?.struck === true;
        const motionId = struck || bare ? null : motionOf(pick.photoId);
        const choices = item?.suitable === true ? item.motions : [];
        const chosen = choices.find((m) => m.id === motionId);
        const tag = chosen === undefined ? null : batchTagOf(chosen);
        return (
          <li key={pick.photoId} className={struck ? "batch-row batch-row-off" : bare || motionId === null ? "batch-row batch-row-bare" : "batch-row"}>
            <span className="ph batch-thumb" aria-hidden="true">
              <Portrait avatarId={avatarId} photoId={pick.photoId} label={pick.label} />
            </span>
            <span className="batch-what">
              <span className="batch-label">{pick.label}</span>
              {note !== null && <span className={note.bold ? "batch-note batch-note-bold" : "batch-note"}>{nbDash(note.text)}</span>}
              {chosen !== undefined && tag !== null && (
                <span className="mc-ben">
                  <span className={chosen.source === "own" ? "tag mc-tag mc-tag-own" : "tag mc-tag"}>{tag}</span>{" "}
                  <span lang="en">{chosen.text}</span>
                </span>
              )}
            </span>
            {motionId !== null && (
              <select
                className="row-select batch-motion mc-bsel"
                aria-label={`Движение · ${pick.label}`}
                value={motionId}
                onChange={(event) => {
                  const next = choices.find((m) => m.id === event.target.value)?.id;
                  if (next === undefined) return;
                  choose(() => setMotions((now) => new Map(now).set(pick.photoId, next)));
                  setUnavailable((now) => {
                    const rest = new Set(now);
                    rest.delete(pick.photoId);
                    return rest;
                  });
                }}
              >
                <MotionOptions choices={choices} />
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
        className={ownRows ? "cat-dlg clip-sheet batch-sheet mc-batch" : "cat-dlg clip-sheet batch-sheet"}
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
          {notice === "price" && sheet !== null && (
            <div id={noticeId}>
              <Notice tone="warn" role="alert">
                Цена изменилась: теперь не больше <span className="mono">{priceNeed}</span>.{" "}
                {priceShort ? monthShort(priceNeed, sheet.room) : "Подтвердите ещё раз."}
              </Notice>
            </div>
          )}
          {notice === "item" && shownAfter?.kind === "item" && (
            <Notice tone="warn" role="alert">
              {shownAfter.text}
            </Notice>
          )}
          {notice === "unpriced" && (
            <Notice tone="warn" role="status">
              {nbDash(UNPRICED_AGAIN)}
            </Notice>
          )}
          {notice === "motion" && (
            <Notice tone="info" role="alert">
              {MOTION_BUSY}
            </Notice>
          )}
          {notice === "error" && error !== null && <Notice tone="danger">{errorText(error)}</Notice>}
          {notice === "dropped" && dropShown !== null && (
            <Notice tone="info" role="status">
              {nbDash(dropShown)}
            </Notice>
          )}
          {/* The buttons are described by the reason alone (`noticeId`), never by the drop said after it. */}
          {notice === "block" && block !== null && (
            <Notice tone="warn" role="status">
              <span id={noticeId}>
                <AnimateWhy
                  why={block}
                  onShowClips={(batchAvatarId) => {
                    onClose();
                    showBatchClips(batchAvatarId);
                  }}
                />
              </span>
              {dropShown !== null && <> {nbDash(dropShown)}</>}
            </Notice>
          )}
          {notice === "budget" && sheet !== null && (
            <Notice tone="warn" role={budgetAlert ? "alert" : "status"}>
              <span id={noticeId}>{monthShort(budgetNeed, sheet.room)}</span>
              {dropShown !== null && <> {nbDash(dropShown)}</>}
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
              aria-describedby={mainWhy}
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
              <button
                type="button"
                className="btn"
                aria-busy={busy === "alone" || undefined}
                aria-disabled={waiting || undefined}
                aria-describedby={motionRunning ? guardId : undefined}
                onClick={() => void send("alone")}
              >
                {busy === "alone" && <Spin />}
                Оживить без запасной модели · <span className="mono">{sheet.noFallback.label}</span>
              </button>
            )}
            <button ref={cancelRef} type="button" className="btn" onClick={onClose}>
              Отмена
            </button>
            <MotionGuard id={guardId} busy={motionRunning && sheet !== null} />
          </div>
        </footer>
        <FocusEdge edge="end" />
      </section>
    </div>,
    document.body,
  );
}

/**
 * 59d: a row's list — the scene and the code motions, then the photo's stored suggestions and own ideas in their groups, each by its label alone (≤ 40 characters, so the closed list never cuts one;
 * which kind is chosen is said by the row's mark).
 */
function MotionOptions({ choices }: { choices: readonly ClipMotionChoice[] }) {
  const option = (m: ClipMotionChoice) => (
    <option key={m.id} value={m.id}>
      {m.label}
    </option>
  );
  const vision = choices.filter((m) => m.source === "vision");
  const own = choices.filter((m) => m.source === "own");
  return (
    <>
      {choices.filter((m) => m.source === "scene" || m.source === "code").map(option)}
      {vision.length > 0 && <optgroup label={GROUP_VISION}>{vision.map(option)}</optgroup>}
      {own.length > 0 && <optgroup label={GROUP_OWN}>{own.map(option)}</optgroup>}
    </>
  );
}
