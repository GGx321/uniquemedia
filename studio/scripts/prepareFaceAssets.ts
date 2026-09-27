/**
 * Build-time copy for the face gate's models (plan T7b, "Packaging"): after
 * `electron-vite build` writes `out-studio/` (emptied on every build — see
 * electron.studio.vite.config.ts's comment on `outDir`), the two `.onnx`
 * files are copied in from the gitignored model cache so
 * electron-builder.studio.yml's `files` glob can find them under
 * `out-studio/**`, right where every other build output lives — never
 * committed to git, and never read by studio/engine itself (its runtime
 * rule forbids resolving a path on its own; the packaged app's real entry
 * point, not this script, hands the engine the bytes).
 *
 * Run as part of `build:studio`/`build:studio:e2e` (package.json), after the
 * electron-vite build step. Models must already be cached
 * (`bun studio/scripts/faceModelCache.ts`, or the workflow's cache step) —
 * this script does not fetch, only copies and hash-verifies.
 */
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { FACE_MODELS, type FaceModelKey } from "../engine/face/modelSource";
import { faceModelPaths } from "./faceModelCache";

export function faceModelOutDir(root: string): string {
  return join(root, "out-studio", "engine", "models");
}

export function faceModelOutPaths(root: string): Record<FaceModelKey, string> {
  const dir = faceModelOutDir(root);
  const paths = {} as Record<FaceModelKey, string>;
  for (const [key, model] of Object.entries(FACE_MODELS)) paths[key as FaceModelKey] = join(dir, model.file);
  return paths;
}

/** Copies both cached, hash-verified models into `out-studio/engine/models/`. Throws if either is not cached yet. */
export async function prepareFaceAssets(root: string): Promise<void> {
  const cachePaths = faceModelPaths(root);
  const outPaths = faceModelOutPaths(root);
  await mkdir(faceModelOutDir(root), { recursive: true });
  for (const key of Object.keys(FACE_MODELS) as FaceModelKey[]) {
    await copyFile(cachePaths[key], outPaths[key]);
  }
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..", "..");
  await prepareFaceAssets(root);
  console.log(`face models copied into ${faceModelOutDir(root)}`);
}
