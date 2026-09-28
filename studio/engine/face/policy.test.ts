import { expect, test } from "bun:test";
import { defaultFaceGateConfig } from "./config";
import { decideFaceVerdict } from "./policy";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

const config = defaultFaceGateConfig();
const IMAGE_HEIGHT = 1000;

function box(x: number, y: number, width: number, height: number, score: number) {
  return { x, y, width, height, score };
}

test("no-face: no detection at all, on any pose", () => {
  for (const pose of ["front", "three-quarter", "profile", "back"] as const) {
    const verdict = decideFaceVerdict({ pose, faces: [], imageHeight: IMAGE_HEIGHT }, config);
    if (pose === "back" || pose === "profile") {
      expect(verdict.kind).toBe("skipped-by-pose");
    } else {
      expect(verdict).toEqual({ kind: "no-face", faces: 0 });
    }
  }
});

test("front, one face, similarity above the threshold: match, with similarity and headRatio reported", () => {
  const verdict = decideFaceVerdict(
    { pose: "front", faces: [box(0, 0, 100, 200, 0.9)], similarity: 0.8, imageHeight: IMAGE_HEIGHT },
    config,
  );
  expect(verdict).toEqual({ kind: "match", similarity: 0.8, faces: 1, headRatio: 0.2 });
});

test("three-quarter, one face, similarity below the threshold: mismatch", () => {
  const verdict = decideFaceVerdict(
    { pose: "three-quarter", faces: [box(0, 0, 100, 200, 0.9)], similarity: 0.1, imageHeight: IMAGE_HEIGHT },
    config,
  );
  expect(verdict).toEqual({ kind: "mismatch", similarity: 0.1, faces: 1, headRatio: 0.2 });
});

test("front, similarity exactly at the threshold counts as a match (inclusive)", () => {
  const threshold = config.identity.strategy.threshold;
  const verdict = decideFaceVerdict(
    { pose: "front", faces: [box(0, 0, 100, 200, 0.9)], similarity: threshold, imageHeight: IMAGE_HEIGHT },
    config,
  );
  expect(verdict.kind).toBe("match");
});

test("front, similarity one step below the threshold: mismatch (the exclusive edge, T7b's own boundary pin)", () => {
  const threshold = config.identity.strategy.threshold;
  const verdict = decideFaceVerdict(
    { pose: "front", faces: [box(0, 0, 100, 200, 0.9)], similarity: threshold - 0.0001, imageHeight: IMAGE_HEIGHT },
    config,
  );
  expect(verdict.kind).toBe("mismatch");
});

test("front, similarity one step above the threshold: match", () => {
  const threshold = config.identity.strategy.threshold;
  const verdict = decideFaceVerdict(
    { pose: "front", faces: [box(0, 0, 100, 200, 0.9)], similarity: threshold + 0.0001, imageHeight: IMAGE_HEIGHT },
    config,
  );
  expect(verdict.kind).toBe("match");
});

test("profile: identity is never checked, even with a strong face and no similarity given", () => {
  const verdict = decideFaceVerdict({ pose: "profile", faces: [box(0, 0, 100, 200, 0.95)], imageHeight: IMAGE_HEIGHT }, config);
  expect(verdict).toEqual({ kind: "skipped-by-pose", faces: 1 });
});

test("back, no face detected: skipped-by-pose (the expected case)", () => {
  const verdict = decideFaceVerdict({ pose: "back", faces: [], imageHeight: IMAGE_HEIGHT }, config);
  expect(verdict).toEqual({ kind: "skipped-by-pose", faces: 0 });
});

test("back, a face detected with good confidence: unexpected-face", () => {
  const verdict = decideFaceVerdict(
    { pose: "back", faces: [box(0, 0, 100, 200, config.unexpectedFace.minScore)], imageHeight: IMAGE_HEIGHT },
    config,
  );
  expect(verdict).toEqual({ kind: "unexpected-face", faces: 1, headRatio: 0.2 });
});

test("back, a score that is exactly the threshold but came from a Float32Array (as YuNet's real output does) still counts as unexpected-face", () => {
  // Storing 0.7 in a Float32Array rounds it to 0.699999988...: a plain
  // float64 `>=` against the config's own 0.7 would then read as false.
  // The comparison must fround the threshold the same way yunet.ts already
  // fronds its own score threshold.
  const row = new Float32Array(1);
  row[0] = config.unexpectedFace.minScore;
  const verdict = decideFaceVerdict(
    { pose: "back", faces: [box(0, 0, 100, 200, row[0]!)], imageHeight: IMAGE_HEIGHT },
    config,
  );
  expect(verdict.kind).toBe("unexpected-face");
});

test("back, a face detected below the unexpected-face confidence: treated as no reliable face", () => {
  const verdict = decideFaceVerdict(
    { pose: "back", faces: [box(0, 0, 100, 200, config.unexpectedFace.minScore - 0.01)], imageHeight: IMAGE_HEIGHT },
    config,
  );
  expect(verdict).toEqual({ kind: "skipped-by-pose", faces: 1 });
});

test("multiple-faces takes priority over every pose rule, including profile and back", () => {
  const twoProminent = [box(0, 0, 100, 300, 0.9), box(400, 0, 100, 300, 0.9)];
  for (const pose of ["front", "three-quarter", "profile", "back"] as const) {
    const verdict = decideFaceVerdict({ pose, faces: twoProminent, similarity: 0.9, imageHeight: IMAGE_HEIGHT }, config);
    expect(verdict).toEqual({ kind: "multiple-faces", faces: 2 });
  }
});

test("a small background face does not trigger multiple-faces: front still runs the identity check on the main face", () => {
  const mainFace = box(0, 0, 100, 300, 0.9);
  const tinyBackgroundFace = box(900, 900, 5, 5, 0.75); // area ratio far below minRelativeArea
  const verdict = decideFaceVerdict(
    { pose: "front", faces: [mainFace, tinyBackgroundFace], similarity: 0.9, imageHeight: IMAGE_HEIGHT },
    config,
  );
  expect(verdict.kind).toBe("match");
  expect(verdict.faces).toBe(2);
});

test("headRatio is the largest prominent face's height divided by the image height", () => {
  const verdict = decideFaceVerdict(
    { pose: "front", faces: [box(10, 10, 50, 250, 0.9)], similarity: 0.9, imageHeight: 500 },
    config,
  );
  expect(verdict.kind).toBe("match");
  if (verdict.kind === "match") expect(verdict.headRatio).toBeCloseTo(0.5, 6);
});

test("front with a face but no similarity given throws: the caller must always compute it for front/three-quarter", () => {
  expect(() => decideFaceVerdict({ pose: "front", faces: [box(0, 0, 100, 200, 0.9)], imageHeight: IMAGE_HEIGHT }, config)).toThrow();
});
