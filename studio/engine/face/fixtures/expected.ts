/**
 * Real OpenCV numbers for the 5 committed fixture images
 * (fixtures/images/*.jpg), copied by hand from
 * `spike/studio-api/out/face.json` (2026-09-24 run, git-ignored spike
 * output) — the exact bytes of each image were also copied unmodified from
 * that same run, so parity.test.ts can decode them for real and compare.
 */
export interface ExpectedFace {
  /** Relative to fixtures/images/. */
  file: string;
  /** cosMaster from face.json: SFace cosine of this image's face against the master's. */
  cosMaster: number;
  headRatio: number;
  faces: number;
}

export const MASTER: ExpectedFace = { file: "master.jpg", cosMaster: 1, headRatio: 0.482, faces: 1 };

/** avatar/candidate-1.jpg: a different person from the same text descriptor, never picked. */
export const IMPOSTOR: ExpectedFace = { file: "impostor-candidate-1.jpg", cosMaster: 0.6575, headRatio: 0.4291, faces: 1 };

/** True renders of the master, spanning the spike's observed range (min/median/max cosMaster). */
export const TRUE_RENDERS: readonly ExpectedFace[] = [
  { file: "render-worst-fitness-3.jpg", cosMaster: 0.4659, headRatio: 0.1099, faces: 1 }, // the spike's lowest true score
  { file: "render-median-travel-2.jpg", cosMaster: 0.6989, headRatio: 0.257, faces: 1 }, // decoder-sensitive: README's own flip case
  { file: "render-best-home-1.jpg", cosMaster: 0.9113, headRatio: 0.3032, faces: 1 }, // the spike's highest true score
];
