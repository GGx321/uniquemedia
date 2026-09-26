import { type ReactNode, type Ref, useEffect, useId, useRef, useState } from "react";
import {
  AbsolutePath,
  ApiKey,
  NetworkConcurrency,
  type ApiKeyStatus,
  type EngineError,
  type MoneyStatus,
  type OpenMoneyStatus,
  type ReconcileReason,
  type ReconcileResult,
  type ReconcileWarning,
  type Settings,
} from "../../shared/engine";
import { useEngine, useEngineView } from "../engine/react";
import { countOf, monthLabel, waitLabel } from "../lib/format";
import { dollarsInputValue, formatUsd, parseDollars, type DollarsParse } from "../lib/money";
import { paidStop, restartStopText } from "../lib/paidStop";
import { bound } from "../lib/traits";
import type { SettingsFocus } from "../navigation";
import { Icon } from "../ui/Icon";
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

function Row({ label, hint, children, labelFor }: { label: string; hint?: ReactNode; children?: ReactNode; labelFor?: string }) {
  return (
    <div className="setting-row">
      <div className="setting-label">
        {labelFor ? (
          <label className="setting-name" htmlFor={labelFor}>
            {label}
          </label>
        ) : (
          <span className="setting-name">{label}</span>
        )}
        {hint && <span className="setting-hint">{hint}</span>}
      </div>
      {children && <div className="setting-control">{children}</div>}
    </div>
  );
}

// ---------- OpenRouter key ----------

function keyState(status: ApiKeyStatus): { tone: "ok" | "danger" | "muted"; title: string; text: string } {
  if (!status.encryptionAvailable) {
    return {
      tone: "danger",
      title: "Системное шифрование недоступно",
      text:
        "Studio хранит ключ только зашифрованным (safeStorage), а сейчас система не даёт шифровать — поэтому ключ не сохраняется. " +
        "На macOS разблокируйте Связку ключей, на Windows войдите в свою учётную запись, затем перезапустите Studio.",
    };
  }
  if (status.rejected) {
    return {
      tone: "danger",
      title: "OpenRouter отклонил ключ (401)",
      text: "Генерация остановлена и сама не повторяется. Замените ключ — например, если старый отозван или истёк.",
    };
  }
  if (status.stored) {
    return {
      tone: "ok",
      title: "Сохранён и зашифрован",
      text: "Ключ лежит в системной связке ключей и не передаётся в окно приложения — здесь видны только последние 4 символа.",
    };
  }
  return { tone: "muted", title: "Не задан", text: "Без ключа генерация недоступна. Ключ создаётся на openrouter.ai в разделе Keys." };
}

function ApiKeyCard({ status, headingRef }: { status: ApiKeyStatus; headingRef: Ref<HTMLHeadingElement> }) {
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
    <Card title="OpenRouter" id="settings-key" headingRef={headingRef}>
      <div className={`key-state key-state-${state.tone}`} role="status">
        <span className="key-state-icon">
          <Icon name={state.tone === "ok" ? "lock" : state.tone === "danger" ? "alert" : "info"} size={14} strokeWidth={2.2} />
        </span>
        <div>
          <p className="key-state-title">{state.title}</p>
          <p className="key-state-text">{state.text}</p>
        </div>
      </div>

      <Row label="API-ключ" labelFor={showInput ? inputId : undefined}>
        {status.stored && !showInput && (
          <>
            <span className="key-mask mono" aria-label={`Ключ, последние символы ${status.last4 ?? ""}`}>
              •••• {status.last4}
            </span>
            <button
              ref={replaceRef}
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setEditing(true);
                setFocusNext("input");
              }}
              disabled={busy}
            >
              Заменить
            </button>
            <button type="button" className="btn btn-sm btn-quiet" onClick={() => void clear()} disabled={busy}>
              Удалить
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
              className="input input-mono key-input"
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
              className="btn btn-sm btn-primary"
              aria-label="Сохранить ключ"
              disabled={!status.encryptionAvailable || busy || typed.trim() === ""}
            >
              {busy ? "Сохраняем…" : "Сохранить"}
            </button>
            {status.stored && (
              <button
                type="button"
                className="btn btn-sm btn-quiet"
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
      {issue && (
        <p id={issueId} className="field-error" role="alert">
          {issue}
        </p>
      )}
      {error && <ErrorNotice error={error} />}
    </Card>
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

/** Why `creditsDeltaMicros` is null: nothing to compare the ledger's own delta against. */
const DELTA_UNAVAILABLE_TEXT: Record<NonNullable<Extract<ReconcileResult, { status: "done" }>["deltaUnavailable"]>, string> = {
  "no-baseline": "Это первая сверка: нет предыдущей точки, с которой сравнить расход по /credits.",
  "negative-delta": "Расход по /credits за это окно ушёл в минус. /credits общий для всего аккаунта — сравнение недостоверно.",
};

const RECONCILE_WARNING_TEXT: Record<ReconcileWarning, string> = {
  "clock-skew": "Системные часы отстают от журнала расходов, поэтому время ожидания посчитано по внутреннему таймеру, а не по часам.",
};

function BudgetRow({ settings }: { settings: Settings }) {
  const { client, store } = useEngine();
  const inputId = useId();
  const issueId = useId();
  const [text, setText] = useState(() => dollarsInputValue(settings.monthlyBudgetMicros));
  const [dirty, setDirty] = useState(false);
  const [issue, setIssue] = useState<string | null>(null);
  const [error, setError] = useState<EngineError | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!dirty) setText(dollarsInputValue(settings.monthlyBudgetMicros));
  }, [settings.monthlyBudgetMicros, dirty]);

  async function save(): Promise<void> {
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
      setText(dollarsInputValue(reply.result.monthlyBudgetMicros));
    } else setError(reply.error);
  }

  return (
    <>
      <Row label="Месячный бюджет" labelFor={inputId} hint="Календарный месяц по UTC. Запрос, который может выйти за бюджет, не отправляется.">
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <span className="money-input">
            <span className="money-input-prefix" aria-hidden="true">
              $
            </span>
            <input
              id={inputId}
              className="input input-mono money-input-field"
              type="text"
              inputMode="decimal"
              value={text}
              autoComplete="off"
              aria-invalid={issue !== null}
              aria-describedby={issue ? issueId : undefined}
              onChange={(e) => {
                setText(e.currentTarget.value);
                setDirty(true);
                setSaved(false);
                setIssue(null);
              }}
            />
          </span>
          <button type="submit" className="btn btn-sm" aria-label="Сохранить бюджет" disabled={!dirty || busy}>
            {busy ? "Сохраняем…" : "Сохранить"}
          </button>
        </form>
      </Row>
      {issue && (
        <p id={issueId} className="field-error" role="alert">
          {issue}
        </p>
      )}
      {saved && !dirty && (
        <p className="field-ok" role="status">
          Бюджет сохранён: {formatUsd(settings.monthlyBudgetMicros)} в месяц.
        </p>
      )}
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
      <Row label={`${monthLabel(money.month)} · потрачено`}>
        <span className="mono money-figure">
          {formatUsd(money.spentMicros)} <span className="faint">из {formatUsd(budget)}</span>
        </span>
      </Row>
      <div className="budget-meter" aria-hidden="true">
        <span className="budget-meter-spent" style={{ width: `${spentShare}%` }} />
        <span className="budget-meter-reserved" style={{ width: `${reservedShare}%` }} />
      </div>
      <Row label="Незакрытые резервы" hint="Запросы без итога считаются по худшей цене до сверки.">
        <span className="mono money-figure">
          {money.unsettledCount === 0
            ? "нет"
            : `${countOf(money.unsettledCount, ["резерв", "резерва", "резервов"])} · до ${formatUsd(money.unsettledMicros, 2, "up")}`}
        </span>
      </Row>
    </>
  );
}

function ReconcileOutcome({ result }: { result: Extract<ReconcileResult, { status: "done" }> }) {
  const credits = result.creditsDeltaMicros;
  const trailer = (
    <>
      {result.closedReserves > 0 && (
        <p className="field-hint">Закрыто по худшей цене: {countOf(result.closedReserves, ["резерв", "резерва", "резервов"])}.</p>
      )}
      {result.tornLineMoved && <p className="field-hint">Обрезанная строка журнала перенесена в ledger.torn.</p>}
    </>
  );
  // No /credits delta to compare (the first reconcile, or usage that went
  // down): say why, but still show the ledger's own delta for the window.
  if (credits === null) {
    return (
      <div className="reconcile-outcome" role="status">
        <dl className="reconcile-totals">
          <div>
            <dt>Журнал Studio</dt>
            <dd className="mono">{formatUsd(result.ledgerDeltaMicros, 4)}</dd>
          </div>
        </dl>
        <Notice tone="info">{result.deltaUnavailable && DELTA_UNAVAILABLE_TEXT[result.deltaUnavailable]}</Notice>
        {trailer}
      </div>
    );
  }
  const diff = Math.abs(credits - result.ledgerDeltaMicros);
  const mismatch = diff > RECONCILE_TOLERANCE_MICROS;
  const higher = credits > result.ledgerDeltaMicros;
  return (
    <div className="reconcile-outcome" role="status">
      <dl className="reconcile-totals">
        <div>
          <dt>OpenRouter · /credits</dt>
          <dd className="mono">{formatUsd(credits, 4)}</dd>
        </div>
        <div>
          <dt>Журнал Studio</dt>
          <dd className="mono">{formatUsd(result.ledgerDeltaMicros, 4)}</dd>
        </div>
      </dl>
      {mismatch ? (
        <Notice tone="warn" title={`Расхождение ${formatUsd(diff, 4)}`}>
          {higher
            ? "OpenRouter насчитал больше, чем записано в журнале. /credits общий для всего аккаунта — возможно, им пользовались вне Studio."
            : "В журнале больше, чем списал OpenRouter: незакрытые резервы закрыты по худшей цене, фактически списано меньше."}
        </Notice>
      ) : (
        <Notice tone="ok">Суммы сходятся: расхождение не больше {formatUsd(RECONCILE_TOLERANCE_MICROS)}.</Notice>
      )}
      {trailer}
    </div>
  );
}

function ReconcileBlock({ money, engineError }: { money: MoneyStatus; engineError: EngineError | null }) {
  const { client, store } = useEngine();
  const [result, setResult] = useState<ReconcileResult | null>(null);
  const [error, setError] = useState<EngineError | null>(null);
  const [busy, setBusy] = useState(false);
  const [readyAt, setReadyAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const stop = paidStop({ money, engineError });
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
      <div className="reconcile">
        <Notice tone="danger" title="Сверка недоступна">
          <p>{restartStopText(stop.code)}</p>
          <p>Сверка тут не поможет: ей нужен исправный журнал расходов.</p>
        </Notice>
      </div>
    );
  }

  return (
    <div className="reconcile">
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
        hint="Сравнивает расход по /credits с журналом и закрывает резервы по худшей цене. OpenRouter обновляет расход с задержкой: сверка возможна через 2 минуты после последнего запроса."
      >
        <button
          type="button"
          className={needed ? "btn btn-sm btn-primary" : "btn btn-sm"}
          onClick={() => void reconcile()}
          disabled={busy || waiting}
          aria-busy={busy}
        >
          <Icon name="scale" size={14} />
          {busy ? "Сверяем…" : "Сверить"}
        </button>
      </Row>
      {result?.status === "too-early" && waiting && readyAt !== null && (
        <Notice tone="info" title="Слишком рано">
          OpenRouter ещё не обновил расход. Сверить можно через {waitLabel(readyAt - now)}.
        </Notice>
      )}
      {result?.warnings.includes("clock-skew") && <Notice tone="info">{RECONCILE_WARNING_TEXT["clock-skew"]}</Notice>}
      {result?.status === "done" && <ReconcileOutcome result={result} />}
      {error && <ErrorNotice error={error} />}
    </div>
  );
}

// ---------- performance, models, library ----------

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
      <div className="setting-row">
        <div className="setting-label">
          <span className="setting-name" id={labelId}>
            Параллельных запросов
          </span>
          <span className="setting-hint">
            От {MIN_CONCURRENCY} до {MAX_CONCURRENCY}. Если OpenRouter отвечает 429, Studio сама уменьшает число.
          </span>
        </div>
        <div className="setting-control stepper-control" role="group" aria-labelledby={labelId}>
          <button type="button" className="icon-btn" aria-label="Меньше" onClick={() => void change(value - 1)} disabled={busy || value <= MIN_CONCURRENCY}>
            <Icon name="minus" size={12} strokeWidth={2.6} />
          </button>
          <output className="mono stepper-value" aria-live="polite" aria-labelledby={labelId}>
            {value}
          </output>
          <button type="button" className="icon-btn" aria-label="Больше" onClick={() => void change(value + 1)} disabled={busy || value >= MAX_CONCURRENCY}>
            <Icon name="plus" size={12} strokeWidth={2.6} />
          </button>
        </div>
      </div>
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
          editing
            ? "Папка с аватарами и фото. Журнал расходов хранится отдельно и при переносе не теряется."
            : <span className="mono setting-path">{settings.libraryPath}</span>
        }
      >
        {!editing && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setPath(settings.libraryPath);
              setEditing(true);
            }}
          >
            <Icon name="folder" size={14} />
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
            className="input input-mono"
            type="text"
            value={path}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={issue !== null}
            aria-describedby={issue ? issueId : undefined}
            onChange={(e) => setPath(e.currentTarget.value)}
          />
          <button type="submit" className="btn btn-sm btn-primary" aria-label="Сохранить папку" disabled={busy}>
            {busy ? "Сохраняем…" : "Сохранить"}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-quiet"
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
  const keyHeading = useRef<HTMLHeadingElement>(null);
  const moneyHeading = useRef<HTMLHeadingElement>(null);
  const ready = view.phase === "ready";

  useEffect(() => {
    if (ready) void store.refreshMoney();
  }, [ready, store]);

  useEffect(() => {
    if (!ready || !focus) return;
    const target = focus === "key" ? keyHeading.current : moneyHeading.current;
    target?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    target?.focus({ preventScroll: true });
  }, [ready, focus]);

  const { settings, money } = view;

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
            <ApiKeyCard status={settings.apiKey} headingRef={keyHeading} />
            <Card title="Модели" id="settings-models">
              <Row label="Фото" hint="Портреты и сцены, 1K">
                <span className="mono model-id">{settings.imageModel}</span>
              </Row>
              <Row label="Текст и проверка возраста" hint="Дескриптор, сцены, проверка «явно старше 21»">
                <span className="mono model-id">{settings.textModel}</span>
              </Row>
              <p className="field-hint">Модели по умолчанию; выбор других появится позже.</p>
            </Card>
          </div>

          <div className="settings-col">
            <Card title="Деньги" id="settings-money" headingRef={moneyHeading}>
              <BudgetRow settings={settings} />
              {money?.ledger === "open" && <MoneyStatusRows money={money} />}
              {money && <ReconcileBlock money={money} engineError={view.engineError} />}
            </Card>
            <Card title="Производительность" id="settings-performance">
              <ConcurrencyRow settings={settings} />
            </Card>
            <Card title="Папки" id="settings-folders">
              <LibraryRow settings={settings} />
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
