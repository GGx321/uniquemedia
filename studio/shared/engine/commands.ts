import { z } from "zod";
import { AvatarName, AvatarTraits } from "./avatar";
import { nonEmpty, ProtocolVersion } from "./envelope";
import { EngineError } from "./errors";
import { EventMessage } from "./events";
import { AbsolutePath, ApiKey, Count, Id, Micros, ModelId } from "./primitives";
import {
  ApiKeyStatus,
  AvatarSummary,
  Draft,
  Estimate,
  JobState,
  MoneyStatus,
  NetworkConcurrency,
  PhotoSummary,
  ReconcileResult,
  RunRequest,
  Settings,
} from "./state";

const Empty = z.strictObject({});

function defineCommand<const T extends string, P extends z.ZodType, R extends z.ZodType>(
  type: T,
  payload: P,
  result: R,
) {
  return {
    type,
    payload,
    result,
    command: z.strictObject({
      v: ProtocolVersion,
      id: Id,
      kind: z.literal("command"),
      type: z.literal(type),
      payload,
    }),
    response: z.strictObject({
      v: ProtocolVersion,
      id: Id,
      kind: z.literal("response"),
      type: z.literal(type),
      ok: z.literal(true),
      result,
    }),
  };
}

/**
 * Everything a new window needs to rebuild its state, the avatar wizard
 * included. Events with the same `bootId` and `seq > lastSeq` are applied on
 * top (the window can close while the app keeps running on macOS). A new
 * `bootId` means the engine restarted and its seq numbering began again.
 */
export const Snapshot = z.strictObject({
  bootId: Id,
  lastSeq: Count,
  settings: Settings,
  money: MoneyStatus,
  avatars: z.array(AvatarSummary),
  drafts: z.array(Draft),
  jobs: z.array(JobState),
});

/**
 * Events after a seq, or `gap` when older events were evicted or the caller's
 * `bootId` belongs to an earlier engine; either way a snapshot is needed.
 */
export const EventsSince = z.discriminatedUnion("gap", [
  z.strictObject({ gap: z.literal(true) }),
  z.strictObject({
    gap: z.literal(false),
    events: z
      .array(EventMessage)
      .refine((events) => events.every((e, i) => i === 0 || e.seq > (events[i - 1]?.seq ?? 0)), {
        message: "events must be in strictly increasing seq order",
      }),
  }),
]);

/**
 * The worst case the user saw and agreed to. A paid command whose current
 * worst case is higher is refused with PRICE_CHANGED before anything is spent.
 */
const AcceptedWorst = { acceptedWorstMicros: Micros };

/** Commands main answers itself; the API key never travels to the engine inside a command. */
const MAIN_ONLY_SPECS = [
  defineCommand("settings.setApiKey", z.strictObject({ key: ApiKey }), ApiKeyStatus),
  defineCommand("settings.clearApiKey", Empty, ApiKeyStatus),
] as const;

/** Commands main forwards to the engine. */
const ENGINE_SPECS = [
  // settings
  defineCommand("settings.get", Empty, Settings),
  defineCommand("settings.setBudget", z.strictObject({ monthlyBudgetMicros: Micros }), Settings),
  defineCommand("settings.setLibraryPath", z.strictObject({ path: AbsolutePath }), Settings),
  defineCommand("settings.setModels", z.strictObject({ imageModel: ModelId, textModel: ModelId }), Settings),
  defineCommand("settings.setConcurrency", z.strictObject({ network: NetworkConcurrency }), Settings),
  // money
  defineCommand("money.status", Empty, MoneyStatus),
  defineCommand("money.reconcile", Empty, ReconcileResult),
  // avatars (2a). One avatar job = descriptor + candidate batches + age checks, under one cap.
  // A draft is an avatar with status "draft"; picking a candidate makes it active.
  defineCommand("avatars.list", Empty, z.strictObject({ avatars: z.array(AvatarSummary) })),
  defineCommand("avatars.estimate", z.strictObject({ traits: AvatarTraits }), Estimate),
  defineCommand(
    "avatars.createDraft",
    z.strictObject({ traits: AvatarTraits, ...AcceptedWorst }),
    z.strictObject({ draft: Draft }),
  ),
  defineCommand(
    "avatars.generateCandidates",
    z.strictObject({ avatarId: Id, ...AcceptedWorst }),
    z.strictObject({ jobId: Id }),
  ),
  defineCommand("avatars.cancel", z.strictObject({ jobId: Id }), z.strictObject({ jobId: Id })),
  defineCommand(
    "avatars.pick",
    z.strictObject({ avatarId: Id, photoId: Id, name: AvatarName }),
    z.strictObject({ avatar: AvatarSummary }),
  ),
  defineCommand("avatars.archive", z.strictObject({ avatarId: Id }), z.strictObject({ avatar: AvatarSummary })),
  // photo runs (2b placeholders)
  defineCommand("runs.estimate", RunRequest, z.strictObject({ estimate: Estimate })),
  defineCommand("runs.start", RunRequest.extend(AcceptedWorst), z.strictObject({ runId: Id, jobId: Id })),
  defineCommand("runs.cancel", z.strictObject({ runId: Id }), z.strictObject({ runId: Id })),
  defineCommand("runs.resume", z.strictObject({ runId: Id }), z.strictObject({ runId: Id, jobId: Id })),
  defineCommand("photos.list", z.strictObject({ avatarId: Id }), z.strictObject({ photos: z.array(PhotoSummary) })),
  // engine
  defineCommand("engine.snapshot", Empty, Snapshot),
  defineCommand("engine.events", z.strictObject({ afterSeq: Count, bootId: Id }), EventsSince),
] as const;

const COMMAND_SPECS = [...MAIN_ONLY_SPECS, ...ENGINE_SPECS] as const;

type CommandSpec = (typeof COMMAND_SPECS)[number];
export type CommandType = CommandSpec["type"];
type EngineCommandType = (typeof ENGINE_SPECS)[number]["type"];

export const COMMAND_TYPES: readonly CommandType[] = COMMAND_SPECS.map((s) => s.type);
export const MAIN_ONLY_COMMANDS: readonly CommandType[] = MAIN_ONLY_SPECS.map((s) => s.type);
export const ENGINE_COMMAND_TYPES: readonly EngineCommandType[] = ENGINE_SPECS.map((s) => s.type);

export const CommandType = z.enum(COMMAND_TYPES);

export const CommandMessage = z.discriminatedUnion("type", nonEmpty(COMMAND_SPECS.map((s) => s.command)));
export type CommandMessage = z.infer<typeof CommandMessage>;
export type CommandPayload<T extends CommandType> = Extract<CommandMessage, { type: T }>["payload"];

/** The commands the engine accepts: everything except the main-only key commands. */
export const EngineCommandMessage = z.discriminatedUnion("type", nonEmpty(ENGINE_SPECS.map((s) => s.command)));
export type EngineCommandMessage = z.infer<typeof EngineCommandMessage>;

export const OkResponse = z.discriminatedUnion("type", nonEmpty(COMMAND_SPECS.map((s) => s.response)));
export type OkResponse = z.infer<typeof OkResponse>;
export type CommandResult<T extends CommandType> = Extract<OkResponse, { type: T }>["result"];

/**
 * A failed command. `id` and `type` are null when the command itself could not
 * be parsed far enough to know them, so the caller still gets an answer.
 */
export const ErrorResponse = z.strictObject({
  v: ProtocolVersion,
  id: Id.nullable(),
  kind: z.literal("response"),
  type: CommandType.nullable(),
  ok: z.literal(false),
  error: EngineError,
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;

/** A response echoes its command's `id` and `type`; `ok` tells success from failure. */
export const ResponseMessage = z.discriminatedUnion("ok", [OkResponse, ErrorResponse]);
export type ResponseMessage = z.infer<typeof ResponseMessage>;

export type Snapshot = z.infer<typeof Snapshot>;
export type EventsSince = z.infer<typeof EventsSince>;
