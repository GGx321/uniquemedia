import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FaceModelSource } from "../engine/face/modelSource";
import { ensureModels, faceModelCacheDir, faceModelPaths } from "./faceModelCache";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

test("faceModelCacheDir is a .cache/studio-face-models folder under the given root", () => {
  expect(faceModelCacheDir("/repo")).toBe("/repo/.cache/studio-face-models");
});

test("faceModelPaths returns one path per model, named after its pinned file name", () => {
  const paths = faceModelPaths("/repo");
  expect(paths.yunet).toBe("/repo/.cache/studio-face-models/face_detection_yunet_2023mar.onnx");
  expect(paths.sface).toBe("/repo/.cache/studio-face-models/face_recognition_sface_2021dec.onnx");
});

// ensureModels: the generic body ensureFaceModels wraps around the real
// FACE_MODELS. Tested against a tiny fake registry instead of the real
// 38.7 MB SFace file, with an injectable fetchImpl so no test ever touches
// the network.
const roots: string[] = [];
async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "face-model-cache-test-"));
  roots.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fakeModel(file: string, bytes: Uint8Array): Record<"fake", FaceModelSource> {
  return { fake: { file, url: `https://example.invalid/${file}`, sha256: sha256Of(bytes), approxBytes: bytes.length } };
}

test("fetches a missing model, verifies it, and returns its cache path", async () => {
  const root = await tempRoot();
  const bytes = new TextEncoder().encode("real model bytes");
  const models = fakeModel("fake.onnx", bytes);
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response(bytes, { status: 200 });
  };

  const paths = await ensureModels(root, models, fetchImpl);

  expect(calls).toBe(1);
  expect(await readFile(paths.fake)).toEqual(Buffer.from(bytes));
});

test("a hash mismatch is refused and nothing is written to the cache path", async () => {
  const root = await tempRoot();
  const wrongBytes = new TextEncoder().encode("not the bytes the hash was computed from");
  const models = fakeModel("fake.onnx", new TextEncoder().encode("expected bytes"));
  const fetchImpl = async () => new Response(wrongBytes, { status: 200 });

  await expect(ensureModels(root, models, fetchImpl)).rejects.toThrow(/hash mismatch/);
  const paths = faceModelCacheDir(root);
  expect(existsSync(join(paths, "fake.onnx"))).toBe(false);
});

test("a non-2xx response is refused and nothing is written", async () => {
  const root = await tempRoot();
  const models = fakeModel("fake.onnx", new TextEncoder().encode("expected bytes"));
  const fetchImpl = async () => new Response("nope", { status: 404 });

  await expect(ensureModels(root, models, fetchImpl)).rejects.toThrow(/404/);
  expect(existsSync(join(faceModelCacheDir(root), "fake.onnx"))).toBe(false);
});

test("a valid cached file makes zero network calls", async () => {
  const root = await tempRoot();
  const bytes = new TextEncoder().encode("already cached, byte for byte");
  const models = fakeModel("fake.onnx", bytes);
  await mkdir(faceModelCacheDir(root), { recursive: true });
  await writeFile(join(faceModelCacheDir(root), "fake.onnx"), bytes);
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    throw new Error("must not be called");
  };

  const paths = await ensureModels(root, models, fetchImpl);

  expect(calls).toBe(0);
  expect(await readFile(paths.fake)).toEqual(Buffer.from(bytes));
});

test("a corrupt cached file (wrong hash) is re-fetched rather than trusted", async () => {
  const root = await tempRoot();
  const goodBytes = new TextEncoder().encode("the correct bytes");
  const models = fakeModel("fake.onnx", goodBytes);
  await mkdir(faceModelCacheDir(root), { recursive: true });
  await writeFile(join(faceModelCacheDir(root), "fake.onnx"), new TextEncoder().encode("corrupted leftovers from a previous run"));
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response(goodBytes, { status: 200 });
  };

  const paths = await ensureModels(root, models, fetchImpl);

  expect(calls).toBe(1);
  expect(await readFile(paths.fake)).toEqual(Buffer.from(goodBytes));
});

test("writes through a temp file and renames it into place: no .tmp file is left behind on success", async () => {
  const root = await tempRoot();
  const bytes = new TextEncoder().encode("atomic write check");
  const models = fakeModel("fake.onnx", bytes);
  const fetchImpl = async () => new Response(bytes, { status: 200 });

  await ensureModels(root, models, fetchImpl);

  const leftover = readdirSync(faceModelCacheDir(root)).filter((f) => f.includes(".tmp"));
  expect(leftover).toEqual([]);
});

test("cleans up the temp file when the rename into place fails", async () => {
  const root = await tempRoot();
  const bytes = new TextEncoder().encode("rename will fail because the destination is a directory");
  const models = fakeModel("fake.onnx", bytes);
  // Put a directory where the final file should land: rename(tmp, dir) fails.
  await mkdir(join(faceModelCacheDir(root), "fake.onnx"), { recursive: true });
  const fetchImpl = async () => new Response(bytes, { status: 200 });

  await expect(ensureModels(root, models, fetchImpl)).rejects.toThrow();

  const leftover = readdirSync(faceModelCacheDir(root)).filter((f) => f.includes(".tmp"));
  expect(leftover).toEqual([]);
});
