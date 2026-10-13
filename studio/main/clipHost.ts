import type { ClipPhase, EventMessage } from "../shared/engine";
import { CLIP_QUIT_DETAIL, CLIP_QUIT_MESSAGE } from "../shared/engine/clipRestartTexts";
import { QUIT_LEAVE_LABEL, QUIT_STAY_LABEL, type PowerBlockerPort, type QuitDialogPort, type QuitDialogSpec } from "./autopilotHost";

// Stage 5, 5b.1, S5.V6 (plan s5b1 §5.12, state 45): main's side of a clip in flight, like the autopilot host (autopilotHost.ts) for a launch. It learns the clips from the engine's `job.progress`,
// `job.done`, `job.failed` and `job.cancelled` events of kind `clip`, and does two things while one is between its `submitting` and its `proving` phases (the Grok attempt's own `submitting`
// and `rendering` included, since it runs through the same phases):
// - the QUIT QUESTION: «Клип ещё снимается...» with «Остаться» / «Выйти». A clip that is sent keeps billing and its reserve stays open at worst, so a quit now means a reconcile (about 5 minutes) at
//   the next start. It is not asked in `preparing` (the first frame: free and under a second), in the download and after it (free; the file can be fetched again), in a recovery or an export
//   (neither spends), nor for a job that is not a clip;
// - the POWER BLOCKER (`prevent-app-suspension`): the `held` sleep class does not keep the Mac awake, and a sleep in the middle of a render only makes the clip late.
// When the engine goes away the clips it ran are no longer running (a restarted engine reads them back from their journals), so nothing is held and nothing is asked about. Each port is called
// inside a guard: a port that throws costs its own feature and nothing else.

/** The phases between the POST being prepared and the proof window closing: the clip may bill, and the render goes on at the provider. */
const IN_FLIGHT: ReadonlySet<ClipPhase> = new Set<ClipPhase>(["submitting", "rendering", "proving"]);

export interface ClipHostDeps {
  blocker: PowerBlockerPort;
  dialog: QuitDialogPort;
  log?: (line: string) => void;
}

/** State 45's dialog: the autopilot's shape (`QuitDialogSpec`), «Остаться» first and the default, Escape staying. */
export function clipQuitDialog(): QuitDialogSpec {
  return { message: CLIP_QUIT_MESSAGE, detail: CLIP_QUIT_DETAIL, buttons: [QUIT_STAY_LABEL, QUIT_LEAVE_LABEL], defaultId: 0, cancelId: 0 };
}

export class ClipHost {
  readonly #deps: ClipHostDeps;
  /** The clip jobs main knows of and the phase each is in. */
  readonly #phases = new Map<string, ClipPhase>();
  #blockerId: number | null = null;
  #disposed = false;

  constructor(deps: ClipHostDeps) {
    this.#deps = deps;
  }

  #guard(what: string, work: () => void): void {
    try {
      work();
    } catch (error) {
      (this.#deps.log ?? console.warn)(`studio: the clip host's ${what} failed (${error instanceof Error ? error.name : typeof error})`);
    }
  }

  /** The engine's events: only the `job.*` events of a clip matter. Never throws. */
  observe(event: EventMessage): void {
    switch (event.type) {
      case "job.progress":
        if (event.payload.kind !== "clip") return;
        this.#phases.set(event.payload.jobId, event.payload.phase);
        break;
      case "job.failed":
      case "job.cancelled":
        if (event.payload.kind !== "clip") return;
        this.#phases.delete(event.payload.jobId);
        break;
      case "job.done":
        if (event.payload.result.kind !== "clip") return;
        this.#phases.delete(event.payload.jobId);
        break;
      default:
        return;
    }
    this.#guard("power blocker", () => this.#syncBlocker());
  }

  /** The engine process is gone (a crash, a restart): the clips it ran are not running now. */
  engineGone(): void {
    this.#phases.clear();
    this.#guard("power blocker", () => this.#syncBlocker());
  }

  #inFlight(): boolean {
    for (const phase of this.#phases.values()) if (IN_FLIGHT.has(phase)) return true;
    return false;
  }

  #syncBlocker(): void {
    const hold = !this.#disposed && this.#inFlight();
    if (hold && this.#blockerId === null) this.#blockerId = this.#deps.blocker.start();
    else if (!hold && this.#blockerId !== null) {
      const id = this.#blockerId;
      this.#blockerId = null;
      this.#deps.blocker.stop(id);
    }
  }

  /** Whether the blocker is held now (for the tests and diagnostics). */
  get blockerHeld(): boolean {
    return this.#blockerId !== null;
  }

  /** The quit is going on: the blocker goes and is not taken again. */
  dispose(): void {
    this.#disposed = true;
    this.#guard("power blocker", () => this.#syncBlocker());
  }

  /** quitFlow's `confirmQuit`, for the clip: true to quit. No question when no clip is between `submitting` and `proving`; «Остаться» (or Escape) keeps the app and changes nothing. */
  async confirmQuit(): Promise<boolean> {
    if (!this.#inFlight()) return true;
    const pressed = await this.#deps.dialog.ask(clipQuitDialog());
    return pressed === 1;
  }
}

/** Asks the quit questions in order and stops at the first «Остаться»: the autopilot's question comes first, and a second dialog is not opened for an owner who already stayed. */
export async function confirmInOrder(asks: readonly (() => Promise<boolean>)[]): Promise<boolean> {
  for (const ask of asks) if (!(await ask())) return false;
  return true;
}
