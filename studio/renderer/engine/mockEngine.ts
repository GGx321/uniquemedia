import {
  type ApiKeyStatus,
  type AvatarSummary,
  type AvatarTraits,
  type Candidate,
  type CommandMessage,
  type CommandType,
  type Draft,
  type EngineError,
  type Estimate,
  EventLog,
  type EventMessage,
  type FailedCandidateSlot,
  type JobState,
  type LedgerUnavailable,
  type MoneyHalt,
  type MoneyStatus,
  OkResponse,
  PROTOCOL_VERSION,
  type ReconcileReason,
  type ReconcileResult,
  type ResponseMessage,
  type Settings,
  type Snapshot,
  type UnsequencedEvent,
} from "../../shared/engine";
import { createEngineClient, type EngineBridge, type EngineClient } from "./client";
import { realScheduler, type Scheduler } from "./scheduler";

// An in-memory engine that speaks the T0 wire protocol. It exists so the
// renderer can be built, tested and demoed before the real engine (T1) and
// its money path land. Every response it produces is parsed with the contract
// schema, and every event goes through the contract's EventLog, so a mock that
// drifts from the contract fails loudly in tests. It never makes images: the
// UI shows neutral placeholders for its photo ids.

const CANDIDATES_PER_JOB = 4;

/** The mock price list, in micro-dollars: descriptor + 4 portraits + 4 age checks. */
const DESCRIPTOR = { expected: 2_000, worst: 3_000 };
/** The attempt a mock settle-above-worst halt names. */
const MOCK_ABOVE_WORST_ATTEMPT = "mock-attempt#1";
export const MOCK_ESTIMATE: Readonly<Estimate> = {
  expectedMicros: 207_600, // 2_000 + 4 × 50_000 + 4 × 1_400 → "$0.21"
  worstMicros: 223_000, // 3_000 + 4 × 53_000 + 4 × 2_000 → "$0.23"
  prices: "live",
  pricesAsOf: "2026-09-24",
};

const START_OF_TIME = Date.UTC(2026, 8, 24, 10, 0, 0);

/** The contract's per-slot account of a mock batch: its last `rejected` slots were rejected by the age check. */
function ageRejectedSlots(total: number, rejected: number): FailedCandidateSlot[] {
  return Array.from({ length: rejected }, (_, i) => ({ slot: total - rejected + 1 + i, reason: "age-rejected" }));
}

export interface MockEngineOptions {
  /** `demo` seeds a small library for the dev build; `empty` is a fresh install. */
  preset?: "empty" | "demo";
  scheduler?: Scheduler;
  /** Delay before each response; 0 answers on the next microtask. */
  latencyMs?: number;
  /** Time between a candidate job's progress steps. */
  stepMs?: number;
  apiKey?: ApiKeyStatus;
  eventCapacity?: number;
  avatars?: AvatarSummary[];
  drafts?: Draft[];
  /**
   * `halt`: paid calls halted as the engine reports it (e.g. a failed ledger
   * write, or a settle above worst known after a restart); `unavailable`: the
   * ledger could not be read, so there are no amounts at all.
   */
  money?: { spentMicros?: number; monthlyBudgetMicros?: number; halt?: MoneyHalt; unavailable?: LedgerUnavailable };
  /** Stored network concurrency (the contract allows 1–16). */
  concurrency?: number;
}

interface MockJob {
  jobId: string;
  avatarId: string;
  status: JobState["status"];
  done: number;
  total: number;
  candidates: Candidate[];
  rejectedByAgeCheck: number;
  error: EngineError | null;
  cancelTimers: (() => void)[];
}

const SKIN: Record<AvatarTraits["skinTone"], string> = {
  "very-light": "very fair",
  light: "fair",
  "light-olive": "light olive",
  tan: "tan",
  dark: "deep brown",
  "very-dark": "very dark",
};
const HAIR: Record<AvatarTraits["hairColor"], string> = {
  black: "black",
  "dark-brown": "dark brown",
  chestnut: "chestnut",
  "light-brown": "light brown",
  blonde: "blonde",
  red: "red",
};
const LENGTH: Record<AvatarTraits["hairLength"], string> = { bob: "bob-length", shoulder: "shoulder-length", long: "long" };
const ETHNICITY: Record<AvatarTraits["ethnicity"], string> = {
  european: "European",
  latina: "Latina",
  asian: "Asian",
  african: "African",
  mixed: "mixed-heritage",
};
const MARKS: Record<AvatarTraits["marks"][number], string> = {
  freckles: "light freckles across the nose",
  mole: "a small mole on the cheek",
  dimples: "dimples",
  "nose-piercing": "a small nose piercing",
  "wrist-tattoo": "a small wrist tattoo",
};

/** What the descriptor LLM would write; built only from fixed English words, so it always passes the contract. */
export function mockDescriptor(t: AvatarTraits): { age: number; text: string } {
  const marks = t.marks.map((m) => MARKS[m]);
  const text =
    `${t.age}-year-old ${ETHNICITY[t.ethnicity]} woman, ${SKIN[t.skinTone]} skin, ${t.eyeColor} eyes, ` +
    `${LENGTH[t.hairLength]} ${t.hairTexture} ${HAIR[t.hairColor]} hair, ${t.build} build` +
    (marks.length > 0 ? `, ${marks.join(", ")}.` : ".");
  return { age: t.age, text };
}

const DEMO_TRAITS: AvatarTraits = {
  age: 25,
  ethnicity: "european",
  skinTone: "light-olive",
  hairColor: "chestnut",
  hairLength: "shoulder",
  hairTexture: "wavy",
  eyeColor: "hazel",
  build: "athletic",
  marks: ["freckles"],
  vibe: "girl next door, coffee, travel, books",
};

function demoAvatars(): AvatarSummary[] {
  const rows: [string, number, Partial<AvatarTraits>, AvatarSummary["status"]][] = [
    ["Mia", 124, {}, "active"],
    ["Sofia", 86, { age: 27, hairColor: "black", hairLength: "long", hairTexture: "straight", eyeColor: "brown" }, "active"],
    ["Elena", 140, { age: 29, skinTone: "light", hairColor: "blonde", eyeColor: "blue", marks: [] }, "active"],
    ["Ava", 64, { age: 23, ethnicity: "latina", skinTone: "tan", hairTexture: "curly", marks: ["dimples"] }, "active"],
    ["Kira", 52, { age: 31, hairColor: "red", hairLength: "bob", eyeColor: "green", build: "slim" }, "active"],
    ["Nora", 118, { age: 26, ethnicity: "mixed", skinTone: "dark", hairColor: "dark-brown", marks: ["mole"] }, "archived"],
  ];
  return rows.map(([name, photoCount, patch, status], i) => {
    const traits = { ...DEMO_TRAITS, ...patch };
    const n = String(i + 1).padStart(4, "0");
    return {
      avatarId: `avatar-demo-${n}`,
      name,
      descriptor: mockDescriptor(traits),
      masterPhotoId: `photo-demo-${n}`,
      createdAt: new Date(START_OF_TIME - (i + 1) * 86_400_000 * 3).toISOString(),
      status,
      photoCount,
    };
  });
}

export class MockEngine implements EngineBridge {
  /** Every command received, in order: tests assert on what the UI sent. */
  readonly calls: CommandMessage[] = [];

  private readonly scheduler: Scheduler;
  private readonly latencyMs: number;
  private readonly stepMs: number;
  private readonly capacity: number;
  private readonly listeners = new Set<(event: unknown) => void>();
  private log: EventLog;
  private boot = 1;
  private idCounter = 0;
  private clock = START_OF_TIME;
  private delivering = true;

  private settings: Settings;
  private avatars: AvatarSummary[];
  private drafts: Draft[];
  private jobs: MockJob[] = [];
  private spentMicros: number;
  private spentSinceReconcile = 0;
  private readonly reserves = new Map<string, number>();
  private reconcileReasons: ReconcileReason[] = [];
  private halt: MoneyHalt | null;
  private readonly unavailable: LedgerUnavailable | null;
  private price: Estimate = { ...MOCK_ESTIMATE };
  private encryptionAvailable: boolean;
  private readonly forced = new Map<CommandType, EngineError[]>();
  private readonly reconcileQueue: ReconcileResult[] = [];
  private ageRejectionsNextJob = 0;

  constructor(options: MockEngineOptions = {}) {
    this.scheduler = options.scheduler ?? realScheduler;
    this.latencyMs = options.latencyMs ?? 0;
    this.stepMs = options.stepMs ?? 700;
    this.capacity = options.eventCapacity ?? 256;
    this.log = new EventLog(this.capacity, this.bootId());
    const apiKey = options.apiKey ?? { stored: true, last4: "3f2a", encryptionAvailable: true, rejected: false };
    this.encryptionAvailable = apiKey.encryptionAvailable;
    this.settings = {
      apiKey,
      monthlyBudgetMicros: options.money?.monthlyBudgetMicros ?? 10_000_000,
      libraryPath: "/Users/studio/Studio/library",
      imageModel: "x-ai/grok-imagine-image-2.0",
      textModel: "x-ai/grok-4.3",
      concurrency: { network: options.concurrency ?? 6 },
    };
    this.avatars = options.avatars ?? (options.preset === "demo" ? demoAvatars() : []);
    this.drafts = options.drafts ?? [];
    this.spentMicros = options.money?.spentMicros ?? (options.preset === "demo" ? 1_420_000 : 0);
    this.halt = options.money?.halt ?? null;
    this.unavailable = options.money?.unavailable ?? null;
  }

  // ---------- EngineBridge ----------

  async request(command: CommandMessage): Promise<ResponseMessage> {
    this.calls.push(command);
    if (this.latencyMs > 0) await new Promise<void>((resolve) => this.scheduler.schedule(this.latencyMs, resolve));
    else await Promise.resolve();
    return this.handle(command);
  }

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---------- test and demo controls ----------

  /** The next `type` command fails with `error` before anything else is checked. */
  failNext(type: CommandType, error: EngineError): void {
    this.forced.set(type, [...(this.forced.get(type) ?? []), error]);
  }

  /** Changes the current price; a paid command accepted at a lower worst case gets PRICE_CHANGED. */
  setPrice(price: Pick<Estimate, "expectedMicros" | "worstMicros">): void {
    this.price = { ...this.price, ...price };
  }

  /** OpenRouter answered 401: the key is marked rejected and running jobs fail with AUTH_INVALID. */
  rejectKey(): void {
    if (!this.settings.apiKey.stored) return;
    this.settings = { ...this.settings, apiKey: { ...this.settings.apiKey, rejected: true } };
    for (const job of this.jobs.filter((j) => j.status === "queued" || j.status === "running")) {
      this.failJob(job, { code: "AUTH_INVALID" });
    }
  }

  setEncryptionAvailable(available: boolean): void {
    this.encryptionAvailable = available;
    this.settings = { ...this.settings, apiKey: { ...this.settings.apiKey, encryptionAvailable: available } };
  }

  /** Paid calls stop until a reconcile; announced with `money.reconcileNeeded`. */
  requireReconcile(reasons: ReconcileReason[]): void {
    this.reconcileReasons = [...new Set([...this.reconcileReasons, ...reasons])];
    this.emitReconcileNeeded();
  }

  /** A settle came in above its reserve: paid calls halt until a reconcile. */
  haltAboveWorst(): void {
    this.halt = { cause: "SETTLE_ABOVE_WORST", detail: "a mock settle above its worst case", attemptIds: [MOCK_ABOVE_WORST_ATTEMPT] };
    this.emit({ v: PROTOCOL_VERSION, id: this.nextId("evt"), kind: "event", type: "engine.error", payload: { error: { code: "SETTLE_ABOVE_WORST" } } });
    this.emitMoney();
  }

  /** The next `money.reconcile` answers with `result` (a queue; the default is a matching `done`). */
  queueReconcile(result: ReconcileResult): void {
    this.reconcileQueue.push(result);
  }

  /** The next candidate job loses `count` portraits to the age check. */
  rejectNextByAgeCheck(count: number): void {
    this.ageRejectionsNextJob = Math.max(0, Math.min(CANDIDATES_PER_JOB, count));
  }

  /** While off, events go into the log but are not delivered: the window misses them. */
  setDelivery(on: boolean): void {
    this.delivering = on;
  }

  /** Adds an avatar without any event, as if another window had saved it. */
  addAvatarSilently(avatar: AvatarSummary): void {
    this.avatars = [...this.avatars, avatar];
  }

  /** The engine process restarts: a new bootId, seq from 1, running jobs are gone, open reserves need a reconcile. */
  restart(): void {
    for (const job of this.jobs) {
      for (const cancel of job.cancelTimers) cancel();
      if (job.status === "queued" || job.status === "running") job.status = "cancelled";
    }
    this.boot += 1;
    this.log = new EventLog(this.capacity, this.bootId());
    if (this.reserves.size > 0 && !this.reconcileReasons.includes("open-reserves")) {
      this.reconcileReasons = [...this.reconcileReasons, "open-reserves"];
    }
    this.emitMoney();
  }

  /** Emits a `money.changed` with the current status (used to create seq traffic in tests). */
  touchMoney(): void {
    this.emitMoney();
  }

  get currentBootId(): string {
    return this.log.bootId;
  }

  // ---------- command handling ----------

  private handle(c: CommandMessage): ResponseMessage {
    const forced = this.forced.get(c.type)?.shift();
    if (forced) return this.fail(c, forced);

    switch (c.type) {
      case "settings.get":
        return this.ok(c, this.settings);
      case "settings.setApiKey": {
        if (!this.encryptionAvailable) return this.fail(c, { code: "ENCRYPTION_UNAVAILABLE" });
        const apiKey: ApiKeyStatus = { stored: true, last4: c.payload.key.slice(-4), encryptionAvailable: true, rejected: false };
        this.settings = { ...this.settings, apiKey };
        return this.ok(c, apiKey);
      }
      case "settings.clearApiKey": {
        const apiKey: ApiKeyStatus = { stored: false, last4: null, encryptionAvailable: this.encryptionAvailable, rejected: false };
        this.settings = { ...this.settings, apiKey };
        return this.ok(c, apiKey);
      }
      case "settings.setBudget":
        this.settings = { ...this.settings, monthlyBudgetMicros: c.payload.monthlyBudgetMicros };
        this.emitMoney();
        return this.ok(c, this.settings);
      case "settings.setLibraryPath":
        if (this.running().length > 0) return this.fail(c, { code: "IN_FLIGHT" });
        this.settings = { ...this.settings, libraryPath: c.payload.path };
        return this.ok(c, this.settings);
      case "settings.setModels":
        this.settings = { ...this.settings, imageModel: c.payload.imageModel, textModel: c.payload.textModel };
        return this.ok(c, this.settings);
      case "settings.setConcurrency":
        this.settings = { ...this.settings, concurrency: { network: c.payload.network } };
        return this.ok(c, this.settings);
      case "money.status":
        return this.ok(c, this.moneyStatus());
      case "money.reconcile":
        return this.reconcile(c);
      case "avatars.list":
        return this.ok(c, { avatars: this.avatars, unreadableAvatars: 0 });
      case "avatars.estimate":
        return this.ok(c, this.price);
      case "avatars.estimateCandidates":
        if (!this.drafts.some((d) => d.avatarId === c.payload.avatarId)) return this.fail(c, { code: "NOT_FOUND" });
        return this.ok(c, this.candidatesPrice());
      case "avatars.createDraft": {
        const refusal = this.paidGate(c.payload.acceptedWorstMicros, this.price.worstMicros);
        if (refusal) return this.fail(c, refusal);
        const draft: Draft = {
          avatarId: this.nextId("avatar"),
          traits: c.payload.traits,
          descriptor: mockDescriptor(c.payload.traits),
          candidates: [],
          // A draft's estimate is its next batch: the descriptor is already paid for.
          estimate: this.candidatesPrice(),
        };
        this.drafts = [...this.drafts, draft];
        this.spend(DESCRIPTOR.expected);
        return this.ok(c, { draft });
      }
      case "avatars.generateCandidates": {
        const draft = this.drafts.find((d) => d.avatarId === c.payload.avatarId);
        if (!draft) return this.fail(c, { code: "NOT_FOUND" });
        // Another batch is priced without the descriptor, like avatars.estimateCandidates.
        const refusal = this.paidGate(c.payload.acceptedWorstMicros, this.candidatesPrice().worstMicros);
        if (refusal) return this.fail(c, refusal);
        return this.ok(c, { jobId: this.startJob(draft.avatarId) });
      }
      case "avatars.cancel": {
        const job = this.jobs.find((j) => j.jobId === c.payload.jobId);
        if (!job) return this.fail(c, { code: "NOT_FOUND" });
        if (job.status === "queued" || job.status === "running") {
          for (const cancel of job.cancelTimers) cancel();
          // An aborted attempt counts at its worst case until reconciled: the reserve stays open.
          job.status = "cancelled";
        }
        return this.ok(c, { jobId: job.jobId });
      }
      case "avatars.pick": {
        const draft = this.drafts.find((d) => d.avatarId === c.payload.avatarId);
        if (!draft || !draft.candidates.some((cand) => cand.photoId === c.payload.photoId)) {
          return this.fail(c, { code: "NOT_FOUND" });
        }
        const avatar: AvatarSummary = {
          avatarId: draft.avatarId,
          name: c.payload.name.trim(),
          descriptor: draft.descriptor,
          masterPhotoId: c.payload.photoId,
          createdAt: this.nowIso(),
          status: "active",
          photoCount: 1,
        };
        this.drafts = this.drafts.filter((d) => d !== draft);
        this.avatars = [...this.avatars, avatar];
        return this.ok(c, { avatar });
      }
      case "avatars.archive": {
        const avatar = this.avatars.find((a) => a.avatarId === c.payload.avatarId);
        if (!avatar) return this.fail(c, { code: "NOT_FOUND" });
        const archived: AvatarSummary = { ...avatar, status: "archived" };
        this.avatars = this.avatars.map((a) => (a === avatar ? archived : a));
        return this.ok(c, { avatar: archived });
      }
      case "photos.list":
        return this.ok(c, { photos: [] });
      case "runs.estimate":
      case "runs.start":
      case "runs.cancel":
      case "runs.resume":
        return this.fail(c, { code: "INTERNAL", detail: "photo runs are not simulated by the mock engine" });
      case "engine.snapshot":
        return this.ok(c, this.snapshot());
      case "engine.events":
        return this.ok(c, this.log.since(c.payload.afterSeq, c.payload.bootId));
    }
  }

  private ok(c: CommandMessage, result: unknown): ResponseMessage {
    // Parsed, not cast: a mock result that breaks the contract throws here.
    return OkResponse.parse({ v: PROTOCOL_VERSION, id: c.id, kind: "response", type: c.type, ok: true, result });
  }

  private fail(c: CommandMessage, error: EngineError): ResponseMessage {
    return { v: PROTOCOL_VERSION, id: c.id, kind: "response", type: c.type, ok: false, error };
  }

  /** A stop no reconcile lifts: the ledger could not be read, or a write failed. */
  private ledgerStop(): EngineError | null {
    if (this.unavailable !== null) return { code: this.unavailable.cause, detail: this.unavailable.detail };
    if (this.halt?.cause === "LEDGER_WRITE_FAILED") return { code: "LEDGER_WRITE_FAILED", detail: this.halt.detail };
    return null;
  }

  /** The engine's checks before any paid call, in the order it runs them; `worstMicros` is this command's own worst case. */
  private paidGate(acceptedWorstMicros: number, worstMicros: number): EngineError | null {
    const key = this.settings.apiKey;
    if (!key.stored) return { code: "AUTH_INVALID", detail: "no API key is stored" };
    if (key.rejected) return { code: "AUTH_INVALID" };
    const stopped = this.ledgerStop();
    if (stopped) return stopped;
    if (this.reconcileReasons.length > 0 || this.halt !== null) return { code: "RECONCILE_REQUIRED" };
    if (acceptedWorstMicros < worstMicros) return { code: "PRICE_CHANGED" };
    const committed = this.spentMicros + this.unsettledMicros() + worstMicros;
    if (committed > this.settings.monthlyBudgetMicros) return { code: "BUDGET_EXCEEDED" };
    return null;
  }

  private reconcile(c: CommandMessage): ResponseMessage {
    const stopped = this.ledgerStop();
    if (stopped) return this.fail(c, stopped);
    if (this.running().length > 0) return this.fail(c, { code: "IN_FLIGHT" });
    const ledgerDelta = this.spentSinceReconcile + this.unsettledMicros();
    const result: ReconcileResult = this.reconcileQueue.shift() ?? {
      status: "done",
      creditsDeltaMicros: ledgerDelta,
      deltaUnavailable: null,
      ledgerDeltaMicros: ledgerDelta,
      mismatch: false,
      closedReserves: this.reserves.size,
      aboveWorstAttempts: this.halt?.cause === "SETTLE_ABOVE_WORST" ? this.halt.attemptIds : [],
      tornLineMoved: this.reconcileReasons.includes("torn-ledger-line"),
      warnings: [],
    };
    if (result.status === "done") {
      // Open reserves close at their worst case.
      this.spentMicros += this.unsettledMicros();
      this.reserves.clear();
      this.spentSinceReconcile = 0;
      this.reconcileReasons = [];
      this.halt = null;
      this.emitMoney();
    }
    return this.ok(c, result);
  }

  private startJob(avatarId: string): string {
    const job: MockJob = {
      jobId: this.nextId("job"),
      avatarId,
      status: "queued",
      done: 0,
      total: CANDIDATES_PER_JOB,
      candidates: [],
      rejectedByAgeCheck: 0,
      error: null,
      cancelTimers: [],
    };
    this.jobs = [...this.jobs, job];
    this.reserves.set(job.jobId, this.price.worstMicros - DESCRIPTOR.worst);
    this.emitMoney();

    for (let step = 1; step <= job.total; step++) {
      job.cancelTimers.push(
        this.scheduler.schedule(this.stepMs * step, () => {
          job.status = "running";
          job.done = step;
          this.emit({
            v: PROTOCOL_VERSION,
            id: this.nextId("evt"),
            kind: "event",
            type: "job.progress",
            payload: { jobId: job.jobId, done: job.done, total: job.total },
          });
        }),
      );
    }
    job.cancelTimers.push(this.scheduler.schedule(this.stepMs * (job.total + 1), () => this.finishJob(job)));
    return job.jobId;
  }

  private finishJob(job: MockJob): void {
    const rejected = this.ageRejectionsNextJob;
    this.ageRejectionsNextJob = 0;
    job.candidates = Array.from({ length: job.total - rejected }, () => ({ avatarId: job.avatarId, photoId: this.nextId("photo") }));
    job.rejectedByAgeCheck = rejected;
    job.status = "done";
    job.done = job.total;
    this.drafts = this.drafts.map((d) =>
      d.avatarId === job.avatarId ? { ...d, candidates: [...d.candidates, ...job.candidates] } : d,
    );
    this.reserves.delete(job.jobId);
    this.spend(this.price.expectedMicros - DESCRIPTOR.expected);
    this.emit({
      v: PROTOCOL_VERSION,
      id: this.nextId("evt"),
      kind: "event",
      type: "job.done",
      payload: {
        jobId: job.jobId,
        result: {
          kind: "avatar.candidates",
          avatarId: job.avatarId,
          candidates: job.candidates,
          rejectedByAgeCheck: rejected,
          failedSlots: ageRejectedSlots(job.total, rejected),
        },
      },
    });
  }

  private failJob(job: MockJob, error: EngineError): void {
    for (const cancel of job.cancelTimers) cancel();
    job.status = "failed";
    job.error = error;
    this.emit({ v: PROTOCOL_VERSION, id: this.nextId("evt"), kind: "event", type: "job.failed", payload: { jobId: job.jobId, error } });
  }

  // ---------- state ----------

  private snapshot(): Snapshot {
    return {
      bootId: this.log.bootId,
      lastSeq: this.log.lastSeq,
      settings: this.settings,
      money: this.moneyStatus(),
      avatars: this.avatars,
      drafts: this.drafts,
      unreadableAvatars: 0,
      jobs: this.jobs.map((j) => this.jobState(j)),
      notices: [],
    };
  }

  private jobState(j: MockJob): JobState {
    const base = { kind: "avatar.candidates" as const, jobId: j.jobId, avatarId: j.avatarId, status: j.status, done: j.done, total: j.total };
    if (j.status === "done") {
      return {
        ...base,
        result: {
          kind: "avatar.candidates",
          avatarId: j.avatarId,
          candidates: j.candidates,
          rejectedByAgeCheck: j.rejectedByAgeCheck,
          failedSlots: ageRejectedSlots(j.total, j.rejectedByAgeCheck),
        },
      };
    }
    if (j.status === "failed" && j.error) return { ...base, error: j.error };
    return base;
  }

  /** Another batch for an existing draft: the price without the descriptor call. */
  private candidatesPrice(): Estimate {
    const worstMicros = Math.max(0, this.price.worstMicros - DESCRIPTOR.worst);
    const expectedMicros = Math.min(worstMicros, Math.max(0, this.price.expectedMicros - DESCRIPTOR.expected));
    return { ...this.price, expectedMicros, worstMicros };
  }

  private moneyStatus(): MoneyStatus {
    const month = new Date(this.clock).toISOString().slice(0, 7);
    if (this.unavailable !== null) {
      return {
        ledger: "unavailable",
        month,
        monthlyBudgetMicros: this.settings.monthlyBudgetMicros,
        reconcileNeeded: false,
        reconcileReasons: [],
        halt: this.unavailable,
      };
    }
    return {
      ledger: "open",
      month,
      spentMicros: this.spentMicros,
      monthlyBudgetMicros: this.settings.monthlyBudgetMicros,
      unsettledMicros: this.unsettledMicros(),
      unsettledCount: this.reserves.size,
      reconcileNeeded: this.reconcileReasons.length > 0,
      reconcileReasons: this.reconcileReasons,
      halt: this.halt,
    };
  }

  private unsettledMicros(): number {
    let total = 0;
    for (const worst of this.reserves.values()) total += worst;
    return total;
  }

  private running(): MockJob[] {
    return this.jobs.filter((j) => j.status === "queued" || j.status === "running");
  }

  private spend(micros: number): void {
    this.spentMicros += micros;
    this.spentSinceReconcile += micros;
    this.emitMoney();
  }

  // ---------- events ----------

  private emitMoney(): void {
    this.emit({ v: PROTOCOL_VERSION, id: this.nextId("evt"), kind: "event", type: "money.changed", payload: { status: this.moneyStatus() } });
  }

  private emitReconcileNeeded(): void {
    if (this.reconcileReasons.length === 0) return;
    this.emit({
      v: PROTOCOL_VERSION,
      id: this.nextId("evt"),
      kind: "event",
      type: "money.reconcileNeeded",
      payload: { reasons: this.reconcileReasons, unsettledMicros: this.unsettledMicros() },
    });
  }

  private emit(event: UnsequencedEvent): void {
    const seq = this.log.append(event);
    if (!this.delivering) return;
    const since = this.log.since(seq - 1, this.log.bootId);
    const delivered: EventMessage[] = since.gap ? [] : since.events;
    for (const e of delivered) for (const listener of [...this.listeners]) listener(e);
  }

  private bootId(): string {
    return `boot-${String(this.boot).padStart(4, "0")}`;
  }

  private nextId(prefix: string): string {
    this.idCounter += 1;
    return `${prefix}-${String(this.idCounter).padStart(4, "0")}`;
  }

  private nowIso(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }
}

/** The mock as an `EngineClient`, through the same validating adapter as the real one; message ids count per client. */
export function mockEngineClient(engine: MockEngine = new MockEngine()): EngineClient {
  let messageCounter = 0;
  return createEngineClient(engine, "mock", () => `msg-${String(++messageCounter).padStart(6, "0")}`);
}
