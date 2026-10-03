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
