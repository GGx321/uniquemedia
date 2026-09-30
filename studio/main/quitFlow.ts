// Quitting Studio (task 3a.8b.2, then the 3d.2 review). The windows are first asked to save what the owner is
// editing (the montage editor's autosave waits up to 3 s for a quiet spell, and a Cmd+Q inside it must not lose the
// edit), for at most `flushTimeoutMs`: a window that does not answer in time does not keep the app from quitting.
// Then the engine is asked to cancel its renders and to let a commit that is past its claim finish, so no orphaned
// ffmpeg keeps writing into the export folder and no half-saved video is left for the next start. Electron's
// `before-quit` is HELD while all that runs (a second Cmd+Q during the wait must not skip it, nor start it again),
// the quit is asked again once the shutdown is over, and the engine's process is stopped only when the quit really
// goes on (`will-quit`): a quit that something else cancels leaves the engine as it is.

/** How long the windows get to save before the engine is shut down anyway. */
export const WINDOW_FLUSH_WAIT_MS = 5_000;

export interface QuitFlowDeps {
  /** Asks every window to save its unsaved work and resolves when they all answered; bounded here, not by the caller. */
  flushWindows(): Promise<void>;
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
  /** Electron's `will-quit`: the quit is going on. */
  willQuit(): void;
}

/** `work`, or nothing after `ms`: a window that hangs or fails is not a reason to stay. */
function bounded(work: () => Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    void Promise.resolve()
      .then(work)
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer);
        resolve();
      });
  });
}

export function createQuitFlow(deps: QuitFlowDeps): QuitFlow {
  let phase: "idle" | "shutting-down" | "done" = "idle";
  const flushTimeoutMs = deps.flushTimeoutMs ?? WINDOW_FLUSH_WAIT_MS;
  return {
    beforeQuit: (event) => {
      if (phase === "done") return; // the shutdown is over: this quit goes through
      event.preventDefault();
      if (phase === "shutting-down") return; // one shutdown, however many times the owner presses Cmd+Q
      phase = "shutting-down";
      void bounded(() => deps.flushWindows(), flushTimeoutMs)
        .then(() => deps.shutdown())
        .catch(() => undefined)
        .finally(() => {
          phase = "done";
          deps.quit();
        });
    },
    willQuit: () => deps.stop(),
  };
}
