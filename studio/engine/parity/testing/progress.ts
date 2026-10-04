/** The parts of a render's `job.progress` the invariants judge. */
export interface RenderProgress {
  readonly jobId: string;
  readonly done: number;
  readonly total: number;
  readonly saving?: boolean | undefined;
  /** The announcement of a render still waiting for a slot (3d.6). */
  readonly queued?: boolean | undefined;
}

interface JobLine {
  readonly total: number;
  done: number;
  saving: boolean;
  /** Announcements at zero, not saving: the queued one and the one when it starts running. */
  starts: number;
}

/**
 * What every render's progress numbers must satisfy, whichever engine sends them (the parity transcript leaves `done` out, since
 * the engine steps by ffmpeg's frames and the mock by a clock; the bar the window draws depends on these rules alone):
 *  - a job begins at zero, and its `total` never changes;
 *  - `0 <= done <= total`, and `done` never goes back, the saving phase included (it is at least the last step);
 *  - progress at zero, not saving, is the START: at most twice (announced queued, announced again when it runs); every step is above zero;
 *  - while the job runs `done` stays below `total`: the last frame belongs to its end (the engine's fold caps it at total - 1);
 *  - no step after the saving phase began;
 *  - `queued` is only ever on a job's FIRST announcement, at zero and not saving: the start that follows, and a render that started at once, say nothing.
 * A violation throws, so the scenario that met it fails on whichever engine sent it.
 */
export class ProgressInvariants {
  readonly #jobs = new Map<string, JobLine>();

  check(progress: RenderProgress): void {
    const { jobId, done, total } = progress;
    const saving = progress.saving === true;
    const queued = progress.queued === true;
    const fail = (rule: string): never => {
      throw new Error(`job.progress of ${jobId} (done ${done} of ${total}${saving ? ", saving" : ""}): ${rule}`);
    };
    if (!Number.isInteger(done) || !Number.isInteger(total) || done < 0 || done > total) return fail("done is outside 0..total");
    const line = this.#jobs.get(jobId);
    if (queued && (done !== 0 || saving || line !== undefined)) return fail("queued is only the first announcement of a job, at zero and not saving");
    if (line === undefined) {
      if (done !== 0 || saving) return fail("a job must begin at zero, not saving");
      this.#jobs.set(jobId, { total, done: 0, saving: false, starts: 1 });
      return;
    }
    if (total !== line.total) return fail(`total changed from ${line.total}`);
    if (done < line.done) return fail(`done goes back from ${line.done}`);
    if (done >= total) return fail("done reaches the total before the job has ended");
    if (line.saving && !saving) return fail("a step after the saving phase began");
    if (!saving && done === 0 && ++line.starts > 2) return fail("a job is announced at zero at most twice (queued, then running): a step must be above zero");
    line.done = done;
    line.saving = saving;
  }
}

/** The parts of an import's `job.progress` the invariants judge: `done` counts bytes copied in the copy stage and the importer's units in the prepare stage. */
export interface ImportProgress {
  readonly jobId: string;
  readonly done: number;
  readonly total: number;
  readonly queued?: boolean | undefined;
  /** Absent means `copy` (3f.6). */
  readonly stage?: "copy" | "prepare" | undefined;
  /** What the probe judged of a video (prepare stage only). */
  readonly prepare?: { readonly hdrToSdr: boolean; readonly fromFps: number | null } | undefined;
}

interface ImportLine {
  stage: "copy" | "prepare";
  total: number;
  done: number;
  /** Announcements at zero in the copy stage: the queued one and the one when it starts running. */
  starts: number;
  /** What the prepare stage's first progress said was judged (null: nothing), kept to compare with every later one. */
  judged: string | null;
}

/**
 * What every import's progress numbers must satisfy, whichever engine sends them (the transcript writes the start and the steps as
 * phases, since the engine steps per percent of a copy and the mock in one step). Two stages, `copy` (bytes; no `stage` field) and then
 * `prepare` (the importer's units, 3f.6):
 *  - a job begins at zero in its copy, and its `total` never changes WITHIN a stage;
 *  - `0 <= done <= total`, and `done` never goes back within a stage; a copy may reach its total (its end follows);
 *  - copy: progress at zero is the START, at most twice (announced queued, announced again when it runs); every step is above zero; `queued` is only ever
 *    on a job's FIRST announcement, at zero;
 *  - the order is copy, then prepare, never back: the prepare begins once, after the copy is whole (done = total), at zero of a total of at least one;
 *  - prepare: `done` stays BELOW the total (the last unit belongs to the job's end, the record's storing, so a window never sees a full bar of a job that
 *    is still working); never `queued`;
 *  - what the probe judged (`prepare`) is on the prepare stage only, and what the first prepare progress said is repeated unchanged by every later one.
 * A violation throws, so the scenario that met it fails on whichever engine sent it.
 */
export class ImportProgressInvariants {
  readonly #jobs = new Map<string, ImportLine>();

  check(progress: ImportProgress): void {
    const { jobId, done, total } = progress;
    const queued = progress.queued === true;
    const stage = progress.stage ?? "copy";
    const judged = progress.prepare === undefined ? null : JSON.stringify([progress.prepare.hdrToSdr, progress.prepare.fromFps]);
    const fail = (rule: string): never => {
      throw new Error(`job.progress of import ${jobId} (${stage}, done ${done} of ${total}${queued ? ", queued" : ""}): ${rule}`);
    };
    if (!Number.isInteger(done) || !Number.isInteger(total) || done < 0 || done > total) return fail("done is outside 0..total");
    if (stage === "copy" && judged !== null) return fail("what the probe judged belongs to the prepare stage only");
    const line = this.#jobs.get(jobId);
    if (queued && (stage !== "copy" || done !== 0 || line !== undefined)) return fail("queued is only the first announcement of a job, at zero");
    if (line === undefined) {
      if (stage !== "copy") return fail("a job begins in its copy, before any prepare");
      if (done !== 0) return fail("a job must begin at zero");
      this.#jobs.set(jobId, { stage: "copy", total, done: 0, starts: 1, judged: null });
      return;
    }
    if (stage === "copy") {
      if (line.stage === "prepare") return fail("a copy after the prepare began: the stages never go back to the copy");
      if (total !== line.total) return fail(`total changed from ${line.total}`);
      if (done < line.done) return fail(`done goes back from ${line.done}`);
      if (done === 0 && ++line.starts > 2) return fail("a job is announced at zero at most twice (queued, then running): a step must be above zero");
      line.done = done;
      return;
    }
    // The prepare stage.
    if (line.stage === "copy") {
      if (line.done !== line.total) return fail(`the prepare begins before the copy is whole (${line.done} of ${line.total} bytes): the copy comes first`);
      if (done !== 0) return fail("the prepare must begin at zero");
      if (total < 1) return fail("the prepare must have at least one unit");
      this.#jobs.set(jobId, { stage: "prepare", total, done: 0, starts: line.starts, judged });
      return;
    }
    if (total !== line.total) return fail(`total changed from ${line.total}`);
    if (done === 0) return fail("the prepare begins once: a second announcement at zero");
    if (done < line.done) return fail(`done goes back from ${line.done}`);
    if (done >= total) return fail("done reaches the total before the job has ended");
    if (judged !== line.judged) return fail("what the probe judged changed (it is said at the begin and repeated unchanged)");
    line.done = done;
  }
}
