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
import { FACE_MODELS, type FaceModelKey, type FaceModelSource, verifyModelBytes } from "../engine/face/modelSource";

export function faceModelCacheDir(root: string): string {
  return join(root, ".cache", "studio-face-models");
}

function pathsFor(root: string, models: Record<string, FaceModelSource>): Record<string, string> {
  const dir = faceModelCacheDir(root);
  const paths: Record<string, string> = {};
  for (const [key, model] of Object.entries(models)) paths[key] = join(dir, model.file);
  return paths;
}

export function faceModelPaths(root: string): Record<FaceModelKey, string> {
  return pathsFor(root, FACE_MODELS) as Record<FaceModelKey, string>;
}

/** Narrower than `typeof fetch` (which also carries bun's `preconnect` static) so a plain test stub is assignable. */
export type FetchLike = (url: string) => Promise<Response>;

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
 * Ensures every model in `models` is present and hash-verified in the cache
 * under `root`, fetching whichever are missing or stale. Returns their
 * paths, keyed the same way `models` is. Network only happens for a model
 * not already cached with the right hash — tested against a tiny fake
 * registry (faceModelCache.test.ts) so no test ever touches the network or
 * the real 38.7 MB SFace file.
 */
export async function ensureModels(root: string, models: Record<string, FaceModelSource>, fetchImpl: FetchLike = fetch): Promise<Record<string, string>> {
  const dir = faceModelCacheDir(root);
  await mkdir(dir, { recursive: true });
  const paths = pathsFor(root, models);

  for (const [key, model] of Object.entries(models)) {
    const path = paths[key];
    if (path === undefined) continue;
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

/** The real model registry (studio/engine/face/modelSource.ts), wrapped around `ensureModels`. */
export async function ensureFaceModels(root: string, fetchImpl: FetchLike = fetch): Promise<Record<FaceModelKey, string>> {
  return (await ensureModels(root, FACE_MODELS, fetchImpl)) as Record<FaceModelKey, string>;
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..", "..");
  const paths = await ensureFaceModels(root);
  for (const [key, path] of Object.entries(paths)) console.log(`${key}: ${path}`);
}
