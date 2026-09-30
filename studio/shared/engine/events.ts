import { z } from "zod";
import { nonEmpty, ProtocolVersion, Seq } from "./envelope";
import { EngineError } from "./errors";
import { Montage } from "./montage";
import { Count, Id, Micros } from "./primitives";
import { VideoSummary } from "./video";
import { AvatarSummary, Draft, EngineNotice, ExportStatus, JobCancelled, JobFailed, JobProgress, JobResult, MoneyStatus, ReconcileReasons, Settings } from "./state";

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

/**
 * Engine → renderer notifications. Each carries a `seq` and the `bootId` of the engine that emitted it.
 *
 * - `job.progress`, `job.failed`, `job.cancelled`: each carries the job's kind, avatar and (a run) runId; `job.done` carries the same in its `result`.
 * - `job.cancelled`: the job stopped on a user's cancel; attempts it aborted count at their worst case until reconciled.
 * - `settings.changed`: the whole settings, key status included (`rejected` after a 401), whenever any of them changed.
 * - `avatar.changed`: a saved avatar was created (a draft was picked) or changed; a draft with its id is gone.
 * - `draft.changed`: a draft was created or changed (e.g. a batch of candidates landed).
 * - `engine.error`: a failure that belongs to no command.
 * - `engine.notice`: something the windows must be told that is not an error; also pending in the snapshot.
 * - `video.changed`: a video record was committed or changed (`upserted`, with its record and current file state), or is gone (`removed`).
 * - `montage.changed`: a montage draft was created or saved (`upserted`, with the draft), or deleted (`removed`).
 * - `export.status`: the export folder's status changed (not on every check): the Render button follows the disk live.
 */
const EVENT_SPECS = [
  defineEvent("job.progress", JobProgress),
  defineEvent("job.done", z.strictObject({ jobId: Id, result: JobResult })),
  defineEvent("job.failed", JobFailed),
  defineEvent("job.cancelled", JobCancelled),
  defineEvent("money.changed", z.strictObject({ status: MoneyStatus })),
  defineEvent("money.reconcileNeeded", z.strictObject({ reasons: ReconcileReasons.min(1), unsettledMicros: Micros })),
  /** `librarySwitchGeneration` is `Snapshot`'s own counter: it says whether this settings.changed is a genuine library switch. */
  defineEvent("settings.changed", z.strictObject({ settings: Settings, librarySwitchGeneration: Count })),
  defineEvent("avatar.changed", z.strictObject({ avatar: AvatarSummary })),
  defineEvent("draft.changed", z.strictObject({ draft: Draft })),
  defineEvent("engine.error", z.strictObject({ error: EngineError })),
  defineEvent("engine.notice", z.strictObject({ notice: EngineNotice })),
  defineEvent(
    "video.changed",
    z.discriminatedUnion("change", [
      z.strictObject({ change: z.literal("upserted"), video: VideoSummary }),
      z.strictObject({ change: z.literal("removed"), videoId: Id, avatarId: Id }),
    ]),
  ),
  defineEvent(
    "montage.changed",
    z.discriminatedUnion("change", [
      z.strictObject({ change: z.literal("upserted"), montage: Montage }),
      z.strictObject({ change: z.literal("removed"), montageId: Id, avatarId: Id }),
    ]),
  ),
  defineEvent("export.status", z.strictObject({ exportStatus: ExportStatus })),
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
