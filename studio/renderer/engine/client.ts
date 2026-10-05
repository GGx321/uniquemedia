import { z } from "zod";
import {
  CommandMessage,
  type CommandPayload,
  type CommandResult,
  type CommandType,
  EngineError as EngineErrorSchema,
  type EngineError,
  EventMessage,
  MediaPickResult,
  type OkResponse,
  PROTOCOL_VERSION,
  ResponseMessage,
} from "../../shared/engine";

/** A command's outcome: the typed result, or the engine's error. Transport failures arrive as INTERNAL. */
export type EngineReply<T extends CommandType> =
  | { ok: true; result: CommandResult<T> }
  | { ok: false; error: EngineError };

/** `unavailable`: a release build whose preload exposes no engine bridge; every command fails. */
export type EngineClientKind = "window" | "mock" | "unavailable";

/**
 * The only way the renderer talks to the engine. Both directions are checked
 * against the T0 contract: a command is parsed before it leaves, and every
 * response and event is parsed on arrival (the preload is a trust boundary).
 */
export interface EngineClient {
  /** `window`: the real engine behind `window.studio`; `mock`: the dev-only stand-in (no real images); `unavailable`: no engine at all. */
  readonly kind: EngineClientKind;
  request<T extends CommandType>(type: T, payload: CommandPayload<T>): Promise<EngineReply<T>>;
  subscribe(listener: (event: EventMessage) => void): () => void;
  /**
   * Where the window gets the picture of a text preview the engine answered: the mock's own address for it (a data URL, since the dev
   * build has no `studio-media://`). Absent on the real client, whose pictures are `studio-media://text/<previewId>` (lib/media.ts).
   * Null for an id the mock does not hold (never given, or evicted).
   */
  textPreviewUrl?(previewId: string): string | null;
  /**
   * Where the window gets a built-in sticker's picture (3d.3b): the mock's own stand-in (a data URL; the dev build has no
   * `studio-media://`). Absent on the real client, whose stickers are `studio-media://sticker/<stickerId>` (lib/media.ts).
   */
  stickerUrl?(stickerId: string): string | null;
  /**
   * Where the window gets an OWN sticker's picture (3f.5): the mock's stand-in for the stored one (a data URL). Absent on the real client, whose own
   * stickers are `studio-media://media/<mediaId>` (lib/media.ts). Null for a media the mock does not hold as a sticker.
   */
  ownStickerUrl?(mediaId: string): string | null;
  /**
   * 3f.6 round 2 (M13): imports files dropped onto «Мои». The window hands over the dropped `File` objects and nothing else; the real
   * client's preload maps them to the paths the OS gave them, and main takes those as its own dialog's picks. Answers like a pick
   * (`media.pickImport`), checked. Absent where no drop door exists (an older preload, a mock without one): the tab offers the dialog only.
   */
  importDropped?(files: readonly File[]): Promise<DropReply>;
}

/** What a drop came to: a pick's result, or the error that refused it. */
export type DropReply = { readonly ok: true; readonly result: MediaPickResult } | { readonly ok: false; readonly error: EngineError };

const DropReplySchema = z.discriminatedUnion("ok", [z.strictObject({ ok: z.literal(true), result: MediaPickResult }), z.strictObject({ ok: z.literal(false), error: EngineErrorSchema })]);

/** A drop's answer as it crossed the bridge (a trust boundary), checked against a pick's result; anything else is INTERNAL. */
export function parseDropReply(raw: unknown): DropReply {
  const parsed = DropReplySchema.safeParse(raw);
  return parsed.success ? parsed.data : internal("importDropped: the answer breaks the contract");
}

/** The wire: what `window.studio` exposes, and what the mock engine implements. */
export interface EngineBridge {
  request(command: CommandMessage): Promise<unknown>;
  subscribe(listener: (event: unknown) => void): () => void;
}

function internal(detail: string): { ok: false; error: EngineError } {
  return { ok: false, error: { code: "INTERNAL", detail } };
}

/**
 * `ResponseMessage` is a union discriminated by `type`, so a parsed response
 * whose `type` equals the command's carries that command's result.
 */
function isResultFor<T extends CommandType>(result: unknown, response: OkResponse, type: T): result is CommandResult<T> {
  return response.type === type && result === response.result;
}

function randomId(): string {
  return crypto.randomUUID();
}

/** Adapts a wire-level bridge to the typed, validating `EngineClient`. */
export function createEngineClient(
  bridge: EngineBridge,
  kind: EngineClientKind,
  newId: () => string = randomId,
): EngineClient {
  return {
    kind,
    async request<T extends CommandType>(type: T, payload: CommandPayload<T>): Promise<EngineReply<T>> {
      const command = CommandMessage.safeParse({ v: PROTOCOL_VERSION, id: newId(), kind: "command", type, payload });
      if (!command.success) {
        return { ok: false, error: { code: "VALIDATION", detail: `${type}: the payload breaks the contract` } };
      }

      let raw: unknown;
      try {
        raw = await bridge.request(command.data);
      } catch {
        return internal(`${type}: the engine bridge failed`);
      }

      const parsed = ResponseMessage.safeParse(raw);
      if (!parsed.success) return internal(`${type}: the response breaks the contract`);
      const response = parsed.data;
      if (response.id !== null && response.id !== command.data.id) return internal(`${type}: a response for another command`);
      if (!response.ok) return { ok: false, error: response.error };
      const result: unknown = response.result;
      if (!isResultFor(result, response, type)) return internal(`${type}: a response of another type`);
      return { ok: true, result };
    },
    subscribe(listener: (event: EventMessage) => void): () => void {
      return bridge.subscribe((raw) => {
        const parsed = EventMessage.safeParse(raw);
        // An event that breaks the contract is dropped; the seq hole it leaves makes the store resync.
        if (parsed.success) listener(parsed.data);
      });
    },
  };
}

/** The client of a build without an engine: nothing is sent, every command answers INTERNAL. */
export function unavailableClient(): EngineClient {
  return {
    kind: "unavailable",
    async request() {
      return internal("the engine bridge is missing from this build");
    },
    subscribe() {
      return () => {};
    },
  };
}
