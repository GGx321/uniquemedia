// Stage 4 (plan §9): `autopilot.changed` is coalesced to at most four a second. The first change after a quiet moment goes out at once; changes that follow within the
// interval are merged into one trailing announcement when the interval ends, and that one carries the latest state (the caller builds it when it fires).

export const COALESCE_INTERVAL_MS = 250;

export interface CoalescerDeps {
  intervalMs: number;
  /** A clock that only moves forward, in milliseconds. */
  now(): number;
  /** Runs `run` after `ms`; the returned function cancels it. */
  schedule(run: () => void, ms: number): () => void;
  /** Announces the latest state. */
  fire(): void;
}

export class EventCoalescer {
  readonly #deps: CoalescerDeps;
  #lastFiredAt: number | null = null;
  #cancel: (() => void) | null = null;

  constructor(deps: CoalescerDeps) {
    this.#deps = deps;
  }

  /** Something changed. */
  request(): void {
    if (this.#cancel !== null) return;
    const now = this.#deps.now();
    const wait = this.#lastFiredAt === null ? 0 : Math.max(0, this.#lastFiredAt + this.#deps.intervalMs - now);
    if (wait === 0) {
      this.#fire(now);
      return;
    }
    this.#cancel = this.#deps.schedule(() => {
      this.#cancel = null;
      this.#fire(this.#deps.now());
    }, wait);
  }

  /** Announces now what is waiting, if anything is. */
  flush(): void {
    if (this.#cancel === null) return;
    this.#cancel();
    this.#cancel = null;
    this.#fire(this.#deps.now());
  }

  /** Drops what is waiting. */
  dispose(): void {
    this.#cancel?.();
    this.#cancel = null;
  }

  #fire(at: number): void {
    this.#lastFiredAt = at;
    this.#deps.fire();
  }
}
