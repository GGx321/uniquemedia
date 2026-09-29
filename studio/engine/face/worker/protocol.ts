import { z } from "zod";
import { FaceGateConfigSchema, FacePoseSchema } from "../config";
import type { FaceVerdict } from "../verdict";

// T7c: the wire format between the engine and its face worker thread
// (faceWorker.ts, spawned by workerGate.ts). A worker is a trust boundary for
// DATA SHAPE — it is our own code, but a message that does not parse must
// never be acted on, so both ends validate with zod and a parse failure kills
// the worker (workerGate.ts) rather than being guessed at.

/** What the worker is started with (`workerData`): everything it needs to load, resolved by the engine — the worker itself never resolves a path. */
export const FaceWorkerInitSchema = z.strictObject({
  models: z.strictObject({ yunetPath: z.string().min(1), sfacePath: z.string().min(1) }),
  /** Where `@jsquash/*`'s codec `.wasm` files live (decode/realBackend.ts). */
  nodeModulesDir: z.string().min(1),
  /** onnxruntime-web's own `env.wasm.wasmPaths`, as `file://` URLs (decode/wasmPaths.ts). */
  wasmPaths: z.strictObject({ wasm: z.string().min(1), mjs: z.string().min(1) }),
  config: FaceGateConfigSchema,
});
export type FaceWorkerInit = z.infer<typeof FaceWorkerInitSchema>;

// `z.instanceof` is checked in the RECEIVING realm, which is also the realm
// that owns the structured-clone result, so the class identity matches.
const Bytes = z.instanceof(ArrayBuffer);

/** SFace's embedding size; the only length either end accepts. */
export const EMBEDDING_LENGTH = 128;

const Embedding = z.custom<Float32Array>(
  (value) => value instanceof Float32Array && value.length === EMBEDDING_LENGTH && value.every((x) => Number.isFinite(x)),
  `an embedding is exactly ${EMBEDDING_LENGTH} finite floats`,
);

/** Free text from the worker (an error message) is bounded: a runaway one must not become a megabyte of engine log or error detail. */
const MAX_MESSAGE_LENGTH = 2_000;
const Message = z.string().max(MAX_MESSAGE_LENGTH);

/** Fits `text` into the wire bound, keeping its beginning (where the cause is) and marking the cut; the sender's answer to a long (multi-issue zod) error, which would otherwise be a protocol violation that hides the real cause. */
export function boundedMessage(text: string): string {
  return text.length <= MAX_MESSAGE_LENGTH ? text : `${text.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
}

const RequestId =z.number().int().nonnegative();

/** Engine -> worker. `id` pairs a response with its request (one is in flight at a time, but a stale answer must never be mistaken for the current one). */
export const FaceWorkerRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("check"), id: RequestId, pose: FacePoseSchema, bytes: Bytes, masterEmbedding: Embedding }),
  z.strictObject({ type: z.literal("embed"), id: RequestId, bytes: Bytes }),
  /** S8: where the largest prominent face is, for the focus point of a placed photo. Detection only: no pose, no embedding. */
  z.strictObject({ type: z.literal("detect"), id: RequestId, bytes: Bytes }),
]);
export type FaceWorkerRequest = z.infer<typeof FaceWorkerRequestSchema>;

const finite = z.number().finite();
const faces = z.number().int().nonnegative();
export const FaceVerdictSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("match"), similarity: finite, faces, headRatio: finite }),
  z.strictObject({ kind: z.literal("mismatch"), similarity: finite, faces, headRatio: finite }),
  z.strictObject({ kind: z.literal("no-face"), faces: z.literal(0) }),
  z.strictObject({ kind: z.literal("multiple-faces"), faces }),
  z.strictObject({ kind: z.literal("skipped-by-pose"), faces }),
  z.strictObject({ kind: z.literal("unexpected-face"), faces, headRatio: finite }),
]) satisfies z.ZodType<FaceVerdict>;

/** A face box in SOURCE-image pixels (the worker scales it back from the normalised image it detected on). It may reach past the image edge a little: YuNet boxes do. */
const FaceBoxSchema = z.strictObject({ x: finite, y: finite, width: finite.positive(), height: finite.positive() });

/** Worker -> engine. `failed.code` tells the one expected failure (a reference with no face) apart from everything else, which is systemic. */
export const FaceWorkerResponseSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ready") }),
  z.strictObject({ type: z.literal("load-failed"), message: Message }),
  z.strictObject({ type: z.literal("checked"), id: RequestId, verdict: FaceVerdictSchema }),
  z.strictObject({ type: z.literal("embedded"), id: RequestId, embedding: Embedding }),
  /** `width`/`height` are the decoded source image's, so the engine can turn the box into fractions without a second decode. */
  z.strictObject({ type: z.literal("detected"), id: RequestId, width: z.number().int().positive(), height: z.number().int().positive(), face: FaceBoxSchema.nullable() }),
  z.strictObject({ type: z.literal("failed"), id: RequestId, code: z.enum(["no-face-in-reference", "error"]), message: Message }),
]);
export type FaceWorkerResponse = z.infer<typeof FaceWorkerResponseSchema>;
