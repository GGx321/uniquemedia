import { clipWorstMicros, PROTOCOL_VERSION, type BoldClipsMode, type ClipBatchStop, type ClipCancelDetail, type ClipMotionChoice, type ClipPrices, type ClipRequest } from "../../shared/engine";
import { clipAlone } from "../../shared/engine/clipAlone";
import type { UnsequencedEvent } from "../../shared/engine/events";
import { EngineFailure } from "../engineFailure";
import type { JobRegistry } from "../jobs";
import type { Budget } from "../money/budget";
import { scopeKey } from "../money/budget";
import type { BatchChange } from "./batchSummary";
import type { ClipHolds } from "./holds";
import type { FrameFacts } from "./frameFacts";
import { clipAttemptId } from "./journal";
import type { ClipMoneyEnd } from "./job";
import type { ClipTimings } from "./timings";

// Stage 5, 5b.2, S5.WB2 (plan s5b2 §5.2.2, I5.61-I5.63): the batch «Оживить выбранные», one money unit at a time. A batch is the queue of its members and the one coroutine that walks it:
//
//   queued     every member is a job in the registry from the batch's start (memory only: no reserve, no journal line, no record), in the pick order, each holding its share of the month in the budget's
//              hold map (`tryHold`, all or nothing at create) and its cap.
//   a turn     when the member before it has CLOSED ITS MONEY (not when its file is downloaded): (1) the photo is read again; (2) the price book is read again and the member's worst case must still be within
//              its share; (3) the 429 pause and the wait for the money to be alone (`clipAlone`, bounded by `aloneWaitMs`); then 5b.1's clip job runs, verbatim, through `ports.runMember`.
//   stops      a price above the share, a price that cannot be read, a ledger that refused or halted, a member whose money is uncertain: every member still queued is cancelled for free with the matching
//              detail, its hold released and its cap cleared. Nothing queued ever holds a reserve.
//   a 429      a member refused at its submit is requeued once, at the tail, as a new job under a new clip id (the 429'd clip keeps its free `rate-limited` record), waiting for its `turn`. No member is
//              submitted for `rateLimitPauseMs` after any 429; the member whose turn falls inside the pause is the one that says it waits out the pause (`rate-limit`).
//   the end    when nothing is queued and the last member's money is closed the unit goes back (`ports.finished`). A member's download and save hold the service's work count, not the unit.
//
// The batch never claims the avatar. It never writes the ledger itself: a member's reserves are its own job's.

/** One member of a batch: a photo made into a clip, and the job that stands for it now. A member requeued after a 429 is a new object with a new job and `retried` set. */
export interface BatchMember {
  /** 1-based, the pick order; the same for the requeued member of a 429. */
  readonly index: number;
  readonly photoId: string;
  readonly motion: ClipMotionChoice;
  /** What runs: Kling, the batch's quality and length, and the fallback the photo allows. */
  readonly request: ClipRequest;
  readonly facts: FrameFacts;
  /** Its worst case under the batch's price book at create: the figure that caps it and holds the month for it. */
  readonly share: number;
  readonly jobId: string;
  readonly clipId: string;
  readonly capKey: string;
  /** The job's own cancel signal (`JobRegistry.startClip`), passed to the clip job once it runs. */
  readonly signal: AbortSignal;
  /** Fires when the member is cancelled while queued, so a wait ends at once. */
  readonly wake: AbortController;
  /** The member's `${clipId}:video#1` holds the month in the budget until the first reserve takes it. A requeued member holds nothing: its reserve checks the month itself. */
  readonly held: boolean;
  readonly retried: boolean;
  state: "queued" | "running" | "ended";
}

/** What `ports.recheck` finds of a member's photo at its turn. */
export type PhotoRecheck =
  | { kind: "ok"; bytes: Uint8Array }
  | { kind: "gone" }
  | { kind: "unreadable" }
  /** The library the batch was made in is no longer the open one (a lost volume): no photo of it can be read, so the batch stops instead of calling each member's photo deleted. */
  | { kind: "library-lost" };

/** What the service hands the batch to start a member's clip job. */
export interface MemberRun {
  readonly member: BatchMember;
  readonly bytes: Uint8Array;
  /** The price book read at this turn: the member's for all its reserves (I5.46). */
  readonly prices: ClipPrices;
  /** The OpenRouter key as it is at this turn (a rejected or changed key reaches the later members). */
  readonly key: string;
  /** Called exactly once when the member's money closed (or at once when it never ran), with how the money state machine ended. */
  readonly onMoneyClosed: (end?: ClipMoneyEnd) => void;
}

/** What the batch needs of the engine and of the clip service. */
export interface BatchPorts {
  readonly clock: () => number;
  /** The usable key now; throws (AUTH_INVALID) when there is none or OpenRouter rejected it. */
  readonly readKey: () => string;
  readonly newId: () => string;
  readonly timings: ClipTimings;
  readonly jobs: JobRegistry;
  readonly emit: (event: UnsequencedEvent) => void;
  readonly emitMoney: () => void;
  readonly setCap: (key: string, micros: number) => void;
  readonly clearCap: (key: string) => void;
  readonly log: (line: string) => void;
  readonly budget: Pick<Budget, "ledger" | "releaseHold" | "status">;
  readonly holds: Pick<ClipHolds, "entries" | "isCompleted">;
  readonly mode: "auto" | "offer";
  readonly boldClips: BoldClipsMode;
  /** The engine is stopping: every wait ends and the queue is dropped. */
  readonly stop: AbortSignal;
  /** The price book now (a free GET when the cache is older than 10 min); rejects with PRICE_UNAVAILABLE when it cannot be read. */
  readonly readPrices: () => Promise<ClipPrices>;
  readonly recheck: (member: BatchMember) => Promise<PhotoRecheck>;
  readonly runMember: (run: MemberRun) => void;
  /** The batch is over: the unit and its paid count go back. Called once. */
  readonly finished: () => void;
  /** `setTimeout` that ends early on `signal`; a test seam. */
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** 5b.2 (S5.WB2c): a transition of the batch, for its summary (`batchSummary.ts`). Synchronous: the summary is written in the background, in the order told. */
  readonly note: (change: BatchChange) => void;
}

export interface BatchInit {
  readonly id: string;
  readonly avatarId: string;
  readonly members: readonly BatchMember[];
}

/** A member whose money ended in one of these has an open reserve nobody can price until the reconcile: the queue is not spent blind (L5). */
const UNCERTAIN_REASONS: readonly string[] = ["submit-uncertain", "late", "lost"];

/** A signal that fires when either does. */
function eitherSignal(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const fire = (): void => controller.abort();
  if (a.aborted || b.aborted) fire();
  else {
    a.addEventListener("abort", fire, { once: true });
    b.addEventListener("abort", fire, { once: true });
  }
  return controller.signal;
}

export class ClipBatch {
  readonly id: string;
  readonly avatarId: string;
  readonly #ports: BatchPorts;
  /** In queue order: the members as picked, then the requeued tail. */
  readonly #members: BatchMember[];
  readonly #size: number;
  /** A stop was ordered: nothing is requeued and nothing new runs. */
  #stopped = false;
  /** Epoch ms: no member is submitted before it (the pause after a 429). */
  #notBefore = 0;
  #finished = false;

  constructor(ports: BatchPorts, init: BatchInit) {
    this.#ports = ports;
    this.id = init.id;
    this.avatarId = init.avatarId;
    this.#members = [...init.members];
    this.#size = init.members.length;
  }

  /** Walks the queue in the background. Never rejects. */
  start(): void {
    void this.#loop();
  }

  /** True once the batch's last member has closed its money (or the queue was dropped). */
  get over(): boolean {
    return this.#finished;
  }

  /** Whether this job id is a member of the batch that is still queued. */
  isQueued(jobId: string): boolean {
    return this.#members.some((member) => member.jobId === jobId && member.state === "queued");
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
    if (cancelled > 0) this.#note({ kind: "stop", detail: "cancelled" });
    return cancelled;
  }

  async #loop(): Promise<void> {
    try {
      for (;;) {
        if (this.#ports.stop.aborted) break;
        const member = this.#members.find((candidate) => candidate.state === "queued");
        if (member === undefined) break;
        await this.#turn(member);
      }
    } catch (error) {
      // A defect: the rest is not spent blind. Whatever is queued goes free, and the unit goes back below.
      this.#ports.log(`[clip] batch ${this.id}: the scheduler failed (${error instanceof Error ? error.name : typeof error}); the queued members were cancelled`);
    } finally {
      // A quit, a stop or a defect: whatever is still queued is dropped for free (no reserve, no journal line, no record: nothing to recover).
      this.#stopped = true;
      for (const member of this.#members) if (member.state === "queued") this.#cancel(member, undefined);
      this.#finished = true;
      this.#note({ kind: "over", at: new Date(this.#ports.clock()).toISOString() });
      this.#ports.finished();
    }
  }

  // ---------- one turn ----------

  async #turn(member: BatchMember): Promise<void> {
    const ports = this.#ports;

    // 1. The photo, read again: it may have been deleted or damaged since the sheet.
    const photo = await ports.recheck(member);
    if (member.state !== "queued") return;
    if (photo.kind === "library-lost") {
      // WB2d (L7): the whole library is gone, not this photo: every member still queued ends `cancelled`, free (the closest existing word; the contract has none for a lost library).
      ports.log(`[clip] batch ${this.id}: the library is no longer the open one at member ${member.index}'s turn; the queue was cancelled`);
      this.#stop("cancelled");
      return;
    }
    if (photo.kind !== "ok") {
      this.#cancel(member, photo.kind === "gone" ? "photo-gone" : "photo-unreadable");
      return;
    }

    // 2. The price, read again (a free GET when the cache is older than 10 min): the member's worst case must still be within its share.
    let prices: ClipPrices;
    try {
      prices = await ports.readPrices();
    } catch (error) {
      if (member.state !== "queued") return;
      ports.log(`[clip] batch ${this.id}: the price could not be read at member ${member.index}'s turn (${error instanceof Error ? error.name : typeof error})`);
      this.#stop("price-unavailable");
      return;
    }
    if (member.state !== "queued") return;
    const worst = clipWorstMicros({
      model: "kling",
      quality: member.request.quality,
      seconds: member.request.seconds,
      mode: ports.mode,
      fallback: member.request.fallback,
      bold: member.facts.bold,
      boldClips: ports.boldClips,
      prices,
    });
    if (worst > member.share) {
      this.#stop("price-changed");
      return;
    }

    // 3. The 429 pause, then the money to be alone.
    if (!(await this.#waitForTurn(member))) return;
    // The key as it is now: after a rejected key the later members fail fast and free, without a POST.
    let key: string;
    try {
      key = ports.readKey();
    } catch (error) {
      this.#failMember(member, error);
      return;
    }
    // A cancel may have landed since the last check (the wait returned in a later microtask): a cancelled member never runs.
    if (member.state !== "queued") return;

    // 4. 5b.1's clip job, verbatim. The next turn starts when this member's money closes.
    member.state = "running";
    this.#note({ kind: "running", index: member.index, clipId: member.clipId });
    await new Promise<void>((resolve) => {
      ports.runMember({
        member,
        bytes: photo.bytes,
        prices,
        key,
        onMoneyClosed: (end) => {
          try {
            this.#closed(member, end);
          } finally {
            resolve();
          }
        },
      });
    });
  }

  /** The pause after a 429, then the wait for the money to be alone, bounded. False when the member was cancelled or the engine is stopping. */
  async #waitForTurn(member: BatchMember): Promise<boolean> {
    const ports = this.#ports;
    const wake = eitherSignal(member.wake.signal, ports.stop);
    const pause = this.#notBefore - ports.clock();
    if (pause > 0) {
      this.#told(member, "rate-limit");
      await ports.sleep(pause, wake);
    }
    const bound = ports.clock() + ports.timings.aloneWaitMs;
    let told = false;
    for (;;) {
      if (member.state !== "queued" || ports.stop.aborted) return false;
      if (this.#alone(member)) return true;
      // The bound passed: the member submits anyway, and a refusal of it is then `net-uncounted`, settled at worst (5b.1's behaviour; the owner was told in §30.3).
      if (ports.clock() >= bound) {
        ports.log(`[clip] batch ${this.id}: member ${member.index} submits though other money is still open (the wait ended)`);
        return true;
      }
      if (!told) {
        told = true;
        this.#told(member, "alone");
      }
      await ports.sleep(Math.max(1, Math.min(ports.timings.proofRetryMs, bound - ports.clock())), wake);
    }
  }

  /** The member's money, as 5b.1's net-usage proof asks about it before the baseline read (I5.47), for the id its first attempt will have. */
  #alone(member: BatchMember): boolean {
    const ports = this.#ports;
    return clipAlone({ ledger: ports.budget.ledger, holds: ports.holds, attemptId: clipAttemptId(member.clipId, 1), nowMs: ports.clock() });
  }

  /** A transition, told to the batch's summary. Never throws (round 2): a summary that cannot be told is logged, and never leaves a member's job, a hold or the money unit behind. */
  #note(change: BatchChange): void {
    try {
      this.#ports.note(change);
    } catch (error) {
      this.#ports.log(`[clip] batch ${this.id}: its summary could not be told a change (${error instanceof Error ? error.name : typeof error})`);
    }
  }

  /** The member's wait is told to the window (`queued` with the reason). */
  #told(member: BatchMember, reason: "turn" | "alone" | "rate-limit"): void {
    const progress = this.#ports.jobs.clipPhase(member.jobId, { phase: "queued", waitReason: reason });
    if (progress !== null) this.#ports.emit({ v: PROTOCOL_VERSION, id: this.#ports.newId(), kind: "event", type: "job.progress", payload: progress });
  }

  // ---------- what a member's end decides ----------

  /** The member's money closed: what its end means for the rest of the batch. Synchronous, so a requeue exists before the member's own `job.done` is announced. */
  #closed(member: BatchMember, end: ClipMoneyEnd | undefined): void {
    member.state = "ended";
    // The first reserve takes the member's month hold; a member whose money closed without one (nothing ran, a cancel in preparing, a reserve the ledger refused) must not leave it behind.
    if (member.held) this.#ports.budget.releaseHold(clipAttemptId(member.clipId, 1));
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
        if (end.refusal.reason === "RECONCILE_REQUIRED" || end.refusal.reason === "HALTED") this.#stop("ledger-stopped");
        return;
      case "fault":
        // A defect inside the money machine. «Needs a reconcile» is told only when it is true: the member has a reserve in the ledger, or the ledger is halted or could not write. A fault before the reserve
        // (the journal's first line, a prompt that did not build) leaves nothing open: the rest still does not run, and the stop is the plain `cancelled`.
        return this.#stop(this.#moneyMayBeOpen(member) ? "ledger-stopped" : "cancelled");
      case "cancelled":
      case "interrupted":
        return;
    }
  }

  /** Whether a faulted member can have left money open: a reserve of either of its attempts is in the ledger, or the ledger is halted or its write failed. */
  #moneyMayBeOpen(member: BatchMember): boolean {
    const { ledger, status } = this.#ports.budget;
    if (ledger.failed || status().state === "halted") return true;
    return ledger.reserveOf(clipAttemptId(member.clipId, 1)) !== undefined || ledger.reserveOf(clipAttemptId(member.clipId, 2)) !== undefined;
  }

  /**
   * A 429 at the submit: no submit for a minute, and the member goes to the tail once. (Backlog: a 429 on the Grok attempt behind a free Kling requeues the whole member, which starts again from Kling.)
   * B1 walks one member at a time and assumes `MAX_CLIPS_IN_FLIGHT === 1` (pinned in batch.test.ts); B2's window comes before that constant moves.
   */
  #rateLimited(member: BatchMember): void {
    const ports = this.#ports;
    this.#notBefore = ports.clock() + ports.timings.rateLimitPauseMs;
    if (member.retried || this.#stopped) return;
    const jobId = ports.newId();
    const clipId = jobId;
    const capKey = scopeKey({ avatarJobId: clipId });
    ports.setCap(capKey, member.share);
    const signal = ports.jobs.startClip(
      jobId,
      {
        avatarId: this.avatarId,
        clipId,
        facts: { photoId: member.photoId, request: member.request, motion: { source: member.motion.source, label: member.motion.label }, acceptedWorstMicros: member.share },
        // It waits for its turn at the tail (S5.WB2c): the pause after the 429 is told only if its own turn comes inside it (`#waitForTurn`), by then usually long over.
        batch: { batchId: this.id, batchIndex: member.index, batchSize: this.#size, waitReason: "turn" },
      },
      "queued",
    );
    this.#members.push({ ...member, jobId, clipId, capKey, signal, wake: new AbortController(), held: false, retried: true, state: "queued" });
    this.#note({ kind: "requeued", index: member.index, clipId });
    const progress = ports.jobs.progress(jobId, 0);
    if (progress !== null) ports.emit({ v: PROTOCOL_VERSION, id: ports.newId(), kind: "event", type: "job.progress", payload: progress });
  }

  /** Every member still queued ends cancelled for free with `detail`; nothing is requeued after it. */
  #stop(detail: ClipBatchStop): void {
    this.#stopped = true;
    let cancelled = 0;
    for (const member of this.#members) if (member.state === "queued" && this.#cancel(member, detail)) cancelled++;
    if (cancelled > 0) this.#note({ kind: "stop", detail });
  }

  /** A member whose turn could not start (no usable key): its job fails, free, with the error; the batch goes on (each later member fails the same way, fast). */
  #failMember(member: BatchMember, error: unknown): void {
    if (member.state !== "queued") return;
    const ports = this.#ports;
    member.state = "ended";
    member.wake.abort();
    if (member.held) ports.budget.releaseHold(clipAttemptId(member.clipId, 1));
    ports.clearCap(member.capKey);
    const failure = error instanceof EngineFailure ? error.error : { code: "AUTH_INVALID" as const, detail: "no usable OpenRouter key" };
    this.#note({ kind: "ended", index: member.index, clipId: member.clipId, outcome: "failed" });
    const state = ports.jobs.finishClip(member.jobId, { status: "failed", error: failure });
    if (state !== null) ports.emit({ v: PROTOCOL_VERSION, id: ports.newId(), kind: "event", type: "job.failed", payload: { kind: "clip", jobId: member.jobId, avatarId: this.avatarId, clipId: member.clipId, error: failure } });
    ports.emitMoney();
  }

  /** A queued member never runs: its job ends cancelled (with why), its month hold is released and its cap cleared. */
  #cancel(member: BatchMember, detail: ClipCancelDetail | undefined): boolean {
    if (member.state !== "queued") return false;
    const ports = this.#ports;
    member.state = "ended";
    member.wake.abort();
    if (member.held) ports.budget.releaseHold(clipAttemptId(member.clipId, 1));
    ports.clearCap(member.capKey);
    this.#note(detail === undefined ? { kind: "dropped", index: member.index, clipId: member.clipId } : { kind: "cancelled", index: member.index, clipId: member.clipId, detail });
    const state = ports.jobs.finishClip(member.jobId, detail === undefined ? { status: "cancelled" } : { status: "cancelled", detail });
    if (state !== null) {
      ports.emit({
        v: PROTOCOL_VERSION,
        id: ports.newId(),
        kind: "event",
        type: "job.cancelled",
        payload: { kind: "clip", jobId: member.jobId, avatarId: this.avatarId, clipId: member.clipId, ...(detail === undefined ? {} : { detail }) },
      });
    }
    ports.emitMoney();
    return true;
  }
}
