/**
 * Fetches the two face-gate models (studio/engine/face/modelSource.ts) into
 * a gitignored local cache, verifying each against its pinned sha256. Run
 * directly (`bun studio/scripts/faceModelCache.ts`) before a local
 * `bun test` or `build:studio`, and by CI (.github/workflows/studio.yml,
 * cached with actions/cache keyed on the two hashes). Never imported by
 * studio/engine itself — the engine only ever receives already-verified
 * bytes as a parameter (its runtime rule forbids resolving a path itself).
 */
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FACE_MODELS, type FaceModelKey, verifyModelBytes } from "../engine/face/modelSource";

export function faceModelCacheDir(root: string): string {
  return join(root, ".cache", "studio-face-models");
}

export function faceModelPaths(root: string): Record<FaceModelKey, string> {
  const dir = faceModelCacheDir(root);
  const paths = {} as Record<FaceModelKey, string>;
  for (const [key, model] of Object.entries(FACE_MODELS)) paths[key as FaceModelKey] = join(dir, model.file);
  return paths;
}

async function readCachedIfValid(path: string, sha256: string): Promise<Uint8Array | undefined> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch {
    return undefined;
  }
  try {
    verifyModelBytes(bytes, sha256, path);
    return bytes;
  } catch {
    return undefined; // stale or corrupt: caller re-fetches.
  }
}

/**
 * Ensures both models are present and hash-verified in the cache under
 * `root`, fetching whichever are missing or stale. Returns their paths.
 * Network only happens for a model not already cached with the right hash.
 */
export async function ensureFaceModels(root: string, fetchImpl: typeof fetch = fetch): Promise<Record<FaceModelKey, string>> {
  const dir = faceModelCacheDir(root);
  await mkdir(dir, { recursive: true });
  const paths = faceModelPaths(root);

  for (const [key, model] of Object.entries(FACE_MODELS)) {
    const path = paths[key as FaceModelKey];
    const cached = await readCachedIfValid(path, model.sha256);
    if (cached !== undefined) continue;

    const response = await fetchImpl(model.url);
    if (!response.ok) throw new Error(`face model fetch: ${model.url} answered ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    verifyModelBytes(bytes, model.sha256, key);

    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, path).catch(async (err) => {
      await unlink(tmp).catch(() => {});
      throw err;
    });
  }

  return paths;
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..", "..");
  const paths = await ensureFaceModels(root);
  for (const [key, path] of Object.entries(paths)) console.log(`${key}: ${path}`);
}
