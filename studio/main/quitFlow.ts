import type { FlushOutcome } from "./windowFlush";

// Quitting Studio (task 3a.8b.2, then the 3d.2 review and re-review). The windows are first asked to save what the
// owner is editing (the montage editor's autosave waits up to 3 s for a quiet spell, and a Cmd+Q inside it must not
// lose the edit). A window that could not save CANCELS the quit before anything else happens (the engine is left
// untouched, the window says why and offers «Выйти без сохранения», which quits skipping the ask); a window that does
// not answer in time does not keep the app from quitting. Then the engine is asked to cancel its renders and to let a
// commit that is past its claim finish, so no orphaned ffmpeg keeps writing into the export folder and no half-saved
// video is left for the next start. Electron's `before-quit` is HELD while all that runs (a second Cmd+Q during the
// wait must not skip it, nor start it again), the quit is asked again once the shutdown is over, and from then on a
// page's `beforeunload` may no longer hold it (`isQuitting`, read by main's `will-prevent-unload`): the engine is
// already shut down. The engine's process is stopped only when the quit really goes on (`will-quit`).
// S4.7: before any of that, while an autopilot launch runs, the owner is asked (`confirmQuit`); «Остаться» touches nothing.

/** How long the windows get to save before the engine is shut down anyway. */
export const WINDOW_FLUSH_WAIT_MS = 5_000;

export interface QuitFlowDeps {
  /**
   * Asked first, before a window or the engine is touched: false keeps the app open (S4.7: a launch runs). Absent, or resolving true, the quit goes on. A rejection
   * counts as true: a dialog that failed must not trap the app.
   */
  confirmQuit?(): Promise<boolean>;
  /** The owner stayed: on Windows the last window is already closed, so this opens one again. */
  stay?(): void;
  /** Asks every window to save its unsaved work; also bounded here, so a hang or a throw cannot keep the app open. */
  flushWindows(): Promise<FlushOutcome>;
  /** The bound on `flushWindows`; `WINDOW_FLUSH_WAIT_MS` when absent. */
  flushTimeoutMs?: number;
  /** The soft shutdown, bounded by its own timeout; a rejection does not keep the app from quitting. */
  shutdown(): Promise<void>;
  /** `app.quit()`. */
  quit(): void;
  /** Ends the engine's process. */
  stop(): void;
}

export interface QuitFlow {
  /** Electron's `before-quit`. */
  beforeQuit(event: { preventDefault(): void }): void;
  /** The owner chose to quit although a window could not save: the ask is skipped. */
  quitWithoutSaving(): void;
  /** The quit is agreed and the engine shut down: a page's `beforeunload` may no longer cancel it. */
  isQuitting(): boolean;
  /** Electron's `will-quit`: the quit is going on. */
  willQuit(): void;
}

/** `work`, or `timeout` after `ms`: a window that hangs or fails is not a reason to stay. */
function bounded(work: () => Promise<FlushOutcome>, ms: number): Promise<FlushOutcome> {
  return new Promise<FlushOutcome>((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), ms);
    void Promise.resolve()
      .then(work)
      .catch((): FlushOutcome => "timeout")
      .then((outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      });
  });
}

export function createQuitFlow(deps: QuitFlowDeps): QuitFlow {
  let phase: "idle" | "confirming" | "asking" | "shutting-down" | "done" = "idle";
  const flushTimeoutMs = deps.flushTimeoutMs ?? WINDOW_FLUSH_WAIT_MS;

  function shutDownAndQuit(): void {
    phase = "shutting-down";
    void deps
      .shutdown()
      .catch(() => undefined)
      .finally(() => {
        phase = "done";
        deps.quit();
      });
  }

  function flushThenShutDown(): void {
    phase = "asking";
    void bounded(() => deps.flushWindows(), flushTimeoutMs).then((outcome) => {
      if (phase !== "asking") return; // «Выйти без сохранения» went ahead meanwhile
      if (outcome === "refused") {
        phase = "idle"; // nothing was touched: the window says why, and the next Cmd+Q asks again
        return;
      }
      shutDownAndQuit();
    });
  }

  /** The question, when there is one to ask; a dialog that fails does not trap the app. */
  function confirmThenFlush(confirm: () => Promise<boolean>): void {
    phase = "confirming";
    void Promise.resolve()
      .then(confirm)
      .catch(() => true)
      .then((agreed) => {
        if (agreed) {
          flushThenShutDown();
          return;
        }
        phase = "idle"; // «Остаться»: nothing was touched, and the next Cmd+Q asks again
        deps.stay?.();
      });
  }

  return {
    beforeQuit: (event) => {
      if (phase === "done") return; // the shutdown is over: this quit goes through
      event.preventDefault();
      if (phase !== "idle") return; // one ask and one shutdown, however many times the owner presses Cmd+Q
      const confirm = deps.confirmQuit;
      if (confirm === undefined) flushThenShutDown();
      else confirmThenFlush(() => confirm.call(deps));
    },
    quitWithoutSaving: () => {
      if (phase === "confirming" || phase === "shutting-down" || phase === "done") return;
      shutDownAndQuit();
    },
    isQuitting: () => phase === "done",
    willQuit: () => deps.stop(),
  };
}
