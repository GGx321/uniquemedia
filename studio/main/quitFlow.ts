// Quitting Studio (task 3a.8b.2). The engine is asked to cancel its renders and to let a commit that is past its claim
// finish BEFORE the app goes, so no orphaned ffmpeg keeps writing into the export folder and no half-saved video is
// left for the next start. Electron's `before-quit` is HELD while that runs (a second Cmd+Q during the wait must not
// skip it, nor start it again), the quit is asked again once the shutdown is over, and the engine's process is stopped
// only when the quit really goes on (`will-quit`): a quit that something else cancels leaves the engine as it is.

export interface QuitFlowDeps {
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

export function createQuitFlow(deps: QuitFlowDeps): QuitFlow {
  let phase: "idle" | "shutting-down" | "done" = "idle";
  return {
    beforeQuit: (event) => {
      if (phase === "done") return; // the shutdown is over: this quit goes through
      event.preventDefault();
      if (phase === "shutting-down") return; // one shutdown, however many times the owner presses Cmd+Q
      phase = "shutting-down";
      void deps
        .shutdown()
        .catch(() => undefined)
        .finally(() => {
          phase = "done";
          deps.quit();
        });
    },
    willQuit: () => deps.stop(),
  };
}
