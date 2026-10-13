import { rm } from "node:fs/promises";
import { join } from "node:path";
import { PROTOCOL_VERSION, type ClipAttemptModel, type ClipFace, type ClipFailReason, type ClipRequest, type EngineError } from "../../shared/engine";
import { CLIP_RETRYABLE_FAILURES } from "../../shared/engine/clips";
import type { UnsequencedEvent } from "../../shared/engine/events";
import { EngineFailure } from "../engineFailure";
import type { WorkerFaceGate } from "../face/worker/workerGate";
import type { ClipJobEnd, JobRegistry } from "../jobs";
import { fsyncDir, fsyncFile, readFolderNames, isTempName } from "../library/durableFs";
import { isLibraryId } from "../library/ids";
import { renameWithRetry } from "../library/renameRetry";
import type { OpenRouterClient } from "../openrouter/types";
import { downloadClip, type ClipDownload } from "./download";
import { checkClipFace } from "./faceCheck";
import type { ClipFaceRole } from "./faceRole";
import { makePoster } from "./frames";
import { holdsAfterRestart, holdUntilForTerminal, type ClipHolds } from "./holds";
import { clipAttemptId, parseClipAttemptId, summarizeJournal, type JournalAttempt, type JournalSummary } from "./journal";
import type { ClipJournalLine, ClipRecord } from "./schemas";
import { clipsDirOf, journalOf, posterPath, posterTempPath, readClipRecord, removeJournal, writeClipRecord } from "./store";
import type { ClipTimings } from "./timings";
import { validateClipFile, type ClipColour } from "./validate";

// Stage 5, 5b.1, S5.V6 (plan s5b1 §5.12, I5.48, I5.49): what a restart does with the clips folder. It is the whole of «restart = reconcile, never adopt»:
//
// - A free RECOVERY JOB per clip that has a journal and no record. It polls and downloads a clip that was submitted (free), and it NEVER writes the ledger: it holds no money type with a write
//   on it (`RecoveryLedger` has only reads). Every reserve of an earlier process waits for the owner's reconcile, which settles it at worst after the holds below have expired.
// - The HOLDS of a restart (`holdsAfterRestart`, V3b): per attempt, the latest fact wins (an `ended` line: 2 min; a `submitted` line: 60 min; a reserve alone: 20 min from the reserve line's `at`),
//   so the reconcile answers TOO_SOON while an attempt of an earlier process may still bill.
// - The SWEEP of the clips folder: temp files and temp folders a crash left (never while a clip job of this process is live), and an mp4 or poster with neither a record nor a journal (a crash in the
//   middle of a delete). A stale journal next to a record is removed. A ready record whose poster file is missing gets its poster drawn again from the kept mp4 (temp + rename, no record rewrite).
//
// The recovery table (§5.12), as `planRecovery` reads it:
//   | journal holds                                                   | action (free, no ledger line)                             | record                              |
//   | `requested` only (a reserve of it with no `submitted` line too) | none                                                      | failed `lost`                       |
//   | `submitted`, no `ended`, < 60 min                               | poll every minute until 60 min; `completed` → fetch it    | ready, `recovered`; or the end seen |
//   | the same, ≥ 60 min                                              | none                                                      | failed `late`                       |
//   | `ended completed`, no record                                    | download again within 60 min                              | ready; after 60 min `download-expired` |
//   | Kling `ended` free, Grok `submitted`                            | the rows above for Grok                                   |                                     |
//   | Kling `ended` free, Grok reserved, no Grok `submitted`          | none                                                      | failed `lost` (Grok's reserve waits) |
//   | a record already exists                                         | remove the stale journal                                  |                                     |

/** The ledger as recovery sees it: read-only. There is no write on this type, so recovery cannot write a line (I5.49). */
export interface RecoveryLedger {
  openReserves(): readonly { attemptId: string; at: string }[];
  reserveOf(attemptId: string): { attemptId: string; at: string } | undefined;
}

/** The part of the library a recovery reads: the avatars and where their folders are. */
export interface RecoveryLibrary {
  listAvatars(): readonly { readonly id: string }[];
  avatarDirPath(avatarId: string): string;
}

/** The three calls a recovery makes, all free: the status, the file, and the provider's own number for information. */
export type RecoveryClient = Pick<OpenRouterClient, "pollVideo" | "downloadVideo" | "fetchGeneration">;

export interface RecoveryMedia {
  readonly downloadClip: typeof downloadClip;
  readonly makePoster: typeof makePoster;
  readonly checkClipFace: typeof checkClipFace;
  readonly validateClipFile: typeof validateClipFile;
}

const REAL_MEDIA: RecoveryMedia = { downloadClip, makePoster, checkClipFace, validateClipFile };

export interface ClipRecoveryHost {
  readonly clock: () => number;
  readonly newId: () => string;
  readonly timings: ClipTimings;
  readonly holds: Pick<ClipHolds, "hold">;
  /** Fires when the engine stops: every recovery job stops waiting. */
  readonly signal: AbortSignal;
  readonly ledger: () => RecoveryLedger | null;
  readonly jobs: Pick<JobRegistry, "startClip" | "clipPhase" | "finishClip">;
  readonly emit: (event: UnsequencedEvent) => void;
  /** The clip service's counters: `enter` is the per-clip guard plus `#clipWork` (null: a job already works on that clip). */
  readonly work: { enter(clipId: string): (() => void) | null; anyActive(): boolean; isActive(clipId: string): boolean };
  readonly usableKey: (purpose: string) => string;
  readonly openRouter: (key: string) => RecoveryClient;
  /** Resolves after `ms`, or as soon as `signal` aborts (it never rejects). */
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly faceGate: () => Pick<WorkerFaceGate, "check" | "isBroken"> | null;
  /** The role the clip's source photo had at the gate (I5.52), or null when it cannot be known (the photo is gone, its plan unreadable). Bound to the library the recovery runs on. */
  readonly faceRoleOf: (photoId: string) => Promise<ClipFaceRole | null>;
  /** The master's embedding for a judged clip, or null when it cannot be taken. Bound to the library the recovery runs on. */
  readonly masterEmbedding: (avatarId: string, signal: AbortSignal) => Promise<Float32Array | null>;
  readonly media?: Partial<RecoveryMedia>;
  readonly log: (line: string) => void;
}

// ---------- the plan: one pure function over what is on disk ----------

export type RecoveryPlan =
  | { kind: "stale-journal" }
  | { kind: "unreadable-journal" }
  | { kind: "fail"; reason: ClipFailReason; model: ClipAttemptModel }
  | { kind: "poll"; attemptId: string; model: ClipAttemptModel; providerJobId: string; submittedAtMs: number }
  | { kind: "download"; attemptId: string; model: ClipAttemptModel; providerJobId: string; submittedAtMs: number };

export interface PlanInput {
  readonly summary: JournalSummary;
  readonly recordExists: boolean;
  /** The clip's attempt ids that have a reserve line in the ledger, open or closed. */
  readonly reservedAttempts: ReadonlySet<string>;
  readonly nowMs: number;
  readonly timings: ClipTimings;
}

type EndedLine = NonNullable<JournalAttempt["ended"]>;

/** Why a failure the journal says ended an attempt is recorded as it is: a refusal by what settled it, any other end as a provider error. */
function reasonOfEnded(ended: EndedLine): ClipFailReason {
  switch (ended.status) {
    case "refused":
      if (ended.costSource === "proof") return "refused-free";
      return ended.costSource === "generation" || ended.costSource === "usage" ? "refused-paid" : "refused-unknown";
    case "late":
      return "late";
    case "uncertain":
      return "submit-uncertain";
    case "completed":
    case "failed":
    case "cancelled":
    case "expired":
      return "provider-error";
  }
}

/** The attempt ids of a clip, with their number: 1 is the chosen model, 2 the automatic Grok behind Kling. */
function numberOf(attemptId: string): 1 | 2 {
  return parseClipAttemptId(attemptId)?.n ?? 1;
}

function modelOf(attempt: { attemptId: string; model?: ClipAttemptModel }, request: ClipRequest): ClipAttemptModel {
  return attempt.model ?? (numberOf(attempt.attemptId) === 2 ? "grok" : request.model);
}

export function planRecovery(input: PlanInput): RecoveryPlan {
  const { summary, recordExists, reservedAttempts, nowMs, timings } = input;
  if (recordExists) return { kind: "stale-journal" };
  const { requested } = summary;
  if (requested === null) return { kind: "unreadable-journal" };
  const request = requested.request;

  // An attempt an earlier process saw complete: its file is fetched again, within 60 min of the submit.
  const completed = summary.attempts.find((a) => a.ended?.status === "completed" && a.providerJobId !== undefined && a.submittedAt !== undefined);
  if (completed?.providerJobId !== undefined && completed.submittedAt !== undefined) {
    const submittedAtMs = Date.parse(completed.submittedAt);
    const model = modelOf(completed, request);
    if (nowMs >= submittedAtMs + timings.lateGiveUpMs) return { kind: "fail", reason: "download-expired", model };
    return { kind: "download", attemptId: completed.attemptId, model, providerJobId: completed.providerJobId, submittedAtMs };
  }

  // The attempt that was out when the process stopped: polled while it is under 60 min old.
  const out = summary.attempts.findLast((a) => a.submittedAt !== undefined && a.providerJobId !== undefined && a.ended === undefined);
  if (out?.providerJobId !== undefined && out.submittedAt !== undefined) {
    const submittedAtMs = Date.parse(out.submittedAt);
    const model = modelOf(out, request);
    if (nowMs >= submittedAtMs + timings.lateGiveUpMs) return { kind: "fail", reason: "late", model };
    return { kind: "poll", attemptId: out.attemptId, model, providerJobId: out.providerJobId, submittedAtMs };
  }

  // A reserve with no `submitted` line: the POST may have left, and nothing says what became of it.
  const submittedIds = new Set(summary.attempts.filter((a) => a.submittedAt !== undefined).map((a) => a.attemptId));
  const unsent = [...reservedAttempts].filter((id) => parseClipAttemptId(id) !== null && !submittedIds.has(id)).sort();
  const lastUnsent = unsent.at(-1);
  if (lastUnsent !== undefined) return { kind: "fail", reason: "lost", model: modelOf({ attemptId: lastUnsent }, request) };

  // Every attempt the journal names ended in a failure: the clip says how the last one did.
  const last = summary.attempts.findLast((a) => a.ended !== undefined);
  if (last?.ended !== undefined) return { kind: "fail", reason: reasonOfEnded(last.ended), model: modelOf(last, request) };

  return { kind: "fail", reason: "lost", model: request.model };
}

// ---------- the sweep ----------

const SUFFIXES = [".journal.jsonl", ".json", ".poster.jpg", ".mp4"] as const;

function parsed(name: string): { clipId: string; suffix: (typeof SUFFIXES)[number] } | null {
  for (const suffix of SUFFIXES) {
    if (!name.endsWith(suffix)) continue;
    const clipId = name.slice(0, -suffix.length);
    return isLibraryId(clipId) ? { clipId, suffix } : null;
  }
  return null;
}

/**
 * Removes what a crash left in one avatar's clips folder: temp files and temp folders (`isTempName`, directories included; only when `sweepTemps`, which the caller turns off while a clip job
 * of this process is live, since a temp name does not say whose it is), and an mp4 or a poster that has neither a record nor a journal (a crash in the middle of a delete) unless a job of this
 * process works on that clip. Never throws: a file that cannot be removed stays for the next start.
 */
export async function sweepClipsDir(clipsDir: string, options: { sweepTemps: boolean; isActive: (clipId: string) => boolean }): Promise<void> {
  const listed = await readFolderNames(clipsDir);
  if (!listed.ok) return;
  const records = new Set<string>();
  const journals = new Set<string>();
  for (const name of listed.names) {
    const p = parsed(name);
    if (p?.suffix === ".json") records.add(p.clipId);
    else if (p?.suffix === ".journal.jsonl") journals.add(p.clipId);
  }
  for (const name of listed.names) {
    if (isTempName(name)) {
      if (options.sweepTemps) await rm(join(clipsDir, name), { recursive: true, force: true }).catch(() => undefined);
      continue;
    }
    const p = parsed(name);
    if (p === null || (p.suffix !== ".mp4" && p.suffix !== ".poster.jpg")) continue;
    if (records.has(p.clipId) || journals.has(p.clipId) || options.isActive(p.clipId)) continue;
    await rm(join(clipsDir, name), { force: true }).catch(() => undefined);
  }
}

// ---------- the recovery of one library ----------

interface Candidate {
  readonly avatarId: string;
  readonly clipsDir: string;
  readonly clipId: string;
  readonly lines: ClipJournalLine[];
  readonly record: Awaited<ReturnType<typeof readClipRecord>>["kind"];
}

const iso = (ms: number): string => new Date(ms).toISOString();

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

/**
 * Called when a library becomes the live one (the engine's start, a library switch). Reads the clips folders, takes the restart's holds, sweeps, removes stale journals and starts one recovery
 * job per clip that needs one. It resolves once the jobs are STARTED, with their promises (a test waits on them; the engine does not).
 */
export async function recoverClips(host: ClipRecoveryHost, library: RecoveryLibrary): Promise<{ jobs: Promise<void>[] }> {
  const jobs: Promise<void>[] = [];
  const ledger = host.ledger();
  const nowMs = host.clock();
  const sweepTemps = !host.work.anyActive();

  // ----- 1. what is on disk: the journals with no record, and the ready records without a poster -----
  const candidates: Candidate[] = [];
  const repaints: { avatarId: string; clipsDir: string; clipId: string }[] = [];
  const folders: { avatarId: string; clipsDir: string }[] = [];
  for (const avatar of library.listAvatars()) {
    const clipsDir = clipsDirOf(library, avatar.id);
    const listed = await readFolderNames(clipsDir);
    if (!listed.ok) {
      host.log(`[clip] the clips folder of avatar ${avatar.id} could not be listed; recovery skips it`);
      continue;
    }
    if (listed.names.length === 0) continue;
    folders.push({ avatarId: avatar.id, clipsDir });
    const present = new Set(listed.names);
    for (const name of listed.names) {
      const p = parsed(name);
      if (p === null || host.work.isActive(p.clipId)) continue;
      if (p.suffix === ".journal.jsonl") {
        try {
          const record = await readClipRecord(clipsDir, p.clipId);
          candidates.push({ avatarId: avatar.id, clipsDir, clipId: p.clipId, lines: await journalOf(clipsDir, p.clipId).read(), record: record.kind });
        } catch (error) {
          host.log(`[clip] the journal of clip ${p.clipId} could not be read (${error instanceof Error ? error.name : typeof error}); recovery skips it`);
        }
      } else if (p.suffix === ".json" && !present.has(`${p.clipId}.poster.jpg`) && present.has(`${p.clipId}.mp4`) && !present.has(`${p.clipId}.journal.jsonl`)) {
        repaints.push({ avatarId: avatar.id, clipsDir, clipId: p.clipId });
      }
    }
  }

  // ----- 2. the holds of a restart, before anything slower -----
  const reserves = (ledger?.openReserves() ?? []).filter((r) => parseClipAttemptId(r.attemptId) !== null).map((r) => ({ attemptId: r.attemptId, at: r.at }));
  const journal = candidates.filter((c) => c.record !== "record").flatMap((c) => c.lines);
  for (const [attemptId, untilMs] of holdsAfterRestart({ reserves, journal, nowMs, timings: host.timings })) host.holds.hold(attemptId, untilMs);

  // ----- 3. the sweep, then the stale journals -----
  for (const folder of folders) await sweepClipsDir(folder.clipsDir, { sweepTemps, isActive: (clipId) => host.work.isActive(clipId) });
  for (const candidate of candidates) {
    if (candidate.record !== "record") continue;
    try {
      await removeJournal(candidate.clipsDir, candidate.clipId);
    } catch (error) {
      host.log(`[clip] the stale journal of clip ${candidate.clipId} could not be removed (${error instanceof Error ? error.name : typeof error}); the next start tries again`);
    }
  }

  // ----- 4. the jobs -----
  for (const candidate of candidates) {
    if (candidate.record === "invalid") {
      host.log(`[clip] the record of clip ${candidate.clipId} does not read; its journal and files are left as they are`);
      continue;
    }
    if (candidate.record === "record") continue;
    const summary = summarizeJournal(candidate.lines);
    const reservedAttempts = new Set([1, 2].map((n) => clipAttemptId(candidate.clipId, n as 1 | 2)).filter((id) => ledger?.reserveOf(id) !== undefined));
    const plan = planRecovery({ summary, recordExists: false, reservedAttempts, nowMs, timings: host.timings });
    if (plan.kind === "unreadable-journal" || plan.kind === "stale-journal") {
      host.log(`[clip] the journal of clip ${candidate.clipId} has no \`requested\` line; recovery leaves it`);
      continue;
    }
    const run = startRecoveryJob(host, candidate.avatarId, candidate.clipId, (job) => new Recovery(host, library, candidate, summary, reservedAttempts, plan, job).run());
    if (run !== null) jobs.push(run);
  }
  for (const repaint of repaints) {
    const run = startRecoveryJob(host, repaint.avatarId, repaint.clipId, (job) => repaintPoster(host, repaint.clipsDir, repaint.clipId, job));
    if (run !== null) jobs.push(run);
  }
  return { jobs };
}

// ---------- a recovery job ----------

interface Job {
  readonly jobId: string;
  readonly avatarId: string;
  readonly clipId: string;
  /** Fires on the engine's stop (and on a cancel, which a recovery job never lets through). */
  readonly signal: AbortSignal;
  phase(update: { phase: "recovering" | "downloading" | "checking" | "saving"; model?: ClipAttemptModel; submittedAt?: string; done?: number }): void;
}

type JobOutcome = "recorded" | "interrupted";

/** Registers the job, runs `work`, and announces its end. Null when a job already works on the clip. Never rejects. */
function startRecoveryJob(host: ClipRecoveryHost, avatarId: string, clipId: string, work: (job: Job) => Promise<JobOutcome>): Promise<void> | null {
  const leave = host.work.enter(clipId);
  if (leave === null) return null;
  const jobId = host.newId();
  const ref = { kind: "clip" as const, jobId, avatarId, clipId };
  const cancel = host.jobs.startClip(jobId, { avatarId, clipId }, "recovering");
  const job: Job = {
    jobId,
    avatarId,
    clipId,
    signal: eitherSignal(cancel, host.signal),
    phase: (update) => {
      const progress = host.jobs.clipPhase(jobId, update);
      if (progress !== null) host.emit({ v: PROTOCOL_VERSION, id: host.newId(), kind: "event", type: "job.progress", payload: progress });
    },
  };
  job.phase({ phase: "recovering" });
  return (async () => {
    let end: ClipJobEnd;
    try {
      end = (await work(job)) === "interrupted" ? { status: "cancelled" } : { status: "done" };
    } catch (error) {
      host.log(`[clip] ${clipId}: its recovery failed (${error instanceof Error ? error.name : typeof error})`);
      const failure: EngineError = error instanceof EngineFailure ? error.error : { code: "INTERNAL", detail: "the clip's recovery failed; its journal is kept for the next start" };
      end = { status: "failed", error: failure };
    } finally {
      leave();
    }
    try {
      const state = host.jobs.finishClip(jobId, end);
      const v = PROTOCOL_VERSION;
      if (state?.status === "done" && state.result !== undefined) host.emit({ v, id: host.newId(), kind: "event", type: "job.done", payload: { jobId, result: state.result } });
      else if (end.status === "failed") host.emit({ v, id: host.newId(), kind: "event", type: "job.failed", payload: { ...ref, error: end.error } });
      else if (end.status === "cancelled") host.emit({ v, id: host.newId(), kind: "event", type: "job.cancelled", payload: ref });
    } catch (error) {
      host.log(`[clip] the end of recovery job ${jobId} could not be announced (${error instanceof Error ? error.name : typeof error})`);
    }
  })();
}

type PolledStatus = Extract<Awaited<ReturnType<RecoveryClient["pollVideo"]>>, { kind: "status" }>;
const TERMINAL = new Set<string>(["completed", "failed", "cancelled", "expired"]);

class Recovery {
  private readonly media: RecoveryMedia;
  private readonly journal;

  constructor(
    private readonly host: ClipRecoveryHost,
    private readonly library: RecoveryLibrary,
    private readonly candidate: Candidate,
    private readonly summary: JournalSummary,
    private readonly reserved: ReadonlySet<string>,
    private readonly plan: Exclude<RecoveryPlan, { kind: "stale-journal" | "unreadable-journal" }>,
    private readonly job: Job,
  ) {
    this.media = { ...REAL_MEDIA, ...host.media };
    this.journal = journalOf(candidate.clipsDir, candidate.clipId);
  }

  private get requested() {
    const requested = this.summary.requested;
    if (requested === null) throw new Error("a recovery plan without a `requested` line");
    return requested;
  }

  async run(): Promise<JobOutcome> {
    const { plan } = this;
    switch (plan.kind) {
      case "fail":
        return this.recordFailure(plan.reason, plan.model);
      case "poll":
        return this.poll(plan);
      case "download":
        return this.fetchAndRecord(plan, null);
    }
  }

  // ----- a client, once there is a key -----

  /** The key arrives after the engine starts (main sends it over the port), so a recovery that needs the network waits for it, until the time the clip is given up on. */
  private async client(giveUpAtMs: number): Promise<RecoveryClient | "stopped" | "deadline"> {
    const { host, job } = this;
    for (;;) {
      if (job.signal.aborted) return "stopped";
      try {
        return host.openRouter(host.usableKey("recover a clip"));
      } catch (error) {
        if (!(error instanceof EngineFailure)) throw error;
      }
      const remaining = giveUpAtMs - host.clock();
      if (remaining <= 0) return "deadline";
      await host.sleep(Math.min(host.timings.pollMs, remaining), job.signal);
    }
  }

  // ----- a submitted attempt with no end -----

  private async poll(plan: Extract<RecoveryPlan, { kind: "poll" }>): Promise<JobOutcome> {
    const { host, job } = this;
    const giveUpAtMs = plan.submittedAtMs + host.timings.lateGiveUpMs;
    job.phase({ phase: "recovering", model: plan.model, submittedAt: iso(plan.submittedAtMs) });
    const client = await this.client(giveUpAtMs);
    if (client === "stopped") return "interrupted";
    if (client === "deadline") return this.giveUp(plan);
    for (;;) {
      if (job.signal.aborted) return "interrupted";
      if (host.clock() >= giveUpAtMs) return this.giveUp(plan);
      let status: PolledStatus | null = null;
      try {
        const read = await client.pollVideo(plan.providerJobId, job.signal);
        if (read.kind === "status") status = read;
      } catch {
        // unreadable: the next poll tries again
      }
      if (job.signal.aborted) return "interrupted";
      if (status !== null && TERMINAL.has(status.status)) return this.terminal(client, plan, status);
      await host.sleep(Math.min(host.timings.latePollMs, Math.max(0, giveUpAtMs - host.clock())), job.signal);
    }
  }

  private async giveUp(plan: { attemptId: string; model: ClipAttemptModel }): Promise<JobOutcome> {
    await this.journal.ended({ attemptId: plan.attemptId, status: "late", costSource: "none", at: iso(this.host.clock()) });
    return this.recordFailure("late", plan.model, { attemptId: plan.attemptId, outcome: "late" });
  }

  /** The job reached a terminal status while the engine was away or just now: the journal learns it, the hold becomes terminal + 2 min, and nothing is written to the ledger. */
  private async terminal(client: RecoveryClient, plan: Extract<RecoveryPlan, { kind: "poll" }>, status: PolledStatus): Promise<JobOutcome> {
    const { host } = this;
    const atMs = host.clock();
    host.holds.hold(plan.attemptId, holdUntilForTerminal(atMs, host.timings));
    if (status.status === "completed") {
      const providerCostMicros = await this.providerCost(client, plan.providerJobId, status);
      await this.journal.ended({ attemptId: plan.attemptId, status: "completed", ...(providerCostMicros === null ? {} : { providerCostMicros }), costSource: "none", at: iso(atMs) });
      return this.fetchAndRecord(plan, providerCostMicros, client);
    }
    const outcome = status.contentFailure ? "refused" : status.status === "cancelled" ? "cancelled" : status.status === "expired" ? "expired" : "failed";
    await this.journal.ended({ attemptId: plan.attemptId, status: outcome, costSource: "none", at: iso(atMs) });
    return this.recordFailure(outcome === "refused" ? "refused-unknown" : "provider-error", plan.model, { attemptId: plan.attemptId, outcome });
  }

  /** The provider's own number, for information only: the poll's usage, else one `/generation` read of this job's own record. */
  private async providerCost(client: RecoveryClient, providerJobId: string, status: PolledStatus): Promise<number | null> {
    if (status.usageCostMicros !== null) return status.usageCostMicros;
    if (status.generationId !== providerJobId) return null;
    try {
      const read = await client.fetchGeneration(providerJobId, this.job.signal);
      return read.kind === "found" ? read.totalCostMicros : null;
    } catch {
      return null;
    }
  }

  // ----- the file -----

  private async fetchAndRecord(plan: { attemptId: string; model: ClipAttemptModel; providerJobId: string; submittedAtMs: number }, providerCostMicros: number | null, known?: RecoveryClient): Promise<JobOutcome> {
    const { host, job, candidate } = this;
    const request = this.requested.request;
    const giveUpAtMs = plan.submittedAtMs + host.timings.lateGiveUpMs;
    const earlier = this.summary.attempts.find((a) => a.attemptId === plan.attemptId)?.ended;
    const cost = providerCostMicros ?? earlier?.providerCostMicros ?? null;
    const completed = { attemptId: plan.attemptId, outcome: "completed" as const, ...(cost === null ? {} : { providerCostMicros: cost }) };

    const client = known ?? (await this.client(giveUpAtMs));
    if (client === "stopped") return "interrupted";
    if (client === "deadline") return this.recordFailure("download-expired", plan.model, completed);

    job.phase({ phase: "downloading", model: plan.model, submittedAt: iso(plan.submittedAtMs), done: 1 });
    let download: ClipDownload;
    try {
      download = await this.media.downloadClip({ client, providerJobId: plan.providerJobId, clipId: candidate.clipId, clipsDir: candidate.clipsDir, requestedSeconds: request.seconds, signal: job.signal });
    } catch (error) {
      if (job.signal.aborted) return "interrupted";
      host.log(`[clip] ${candidate.clipId}: the download could not be stored (${error instanceof Error ? error.name : typeof error})`);
      return this.recordFailure("download-failed", plan.model, completed, plan.submittedAtMs);
    }
    if (job.signal.aborted) return "interrupted";
    if (download.kind === "failed") {
      host.log(`[clip] ${candidate.clipId}: the download failed (${download.reason})`);
      return this.recordFailure(download.reason, plan.model, completed, plan.submittedAtMs);
    }
    await this.journal.downloaded({ sha256: download.sha256, bytes: download.clip.bytes, at: iso(host.clock()) });

    job.phase({ phase: "checking", model: plan.model, done: 2 });
    await this.poster(download.path, download.clip.colour);
    const face = await this.face(download);
    if (job.signal.aborted) return "interrupted";

    job.phase({ phase: "saving", model: plan.model, done: 3 });
    return this.commit({
      ...this.base(plan.model, completed),
      outcome: {
        status: "ready",
        file: `${candidate.clipId}.mp4`,
        posterFile: `${candidate.clipId}.poster.jpg`,
        width: download.clip.width,
        height: download.clip.height,
        durationMs: Math.max(1, Math.round(download.clip.durationMs)),
        fps: download.clip.fps,
        bytes: download.clip.bytes,
        sha256: download.sha256,
        face,
      },
    });
  }

  /** The poster under a temp name, made durable and renamed. A poster that cannot be drawn costs the paid clip nothing: it is kept without one and the next start draws it again. */
  private async poster(clipPath: string, colour: ClipColour): Promise<void> {
    const { host, candidate } = this;
    const temp = posterTempPath(candidate.clipsDir, candidate.clipId);
    try {
      await this.media.makePoster({ clipPath, colour, log: host.log, outPath: temp, signal: this.job.signal });
      await fsyncFile(temp);
      await renameWithRetry(temp, posterPath(candidate.clipsDir, candidate.clipId));
      await fsyncDir(candidate.clipsDir);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      host.log(`[clip] ${candidate.clipId}: the poster could not be drawn (${error instanceof Error ? error.name : typeof error}); the clip is kept without one`);
    }
  }

  /** The face check (I5.52): it marks and never fails the clip. A photo whose role is unknown, and a judged photo without a gate or a master embedding, are kept unchecked. */
  private async face(download: Extract<ClipDownload, { kind: "saved" }>): Promise<ClipFace> {
    const { host, candidate, job } = this;
    const unchecked: ClipFace = { verdict: "skipped", frames: 0, why: "worker" };
    const role = await host.faceRoleOf(this.requested.photoId);
    if (role === null) return unchecked;
    const gate = host.faceGate();
    let embedding: Float32Array | null = null;
    if (role === "judged") {
      if (gate === null || gate.isBroken()) return unchecked;
      embedding = await host.masterEmbedding(candidate.avatarId, job.signal);
      if (embedding === null) return unchecked;
    }
    return this.media.checkClipFace({
      role,
      clipPath: download.path,
      colour: download.clip.colour,
      durationMs: download.clip.durationMs,
      scratchDir: candidate.clipsDir,
      masterEmbedding: embedding ?? new Float32Array(0),
      gate: gate ?? { check: () => Promise.reject(new Error("no face gate")) },
      signal: job.signal,
      log: host.log,
    });
  }

  // ----- the record -----

  /** The attempts the record keeps: those the journal names, then a reserve with no journal line; the one this recovery decided is overridden by what it learned. */
  private attempts(decided?: { attemptId: string; outcome: ClipRecord["provider"]["attempts"][number]["outcome"]; providerCostMicros?: number }): ClipRecord["provider"]["attempts"] {
    const named = this.summary.attempts.map((a) => {
      const base = {
        attemptId: a.attemptId,
        ...(a.providerJobId === undefined ? {} : { providerJobId: a.providerJobId }),
        outcome: a.ended?.status ?? ("late" as const),
        ...(a.ended?.providerCostMicros === undefined ? {} : { providerCostMicros: a.ended.providerCostMicros }),
        costSource: a.ended?.costSource ?? ("none" as const),
      };
      if (decided?.attemptId !== a.attemptId) return base;
      return { ...base, outcome: decided.outcome, ...(decided.providerCostMicros === undefined ? {} : { providerCostMicros: decided.providerCostMicros }), costSource: a.ended?.costSource ?? ("none" as const) };
    });
    const known = new Set(named.map((a) => a.attemptId));
    const unsent = [...this.reserved].filter((id) => !known.has(id)).sort().map((attemptId) => ({ attemptId, outcome: "uncertain" as const, costSource: "none" as const }));
    return [...named, ...unsent].slice(0, 2);
  }

  private base(model: ClipAttemptModel, decided?: Parameters<Recovery["attempts"]>[0]): Omit<ClipRecord, "outcome"> {
    const { candidate } = this;
    const requested = this.requested;
    return {
      schemaVersion: 1,
      id: candidate.clipId,
      avatarId: candidate.avatarId,
      sourcePhotoId: requested.photoId,
      createdAt: requested.at,
      seen: false,
      motion: requested.motion,
      request: requested.request,
      provider: { model: model === "grok" ? "grok" : requested.request.quality === "pro" ? "kling-pro" : "kling-std", attempts: this.attempts(decided) },
      recovered: true,
      exports: [],
    };
  }

  private async recordFailure(reason: ClipFailReason, model: ClipAttemptModel, decided?: Parameters<Recovery["attempts"]>[0], submittedAtMs?: number): Promise<JobOutcome> {
    const retryable = CLIP_RETRYABLE_FAILURES.includes(reason) && submittedAtMs !== undefined;
    const until = retryable ? iso(submittedAtMs + this.host.timings.lateGiveUpMs) : undefined;
    return this.commit({ ...this.base(model, decided), outcome: { status: "failed", reason, ...(until === undefined ? {} : { retryDownloadUntil: until }) } });
  }

  /** The record is the commit; the journal goes once it stands. A journal that cannot be removed then is the next start's to remove. */
  private async commit(record: ClipRecord): Promise<JobOutcome> {
    const { candidate, host } = this;
    await writeClipRecord(candidate.clipsDir, record);
    try {
      await removeJournal(candidate.clipsDir, candidate.clipId);
    } catch (error) {
      host.log(`[clip] ${candidate.clipId}: the record stands, but its journal could not be removed (${error instanceof Error ? error.name : typeof error}); the next start removes it`);
    }
    return "recorded";
  }
}

// ---------- a poster that was lost ----------

/** A ready record whose poster file is missing: the poster is drawn again from the kept mp4 with the clip's own colour, under a temp name and renamed. The record is not rewritten. */
async function repaintPoster(host: ClipRecoveryHost, clipsDir: string, clipId: string, job: Job): Promise<JobOutcome> {
  const media = { ...REAL_MEDIA, ...host.media };
  const read = await readClipRecord(clipsDir, clipId);
  if (read.kind !== "record" || read.record.outcome.status !== "ready") return "recorded";
  const { record } = read;
  const clipPath = join(clipsDir, record.outcome.status === "ready" ? record.outcome.file : "");
  const temp = posterTempPath(clipsDir, clipId);
  try {
    const judged = await media.validateClipFile(clipPath, record.request.seconds);
    if (!judged.ok) {
      host.log(`[clip] ${clipId}: the kept file is not a clip any more (${judged.reason}); its poster is not drawn again`);
      return "recorded";
    }
    await media.makePoster({ clipPath, colour: judged.clip.colour, log: host.log, outPath: temp, signal: job.signal });
    await fsyncFile(temp);
    await renameWithRetry(temp, posterPath(clipsDir, clipId));
    await fsyncDir(clipsDir);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    if (job.signal.aborted) return "interrupted";
    host.log(`[clip] ${clipId}: the poster could not be drawn again (${error instanceof Error ? error.name : typeof error}); the next start tries again`);
  }
  return "recorded";
}
