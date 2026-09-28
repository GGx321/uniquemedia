import { type ReactNode, type Ref, useEffect, useId, useRef, useState } from "react";
import {
  AbsolutePath,
  ApiKey,
  IMPORT_FALLBACK_PRICE,
  NetworkConcurrency,
  type ApiKeyStatus,
  type EngineError,
  type MoneyStatus,
  type OpenMoneyStatus,
  type ReconcileReason,
  type ReconcileResult,
  type Settings,
} from "../../shared/engine";
import { useEngine, useEngineView } from "../engine/react";
import type { SyncPhase } from "../engine/store";
import { countOf, monthName, NBSP, waitLabel } from "../lib/format";
import { dollarsInputValue, formatUsd, formatUsdRange, parseDollars, type DollarsParse } from "../lib/money";
import { paidStop, restartStopText } from "../lib/paidStop";
import { bound } from "../lib/traits";
import type { SettingsFocus } from "../navigation";
import { Icon, Spin } from "../ui/Icon";
import { ErrorNotice, Notice } from "../ui/Notice";
import { EngineOffline } from "../ui/EngineOffline";
import { ScreenTitle } from "../ui/ScreenTitle";

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
  hint?: ReactNode;
  hintId?: string;
  /** A hint that reports a result (`status`) or a problem (`alert`) rather than explaining the row. */
  hintRole?: "status" | "alert";
  hintTone?: Tone;
  children?: ReactNode;
}

/** The sheet's settings row: `.row` with the name and hint (`.rl`) on the left and the control on the right. */
function Row({ label, labelFor, labelId, hint, hintId, hintRole, hintTone, children }: RowProps) {
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

// One image age check at the dated fallback table (IMPORT_FALLBACK_PRICE: the
// same AGE_CHECK_CALL prices a candidate's check and an import's). «до» means
// a hard cap everywhere else in the app, but the fallback table is only used
// when OpenRouter did not answer — the live price can be higher — so this is
// «≈» (nearest, not rounded up): a range from the expected price to the worst
// case, not the worst case alone prefixed with «≈» (which would overstate the
// approximate cost).
const AGE_CHECK_PRICE = formatUsdRange(IMPORT_FALLBACK_PRICE.ageCheck.expectedMicros, IMPORT_FALLBACK_PRICE.ageCheck.worstMicros, 3);

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

function LibraryRow({ settings }: { settings: Settings }) {
  const { client, store } = useEngine();
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
      {error && <ErrorNotice error={error} />}
    </>
  );
}

export function SettingsScreen({ focus }: { focus?: SettingsFocus }) {
  const { store } = useEngine();
  const view = useEngineView();
  // The key and the money share one card now («OpenRouter и расходы»): an error link to either lands on its heading.
  const openRouterHeading = useRef<HTMLHeadingElement>(null);
  const ready = view.phase === "ready";

  useEffect(() => {
    if (ready) void store.refreshMoney();
  }, [ready, store]);

  useEffect(() => {
    if (!ready || !focus) return;
    const target = openRouterHeading.current;
    target?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    target?.focus({ preventScroll: true });
  }, [ready, focus]);

  const { settings, money } = view;
  const ageCheckOn = settings?.imageAgeCheck === "on";

  return (
    <div className="page">
      <header className="page-head">
        <ScreenTitle>Настройки</ScreenTitle>
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
              {/* T5b's scenes/writer.ts and assembler.ts exist but are not wired into the job pipeline yet — no run uses this model for scenes today. */}
              <Row
                label="Сцены"
                hint={ageCheckOn ? "дескриптор и проверка «явно старше 21» · сцены — появятся вместе с фото-ранами" : "дескриптор · сцены появятся вместе с фото-ранами"}
              >
                <span className="mono row-value">{settings.textModel}</span>
              </Row>
              <Row label="Фото" hint="портреты · 1K · сцены появятся вместе с фото-ранами">
                <span className="mono row-value">{settings.imageModel}</span>
              </Row>
              <ImageAgeCheckRow settings={settings} />
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
            <Card title="Папки и экспорт" id="settings-folders">
              <LibraryRow settings={settings} />
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
