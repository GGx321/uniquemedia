import { z } from "zod";
import { AbsolutePath, ApiKey, EngineError, EngineNotice, Id, Settings } from "../shared/engine";

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
   * main's dialog, and stages it. Only the engine touches the library; main
   * persists the new path after an ok reply, and the engine switches to the
   * staged folder only when a `settings.update` names it. A folder main gave
   * up on (its deadline passed) is therefore never taken.
   */
  z.strictObject({ kind: z.literal("control"), type: z.literal("library.open"), callId: Id, path: AbsolutePath }),
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
