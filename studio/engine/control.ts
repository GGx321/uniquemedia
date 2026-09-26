import { z } from "zod";
import { AbsolutePath, ApiKey, EngineError, EngineNotice, Id, Settings, type EngineCommandMessage } from "../shared/engine";
import { DESCRIPTOR_MAX_ATTEMPTS } from "./avatars/descriptor";
import { PRICE_FETCH_TIMEOUT_MS } from "./money/prices";
import { MAX_ATTEMPT_MS } from "./openrouter/transport";

// Messages between main and the engine that are not part of the
// renderer-facing contract (studio/shared/engine). They never reach the
// renderer: main builds them itself and the engine accepts them only on its
// own MessagePort. The API key travels only here (invariant 10).

/**
 * The settings main owns and persists (userData/settings.json): T0 `Settings`
 * without the API key status, which main (stored, last4) and the engine
 * (rejected) derive at run time.
 */
export const EngineSettings = Settings.omit({ apiKey: true });
export type EngineSettings = z.infer<typeof EngineSettings>;

/** The first message, sent through `parentPort` together with the engine's MessagePort. */
export const EngineInit = z.strictObject({
  kind: z.literal("control"),
  type: z.literal("init"),
  ledgerPath: AbsolutePath,
  /**
   * `userData/library`, the folder the default settings name. The engine
   * creates it when the settings name it and it is missing (first run); a
   * folder the user chose is never created, it may be an unmounted volume.
   */
  defaultLibraryPath: AbsolutePath,
  /** `userData/raw`: where the body of a paid answer that could not be used is kept, redacted. */
  rawDir: AbsolutePath,
  settings: EngineSettings,
  encryptionAvailable: z.boolean(),
  /** A mock OpenRouter for end-to-end tests; honoured only by an E2E build (invariant 13). */
  openRouterBaseUrl: z.url({ protocol: /^https?$/ }).optional(),
  /**
   * What main has to tell the windows (the engine restarted, settings.json was
   * reset), oldest first. The engine keeps them pending in its snapshot and
   * emits each as an `engine.notice` in its own seq/bootId stream, so a window
   * never sees an event from a foreign bootId and one opened later still
   * shows them. Every (re)start gets the whole list again.
   */
  notices: z.array(EngineNotice),
});
export type EngineInit = z.infer<typeof EngineInit>;

/** Sent by main over the MessagePort after init, in order with the commands. */
export const HostControl = z.discriminatedUnion("type", [
  /** A key the user stored (or main decrypted on engine start); replaces any previous one. */
  z.strictObject({ kind: z.literal("control"), type: z.literal("apiKey.set"), key: ApiKey }),
  z.strictObject({ kind: z.literal("control"), type: z.literal("apiKey.clear") }),
  /**
   * Settings main has just persisted (and re-sent with init after a restart).
   * They are the truth: a library folder is taken only once it appears here.
   */
  z.strictObject({ kind: z.literal("control"), type: z.literal("settings.update"), settings: EngineSettings }),
]);
export type HostControl = z.infer<typeof HostControl>;

/** A question main asks the engine; the engine answers with an `EngineReply` carrying the same `callId`. */
export const HostCall = z.discriminatedUnion("type", [
  /**
   * Opens (creating on first use) the library at a folder the user picked in
   * main's dialog, and stages it. Only the engine touches the library; the
   * engine switches to the staged folder only on a `library.confirm` that
   * names it. A folder main gave up on (its deadline passed, so it never
   * sent a confirm) is therefore never taken.
   */
  z.strictObject({ kind: z.literal("control"), type: z.literal("library.open"), callId: Id, path: AbsolutePath }),
  /**
   * Commits the switch to a folder staged by `library.open` for this exact
   * path string: a folder never staged (or staged under another spelling of
   * the same string) is refused with VALIDATION rather than surveyed fresh —
   * opening it here, after the busy check below, would reopen the very
   * TOCTOU window this call exists to close (a paid command could start
   * during that survey and write into the old library while this call
   * answers ok). Main must send `library.open` again first.
   *
   * Already the live (and saved) folder is a harmless no-op, checked by the
   * same path string, without staging or a survey. Otherwise, refused with
   * IN_FLIGHT, the live library unchanged, while any avatar job or paid
   * command writes into it, or a pick or archive is in flight; main then
   * must not persist the new path. Once staged and not busy, the switch
   * itself has no await in it: main persists the path and pushes the rest of
   * the settings (`settings.update`) only after an ok reply.
   */
  z.strictObject({ kind: z.literal("control"), type: z.literal("library.confirm"), callId: Id, path: AbsolutePath }),
]);
export type HostCall = z.infer<typeof HostCall>;

/** The engine's answer to a `HostCall`: no `error` means it succeeded. */
export const EngineReply = z.strictObject({
  kind: z.literal("control"),
  type: z.literal("reply"),
  callId: Id,
  error: EngineError.optional(),
});
export type EngineReply = z.infer<typeof EngineReply>;

/** True for anything that claims to be a control message; commands and responses never do. */
export function isControlMessage(message: unknown): boolean {
  return typeof message === "object" && message !== null && "kind" in message && message.kind === "control";
}

/** Room for the engine's own work around its network waits: ledger fsyncs, the library write, a reserve queued behind a reconcile. */
const COMMAND_SLACK_MS = 30_000;

/**
 * How long main waits for the answer to a command before it answers INTERNAL
 * itself; a command not listed gets main's default (30 s). A paid command
 * must not be given up on while the engine may still be working on it: the
 * user would click again and pay twice. So createDraft waits for a price load
 * (every GET at once, one timeout) and every descriptor attempt at its
 * slowest. The estimates wait for a price load that times out, so the
 * fallback estimate still arrives.
 */
export const COMMAND_DEADLINE_MS: Partial<Record<EngineCommandMessage["type"], number>> = {
  "avatars.estimate": PRICE_FETCH_TIMEOUT_MS + 15_000,
  "avatars.estimateCandidates": PRICE_FETCH_TIMEOUT_MS + 15_000,
  // Answers with the job id once its checks and a price load are done; the job runs on and reports by events.
  "avatars.generateCandidates": PRICE_FETCH_TIMEOUT_MS + 15_000,
  "avatars.createDraft": PRICE_FETCH_TIMEOUT_MS + DESCRIPTOR_MAX_ATTEMPTS * MAX_ATTEMPT_MS + COMMAND_SLACK_MS,
};
