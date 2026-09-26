import {
  AvatarDescriptor,
  type ApiKeyStatus,
  type AvatarStatus,
  type AvatarSummary,
  type AvatarTraits,
  type Candidate,
  type CommandMessage,
  type CommandType,
  type Draft,
  type EngineError,
  type EngineNotice,
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
  type UnreadableAvatar,
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
export const DESCRIPTOR = { expected: 2_000, worst: 3_000 };
/** The attempt a mock settle-above-worst halt names. */
const MOCK_ABOVE_WORST_ATTEMPT = "mock-attempt#1";
export const MOCK_ESTIMATE: Readonly<Estimate> = {
  expectedMicros: 207_600, // 2_000 + 4 × 50_000 + 4 × 1_400 → "$0.21"
  worstMicros: 223_000, // 3_000 + 4 × 53_000 + 4 × 2_000 → "$0.23"
  prices: "live",
  pricesAsOf: "2026-09-24",
};

const START_OF_TIME = Date.UTC(2026, 8, 24, 10, 0, 0);

type SlotOutcome = "success" | "age-rejected" | "failed";

/**
 * Slot `step` (1-based) of a batch of `total`: the trailing `ageRejected`
 * slots are rejected by the age check, the `failedCount` right before them
 * fail with an error, and the rest succeed. Mirrors the contract's own
 * "unlucky tail" accounting (`FailedCandidateSlot`).
 */
function slotOutcome(step: number, total: number, ageRejected: number, failedCount: number): SlotOutcome {
  const fromEnd = total - step;
  if (fromEnd < ageRejected) return "age-rejected";
  if (fromEnd < ageRejected + failedCount) return "failed";
  return "success";
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
  unreadableAvatars?: UnreadableAvatar[];
  /** Overrides `unreadableTotal` above `unreadableAvatars.length` (L1): the real engine's list is bounded and cut, its total never is. */
  unreadableTotal?: number;
  /**
   * `halt`: paid calls halted as the engine reports it (e.g. a failed ledger
   * write, or a settle above worst known after a restart); `unavailable`: the
   * ledger could not be read, so there are no amounts at all.
   */
  money?: { spentMicros?: number; monthlyBudgetMicros?: number; halt?: MoneyHalt; unavailable?: LedgerUnavailable };
  /** Stored network concurrency (the contract allows 1–16). */
  concurrency?: number;
}

/**
 * What `avatars.rewriteDescriptor` restores a seeded `descriptor-invalid`
 * entry to: everything the resulting draft or saved avatar needs besides its
 * (freshly rewritten) descriptor, which `avatars.rewriteDescriptor` never
 * touches on the master photo, candidates or name.
 */
export interface RewriteTarget {
  status: "draft" | Exclude<AvatarStatus, "draft">;
  name: string;
  traits: AvatarTraits;
  /** Ignored for a draft: it has no master yet. */
  masterPhotoId?: string;
  createdAt?: string;
  photoCount?: number;
  /** A draft's existing candidates, kept through the rewrite exactly as the engine keeps them; ignored for a saved avatar. */
  candidates?: Candidate[];
}

interface MockJob {
  jobId: string;
  avatarId: string;
  status: JobState["status"];
  done: number;
  total: number;
  /** This job's own successes so far, added one at a time as each step lands. */
  candidates: Candidate[];
  rejectedByAgeCheck: number;
  /** Slots that gave no candidate, in step order: age-rejected and failed alike. */
  failedSlots: FailedCandidateSlot[];
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
  private unreadable: UnreadableAvatar[];
  private readonly unreadableTotalOverride: number | null;
  /** What a seeded `descriptor-invalid` entry recovers to, by avatarId; entries seeded without one (or for any other reason) cannot be rewritten. */
  private readonly rewritable = new Map<string, RewriteTarget>();
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
  private readonly delayed = new Map<CommandType, number[]>();
  private readonly reconcileQueue: ReconcileResult[] = [];
  private ageRejectionsNextJob = 0;
  private failedSlotsNextJob: { count: number; error: EngineError; reserveLeftOpen: boolean } | null = null;
  private nextDraftEstimateMissing = false;
  /** Bumped whenever settings.setLibraryPath actually changes the folder, mirroring the real engine's Snapshot field. */
  private librarySwitchGeneration = 0;

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
    this.unreadable = options.unreadableAvatars ?? [];
    this.unreadableTotalOverride = options.unreadableTotal ?? null;
    this.spentMicros = options.money?.spentMicros ?? (options.preset === "demo" ? 1_420_000 : 0);
    this.halt = options.money?.halt ?? null;
    this.unavailable = options.money?.unavailable ?? null;
  }

  // ---------- EngineBridge ----------

  async request(command: CommandMessage): Promise<ResponseMessage> {
    this.calls.push(command);
    const delay = this.delayed.get(command.type)?.shift() ?? (this.latencyMs > 0 ? this.latencyMs : null);
    if (delay !== null) await new Promise<void>((resolve) => this.scheduler.schedule(delay, resolve));
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

  /**
   * The next `type` command answers after `ms` instead of the usual
   * `latencyMs`, so a test can observe a busy/cancelling UI state for exactly
   * that one command without slowing (or racing) anything else, including the
   * scheduler-driven job timers that share the same clock.
   */
  delayNext(type: CommandType, ms: number): void {
    this.delayed.set(type, [...(this.delayed.get(type) ?? []), ms]);
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

  /**
   * The next avatars.createDraft answers with a Draft whose `estimate` is
   * null, as if the engine could not price the next batch when it built the
   * draft — `Draft.estimate` is nullable in the contract (state.ts). Exercises
   * the renderer's avatars.estimateCandidates fallback for that case.
   */
  dropNextDraftEstimate(): void {
    this.nextDraftEstimateMissing = true;
  }

  /**
   * The next candidate job's trailing `count` slots (right before any
   * age-rejected tail from `rejectNextByAgeCheck`) fail with `error` instead
   * of producing a candidate — a moderation refusal, a timeout, and so on.
   * With `count` at 4 (and no age rejections), every slot fails: the batch
   * still ends `status: "done"`, just with zero candidates.
   */
  failNextSlots(count: number, error: EngineError, reserveLeftOpen = false): void {
    this.failedSlotsNextJob = { count: Math.max(0, Math.min(CANDIDATES_PER_JOB, count)), error, reserveLeftOpen };
  }

  /** While off, events go into the log but are not delivered: the window misses them. */
  setDelivery(on: boolean): void {
    this.delivering = on;
  }

  /** Adds an avatar without any event, as if another window had saved it. */
  addAvatarSilently(avatar: AvatarSummary): void {
    this.avatars = [...this.avatars, avatar];
  }

  /**
   * Lists `entry` in `unreadableAvatars`, as the real engine would for a
   * quarantined manifest or a record the contract refuses. With `recoverTo`,
   * `avatars.rewriteDescriptor` can turn it into a normal draft or saved
   * avatar with that shape (its descriptor freshly written); without one, a
   * rewrite attempt on this id answers VALIDATION, like any other entry whose
   * reason is not `descriptor-invalid`.
   */
  seedUnreadable(entry: UnreadableAvatar, recoverTo?: RewriteTarget): void {
    this.unreadable = [...this.unreadable, entry];
    if (recoverTo !== undefined && entry.avatarId !== null) this.rewritable.set(entry.avatarId, recoverTo);
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

  /** Emits an `engine.notice` (a restart, a settings reset) for tests of the renderer's notice handling. */
  emitNotice(notice: EngineNotice): void {
    this.emit({ v: PROTOCOL_VERSION, id: this.nextId("evt"), kind: "event", type: "engine.notice", payload: { notice } });
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
        this.emitSettingsChanged();
        return this.ok(c, apiKey);
      }
      case "settings.clearApiKey": {
        const apiKey: ApiKeyStatus = { stored: false, last4: null, encryptionAvailable: this.encryptionAvailable, rejected: false };
        this.settings = { ...this.settings, apiKey };
        this.emitSettingsChanged();
        return this.ok(c, apiKey);
      }
      case "settings.setBudget":
        this.settings = { ...this.settings, monthlyBudgetMicros: c.payload.monthlyBudgetMicros };
        this.emitMoney();
        this.emitSettingsChanged();
        return this.ok(c, this.settings);
      case "settings.setLibraryPath":
        if (this.running().length > 0) return this.fail(c, { code: "IN_FLIGHT" });
        if (c.payload.path !== this.settings.libraryPath) this.librarySwitchGeneration += 1;
        this.settings = { ...this.settings, libraryPath: c.payload.path };
        this.emitSettingsChanged();
        return this.ok(c, this.settings);
      case "settings.setModels":
        this.settings = { ...this.settings, imageModel: c.payload.imageModel, textModel: c.payload.textModel };
        this.emitSettingsChanged();
        return this.ok(c, this.settings);
      case "settings.setConcurrency":
        this.settings = { ...this.settings, concurrency: { network: c.payload.network } };
        this.emitSettingsChanged();
        return this.ok(c, this.settings);
      case "money.status":
        return this.ok(c, this.moneyStatus());
      case "money.reconcile":
        return this.reconcile(c);
      case "avatars.list":
        return this.ok(c, { avatars: this.avatars, unreadableAvatars: this.unreadable, unreadableTotal: this.unreadableCount() });
      case "avatars.estimate":
        return this.ok(c, this.price);
      case "avatars.estimateCandidates": {
        const draft = this.drafts.find((d) => d.avatarId === c.payload.avatarId);
        if (!draft) return this.fail(c, { code: "NOT_FOUND" });
        if (!AvatarDescriptor.safeParse(draft.descriptor).success) return this.fail(c, { code: "DESCRIPTOR_INVALID" });
        return this.ok(c, this.candidatesPrice());
      }
      case "avatars.estimateRewriteDescriptor": {
        const refusal = this.rewriteRefusal(c.payload.avatarId);
        if (refusal) return this.fail(c, refusal);
        return this.ok(c, this.rewritePrice());
      }
      case "avatars.createDraft": {
        const refusal = this.paidGate(c.payload.acceptedWorstMicros, this.price.worstMicros);
        if (refusal) return this.fail(c, refusal);
        const noEstimate = this.nextDraftEstimateMissing;
        this.nextDraftEstimateMissing = false;
        const draft: Draft = {
          avatarId: this.nextId("avatar"),
          traits: c.payload.traits,
          descriptor: mockDescriptor(c.payload.traits),
          candidates: [],
          // A draft's estimate is its next batch: the descriptor is already
          // paid for. null (dropNextDraftEstimate) mirrors the contract's
          // nullable case: the engine could not price the batch when it
          // built the draft.
          estimate: noEstimate ? null : this.candidatesPrice(),
        };
        this.drafts = [...this.drafts, draft];
        this.spend(DESCRIPTOR.expected);
        return this.ok(c, { draft });
      }
      case "avatars.generateCandidates": {
        const draft = this.drafts.find((d) => d.avatarId === c.payload.avatarId);
        if (!draft) return this.fail(c, { code: "NOT_FOUND" });
        if (this.jobRunningFor(draft.avatarId)) return this.fail(c, { code: "IN_FLIGHT" });
        if (!AvatarDescriptor.safeParse(draft.descriptor).success) return this.fail(c, { code: "DESCRIPTOR_INVALID" });
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
          job.cancelTimers = [];
          // An aborted attempt counts at its worst case until reconciled: the reserve stays open.
          job.status = "cancelled";
          this.emit({ v: PROTOCOL_VERSION, id: this.nextId("evt"), kind: "event", type: "job.cancelled", payload: { jobId: job.jobId } });
        }
        return this.ok(c, { jobId: job.jobId });
      }
      case "avatars.pick": {
        const draft = this.drafts.find((d) => d.avatarId === c.payload.avatarId);
        if (!draft || !draft.candidates.some((cand) => cand.photoId === c.payload.photoId)) {
          return this.fail(c, { code: "NOT_FOUND" });
        }
        if (this.jobRunningFor(draft.avatarId)) return this.fail(c, { code: "IN_FLIGHT" });
        if (!AvatarDescriptor.safeParse(draft.descriptor).success) return this.fail(c, { code: "DESCRIPTOR_INVALID" });
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
        this.emit({ v: PROTOCOL_VERSION, id: this.nextId("evt"), kind: "event", type: "avatar.changed", payload: { avatar } });
        return this.ok(c, { avatar });
      }
      case "avatars.archive": {
        const avatar = this.avatars.find((a) => a.avatarId === c.payload.avatarId);
        if (!avatar) return this.fail(c, { code: "NOT_FOUND" });
        if (!AvatarDescriptor.safeParse(avatar.descriptor).success) return this.fail(c, { code: "DESCRIPTOR_INVALID" });
        const archived: AvatarSummary = { ...avatar, status: "archived" };
        this.avatars = this.avatars.map((a) => (a === avatar ? archived : a));
        this.emit({ v: PROTOCOL_VERSION, id: this.nextId("evt"), kind: "event", type: "avatar.changed", payload: { avatar: archived } });
        return this.ok(c, { avatar: archived });
      }
      case "avatars.rewriteDescriptor": {
        const { avatarId } = c.payload;
        // The engine's order: the key and the ledger before it even looks up
        // the id, then the id (NOT_FOUND/VALIDATION), then the price.
        const refusal = this.keyAndLedgerGate() ?? this.rewriteRefusal(avatarId) ?? this.priceGate(c.payload.acceptedWorstMicros, this.rewritePrice().worstMicros);
        if (refusal) return this.fail(c, refusal);
        const target = this.rewritable.get(avatarId);
        if (target === undefined) throw new Error("unreachable: rewriteRefusal already checked the target exists");
        this.applyRewrite(avatarId, target);
        this.spend(DESCRIPTOR.expected);
        return this.ok(c, { avatarId });
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

  /** The key and the ledger: the engine's first checks before any paid call, before it even looks up what the command names. */
  private keyAndLedgerGate(): EngineError | null {
    const key = this.settings.apiKey;
    if (!key.stored) return { code: "AUTH_INVALID", detail: "no API key is stored" };
    if (key.rejected) return { code: "AUTH_INVALID" };
    const stopped = this.ledgerStop();
    if (stopped) return stopped;
    if (this.reconcileReasons.length > 0 || this.halt !== null) return { code: "RECONCILE_REQUIRED" };
    return null;
  }

  /** The price checks: after the command's target is found valid, `worstMicros` is this command's own worst case. */
  private priceGate(acceptedWorstMicros: number, worstMicros: number): EngineError | null {
    if (acceptedWorstMicros < worstMicros) return { code: "PRICE_CHANGED" };
    const committed = this.spentMicros + this.unsettledMicros() + worstMicros;
    if (committed > this.settings.monthlyBudgetMicros) return { code: "BUDGET_EXCEEDED" };
    return null;
  }

  /** The engine's checks before any paid call, in the order it runs them; `worstMicros` is this command's own worst case. */
  private paidGate(acceptedWorstMicros: number, worstMicros: number): EngineError | null {
    return this.keyAndLedgerGate() ?? this.priceGate(acceptedWorstMicros, worstMicros);
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

  /** Whether an avatar has a candidate batch still queued or running: a second batch or a pick must wait. */
  private jobRunningFor(avatarId: string): boolean {
    return this.jobs.some((j) => j.avatarId === avatarId && (j.status === "queued" || j.status === "running"));
  }

  /** One slot's own reserve, keyed apart from its siblings: cancel, a crash, or `reserveLeftOpen` can leave just this one open. */
  private slotReserveKey(jobId: string, slot: number): string {
    return `${jobId}#${slot}`;
  }

  private startJob(avatarId: string): string {
    const total = CANDIDATES_PER_JOB;
    const ageRejected = this.ageRejectionsNextJob;
    this.ageRejectionsNextJob = 0;
    const failedSpec = this.failedSlotsNextJob;
    this.failedSlotsNextJob = null;
    const failedCount = failedSpec?.count ?? 0;
    const failedError: EngineError = failedSpec?.error ?? { code: "INTERNAL" };
    const failedReserveLeftOpen = failedSpec?.reserveLeftOpen ?? false;
    // Fixed at job start, like the reserve itself: a later setPrice() must not change what an already-running slot owes.
    const perSlotWorst = Math.round((this.price.worstMicros - DESCRIPTOR.worst) / total);
    const perSlotExpected = Math.round((this.price.expectedMicros - DESCRIPTOR.expected) / total);

    const job: MockJob = {
      jobId: this.nextId("job"),
      avatarId,
      status: "queued",
      done: 0,
      total,
      candidates: [],
      rejectedByAgeCheck: 0,
      failedSlots: [],
      error: null,
      cancelTimers: [],
    };
    this.jobs = [...this.jobs, job];
    // Reserved per slot, not as one lump for the whole batch: a cancel, a
    // crash, or a `reserveLeftOpen` failure then leaves only its own slots'
    // reserves open, exactly as the real engine's per-attempt reserves would.
    for (let slot = 1; slot <= total; slot++) this.reserves.set(this.slotReserveKey(job.jobId, slot), perSlotWorst);
    this.emitMoney();

    // Each slot lands on its own step: a success is appended to the draft
    // right away (draft.changed), one at a time, exactly as a real run would
    // report each portrait as it clears its age check. Its reserve is settled
    // the same moment, not batched to the job's end.
    for (let step = 1; step <= total; step++) {
      job.cancelTimers.push(
        this.scheduler.schedule(this.stepMs * step, () => {
          job.status = "running";
          job.done = step;
          const outcome = slotOutcome(step, total, ageRejected, failedCount);
          const reserveKey = this.slotReserveKey(job.jobId, step);
          if (outcome === "success") {
            const candidate: Candidate = { avatarId: job.avatarId, photoId: this.nextId("photo") };
            job.candidates = [...job.candidates, candidate];
            const draft = this.drafts.find((d) => d.avatarId === avatarId);
            if (draft) {
              const updated: Draft = { ...draft, candidates: [...draft.candidates, candidate] };
              this.drafts = this.drafts.map((d) => (d === draft ? updated : d));
              this.emit({ v: PROTOCOL_VERSION, id: this.nextId("evt"), kind: "event", type: "draft.changed", payload: { draft: updated } });
            }
            // A 2xx generation, billed regardless of the (later) pick decision.
            this.reserves.delete(reserveKey);
            this.spend(perSlotExpected);
          } else if (outcome === "age-rejected") {
            job.rejectedByAgeCheck += 1;
            job.failedSlots = [...job.failedSlots, { slot: step, reason: "age-rejected" }];
            // The image itself still generated (a 2xx) before the age check dropped it: billed all the same.
            this.reserves.delete(reserveKey);
            this.spend(perSlotExpected);
          } else {
            job.failedSlots = [...job.failedSlots, { slot: step, reason: "failed", error: failedError, reserveLeftOpen: failedReserveLeftOpen }];
            if (failedReserveLeftOpen) {
              // A timeout or network error: unknown whether OpenRouter billed it, so the reserve stays open until reconciled.
              this.emitMoney();
            } else {
              // A definite non-2xx (a moderation refusal, say): settled at its known cost of zero.
              this.reserves.delete(reserveKey);
              this.emitMoney();
            }
          }
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
    job.cancelTimers.push(this.scheduler.schedule(this.stepMs * (total + 1), () => this.finishJob(job)));
    return job.jobId;
  }

  private finishJob(job: MockJob): void {
    job.status = "done";
    job.done = job.total;
    // Every slot settled (or, for `reserveLeftOpen`, stayed open) as it landed above: nothing left to spend here.
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
          rejectedByAgeCheck: job.rejectedByAgeCheck,
          failedSlots: job.failedSlots,
        },
      },
    });
  }

  private failJob(job: MockJob, error: EngineError): void {
    for (const cancel of job.cancelTimers) cancel();
    job.cancelTimers = [];
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
      unreadableAvatars: this.unreadable,
      unreadableTotal: this.unreadableCount(),
      jobs: this.jobs.map((j) => this.jobState(j)),
      librarySwitchGeneration: this.librarySwitchGeneration,
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
          failedSlots: j.failedSlots,
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

  /** The descriptor-only recovery's price: the same descriptor sub-cost `candidatesPrice` subtracts, alone. */
  private rewritePrice(): Estimate {
    return { ...this.price, expectedMicros: DESCRIPTOR.expected, worstMicros: DESCRIPTOR.worst };
  }

  /**
   * NOT_FOUND for an id that names nothing at all, or that names a
   * `manifest-unreadable` entry — the real engine's library never holds such
   * a manifest either, so it is exactly as unknown as an id that never
   * existed. VALIDATION for one this mock cannot rewrite — already fine
   * (listed normally), or unreadable for a `contract-mismatch` reason, or
   * seeded without a recovery target. Null when it is a rewritable
   * descriptor-invalid entry.
   */
  private rewriteRefusal(avatarId: string): EngineError | null {
    if (this.rewritable.has(avatarId)) return null;
    const entry = this.unreadable.find((u) => u.avatarId === avatarId);
    if (entry !== undefined) return entry.reason === "manifest-unreadable" ? { code: "NOT_FOUND" } : { code: "VALIDATION", detail: "nothing to rewrite" };
    const known = this.avatars.some((a) => a.avatarId === avatarId) || this.drafts.some((d) => d.avatarId === avatarId);
    return known ? { code: "VALIDATION", detail: "nothing to rewrite" } : { code: "NOT_FOUND" };
  }

  /** Turns a seeded unreadable entry into a normal draft or saved avatar with a freshly written descriptor; the master, candidates and name are untouched. */
  private applyRewrite(avatarId: string, target: RewriteTarget): void {
    this.unreadable = this.unreadable.filter((u) => u.avatarId !== avatarId);
    this.rewritable.delete(avatarId);
    const descriptor = mockDescriptor(target.traits);
    if (target.status === "draft") {
      const draft: Draft = { avatarId, traits: target.traits, descriptor, candidates: target.candidates ?? [], estimate: this.candidatesPrice() };
      this.drafts = [...this.drafts, draft];
      this.emit({ v: PROTOCOL_VERSION, id: this.nextId("evt"), kind: "event", type: "draft.changed", payload: { draft } });
      return;
    }
    const avatar: AvatarSummary = {
      avatarId,
      name: target.name,
      descriptor,
      masterPhotoId: target.masterPhotoId ?? this.nextId("photo"),
      createdAt: target.createdAt ?? this.nowIso(),
      status: target.status,
      photoCount: target.photoCount ?? 0,
    };
    this.avatars = [...this.avatars, avatar];
    this.emit({ v: PROTOCOL_VERSION, id: this.nextId("evt"), kind: "event", type: "avatar.changed", payload: { avatar } });
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

  /** `unreadableAvatars.length`, or a seeded override for testing the "N more" UI beyond the bounded list (L1). */
  private unreadableCount(): number {
    return Math.max(this.unreadable.length, this.unreadableTotalOverride ?? 0);
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

  /** Mirrors the real engine's #emitSettings: every settings command emits this, so generation-based resync (store.ts) is exercised in mock/dev mode too. */
  private emitSettingsChanged(): void {
    this.emit({
      v: PROTOCOL_VERSION,
      id: this.nextId("evt"),
      kind: "event",
      type: "settings.changed",
      payload: { settings: this.settings, librarySwitchGeneration: this.librarySwitchGeneration },
    });
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
