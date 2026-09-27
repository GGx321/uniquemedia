import { expect, test } from "bun:test";
import { faceModelCacheDir, faceModelPaths } from "./faceModelCache";
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
