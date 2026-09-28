// T6: the photo run's two pools. The network pool bounds the paid requests
// in flight across every run of the engine (the settings' network
// concurrency, default 6): a 429 from OpenRouter shrinks it by one, and it
// grows back by one only after a streak of successful responses, so a rate
// limit backs the whole engine off at once instead of every slot finding
// out on its own. The CPU pool bounds local work (QA gates, decoding) so a
// burst of finished images cannot starve the engine's own event loop.

/** Frees a slot taken from a pool; idempotent. */
export type Release = () => void;

/** The fewest successful responses in a row before a shrunk network pool grows back by one slot. */
export const MIN_RECOVER_STREAK = 2;

/** A burst of 429s inside this window is one rate limit: it shrinks the pool once. */
export const SHRINK_WINDOW_MS = 5_000;

interface Waiter {
  grant: () => void;
  signal: AbortSignal;
  onAbort: () => void;
}

function assertPositiveInt(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer, got ${value}`);
}

/** A FIFO counting semaphore whose limit can move while slots are held. */
class Slots {
  #limit: number;
  #active = 0;
  readonly #waiters: Waiter[] = [];

  constructor(limit: number) {
    this.#limit = limit;
  }

  get limit(): number {
    return this.#limit;
  }

  get active(): number {
    return this.#active;
  }

  set limit(value: number) {
    this.#limit = value;
    this.#wake();
  }

  acquire(signal: AbortSignal): Promise<Release> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<Release>((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        grant: () => {
          signal.removeEventListener("abort", waiter.onAbort);
          this.#active++;
          resolve(this.#releaser());
        },
        onAbort: () => {
          const at = this.#waiters.indexOf(waiter);
          if (at >= 0) this.#waiters.splice(at, 1);
          reject(signal.reason);
        },
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.#waiters.push(waiter);
      this.#wake();
    });
  }

  #releaser(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active--;
      this.#wake();
    };
  }

  #wake(): void {
    while (this.#active < this.#limit) {
      const next = this.#waiters.shift();
      if (next === undefined) return;
      next.grant();
    }
  }
}

/**
 * Paid requests in flight. `onResponse` sees every HTTP status the engine's
 * fetch gets back (transport retries included). A 429 takes one slot away
 * (never below one) and resets the success streak — at most once per
 * SHRINK_WINDOW_MS, since every request in flight is usually hit by the same
 * limit at once, and six 429s from one burst are one signal, not six. A
 * streak of 2xx as long as the current limit (at least MIN_RECOVER_STREAK)
 * gives one slot back, never above `max`: recovery takes about one round of
 * requests per step at any size, so 1 back to 6 is 16 successes, not 50.
 * Requests already in flight are never interrupted: a shrink only makes new
 * ones wait longer.
 */
export class NetworkPool {
  readonly #slots: Slots;
  readonly #monotonic: () => number;
  readonly #shrinkWindowMs: number;
  #max: number;
  #streak = 0;
  #lastShrinkAt: number | null = null;

  constructor(opts: { max: number; monotonic?: () => number; shrinkWindowMs?: number }) {
    assertPositiveInt("max", opts.max);
    const shrinkWindowMs = opts.shrinkWindowMs ?? SHRINK_WINDOW_MS;
    if (!Number.isSafeInteger(shrinkWindowMs) || shrinkWindowMs < 0) throw new RangeError(`shrinkWindowMs must be a non-negative integer, got ${shrinkWindowMs}`);
    this.#max = opts.max;
    this.#monotonic = opts.monotonic ?? (() => performance.now());
    this.#shrinkWindowMs = shrinkWindowMs;
    this.#slots = new Slots(opts.max);
  }

  get limit(): number {
    return this.#slots.limit;
  }

  get active(): number {
    return this.#slots.active;
  }

  /** A slot for one request, in the order asked; rejects with the signal's reason if it aborts first. */
  acquire(signal: AbortSignal): Promise<Release> {
    return this.#slots.acquire(signal);
  }

  onResponse(status: number): void {
    if (status === 429) {
      this.#streak = 0;
      const now = this.#monotonic();
      if (this.#lastShrinkAt !== null && now - this.#lastShrinkAt < this.#shrinkWindowMs) return;
      this.#lastShrinkAt = now;
      this.#slots.limit = Math.max(1, this.#slots.limit - 1);
      return;
    }
    if (status < 200 || status > 299) return;
    this.#streak++;
    if (this.#streak < Math.max(MIN_RECOVER_STREAK, this.#slots.limit)) return;
    this.#streak = 0;
    if (this.#slots.limit < this.#max) this.#slots.limit = this.#slots.limit + 1;
  }

  /** The settings' concurrency changed: the new ceiling, and the current limit clamped to it. */
  setMax(max: number): void {
    assertPositiveInt("max", max);
    const wasAtMax = this.#slots.limit >= this.#max;
    this.#max = max;
    this.#slots.limit = wasAtMax ? max : Math.min(this.#slots.limit, max);
  }
}

/** Local work (QA gates, decoding): at most `size` tasks at once, in the order asked. */
export class CpuPool {
  readonly #slots: Slots;

  constructor(size: number) {
    assertPositiveInt("size", size);
    this.#slots = new Slots(size);
  }

  /**
   * Runs `work` once a slot is free; a task still waiting when `signal`
   * aborts never runs. A running task's slot is freed the moment `signal`
   * aborts, whether or not the task itself ever settles (review round 3,
   * L-c): a task that ignores its abort must not hold the pool.
   */
  async run<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    const release = await this.#slots.acquire(signal);
    signal.addEventListener("abort", release, { once: true });
    // An abort between the grant and this line fired no listener: free the slot now (release is idempotent).
    if (signal.aborted) release();
    try {
      return await work();
    } finally {
      signal.removeEventListener("abort", release);
      release();
    }
  }
}
