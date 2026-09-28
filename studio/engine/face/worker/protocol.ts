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
const Embedding = z.custom<Float32Array>((value) => value instanceof Float32Array && value.length > 0, "an embedding is a non-empty Float32Array");

const RequestId = z.number().int().nonnegative();

/** Engine -> worker. `id` pairs a response with its request (one is in flight at a time, but a stale answer must never be mistaken for the current one). */
export const FaceWorkerRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("check"), id: RequestId, pose: FacePoseSchema, bytes: Bytes, masterEmbedding: Embedding }),
  z.strictObject({ type: z.literal("embed"), id: RequestId, bytes: Bytes }),
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

/** Worker -> engine. `failed.code` tells the one expected failure (a reference with no face) apart from everything else, which is systemic. */
export const FaceWorkerResponseSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ready") }),
  z.strictObject({ type: z.literal("load-failed"), message: z.string() }),
  z.strictObject({ type: z.literal("checked"), id: RequestId, verdict: FaceVerdictSchema }),
  z.strictObject({ type: z.literal("embedded"), id: RequestId, embedding: Embedding }),
  z.strictObject({ type: z.literal("failed"), id: RequestId, code: z.enum(["no-face-in-reference", "error"]), message: z.string() }),
]);
export type FaceWorkerResponse = z.infer<typeof FaceWorkerResponseSchema>;
