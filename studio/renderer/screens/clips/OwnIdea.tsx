import { useEffect, useLayoutEffect, useRef, type ClipboardEvent, type KeyboardEvent } from "react";
import { OWN_IDEA_MAX } from "../../../shared/engine";
import { errorText } from "../../lib/errors";
import { nbDash } from "../../lib/format";
import { formatUsdTiered } from "../../lib/money";
import { Icon, Spin } from "../../ui/Icon";
import { paidButtonState, PriceFailed } from "../photos/scenePaid";
import {
  checkIdea,
  flattenLines,
  IDEA_FIELD,
  IDEA_HINT,
  IDEA_PLACEHOLDER,
  ideaFaultText,
  ideaNoneLine,
  insertIdeaText,
  rejectedPaidLine,
  rejectionText,
  TRANSLATE_LABEL,
  TRANSLATING,
} from "./motionModel";
import { errorTone, MoneyText, QuietNotice, type MotionBlock, type MotionCalls } from "./MotionSuggest";

// 5b.2 part C, S5.WC5 (plan s5b2 §5.3, §6 rows 63–63c, I5.67; mockups 63, 63a–63c and README §S5.WCD decisions 7–8): «Своя идея…» — the owner's idea in his words, translated by one paid call
// («Перевести · до $0.010», the engine's live estimate). SceneIdeaForm's parts: the label and the count against the limit, the field, the reason a text cannot be sent, the limits line, the button.
//  - The text is the contract's `OwnIdeaText` (1–300 characters, a letter, no control or format character — a ZWJ emoji included): «Перевести» waits until the text is one, and says why.
//  - Enter and pasted line breaks become spaces (the contract refuses a newline; Enter never buys anything).
//  - S5.WC2c: an idea that takes clothing off is accepted on every frame like any other (63c's refusal is gone); the window shows what the engine answered and decides nothing itself.
//  - A refusal is a line of the field, about its text (63b): ONE text, the first problem's in the contract's order. The focus goes into the field, which it describes — said once — and an edit ends it.
//    His full text never leaves the field and this call (I5.67).

interface OwnIdeaProps {
  readonly calls: MotionCalls;
  readonly block: MotionBlock;
  readonly ids: { readonly panel: string; readonly guard: string; readonly clipBusy: string };
}

export function OwnIdea({ calls, block, ids }: OwnIdeaProps) {
  const { idea, translate, ideaRunning, suggestRunning } = calls;
  const field = useRef<HTMLTextAreaElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  /** Where the caret goes after a text the window changed (Enter, a paste): React's own update would put it at the end. */
  const caret = useRef<number | null>(null);
  const base = ids.panel;
  const labelId = `${base}-l`;
  const fieldId = `${base}-ta`;
  const faultId = `${base}-bad`;
  const refusalId = `${base}-no`;
  const hintId = `${base}-hint`;
  const priceId = `${base}-price`;

  const check = checkIdea(idea.text);
  const fault = check.ok ? null : ideaFaultText(check.fault);
  const outcome = idea.outcome;
  // One call per sheet: while this photo's suggestion runs, «Перевести» waits with the guard.
  const blocked = block.clipBusy || block.otherId !== null || suggestRunning || !check.ok;
  // Round 2 (L8): a price of 0 is «бесплатно», never «до $0.000».
  const state = paidButtonState(translate, TRANSLATE_LABEL, blocked, translate.estimate?.worstMicros === 0);
  const why = ideaRunning || suggestRunning ? ids.guard : block.clipBusy ? ids.clipBusy : block.otherId !== null ? block.otherId : !check.ok ? (fault !== null ? faultId : hintId) : translate.priceError !== null ? priceId : undefined;
  // The new price is said until the next click's answer: a refusal of that click says its own words instead.
  const changed = translate.previousWorst !== null && translate.estimate !== null && translate.error === null ? translate.estimate.worstMicros : null;

  // The panel opened: the focus goes into the field (63).
  useEffect(() => {
    if (!idea.open) return;
    field.current?.focus();
    field.current?.closest(".mc-idea")?.scrollIntoView?.({ block: "nearest" });
  }, [idea.open]);

  // A refusal or an empty answer came back: the field, re-enabled once the call has ended, takes the focus and reads it — once per answer.
  const focused = useRef(0);
  useEffect(() => {
    if (idea.focusField === focused.current || ideaRunning) return;
    focused.current = idea.focusField;
    field.current?.focus();
  }, [idea.focusField, ideaRunning]);

  useLayoutEffect(() => {
    const at = caret.current;
    if (at === null || field.current === null) return;
    caret.current = null;
    field.current.setSelectionRange(at, at);
  });

  function insert(text: string): void {
    const el = field.current;
    if (el === null) return;
    const next = insertIdeaText(idea.text, el.selectionStart, el.selectionEnd, text, OWN_IDEA_MAX);
    caret.current = next.caret;
    idea.setText(next.value);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    // Enter buys nothing and breaks no line: it is a space (the contract refuses a newline).
    event.preventDefault();
    insert(" ");
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    const text = event.clipboardData.getData("text");
    if (!/[\r\n]/.test(text)) return;
    event.preventDefault();
    insert(text);
  }

  const describedBy = [fault !== null ? faultId : null, outcome !== null ? refusalId : null, hintId].filter((id): id is string => id !== null).join(" ");

  return (
    <section className="mc-idea" id={ids.panel} aria-labelledby={labelId} hidden={!idea.open}>
      <div className="field-row">
        <label className="fl" id={labelId} htmlFor={fieldId}>
          {IDEA_FIELD}
        </label>
        <span className="mono faint mc-count">
          {idea.text.length}/{OWN_IDEA_MAX}
        </span>
      </div>
      <textarea
        ref={field}
        id={fieldId}
        className="in scene-ta mc-ta"
        rows={3}
        maxLength={OWN_IDEA_MAX}
        placeholder={nbDash(IDEA_PLACEHOLDER)}
        aria-invalid={fault !== null || outcome !== null}
        aria-describedby={describedBy}
        value={idea.text}
        disabled={ideaRunning}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        // A line break that came in another way (a drop, an input method) is a space too.
        onChange={(event) => idea.setText(flattenLines(event.target.value))}
      />
      {fault !== null && (
        <p id={faultId} className="scene-idea-invalid">
          {fault}
        </p>
      )}
      {outcome !== null && (
        <div id={refusalId} className={outcome.kind === "none" && outcome.costMicros === 0 ? "mc-refusal mc-refusal-info" : "mc-refusal mc-refusal-warn"}>
          <Icon name={outcome.kind === "none" && outcome.costMicros === 0 ? "info" : "alert"} size={14} strokeWidth={2} />
          <div>
            {outcome.kind === "rejected" ? (
              <>
                <p>{nbDash(rejectionText(outcome.problems) ?? "")}</p>
                <span className="mc-paid">
                  <MoneyText line={rejectedPaidLine(outcome.costMicros)} />
                </span>
              </>
            ) : (
              <p>
                <MoneyText line={ideaNoneLine(outcome.costMicros)} />
              </p>
            )}
          </div>
        </div>
      )}
      <div className="mc-idea-foot">
        <p id={hintId} className="field-hint mc-hint">
          {IDEA_HINT}
        </p>
        <button
          ref={button}
          type="button"
          className="btn btn-s mc-translate"
          aria-busy={ideaRunning || undefined}
          aria-disabled={ideaRunning || !state.clickable || undefined}
          aria-describedby={why}
          onClick={() => {
            if (!ideaRunning && state.clickable) calls.startTranslate();
          }}
        >
          {ideaRunning ? (
            <>
              <Spin />
              {TRANSLATING}
            </>
          ) : (
            <span>
              {TRANSLATE_LABEL} · <span className="mono">{state.price}</span>
            </span>
          )}
        </button>
      </div>
      {changed !== null && (
        <QuietNotice tone="warn">
          Цена изменилась: теперь не больше <span className="mono">{formatUsdTiered(changed, "up")}</span>. Подтвердите ещё раз.
        </QuietNotice>
      )}
      {translate.error !== null && <QuietNotice tone={errorTone(translate.error)}>{nbDash(errorText(translate.error))}</QuietNotice>}
      {translate.priceError !== null && <PriceFailed id={priceId} error={translate.priceError} onRetry={translate.retryPrice} after={() => button.current} />}
    </section>
  );
}
