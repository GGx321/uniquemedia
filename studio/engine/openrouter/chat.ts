import { Buffer } from "node:buffer";
import { z } from "zod";
import { jpegDataUrl } from "./image";
import { runPaidAttempt, type ClientContext, type Interpretation } from "./transport";
import type { ChatMessage, ChatParams, ChatResult } from "./types";

/** Lenient: only `choices[0].message` is required; its content may be null (reported as EMPTY_CONTENT). */
const ChatEnvelope = z.object({ choices: z.array(z.unknown()).min(1) });
const FirstChoice = z.object({
  message: z.object({ content: z.string().nullish() }),
  finish_reason: z.string().nullish(),
});

type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
type WireMessage = { role: ChatMessage["role"]; content: string | Part[] };

function interpretChat(body: unknown): Interpretation<{ content: string; finishReason: string | null }> {
  if (body === undefined) return { ok: false, kind: "UNUSABLE_PAID_RESPONSE", why: "the body is not JSON" };
  const envelope = ChatEnvelope.safeParse(body);
  if (!envelope.success) return { ok: false, kind: "UNUSABLE_PAID_RESPONSE", why: "the body has no choices[0]" };
  const first = FirstChoice.safeParse(envelope.data.choices[0]);
  if (!first.success) return { ok: false, kind: "UNUSABLE_PAID_RESPONSE", why: "choices[0].message is missing" };
  const finishReason = first.data.finish_reason ?? null;
  const content = first.data.message.content;
  if (content === null || content === undefined || content === "") {
    return { ok: false, kind: "EMPTY_CONTENT", why: `the message has no content (finish_reason: ${finishReason ?? "none"})` };
  }
  return { ok: true, value: { content, finishReason } };
}

/** The images go after the text of the last user message. */
function wireMessages(messages: readonly ChatMessage[], images: readonly Uint8Array[]): WireMessage[] {
  const wire: WireMessage[] = messages.map((m) => ({ role: m.role, content: m.content }));
  if (images.length === 0) return wire;
  const last = wire.findLastIndex((m) => m.role === "user");
  const target = messages[last];
  if (target === undefined) throw new TypeError("images need a user message to attach to");
  wire[last] = {
    role: "user",
    content: [
      { type: "text", text: target.content },
      ...images.map((img, i): Part => ({ type: "image_url", image_url: { url: jpegDataUrl(img, `image ${i}`) } })),
    ],
  };
  return wire;
}

/** Role markers and separators the chat template adds per message; generous. */
const TEMPLATE_TOKENS_PER_MESSAGE = 16;
/**
 * Prompt tokens allowed per input image. Image tokens are not bounded by
 * bytes; in the spike a whole age check (one 768 px image plus text) used
 * 658 prompt tokens on average, 747 at most.
 */
export const CHAT_IMAGE_TOKEN_ALLOWANCE = 1_500;

/**
 * A lower bound under the caller's prompt-token ceiling (money/estimate.ts),
 * so a ceiling set too low cannot make the reserve an underestimate: the
 * message text and the JSON schema count one token per UTF-8 byte (a
 * byte-level tokenizer never emits more), plus template tokens per message and
 * an allowance per image.
 */
function promptTokenFloor(params: ChatParams, images: number): number {
  const textBytes = params.messages.reduce((sum, m) => sum + Buffer.byteLength(m.content, "utf8"), 0);
  const schemaBytes = params.jsonSchema ? Buffer.byteLength(JSON.stringify(params.jsonSchema), "utf8") : 0;
  return textBytes + schemaBytes + params.messages.length * TEMPLATE_TOKENS_PER_MESSAGE + images * CHAT_IMAGE_TOKEN_ALLOWANCE;
}

/** One chat attempt (`POST /chat/completions`) with usage accounting on. */
export async function chat(ctx: ClientContext, params: ChatParams): Promise<ChatResult> {
  const images = params.images ?? [];
  const worstMicros = params.priceBook.chatWorstCase({
    model: params.model,
    maxTokens: params.maxTokens,
    inputTokens: Math.max(params.inputTokens, promptTokenFloor(params, images.length)),
    images: images.length,
  });
  const result = await runPaidAttempt(ctx, {
    attemptId: params.attemptId,
    jobId: params.jobId,
    scope: params.scope,
    model: params.model,
    worstMicros,
    budget: params.budget,
    signal: params.signal,
    path: "/chat/completions",
    buildBody: () => ({
      model: params.model,
      messages: wireMessages(params.messages, images),
      max_tokens: params.maxTokens,
      reasoning: { effort: params.reasoningEffort },
      usage: { include: true },
      ...(params.jsonSchema
        ? { response_format: { type: "json_schema", json_schema: { name: params.jsonSchema.name, strict: true, schema: params.jsonSchema.schema } } }
        : {}),
    }),
    interpret: interpretChat,
  });
  if (result.status !== "ok") return result;
  const { value, ...paid } = result;
  return { ...paid, content: value.content, finishReason: value.finishReason };
}
