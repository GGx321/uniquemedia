import type { LaunchFile } from "./launchFile";
import type { AvatarMirror, ContinueInput, ContinueOutcome, LaunchSteps, LaunchStepsContext, MirrorSource, StepTimers } from "./steps";

// Stage 4, S4.6b1 (plan §20, fix round 1): the composer of the steps seam. The paid path (`paidSteps.ts`, S4.6b) and the free path (`freeSteps.ts`, S4.6c) are two `LaunchSteps`; the
// engine takes one. This puts them behind it, and it owns three things neither part can decide alone.
//
// 1. THE FINISH GATE. Finishing a launch closes its Budget group and fixes its sum, so it is a JOINT decision. Each part is a voter:
//    - the free part is an ACTIVE voter: it calls `ctx.finish()` when all its videos are final. Behind the composer that call is a VOTE, not the finish: it returns the launch file at
//      once (it never waits for the others and never rejects for want of them) and may be repeated at every poll;
//    - the paid part is a PASSIVE voter (`finishReady`): ready when it has no worker and no live job and every generating avatar is in `montage`/`done`/`skipped`. It tells the
//      composer when that may have changed (`onReadyChange`);
//    - the real `ctx.finish()` runs exactly once, when every part is ready. It is the core's: it refuses while anything is in flight (`steps.inFlight()`), runs in the core's queue,
//      calls `complete` on the parts, then closes the group. A refused or failed finish is told (`warn`) and leaves every vote standing: the next vote or ready-change tries again.
//    The votes are forgotten at every `begin` (a new epoch: a resume).
//    The retry after a refused finish is armed only while the launch runs, fires only while it runs, and is taken back by `begin`, `drain`, `release` and `complete` (S4.6b2: it used to poll
//    through a pause). A vote while the launch does not run reaches no finish at all; the resume's `begin` starts a new epoch.
// 2. FIELD OWNERSHIP in the launch file. Paid owns an avatar's `phase`, `waiting`, `skipped` and `photosDone`; free owns `videos[]`. The free part's `ctx.update` is filtered: it cannot
//    change what paid owns, with one exception: it may move an avatar from `montage` to `done` once the paid part has no live work for that avatar.
// 3. ISOLATION. Every part begins, drains and releases even if another one fails; failures are told, never thrown through the others.

export interface ComposedSteps extends LaunchSteps {
  /** Resolves when the finish this composer started (if any) has ended. Tests wait on it. */
  settled(): Promise<void>;
}

export interface ComposeOptions {
  warn?: (line: string) => void;
  /** After a refused or failed finish with both parts ready, the composer tries again after this long (and at every ready-change). Default 1000 ms. */
  retryMs?: number;
  /** The retry's timer, for a test that owns the clock. The default is the global `setTimeout`, unref'd (nothing awaits it). */
  timers?: StepTimers;
}

const DEFAULT_TIMERS: StepTimers = {
  set: (run, ms) => {
    const timer = setTimeout(run, ms);
    timer.unref();
    return timer;
  },
  clear: (handle) => clearTimeout(handle),
};

/**
 * The free part's rewrite, filtered. A row without a `generation` belongs to the free part entirely (the paid part never touches it). On a generating row what the paid part owns
 * (`waiting`, `skipped`, `photosDone`, and the phase) is restored from the file as it was; `montage` to `done` is allowed when paid is idle for that avatar. Null when nothing is left
 * of the change: no write at all, so the free part never counts a rolled-back change as progress.
 */
export function guardFreeChange(before: LaunchFile, after: LaunchFile, paidIdle: (avatarId: string) => boolean): LaunchFile | null {
  const old = new Map(before.avatars.map((a) => [a.avatarId, a]));
  let rowsChanged = false;
  const avatars = after.avatars.map((row) => {
    const was = old.get(row.avatarId);
    if (was === undefined) {
      rowsChanged = true;
      return row;
    }
    let out = row;
    if (was.generation !== null) {
      const finishes = was.phase === "montage" && row.phase === "done" && paidIdle(row.avatarId);
      out = { ...row, phase: finishes ? row.phase : was.phase, waiting: was.waiting, skipped: was.skipped, photosDone: was.photosDone };
    }
    const same = out.phase === was.phase && out.waiting === was.waiting && out.skipped === was.skipped && out.photosDone === was.photosDone && out.videos === was.videos;
    if (same) return was;
    rowsChanged = true;
    return out;
  });
  const outside = (Object.keys(after) as (keyof LaunchFile)[]).some((key) => key !== "avatars" && after[key] !== before[key]);
  if (!rowsChanged && !outside) return null;
  return { ...after, avatars };
}

/** The final rewrite before the launch finishes: a row whose videos are all final (done or dropped) is `done`, a generating row included (the paid part rests at `montage`). */
function settledRows(file: LaunchFile): LaunchFile | null {
  let changed = false;
  const avatars = file.avatars.map((row) => {
    const final = row.videos.length > 0 && row.videos.every((v) => v.state === "done" || v.state === "dropped");
    if (row.phase === "skipped" || row.phase === "done" || !final) return row;
    changed = true;
    return { ...row, phase: "done" as const, waiting: null };
  });
  return changed ? { ...file, avatars } : null;
}

export function composeSteps(paid: LaunchSteps, free: LaunchSteps, options: ComposeOptions = {}): ComposedSteps {
  const warn = options.warn ?? ((line: string) => console.warn(line));
  const parts: readonly LaunchSteps[] = [paid, free];
  const raws = new Map<string, LaunchStepsContext>();
  const votes = new Map<string, Set<number>>();
  const finishing = new Map<string, Promise<void>>();
  /** Launches whose finish went through in this epoch: a late vote finishes nothing twice. */
  const finished = new Set<string>();
  const timers = options.timers ?? DEFAULT_TIMERS;
  /** The one pending retry of the finish, by launch id. */
  const retries = new Map<string, ReturnType<StepTimers["set"]>>();
  const cancelRetry = (launchId?: string): void => {
    for (const [id, handle] of [...retries]) {
      if (launchId !== undefined && id !== launchId) continue;
      timers.clear(handle);
      retries.delete(id);
    }
  };

  const ready = (launchId: string): boolean => {
    const voted = votes.get(launchId) ?? new Set<number>();
    return parts.every((part, i) => (part.finishReady === undefined ? voted.has(i) : part.finishReady(launchId)));
  };

  /** Starts the real finish when every part is ready. Never throws, never waits: a voter must not hold the core's queue. */
  const evaluate = (launchId: string): void => {
    const raw = raws.get(launchId);
    if (raw === undefined || finished.has(launchId) || finishing.has(launchId) || !raw.isRunning() || !ready(launchId)) return;
    // The rows whose videos are all final become `done` first (a generating row rests at `montage`), then the core finishes: it refuses while anything is in flight.
    const run = raw
      .update(settledRows)
      .then(() => raw.finish())
      .then(
        () => void finished.add(launchId),
        (error: unknown) => {
          warn(`studio engine: launch ${launchId} could not finish yet (${error instanceof Error ? error.message : typeof error}); trying again`);
          // Both parts have voted and nobody would vote again: try once more soon. Only while the launch runs: a paused or stopped one starts a new epoch when it goes on.
          cancelRetry(launchId);
          if (!raw.isRunning()) return;
          retries.set(
            launchId,
            timers.set(() => {
              retries.delete(launchId);
              evaluate(launchId);
            }, options.retryMs ?? 1_000),
          );
        },
      );
    const tracked = run.finally(() => {
      finishing.delete(launchId);
    });
    finishing.set(launchId, tracked);
  };

  for (const part of parts) {
    part.onReadyChange?.(() => {
      for (const launchId of raws.keys()) evaluate(launchId);
    });
  }

  const wrap = (index: number, raw: LaunchStepsContext): LaunchStepsContext => {
    const isFree = index === 1;
    return {
      ...raw,
      update: isFree ? (change) => raw.update((file) => {
        const next = change(file);
        return next === null ? null : guardFreeChange(file, next, (avatarId) => paid.active?.(raw.launchId, avatarId) !== true);
      }) : raw.update,
      finish: () => {
        const set = votes.get(raw.launchId) ?? new Set<number>();
        set.add(index);
        votes.set(raw.launchId, set);
        evaluate(raw.launchId);
        return Promise.resolve(raw.file());
      },
    };
  };

  const composed: ComposedSteps = {
    begin(ctx: LaunchStepsContext): void {
      cancelRetry(ctx.launchId);
      raws.set(ctx.launchId, ctx);
      votes.set(ctx.launchId, new Set());
      finished.delete(ctx.launchId);
      // Every part begins, whatever another one does; a failure is told afterwards, not thrown through the others.
      const failures: string[] = [];
      parts.forEach((part, i) => {
        try {
          part.begin(wrap(i, ctx));
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      });
      for (const failure of failures) warn(`studio engine: a part of launch ${ctx.launchId} could not begin (${failure})`);
    },
    async drain(): Promise<void> {
      cancelRetry();
      // Each part's drain never rejects by contract; one that breaks it must not leave the others undrained.
      await Promise.allSettled(parts.map((part) => part.drain()));
    },
    async release(ctx: LaunchStepsContext): Promise<void> {
      cancelRetry(ctx.launchId);
      // Every part releases what it holds even if an earlier one failed; the first failure is told after all of them ran.
      const results = await Promise.allSettled(parts.map((part, i) => part.release(wrap(i, ctx))));
      const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed !== undefined) throw failed.reason;
    },
    async complete(ctx: LaunchStepsContext): Promise<void> {
      cancelRetry(ctx.launchId);
      const results = await Promise.allSettled(parts.map((part, i) => part.complete?.(wrap(i, ctx)) ?? Promise.resolve()));
      const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed !== undefined) throw failed.reason;
    },
    inFlight(): { requests: number; renders: number } {
      let requests = 0;
      let renders = 0;
      for (const part of parts) {
        const now = part.inFlight();
        requests += now.requests;
        renders += now.renders;
      }
      return { requests, renders };
    },
    active: (launchId: string, avatarId: string): boolean => parts.some((part) => part.active?.(launchId, avatarId) === true),
    settled: async (): Promise<void> => {
      await Promise.allSettled([...finishing.values(), ...parts.map((part) => part.settled?.())]);
    },
  };
  if (parts.some((part) => part.onMirrorChange !== undefined)) {
    composed.onMirrorChange = (listener: (launchId: string) => void): void => {
      for (const part of parts) part.onMirrorChange?.(listener);
    };
  }
  if (parts.some((part) => part.suspend !== undefined)) {
    composed.suspend = (): void => {
      for (const part of parts) {
        try {
          part.suspend?.();
        } catch (error) {
          warn(`studio engine: a part could not be told of the sleep (${error instanceof Error ? error.message : String(error)})`);
        }
      }
    };
  }
  if (parts.some((part) => part.wake !== undefined)) {
    composed.wake = async (ctx: LaunchStepsContext): Promise<void> => {
      // The votes stand (a sleep is no new epoch); a part with no wake-up of its own is begun again, which is idempotent for a running launch.
      raws.set(ctx.launchId, ctx);
      const results = await Promise.allSettled(
        parts.map(async (part, i) => {
          if (part.wake !== undefined) await part.wake(wrap(i, ctx));
          else part.begin(wrap(i, ctx));
        }),
      );
      for (const result of results) if (result.status === "rejected") warn(`studio engine: a part could not wake launch ${ctx.launchId} (${result.reason instanceof Error ? result.reason.message : String(result.reason)})`);
    };
  }
  const review = parts.find((part) => part.continueAfterReview !== undefined);
  if (review?.continueAfterReview !== undefined) {
    const hand = review.continueAfterReview.bind(review);
    composed.continueAfterReview = (ctx: LaunchStepsContext, input: ContinueInput): Promise<ContinueOutcome> => hand(wrap(parts.indexOf(review), ctx), input);
  }
  if (parts.some((part) => part.mirror !== undefined)) {
    composed.mirror = (launchId: string, avatarId: string): AvatarMirror | null => {
      for (const part of parts) {
        const mirror = part.mirror?.(launchId, avatarId) ?? null;
        if (mirror !== null) return mirror;
      }
      return null;
    };
  }
  if (parts.some((part) => part.restore !== undefined)) {
    composed.restore = (launchId: string, sets: readonly MirrorSource[]): void => {
      for (const part of parts) {
        try {
          part.restore?.(launchId, sets);
        } catch (error) {
          warn(`studio engine: a part could not restore launch ${launchId} (${error instanceof Error ? error.message : String(error)})`);
        }
      }
    };
  }
  return composed;
}
