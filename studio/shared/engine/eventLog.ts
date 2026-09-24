import type { EventsSince } from "./commands";
import { EventMessage, type UnsequencedEvent } from "./events";
import { Id } from "./primitives";

function assertCount(name: string, value: number, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RangeError(`${name} must be an integer >= ${min}`);
  }
}

function deepFreeze(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  const children: unknown[] = Object.values(value);
  for (const child of children) deepFreeze(child);
  Object.freeze(value);
}

/**
 * The engine's recent events in a fixed-size ring. `append` validates each
 * event, stamps it with the next `seq` (1, 2, 3, ...) and the engine's
 * `bootId`, and stores a deep-frozen copy, so nothing can rewrite history.
 * `since` lets a window that reconnects catch up. It answers `gap` (refetch
 * `engine.snapshot`) when events the caller missed are gone, when the caller
 * is ahead of the log, or when the caller's `bootId` is from an earlier engine
 * whose seqs mean nothing here.
 */
export class EventLog {
  private readonly ring: EventMessage[] = [];
  private last = 0;

  constructor(
    readonly capacity: number,
    readonly bootId: string,
  ) {
    assertCount("capacity", capacity, 1);
    if (!Id.safeParse(bootId).success) throw new RangeError("bootId must be a valid id");
  }

  get lastSeq(): number {
    return this.last;
  }

  /** Throws a ZodError for an event that breaks the contract; no seq is used up. */
  append(event: UnsequencedEvent): number {
    const seq = this.last + 1;
    const stored = EventMessage.parse(structuredClone({ ...event, seq, bootId: this.bootId }));
    deepFreeze(stored);
    this.ring[(seq - 1) % this.capacity] = stored;
    this.last = seq;
    return seq;
  }

  since(afterSeq: number, bootId: string): EventsSince {
    assertCount("afterSeq", afterSeq, 0);
    if (bootId !== this.bootId) return { gap: true };
    const oldestKept = Math.max(1, this.last - this.capacity + 1);
    if (afterSeq > this.last || afterSeq < oldestKept - 1) return { gap: true };

    const events: EventMessage[] = [];
    for (let seq = afterSeq + 1; seq <= this.last; seq++) {
      events.push(this.ring[(seq - 1) % this.capacity]);
    }
    return { gap: false, events };
  }
}
