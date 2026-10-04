import { Worker } from "node:worker_threads";
import { DecodeWorkerInitSchema, type DecodeWorkerInit } from "./decodeProtocol";

/**
 * The real `spawnWorker` for `createDecodeGate`: starts the built decode worker entry (`photoDecodeWorker.ts`, bundled as
 * `out-studio/engine/photoDecodeWorker.js`) with what it needs to load in `workerData`. `workerUrl` is a `file://` URL the CALLER resolves
 * from its own `import.meta.url` (it works unchanged inside `app.asar`, as the face worker's does); `init` is validated here too, so a wiring
 * mistake fails at the engine with a zod message, not as a cryptic worker crash.
 */
export function createDecodeWorkerSpawner(workerUrl: URL | string, init: DecodeWorkerInit): () => Worker {
  const validated = DecodeWorkerInitSchema.parse(init);
  return () => new Worker(workerUrl, { workerData: validated });
}
