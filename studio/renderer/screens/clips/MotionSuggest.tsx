import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { ClipFrameNote, ClipMotionId, ClipSuggestResult, ClipTranslateResult, EngineError, MotionProblem } from "../../../shared/engine";
import { useEngine } from "../../engine/react";
import { motionCallRunning, motionCallsOf, type EngineView, type MotionResult } from "../../engine/store";
import { errorText } from "../../lib/errors";
import { nbDash } from "../../lib/format";
import { formatUsdTiered } from "../../lib/money";
import { Icon, Spin } from "../../ui/Icon";
import { paidButtonState, PriceFailed } from "../photos/scenePaid";
import { useMounted } from "../photos/shared";
import { usePaidAction, type PaidAction } from "../photos/usePaidAction";
import {
  checkIdea,
  CLIP_BUSY,
  FRAME_NOTES_RU,
  frameNotesNews,
  IDEA_OPEN,
  lineText,
  MOTION_BUSY,
  NOTES_LABEL,
  SUGGEST_LABEL,
  SUGGESTING,
  suggestedLine,
  suggestNoneLine,
  translatedLine,
  type MoneyLine,
} from "./motionModel";

// 5b.2 part C, S5.WC5 (plan s5b2 §5.3, §6 rows 62–62d, I5.66–I5.68; mockups 62, 62a–62d and README §S5.WCD decisions 1–9): the two paid part C calls of the «Оживить фото» sheet — «Предложить движения»
// (`clips.suggestMotions`, the vision writer) and «Своя идея…» → «Перевести» (`clips.translateIdea`, the field is OwnIdea.tsx) — with the lines they leave and the guard they set.
//  - Each button shows the engine's LIVE estimate (`clips.estimateSuggest` / `clips.estimateIdea`, free) and sends exactly it as `acceptedWorstMicros`, once (`usePaidAction`): PRICE_CHANGED asks again and needs a
//    new click; a refusal says why under the button.
//  - The guard, both ways (r2.1 N10; the engine binds, the sheet mirrors): while any call runs (the window's store, `motionCalls`, any avatar) «Оживить» waits beside «Подождите: идёт подбор движения или
//    перевод.»; while a clip or a batch holds the clip money unit the two buttons wait, described by the reason the sheet's footer shows (S5.WC5b, M1), and while the sheet's own «Оживить» is on its way
//    by `CLIP_BUSY` (that one clip); the engine's `clip-busy` words are said only for a refusal after a click. One call per sheet: while this photo's call runs, its other action waits too.
//  - NOT the avatar's paid lock: a call claims no avatar (I5.68), so `paidInFlightAvatars` is left alone and a photo run goes on.
//  - The live regions are mounted with the sheet; a result is said once — by them, or by the focus moving to the field it is about (63b), never both.

/** What a live region says now; `seq` makes the same words said again. */
export interface News {
  readonly text: string;
  readonly seq: number;
}

/** How a sent idea came back when it did not give a motion (63b, 63c, the two ends of `none`). */
export type IdeaOutcome = { readonly kind: "rejected"; readonly problems: readonly MotionProblem[]; readonly costMicros: number } | { readonly kind: "none"; readonly costMicros: number };

export interface MotionCallsArgs {
  readonly avatarId: string;
  readonly photoId: string;
  readonly view: EngineView;
  /** The sheet offers part C: its photo is suitable and its options are on show. Without it no price is asked. */
  readonly offered: boolean;
  /** Ask `clips.options` again: the photo's stored suggestions and ideas changed. Asked ONCE per finished call, when the call leaves the window's store. */
  readonly relist: () => void;
  /** A new row to focus once the list holds it — and to select, for an own idea (§6 63a); `last`, the last new row, is scrolled into view first (62b). */
  readonly reveal: (id: ClipMotionId, select: boolean, last?: ClipMotionId) => void;
  /** 62c: the focus goes to «Отмена». */
  readonly toCancel: () => void;
  /** 63a: the focus goes to «Своя идея…» before the panel it is in hides (round 2, M2). */
  readonly toIdeaToggle: () => void;
}

export interface MotionCalls {
  readonly suggest: PaidAction;
  readonly translate: PaidAction;
  /** This photo's suggestion is on its way: sent from this sheet, or from an earlier opening of it (the store). */
  readonly suggestRunning: boolean;
  readonly ideaRunning: boolean;
  /** Any part C call is on its way, any avatar: «Оживить» waits (the engine's `motion-busy` is GLOBAL). */
  readonly anyRunning: boolean;
  /** 62b, 63a: the line beside «Движение»; null when there is none. */
  readonly status: MoneyLine | null;
  /** 62c: the suggestion that gave nothing. */
  readonly suggestNone: { readonly line: MoneyLine; readonly free: boolean } | null;
  /** The frame reading of the suggestion made in this opening (it is also stored, `ClipOptions.reading`). */
  readonly reading: readonly ClipFrameNote[] | null;
  readonly idea: {
    readonly open: boolean;
    readonly text: string;
    readonly outcome: IdeaOutcome | null;
    /** Bumped when the focus is to go into the field (a refusal is about its text). */
    readonly focusField: number;
    setText(next: string): void;
    toggle(): void;
  };
  readonly news: { readonly polite: News; readonly alert: News };
  /** Says `text` in a live region (again, if it said the same last). */
  announce(where: "polite" | "alert", text: string): void;
  startSuggest(): void;
  startTranslate(): void;
}

/** The two calls of one photo's sheet, their prices, outcomes and the guard's facts. */
export function useMotionCalls({ avatarId, photoId, view, offered, relist, reveal, toCancel, toIdeaToggle }: MotionCallsArgs): MotionCalls {
  const { client, store } = useEngine();
  const mounted = useMounted();
  const latest = useRef({ relist, reveal, toCancel, toIdeaToggle });
  useLayoutEffect(() => {
    latest.current = { relist, reveal, toCancel, toIdeaToggle };
  });
  /** Round 2 (L7): the photo each call was sent for, kept at the click, so its end clears exactly the call it started. */
  const sentFor = useRef<{ suggest: { avatarId: string; photoId: string } | null; idea: { avatarId: string; photoId: string } | null }>({ suggest: null, idea: null });
  const inFlight = (kind: "suggest" | "idea", running: boolean): void => {
    const target = running ? { avatarId, photoId } : sentFor.current[kind];
    sentFor.current[kind] = running ? target : null;
    if (target !== null) store.setMotionCall(target.avatarId, { photoId: target.photoId, kind }, running);
  };
  const [status, setStatus] = useState<MoneyLine | null>(null);
  const [suggestNone, setSuggestNone] = useState<MotionCalls["suggestNone"]>(null);
  const [reading, setReading] = useState<readonly ClipFrameNote[] | null>(null);
  const [ideaOpen, setIdeaOpen] = useState(false);
  const [ideaText, setIdeaText] = useState("");
  const [ideaOutcome, setIdeaOutcome] = useState<IdeaOutcome | null>(null);
  const [focusField, setFocusField] = useState(0);
  const [news, setNews] = useState<MotionCalls["news"]>({ polite: { text: "", seq: 0 }, alert: { text: "", seq: 0 } });
  const announce = (where: "polite" | "alert", text: string): void => setNews((now) => ({ ...now, [where]: { text, seq: now[where].seq + 1 } }));

  // The price follows the photo and the text model the call is priced with (the estimate reads the model's price; the idea's text never moves it).
  const priceKey = offered && view.settings !== null ? `${avatarId}|${photoId}|${view.settings.textModel}` : null;
  const check = checkIdea(ideaText);

  const suggest = usePaidAction<ClipSuggestResult>({
    key: priceKey === null ? null : `suggest|${priceKey}`,
    price: async () => {
      const reply = await client.request("clips.estimateSuggest", { avatarId, photoId });
      return reply.ok ? { ok: true, result: { estimate: reply.result } } : reply;
    },
    send: (acceptedWorstMicros) => client.request("clips.suggestMotions", { avatarId, photoId, acceptedWorstMicros }),
    onSent: (result) => {
      if (keep("suggest", { kind: "suggest", result })) return;
      showSuggest(result, true);
    },
    onRefused: (error) => announce("alert", errorText(error)),
    onPaidInFlightChange: (running) => inFlight("suggest", running),
  });

  const translate = usePaidAction<ClipTranslateResult>({
    key: priceKey === null ? null : `idea|${priceKey}`,
    price: async () => {
      const reply = await client.request("clips.estimateIdea", { avatarId, photoId });
      return reply.ok ? { ok: true, result: { estimate: reply.result } } : reply;
    },
    // Only a text the contract takes is ever sent (`startTranslate`); the field waits meanwhile, so this is the text clicked.
    send: (acceptedWorstMicros) => client.request("clips.translateIdea", { avatarId, photoId, text: check.ok ? check.idea : ideaText, acceptedWorstMicros }),
    onSent: (result) => {
      if (keep("idea", { kind: "idea", result })) return;
      showIdea(result, true);
    },
    onRefused: (error) => announce("alert", errorText(error)),
    onPaidInFlightChange: (running) => inFlight("idea", running),
  });

  /**
   * S5.WC5b: an answer that came after this sheet closed is kept in the window's store for its photo (the photo it was sent for, round 2 L7), to be said by the sheet of that photo — the one open when
   * the call ends (`hereKey` below), else the next opening: a paid `none` or `rejected` is never silent. True when it was kept.
   */
  function keep(kind: "suggest" | "idea", result: MotionResult): boolean {
    if (mounted.current) return false;
    const target = sentFor.current[kind];
    if (target !== null) store.keepMotionResult(target.avatarId, target.photoId, result);
    return true;
  }

  /** A suggestion's answer, as it came (`live`: this sheet sent it and is open) or as a kept one said on opening (no focus is moved, no row revealed). */
  function showSuggest(result: ClipSuggestResult, live: boolean): void {
    if (result.outcome === "ok") {
      const line = suggestedLine(result.motions.length, result.costMicros);
      setStatus(line);
      setReading(result.reading.notes);
      const notes = frameNotesNews(result.reading.notes);
      announce("polite", notes === null ? lineText(line) : `${lineText(line)} ${notes}`);
      // 62b: the choice stays where the owner left it; the focus goes to the first suggestion, the group brought down to the last (README decision 4).
      const first = result.motions[0];
      if (live && first !== undefined) latest.current.reveal(first.id, false, result.motions.at(-1)?.id);
      return;
    }
    const line = suggestNoneLine(result.costMicros);
    setSuggestNone({ line, free: result.costMicros === 0 });
    announce(result.costMicros === 0 ? "polite" : "alert", lineText(line));
    if (live) latest.current.toCancel();
  }

  /** A translation's answer, as it came or as a kept one. His words are not kept anywhere (I5.67): a kept refusal opens the card on an empty field. */
  function showIdea(result: ClipTranslateResult, live: boolean): void {
    if (result.outcome === "ok") {
      const line = translatedLine(result.costMicros);
      if (live) {
        // Round 2 (M2): the focus leaves the panel before it hides, so it never falls to the page while the list is read again.
        latest.current.toIdeaToggle();
        setIdeaOpen(false);
        setIdeaText("");
        setIdeaOutcome(null);
        // 63a: his idea is chosen — his direct intent — and the focus is on it.
        latest.current.reveal(result.item.id, true);
      }
      setStatus(line);
      announce("polite", lineText(line));
      return;
    }
    // 63b, 63c and `none`: the reason is about his text, so the focus goes into the field, which it describes (said once: no live region repeats it).
    setIdeaOpen(true);
    setIdeaOutcome(result.outcome === "rejected" ? { kind: "rejected", problems: result.problems, costMicros: result.costMicros } : { kind: "none", costMicros: result.costMicros });
    setFocusField((n) => n + 1);
  }

  /** S5.WC5b: the answer kept for this photo while no sheet of it was open, said once (no focus moved, no row revealed). */
  function sayKept(): void {
    const kept = store.takeMotionResult(avatarId, photoId);
    if (kept === null) return;
    if (kept.kind === "suggest") showSuggest(kept.result, false);
    else showIdea(kept.result, false);
  }

  // S5.WC5b: what came for this photo while no sheet of it was open is said once, now.
  useEffect(sayKept, []);

  // PRICE_CHANGED: the fresh price is on the button and needs a new click — said once.
  const suggestChanged = suggest.previousWorst !== null && suggest.estimate !== null ? suggest.estimate.worstMicros : null;
  const translateChanged = translate.previousWorst !== null && translate.estimate !== null ? translate.estimate.worstMicros : null;
  useEffect(() => {
    if (suggestChanged !== null) announce("alert", priceChangedText(suggestChanged));
  }, [suggestChanged]);
  useEffect(() => {
    if (translateChanged !== null) announce("alert", priceChangedText(translateChanged));
  }, [translateChanged]);

  // A call of this photo that ended — this sheet's, or one an earlier opening sent (the store) — may have stored new rows: the list is asked again, once per call (round 2, L3). An earlier opening's
  // call left its answer in the store before it left the store's calls (`usePaidAction`: `onSent`, then the in-flight end), so this open sheet says it now (S5.WC5b round 2, M-1).
  const here = motionCallsOf(view, avatarId, photoId);
  const hereKey = here.join(",");
  const lastHere = useRef(hereKey);
  useEffect(() => {
    const before = lastHere.current.split(",").filter((kind) => kind !== "");
    lastHere.current = hereKey;
    if (!before.some((kind) => !hereKey.split(",").includes(kind))) return;
    latest.current.relist();
    sayKept();
  }, [hereKey]);

  const suggestRunning = suggest.sending || here.includes("suggest");
  const ideaRunning = translate.sending || here.includes("idea");

  // 62a, 63 #running: a call this sheet sent holds «Оживить» — said once, politely (the busy button keeps the focus and says «Смотрим кадр…» / «Переводим…» itself).
  const ownSending = suggest.sending || translate.sending;
  useEffect(() => {
    if (ownSending) announce("polite", MOTION_BUSY);
  }, [ownSending]);

  return {
    suggest,
    translate,
    suggestRunning,
    ideaRunning,
    anyRunning: suggest.sending || translate.sending || motionCallRunning(view),
    status,
    suggestNone,
    reading,
    idea: {
      open: ideaOpen,
      text: ideaText,
      outcome: ideaOutcome,
      focusField,
      setText: (next) => {
        setIdeaText(next);
        // A refusal was about the text it was given: an edit ends it (38b's rule).
        setIdeaOutcome(null);
      },
      toggle: () => setIdeaOpen((open) => !open),
    },
    news,
    announce,
    startSuggest: () => {
      if (suggest.estimate === null || suggest.sending) return;
      setStatus(null);
      setSuggestNone(null);
      suggest.click();
    },
    startTranslate: () => {
      if (!check.ok || translate.estimate === null || translate.sending) return;
      setStatus(null);
      setIdeaOutcome(null);
      translate.click();
    },
  };
}

/** The sheet's 38b words for a part C button's new price. */
export function priceChangedText(worstMicros: number): string {
  return `Цена изменилась: теперь не больше ${formatUsdTiered(worstMicros, "up")}. Подтвердите ещё раз.`;
}

/** A line with its figure set in mono. */
export function MoneyText({ line }: { line: MoneyLine }) {
  return (
    <>
      {line.before}
      {line.money !== null && <span className="mono">{line.money}</span>}
      {line.after}
    </>
  );
}

/** A notice as the app draws one, with no live role: what it says is said by the sheet's live regions (mounted from the start), once. */
export function QuietNotice({ tone, id, children }: { tone: "info" | "warn" | "danger"; id?: string; children: ReactNode }) {
  return (
    <div id={id} className={`notice notice-${tone}`}>
      <span className="notice-icon">
        <Icon name={tone === "info" ? "info" : "alert"} size={16} />
      </span>
      <div className="notice-body">
        <div className="notice-text">{children}</div>
      </div>
    </div>
  );
}

/** The sheet's two live regions, in the page from the start (sr-only): a result, a refusal after a click, the frame's notes. */
export function MotionNews({ news }: { news: MotionCalls["news"] }) {
  return (
    <>
      <p className="sr-only" aria-live="polite" data-motion-news="polite">
        {news.polite.text !== "" && <span key={news.polite.seq}>{news.polite.text}</span>}
      </p>
      <p className="sr-only" aria-live="assertive" data-motion-news="alert">
        {news.alert.text !== "" && <span key={news.alert.seq}>{news.alert.text}</span>}
      </p>
    </>
  );
}

/**
 * 62a, 63 #running: the guard beside the buttons it holds, which it describes. It is no live region of its own (one per sheet, README decision 13): a call this sheet starts says it through the sheet's
 * polite region; a call already running when the sheet opens is read with the button it holds.
 */
export function MotionGuard({ id, busy }: { id: string; busy: boolean }) {
  return (
    <p id={id} className="mc-guard">
      {busy && (
        <>
          <Spin />
          <span>{MOTION_BUSY}</span>
        </>
      )}
    </p>
  );
}

/** 62d: the frame reading's marks under the frame — they mark, they never refuse or price. */
export function FrameNotes({ notes }: { notes: readonly ClipFrameNote[] }) {
  if (notes.length === 0) return null;
  return (
    <ul className="mc-notes" aria-label={NOTES_LABEL}>
      {notes.map((note) => (
        <li key={note} className={note === "capture-differs" ? "mc-note mc-note-info" : "mc-note mc-note-warn"}>
          <Icon name={note === "capture-differs" ? "info" : "alert"} size={13} strokeWidth={2} />
          <span>{nbDash(FRAME_NOTES_RU[note])}</span>
        </li>
      ))}
    </ul>
  );
}

/** 62b, 63a: the line beside «Движение» (no height of its own: it sits in the group's head). */
export function MotionStatus({ line }: { line: MoneyLine | null }) {
  if (line === null) return null;
  return (
    <p className="mc-status">
      <Icon name="check" size={13} strokeWidth={2.4} />
      <span>
        <MoneyText line={line} />
      </span>
    </p>
  );
}

/** Why the two paid buttons cannot send now (besides their own call): a clip money unit held (`clip-busy`), or the sheet's own wait (a key, a reconcile, …) said in its footer. */
export interface MotionBlock {
  readonly clipBusy: boolean;
  /** The id of the footer's reason, when another wait holds paid work; null when none does. */
  readonly otherId: string | null;
}

interface MotionActionsProps {
  readonly calls: MotionCalls;
  readonly block: MotionBlock;
  /** The ids the actions point at: the idea panel, the guard, the clip-busy line, the price lines. */
  readonly ids: { readonly panel: string; readonly guard: string; readonly clipBusy: string; readonly suggestPrice: string };
  readonly suggestRef: RefObject<HTMLButtonElement | null>;
  /** «Своя идея…»: where the focus goes when the panel hides (63a). */
  readonly toggleRef: RefObject<HTMLButtonElement | null>;
}

/**
 * Under the list: «Предложить движения · до $0.015» (the accent's quiet tint, as «Оживить» in the viewer) and «Своя идея…» (free: it opens the field), then what the suggestion left — 62c's notice, a refusal,
 * a new price — under the button it came from.
 */
export function MotionActions({ calls, block, ids, suggestRef, toggleRef }: MotionActionsProps) {
  const { suggest, suggestRunning, ideaRunning, idea } = calls;
  // One call per sheet: while this photo's translation runs, the suggestion waits with the guard.
  const blocked = block.clipBusy || block.otherId !== null || ideaRunning;
  const state = paidButtonState(suggest, SUGGEST_LABEL, blocked, suggest.estimate?.worstMicros === 0);
  const suggestWhy = suggestRunning || ideaRunning ? ids.guard : block.clipBusy ? ids.clipBusy : (block.otherId ?? (suggest.priceError !== null ? ids.suggestPrice : undefined));
  const toggleWaits = suggestRunning || ideaRunning;
  // The new price is said until the next click's answer: a refusal of that click says its own words instead.
  const changed = suggest.previousWorst !== null && suggest.estimate !== null && suggest.error === null ? suggest.estimate.worstMicros : null;
  return (
    <>
      <div className="mc-actions">
        <button
          ref={suggestRef}
          type="button"
          className="btn btn-s mc-suggest"
          aria-busy={suggestRunning || undefined}
          aria-disabled={suggestRunning || !state.clickable || undefined}
          aria-describedby={suggestWhy}
          onClick={() => {
            if (!suggestRunning && state.clickable) calls.startSuggest();
          }}
        >
          {suggestRunning ? (
            <>
              <Spin />
              {SUGGESTING}
            </>
          ) : (
            <>
              <Icon name="sparkle" size={14} strokeWidth={2} />
              <span>
                {SUGGEST_LABEL} · <span className="mono">{state.price}</span>
              </span>
            </>
          )}
        </button>
        <button
          ref={toggleRef}
          type="button"
          className={idea.open ? "btn btn-s mc-idea-open mc-on" : "btn btn-s mc-idea-open"}
          aria-expanded={idea.open}
          aria-controls={ids.panel}
          aria-disabled={toggleWaits || undefined}
          aria-describedby={toggleWaits ? ids.guard : undefined}
          onClick={() => {
            if (!toggleWaits) idea.toggle();
          }}
        >
          <Icon name="pencil" size={14} strokeWidth={2} />
          {IDEA_OPEN}
        </button>
      </div>
      {block.clipBusy && (
        <p id={ids.clipBusy} className="field-hint mc-why">
          {nbDash(CLIP_BUSY)}
        </p>
      )}
      {calls.suggestNone !== null && (
        <QuietNotice tone={calls.suggestNone.free ? "info" : "warn"}>
          <MoneyText line={calls.suggestNone.line} />
        </QuietNotice>
      )}
      {changed !== null && (
        <QuietNotice tone="warn">
          Цена изменилась: теперь не больше <span className="mono">{formatUsdTiered(changed, "up")}</span>. Подтвердите ещё раз.
        </QuietNotice>
      )}
      {suggest.error !== null && <QuietNotice tone={errorTone(suggest.error)}>{nbDash(errorText(suggest.error))}</QuietNotice>}
      {suggest.priceError !== null && <PriceFailed id={ids.suggestPrice} error={suggest.priceError} onRetry={suggest.retryPrice} after={() => suggestRef.current} />}
    </>
  );
}

/** A refusal that only asks to wait or to choose again is a warning; a lost key, a broken ledger or a missing photo is a danger. */
export function errorTone(error: EngineError): "warn" | "danger" {
  return error.code === "IN_FLIGHT" || error.code === "BUDGET_EXCEEDED" || error.code === "RATE_LIMITED" || error.code === "VALIDATION" ? "warn" : "danger";
}
