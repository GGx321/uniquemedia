import { z } from "zod";
import { TEXT_FONT_KEYS } from "../fonts";
import { DEFAULT_RASTER_LIMITS, RASTER_ERROR_CODES } from "../rasterTypes";

// The wire format between the engine and its text worker thread (textWorker.ts, spawned by textGate.ts), the
// face worker's pattern (face/worker/protocol.ts): a worker is a trust boundary for DATA SHAPE, so both ends
// validate with zod and a message that does not parse kills the worker rather than being guessed at.
//
// The union is open for 3b.4b: `layoutAndRender { id, layer } -> { layout, png }` is one more request and one
// more response here, handled by the same lane, deadline and restart rules, with the layout (and its
// synchronous `measure`) living inside the worker.

/** What the worker is started with (`workerData`): the paths the engine resolved; the worker resolves none itself. */
export const TextWorkerInitSchema = z.strictObject({
  wasmPath: z.string().min(1),
  fontDir: z.string().min(1),
});
export type TextWorkerInit = z.infer<typeof TextWorkerInitSchema>;

const RequestId = z.number().int().nonnegative();
const Font = z.enum(TEXT_FONT_KEYS);
/** UTF-16 units never exceed UTF-8 bytes, so this only rejects what the worker's own byte cap would reject too. */
const Svg = z.string().max(DEFAULT_RASTER_LIMITS.maxSvgBytes);

/** Engine -> worker. `id` pairs an answer with its request; one is in flight at a time. */
export const TextWorkerRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("render"), id: RequestId, svg: Svg, font: Font }),
  z.strictObject({ type: z.literal("measure"), id: RequestId, svg: Svg, font: Font }),
]);
export type TextWorkerRequest = z.infer<typeof TextWorkerRequestSchema>;

/** Free text from the worker (an error message) is bounded: a runaway one must not become a megabyte of engine log. */
const MAX_MESSAGE_LENGTH = 2_000;
const Message = z.string().max(MAX_MESSAGE_LENGTH);

/** Fits `text` into the wire bound, keeping its beginning (where the cause is) and marking the cut. */
export function boundedMessage(text: string): string {
  return text.length <= MAX_MESSAGE_LENGTH ? text : `${text.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
}

const finite = z.number().finite();
const Box = z.strictObject({ x: finite, y: finite, width: finite.nonnegative(), height: finite.nonnegative() });
const Png = z.instanceof(ArrayBuffer).refine((b) => b.byteLength > 0 && b.byteLength <= DEFAULT_RASTER_LIMITS.maxOutputBytes, {
  message: `a PNG is 1 to ${DEFAULT_RASTER_LIMITS.maxOutputBytes} bytes`,
});

/** Worker -> engine. `workerMs` is the time the worker spent on the call itself, so the gate can tell the round trip's own overhead. */
export const TextWorkerResponseSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ready") }),
  z.strictObject({ type: z.literal("load-failed"), message: Message }),
  z
    .strictObject({ type: z.literal("rendered"), id: RequestId, width: z.number().int().positive(), height: z.number().int().positive(), png: Png, workerMs: finite.nonnegative() })
    .refine((r) => r.width * r.height <= DEFAULT_RASTER_LIMITS.maxPixels, { message: `a canvas is at most ${DEFAULT_RASTER_LIMITS.maxPixels} pixels`, path: ["width"] }),
  z.strictObject({ type: z.literal("measured"), id: RequestId, box: Box.nullable(), workerMs: finite.nonnegative() }),
  /** `fatal` means the worker's resvg instance is broken and the gate must replace the worker. */
  z.strictObject({ type: z.literal("failed"), id: RequestId, code: z.enum(RASTER_ERROR_CODES), message: Message, fatal: z.boolean() }),
]);
export type TextWorkerResponse = z.infer<typeof TextWorkerResponseSchema>;
