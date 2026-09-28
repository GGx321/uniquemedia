import { Worker } from "node:worker_threads";
import { FaceWorkerInitSchema, type FaceWorkerInit } from "./protocol";

/**
 * The real `spawnWorker` for `createWorkerFaceGate`: starts the built face
 * worker entry (`faceWorker.ts`, bundled as `out-studio/engine/faceWorker.js`)
 * with everything it needs to load in `workerData`.
 *
 * `workerUrl` is a `file://` URL (or an absolute path) the CALLER resolves —
 * the engine's entry (main.ts) derives it from its own `import.meta.url`,
 * never from `process`, and it works unchanged inside `app.asar` on macOS and
 * Windows (Node/Electron read the asar transparently; nothing is unpacked).
 * `init` is validated here too, so a wiring mistake fails at the engine, with
 * a zod message, not as a cryptic worker crash.
 */
export function createFaceWorkerSpawner(workerUrl: URL | string, init: FaceWorkerInit): () => Worker {
  const validated = FaceWorkerInitSchema.parse(init);
  return () => new Worker(workerUrl, { workerData: validated });
}
