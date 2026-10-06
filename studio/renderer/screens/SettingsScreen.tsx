import { type ReactNode, type Ref, useEffect, useId, useRef, useState } from "react";
import {
  AbsolutePath,
  ApiKey,
  AGE_CHECK_FALLBACK_PRICE,
  MusicKey,
  NetworkConcurrency,
  type ApiKeyStatus,
  type EngineError,
  type ImageModelCatalogue,
  type ImageModelEntry,
  type ImageQuality,
  type MoneyStatus,
  type MusicKeyStatus,
  type MusicStatus,
  type OpenMoneyStatus,
  type ReconcileReason,
  type ReconcileResult,
  type Settings,
} from "../../shared/engine";
import { useEngine, useEngineView } from "../engine/react";
import { isActiveJob, type SyncPhase } from "../engine/store";
import { errorText } from "../lib/errors";
import { EXPORT_UNAVAILABLE_TITLE, LIBRARY_RENDER_BUSY_TEXT, pickedNotice, refusedPickText, unavailableText, type PickedNotice } from "../lib/exportFolder";
import { countOf, monthName, NBSP, waitLabel } from "../lib/format";
import { catalogueFreshMs, modelOptionLabel, photoPriceMicros, qualityOptionLabel } from "../lib/imageModels";
import { dollarsInputValue, formatUsd, formatUsdRange, parseDollars, type DollarsParse } from "../lib/money";
import { listLine, musicFailureText, quotaView, recoveryText, refreshGate, refreshLabel, refusalText } from "../lib/music";
import { paidStop, restartStopText } from "../lib/paidStop";
import { bound } from "../lib/traits";
import { type SettingsFocus, useNavigate } from "../navigation";
import { Icon, Spin } from "../ui/Icon";
import { ErrorNotice, Notice } from "../ui/Notice";
import { EngineOffline } from "../ui/EngineOffline";
import { ScreenTitle } from "../ui/ScreenTitle";
import { draftTitle } from "./montage/labels";
import { useDraftSessions } from "./montage/sessions";

/**
 * `/credits` is account-wide, so a difference up to $0.01 from the ledger is
 * not flagged. Mirrors RECONCILE_TOLERANCE_MICROS in studio/engine/money: the
 * contract's ReconcileResult carries both totals but no verdict.
 */
export const RECONCILE_TOLERANCE_MICROS = 10_000;

/** The contract's range (the queue shrinks the value itself on 429). */
export const MIN_CONCURRENCY = bound(NetworkConcurrency.minValue, "minimum network concurrency");
export const MAX_CONCURRENCY = bound(NetworkConcurrency.maxValue, "maximum network concurrency");

/** A status line's colour: the sheet's status tokens. */
type Tone = "ok" | "warn" | "info" | "danger";
const TONE: Record<Tone, string> = { ok: "var(--ok)", warn: "var(--warn)", info: "var(--info)", danger: "var(--danger)" };

function Card({ title, id, children, headingRef }: { title: string; id: string; children: ReactNode; headingRef?: Ref<HTMLHeadingElement> }) {
  return (
    <section className="card settings-card" aria-labelledby={id}>
      <h2 id={id} ref={headingRef} className="card-title" tabIndex={-1}>
        {title}
      </h2>
      {children}
    </section>
  );
}

interface RowProps {
  label: string;
  /** The control the label names; without it the label is plain text (`b`). */
  labelFor?: string;
  labelId?: string;
  /** A path in mono under the label, a line of its own before the hint (the sheet's «Готовые видео» row). */
  path?: { id: string; text: string };
  hint?: ReactNode;
  hintId?: string;
  /** A hint that reports a result (`status`) or a problem (`alert`) rather than explaining the row. */
  hintRole?: "status" | "alert";
  hintTone?: Tone;
  children?: ReactNode;
}

/** The sheet's settings row: `.row` with the name and hint (`.rl`) on the left and the control on the right. */
function Row({ label, labelFor, labelId, path, hint, hintId, hintRole, hintTone, children }: RowProps) {
  return (
    <div className="row">
      <div className="rl">
        {labelFor ? (
          <label id={labelId} htmlFor={labelFor}>
            {label}
          </label>
        ) : (
          <b id={labelId}>{label}</b>
        )}
        {path !== undefined && (
          <span id={path.id} className="mono rl-path">
            {path.text}
          </span>
        )}
        {/* Keyed on its role: a result or a problem arrives as a fresh live region, which screen readers announce reliably. */}
        {hint !== undefined && (
          <span key={hintRole ?? "hint"} id={hintId} role={hintRole} style={hintTone ? { color: TONE[hintTone] } : undefined}>
            {hint}
          </span>
        )}
      </div>
      {children !== undefined && <div className="row-control">{children}</div>}
    </div>
  );
}

// ---------- OpenRouter key ----------

interface KeyState {
  tone: Tone | null;
  icon: "lock" | "alert" | null;
  hint: string;
  /** The longer explanation, as a notice under the row, when the state needs one. */
  notice: { title?: string; text: string } | null;
}

function keyState(status: ApiKeyStatus): KeyState {
  if (!status.encryptionAvailable) {
    return {
      tone: "danger",
      icon: "alert",
      hint: "шифрование недоступно — ключ не сохраняется",
      notice: {
        title: "Системное шифрование недоступно",
        text:
          "Studio хранит ключ только зашифрованным (safeStorage), а сейчас система не даёт шифровать — поэтому ключ не сохраняется. " +
          "На macOS разблокируйте Связку ключей, на Windows войдите в свою учётную запись, затем перезапустите Studio.",
      },
    };
  }
  if (status.rejected) {
    return {
      tone: "danger",
      icon: "alert",
      hint: "OpenRouter отклонил ключ (401)",
      notice: { text: "Генерация остановлена и сама не повторяется. Замените ключ — например, если старый отозван или истёк." },
    };
  }
  if (status.stored) return { tone: "ok", icon: "lock", hint: "зашифрован системой", notice: null };
  return { tone: null, icon: null, hint: "не задан · ключ создаётся на openrouter.ai в разделе Keys", notice: null };
}

function ApiKeyRow({ status }: { status: ApiKeyStatus }) {
  const { client, store } = useEngine();
  const inputId = useId();
  const issueId = useId();
  const [editing, setEditing] = useState(false);
  const [typed, setTyped] = useState("");
  const [issue, setIssue] = useState<string | null>(null);
  const [error, setError] = useState<EngineError | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLButtonElement>(null);
  // Set when a user action removes the focused control; the effect moves focus to its successor.
  const [focusNext, setFocusNext] = useState<"input" | "replace" | null>(null);
  const showInput = editing || !status.stored;
  const state = keyState(status);

  useEffect(() => {
    if (focusNext === null) return;
    (focusNext === "input" ? inputRef.current : replaceRef.current)?.focus();
    setFocusNext(null);
  }, [focusNext, showInput]);

  async function save(): Promise<void> {
    const parsed = ApiKey.safeParse(typed.trim());
    if (!parsed.success) {
      setIssue("Ключ — от 8 печатных символов без пробелов (обычно начинается с sk-or-).");
      return;
    }
    // The typed key leaves React state before the request goes out; only its status comes back.
    setTyped("");
    setIssue(null);
    setError(null);
    setBusy(true);
    const reply = await client.request("settings.setApiKey", { key: parsed.data });
    setBusy(false);
    if (reply.ok) {
      store.setApiKey(reply.result);
      setEditing(false);
      setFocusNext(reply.result.stored ? "replace" : "input");
    } else setError(reply.error);
  }

  async function clear(): Promise<void> {
    setBusy(true);
    setError(null);
    const reply = await client.request("settings.clearApiKey", {});
    setBusy(false);
    if (reply.ok) {
      store.setApiKey(reply.result);
      setFocusNext("input");
    } else setError(reply.error);
  }

  return (
    <>
      <Row
        label="API-ключ"
        labelFor={showInput ? inputId : undefined}
        hintRole="status"
        // A stored key reads as the sheet has it: a muted line behind a green lock; a problem colours the whole line.
        hintTone={state.tone === "ok" ? undefined : (state.tone ?? undefined)}
        hint={
          <span className={state.tone === "ok" ? "key-hint key-hint-ok" : "key-hint"}>
            {state.icon && <Icon name={state.icon} size={12} strokeWidth={2.2} />}
            {state.hint}
          </span>
        }
      >
        {status.stored && !showInput && (
          <>
            {/* Only the last four characters ever reach the window; the rest is a mask, never the key. */}
            <input
              className="in in-s key-field"
              type="text"
              readOnly
              value={`••••••${status.last4 ?? ""}`}
              aria-label={`Ключ, последние символы ${status.last4 ?? ""}`}
            />
            <button
              ref={replaceRef}
              type="button"
              className="btn btn-s"
              onClick={() => {
                setEditing(true);
                setFocusNext("input");
              }}
              disabled={busy}
            >
              Заменить
            </button>
            <button type="button" className="btn btn-s" onClick={() => void clear()} disabled={busy} aria-busy={busy}>
              {busy ? (
                <>
                  <Spin />
                  Удаляем…
                </>
              ) : (
                "Удалить"
              )}
            </button>
          </>
        )}
        {showInput && (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <input
              ref={inputRef}
              id={inputId}
              className="in in-s key-field"
              type="password"
              value={typed}
              placeholder="sk-or-v1-…"
              autoComplete="off"
              spellCheck={false}
              disabled={!status.encryptionAvailable || busy}
              aria-invalid={issue !== null}
              aria-describedby={issue ? issueId : undefined}
              onChange={(e) => setTyped(e.currentTarget.value)}
            />
            <button
              type="submit"
              className="btn btn-s btn-p"
              aria-label="Сохранить ключ"
              aria-busy={busy}
              disabled={!status.encryptionAvailable || busy || typed.trim() === ""}
            >
              {busy ? (
                <>
                  <Spin />
                  Сохраняем…
                </>
              ) : (
                "Сохранить"
              )}
            </button>
            {status.stored && (
              <button
                type="button"
                className="btn btn-s"
                onClick={() => {
                  setEditing(false);
                  setTyped("");
                  setIssue(null);
                  setFocusNext("replace");
                }}
              >
                Отмена
              </button>
            )}
          </form>
        )}
      </Row>
      {state.notice && (
        <Notice tone="danger" title={state.notice.title}>
          {state.notice.text}
        </Notice>
      )}
      {issue && (
        <p id={issueId} className="field-error" role="alert">
          {issue}
        </p>
      )}
      {error && <ErrorNotice error={error} />}
    </>
  );
}

// ---------- money ----------

const BUDGET_ISSUES: Record<Exclude<DollarsParse, { ok: true }>["reason"], string> = {
  empty: "Введите сумму в долларах, например 10 или 12.50.",
  format: "Только число: например 10 или 12.50.",
  precision: "Не больше двух знаков после точки — до центов.",
  zero: "Бюджет должен быть больше нуля.",
  "too-large": "Не больше $10 000 в месяц.",
};

const REASON_TEXT: Record<ReconcileReason, string> = {
  "open-reserves": "после перезапуска остались незакрытые резервы — их итог неизвестен",
  "torn-ledger-line": "последняя строка журнала расходов обрезана (например, при сбое питания)",
};

const CLOCK_SKEW_TEXT = "системные часы отстают от журнала — ожидание посчитано по внутреннему таймеру, а не по часам";

/** "$10.00": the budget field shows the dollar sign, as the sheet does; parseDollars accepts it back. */
function budgetText(micros: number): string {
  return `$${dollarsInputValue(micros)}`;
}

function BudgetRow({ settings }: { settings: Settings }) {
  const { client, store } = useEngine();
  const inputId = useId();
  const hintId = useId();
  const [text, setText] = useState(() => budgetText(settings.monthlyBudgetMicros));
  const [dirty, setDirty] = useState(false);
  const [issue, setIssue] = useState<string | null>(null);
  const [error, setError] = useState<EngineError | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!dirty) setText(budgetText(settings.monthlyBudgetMicros));
  }, [settings.monthlyBudgetMicros, dirty]);

  async function save(): Promise<void> {
    // Enter on an unchanged amount has nothing to save (the button is not even shown then).
    if (!dirty) return;
    const parsed = parseDollars(text);
    if (!parsed.ok) {
      setIssue(BUDGET_ISSUES[parsed.reason]);
      return;
    }
    setIssue(null);
    setError(null);
    setBusy(true);
    const reply = await client.request("settings.setBudget", { monthlyBudgetMicros: parsed.micros });
    setBusy(false);
    if (reply.ok) {
      store.setSettings(reply.result);
      setDirty(false);
      setSaved(true);
      setText(budgetText(reply.result.monthlyBudgetMicros));
      // The save button goes away with the change it saved: focus stays with the amount, not on the page.
      inputRef.current?.focus();
    } else setError(reply.error);
  }

  const hint = issue ?? (saved && !dirty ? `сохранён: ${formatUsd(settings.monthlyBudgetMicros)} в месяц` : "календарный месяц по UTC · запрос сверх бюджета не отправляется");

  return (
    <>
      <Row
        label="Бюджет на месяц"
        labelFor={inputId}
        hint={hint}
        hintId={hintId}
        hintRole={issue ? "alert" : saved && !dirty ? "status" : undefined}
        hintTone={issue ? "danger" : saved && !dirty ? "ok" : undefined}
      >
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input
            ref={inputRef}
            id={inputId}
            className="in in-s budget-field"
            type="text"
            inputMode="decimal"
            value={text}
            autoComplete="off"
            aria-invalid={issue !== null}
            aria-describedby={hintId}
            onChange={(e) => {
              setText(e.currentTarget.value);
              setDirty(true);
              setSaved(false);
              setIssue(null);
            }}
          />
          {dirty && (
            <button type="submit" className="btn btn-s btn-p" aria-label="Сохранить бюджет" aria-busy={busy} disabled={busy}>
              {busy ? (
                <>
                  <Spin />
                  Сохраняем…
                </>
              ) : (
                "Сохранить"
              )}
            </button>
          )}
        </form>
      </Row>
      {error && <ErrorNotice error={error} />}
    </>
  );
}

function MoneyStatusRows({ money }: { money: OpenMoneyStatus }) {
  const budget = money.monthlyBudgetMicros;
  const spentShare = budget > 0 ? Math.min(100, (money.spentMicros / budget) * 100) : 100;
  const reservedShare = budget > 0 ? Math.min(100 - spentShare, (money.unsettledMicros / budget) * 100) : 0;
  return (
    <>
      <div className="row">
        <div className="rl rl-meter">
          <b>{monthName(money.month)} · потрачено</b>
          {/* Spent in the accent, open reserves at their worst case in the accent at 40 %. */}
          <div className="bar" aria-hidden="true">
            <span style={{ width: `${spentShare}%` }} />
            <span style={{ width: `${reservedShare}%`, background: "var(--accent-40)" }} />
          </div>
        </div>
        <span className="mono money-figure">
          {formatUsd(money.spentMicros)} <span className="faint">из {formatUsd(budget)}</span>
        </span>
      </div>
      <Row label="Незакрытые резервы" hint="запросы без итога считаются по худшей цене до сверки">
        <span className="mono row-value">
          {money.unsettledCount === 0
            ? "нет"
            : `${countOf(money.unsettledCount, ["резерв", "резерва", "резервов"])} · до ${formatUsd(money.unsettledMicros, 2, "up")}`}
        </span>
      </Row>
    </>
  );
}

/**
 * A finished reconcile as the row's hint: the verdict first — «сверено…
 * сходится», «расхождение…», or why there is nothing to compare — then
 * anything else the reconcile did (reserves closed at their worst case, the
 * torn ledger line moved aside) and any warning about how it was measured.
 */
function doneStatus(result: Extract<ReconcileResult, { status: "done" }>): { text: string; tone: Tone } {
  const ledger = `журнал ${formatUsd(result.ledgerDeltaMicros, 4)}`;
  const credits = result.creditsDeltaMicros;
  const parts: string[] = [];
  let tone: Tone;
  if (credits === null) {
    tone = "info";
    parts.push(
      result.deltaUnavailable === "negative-delta"
        ? `сравнение недостоверно: расход по /credits за это окно ушёл в минус, а /credits общий для всего аккаунта · ${ledger}`
        : `первая сверка: сравнить с /credits не с чем · ${ledger}`,
    );
  } else {
    const diff = Math.abs(credits - result.ledgerDeltaMicros);
    const totals = `/credits ${formatUsd(credits, 4)} · ${ledger}`;
    if (diff > RECONCILE_TOLERANCE_MICROS) {
      tone = "warn";
      parts.push(
        credits > result.ledgerDeltaMicros
          ? `расхождение ${formatUsd(diff, 4)}: ${totals} — ключом пользовались вне Studio?`
          : `расхождение ${formatUsd(diff, 4)}: ${totals} — в журнале больше: резервы закрыты по худшей цене, фактически списано меньше`,
      );
    } else {
      tone = "ok";
      parts.push(`сверено: ${totals} — сходится`);
    }
  }
  if (result.closedReserves > 0) parts.push(`закрыто по худшей цене: ${countOf(result.closedReserves, ["резерв", "резерва", "резервов"])}`);
  if (result.tornLineMoved) parts.push("обрезанная строка журнала перенесена в ledger.torn");
  if (result.warnings.includes("clock-skew")) parts.push(CLOCK_SKEW_TEXT);
  return { text: parts.join(" · "), tone };
}

function ReconcileBlock({ phase, money, engineError }: { phase: SyncPhase; money: MoneyStatus; engineError: EngineError | null }) {
  const { client, store } = useEngine();
  const [result, setResult] = useState<ReconcileResult | null>(null);
  const [error, setError] = useState<EngineError | null>(null);
  const [busy, setBusy] = useState(false);
  const [readyAt, setReadyAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const stop = paidStop({ phase, money, engineError });
  const aboveWorst = engineError?.code === "SETTLE_ABOVE_WORST" || (money.ledger === "open" && money.halt?.cause === "SETTLE_ABOVE_WORST");
  const needed = stop?.kind === "reconcile";
  const waiting = readyAt !== null && now < readyAt;

  useEffect(() => {
    if (readyAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [readyAt]);

  async function reconcile(): Promise<void> {
    setBusy(true);
    setError(null);
    const reply = await client.request("money.reconcile", {});
    setBusy(false);
    if (!reply.ok) {
      setError(reply.error);
      return;
    }
    setResult(reply.result);
    if (reply.result.status === "too-early") {
      const at = Date.now();
      setNow(at);
      setReadyAt(at + reply.result.retryAfterMs);
    } else {
      setReadyAt(null);
      // A reconcile can lift halts that only a fresh snapshot clears (an above-worst engine error, the reasons).
      store.reload();
    }
  }

  // A ledger that cannot be read, or a failed write: a reconcile needs a sound ledger, so none is offered.
  if (stop?.kind === "restart") {
    return (
      <Notice tone="danger" title="Сверка недоступна">
        <p>{restartStopText(stop.code)}</p>
        <p>Сверка тут не поможет: ей нужен исправный журнал расходов.</p>
      </Notice>
    );
  }

  let status: { text: string; tone?: Tone } | null = null;
  if (result?.status === "too-early" && waiting && readyAt !== null) {
    const early = `OpenRouter ещё не обновил расход · сверить можно через ${waitLabel(readyAt - now)}`;
    status = { text: result.warnings.includes("clock-skew") ? `${early} · ${CLOCK_SKEW_TEXT}` : early };
  } else if (result?.status === "too-early" && result.warnings.includes("clock-skew")) {
    // The countdown ended, but the warning it was shown with is still true:
    // it must stay visible, not vanish just because `waiting` flipped to false.
    status = { text: CLOCK_SKEW_TEXT };
  } else if (result?.status === "done") {
    status = doneStatus(result);
  }

  return (
    <>
      {needed && (
        <Notice tone="warn" title="Нужна сверка расходов">
          <p>Платные запросы остановлены до сверки. Причины:</p>
          <ul className="reason-list">
            {money.reconcileReasons.map((r) => (
              <li key={r}>{REASON_TEXT[r]}</li>
            ))}
            {aboveWorst && <li>списание оказалось выше зарезервированного максимума</li>}
          </ul>
        </Notice>
      )}
      <Row
        label="Сверка с OpenRouter"
        hint={status?.text ?? `сравнивает расход по /credits с журналом и закрывает резервы по худшей цене · через 2${NBSP}мин после последнего запроса`}
        hintRole={status ? "status" : undefined}
        hintTone={status?.tone}
      >
        <button
          type="button"
          className={needed ? "btn btn-s btn-p" : "btn btn-s"}
          onClick={() => void reconcile()}
          disabled={busy || waiting}
          aria-busy={busy}
        >
          {busy ? <Spin /> : <Icon name="scale" size={14} />}
          {busy ? "Сверяем…" : "Сверить"}
        </button>
      </Row>
      {error && <ErrorNotice error={error} />}
    </>
  );
}

// ---------- models, performance, folders ----------

function ConcurrencyRow({ settings }: { settings: Settings }) {
  const { client, store } = useEngine();
  const labelId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<EngineError | null>(null);
  const value = settings.concurrency.network;

  async function change(requested: number): Promise<void> {
    // Clamped, so a value stored outside the range still steps back into it.
    const next = Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, requested));
    if (next === value) return;
    setBusy(true);
    setError(null);
    const reply = await client.request("settings.setConcurrency", { network: next });
    setBusy(false);
    if (reply.ok) store.setSettings(reply.result);
    else setError(reply.error);
  }

  return (
    <>
      <div className="row">
        <div className="rl">
          <b id={labelId}>Параллельных генераций</b>
          <span>
            от {MIN_CONCURRENCY} до {MAX_CONCURRENCY} · на 429 уменьшается сама
          </span>
        </div>
        <div className="row-control row-control-tight" role="group" aria-labelledby={labelId}>
          <button type="button" className="ibtn" aria-label="Меньше" onClick={() => void change(value - 1)} disabled={busy || value <= MIN_CONCURRENCY}>
            <Icon name="minus" size={12} strokeWidth={2.6} />
          </button>
          <output className="mono stepper-value" aria-live="polite" aria-labelledby={labelId}>
            {value}
          </output>
          <button type="button" className="ibtn" aria-label="Больше" onClick={() => void change(value + 1)} disabled={busy || value >= MAX_CONCURRENCY}>
            <Icon name="plus" size={12} strokeWidth={2.6} />
          </button>
        </div>
      </div>
      {error && <ErrorNotice error={error} />}
    </>
  );
}

// One image age check at the dated fallback table (AGE_CHECK_FALLBACK_PRICE:
// the AGE_CHECK_CALL price a candidate's or a run photo's check pays). «до» means
// a hard cap everywhere else in the app, but the fallback table is only used
// when OpenRouter did not answer — the live price can be higher — so this is
// «≈» (nearest, not rounded up): a range from the expected price to the worst
// case, not the worst case alone prefixed with «≈» (which would overstate the
// approximate cost).
const AGE_CHECK_PRICE = formatUsdRange(AGE_CHECK_FALLBACK_PRICE.expectedMicros, AGE_CHECK_FALLBACK_PRICE.worstMicros, 3);

// Owner's decision (2026-09-27): the paid image age check is optional, off by
// default — the app is his personal tool, and he judges age by eye, including
// at pick. The free text-level 21+ safeguards (the descriptor gate, the
// prompts) are never affected by this toggle.
function ImageAgeCheckRow({ settings }: { settings: Settings }) {
  const { client, store } = useEngine();
  const labelId = useId();
  const hintId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<EngineError | null>(null);
  const on = settings.imageAgeCheck === "on";

  async function change(next: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    const reply = await client.request("settings.setImageAgeCheck", { imageAgeCheck: next ? "on" : "off" });
    setBusy(false);
    if (reply.ok) store.setSettings(reply.result);
    else setError(reply.error);
  }

  return (
    <>
      <Row
        label="Автопроверка возраста на фото"
        labelId={labelId}
        hintId={hintId}
        hint={`по умолчанию выключена — возраст оцениваете вы сами · ≈ ${AGE_CHECK_PRICE} за фото`}
      >
        <button
          type="button"
          role="switch"
          className={on ? "sw sw-on" : "sw"}
          aria-checked={on}
          aria-labelledby={labelId}
          aria-describedby={hintId}
          aria-busy={busy}
          disabled={busy}
          onClick={() => void change(!on)}
        />
      </Row>
      {error && <ErrorNotice error={error} />}
    </>
  );
}

/**
 * The camera-realism switch: when on, every NEW run's image prompts end with one fixed English clause about the camera (skin pores,
 * sensor noise, imperfect light, no retouching: studio/engine/scenes/assembler.ts). Off by default.
 */
function CameraRealismRow({ settings }: { settings: Settings }) {
  const { client, store } = useEngine();
  const labelId = useId();
  const hintId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<EngineError | null>(null);
  const on = settings.cameraRealism;

  async function change(next: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    const reply = await client.request("settings.setCameraRealism", { cameraRealism: next });
    setBusy(false);
    if (reply.ok) store.setSettings(reply.result);
    else setError(reply.error);
  }

  return (
    <>
      <Row
        label="Реализм камеры"
        labelId={labelId}
        hintId={hintId}
        hint="в промпт добавляется фраза про снимок на смартфон: поры кожи, шум матрицы, неидеальный свет, без ретуши · применяется к новым запускам"
      >
        <button
          type="button"
          role="switch"
          className={on ? "sw sw-on" : "sw"}
          aria-checked={on}
          aria-labelledby={labelId}
          aria-describedby={hintId}
          aria-busy={busy}
          disabled={busy}
          onClick={() => void change(!on)}
        />
      </Row>
      {error && <ErrorNotice error={error} />}
    </>
  );
}

type CatalogueState = { status: "loading" } | { status: "failed" } | { status: "ready"; catalogue: ImageModelCatalogue };

/**
 * «Фото»: the image model (a select over the engine's catalogue: name, price of one photo, «не проверена» for a model outside the
 * spike) and, for a model with two qualities, the quality. They apply to NEW runs and new portraits; a run that has started keeps
 * what it was planned and priced with. The catalogue is read when the card opens, again on «Повторить», and again when the window
 * comes back after the engine's cache window; until it arrives, or when it cannot be read, the model is shown as plain text, as
 * before the choice existed. A refresh that fails keeps the list on show.
 */
function ImageModelRows({ settings }: { settings: Settings }) {
  const { client, store } = useEngine();
  const modelId = useId();
  const qualityId = useId();
  const hintId = useId();
  const [state, setState] = useState<CatalogueState>({ status: "loading" });
  const [asks, setAsks] = useState(0);
  const askedAt = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<EngineError | null>(null);

  useEffect(() => {
    let current = true;
    askedAt.current = Date.now();
    void client.request("settings.imageModels", {}).then((reply) => {
      if (current) setState((was) => (reply.ok ? { status: "ready", catalogue: reply.result } : was.status === "ready" ? was : { status: "failed" }));
    });
    return () => {
      current = false;
    };
  }, [client, asks]);

  // Focus and visibility come together on a return: the first asks, the second finds the ask fresh.
  const shown = state.status === "ready" ? state.catalogue : null;
  useEffect(() => {
    if (shown === null) return;
    const again = (): void => {
      if (document.visibilityState !== "visible" || Date.now() - askedAt.current < catalogueFreshMs(shown)) return;
      askedAt.current = Date.now();
      setAsks((n) => n + 1);
    };
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    return () => {
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
    };
  }, [shown]);

  async function save(imageModel: string, imageQuality?: ImageQuality): Promise<void> {
    setBusy(true);
    setError(null);
    const reply = await client.request("settings.setModels", { imageModel, ...(imageQuality === undefined ? {} : { imageQuality }), textModel: settings.textModel });
    setBusy(false);
    if (reply.ok) store.setSettings(reply.result);
    else setError(reply.error);
  }

  const explanation = "портреты аватара и фото-раны";
  if (state.status !== "ready") {
    return (
      <>
        <Row label="Фото" hint={state.status === "failed" ? `${explanation} · список моделей не загрузился, выбор недоступен` : explanation}>
          <span className="mono row-value">{settings.imageModel}</span>
          {state.status === "failed" && (
            <button
              type="button"
              className="btn btn-s"
              onClick={() => {
                setState({ status: "loading" });
                setAsks((n) => n + 1);
              }}
            >
              Повторить
            </button>
          )}
        </Row>
      </>
    );
  }

  const { catalogue } = state;
  const entry: ImageModelEntry | undefined = catalogue.models.find((m) => m.id === settings.imageModel);
  const price = entry === undefined ? null : formatUsd(photoPriceMicros(entry, settings.imageQuality), 3);
  const hint = [
    explanation,
    price === null ? null : `≈ ${price} за фото (с референсом)`,
    "применяется к новым запускам",
    catalogue.source === "fallback" ? "встроенный список: OpenRouter не ответил" : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  return (
    <>
      <Row label="Фото" labelFor={modelId} hint={hint} hintId={hintId}>
        <select id={modelId} className="row-select mono" value={settings.imageModel} disabled={busy} aria-describedby={hintId} onChange={(e) => void save(e.target.value)}>
          {entry === undefined && <option value={settings.imageModel}>{`${settings.imageModel} · нет в списке`}</option>}
          {catalogue.models.map((m) => (
            <option key={m.id} value={m.id}>
              {modelOptionLabel(m)}
            </option>
          ))}
        </select>
      </Row>
      {entry !== undefined && entry.qualities.length > 1 && (
        <Row label="Качество фото" labelFor={qualityId} hint="выше качество — дороже каждый кадр, цена в списке">
          <select
            id={qualityId}
            className="row-select mono"
            value={settings.imageQuality ?? ""}
            disabled={busy}
            onChange={(e) => {
              const next = entry.qualities.find((q) => q === e.target.value);
              if (next !== undefined) void save(settings.imageModel, next);
            }}
          >
            {/* No quality saved (the request sends none): without this the select would show the first one, and choosing it would change nothing. */}
            {settings.imageQuality === null && (
              <option value="" disabled>
                не задано
              </option>
            )}
            {entry.qualities.map((q) => (
              <option key={q} value={q}>
                {qualityOptionLabel(entry, q)}
              </option>
            ))}
          </select>
        </Row>
      )}
      {error && <ErrorNotice error={error} />}
    </>
  );
}

function LibraryRow({ settings }: { settings: Settings }) {
  const { client, store } = useEngine();
  // A queued or running render is what holds the library folder then, and the generic text talks about paid requests.
  const rendering = useEngineView().jobs.some((job) => job.kind === "render" && isActiveJob(job));
  const inputId = useId();
  const issueId = useId();
  const [editing, setEditing] = useState(false);
  const [path, setPath] = useState(settings.libraryPath);
  const [issue, setIssue] = useState<string | null>(null);
  const [error, setError] = useState<EngineError | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(): Promise<void> {
    const parsed = AbsolutePath.safeParse(path.trim());
    if (!parsed.success) {
      setIssue("Нужен полный путь к папке без «..», например /Users/you/Studio/library или D:\\Studio\\library.");
      return;
    }
    setIssue(null);
    setError(null);
    setBusy(true);
    const reply = await client.request("settings.setLibraryPath", { path: parsed.data });
    setBusy(false);
    if (reply.ok) {
      store.setSettings(reply.result);
      setEditing(false);
      // The avatars and drafts belong to the folder: even the same path may
      // hold a library now that the engine could not open before.
      store.reload();
    } else setError(reply.error);
  }

  return (
    <>
      <Row
        label="Библиотека"
        labelFor={editing ? inputId : undefined}
        hint={
          editing ? (
            "папка с аватарами и фото · журнал расходов хранится отдельно и при переносе не теряется"
          ) : (
            <span className="mono rl-path">{settings.libraryPath}</span>
          )
        }
      >
        {!editing && (
          <button
            type="button"
            className="btn btn-s"
            onClick={() => {
              setPath(settings.libraryPath);
              setEditing(true);
            }}
          >
            Изменить
          </button>
        )}
      </Row>
      {editing && (
        <form
          className="inline-form path-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input
            id={inputId}
            className="in in-s"
            type="text"
            value={path}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={issue !== null}
            aria-describedby={issue ? issueId : undefined}
            onChange={(e) => setPath(e.currentTarget.value)}
          />
          <button type="submit" className="btn btn-s btn-p" aria-label="Сохранить папку" aria-busy={busy} disabled={busy}>
            {busy ? (
              <>
                <Spin />
                Сохраняем…
              </>
            ) : (
              "Сохранить"
            )}
          </button>
          <button
            type="button"
            className="btn btn-s"
            onClick={() => {
              setEditing(false);
              setIssue(null);
            }}
          >
            Отмена
          </button>
        </form>
      )}
      {issue && (
        <p id={issueId} className="field-error" role="alert">
          {issue}
        </p>
      )}
      {error && (error.code === "IN_FLIGHT" && rendering ? <Notice tone="danger">{LIBRARY_RENDER_BUSY_TEXT}</Notice> : <ErrorNotice error={error} />)}
    </>
  );
}

/** What the row last did: a pick that took (with its counts), or one that was refused (with the words for it). A cancel leaves it as it was. */
type ExportOutcome = { kind: "picked"; notice: PickedNotice } | { kind: "refused"; text: string };

/**
 * «Готовые видео» (3e.3, K18). The folder is picked in main's own dialog: the window sends no path and gets back how many videos
 * resolve in it and how many stay in the previous folder. The path shown is main's display string (home as «~»), asked again
 * whenever the folder changes. When the folder in use cannot take a video (an unplugged disk), the store's live status says why.
 */
function ExportFolderRow({ settings }: { settings: Settings }) {
  const { client, store } = useEngine();
  const view = useEngineView();
  const pathId = useId();
  const [shown, setShown] = useState<{ folder: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ExportOutcome | null>(null);
  const status = view.exportStatus;

  useEffect(() => {
    let current = true;
    void client.request("settings.exportDisplay", {}).then((reply) => {
      // Main could not say (an older preload): the folder as the settings hold it is better than none.
      if (current) setShown({ folder: settings.exportPath, text: reply.ok ? reply.result.display : settings.exportPath });
    });
    return () => {
      current = false;
    };
  }, [client, settings.exportPath]);

  async function choose(): Promise<void> {
    setBusy(true);
    const reply = await client.request("settings.setExportPath", {});
    setBusy(false);
    if (!reply.ok) {
      setOutcome({ kind: "refused", text: refusedPickText(reply.error) });
      return;
    }
    // A cancelled dialog changes nothing: not the path, and not what the row last said.
    if (!reply.result.picked) return;
    store.setSettings(reply.result.settings);
    setOutcome({ kind: "picked", notice: pickedNotice(reply.result) });
  }

  return (
    <>
      <Row
        label="Готовые видео"
        path={shown !== null && shown.folder === settings.exportPath ? { id: pathId, text: shown.text } : undefined}
        hint="здесь хранятся готовые видео · Studio держит у себя только запись о каждом"
      >
        <button type="button" className="btn btn-s" aria-label="Изменить папку «Готовые видео»" aria-describedby={pathId} aria-busy={busy} disabled={busy} onClick={() => void choose()}>
          Изменить
        </button>
      </Row>
      {status?.status === "unavailable" && (
        <Notice
          tone="danger"
          title={EXPORT_UNAVAILABLE_TITLE}
          actions={
            <button type="button" className="btn btn-s" onClick={() => void store.recheckExport({ force: true })}>
              Проверить снова
            </button>
          }
        >
          {unavailableText(status.reason)}
        </Notice>
      )}
      {outcome?.kind === "refused" && (
        <Notice tone="danger">{outcome.text}</Notice>
      )}
      {outcome?.kind === "picked" && (
        <Notice tone={outcome.notice.tone}>
          <p>{outcome.notice.text}</p>
          {outcome.notice.hint !== null && <p>{outcome.notice.hint}</p>}
        </Notice>
      )}
    </>
  );
}

// ---------- music (3c.6, Settings.dc.html «Музыка · flashapi») ----------

/** The artboard's mask: eight dots, then the last four chars, the only part of the key that ever reaches the window. */
const MUSIC_KEY_MASK = "••••••••";

function musicKeyState(status: MusicKeyStatus, encryptionAvailable: boolean): KeyState {
  if (status.rejected) {
    return {
      tone: "danger",
      icon: "alert",
      hint: "RapidAPI отклонил ключ (401)",
      notice: { text: "Обновление списка остановлено и само не повторяется: с этим ключом запросы не отправляются и не тратятся. Замените ключ — например, если старый отозван." },
    };
  }
  if (status.stored) return { tone: "ok", icon: "lock", hint: "зашифрован системой", notice: null };
  if (!encryptionAvailable) return { tone: "danger", icon: "alert", hint: "шифрование недоступно — ключ не сохраняется", notice: null };
  return { tone: null, icon: null, hint: "не сохранён · X-RapidAPI-Key из кабинета RapidAPI, с подпиской на flashapi", notice: null };
}

/**
 * «Ключ RapidAPI»: the same component as the OpenRouter key (the artboard's note), with «Заменить» and «Удалить» and no
 * «Проверить» (Q4: a check would spend one of the 30 requests). The key goes through main's own flow
 * (`settings.setMusicKey`): the typed text leaves React state before the request does, and only its status comes back.
 */
function MusicKeyRow({ status, encryptionAvailable }: { status: MusicKeyStatus; encryptionAvailable: boolean }) {
  const { client, store } = useEngine();
  const inputId = useId();
  const issueId = useId();
  const [editing, setEditing] = useState(false);
  const [typed, setTyped] = useState("");
  const [issue, setIssue] = useState<string | null>(null);
  const [error, setError] = useState<EngineError | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLButtonElement>(null);
  // Set when a user action removes the focused control; the effect moves focus to its successor.
  const [focusNext, setFocusNext] = useState<"input" | "replace" | null>(null);
  const showInput = editing || !status.stored;
  const state = musicKeyState(status, encryptionAvailable);

  useEffect(() => {
    if (focusNext === null) return;
    (focusNext === "input" ? inputRef.current : replaceRef.current)?.focus();
    setFocusNext(null);
  }, [focusNext, showInput]);

  async function save(): Promise<void> {
    const parsed = MusicKey.safeParse(typed);
    if (!parsed.success) {
      setIssue("Ключ — от 8 печатных символов без пробелов: X-RapidAPI-Key из кабинета RapidAPI.");
      return;
    }
    // The typed key leaves React state before the request goes out; only its status comes back.
    setTyped("");
    setIssue(null);
    setError(null);
    setBusy(true);
    const reply = await client.request("settings.setMusicKey", { key: parsed.data });
    setBusy(false);
    if (reply.ok) {
      store.setMusicKey(reply.result);
      setEditing(false);
      setFocusNext(reply.result.stored ? "replace" : "input");
    } else setError(reply.error);
  }

  async function clear(): Promise<void> {
    setBusy(true);
    setError(null);
    const reply = await client.request("settings.clearMusicKey", {});
    setBusy(false);
    if (reply.ok) {
      store.setMusicKey(reply.result);
      setFocusNext("input");
    } else setError(reply.error);
  }

  return (
    <>
      <Row
        label="Ключ RapidAPI"
        labelFor={showInput ? inputId : undefined}
        hintRole="status"
        hintTone={state.tone === "ok" ? undefined : (state.tone ?? undefined)}
        hint={
          <span className={state.tone === "ok" ? "key-hint key-hint-ok" : "key-hint"}>
            {state.icon && <Icon name={state.icon} size={12} strokeWidth={2.2} />}
            {state.hint}
          </span>
        }
      >
        {status.stored && !showInput && (
          <>
            <input className="in in-s music-key-mask" type="text" readOnly value={`${MUSIC_KEY_MASK}${status.last4 ?? ""}`} aria-label={`Ключ RapidAPI, последние символы ${status.last4 ?? ""}`} />
            <button
              ref={replaceRef}
              type="button"
              className="btn btn-s"
              aria-label="Заменить ключ RapidAPI"
              onClick={() => {
                setEditing(true);
                setFocusNext("input");
              }}
              disabled={busy}
            >
              Заменить
            </button>
            <button type="button" className="btn btn-s" aria-label="Удалить ключ RapidAPI" onClick={() => void clear()} disabled={busy} aria-busy={busy}>
              {busy ? (
                <>
                  <Spin />
                  Удаляем…
                </>
              ) : (
                "Удалить"
              )}
            </button>
          </>
        )}
        {showInput && (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <input
              ref={inputRef}
              id={inputId}
              className="in in-s key-field"
              type="password"
              value={typed}
              placeholder="X-RapidAPI-Key"
              autoComplete="off"
              spellCheck={false}
              disabled={!encryptionAvailable || busy}
              aria-invalid={issue !== null}
              aria-describedby={issue ? issueId : undefined}
              onChange={(e) => setTyped(e.currentTarget.value)}
            />
            <button type="submit" className="btn btn-s btn-p" aria-label="Сохранить ключ RapidAPI" aria-busy={busy} disabled={!encryptionAvailable || busy || typed.trim() === ""}>
              {busy ? (
                <>
                  <Spin />
                  Сохраняем…
                </>
              ) : (
                "Сохранить"
              )}
            </button>
            {status.stored && (
              <button
                type="button"
                className="btn btn-s"
                aria-label="Отменить замену ключа RapidAPI"
                onClick={() => {
                  setEditing(false);
                  setTyped("");
                  setIssue(null);
                  setFocusNext("replace");
                }}
              >
                Отмена
              </button>
            )}
          </form>
        )}
      </Row>
      {state.notice && <Notice tone="danger">{state.notice.text}</Notice>}
      {issue && (
        <p id={issueId} className="field-error" role="alert">
          {issue}
        </p>
      )}
      {error && <Notice tone="danger">{errorText(error)}</Notice>}
    </>
  );
}

/** «Запросы flashapi»: «отправлено N из 30 за 31 день», the bar, the figure as the artboard sets it, and when the next frees. */
function MusicQuotaRow({ music }: { music: MusicStatus }) {
  const labelId = useId();
  const view = quotaView(music);
  // Two lines: the count and what counts, then when the next request frees (and flashapi's own lower figure).
  const when = [view.nextFree, view.server].filter((part): part is string => part !== null).join(" · ");
  return (
    <div className="row">
      <div className="rl music-meter">
        <b id={labelId}>Запросы flashapi</b>
        <div
          className={`bar bar-${view.tone}`}
          role="progressbar"
          aria-labelledby={labelId}
          aria-valuemin={0}
          aria-valuemax={view.figure.limit}
          aria-valuenow={view.figure.sent}
          aria-valuetext={view.line}
        >
          <span style={{ width: `${view.share}%` }} />
        </div>
        <span>{view.line} · считаются и запросы с ошибкой</span>
        {when !== "" && <span>{when}</span>}
      </div>
      <span className="mono money-figure">
        {view.figure.sent} <span className="faint">из {view.figure.limit}</span>
      </span>
    </div>
  );
}

/**
 * «Тренды Instagram»: the list's age and «Обновить · 1 запрос». A request costs one of 30 per 31 days, so the first click only
 * asks, in the row itself (the artboard's confirm state), saying what is left and when the next frees; only the confirmation
 * sends `music.refresh {confirm: true}`, once. A closed refresh says why on the row; a refresh in flight shows how far it is.
 */
function MusicTrendsRow({ musicKey, music }: { musicKey: MusicKeyStatus; music: MusicStatus }) {
  const { store } = useEngine();
  const labelId = useId();
  const hintId = useId();
  const reasonId = useId();
  const [asking, setAsking] = useState(false);
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<EngineError | null>(null);
  const askRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [focusNext, setFocusNext] = useState<"ask" | "cancel" | null>(null);
  const gate = refreshGate(musicKey, music, Date.now());
  // The confirmation is for a request the engine would let leave: a status that closed meanwhile closes it too.
  const confirming = asking && (gate.kind === "ready" || sending);
  // The gate left `ready` while the owner was asked and nothing is being sent: the question is over (review round 1), so it
  // cannot come back on its own when the gate opens again.
  const stale = asking && !sending && gate.kind !== "ready";
  useEffect(() => {
    if (stale) setAsking(false);
  }, [stale]);
  const label = refreshLabel(music);

  useEffect(() => {
    if (focusNext === null) return;
    (focusNext === "cancel" ? cancelRef.current : askRef.current)?.focus();
    setFocusNext(null);
  }, [focusNext, confirming]);

  function ask(): void {
    setRefusal(null);
    setAsking(true);
    setFocusNext("cancel");
  }

  function cancel(): void {
    setAsking(false);
    setFocusNext("ask");
  }

  async function confirm(): Promise<void> {
    setSending(true);
    const reply = await store.confirmMusicRefresh();
    setSending(false);
    setAsking(false);
    if (reply.ok) return;
    setRefusal(reply.error);
    // A refusal means the window's picture was behind the engine's: ask for the status again, so the row says why it is closed.
    void store.refreshMusic();
  }

  const reason = gate.kind === "blocked" ? gate.reason : null;
  const failure = music.refresh.state === "failed" ? music.refresh.error : null;
  return (
    <>
      <div className="row">
        <div className="rl">
          <b id={labelId}>Тренды Instagram</b>
          {confirming && gate.kind === "ready" ? (
            <span id={hintId} role="status" className="music-confirm">
              {gate.confirm}
            </span>
          ) : gate.kind === "running" ? (
            <span id={hintId} role="status">
              обновляется · {gate.percent}
              {NBSP}%
            </span>
          ) : (
            <span id={hintId}>{listLine(music)}</span>
          )}
          {gate.kind === "running" && (
            <div className="bar music-progress" aria-hidden="true">
              <span style={{ width: `${gate.percent}%` }} />
            </div>
          )}
          {!confirming && failure !== null && (
            <span role="alert" className="music-failure">
              {musicFailureText(failure)}
            </span>
          )}
          {!confirming && reason !== null && (
            <span id={reasonId} className="music-reason">
              {reason}
            </span>
          )}
        </div>
        <div className="row-control">
          {confirming ? (
            <div
              className="music-confirm-actions"
              role="group"
              aria-labelledby={labelId}
              aria-describedby={hintId}
              onKeyDown={(e) => {
                if (e.key === "Escape" && !sending) cancel();
              }}
            >
              <button ref={cancelRef} type="button" className="btn btn-s" onClick={cancel} disabled={sending}>
                Отмена
              </button>
              <button type="button" className="btn btn-s btn-p" onClick={() => void confirm()} disabled={sending} aria-busy={sending}>
                {sending ? (
                  <>
                    <Spin />
                    Отправляем…
                  </>
                ) : (
                  label
                )}
              </button>
            </div>
          ) : (
            <button
              ref={askRef}
              type="button"
              className="btn btn-s"
              onClick={ask}
              disabled={gate.kind !== "ready"}
              aria-busy={gate.kind === "running"}
              aria-describedby={reason !== null ? `${hintId} ${reasonId}` : hintId}
            >
              {gate.kind === "running" ? (
                <>
                  <Spin />
                  Обновляется…
                </>
              ) : (
                <>
                  <Icon name="reload" size={14} />
                  {label}
                </>
              )}
            </button>
          )}
        </div>
      </div>
      {refusal && <Notice tone="danger">{refusalText(refusal)}</Notice>}
    </>
  );
}

/** Why the recovery was refused: a sound log, a refresh running (not the paid requests IN_FLIGHT's own text speaks of), else the error. */
function recoveryRefusalText(error: EngineError): string {
  if (error.code === "VALIDATION") return "Журнал уже в порядке: ничего не изменено.";
  if (error.code === "IN_FLIGHT") return "Сейчас идёт обновление списка: восстановите журнал, когда оно закончится.";
  return errorText(error);
}

/**
 * The quota log's own trouble, under the rows: a line still waiting to be written (`held`), a log that cannot be read, and a
 * damaged log, the only one with a way out (3c.6): put aside, and the quota closed for exactly 31 days, behind a confirmation
 * that names the day it reopens. Nothing is sent.
 */
function QuotaLogNotice({ music }: { music: MusicStatus }) {
  const { store } = useEngine();
  const [asking, setAsking] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<EngineError | null>(null);
  const askRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [focusNext, setFocusNext] = useState<"ask" | "cancel" | null>(null);

  useEffect(() => {
    if (focusNext === null) return;
    (focusNext === "cancel" ? cancelRef.current : askRef.current)?.focus();
    setFocusNext(null);
  }, [focusNext, asking]);

  if (music.quotaLog === "held") {
    // Asking the status writes what is held (free, nothing leaves): the way out once the disk is fixed (review round 1).
    return (
      <Notice
        tone="warn"
        title="Ответ сервиса ещё не записан в журнал"
        actions={
          <button type="button" className="btn btn-s" onClick={() => void store.refreshMusic()}>
            Проверить снова
          </button>
        }
      >
        Пока он не записан, новый запрос не уйдёт: иначе он обошёл бы учёт квоты. Освободите место на диске или проверьте права на папку данных Studio —
        запись повторится, когда вы снова откроете эту карточку или нажмёте «Проверить снова». Ничего не отправится.
      </Notice>
    );
  }
  if (music.quotaLog === "unreadable") {
    return (
      <Notice tone="danger" title="Журнал запросов не читается">
        Без журнала Studio не знает, сколько запросов ушло за 31{NBSP}день, поэтому новые не отправляются. Проверьте доступ к файлу журнала в папке данных
        Studio и перезапустите приложение.
      </Notice>
    );
  }
  if (music.quotaLog !== "corrupt" && music.quotaLog !== "missing") return null;

  const text = recoveryText(Date.now());
  const gone = music.quotaLog === "missing";
  // A refresh, or the downloads it left, is running: the engine does not swap the log under it (review round 1).
  const running = music.refresh.state === "running";

  async function recover(): Promise<void> {
    setSending(true);
    setError(null);
    const reply = await store.confirmQuotaLogRecovery();
    setSending(false);
    setAsking(false);
    if (reply.ok) return;
    setError(reply.error);
    void store.refreshMusic();
  }

  return (
    <Notice
      tone="danger"
      title={gone ? "Журнал запросов пропал" : "Журнал запросов повреждён"}
      actions={
        asking ? (
          <div
            className="music-confirm-actions"
            role="group"
            aria-label="Восстановить журнал запросов"
            onKeyDown={(e) => {
              if (e.key === "Escape" && !sending) {
                setAsking(false);
                setFocusNext("ask");
              }
            }}
          >
            <button
              ref={cancelRef}
              type="button"
              className="btn btn-s"
              disabled={sending}
              onClick={() => {
                setAsking(false);
                setFocusNext("ask");
              }}
            >
              Отмена
            </button>
            <button type="button" className="btn btn-s btn-p" disabled={sending || running} aria-busy={sending} onClick={() => void recover()}>
              {sending ? (
                <>
                  <Spin />
                  Восстанавливаем…
                </>
              ) : (
                "Восстановить и закрыть на 31 день"
              )}
            </button>
          </div>
        ) : (
          <button
            ref={askRef}
            type="button"
            className="btn btn-s"
            disabled={running}
            onClick={() => {
              setError(null);
              setAsking(true);
              setFocusNext("cancel");
            }}
          >
            Восстановить журнал…
          </button>
        )
      }
    >
      {gone ? (
        <p>
          Studio уже отправляла запросы, но журнала с их счётом больше нет — например, удалили папку с музыкой. Пока счёт неизвестен, новые запросы не
          отправляются; журнал можно начать заново.
        </p>
      ) : (
        <p>Studio не может посчитать, сколько запросов ушло за 31{NBSP}день, поэтому новые не отправляются, пока журнал не начат заново.</p>
      )}
      {running && !asking && <p>Сейчас идёт обновление списка: восстановить журнал можно, когда оно закончится.</p>}
      {asking && <p className="music-confirm">{text.confirm}</p>}
      {error && <p>{recoveryRefusalText(error)}</p>}
    </Notice>
  );
}

/** «Музыка · flashapi»: the key, the quota and the trends list (3c.6). The status is asked when the card opens and after a restart. */
function MusicCard({ settings, headingRef }: { settings: Settings; headingRef: Ref<HTMLHeadingElement> }) {
  const { store } = useEngine();
  const view = useEngineView();
  const ready = view.phase === "ready";

  useEffect(() => {
    if (ready) void store.refreshMusic();
  }, [ready, view.bootId, store]);

  const { music } = view;
  return (
    <Card title="Музыка · flashapi" id="settings-music" headingRef={headingRef}>
      <MusicKeyRow status={settings.musicKey} encryptionAvailable={settings.apiKey.encryptionAvailable} />
      {music === null ? (
        <p className="muted music-loading">Загружаем квоту…</p>
      ) : (
        <>
          <MusicQuotaRow music={music} />
          <MusicTrendsRow musicKey={settings.musicKey} music={music} />
          <QuotaLogNotice music={music} />
        </>
      )}
    </Card>
  );
}

/**
 * «← К черновику» (slice review 5-M2): Settings was entered from this draft's editor, which sends the owner here for the trending list, the export
 * folder or an error's card. The editor this window kept for the draft names it; back there, the draft goes on where it was (its undo included).
 */
function BackToDraft({ montageId }: { montageId: string }) {
  const navigate = useNavigate();
  const view = useEngineView();
  const kept = useDraftSessions().peek(montageId);
  const avatar = kept === null ? null : (view.avatars.find((a) => a.avatarId === kept.session.state.spec.avatarId)?.name ?? null);
  return (
    <button type="button" className="back-link" onClick={() => navigate({ name: "editor", montageId })}>
      <Icon name="back" size={14} strokeWidth={2.2} />
      {kept === null ? "К черновику" : `К черновику ${draftTitle(avatar, kept.session.state.name)}`}
    </button>
  );
}

export function SettingsScreen({ focus, back }: { focus?: SettingsFocus; back?: { readonly montageId: string } }) {
  const { store } = useEngine();
  const view = useEngineView();
  // The key and the money share one card now («OpenRouter и расходы»): an error link to either lands on its heading.
  const openRouterHeading = useRef<HTMLHeadingElement>(null);
  // An EXPORT_UNAVAILABLE link lands on the folders card, where the export folder is fixed.
  const foldersHeading = useRef<HTMLHeadingElement>(null);
  // A music error (the editor's music tab) lands on the «Музыка» card.
  const musicHeading = useRef<HTMLHeadingElement>(null);
  const ready = view.phase === "ready";

  useEffect(() => {
    if (ready) void store.refreshMoney();
  }, [ready, store]);

  useEffect(() => {
    if (!ready || !focus) return;
    const target = focus === "export" ? foldersHeading.current : focus === "music" ? musicHeading.current : openRouterHeading.current;
    target?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    target?.focus({ preventScroll: true });
  }, [ready, focus]);

  const { settings, money } = view;
  const ageCheckOn = settings?.imageAgeCheck === "on";

  return (
    <div className="page page-bounded">
      <header className="page-head">
        <div>
          {back !== undefined && <BackToDraft montageId={back.montageId} />}
          <ScreenTitle>Настройки</ScreenTitle>
        </div>
      </header>

      {view.phase === "connecting" && <p className="muted">Загружаем настройки…</p>}
      {view.phase === "offline" && <EngineOffline view={view} />}

      {settings && (
        <div className="settings-grid">
          <div className="settings-col">
            <Card title="OpenRouter и расходы" id="settings-openrouter" headingRef={openRouterHeading}>
              <ApiKeyRow status={settings.apiKey} />
              <BudgetRow settings={settings} />
              {money?.ledger === "open" && <MoneyStatusRows money={money} />}
              {money && <ReconcileBlock phase={view.phase} money={money} engineError={view.engineError} />}
            </Card>
            <Card title="Модели" id="settings-models">
              {/* The text model writes the descriptor (avatar jobs) and every photo run's scene sentences (scenes/writer.ts); the image model makes the avatar portraits and every photo run's photos. */}
              <Row
                label="Сцены"
                hint={ageCheckOn ? "дескриптор аватара, сценарист фото-ранов и проверка «явно старше 21»" : "дескриптор аватара и сценарист фото-ранов"}
              >
                <span className="mono row-value">{settings.textModel}</span>
              </Row>
              <ImageModelRows settings={settings} />
              <ImageAgeCheckRow settings={settings} />
              <CameraRealismRow settings={settings} />
              {/*
               * The engine's face gate (studio/engine/face/config.ts) is a
               * hybrid, not a strict identity filter — wired into photo runs
               * (T7b), so the retries and gallery badges below describe
               * what a run actually does, not a future promise. The
               * threshold (0.55) is that module's own literal
               * (defaultFaceGateConfig), restated by hand here — the
               * renderer bundle itself never imports engine code for it —
               * but SettingsScreen.test.tsx does import the real constant
               * and pins this hint's text against it, so the two numbers
               * cannot silently drift apart.
               */}
              <Row
                label="Сходство лица"
                hint="локально, без токенов · повтор только при явном браке — нет лица, два лица, лицо на кадре со спины, сходство ниже 0.55 · остальное — значком в галерее"
              >
                <span className="mono row-value">гибрид</span>
              </Row>
            </Card>
          </div>

          <div className="settings-col">
            <Card title="Производительность" id="settings-performance">
              <ConcurrencyRow settings={settings} />
            </Card>
            <Card title="Папки и экспорт" id="settings-folders" headingRef={foldersHeading}>
              <LibraryRow settings={settings} />
              <ExportFolderRow settings={settings} />
            </Card>
            <MusicCard settings={settings} headingRef={musicHeading} />
          </div>
        </div>
      )}
    </div>
  );
}
