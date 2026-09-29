import { Worker } from "node:worker_threads";
import { TextWorkerInitSchema, type TextWorkerInit } from "./protocol";

/**
 * The real `spawnWorker` for `createTextGate`: starts the built text worker entry (`textWorker.ts`, bundled as
 * `out-studio/engine/textWorker.js`) with the two paths it needs in `workerData`.
 *
 * `workerUrl` is a `file://` URL (or an absolute path) the CALLER resolves: the engine's entry (main.ts) derives it
 * from its own `import.meta.url`, never from `process`, and it works unchanged inside `app.asar` on macOS and
 * Windows (Node and Electron read the asar transparently; nothing is unpacked), exactly like the face worker's.
 * `init` is validated here, so a wiring mistake fails at the engine with a zod message, not as a cryptic worker crash.
 */
export function createTextWorkerSpawner(workerUrl: URL | string, init: TextWorkerInit): () => Worker {
  const validated = TextWorkerInitSchema.parse(init);
  return () => new Worker(workerUrl, { workerData: validated });
}
