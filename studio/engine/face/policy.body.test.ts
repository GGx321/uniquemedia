import { expect, test } from "bun:test";
import { defaultFaceGateConfig } from "./config";
import { decideFaceVerdict } from "./policy";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// S5.6f: the `body` pose is a frame whose face is hidden or not meant to show (faceVisibleOf no or maybe). Its likeness is marked, never judged.

const config = defaultFaceGateConfig();
const IMAGE_HEIGHT = 1000;

function box(x: number, y: number, width: number, height: number, score: number) {
  return { x, y, width, height, score };
}

test("body, no face: skipped-by-pose", () => {
  expect(decideFaceVerdict({ pose: "body", faces: [], imageHeight: IMAGE_HEIGHT }, config)).toEqual({ kind: "skipped-by-pose", faces: 0 });
});

test("body, one face: marked with similarity, faces and headRatio", () => {
  const verdict = decideFaceVerdict({ pose: "body", faces: [box(0, 0, 100, 200, 0.9)], similarity: 0.8, imageHeight: IMAGE_HEIGHT }, config);
  expect(verdict).toEqual({ kind: "marked", similarity: 0.8, faces: 1, headRatio: 0.2 });
});

test("body, one face far below the identity threshold: still marked, never a mismatch", () => {
  const verdict = decideFaceVerdict({ pose: "body", faces: [box(0, 0, 100, 200, 0.9)], similarity: 0.05, imageHeight: IMAGE_HEIGHT }, config);
  expect(verdict.kind).toBe("marked");
});

test("body, one confident face: marked, not unexpected-face", () => {
  const verdict = decideFaceVerdict({ pose: "body", faces: [box(0, 0, 100, 200, 0.99)], similarity: 0.9, imageHeight: IMAGE_HEIGHT }, config);
  expect(verdict.kind).toBe("marked");
});

test("body, two prominent faces: multiple-faces, the one retry a face-hidden frame can take", () => {
  const faces = [box(0, 0, 100, 100, 0.9), box(300, 0, 100, 100, 0.9)];
  expect(decideFaceVerdict({ pose: "body", faces, imageHeight: IMAGE_HEIGHT }, config)).toEqual({ kind: "multiple-faces", faces: 2 });
});

test("body, a small background face beside the prominent one: marked on the prominent face", () => {
  const faces = [box(0, 0, 100, 200, 0.9), box(400, 0, 10, 10, 0.9)];
  const verdict = decideFaceVerdict({ pose: "body", faces, similarity: 0.7, imageHeight: IMAGE_HEIGHT }, config);
  expect(verdict).toEqual({ kind: "marked", similarity: 0.7, faces: 2, headRatio: 0.2 });
});
