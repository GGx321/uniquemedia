import { useEffect, useId, type ReactNode } from "react";
import type { DescriptorCheck } from "../../../shared/engine";
import { errorSettingsFocus, errorText, settingsLinkLabel } from "../../lib/errors";
import { formatUsdTiered } from "../../lib/money";
import { useNavigate } from "../../navigation";
import { Icon, Spin } from "../../ui/Icon";
import { Notice } from "../../ui/Notice";
import { useAnnouncer } from "../../ui/useAnnouncer";
import { aspectRows, CHECK_HELD_REASON, lastLine, mismatchTitle, textMismatch, whenLabel, type AspectRow } from "./lookModel";
import type { LookCheck } from "./useLookCheck";

// S5.0d: «Сверка с фото» (.omc/stage5/design 07, 09–13): what the check compares, its verdict per aspect, and the one paid button with its worst case
// on the second line. The verdict never changes the description: a proposal is offered in «Описание», beside it.

function AspectList({ rows }: { rows: readonly AspectRow[] }) {
  return (
    <ul className="chk-aspects" aria-label="Что сверяется">
      {rows.map((row) => (
        <li key={row.aspect} className={`chk-a chk-a-${row.mark}`}>
          <span className="chk-ic" aria-hidden="true">
            {row.mark === "ok" ? (
              <Icon name="check" size={14} strokeWidth={2.6} />
            ) : row.mark === "bad" ? (
              <Icon name="close" size={14} strokeWidth={2.6} />
            ) : row.mark === "wait" ? (
              <span className="chk-dot" />
            ) : (
              <Icon name="minus" size={14} strokeWidth={2.4} />
            )}
          </span>
          <div>
            <span className="chk-a-name">{row.label}</span>
            {row.note !== null ? <span className="chk-a-note"> {row.note}</span> : <span className="sr-only"> — {row.spoken}</span>}
            {(row.said !== null || row.seen !== null) && (
              <div className="chk-diff">
                {row.said !== null && (
                  <p>
                    <span>В описании:</span> {row.said}
                  </p>
                )}
                {row.seen !== null && (
                  <p className="chk-diff-photo">
                    <span>На фото:</span> {row.seen}
                  </p>
                )}
              </div>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function Verdict({ tone, title, sub }: { tone: "ok" | "bad"; title: string; sub: string }) {
  return (
    <div className={`chk-verdict chk-verdict-${tone}`}>
      <span className="chk-verdict-ic" aria-hidden="true">
        <Icon name={tone === "ok" ? "check" : "alert"} size={16} strokeWidth={tone === "ok" ? 2.4 : 2} />
      </span>
      <div>
        <p className="chk-verdict-title">{title}</p>
        <p className="mono chk-verdict-sub">{sub}</p>
      </div>
    </div>
  );
}

function Pointer({ children }: { children: ReactNode }) {
  return (
    <p className="chk-pointer">
      <Icon name="info" size={14} strokeWidth={2} />
      <span>{children}</span>
    </p>
  );
}

/** What a finished check says under its aspects: where its proposal is, what became of it, or that the description moved on since. */
/**
 * S5.R2: the check judged the body (it was in the photo) and her body phrase is not the one it judged: «Сохранить тело» since then left the body
 * verdict stale. A verdict that could not see the body is not changed by it.
 */
function bodyChangedSince(check: DescriptorCheck, judged: string | undefined, current: string | undefined): boolean {
  const state = check.aspects.body?.state;
  return (state === "ok" || state === "mismatch") && judged !== current;
}

function afterword(check: DescriptorCheck, look: LookCheck, currentText: string, bodyChanged: boolean): ReactNode {
  if (check.checkedText !== currentText) return <Pointer>Описание изменено после сверки — проверьте ещё раз.</Pointer>;
  const stale = bodyChanged ? <Pointer>Тело изменено после сверки — проверьте ещё раз.</Pointer> : null;
  if (look.fate === "kept" || look.fate === "stale") {
    return (
      <>
        <Pointer>{look.fate === "kept" ? "Описание оставлено как было." : "Описание уже изменилось — проверьте ещё раз."}</Pointer>
        {stale}
      </>
    );
  }
  if (check.matches) return stale;
  const text =
    check.proposal !== null ? (
      <Pointer>Исправленный текст — в «Описании» справа. Сам он не применится.</Pointer>
    ) : textMismatch(check) ? (
      <Pointer>Готового исправления нет — поправьте описание сами: «Изменить текст» справа.</Pointer>
    ) : null;
  // S5.2d: a body mismatch is never fixed in text (S5.0c): it goes to the body traits, and the build word (D1) to the description's own text — unless
  // the body was saved since, and then only a new check can say whether it matches now.
  const body =
    stale ?? (check.aspects.body?.state === "mismatch" ? <Pointer>Тело на фото другое — поправьте его в карточке «Тело» справа, а телосложение — в «Описании».</Pointer> : null);
  return text === null && body === null ? null : (
    <>
      {text}
      {body}
    </>
  );
}

/** Whether a proposal still waits for «Исправить описание» or «Оставить» in «Описание»: the card then ends at its pointer, as the mockup's 10 does. */
export function proposalOpen(look: LookCheck, currentText: string): DescriptorCheck | null {
  const { phase } = look;
  if (phase.kind !== "done" || look.fate !== "open") return null;
  const { check } = phase;
  return check.proposal !== null && check.checkedText === currentText ? check : null;
}

export function CheckCard({
  look,
  currentText,
  currentBodyPhrase,
  model,
  blockedReason,
  keyMissing,
  held,
}: {
  look: LookCheck;
  /** The description as stored now: a verdict about an older text says so. */
  currentText: string;
  /** Her body phrase as stored now (S5.R2): a body verdict about an older body says so. */
  currentBodyPhrase: string | undefined;
  /** «grok-4.3»: the settings' text model, which runs the check. */
  model: string | null;
  /** Why no paid command can go now (no key, offline, a halt), or null. */
  blockedReason: string | null;
  /** The reason is the key: the card offers «Открыть ключ в Настройках». */
  keyMissing: boolean;
  /** A photo run or another job of hers is under way: the check would be refused IN_FLIGHT. */
  held: boolean;
}) {
  const navigate = useNavigate();
  const whyId = useId();
  const [said, say] = useAnnouncer();
  const { phase, estimate } = look;
  const running = phase.kind === "running";

  // What the card has come to, said once per check (the verdict itself is no live region: it is drawn again on every render).
  useEffect(() => {
    if (phase.kind === "done") say(phase.check.matches ? "Сверка: описание совпадает с фото" : `Сверка: ${mismatchTitle(phase.check).toLowerCase()}`);
    else if (phase.kind === "failed") say(phase.error.code === "IN_FLIGHT" ? CHECK_HELD_REASON : phase.error.code === "PRICE_CHANGED" ? "Цена сверки выросла" : "Сверка не прошла");
  }, [phase, say]);

  const worst = estimate === null ? "до …" : `до ${formatUsdTiered(estimate.worstMicros, "up")}`;
  const heldNow = held || (phase.kind === "failed" && phase.error.code === "IN_FLIGHT");
  const reason = blockedReason ?? (held ? CHECK_HELD_REASON : null);
  const disabled = running || estimate === null || reason !== null;
  const priceChanged = phase.kind === "failed" && phase.error.code === "PRICE_CHANGED" && look.previousWorst !== null && estimate !== null;

  const label = running
    ? "Проверяем…"
    : priceChanged
      ? "Подтвердить новую цену"
      : phase.kind === "failed"
        ? "Повторить сверку"
        : phase.kind === "done"
          ? "Проверить снова"
          : "Проверить описание";

  const button = (
    <button
      type="button"
      className={priceChanged ? "btn btn-p btn-stack" : "btn btn-stack"}
      disabled={disabled}
      aria-busy={running}
      aria-describedby={reason !== null && !running ? whyId : undefined}
      onClick={() => look.run()}
    >
      <span className="btn-stack-line">
        {running && <Spin />}
        {label}
      </span>
      {!running && (
        <>
          <span className="sr-only"> · </span>
          <span className="mono">{worst}</span>
        </>
      )}
    </button>
  );

  const why =
    reason !== null && !running ? (
      blockedReason !== null ? (
        <>
          <p id={whyId} className="field-hint">
            {blockedReason}
          </p>
          {keyMissing && (
            <button type="button" className="btn btn-s chk-settings" onClick={() => navigate({ name: "settings", focus: "key" })}>
              Открыть ключ в Настройках
            </button>
          )}
        </>
      ) : (
        <p id={whyId} className="chk-held">
          <Icon name="alert" size={14} strokeWidth={2} />
          <span>{CHECK_HELD_REASON}</span>
        </p>
      )
    ) : null;

  const head = (
    <div className="card-head">
      <h2 className="card-title">Сверка с фото</h2>
      {model !== null && <span className="mono faint">{model}</span>}
    </div>
  );
  const live = (
    <p className="sr-only" role="status">
      {said}
    </p>
  );
  // The price could not be had: the paid button waits («до …»), and this asks for it again (free).
  const priceTrouble =
    look.estimateError !== null && estimate === null && !look.estimating ? (
      <Notice
        tone="danger"
        title="Цена сверки неизвестна"
        role="status"
        actions={
          <button type="button" className="btn btn-s" onClick={() => look.reprice()}>
            Повторить
          </button>
        }
      >
        {errorText(look.estimateError)}
      </Notice>
    ) : null;

  if (phase.kind === "running") {
    return (
      <section className="card chk" aria-label="Сверка с фото" aria-busy="true">
        {head}
        <div className="job-progress chk-progress">
          <span className="job-progress-label">{phase.context === "import" ? "Сверяем прочитанное с фото…" : "Сверяем описание с фото…"}</span>
          <div className="bar bar-indet" aria-hidden="true">
            <span />
          </div>
          <span className="mono muted">{worst} · несколько секунд</span>
        </div>
        <AspectList rows={aspectRows(null)} />
        {button}
        {live}
      </section>
    );
  }

  if (phase.kind === "done") {
    const { check } = phase;
    const sub = whenLabel(phase.context, phase.at);
    const applied = look.fate === "applied";
    const waiting = proposalOpen(look, currentText) !== null;
    return (
      <section className={check.matches || applied ? "card chk" : "card chk chk-bad"} aria-label="Сверка с фото">
        {head}
        {applied ? (
          <>
            <Verdict tone="ok" title="Описание исправлено по сверке" sub={sub} />
            <Pointer>Проверьте ещё раз, чтобы убедиться, что теперь оно совпадает с фото.</Pointer>
          </>
        ) : (
          <>
            <Verdict tone={check.matches ? "ok" : "bad"} title={check.matches ? "Описание совпадает с фото" : mismatchTitle(check)} sub={sub} />
            <AspectList rows={aspectRows(check)} />
            {afterword(check, look, currentText, bodyChangedSince(check, phase.bodyPhrase, currentBodyPhrase))}
          </>
        )}
        {!waiting && button}
        {!waiting && why}
        {!waiting && priceTrouble}
        {live}
      </section>
    );
  }

  if (phase.kind === "failed") {
    const { error } = phase;
    const focus = errorSettingsFocus(error.code);
    return (
      <section className="card chk" aria-label="Сверка с фото">
        {head}
        {priceChanged && look.previousWorst !== null && estimate !== null ? (
          <Notice tone="warn" title="Цена выросла" role="status">
            Было не больше {formatUsdTiered(look.previousWorst, "up")}, теперь не больше {formatUsdTiered(estimate.worstMicros, "up")}. Подтвердите новую цену.
          </Notice>
        ) : error.code === "IN_FLIGHT" ? null : (
          <Notice
            tone="danger"
            title="Сверка не прошла"
            role="status"
            actions={
              focus !== null && !keyMissing ? (
                <button type="button" className="btn btn-s" onClick={() => navigate({ name: "settings", focus })}>
                  {settingsLinkLabel(focus)}
                </button>
              ) : undefined
            }
          >
            {errorText(error)}
          </Notice>
        )}
        <p className="mono faint chk-last">{lastLine(look.last)}</p>
        {button}
        {heldNow && reason === null ? (
          <p className="chk-held">
            <Icon name="alert" size={14} strokeWidth={2} />
            <span>{CHECK_HELD_REASON}</span>
          </p>
        ) : (
          why
        )}
        {priceTrouble}
        {live}
      </section>
    );
  }

  return (
    <section className="card chk" aria-label="Сверка с фото">
      {head}
      {phase.kind === "missed" ? (
        <Notice tone="warn" title="Сверка при импорте не прошла" role="status">
          Аватар сохранён, описание прочитано с фото. Сверить его с фото можно здесь.
        </Notice>
      ) : (
        blockedReason === null && <p className="chk-text">Сравнивает описание с мастер-портретом: волосы, глаза, приметы и тело, если оно в кадре. Сама ничего не меняет.</p>
      )}
      <p className="mono faint chk-last">{lastLine(look.last)}</p>
      {button}
      {why ??
        (estimate !== null && (
          <p className="field-hint">
            ожидаемая ≈ <span className="mono">{formatUsdTiered(estimate.expectedMicros, "nearest")}</span> · один запрос с мастер-портретом
          </p>
        ))}
      {priceTrouble}
      {live}
    </section>
  );
}
