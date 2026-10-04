import { z } from "zod";

// The wire between the engine and its own-photo decode worker thread (decodeGate.ts, photoDecodeWorker.ts; 3f.2 fix round 1, H1). Both ends
// validate with zod, and a message that does not parse is never acted on: the gate ends the worker.

/** What the worker is started with (`workerData`): where the codecs' `.wasm` files are, and the most pixels it will decode. The worker resolves no path itself. */
export const DecodeWorkerInitSchema = z.strictObject({
  nodeModulesDir: z.string().min(1),
  maxPixels: z.number().int().positive(),
});
export type DecodeWorkerInit = z.infer<typeof DecodeWorkerInitSchema>;

const RequestId = z.number().int().nonnegative();
const Pixels = z.number().int().positive();

/** Engine -> worker: one picture's bytes (JPEG or PNG), transferred. */
export const DecodeRequestSchema = z.strictObject({ type: z.literal("decode"), id: RequestId, bytes: z.instanceof(ArrayBuffer) });
export type DecodeRequest = z.infer<typeof DecodeRequestSchema>;

/** Free text from the worker is bounded: a runaway message must not become a megabyte of engine log. */
export const MAX_DECODE_MESSAGE_LENGTH = 2_000;

/** Worker -> engine: the RGBA pixels (transferred), or why the picture could not be read. */
export const DecodeResponseSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("decoded"), id: RequestId, width: Pixels, height: Pixels, data: z.instanceof(ArrayBuffer) }),
  z.strictObject({ type: z.literal("failed"), id: RequestId, message: z.string().max(MAX_DECODE_MESSAGE_LENGTH) }),
]);
export type DecodeResponse = z.infer<typeof DecodeResponseSchema>;
