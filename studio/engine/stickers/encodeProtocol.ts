import { z } from "zod";
import { STICKER_LIMITS } from "../../shared/stickers/apng";

// The wire between the engine and its own-sticker encode worker thread (encodeGate.ts, stickerEncodeWorker.ts; 3f.5). Both ends validate with
// zod, and a message that does not parse is never acted on: the gate ends the worker.
//
// The job names a RAW file the importer's ffmpeg decode wrote (rgba, one frame per source frame, `width * height * 4` bytes each); the worker
// reads the frames that last at least one 30 fps slot, one at a time, and writes an APNG. The raw frames never cross the thread boundary and
// never all sit in memory.

const RequestId = z.number().int().nonnegative();

export const EncodeRequestSchema = z
  .strictObject({
    type: z.literal("encode"),
    id: RequestId,
    /** The raw rgba file inside the library's staging folder, made by the importer's own ffmpeg call. */
    rawPath: z.string().min(1),
    width: z.number().int().min(1).max(STICKER_LIMITS.maxSide),
    height: z.number().int().min(1).max(STICKER_LIMITS.maxSide),
    /** The slots (30 fps frames) each source frame lasts; 0 means the frame is not in the loop. One per frame in the raw file. */
    slots: z.array(z.number().int().min(0).max(STICKER_LIMITS.maxLoopFrames)).min(1).max(STICKER_LIMITS.maxLoopFrames),
    /** The encoded file may not pass this many bytes. */
    maxBytes: z.number().int().positive().max(STICKER_LIMITS.maxBytes),
  })
  .refine((job) => {
    const loop = job.slots.reduce((sum, s) => sum + s, 0);
    return loop >= 1 && loop <= STICKER_LIMITS.maxLoopFrames;
  }, "the slots must add up to a loop of 1 to 300 frames");
export type EncodeRequest = z.infer<typeof EncodeRequestSchema>;

/** Free text from the worker is bounded: a runaway message must not become a megabyte of engine log. */
export const MAX_ENCODE_MESSAGE_LENGTH = 500;

export const EncodeResponseSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("encoded"), id: RequestId, apng: z.instanceof(ArrayBuffer) }),
  z.strictObject({ type: z.literal("failed"), id: RequestId, reason: z.enum(["too-large", "failed"]), message: z.string().max(MAX_ENCODE_MESSAGE_LENGTH) }),
]);
export type EncodeResponse = z.infer<typeof EncodeResponseSchema>;
