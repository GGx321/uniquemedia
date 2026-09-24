import { MoneyError } from "./errors";
import { isAttemptId, type Clock, type Ledger, type LedgerLine, type Scope } from "./ledger";
import { reconcileLedger, type CreditsFetcher, type ReconcileResult } from "./reconcile";

/** The contract's attempt id rule, defined with the ledger that stores the ids. */
export { isAttemptId };

/** The client's request timeout (T3): an open reserve's request may have run this long after its `at`. */
export const REQUEST_TIMEOUT_MS = 180_000;

export interface BudgetLimits {
  /** One cap for every scope, or a cap per scope (a run's plan worst case, an avatar job's worst case). */
  runCapMicros: number | ((scope: Scope) => number);
  /** Global budget per UTC calendar month, at construction; `setMonthlyBudget` changes it. */
  monthlyBudgetMicros: number;
  /** Wall clock, epoch ms: ledger `at` values and the monthly window. */
  clock: Clock;
  /** Monotonic ms (`performance.now`-like): quiet time that survives wall-clock jumps. */
  monotonic: Clock;
}

export interface ReserveRequest {
  attemptId: string;
  jobId: string;
  scope: Scope;
  model: string;
  worstMicros: number;
}

export interface ReserveHandle {
  readonly attemptId: string;
  readonly jobId: string;
  readonly scope: Scope;
  readonly model: string;
  readonly worstMicros: number;
}

/**
 * SETTLE_ABOVE_WORST: an attempt after the latest reconcile marker was billed
 * above its worst case (the price table is wrong); it persists across restarts
 * until the user reconciles. LEDGER_WRITE_FAILED: a write failed in this process.
 */
export type HaltCause = "SETTLE_ABOVE_WORST" | "LEDGER_WRITE_FAILED";

export type ReserveRefusal =
  | { ok: false; reason: "BUDGET_EXCEEDED" | "RUN_CAP_EXCEEDED"; limitMicros: number; committedMicros: number; worstMicros: number }
  | { ok: false; reason: "RECONCILE_REQUIRED"; openAttempts: number; torn: boolean }
  | { ok: false; reason: "HALTED"; cause: HaltCause; detail: string };

export type ReserveResult = { ok: true; handle: ReserveHandle } | ReserveRefusal;

/** An attempt admitted ahead of its request (see `tryHold`). */
export interface HoldRequest {
  attemptId: string;
  scope: Scope;
  worstMicros: number;
}

/**
 * For the UI. With `haltCause: "SETTLE_ABOVE_WORST"` the UI (T8a) must list
 * `budget.aboveWorstAttempts()` — the attempts billed above their worst case —
 * next to the reconcile action that acknowledges them.
 */
export interface BudgetStatus {
  state: "ok" | "reconcile-required" | "halted";
  monthlyBudgetMicros: number;
  spentThisMonthMicros: number;
  /** Every open reserve at its worst case: this process's in-flight and abandoned ones, and earlier processes' ones. */
  openReserveMicros: number;
  openAttempts: number;
  /** Held attempts not yet reserved (see `tryHold`): in memory only, never on disk. */
  heldMicros: number;
  torn: boolean;
  haltCause: HaltCause | null;
}

type AttemptState = "in-flight" | "closed" | "abandoned";

/** Runs async tasks one at a time, in call order. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/** One key per cap: a photo run or an avatar job. */
export function scopeKey(scope: Scope): string {
  return "runId" in scope ? `run:${scope.runId}` : `avatar:${scope.avatarJobId}`;
}

function startOfUtcMonth(epochMs: number): number {
  const d = new Date(epochMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function assertMicros(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer number of micro-dollars, got ${value}`);
  }
}

interface Totals {
  spentThisMonth: number;
  openWorst: number;
  openAttempts: number;
  scopeSpent: number;
  scopeOpenWorst: number;
}

/**
 * Decides whether a paid attempt may start. Before any paid call:
 * spent this month + every open reserve at its worst case + this attempt's
 * worst case must be ≤ the monthly budget, and the same restricted to the
 * attempt's scope (all time) must be ≤ that scope's cap. The check and the
 * `reserve` append run under one mutex, so concurrent callers cannot jointly
 * exceed a limit, and the reserve is fsynced before the handle is returned.
 *
 * Open reserves left by an earlier process (or a torn ledger) refuse every
 * reserve with RECONCILE_REQUIRED: after a restart nothing is spent until the
 * user reconciles. A settle above its worst case after the latest reconcile
 * marker halts every reserve — in this process and after a restart — until
 * the user reconciles; a failed ledger write halts this process.
 */
export class Budget {
  readonly ledger: Ledger;
  readonly clock: Clock;
  private readonly monotonic: Clock;
  private readonly limits: BudgetLimits;
  /** The global budget now; `setMonthlyBudget` changes it under the mutex. */
  private monthlyBudgetMicros: number;
  private readonly mutex = new Mutex();
  private readonly own = new Map<string, { handle: ReserveHandle; state: AttemptState }>();
  /** Monotonic time this Budget was built, right after its ledger was opened. */
  private readonly openedAtMono: number;
  /** Monotonic time of this process's last ledger write or abandon. */
  private lastOwnActivityMono: number | null = null;
  /** Attempts admitted by `tryHold` and not yet reserved or released, by attempt id. */
  private readonly holds = new Map<string, { scopeKey: string; worstMicros: number }>();

  constructor(ledger: Ledger, limits: BudgetLimits) {
    assertMicros("monthlyBudgetMicros", limits.monthlyBudgetMicros);
    if (typeof limits.runCapMicros === "number") assertMicros("runCapMicros", limits.runCapMicros);
    this.ledger = ledger;
    this.clock = limits.clock;
    this.monotonic = limits.monotonic;
    this.limits = limits;
    this.monthlyBudgetMicros = limits.monthlyBudgetMicros;
    this.openedAtMono = limits.monotonic();
  }

  tryReserve(req: ReserveRequest): Promise<ReserveResult> {
    return this.mutex.run(async () => {
      assertMicros("worstMicros", req.worstMicros);
      if (!isAttemptId(req.attemptId)) throw new TypeError("attemptId must be 1-128 visible ASCII chars, as the contract carries it");
      const blocked = this.blocked();
      if (blocked) return blocked;
      if (this.ledger.reserveOf(req.attemptId)) {
        throw new MoneyError("ATTEMPT_ID_REUSED", `attempt ${req.attemptId} was already reserved; an attempt id is never sent twice`);
      }

      // The attempt's own hold, if any, is what this reserve replaces: it is not counted twice.
      const totals = this.totals(req.scope);
      const monthCommitted = totals.spentThisMonth + totals.openWorst + this.heldMicros(null, req.attemptId);
      if (monthCommitted + req.worstMicros > this.monthlyBudgetMicros) {
        return { ok: false, reason: "BUDGET_EXCEEDED", limitMicros: this.monthlyBudgetMicros, committedMicros: monthCommitted, worstMicros: req.worstMicros };
      }
      const cap = this.capOf(req.scope);
      const scopeCommitted = totals.scopeSpent + totals.scopeOpenWorst + this.heldMicros(scopeKey(req.scope), req.attemptId);
      if (scopeCommitted + req.worstMicros > cap) {
        return { ok: false, reason: "RUN_CAP_EXCEEDED", limitMicros: cap, committedMicros: scopeCommitted, worstMicros: req.worstMicros };
      }

      await this.#write({
        type: "reserve",
        attemptId: req.attemptId,
        jobId: req.jobId,
        scope: req.scope,
        model: req.model,
        worstMicros: req.worstMicros,
        at: this.nowIso(),
      });
      const handle: ReserveHandle = Object.freeze({
        attemptId: req.attemptId,
        jobId: req.jobId,
        scope: req.scope,
        model: req.model,
        worstMicros: req.worstMicros,
      });
      this.own.set(req.attemptId, { handle, state: "in-flight" });
      this.holds.delete(req.attemptId);
      return { ok: true, handle };
    });
  }

  /**
   * Records what the attempt cost. A cost above the reserved worst case is
   * recorded first, then throws a fatal SETTLE_ABOVE_WORST; the recorded line
   * halts every reserve until the user reconciles.
   */
  settle(handle: ReserveHandle, bill: { costMicros: number; estimated: boolean }): Promise<void> {
    return this.mutex.run(async () => {
      assertMicros("costMicros", bill.costMicros);
      const entry = this.inFlight(handle);
      await this.#write({
        type: "settle",
        attemptId: handle.attemptId,
        costMicros: bill.costMicros,
        estimated: bill.estimated,
        at: this.nowIso(),
      });
      entry.state = "closed";
      if (bill.costMicros > handle.worstMicros) {
        throw new MoneyError(
          "SETTLE_ABOVE_WORST",
          `attempt ${handle.attemptId} (${handle.model}) was billed ${bill.costMicros} µ$, above its worst case ${handle.worstMicros} µ$; the price table is wrong`,
          { fatal: true }
        );
      }
    });
  }

  /** Closes an attempt that provably never reached OpenRouter (it failed before `fetch`). */
  release(handle: ReserveHandle, reason: string): Promise<void> {
    return this.mutex.run(async () => {
      const entry = this.inFlight(handle);
      await this.#write({ type: "release", attemptId: handle.attemptId, reason, at: this.nowIso() });
      entry.state = "closed";
    });
  }

  /**
   * Gives up on an aborted, timed-out or network-failed attempt: no line is
   * written, the reserve stays open at its worst case until reconcile, and the
   * attempt can no longer be settled or released. Counts as activity for the
   * reconcile wait, since the request ended only now.
   */
  abandon(handle: ReserveHandle): Promise<void> {
    return this.mutex.run(async () => {
      this.inFlight(handle).state = "abandoned";
      this.lastOwnActivityMono = this.monotonic();
    });
  }

  /**
   * A new global budget (Settings), under this Budget's mutex: a reserve whose
   * check and write are under way finishes against the old value, every later
   * reserve is checked against the new one. The Budget itself stays, so its
   * own open reserves stay its own and there is still one mutex on the ledger.
   * Writes nothing.
   */
  setMonthlyBudget(micros: number): Promise<void> {
    return this.mutex.run(async () => {
      assertMicros("monthlyBudgetMicros", micros);
      this.monthlyBudgetMicros = micros;
    });
  }

  /**
   * Admits several attempts together before any of them is sent, e.g. an
   * image and the age check that must follow it: all of them fit the monthly
   * budget and their scopes' caps with everything committed and held so far,
   * or none is held. A hold is in memory only (no request has left, so
   * nothing goes to the ledger) and counts in every later check until its
   * attempt is reserved, which takes the hold's place, or it is released.
   */
  tryHold(requests: readonly HoldRequest[]): Promise<{ ok: true } | ReserveRefusal> {
    return this.mutex.run(async () => {
      const ids = new Set<string>();
      for (const r of requests) {
        assertMicros("worstMicros", r.worstMicros);
        if (!isAttemptId(r.attemptId)) throw new TypeError("attemptId must be 1-128 visible ASCII chars, as the contract carries it");
        if (this.ledger.reserveOf(r.attemptId) || this.holds.has(r.attemptId) || ids.has(r.attemptId)) {
          throw new MoneyError("ATTEMPT_ID_REUSED", `attempt ${r.attemptId} was already reserved or held; an attempt id is never sent twice`);
        }
        ids.add(r.attemptId);
      }
      const blocked = this.blocked();
      if (blocked) return blocked;

      const worstMicros = requests.reduce((sum, r) => sum + r.worstMicros, 0);
      const month = this.totals(null);
      const monthCommitted = month.spentThisMonth + month.openWorst + this.heldMicros(null);
      if (monthCommitted + worstMicros > this.monthlyBudgetMicros) {
        return { ok: false, reason: "BUDGET_EXCEEDED", limitMicros: this.monthlyBudgetMicros, committedMicros: monthCommitted, worstMicros };
      }
      for (const scope of new Map(requests.map((r) => [scopeKey(r.scope), r.scope])).values()) {
        const key = scopeKey(scope);
        const scopeWorst = requests.filter((r) => scopeKey(r.scope) === key).reduce((sum, r) => sum + r.worstMicros, 0);
        const totals = this.totals(scope);
        const cap = this.capOf(scope);
        const scopeCommitted = totals.scopeSpent + totals.scopeOpenWorst + this.heldMicros(key);
        if (scopeCommitted + scopeWorst > cap) {
          return { ok: false, reason: "RUN_CAP_EXCEEDED", limitMicros: cap, committedMicros: scopeCommitted, worstMicros: scopeWorst };
        }
      }
      for (const r of requests) this.holds.set(r.attemptId, { scopeKey: scopeKey(r.scope), worstMicros: r.worstMicros });
      return { ok: true };
    });
  }

  /** Gives a held attempt's room back (it will not be sent); a reserved or unknown one is left as it is. */
  releaseHold(attemptId: string): void {
    this.holds.delete(attemptId);
  }

  /** How many of this process's attempts are still waiting for a response. */
  inFlightCount(): number {
    let n = 0;
    for (const entry of this.own.values()) if (entry.state === "in-flight") n++;
    return n;
  }

  /** Attempts after the latest reconcile marker that were billed above their worst case. */
  aboveWorstAttempts(): string[] {
    const lines = this.ledger.lines;
    const ids: string[] = [];
    for (let i = lines.findLastIndex((l) => l.type === "reconcile") + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line?.type !== "settle") continue;
      const reserve = this.ledger.reserveOf(line.attemptId);
      if (reserve && line.costMicros > reserve.worstMicros) ids.push(line.attemptId);
    }
    return ids;
  }

  /**
   * How long the ledger has been quiet, for the reconcile wait (`/credits`
   * lags). Activity is: the latest `at` in the ledger; an open reserve of an
   * earlier process until `at + REQUEST_TIMEOUT_MS` (its request may have run
   * that long); this process's last write or abandon, on the monotonic clock. An open
   * reserve of an earlier process also counts as active until
   * REQUEST_TIMEOUT_MS after this Budget opened the ledger (monotonic), so a
   * wall clock that jumped forward cannot shorten the wait after a restart.
   * If the ledger holds an `at` later than the wall clock now (the clock was
   * wrong when it was written, or is wrong now), wall times are not trusted:
   * quiet time counts from ledger open on the monotonic clock, and
   * `clockSkew` is set.
   */
  quiet(): { quietMs: number; clockSkew: boolean } {
    const now = this.clock();
    const mono = this.monotonic();
    const ownQuiet = this.lastOwnActivityMono === null ? Number.POSITIVE_INFINITY : mono - this.lastOwnActivityMono;
    const foreignOpen = this.ledger.openReserves().filter((r) => !this.own.has(r.attemptId));
    const lastWrite = this.ledger.lastWriteAt();

    const sinceOpen = mono - this.openedAtMono - (foreignOpen.length > 0 ? REQUEST_TIMEOUT_MS : 0);

    if (lastWrite !== null && lastWrite > now) {
      return { quietMs: Math.min(sinceOpen, ownQuiet), clockSkew: true };
    }
    let lastActivity = lastWrite ?? Number.NEGATIVE_INFINITY;
    for (const reserve of foreignOpen) lastActivity = Math.max(lastActivity, Date.parse(reserve.at) + REQUEST_TIMEOUT_MS);
    const foreignQuiet = foreignOpen.length > 0 ? sinceOpen : Number.POSITIVE_INFINITY;
    return { quietMs: Math.min(now - lastActivity, ownQuiet, foreignQuiet), clockSkew: false };
  }

  status(): BudgetStatus {
    const totals = this.totals(null);
    const blocked = this.blocked();
    return {
      state: blocked === null ? "ok" : blocked.reason === "HALTED" ? "halted" : "reconcile-required",
      monthlyBudgetMicros: this.monthlyBudgetMicros,
      spentThisMonthMicros: totals.spentThisMonth,
      openReserveMicros: totals.openWorst,
      openAttempts: totals.openAttempts,
      heldMicros: this.heldMicros(null),
      torn: this.ledger.torn !== null,
      haltCause: blocked?.reason === "HALTED" ? blocked.cause : null,
    };
  }

  /**
   * The user's reconcile action (see `reconcileLedger`), under this Budget's
   * mutex so no reserve interleaves with it. Reconcile is the only code outside
   * this class that may append through the Budget: it gets the private writer
   * for the duration of this call.
   */
  reconcile(opts: { fetchCredits: CreditsFetcher }): Promise<ReconcileResult> {
    return this.mutex.run(() =>
      reconcileLedger(
        {
          ledger: this.ledger,
          clock: this.clock,
          inFlight: this.inFlightCount(),
          quiet: this.quiet(),
          aboveWorstAttempts: this.aboveWorstAttempts(),
          write: (line) => this.#write(line),
        },
        opts
      )
    );
  }

  /** Appends a line on behalf of this process and records the activity time. Private: every public path checks the limits. */
  async #write(line: LedgerLine): Promise<void> {
    await this.ledger.append(line);
    this.lastOwnActivityMono = this.monotonic();
  }

  private blocked(): ReserveRefusal | null {
    if (this.ledger.failed) {
      return { ok: false, reason: "HALTED", cause: "LEDGER_WRITE_FAILED", detail: "a ledger write failed; restart the app" };
    }
    const above = this.aboveWorstAttempts();
    if (above.length > 0) {
      return {
        ok: false,
        reason: "HALTED",
        cause: "SETTLE_ABOVE_WORST",
        detail: `billed above the worst case: ${above.join(", ")}; the price table is wrong, reconcile to acknowledge`,
      };
    }
    const open = this.ledger.openReserves();
    const foreign = open.some((r) => !this.own.has(r.attemptId));
    if (this.ledger.torn !== null || foreign) {
      return { ok: false, reason: "RECONCILE_REQUIRED", openAttempts: open.length, torn: this.ledger.torn !== null };
    }
    return null;
  }

  private inFlight(handle: ReserveHandle): { handle: ReserveHandle; state: AttemptState } {
    const entry = this.own.get(handle.attemptId);
    if (!entry || entry.handle !== handle) {
      throw new MoneyError("UNKNOWN_ATTEMPT", `attempt ${handle.attemptId} was not reserved by this budget`);
    }
    if (entry.state !== "in-flight") {
      throw new MoneyError("ATTEMPT_CLOSED", `attempt ${handle.attemptId} is already ${entry.state}`);
    }
    return entry;
  }

  /** Held micro-dollars, in one scope or all of them, leaving out the attempt a reserve is replacing. */
  private heldMicros(key: string | null, except?: string): number {
    let sum = 0;
    for (const [attemptId, held] of this.holds) {
      if (attemptId !== except && (key === null || held.scopeKey === key)) sum += held.worstMicros;
    }
    return sum;
  }

  private capOf(scope: Scope): number {
    const cap = typeof this.limits.runCapMicros === "number" ? this.limits.runCapMicros : this.limits.runCapMicros(scope);
    assertMicros(`runCapMicros for ${scopeKey(scope)}`, cap);
    return cap;
  }

  private totals(scope: Scope | null): Totals {
    const key = scope ? scopeKey(scope) : null;
    const monthStart = startOfUtcMonth(this.clock());
    const t: Totals = { spentThisMonth: 0, openWorst: 0, openAttempts: 0, scopeSpent: 0, scopeOpenWorst: 0 };
    for (const line of this.ledger.lines) {
      if (line.type !== "settle") continue;
      const reserve = this.ledger.reserveOf(line.attemptId);
      if (!reserve) throw new MoneyError("LEDGER_CORRUPT", `settle for ${line.attemptId} has no reserve`, { fatal: true });
      // No upper bound: a future-dated settle (clock skew) counts in every month until its date — conservative.
      if (Date.parse(line.at) >= monthStart) t.spentThisMonth += line.costMicros;
      if (scopeKey(reserve.scope) === key) t.scopeSpent += line.costMicros;
    }
    for (const reserve of this.ledger.openReserves()) {
      t.openWorst += reserve.worstMicros;
      t.openAttempts++;
      if (scopeKey(reserve.scope) === key) t.scopeOpenWorst += reserve.worstMicros;
    }
    for (const [name, value] of Object.entries(t)) {
      if (!Number.isSafeInteger(value)) throw new MoneyError("LEDGER_CORRUPT", `ledger total ${name} overflowed`, { fatal: true });
    }
    return t;
  }

  private nowIso(): string {
    return new Date(this.clock()).toISOString();
  }
}
