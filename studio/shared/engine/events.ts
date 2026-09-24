import { z } from "zod";
import { nonEmpty, ProtocolVersion, Seq } from "./envelope";
import { EngineError } from "./errors";
import { Id, Micros } from "./primitives";
import { JobProgress, JobResult, MoneyStatus, ReconcileReasons } from "./state";

function defineEvent<const T extends string, P extends z.ZodType>(type: T, payload: P) {
  return {
    type,
    payload,
    message: z.strictObject({
      v: ProtocolVersion,
      id: Id,
      kind: z.literal("event"),
      seq: Seq,
      bootId: Id,
      type: z.literal(type),
      payload,
    }),
  };
}

/** Engine → renderer notifications. Each carries a `seq` and the `bootId` of the engine that emitted it. */
const EVENT_SPECS = [
  defineEvent("job.progress", JobProgress),
  defineEvent("job.done", z.strictObject({ jobId: Id, result: JobResult })),
  defineEvent("job.failed", z.strictObject({ jobId: Id, error: EngineError })),
  defineEvent("money.changed", z.strictObject({ status: MoneyStatus })),
  defineEvent("money.reconcileNeeded", z.strictObject({ reasons: ReconcileReasons.min(1), unsettledMicros: Micros })),
  defineEvent("engine.error", z.strictObject({ error: EngineError })),
] as const;

type EventSpec = (typeof EVENT_SPECS)[number];
export type EventType = EventSpec["type"];

export const EVENT_TYPES: readonly EventType[] = EVENT_SPECS.map((s) => s.type);

export const EventMessage = z.discriminatedUnion("type", nonEmpty(EVENT_SPECS.map((s) => s.message)));
export type EventMessage = z.infer<typeof EventMessage>;

export type EventPayload<T extends EventType> = Extract<EventMessage, { type: T }>["payload"];

type WithoutSeq<E> = E extends unknown ? Omit<E, "seq" | "bootId"> : never;

/** An event before the `EventLog` stamps it with its `seq` and `bootId`. */
export type UnsequencedEvent = WithoutSeq<EventMessage>;
