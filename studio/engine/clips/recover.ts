import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { PROTOCOL_VERSION, type ClipAttemptModel, type ClipFace, type ClipFailReason, type ClipRequest, type EngineError } from "../../shared/engine";
import { CLIP_RETRYABLE_FAILURES } from "../../shared/engine/clips";
import type { UnsequencedEvent } from "../../shared/engine/events";
import { EngineFailure } from "../engineFailure";
import type { WorkerFaceGate } from "../face/worker/workerGate";
import type { ClipJobEnd, ClipJobFacts, JobRegistry } from "../jobs";
import { hasErrorCode, readFolderNames, isTempName } from "../library/durableFs";
import { isLibraryId } from "../library/ids";
import type { OpenRouterClient } from "../openrouter/types";
import { downloadClip, type ClipDownload } from "./download";
import { checkClipFace } from "./faceCheck";
import type { ClipFaceRole } from "./faceRole";
import { makePoster } from "./frames";
import { holdsAfterRestart, holdUntilForTerminal, type ClipHolds } from "./holds";
import { clipAttemptId, parseClipAttemptId, summarizeJournal, type JournalAttempt, type JournalSummary } from "./journal";
import { openClipReserveMicros, type ClipReserveLedger } from "./openReserve";
import { clipFaceOf, drawPoster, readyOutcomeOf } from "./ready";
import type { ClipJournalLine, ClipRecord } from "./schemas";
import { clipFilePath, clipsDirOf, journalOf, readClipRecord, removeJournal, writeClipRecord } from "./store";
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
export interface RecoveryLedger extends ClipReserveLedger {
  openReserves(): readonly { attemptId: string; at: string }[];
  reserveOf(attemptId: string): { attemptId: string; at: string; worstMicros: number } | undefined;
  /** How an attempt was closed: a settle (with what it settled and whether that was an estimate) or a release. Read-only, like the rest: recovery never writes a line. */
  closeOf(attemptId: string): { readonly type: "settle"; readonly costMicros: number; readonly estimated: boolean } | { readonly type: "release" } | undefined;
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
  readonly holds: Pick<ClipHolds, "hold" | "untilOf">;
  /**
   * The clip's lock, the one the clip records use (delete, markSeen, retry): held from re-reading a clip's journal to registering its job, so a concurrent `clips.delete` (journal, then record,
   * then media) cannot land between the scan and the act and have the clip brought back.
   */
  readonly withClipLock: <T>(clipId: string, work: () => Promise<T>) => Promise<T>;
  /** The library is still the live one: a recovery that was slow to start (a switch away and back) starts nothing for a library that is no longer live. */
  readonly isCurrent: () => boolean;
  /** This process reserved the attempt itself (its hold is the registry's, taken when it was reserved). */
  readonly isOwn: (attemptId: string) => boolean;
  /** Fires when the engine stops: every recovery job stops waiting. */
  readonly signal: AbortSignal;
  readonly ledger: () => RecoveryLedger | null;
  readonly jobs: Pick<JobRegistry, "startClip" | "clipPhase" | "finishClip">;
  readonly emit: (event: UnsequencedEvent) => void;
  /**
   * The clip service's per-clip guard, ONE set with the create job's and the records' (`begin`), so a delete or a retry of a clip a recovery works on is `job-running`. `enter` does not count as
   * library work: a switch stops a recovery instead of waiting for it. Null: a job already works on that clip.
   */
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
  /** `local`: the journal says the file was fetched and checked (`downloaded`), so the kept `<clipId>.mp4` is tried first, with no network and at any age. */
  | { kind: "download"; attemptId: string; model: ClipAttemptModel; providerJobId: string; submittedAtMs: number; local?: { sha256: string; bytes: number } };

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

/**
 * Why an attempt the journal says ended is recorded as it is. An `ended` line with NO `submitted` line is a POST the provider refused (VR item 2): the reserve was settled 0 before the line was written,
 * so the record says what the live path did (a moderation refusal is `refused-free`; another 4xx names its reason, `bad-request` when the line has none), never `lost` and never «settled at worst».
 */
function reasonOfAttempt(attempt: JournalAttempt, ended: EndedLine): ClipFailReason {
  if (attempt.submittedAt !== undefined) return reasonOfEnded(ended);
  if (ended.status === "refused") return "refused-free";
  if (ended.status === "failed") return ended.failReason ?? "bad-request";
  return reasonOfEnded(ended);
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
    // A file the journal says was fetched and checked may be on disk: it is tried first, whatever the age (it costs no network). Without that line the 60 min rule is all there is.
    const local = summary.downloaded === null ? undefined : { sha256: summary.downloaded.sha256, bytes: summary.downloaded.bytes };
    if (local === undefined && nowMs >= submittedAtMs + timings.lateGiveUpMs) return { kind: "fail", reason: "download-expired", model };
    return { kind: "download", attemptId: completed.attemptId, model, providerJobId: completed.providerJobId, submittedAtMs, ...(local === undefined ? {} : { local }) };
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
  if (lastUnsent !== undefined) {
    // An attempt whose POST was refused has an `ended` line and its reserve is already closed: it is not unsent.
    const unsentAttempt = summary.attempts.find((a) => a.attemptId === lastUnsent);
    if (unsentAttempt?.ended === undefined) return { kind: "fail", reason: "lost", model: modelOf({ attemptId: lastUnsent }, request) };
    return { kind: "fail", reason: reasonOfAttempt(unsentAttempt, unsentAttempt.ended), model: modelOf(unsentAttempt, request) };
  }

  // Every attempt the journal names ended in a failure: the clip says how the last one did.
  const last = summary.attempts.findLast((a) => a.ended !== undefined);
  if (last?.ended !== undefined) return { kind: "fail", reason: reasonOfAttempt(last, last.ended), model: modelOf(last, request) };

  return { kind: "fail", reason: "lost", model: request.model };
}

function sha256Of(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

// ---------- the holds of a restart, from the ledger alone ----------

/**
 * The holds for open reserves of clip attempts when no journal of theirs is in view (no library is open, or the clip belongs to another library): nothing says how far the render got, so each
 * is held 60 min from its reserve line's `at` (the longest an attempt is polled). Entries whose time has passed are left out. Pure.
 */
export function holdsFromLedger(reserves: readonly { attemptId: string; at: string }[], nowMs: number, timings: ClipTimings): Map<string, number> {
  const until = new Map<string, number>();
  for (const reserve of reserves) {
    const untilMs = Date.parse(reserve.at) + timings.holdSubmittedMs;
    if (!Number.isNaN(untilMs) && untilMs > nowMs) until.set(reserve.attemptId, untilMs);
  }
  return until;
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
        // Only a ready clip has a poster to draw again.
        try {
          const record = await readClipRecord(clipsDir, p.clipId);
          if (record.kind === "record" && record.record.outcome.status === "ready") repaints.push({ avatarId: avatar.id, clipsDir, clipId: p.clipId });
        } catch (error) {
          host.log(`[clip] the record of clip ${p.clipId} could not be read (${error instanceof Error ? error.name : typeof error}); its poster is not looked at`);
        }
      }
    }
  }

  // ----- 2. the holds of a restart, before anything slower. They only EXTEND what the registry holds: a later open of a library never shortens an entry (an earlier open, or the start, may know more). -----
  // A clip with a journal in view is held by the journal's rules (`holdsAfterRestart`); an open reserve of a clip with none in view (its journal is in a library that is not open, or is gone) may
  // be a render still going, so it is held 60 min from the reserve line's `at`. A reserve this process made itself keeps the hold it took.
  const openClip = (ledger?.openReserves() ?? []).filter((r) => parseClipAttemptId(r.attemptId) !== null && !host.isOwn(r.attemptId));
  const inView = new Set(candidates.map((c) => c.clipId));
  const seen = openClip.filter((r) => inView.has(parseClipAttemptId(r.attemptId)?.clipId ?? ""));
  const unseen = openClip.filter((r) => !inView.has(parseClipAttemptId(r.attemptId)?.clipId ?? ""));
  const extend = (attemptId: string, untilMs: number): void => {
    if (untilMs > (host.holds.untilOf(attemptId) ?? 0)) host.holds.hold(attemptId, untilMs);
  };
  const journal = candidates.flatMap((c) => c.lines);
  for (const [attemptId, untilMs] of holdsAfterRestart({ reserves: seen.map((r) => ({ attemptId: r.attemptId, at: r.at })), journal, nowMs, timings: host.timings })) extend(attemptId, untilMs);
  for (const [attemptId, untilMs] of holdsFromLedger(unseen, nowMs, host.timings)) extend(attemptId, untilMs);

  // ----- 3. the sweep, then the stale journals -----
  // Decided here, after the folders were read: a `clips.create` that arrived meanwhile has a first-frame temp on disk, and its job counts as active.
  const sweepTemps = !host.work.anyActive();
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
    // A library that was switched away from while this recovery waited (A, then B, then A again) is not this call's to recover any more.
    if (!host.isCurrent()) break;
    // Under the clip's lock the journal and the record are read AGAIN, and the job is registered before the lock goes: a delete (journal, record, media) that ran since the scan has taken the
    // journal away, a record written since means the clip is done. Either way nothing is brought back.
    // The per-clip guard is taken first, under the lock, so nothing else can start a job on this journal between the re-read and the job (a library switched away and back included).
    let started: { running: Promise<void> } | null = null;
    try {
      started = await host.withClipLock(candidate.clipId, async () => {
        // The lock may have been waited for (a delete on a slow disk): a library switched away meanwhile is not this call's to act on.
        if (!host.isCurrent()) return null;
        const leave = host.work.enter(candidate.clipId);
        if (leave === null) return null;
        let handedOver = false;
        try {
          const lines = await journalOf(candidate.clipsDir, candidate.clipId).read();
          if (lines.length === 0) return null;
          const record = await readClipRecord(candidate.clipsDir, candidate.clipId);
          if (record.kind !== "missing") {
            if (record.kind === "record") await removeJournal(candidate.clipsDir, candidate.clipId).catch(() => undefined);
            return null;
          }
          const fresh: Candidate = { ...candidate, lines };
          const summary = summarizeJournal(lines);
          const reservedAttempts = new Set([1, 2].map((n) => clipAttemptId(candidate.clipId, n as 1 | 2)).filter((id) => ledger?.reserveOf(id) !== undefined));
          const plan = planRecovery({ summary, recordExists: false, reservedAttempts, nowMs, timings: host.timings });
          if (plan.kind === "unreadable-journal" || plan.kind === "stale-journal") {
            host.log(`[clip] the journal of clip ${candidate.clipId} has no \`requested\` line; recovery leaves it`);
            return null;
          }
          handedOver = true;
          // Wrapped: a promise returned from the lock's work would be awaited with it, and the lock would be held for the whole job.
          return { running: startRecoveryJob(host, candidate.avatarId, candidate.clipId, factsOf(summary), leave, (job) => new Recovery(host, library, fresh, summary, reservedAttempts, plan, job).run()) };
        } finally {
          if (!handedOver) leave();
        }
      });
    } catch (error) {
      // An I/O error under one clip's lock costs that clip its recovery this time (its journal stays for the next start), not the other clips theirs.
      host.log(`[clip] clip ${candidate.clipId} could not be looked at for recovery (${error instanceof Error ? error.name : typeof error}); its journal is kept`);
      continue;
    }
    if (started !== null) jobs.push(started.running);
  }
  for (const repaint of repaints) {
    if (!host.isCurrent()) break;
    // As a job above: under the clip's lock the record is read again and the job is registered before the lock goes, so a delete that ran since the scan (or runs now) is not met by a
    // poster drawn for a clip that is gone.
    let started: { running: Promise<void> } | null = null;
    try {
      started = await host.withClipLock(repaint.clipId, async () => {
        if (!host.isCurrent()) return null;
        const leave = host.work.enter(repaint.clipId);
        if (leave === null) return null;
        let handedOver = false;
        try {
          const read = await readClipRecord(repaint.clipsDir, repaint.clipId);
          if (read.kind !== "record" || read.record.outcome.status !== "ready") return null;
          handedOver = true;
          return { running: startRecoveryJob(host, repaint.avatarId, repaint.clipId, undefined, leave, (job) => repaintPoster(host, repaint.clipsDir, repaint.clipId, job)) };
        } finally {
          if (!handedOver) leave();
        }
      });
    } catch (error) {
      host.log(`[clip] the record of clip ${repaint.clipId} could not be read again (${error instanceof Error ? error.name : typeof error}); its poster is not drawn this time`);
      continue;
    }
    if (started !== null) jobs.push(started.running);
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

/** The facts a recovery job carries, from the journal's `requested` line (the plan checked it is there): the same the first job announced. */
function factsOf(summary: JournalSummary): ClipJobFacts | undefined {
  const { requested } = summary;
  if (requested === null) return undefined;
  return { photoId: requested.photoId, request: requested.request, motion: { source: requested.motion.source, label: requested.motion.label }, acceptedWorstMicros: requested.acceptedWorstMicros };
}

/** Registers the job, runs `work`, and announces its end. Null when a job already works on the clip. Never rejects. */
function startRecoveryJob(host: ClipRecoveryHost, avatarId: string, clipId: string, facts: ClipJobFacts | undefined, leave: () => void, work: (job: Job) => Promise<JobOutcome>): Promise<void> {
  const jobId = host.newId();
  const ref = { kind: "clip" as const, jobId, avatarId, clipId };
  const cancel = host.jobs.startClip(jobId, { avatarId, clipId, ...(facts === undefined ? {} : { facts }) }, "recovering");
  const job: Job = {
    jobId,
    avatarId,
    clipId,
    signal: eitherSignal(cancel, host.signal),
    phase: (update) => {
      // What the ledger holds open for the clip, as it stands at this moment: the earlier process's reserve, until the owner's reconcile closes it.
      const progress = host.jobs.clipPhase(jobId, { ...update, openReserveMicros: openClipReserveMicros(host.ledger(), clipId) });
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

/** How often a recovery that waits for the key looks for it: the key is a local value main sends a moment after the engine starts, so the look is cheap and short. */
const KEY_LOOK_MS = 2_000;

type PolledStatus =Extract<Awaited<ReturnType<RecoveryClient["pollVideo"]>>, { kind: "status" }>;
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
      await host.sleep(Math.min(host.timings.pollMs, KEY_LOOK_MS, remaining), job.signal);
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
    return this.recordFailure(outcome === "refused" ? this.refusalReason(plan.attemptId) : "provider-error", plan.model, { attemptId: plan.attemptId, outcome });
  }

  /**
   * The reason of a content refusal. When the old process already settled the attempt (the proof passed and `settle` was written, then it stopped before the journal's `ended` line), the reason comes from
   * that settle: 0 is `refused-free`, an estimate is `refused-unknown`, a bill is `refused-paid`. With the reserve still open, nothing proved it free and the reconcile will settle it at worst. Read-only (I5.49).
   */
  private refusalReason(attemptId: string): ClipFailReason {
    const close = this.host.ledger()?.closeOf(attemptId);
    if (close?.type !== "settle") return "refused-unknown";
    if (close.estimated) return "refused-unknown";
    return close.costMicros === 0 ? "refused-free" : "refused-paid";
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

  /**
   * The kept `<clipId>.mp4`, when it is the file the journal's `downloaded` line describes (its size and sha256) and still validates: then the clip is finished with no network. Any other state of
   * the file (missing, another size or hash, no longer a clip) is null, and the 60 min rule decides.
   */
  private async keptFile(local: { sha256: string; bytes: number }): Promise<Extract<ClipDownload, { kind: "saved" }> | null> {
    const { candidate, host } = this;
    const path = clipFilePath(candidate.clipsDir, candidate.clipId);
    // Only «no file», «another size or hash» and «not a clip any more» decide. Any other error (EBUSY, EMFILE: the disk, not the file) throws: the job fails with its journal kept for the next start.
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return null;
      throw error;
    }
    if (size !== local.bytes) return null;
    if ((await sha256Of(path)) !== local.sha256) return null;
    const judged = await this.media.validateClipFile(path, this.requested.request.seconds);
    if (!judged.ok) {
      // `unreadable` is also what a failed open is called: the file was just read whole, so one that cannot be opened now is the disk's trouble, not a verdict.
      if (judged.reason === "unreadable") await (await open(path, "r")).close();
      host.log(`[clip] ${candidate.clipId}: the kept file no longer validates (${judged.reason})`);
      return null;
    }
    return { kind: "saved", path, sha256: local.sha256, clip: judged.clip };
  }

  private async fetchAndRecord(
    plan: { attemptId: string; model: ClipAttemptModel; providerJobId: string; submittedAtMs: number; local?: { sha256: string; bytes: number } },
    providerCostMicros: number | null,
    known?: RecoveryClient,
  ): Promise<JobOutcome> {
    const { host, job, candidate } = this;
    const request = this.requested.request;
    const giveUpAtMs = plan.submittedAtMs + host.timings.lateGiveUpMs;
    const earlier = this.summary.attempts.find((a) => a.attemptId === plan.attemptId)?.ended;
    const cost = providerCostMicros ?? earlier?.providerCostMicros ?? null;
    const completed = { attemptId: plan.attemptId, outcome: "completed" as const, ...(cost === null ? {} : { providerCostMicros: cost }) };

    // The process stopped after the file was fetched and checked (the quit while «Проверяем лицо» or «Сохраняем» does not wait): the paid file is on disk, and it is finished from there.
    if (plan.local !== undefined) {
      const kept = await this.keptFile(plan.local);
      if (job.signal.aborted) return "interrupted";
      if (kept !== null) return this.finish(plan, completed, kept);
      if (host.clock() >= giveUpAtMs) return this.recordFailure("download-expired", plan.model, completed);
    }

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
    // The paid file is in place: the journal says so BEFORE a stop is looked at, so a stop in this window leaves `downloaded` beside the mp4 (the next start finishes it from disk).
    if (download.kind === "saved") await this.journal.downloaded({ sha256: download.sha256, bytes: download.clip.bytes, at: iso(host.clock()) });
    if (job.signal.aborted) return "interrupted";
    if (download.kind === "failed") {
      host.log(`[clip] ${candidate.clipId}: the download failed (${download.reason})`);
      return this.recordFailure(download.reason, plan.model, completed, plan.submittedAtMs);
    }
    return this.finish(plan, completed, download);
  }

  /** From a validated file on disk to the record: the poster, the face check, the commit. */
  private async finish(
    plan: { model: ClipAttemptModel; submittedAtMs: number },
    completed: Parameters<Recovery["attempts"]>[0],
    download: Extract<ClipDownload, { kind: "saved" }>,
  ): Promise<JobOutcome> {
    const { job, candidate } = this;
    job.phase({ phase: "checking", model: plan.model, done: 2 });
    await this.poster(download.path, download.clip.colour);
    const face = await this.face(download);
    if (job.signal.aborted) return "interrupted";

    job.phase({ phase: "saving", model: plan.model, done: 3 });
    return this.commit({ ...this.base(plan.model, completed), outcome: readyOutcomeOf(candidate.clipId, download, face) });
  }

  /** The poster (`drawPoster`). A poster that cannot be drawn costs the paid clip nothing, whatever ffmpeg said: it is kept without one and the next start draws it again. */
  private async poster(clipPath: string, colour: ClipColour): Promise<void> {
    const { host, candidate } = this;
    const drawn = await drawPoster({ makePoster: (options) => this.media.makePoster(options), clipPath, colour, clipsDir: candidate.clipsDir, clipId: candidate.clipId, signal: this.job.signal, log: host.log });
    if (!drawn.drawn) host.log(`[clip] ${candidate.clipId}: the poster could not be drawn (${drawn.error instanceof Error ? drawn.error.name : typeof drawn.error}); the clip is kept without one`);
  }

  /** The face check (`clipFaceOf`): the role of the clip's photo as it is now (null when the photo is gone), the gate unless it is broken, the master's embedding only for a judged clip. */
  private async face(download: Extract<ClipDownload, { kind: "saved" }>): Promise<ClipFace> {
    const { host, candidate, job } = this;
    const role = await host.faceRoleOf(this.requested.photoId);
    const gate = host.faceGate();
    return clipFaceOf({
      role,
      gate: gate === null || gate.isBroken() ? null : gate,
      masterEmbedding: () => host.masterEmbedding(candidate.avatarId, job.signal),
      check: (options) => this.media.checkClipFace(options),
      clipPath: download.path,
      colour: download.clip.colour,
      durationMs: download.clip.durationMs,
      scratchDir: candidate.clipsDir,
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
  const failed = (error: unknown): JobOutcome => {
    if (job.signal.aborted) return "interrupted";
    host.log(`[clip] ${clipId}: the poster could not be drawn again (${error instanceof Error ? error.name : typeof error}); the next start tries again`);
    return "recorded";
  };
  let judged: Awaited<ReturnType<RecoveryMedia["validateClipFile"]>>;
  try {
    judged = await media.validateClipFile(clipPath, record.request.seconds);
  } catch (error) {
    return failed(error);
  }
  if (!judged.ok) {
    host.log(`[clip] ${clipId}: the kept file is not a clip any more (${judged.reason}); its poster is not drawn again`);
    return "recorded";
  }
  const drawn = await drawPoster({ makePoster: (options) => media.makePoster(options), clipPath, colour: judged.clip.colour, clipsDir, clipId, signal: job.signal, log: host.log });
  return drawn.drawn ? "recorded" : failed(drawn.error);
}
