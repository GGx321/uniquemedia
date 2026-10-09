import type { AvatarMirror, ContinueInput, ContinueOutcome, LaunchSteps, LaunchStepsContext } from "../steps";

// Test-only: the steps seam's double. It records what the orchestrator asks of the steps, and lets a test hold a drain open or plant code at a call.

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export class FakeSteps implements LaunchSteps {
  readonly calls: string[] = [];
  readonly contexts: LaunchStepsContext[] = [];
  inflight = { requests: 0, renders: 0 };
  drainGate: Promise<void> | null = null;
  onBegin: ((ctx: LaunchStepsContext) => void) | null = null;
  onDrain: (() => void) | null = null;
  onRelease: (() => void) | null = null;
  /** S4.6b1: what the review hand-off was asked, and what it answers (an EngineFailure is thrown). Set to undefined for steps with no review step. */
  continued: ContinueInput[] = [];
  continueAnswer: ContinueOutcome | Error = { draw: "started", photos: 3 };
  continueAfterReview: LaunchSteps["continueAfterReview"] = async (_ctx, input) => {
    this.continued.push(input);
    if (this.continueAnswer instanceof Error) throw this.continueAnswer;
    return this.continueAnswer;
  };
  /** S4.6b2, `host.power`: assign to make this part answer a sleep; absent, the orchestrator begins it again on waking. */
  suspend: LaunchSteps["suspend"] = undefined;
  wake: LaunchSteps["wake"] = undefined;
  /** S4.6b1: the finish gate. Assign `finishReady` to make this a passive voter; `readyListeners` are the composer's. */
  finishReady: LaunchSteps["finishReady"] = undefined;
  readyListeners: (() => void)[] = [];
  onReadyChange(listener: () => void): void {
    this.readyListeners.push(listener);
  }
  /** Avatars this part has live work for. */
  busyAvatars = new Set<string>();
  active(_launchId: string, avatarId: string): boolean {
    return this.busyAvatars.has(avatarId);
  }
  completed = 0;
  complete(): Promise<void> {
    this.calls.push("complete");
    this.completed += 1;
    return Promise.resolve();
  }
  /** The set mirrors the view shows, by avatar id. */
  mirrors = new Map<string, AvatarMirror>();

  mirror(_launchId: string, avatarId: string): AvatarMirror | null {
    return this.mirrors.get(avatarId) ?? null;
  }

  begin(ctx: LaunchStepsContext): void {
    this.calls.push("begin");
    this.contexts.push(ctx);
    this.onBegin?.(ctx);
  }

  drain(): Promise<void> {
    this.calls.push("drain");
    this.onDrain?.();
    return this.drainGate ?? Promise.resolve();
  }

  release(): Promise<void> {
    this.calls.push("release");
    this.onRelease?.();
    return Promise.resolve();
  }

  inFlight(): { requests: number; renders: number } {
    return this.inflight;
  }

  /** The context of the latest `begin`. */
  get ctx(): LaunchStepsContext {
    const last = this.contexts.at(-1);
    if (last === undefined) throw new Error("begin was not called");
    return last;
  }
}
