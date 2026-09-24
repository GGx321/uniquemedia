/** Timers for the mock engine: real ones in the dev build, a manual clock in tests. */
export interface Scheduler {
  /** Runs `task` after `ms`; the returned function cancels it. */
  schedule(ms: number, task: () => void): () => void;
}

export const realScheduler: Scheduler = {
  schedule(ms, task) {
    const handle = setTimeout(task, ms);
    return () => clearTimeout(handle);
  },
};

interface Pending {
  at: number;
  order: number;
  task: () => void;
}

/** A deterministic clock: nothing runs until the test advances it. */
export class ManualScheduler implements Scheduler {
  private queue: Pending[] = [];
  private now = 0;
  private order = 0;

  schedule(ms: number, task: () => void): () => void {
    const entry: Pending = { at: this.now + Math.max(0, ms), order: this.order++, task };
    this.queue.push(entry);
    return () => {
      this.queue = this.queue.filter((p) => p !== entry);
    };
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Runs the earliest task; false when nothing is queued. */
  next(): boolean {
    const [first] = [...this.queue].sort((a, b) => a.at - b.at || a.order - b.order);
    if (!first) return false;
    this.queue = this.queue.filter((p) => p !== first);
    this.now = first.at;
    first.task();
    return true;
  }

  /** Runs every task, including ones scheduled while running, up to a safety limit. */
  runAll(limit = 1000): void {
    for (let i = 0; i < limit && this.next(); i++);
  }
}
