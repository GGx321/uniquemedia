import type { LaunchSteps, LaunchStepsContext } from "../steps";

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
