import { z } from "zod";
import { CAPTION_ISSUES } from "../../../shared/engine";
import { TextStyle } from "../../../shared/engine/montage";
import { TEXT_FONT_KEYS } from "../fonts";
import { DEFAULT_RASTER_LIMITS, RASTER_ERROR_CODES } from "../rasterTypes";

// The wire format between the engine and its text worker thread (textWorker.ts, spawned by textGate.ts), the
// face worker's pattern (face/worker/protocol.ts): a worker is a trust boundary for DATA SHAPE, so both ends
// validate with zod and a message that does not parse kills the worker rather than being guessed at.
//
// `caption` (3b.4b) is a whole layer in and a picture with its resolved layout out: the caption rules, the layout
// (with its synchronous `measure`), the template and the rasteriser all live inside the worker, handled by the same
// lane, deadline and restart rules as `render` and `measure`.

/** What the worker is started with (`workerData`): the paths the engine resolved; the worker resolves none itself. */
export const TextWorkerInitSchema = z.strictObject({
  wasmPath: z.string().min(1),
  fontDir: z.string().min(1),
});
export type TextWorkerInit = z.infer<typeof TextWorkerInitSchema>;

const RequestId = z.number().int().nonnegative();
const Font = z.enum(TEXT_FONT_KEYS);
/**
 * No length bound here on purpose: the gate refuses an oversized SVG before sending it, and the rasteriser inside
 * the worker answers `SVG_TOO_LARGE` as a `failed` response. A zod bound would make the worker throw, and die.
 */
const Svg = z.string();

/** A colour as the contract states it. The worker builds markup from it, so nothing else may get through. */
const HexColor = z.string().regex(/^#[0-9a-f]{6}$/);

/** Engine -> worker. `id` pairs an answer with its request; one is in flight at a time. */
export const TextWorkerRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("render"), id: RequestId, svg: Svg, font: Font }),
  z.strictObject({ type: z.literal("measure"), id: RequestId, svg: Svg, font: Font }),
  /**
   * A text layer to a picture. `value` has no length bound here for the same reason `svg` has none: the caption rules answer
   * an over-long text as CAPTION_INVALID, where a zod bound would make the worker throw and die.
   */
  z.strictObject({ type: z.literal("caption"), id: RequestId, value: z.string(), font: Font, style: TextStyle, color: HexColor, scale: z.number().min(0.5).max(2) }),
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

/** What a text layer's resolved layout stores: the size the text was drawn at, what each of its one or two lines says, and the picture's box. */
const ResolvedLayout = z.strictObject({
  fontSize: finite.positive(),
  lines: z.array(z.string().max(400)).min(1).max(2),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

const dimensions = { width: z.number().int().positive(), height: z.number().int().positive() };
const withinCanvas = (r: { width: number; height: number }): boolean => r.width * r.height <= DEFAULT_RASTER_LIMITS.maxPixels;

/** Worker -> engine. `workerMs` is the time the worker spent on the call itself, so the gate can tell the round trip's own overhead. */
export const TextWorkerResponseSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ready") }),
  z.strictObject({ type: z.literal("load-failed"), message: Message }),
  z
    .strictObject({ type: z.literal("rendered"), id: RequestId, ...dimensions, png: Png, workerMs: finite.nonnegative() })
    .refine(withinCanvas, { message: `a canvas is at most ${DEFAULT_RASTER_LIMITS.maxPixels} pixels`, path: ["width"] }),
  z.strictObject({ type: z.literal("measured"), id: RequestId, box: Box.nullable(), workerMs: finite.nonnegative() }),
  z
    .strictObject({ type: z.literal("captioned"), id: RequestId, ...dimensions, png: Png, layout: ResolvedLayout, workerMs: finite.nonnegative() })
    .refine(withinCanvas, { message: `a canvas is at most ${DEFAULT_RASTER_LIMITS.maxPixels} pixels`, path: ["width"] })
    .refine((r) => r.layout.width === r.width && r.layout.height === r.height, { message: "the layout's box is the picture's", path: ["layout"] }),
  /**
   * `fatal` means the worker's resvg instance is broken and the gate must replace the worker. `captionIssue` is the rule a
   * `CAPTION_INVALID` names, and comes with that code only, like the contract's `TEXT_INVALID`.
   */
  z
    .strictObject({ type: z.literal("failed"), id: RequestId, code: z.enum(RASTER_ERROR_CODES), message: Message, fatal: z.boolean(), captionIssue: z.enum(CAPTION_ISSUES).optional() })
    .refine((r) => (r.code === "CAPTION_INVALID") === (r.captionIssue !== undefined), { message: "captionIssue comes with CAPTION_INVALID only", path: ["captionIssue"] }),
]);
export type TextWorkerResponse = z.infer<typeof TextWorkerResponseSchema>;
