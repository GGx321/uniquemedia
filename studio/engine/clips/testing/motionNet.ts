import type { ResponseMessage } from "../../../shared/engine";
import type { OpenRouterFetch, OpenRouterRequestInit, OpenRouterResponse } from "../../openrouter/types";
import { clipNetwork, command, type ClipEngine, type ClipNetworkOptions } from "./engineClipKit";

// Test-only (S5.WC3): the clip kit's fake OpenRouter with the CHAT route added, for the part C commands. Nothing here reaches the network. A chat request goes to `chat` (call number, request); every other
// route is the clip network's own. The chat bodies are kept, so a test can look at exactly what was sent.

export interface ChatReply {
  readonly status: number;
  readonly body: unknown;
}

export interface ChatRequest {
  readonly n: number;
  readonly body: string;
  json(): ChatBody;
}

export interface ChatBody {
  readonly model: string;
  readonly messages: { role: string; content: string | { type: string; text?: string; image_url?: { url: string } }[] }[];
  readonly response_format?: { json_schema?: { name?: string } };
  readonly reasoning?: { effort?: string };
}

export type ChatHandler = (request: ChatRequest) => ChatReply | Promise<ChatReply>;

/** A 2xx chat completion whose message is `content`, billed `cost` dollars. */
export function chatReply(content: string | object | null, cost = 0.0034): ChatReply {
  const text = content === null ? null : typeof content === "string" ? content : JSON.stringify(content);
  return { status: 200, body: { id: "gen-1", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }], usage: { prompt_tokens: 1400, completion_tokens: 600, cost } } };
}

/** A moderation refusal: a 400, free. */
export const MODERATED: ChatReply = { status: 400, body: { error: { message: "xAI blocked this request through content moderation." } } };

function response(reply: ChatReply): OpenRouterResponse {
  const bytes = new TextEncoder().encode(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
  let offset = 0;
  return {
    status: reply.status,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => {
          if (offset >= bytes.length) return { done: true };
          const value = bytes.subarray(offset, offset + 65_536);
          offset += 65_536;
          return { done: false, value };
        },
        cancel: async () => {
          offset = bytes.length;
        },
      }),
    },
  };
}

/** A promise a test settles from outside: how a chat answer is held while something else is tried. */
export function gate(): { promise: Promise<void>; open(): void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

export type MotionNetwork = ReturnType<typeof motionNetwork>;

export function motionNetwork(options: { chat?: ChatHandler; clip?: ClipNetworkOptions } = {}) {
  const clip = clipNetwork(options.clip);
  const chats: ChatRequest[] = [];
  let handler: ChatHandler = options.chat ?? (() => chatReply({ motions: [], frame: { capture: "unknown", phoneVisible: false, faceVisible: true } }));
  const fetch: OpenRouterFetch = async (url: string, init: OpenRouterRequestInit) => {
    const path = new URL(url).pathname.replace(/^\/api\/v1/, "");
    if (path !== "/chat/completions") return clip.fetch(url, init);
    const body = init.body ?? "{}";
    const n = chats.length + 1;
    const request: ChatRequest = { n, body, json: () => JSON.parse(body) as ChatBody };
    chats.push(request);
    return response(await handler(request));
  };
  return {
    ...clip,
    fetch,
    chats,
    /** Replaces the chat handler from now on. */
    setChat: (next: ChatHandler): void => {
      handler = next;
    },
  };
}

/** The user message of a chat request, parsed: the part C calls send their data there as JSON. */
export function userDataOf(request: ChatRequest): Record<string, unknown> {
  const user = request.json().messages.filter((m) => m.role === "user").at(-1)?.content;
  const text = typeof user === "string" ? user : (user?.find((part) => part.type === "text")?.text ?? "");
  return JSON.parse(text) as Record<string, unknown>;
}

/** The result or the error of a response, for a test that expects one of them. */
export function resultOf(response: ResponseMessage): unknown {
  if (!response.ok) throw new Error(`expected a result, got ${response.error.code}: ${response.error.detail ?? ""}`);
  return response.result;
}

export function errorOf(response: ResponseMessage) {
  if (response.ok) throw new Error(`expected an error, got ${JSON.stringify(response.result)}`);
  return response.error;
}

export function send(started: ClipEngine, type: string, payload: unknown): Promise<ResponseMessage> {
  return started.engine.handle(command(type, payload));
}
