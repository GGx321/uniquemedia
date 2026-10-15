import type { ClipBatchStop, ClipCancelDetail, ClipPrices, EngineError } from "../../shared/engine";
import type { BatchChange } from "../../shared/engine/clipBatchSummary";

// Stage 5, 5b.2, S5.WB3 (plan s5b2 §5.2.2, I5.61-I5.63): the batch «Оживить выбранные» of the mock engine, the mirror of engine/clips/batch.ts. It is the same scheduler over the same ports, written for the
// mock's clock: no promise waits, every wait is a timer of the mock's scheduler, so a test and the parity rig move it by the clock they already move. A batch is the queue of its members and the one walk over it:
//
//   queued     every member is a job from the batch's start (memory only: no reserve, no journal line, no record), in the pick order, each holding its share of the month and, in the engine, its cap.
//   a turn     when the member before it has CLOSED ITS MONEY (not when its file is downloaded): (1) the photo is read again; (2) the price book is read again and the member's worst case must still be within its
//              share; (3) the 429 pause and the wait for the money to be alone (`clipAlone`, the very function the engine reads, bounded by `aloneWaitMs`); (4) the key; then the member's clip runs, as a single clip does.
//   stops      a price above the share, a price that cannot be read, a ledger that refused or halted, a member whose money is uncertain: every member still queued is cancelled for free with the matching detail, its
//              hold released. Nothing queued ever holds a reserve.
//   a 429      a member refused at its submit is requeued once, at the tail, as a new job under a new clip id (the 429'd clip keeps its free `rate-limited` record), waiting for its `turn`. No member is
//              submitted for `rateLimitPauseMs` after any 429 (the member whose turn falls inside the pause says `rate-limit`), and a cancel by the owner (`clips.cancelBatch`) is final: nothing is requeued after it.
//   the end    when nothing is queued and the last member's money is closed the unit goes back (`ports.finished`).
//
// The mock's holds are in memory like the engine's (`Budget.tryHold`): a restart drops the batch (`drop`) and its members with it, and nothing is announced.

/** One member of a batch: a photo made into a clip, and the job that stands for it now. A member requeued after a 429 is a new object with a new job and `retried` set. */
export interface BatchMember<P> {
  /** 1-based, the pick order; the same for the requeued member of a 429. */
  readonly index: number;
  readonly photoId: string;
  readonly bold: boolean;
  /** Its worst case under the batch's price book at create: the figure that caps it and holds the month for it. */
  readonly share: number;
  readonly jobId: string;
  readonly clipId: string;
  /** The member's `${clipId}:video#1` holds the month until the first reserve takes it. A requeued member holds nothing: its reserve checks the month itself. */
  readonly held: boolean;
  readonly retried: boolean;
  /** What the mock needs to run the member's clip (the request, the motion, the facts): opaque here. */
  readonly payload: P;
  state: "queued" | "running" | "ended";
  /** Cancels the member's timer (the pause, the alone-wait), so a cancelled member's wait ends at once. */
  wake: (() => void) | null;
}

/** How a member's money state machine ended, as the batch needs it (engine/clips/job.ts `ClipMoneyEnd`; no money figure travels). */
export type MockMoneyEnd =
  | { kind: "completed"; aboveWorst: boolean }
  | { kind: "failed"; reason: string; aboveWorst: boolean }
  | { kind: "late" }
  | { kind: "not-reserved"; reason: string }
  | { kind: "cancelled" }
  | { kind: "interrupted" }
  | { kind: "fault" };

/** What the mock hands the batch. */
export interface MockBatchPorts<P> {
  readonly clock: () => number;
  /** A timer of the mock's scheduler that also moves the mock's clock when it fires; the returned function cancels it. */
  readonly later: (ms: number, fn: () => void) => () => void;
  readonly timings: { readonly aloneWaitMs: number; readonly proofRetryMs: number; readonly rateLimitPauseMs: number };
  /** The usable key now, or the refusal (AUTH_INVALID) when there is none or OpenRouter rejected it. */
  readonly readKey: () => EngineError | null;
  /** The price book now: the cache while it is fresh (10 minutes), else a read; `null` when the listing reads and lacks a price (PRICE_UNAVAILABLE). */
  readonly readPrices: () => ClipPrices | null;
  readonly worstOf: (member: BatchMember<P>, prices: ClipPrices) => number;
  readonly recheck: (member: BatchMember<P>) => "ok" | "gone" | "unreadable";
  readonly alone: (member: BatchMember<P>) => boolean;
  /** The member waits: `queued` with the reason, announced. */
  readonly told: (member: BatchMember<P>, reason: "turn" | "alone" | "rate-limit") => void;
  /** A queued member never runs: its job ends cancelled (with why), announced; its month hold goes back. */
  readonly cancelJob: (member: BatchMember<P>, detail: ClipCancelDetail | undefined) => void;
  /** A member whose turn could not start (no usable key): its job fails, free, with the error. */
  readonly failJob: (member: BatchMember<P>, error: EngineError) => void;
  /** A member requeued after a 429: a new job with a new id for the same place in the batch, announced `queued` under `rate-limit`. */
  readonly requeue: (member: BatchMember<P>) => BatchMember<P>;
  /** The member's turn has come: the mock's clip, as a single clip runs. The batch hears of its money through `ports.closed`. */
  readonly runMember: (member: BatchMember<P>, prices: ClipPrices) => void;
  readonly releaseHold: (member: BatchMember<P>) => void;
  /** The batch is over: the unit goes back. Called once. */
  readonly finished: () => void;
  readonly log: (line: string) => void;
  /** 5b.2 (S5.WB2c): a transition of the batch, for its summary, at the engine's moments (engine/clips/batch.ts `ports.note`). */
  readonly note: (change: BatchChange) => void;
}

/** A member whose money ended in one of these has an open reserve nobody can price until the reconcile: the queue is not spent blind. */
const UNCERTAIN_REASONS: readonly string[] = ["submit-uncertain", "late", "lost"];

export class MockClipBatch<P> {
  readonly id: string;
  readonly avatarId: string;
  readonly #ports: MockBatchPorts<P>;
  /** In queue order: the members as picked, then the requeued tail. */
  readonly #members: BatchMember<P>[];
  readonly #size: number;
  /** A stop was ordered: nothing is requeued and nothing new runs. */
  #stopped = false;
  /** Epoch ms: no member is submitted before it (the pause after a 429). */
  #notBefore = 0;
  #finished = false;
  #dropped = false;
  /** The member whose turn is under way (waiting or running): the walk goes on when it ends. */
  #current: BatchMember<P> | null = null;
  #scheduled = false;

  constructor(ports: MockBatchPorts<P>, init: { id: string; avatarId: string; members: readonly BatchMember<P>[] }) {
    this.#ports = ports;
    this.id = init.id;
    this.avatarId = init.avatarId;
    this.#members = [...init.members];
    this.#size = init.members.length;
  }

  get size(): number {
    return this.#size;
  }

  /** Walks the queue. */
  start(): void {
    this.#schedule();
  }

  /** True once the batch's last member has closed its money (or the queue was dropped). */
  get over(): boolean {
    return this.#finished;
  }

  /** Whether this job id is a member of the batch that is still queued. */
  isQueued(jobId: string): boolean {
    return this.#members.some((member) => member.jobId === jobId && member.state === "queued");
  }

  /** The members as they stand now: for the quit question and the tests. */
  members(): readonly BatchMember<P>[] {
    return this.#members;
  }

  /** `avatars.cancel` on one queued member: it alone is cancelled, free. False when the job is not a queued member of this batch. */
  cancelMember(jobId: string): boolean {
    const member = this.#members.find((candidate) => candidate.jobId === jobId && candidate.state === "queued");
    return member !== undefined && this.#cancel(member, "cancelled");
  }

  /** `clips.cancelBatch`: every queued member, free. A member already submitted (or preparing) is never cancelled here. The count of those cancelled. */
  cancelQueued(): number {
    // The owner's cancel is final: nothing is requeued after it (a 429 of the member in flight ends that member, it does not start a new paid POST).
    this.#stopped = true;
    let cancelled = 0;
    for (const member of this.#members) if (member.state === "queued" && this.#cancel(member, "cancelled")) cancelled++;
    if (cancelled > 0) this.#ports.note({ kind: "stop", detail: "cancelled" });
    return cancelled;
  }

  /** The engine process is gone: the queue is dropped in silence (no event, no hold to give back: the holds died with the process). */
  drop(): void {
    this.#dropped = true;
    this.#finished = true;
    for (const member of this.#members) {
      member.wake?.();
      member.wake = null;
    }
  }

  // ---------- the walk ----------

  /** The next step, one tick of the mock's scheduler later: the member's own events (its download) are announced before the next member's turn begins, as the engine's promise resolves after them. */
  #schedule(): void {
    if (this.#scheduled || this.#dropped || this.#finished) return;
    this.#scheduled = true;
    this.#ports.later(0, () => {
      this.#scheduled = false;
      this.#loop();
    });
  }

  #loop(): void {
    if (this.#dropped || this.#finished || this.#current !== null) return;
    const member = this.#members.find((candidate) => candidate.state === "queued");
    if (member === undefined) {
      // The end: nothing queued and the last member's money is closed.
      this.#stopped = true;
      this.#finished = true;
      this.#ports.note({ kind: "over", at: new Date(this.#ports.clock()).toISOString() });
      this.#ports.finished();
      return;
    }
    this.#current = member;
    this.#turn(member);
  }

  /**
   * The member's turn is over (it ended, or its money closed): the walk goes on. The END of the batch comes at once (the engine's loop falls through in the microtasks that follow the member's money
   * closing, before any command can be heard), but the next member's turn is a tick later: its photo and its price are read, which takes the engine real I/O after the member's own events.
   */
  #next(member: BatchMember<P>): void {
    if (this.#current === member) this.#current = null;
    if (this.#members.some((candidate) => candidate.state === "queued")) this.#schedule();
    else this.#loop();
  }

  // ---------- one turn ----------

  #turn(member: BatchMember<P>): void {
    const ports = this.#ports;

    // 1. The photo, read again: it may have been deleted or damaged since the sheet.
    const photo = ports.recheck(member);
    if (photo !== "ok") {
      this.#cancel(member, photo === "gone" ? "photo-gone" : "photo-unreadable");
      return;
    }

    // 2. The price, read again (the cache while it is fresh): the member's worst case must still be within its share.
    const prices = ports.readPrices();
    if (prices === null) {
      ports.log(`[clip] batch ${this.id}: the price could not be read at member ${member.index}'s turn`);
      this.#stop("price-unavailable");
      return;
    }
    if (ports.worstOf(member, prices) > member.share) {
      this.#stop("price-changed");
      return;
    }

    // 3. The 429 pause, then the money to be alone; 4. the key; then the clip.
    this.#waitForTurn(member, () => {
      const key = ports.readKey();
      if (key !== null) {
        this.#failMember(member, key);
        return;
      }
      member.state = "running";
      member.wake = null;
      ports.note({ kind: "running", index: member.index, clipId: member.clipId });
      ports.runMember(member, prices);
    });
  }

  /** The pause after a 429, then the wait for the money to be alone, bounded. `go` runs when the member may be submitted; never when it was cancelled meanwhile. */
  #waitForTurn(member: BatchMember<P>, go: () => void): void {
    const ports = this.#ports;
    const pause = this.#notBefore - ports.clock();
    const afterPause = (): void => {
      if (member.state !== "queued" || this.#dropped) return;
      const bound = ports.clock() + ports.timings.aloneWaitMs;
      this.#waitAlone(member, bound, false, go);
    };
    if (pause > 0) {
      ports.told(member, "rate-limit");
      member.wake = ports.later(pause, afterPause);
      return;
    }
    afterPause();
  }

  #waitAlone(member: BatchMember<P>, bound: number, told: boolean, go: () => void): void {
    const ports = this.#ports;
    if (member.state !== "queued" || this.#dropped) return;
    if (ports.alone(member)) return go();
    // The bound passed: the member submits anyway, and a refusal of it is then `net-uncounted`, settled at worst (5b.1's behaviour; the owner was told in §30.3).
    if (ports.clock() >= bound) {
      ports.log(`[clip] batch ${this.id}: member ${member.index} submits though other money is still open (the wait ended)`);
      return go();
    }
    if (!told) ports.told(member, "alone");
    const wait = Math.max(1, Math.min(ports.timings.proofRetryMs, bound - ports.clock()));
    member.wake = ports.later(wait, () => this.#waitAlone(member, bound, true, go));
  }

  // ---------- what a member's end decides ----------

  /** The member's money closed: what its end means for the rest of the batch. Synchronous, so a requeue exists before the member's own `job.done` is announced. */
  closed(member: BatchMember<P>, end: MockMoneyEnd | undefined): void {
    member.state = "ended";
    // The first reserve takes the member's month hold; a member whose money closed without one (nothing ran, a cancel in preparing, a reserve the ledger refused) must not leave it behind.
    if (member.held) this.#ports.releaseHold(member);
    this.#decide(member, end);
    this.#next(member);
  }

  #decide(member: BatchMember<P>, end: MockMoneyEnd | undefined): void {
    if (end === undefined) return;
    switch (end.kind) {
      case "completed":
        if (end.aboveWorst) this.#stop("ledger-stopped");
        return;
      case "failed":
        if (end.aboveWorst) return this.#stop("ledger-stopped");
        if (end.reason === "rate-limited") return this.#rateLimited(member);
        if (UNCERTAIN_REASONS.includes(end.reason)) this.#stop("money-uncertain");
        return;
      case "late":
        return this.#stop("money-uncertain");
      case "not-reserved":
        // The ledger refused the reserve for a reason that is not the month's room (a halt, a reconcile to do, a torn line): the rest would be refused the same way.
        if (end.reason === "RECONCILE_REQUIRED" || end.reason === "HALTED") this.#stop("ledger-stopped");
        return;
      case "fault":
        // A defect inside the money machine: whether anything is open is not known, so the rest is not spent blind.
        return this.#stop("ledger-stopped");
      case "cancelled":
      case "interrupted":
        return;
    }
  }

  /**
   * A 429 at the submit: no submit for a minute, and the member goes to the tail once. (Backlog, as in the engine: a 429 on the Grok attempt behind a free Kling requeues the whole member, which starts again
   * from Kling.) B1 walks one member at a time and assumes `MAX_CLIPS_IN_FLIGHT === 1`.
   */
  #rateLimited(member: BatchMember<P>): void {
    const ports = this.#ports;
    this.#notBefore = ports.clock() + ports.timings.rateLimitPauseMs;
    if (member.retried || this.#stopped) return;
    const next = ports.requeue(member);
    this.#members.push(next);
    ports.note({ kind: "requeued", index: next.index, clipId: next.clipId });
  }

  /** Every member still queued ends cancelled for free with `detail`; nothing is requeued after it. */
  #stop(detail: ClipBatchStop): void {
    this.#stopped = true;
    let cancelled = 0;
    for (const member of this.#members) if (member.state === "queued" && this.#cancel(member, detail)) cancelled++;
    if (cancelled > 0) this.#ports.note({ kind: "stop", detail });
  }

  /** A member whose turn could not start (no usable key): its job fails, free, with the error; the batch goes on (each later member fails the same way, fast). */
  #failMember(member: BatchMember<P>, error: EngineError): void {
    if (member.state !== "queued") return;
    member.state = "ended";
    member.wake?.();
    member.wake = null;
    if (member.held) this.#ports.releaseHold(member);
    this.#ports.note({ kind: "ended", index: member.index, clipId: member.clipId, outcome: "failed" });
    this.#ports.failJob(member, error);
    this.#next(member);
  }

  /** A queued member never runs: its job ends cancelled (with why) and its month hold is released. */
  #cancel(member: BatchMember<P>, detail: ClipCancelDetail | undefined): boolean {
    if (member.state !== "queued") return false;
    member.state = "ended";
    member.wake?.();
    member.wake = null;
    if (member.held) this.#ports.releaseHold(member);
    this.#ports.note(detail === undefined ? { kind: "dropped", index: member.index, clipId: member.clipId } : { kind: "cancelled", index: member.index, clipId: member.clipId, detail });
    this.#ports.cancelJob(member, detail);
    this.#next(member);
    return true;
  }
}
