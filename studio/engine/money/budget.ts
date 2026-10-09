import { STUDIO_E2E } from "../buildFlags";
import { MoneyError } from "./errors";
import { isAttemptId, type Clock, type Ledger, type LedgerLine, type Scope } from "./ledger";
import { reconcileLedger, type CreditsFetcher, type ReconcileResult } from "./reconcile";

/** The contract's attempt id rule, defined with the ledger that stores the ids. */
export { isAttemptId };

/**
 * The client's request timeout (T3): an open reserve's request may have run this long after its `at`.
 * An E2E build (never a shipped one: the flag is a build-time constant) shrinks it, and RECONCILE_QUIET_MS with it, so
 * the packaged smoke does not wait out minutes of real time for a reconcile (the mock answers in well under a second).
 *
 * An E2E build must never be pointed at the real OpenRouter: with the request timeout at 15 s and the quiet period at 5 s,
 * the reconcile rule that protects the owner's money (a request that ran long is waited out before the ledger is trusted
 * again) is a fraction of what production keeps. It is a throwaway build made only by `build:studio:e2e` for the smoke and
 * its mock, never uploaded or published (studio.yml), and `build:studio` pins STUDIO_E2E=0, so a stray variable or `.env`
 * line cannot turn a local production build into one.
 */
export const REQUEST_TIMEOUT_MS = STUDIO_E2E ? 15_000 : 180_000;

export interface BudgetLimits {
  /** One cap for every scope, or a cap per scope (a run's plan worst case, an avatar job's worst case). */
  runCapMicros: number | ((scope: Scope) => number);
  /** Global budget per UTC calendar month, at construction; `setMonthlyBudget` changes it. */
  monthlyBudgetMicros: number;
  /** Wall clock, epoch ms: ledger `at` values and the monthly window. */
  clock: Clock;
  /** Monotonic ms (`performance.now`-like): quiet time that survives wall-clock jumps. */
  monotonic: Clock;
  /**
   * Stage 4 (plan §4.10): the group an attempt belongs to, with the group's cap, or null for none. A launch's writer attempts and slice runs are one group
   * whose cap is the launch's recomputed worst case W′. Asked for the attempt being reserved or held (its id and scope) and, for the group's committed, for
   * every reserve already in the ledger, so a group is restored by the mapping alone: the ledger format does not change. A group that maps nothing (a
   * finished launch) limits nothing.
   */
  groupOf?: (req: { attemptId: string; scope: Scope }) => AttemptGroup | null;
}

/** A group of attempts that share one cap across scopes: `key` names it, `capMicros` is the most its attempts may commit together. */
export interface AttemptGroup {
  key: string;
  capMicros: number;
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
  /** Settled at cost (all time) and open at worst, over the ledger lines whose reserve maps to the requested group key. */
  groupSpent: number;
  groupOpenWorst: number;
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
  private readonly holds = new Map<string, { scopeKey: string; groupKey: string | null; worstMicros: number }>();

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
      const group = this.groupOf(req);
      const totals = this.totals(req.scope, group?.key ?? null);
      const monthCommitted = totals.spentThisMonth + totals.openWorst + this.heldMicros(null, req.attemptId);
      if (monthCommitted + req.worstMicros > this.monthlyBudgetMicros) {
        return { ok: false, reason: "BUDGET_EXCEEDED", limitMicros: this.monthlyBudgetMicros, committedMicros: monthCommitted, worstMicros: req.worstMicros };
      }
      const cap = this.capOf(req.scope);
      const scopeCommitted = totals.scopeSpent + totals.scopeOpenWorst + this.heldMicros(scopeKey(req.scope), req.attemptId);
      if (scopeCommitted + req.worstMicros > cap) {
        return { ok: false, reason: "RUN_CAP_EXCEEDED", limitMicros: cap, committedMicros: scopeCommitted, worstMicros: req.worstMicros };
      }
      if (group !== null) {
        const groupCommitted = totals.groupSpent + totals.groupOpenWorst + this.heldMicrosOfGroup(group.key, req.attemptId);
        if (groupCommitted + req.worstMicros > group.capMicros) {
          return { ok: false, reason: "RUN_CAP_EXCEEDED", limitMicros: group.capMicros, committedMicros: groupCommitted, worstMicros: req.worstMicros };
        }
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
      const groups = new Map<string, { group: AttemptGroup; worstMicros: number }>();
      const groupKeyOf = new Map<string, string | null>();
      for (const r of requests) {
        const group = this.groupOf(r);
        groupKeyOf.set(r.attemptId, group?.key ?? null);
        if (group === null) continue;
        const entry = groups.get(group.key);
        if (entry === undefined) groups.set(group.key, { group, worstMicros: r.worstMicros });
        else entry.worstMicros += r.worstMicros;
      }
      for (const { group, worstMicros: groupWorst } of groups.values()) {
        const totals = this.totals(null, group.key);
        const groupCommitted = totals.groupSpent + totals.groupOpenWorst + this.heldMicrosOfGroup(group.key);
        if (groupCommitted + groupWorst > group.capMicros) {
          return { ok: false, reason: "RUN_CAP_EXCEEDED", limitMicros: group.capMicros, committedMicros: groupCommitted, worstMicros: groupWorst };
        }
      }
      for (const r of requests) this.holds.set(r.attemptId, { scopeKey: scopeKey(r.scope), groupKey: groupKeyOf.get(r.attemptId) ?? null, worstMicros: r.worstMicros });
      return { ok: true };
    });
  }

  /**
   * What a group has committed: settled at cost (all time), open at worst and held, over every ledger line whose reserve maps to `key` — computed by the very
   * `totals` the group's check uses, so a launch's «Потрачено» and R are exactly the sum the Budget enforces.
   *
   * Invariant: the group is registered (`groupOf` maps it) before the first hold or reserve of any of its attempts. A hold or reserve made while the
   * mapping is absent is admitted outside the group and is counted in it only from the moment the mapping exists (a hold is remembered by the key it had then).
   */
  committedOfGroup(key: string): number {
    const totals = this.totals(null, key);
    return totals.groupSpent + totals.groupOpenWorst + this.heldMicrosOfGroup(key);
  }

  /**
   * What each scope has committed, by `scopeKey`: settled at cost (all time), open at worst, and held. A scope the ledger and the holds have not seen is
   * absent. The engine's month room (`room.ts`) subtracts, for every live scope, what is left of its cap, and this is the "committed" side of that.
   * One walk over the ledger for every scope.
   */
  committedByScope(): Map<string, number> {
    const committed = new Map<string, number>();
    const add = (key: string, micros: number): void => void committed.set(key, (committed.get(key) ?? 0) + micros);
    for (const line of this.ledger.lines) {
      if (line.type !== "settle") continue;
      const reserve = this.ledger.reserveOf(line.attemptId);
      if (!reserve) throw new MoneyError("LEDGER_CORRUPT", `settle for ${line.attemptId} has no reserve`, { fatal: true });
      add(scopeKey(reserve.scope), line.costMicros);
    }
    for (const reserve of this.ledger.openReserves()) add(scopeKey(reserve.scope), reserve.worstMicros);
    for (const held of this.holds.values()) add(held.scopeKey, held.worstMicros);
    for (const [key, value] of committed) {
      if (!Number.isSafeInteger(value)) throw new MoneyError("LEDGER_CORRUPT", `ledger total for ${key} overflowed`, { fatal: true });
    }
    return committed;
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

  /**
   * Whether `scope` has an open reserve that only a user's reconcile can close: one this process has no request
   * in flight for (left by a crash, an abort or a timeout). Other scopes' reserves and a torn line are the
   * ledger's business, not this scope's — its committed money cannot change by reconciling them.
   */
  scopeNeedsReconcile(scope: Scope): boolean {
    const key = scopeKey(scope);
    return this.ledger.openReserves().some((r) => scopeKey(r.scope) === key && this.own.get(r.attemptId)?.state !== "in-flight");
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

  /** Held micro-dollars of one group, leaving out the attempt a reserve is replacing. */
  private heldMicrosOfGroup(key: string, except?: string): number {
    let sum = 0;
    for (const [attemptId, held] of this.holds) {
      if (attemptId !== except && held.groupKey === key) sum += held.worstMicros;
    }
    return sum;
  }

  private groupOf(req: { attemptId: string; scope: Scope }): AttemptGroup | null {
    const group = this.limits.groupOf?.({ attemptId: req.attemptId, scope: req.scope }) ?? null;
    if (group !== null) assertMicros(`group cap for ${group.key}`, group.capMicros);
    return group;
  }

  private capOf(scope: Scope): number {
    const cap = typeof this.limits.runCapMicros === "number" ? this.limits.runCapMicros : this.limits.runCapMicros(scope);
    assertMicros(`runCapMicros for ${scopeKey(scope)}`, cap);
    return cap;
  }

  private totals(scope: Scope | null, groupKey: string | null = null): Totals {
    const key = scope ? scopeKey(scope) : null;
    const monthStart = startOfUtcMonth(this.clock());
    const t: Totals = { spentThisMonth: 0, openWorst: 0, openAttempts: 0, scopeSpent: 0, scopeOpenWorst: 0, groupSpent: 0, groupOpenWorst: 0 };
    const inGroup = (reserve: { attemptId: string; scope: Scope }): boolean => groupKey !== null && this.limits.groupOf?.({ attemptId: reserve.attemptId, scope: reserve.scope })?.key === groupKey;
    for (const line of this.ledger.lines) {
      if (line.type !== "settle") continue;
      const reserve = this.ledger.reserveOf(line.attemptId);
      if (!reserve) throw new MoneyError("LEDGER_CORRUPT", `settle for ${line.attemptId} has no reserve`, { fatal: true });
      // No upper bound: a future-dated settle (clock skew) counts in every month until its date — conservative.
      if (Date.parse(line.at) >= monthStart) t.spentThisMonth += line.costMicros;
      if (scopeKey(reserve.scope) === key) t.scopeSpent += line.costMicros;
      if (inGroup(reserve)) t.groupSpent += line.costMicros;
    }
    for (const reserve of this.ledger.openReserves()) {
      t.openWorst += reserve.worstMicros;
      t.openAttempts++;
      if (scopeKey(reserve.scope) === key) t.scopeOpenWorst += reserve.worstMicros;
      if (inGroup(reserve)) t.groupOpenWorst += reserve.worstMicros;
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
