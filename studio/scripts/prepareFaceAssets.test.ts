import { expect, test } from "bun:test";
import { join } from "node:path";
import { faceModelOutPaths, faceModelOutDir } from "./prepareFaceAssets";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

test("faceModelOutDir is out-studio/engine/models under the given root", () => {
  expect(faceModelOutDir("/repo")).toBe(join("/repo", "out-studio", "engine", "models"));
});

test("faceModelOutPaths names each model after its pinned file name, under faceModelOutDir", () => {
  const paths = faceModelOutPaths("/repo");
  expect(paths.yunet).toBe(join("/repo", "out-studio", "engine", "models", "face_detection_yunet_2023mar.onnx"));
  expect(paths.sface).toBe(join("/repo", "out-studio", "engine", "models", "face_recognition_sface_2021dec.onnx"));
});
