import {
  PROTOCOL_VERSION,
  type CategoryRef,
  type EngineError,
  type Estimate,
  type SceneSetView,
  type ScenesEditResult,
  type ScenesGetResult,
  type SceneWriteTarget,
  type UnsequencedEvent,
} from "../../shared/engine";
import { EngineFailure } from "../engineFailure";
import type { StoredCategory } from "../library/categories";
import type { AvatarManifest, Library } from "../library";
import { SceneSetError, type SceneSetGuard, type StoredSceneSet } from "../library/sceneSets";
import type { Budget } from "../money/budget";
import { scopeKey } from "../money/budget";
import type { PricedBook, PriceModels } from "../money/priceCache";
import type { LedgerView } from "../runs/journal";
import type { NetworkPool, Release } from "../runs/pools";
import type { OpenRouterClient } from "../openrouter/types";
import { POOLS, type Pool } from "../scenes";
import { poolOf } from "../scenes/poolGen";
import { snapshotOf } from "../library/categories";
import type { JobRegistry, ScenesJobEnd } from "../jobs";
import { pendingChunks } from "./chunks";
import { planSceneSet } from "./compose";
import { applyEdit, type EditOutcome } from "./edit";
import { composeEstimate, sceneSetPriceModels, writeEstimate } from "./estimate";
import { beginWrite, withChunkGivenUp, withChunkWritten, withOutcome, withWriteFinished, withWriteStopped } from "./mutations";
import { buildSceneSetView, currentTally } from "./view";
import { runSceneWrite, type SceneWriteEnd } from "./writeJob";

// CS.4a: the scene sets' commands and their writer job. The engine owns the money and the library; this owns the set's life, and talks to the engine
// through `SceneSetServiceDeps` (so engine.ts keeps only the wiring of its commands).
//
// Concurrency, as one rule set:
//  - One paid job per avatar at a time: a compose and a «Дописать» CLAIM the avatar (`claimAvatar`, shared with runs, candidates and the delete), so a
//    scenes job and a photo run, or two scenes jobs, refuse one another (IN_FLIGHT, nothing reserved).
//  - A scenes job counts in `paidStart` (the engine's `#paidCommands`) from before its first await to its end: a library switch and a reconcile are refused meanwhile.
//  - A set is live from the moment its compose or write passes the claim (before any await of its own) to the end of its job. A free edit, a discard and
//    another write ask the set's own lock-protected guard, which looks at it: IN_FLIGHT. Edits are refused only for the set whose job runs.
//  - Every change of the file goes through the store: under the set's lock, on the revision the change was made on (SCENES_CHANGED when it moved).

export interface SceneSetServiceDeps {
  newId: () => string;
  /** The open library for a read; null when none is open. */
  currentLibrary: () => Library | null;
  /** The live library for a write (a library switch waits for `work`), refusing like every write does. */
  withLiveLibrary: <T>(work: (library: Library) => Promise<T>) => Promise<T>;
  /** The live library for a paid command, counted by the caller's own `paidStart`. */
  liveLibrary: () => Promise<Library>;
  usableKey: (purpose: string) => string;
  paidBudget: () => Budget;
  /** The ledger as the sets read it; null when it cannot be read. */
  ledger: () => LedgerView | null;
  runnableAvatar: (library: Library | null, avatarId: string) => AvatarManifest;
  assertAvatarOnDisk: (library: Library, avatarId: string) => Promise<void>;
  customCategories: (library: Library | null, categories: readonly CategoryRef[]) => Promise<StoredCategory[]>;
  /** The settings' text model. */
  textModel: () => string;
  prices: (models: PriceModels) => Promise<PricedBook>;
  checkAccepted: (worstMicros: number, acceptedWorstMicros: number) => void;
  checkMonthlyRoom: (budget: Budget, worstMicros: number) => void;
  claimAvatar: (avatarId: string, detail: string) => void;
  releaseAvatar: (avatarId: string) => void;
  /** The engine's paid-commands counter: a library switch is refused while it is above 0. */
  paidStart: () => void;
  paidEnd: () => void;
  setCap: (key: string, micros: number) => void;
  clearCap: (key: string) => void;
  openRouter: (key: string) => OpenRouterClient;
  networkPool: NetworkPool;
  jobs: JobRegistry;
  emit: (event: UnsequencedEvent) => void;
  emitMoney: () => void;
  markKeyRejected: (key: string) => void;
  recentPairs: (library: Library, avatarId: string) => Promise<readonly { location: string; outfit: string }[]>;
  errorOf: (error: unknown) => EngineError;
  warn: (line: string) => void;
}

/** A set whose job runs (or is about to): what the view's `write` and its in-flight attempts come from. */
interface LiveJob {
  jobId: string;
  avatarId: string;
  kind: "compose" | "unwritten";
  count: number;
  /** The attempt ids of requests at the model right now. */
  readonly inFlight: Set<string>;
}

function detailOfError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

export class SceneSetService {
  readonly #deps: SceneSetServiceDeps;
  readonly #live = new Map<string, LiveJob>();

  constructor(deps: SceneSetServiceDeps) {
    this.#deps = deps;
  }

  // ---------- reading ----------

  /** The set as the windows see it: built from its file, the ledger and what is running. */
  async #view(library: Library, set: StoredSceneSet): Promise<SceneSetView> {
    const live = this.#live.get(set.sceneSetId);
    return buildSceneSetView(set, {
      ledger: this.#deps.ledger(),
      inFlight: live?.inFlight ?? new Set<string>(),
      live: live === undefined ? null : { kind: live.kind, count: live.count },
      used: await library.runFolderExists(set.runId),
    });
  }

  async #announce(library: Library, set: StoredSceneSet): Promise<void> {
    try {
      const sceneSet = await this.#view(library, set);
      this.#deps.emit({ v: PROTOCOL_VERSION, id: this.#deps.newId(), kind: "event", type: "scenes.changed", payload: { change: "upserted", sceneSet } });
    } catch (error) {
      this.#deps.warn(`studio engine: scene set ${set.sceneSetId} changed but could not be announced (${detailOfError(error)})`);
    }
  }

  /** The set with this id, in whichever avatar's folder it lies; NOT_FOUND when none of them has it. */
  async #find(library: Library, sceneSetId: string): Promise<{ set: StoredSceneSet; avatarId: string }> {
    for (const manifest of library.listAvatars()) {
      const set = await library.sceneSets.get(manifest.id, sceneSetId).catch(() => null);
      if (set !== null) return { set, avatarId: manifest.id };
    }
    throw new EngineFailure({ code: "NOT_FOUND", detail: `no scene set ${sceneSetId} in the open library` });
  }

  #needLibrary(): Library {
    const library = this.#deps.currentLibrary();
    if (library === null) throw new EngineFailure({ code: "LIBRARY_UNAVAILABLE", detail: "no library is open: its folder is missing or unreadable; choose one in Settings" });
    return library;
  }

  /** The avatar's newest set (open, or used and read-only), and how many set files could not be read. */
  async get(avatarId: string): Promise<ScenesGetResult> {
    const library = this.#needLibrary();
    if (library.getAvatar(avatarId) === undefined) throw new EngineFailure({ code: "NOT_FOUND", detail: `no avatar ${avatarId} in the open library` });
    const { sets, unreadable } = await library.sceneSets.list(avatarId);
    // The open set (not yet used) is the one to show; with none open, the newest used one, read-only. At most one set is open, so this is the newest in practice.
    let shown = sets.at(-1);
    for (const set of [...sets].reverse()) {
      if (!(await library.runFolderExists(set.runId))) {
        shown = set;
        break;
      }
    }
    return { sceneSet: shown === undefined ? null : await this.#view(library, shown), unreadable };
  }

  /** What composing `count` scenes could cost; NOT_FOUND for an avatar that cannot get photos or a custom category the library lacks, before any price is fetched. */
  async estimateCompose(request: { avatarId: string; count: number; categories: readonly CategoryRef[] }): Promise<Estimate> {
    const library = this.#deps.currentLibrary();
    this.#deps.runnableAvatar(library, request.avatarId);
    await this.#deps.customCategories(library, request.categories);
    const textModel = this.#deps.textModel();
    return composeEstimate(await this.#deps.prices(sceneSetPriceModels(textModel)), textModel, request.count);
  }

  /** What «Дописать» could cost now: the chunks still to write, each at the attempts it has left. */
  async estimateWrite(sceneSetId: string, _target: SceneWriteTarget): Promise<Estimate> {
    const library = this.#needLibrary();
    const { set } = await this.#find(library, sceneSetId);
    return writeEstimate(await this.#deps.prices(sceneSetPriceModels(set.models.text)), set, this.#deps.ledger());
  }

  // ---------- refusals shared by the commands ----------

  #failureOf(error: unknown): never {
    if (error instanceof SceneSetError) {
      if (error.code === "stale") throw new EngineFailure({ code: "SCENES_CHANGED", detail: error.message });
      if (error.code === "not-found") throw new EngineFailure({ code: "NOT_FOUND", detail: error.message });
      throw new EngineFailure({ code: "INTERNAL", detail: error.message });
    }
    throw error;
  }

  /** Under the set's lock: the set's job runs (IN_FLIGHT), or its run's folder exists (the set is used: VALIDATION). */
  #guard(library: Library): SceneSetGuard {
    return async (current) => {
      if (this.#live.has(current.sceneSetId)) throw new EngineFailure({ code: "IN_FLIGHT", detail: `scene set ${current.sceneSetId} is being written; change it when that ends (or cancel it)` });
      if (await library.runFolderExists(current.runId)) throw new EngineFailure({ code: "VALIDATION", detail: `scene set ${current.sceneSetId} is used by run ${current.runId} and is read-only` });
    };
  }

  // ---------- free changes ----------

  async edit(payload: { sceneSetId: string; revision: number; op: Parameters<typeof applyEdit>[1] }): Promise<ScenesEditResult> {
    return this.#deps.withLiveLibrary(async (library) => {
      const { avatarId } = await this.#find(library, payload.sceneSetId);
      let outcome: EditOutcome | null = null;
      let updated: StoredSceneSet;
      try {
        updated = await library.sceneSets.update(
          avatarId,
          payload.sceneSetId,
          (current) => {
            outcome = applyEdit(current, payload.op);
            return outcome.kind === "changed" ? outcome.set : null;
          },
          { expectedRevision: payload.revision, guard: this.#guard(library) },
        );
      } catch (error) {
        return this.#failureOf(error);
      }
      const result = outcome as EditOutcome | null;
      if (result === null) throw new EngineFailure({ code: "INTERNAL", detail: "the edit was not applied" });
      if (result.kind === "problem") return { problem: result.problem };
      if (result.kind === "invalid") throw new EngineFailure({ code: "VALIDATION", detail: result.detail });
      if (result.kind === "changed") await this.#announce(library, updated);
      return { sceneSet: await this.#view(library, updated) };
    });
  }

  async discard(sceneSetId: string): Promise<void> {
    await this.#deps.withLiveLibrary(async (library) => {
      const { avatarId } = await this.#find(library, sceneSetId);
      try {
        await library.sceneSets.remove(avatarId, sceneSetId, { guard: this.#guard(library) });
      } catch (error) {
        return this.#failureOf(error);
      }
      this.#deps.emit({ v: PROTOCOL_VERSION, id: this.#deps.newId(), kind: "event", type: "scenes.changed", payload: { change: "removed", sceneSetId, avatarId } });
    });
  }

  /** Aborts the set's job when one runs (its request in flight keeps its reserve open until reconciled); ok for a set whose job is not running. */
  async cancel(sceneSetId: string): Promise<void> {
    const library = this.#needLibrary();
    await this.#find(library, sceneSetId);
    const jobId = this.#deps.jobs.runningJobOfSet(sceneSetId);
    if (jobId !== null) this.#deps.jobs.cancel(jobId);
  }

  // ---------- compose ----------

  /**
   * Plans a set and writes it, with its run id and every chunk's attempt ids, BEFORE the first call, then launches its writer job. Checked like a run's
   * start minus the image side (no master, no gates: nothing visual is paid yet). Count 0 is an empty set and costs nothing: no key, no job.
   */
  async compose(payload: { avatarId: string; count: number; categories: readonly CategoryRef[]; poses: { profile: boolean; back: boolean }; acceptedWorstMicros: number }): Promise<{ sceneSetId: string; jobId: string | null }> {
    const { avatarId, count, categories, poses } = payload;
    const free = count === 0;
    const deps = this.#deps;
    // Claimed before the first await, like a run's start: the avatar's one paid job at a time, and a library switch refused from here on.
    deps.claimAvatar(avatarId, "a photo run or another job is already changing this avatar; wait for it to finish");
    if (!free) deps.paidStart();
    const sceneSetId = deps.newId();
    let launched = false;
    try {
      const key = free ? null : deps.usableKey("compose scenes");
      const budget = free ? null : deps.paidBudget();
      const library = await deps.liveLibrary();
      const manifest = deps.runnableAvatar(library, avatarId);
      await deps.assertAvatarOnDisk(library, avatarId);
      const custom = await deps.customCategories(library, categories);
      // One open set per avatar: a set is open until its run starts (its folder exists) or it is discarded.
      const existing = await library.sceneSets.list(avatarId);
      for (const set of existing.sets) {
        if (!(await library.runFolderExists(set.runId))) {
          throw new EngineFailure({ code: "VALIDATION", detail: `avatar ${manifest.id} already has an open scene set; discard it or use its run first` });
        }
      }
      const textModel = deps.textModel();
      let priced: PricedBook | null = null;
      let worstMicros = 0;
      if (!free && budget !== null) {
        priced = await deps.prices(sceneSetPriceModels(textModel));
        worstMicros = composeEstimate(priced, textModel, count).worstMicros;
        deps.checkAccepted(worstMicros, payload.acceptedWorstMicros);
        deps.checkMonthlyRoom(budget, worstMicros);
      }
      const jobId = free ? null : deps.newId();
      const recent = await deps.recentPairs(library, avatarId);
      const planned = planSceneSet({
        sceneSetId,
        avatarId,
        runId: deps.newId(),
        jobId: jobId ?? "none",
        count,
        categories,
        poses,
        pools: { ...POOLS, ...Object.fromEntries(custom.map((c): [string, Pool] => [c.categoryId, poolOf(c.pool)])) },
        snapshots: custom.map(snapshotOf),
        recentPairs: recent,
        textModel,
      });
      // Live from here: an edit or a discard cannot slip in between the file and the job.
      if (jobId !== null) this.#live.set(sceneSetId, { jobId, avatarId, kind: "compose", count: 0, inFlight: new Set() });
      let stored: StoredSceneSet;
      try {
        stored = await library.sceneSets.create(planned);
      } catch (error) {
        this.#live.delete(sceneSetId);
        throw new EngineFailure({ code: "INTERNAL", detail: `nothing was sent: the scene set could not be written (${detailOfError(error)})` });
      }
      if (jobId === null || key === null || budget === null || priced === null) {
        await this.#announce(library, stored);
        return { sceneSetId, jobId: null };
      }
      // The first announcement already tells how many scenes the job will write, as scenes.get does.
      this.#setCount(stored, budget);
      await this.#announce(library, stored);
      this.#launch({ jobId, set: stored, kind: "compose", key, budget, library, priced, capMicros: worstMicros });
      launched = true;
      return { sceneSetId, jobId };
    } finally {
      if (!launched) {
        this.#live.delete(sceneSetId);
        if (!free) deps.paidEnd();
        deps.releaseAvatar(avatarId);
      }
    }
  }

  // ---------- «Дописать» ----------

  /**
   * Writes the scenes still waiting, chunk by chunk, from each chunk's next unused id and within the attempts it has left across ALL jobs. The write is
   * recorded in the set BEFORE its first call, on the revision the window showed (SCENES_CHANGED when it moved, even while the prices were awaited).
   */
  async write(payload: { sceneSetId: string; revision: number; target: SceneWriteTarget; acceptedWorstMicros: number }): Promise<{ jobId: string }> {
    const { sceneSetId, revision } = payload;
    const deps = this.#deps;
    // Counted before the first await (the set's avatar is only known once it is found): a library switch is refused from here on.
    deps.paidStart();
    let launched = false;
    let claimed: string | null = null;
    /** The live entry THIS call made: a refused write must never delete another job's. */
    let mine: LiveJob | null = null;
    try {
      // A set whose job runs refuses before anything is read, claimed or written.
      if (this.#live.has(sceneSetId)) throw new EngineFailure({ code: "IN_FLIGHT", detail: `scene set ${sceneSetId} is being written; wait for that to end (or cancel it)` });
      const key = deps.usableKey("write scenes");
      const budget = deps.paidBudget();
      const library = await deps.liveLibrary();
      const { set, avatarId } = await this.#find(library, sceneSetId);
      deps.claimAvatar(avatarId, "a photo run or another job is already changing this avatar; wait for it to finish");
      claimed = avatarId;
      const jobId = deps.newId();
      mine = { jobId, avatarId, kind: "unwritten", count: 0, inFlight: new Set() };
      this.#live.set(sceneSetId, mine);
      deps.runnableAvatar(library, avatarId);
      await deps.assertAvatarOnDisk(library, avatarId);
      if (await library.runFolderExists(set.runId)) throw new EngineFailure({ code: "VALIDATION", detail: `scene set ${sceneSetId} is used by run ${set.runId} and is read-only` });
      if (set.revision !== revision) throw new EngineFailure({ code: "SCENES_CHANGED", detail: `scene set ${sceneSetId} is at revision ${set.revision}, not ${revision}` });
      const ledger = budget.ledger;
      if (pendingChunks(set, ledger).length === 0) throw new EngineFailure({ code: "VALIDATION", detail: "no scene of the set is waiting to be written" });
      const priced = await deps.prices(sceneSetPriceModels(set.models.text));
      const estimate = writeEstimate(priced, set, ledger);
      deps.checkAccepted(estimate.worstMicros, payload.acceptedWorstMicros);
      deps.checkMonthlyRoom(budget, estimate.worstMicros);
      let started: StoredSceneSet;
      try {
        started = await library.sceneSets.update(avatarId, sceneSetId, (current) => beginWrite(current, { kind: "unwritten", jobId }), {
          expectedRevision: revision,
          guard: async (current) => {
            if (await library.runFolderExists(current.runId)) throw new EngineFailure({ code: "VALIDATION", detail: `scene set ${sceneSetId} is used by run ${current.runId} and is read-only` });
          },
        });
      } catch (error) {
        return this.#failureOf(error);
      }
      // The write is in the file (revision and status moved): announce it now, not at the first chunk (which can be minutes away).
      this.#setCount(started, budget);
      await this.#announce(library, started);
      this.#launch({ jobId, set: started, kind: "unwritten", key, budget, library, priced, capMicros: estimate.worstMicros });
      launched = true;
      return { jobId };
    } finally {
      if (!launched) {
        if (mine !== null && this.#live.get(sceneSetId) === mine) this.#live.delete(sceneSetId);
        deps.paidEnd();
        if (claimed !== null) deps.releaseAvatar(claimed);
      }
    }
  }

  // ---------- the job ----------

  /** The scenes the set's job will write (the chunks still pending), put on its live entry so the view says it from the first announcement. */
  #setCount(set: StoredSceneSet, budget: Budget): number {
    const total = pendingChunks(set, budget.ledger).reduce((sum, pending) => sum + pending.sceneIds.length, 0);
    const live = this.#live.get(set.sceneSetId);
    if (live !== undefined) live.count = total;
    return total;
  }

  /** Registers the job under its own scope, capped at the worst case it was priced at, and runs it on after the command's answer. */
  #launch(job: { jobId: string; set: StoredSceneSet; kind: "compose" | "unwritten"; key: string; budget: Budget; library: Library; priced: PricedBook; capMicros: number }): void {
    const deps = this.#deps;
    const { set, jobId } = job;
    const total = this.#setCount(set, job.budget);
    const live = this.#live.get(set.sceneSetId);
    if (live === undefined) throw new Error(`scene set ${set.sceneSetId} has no live job to launch`);
    const signal = deps.jobs.startScenes(jobId, { sceneSetId: set.sceneSetId, avatarId: set.avatarId, total });
    deps.setCap(scopeKey({ avatarJobId: jobId }), job.capMicros);
    try {
      const progress = deps.jobs.progress(jobId, 0);
      if (progress !== null) deps.emit({ v: PROTOCOL_VERSION, id: deps.newId(), kind: "event", type: "job.progress", payload: progress });
    } catch (error) {
      deps.warn(`studio engine: the launch of scenes job ${jobId} could not be announced (${detailOfError(error)})`);
    }
    void this.#run({ ...job, live, signal });
  }

  /** Runs a registered job to its end and announces it: money.changed, the set's last state, then job.done, job.failed or job.cancelled. Never rejects. */
  async #run(job: { jobId: string; set: StoredSceneSet; key: string; budget: Budget; library: Library; priced: PricedBook; live: LiveJob; signal: AbortSignal }): Promise<void> {
    const deps = this.#deps;
    const { set, jobId, library, live } = job;
    const { sceneSetId, avatarId } = set;
    const scope = { avatarJobId: jobId };
    const update = async (change: (current: StoredSceneSet) => StoredSceneSet): Promise<StoredSceneSet> => library.sceneSets.update(avatarId, sceneSetId, change);
    // An accepted chunk is paid for and its answer is kept nowhere else: a disk error while storing it is tried once more from the sentences in memory.
    // A refusal of the store itself (the record is gone or does not fit) is not transient and is not retried.
    const store = async (change: (current: StoredSceneSet) => StoredSceneSet): Promise<StoredSceneSet> => {
      try {
        return await update(change);
      } catch (error) {
        if (error instanceof SceneSetError) throw error;
        deps.warn(`studio engine: scene set ${sceneSetId} could not be written (${detailOfError(error)}); trying once more`);
        return update(change);
      }
    };
    let end: SceneWriteEnd;
    try {
      const client = deps.openRouter(job.key);
      end = await runSceneWrite(
        {
          chat: (params) => {
            live.inFlight.add(params.attemptId);
            return client.chat(params).finally(() => live.inFlight.delete(params.attemptId));
          },
          budget: job.budget,
          priceBook: job.priced.book,
          acquire: (signal): Promise<Release> => deps.networkPool.acquire(signal),
          load: async () => {
            const current = await library.sceneSets.get(avatarId, sceneSetId);
            if (current === null) throw new Error(`scene set ${sceneSetId} is gone`);
            return current;
          },
          saveChunk: async (_chunk, sentences) => {
            await this.#announce(library, await store((current) => withChunkWritten(current, sentences)));
          },
          giveUp: async (chunk, by) => {
            await this.#announce(library, await update((current) => withChunkGivenUp(current, chunk, by)));
          },
          progress: (done) => {
            const payload = deps.jobs.progress(jobId, done);
            if (payload !== null) deps.emit({ v: PROTOCOL_VERSION, id: deps.newId(), kind: "event", type: "job.progress", payload });
          },
        },
        { jobId, scope, signal: job.signal },
      );
    } catch (error) {
      end = { status: "failed", error: deps.errorOf(error), stoppedBy: "failed" };
    }
    deps.clearCap(scopeKey(scope));
    // Why the write ended is kept in the set (a dying process cannot write «closed»: no outcome and no live job reads that).
    try {
      await update((current) => {
        const ended =
          end.status === "done"
            ? withWriteFinished(current)
            : withWriteStopped(current, end.status === "cancelled" ? { stoppedBy: "cancelled" } : { stoppedBy: end.stoppedBy, error: end.error });
        return withOutcome(ended, currentTally(ended, deps.ledger()));
      });
    } catch (error) {
      deps.warn(`studio engine: how scenes job ${jobId} ended could not be recorded in its set (${detailOfError(error)}); the set will read as closed`);
    }
    // Not live any more: the view built below is the set at rest.
    this.#live.delete(sceneSetId);
    deps.paidEnd();
    deps.releaseAvatar(avatarId);
    try {
      if (end.status === "failed" && end.error.code === "AUTH_INVALID") deps.markKeyRejected(job.key);
      deps.emitMoney();
      const jobEnd: ScenesJobEnd = end.status === "done" ? { status: "done", written: end.written, unwritten: end.unwritten } : end.status === "failed" ? { status: "failed", error: end.error } : { status: "cancelled" };
      const state = deps.jobs.finishScenes(jobId, jobEnd);
      const final = await library.sceneSets.get(avatarId, sceneSetId).catch(() => null);
      if (final !== null) await this.#announce(library, final);
      const v = PROTOCOL_VERSION;
      const ref = { kind: "scenes" as const, jobId, sceneSetId, avatarId };
      if (state?.status === "done" && state.result !== undefined) {
        deps.emit({ v, id: deps.newId(), kind: "event", type: "job.done", payload: { jobId, result: state.result } });
      } else if (end.status === "failed") {
        deps.emit({ v, id: deps.newId(), kind: "event", type: "job.failed", payload: { ...ref, error: end.error } });
      } else if (end.status === "cancelled") {
        deps.emit({ v, id: deps.newId(), kind: "event", type: "job.cancelled", payload: ref });
      }
    } catch (error) {
      deps.warn(`studio engine: the end of scenes job ${jobId} could not be announced (${detailOfError(error)})`);
    }
  }
}
