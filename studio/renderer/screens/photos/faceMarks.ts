import type { PhotoSummary } from "../../../shared/engine";
import { countOf } from "../../lib/format";
import { FACE_GATE_THRESHOLD } from "./shared";

// S5.6f marks a face-hidden or back frame instead of retrying it: the gate keeps the likeness of a one-face frame and judges nothing, and a frame with no
// prominent face carries no likeness at all. The photo contract has no flag for either, so the window reads the two from what a photo does carry.

/** A likeness under the gate's line, compared on the value the badge shows (0.549 reads «0.55», which is on the line). */
export function underFaceLine(faceCos: number): boolean {
  return Number(faceCos.toFixed(2)) < FACE_GATE_THRESHOLD;
}

/** How many of a run's photos (those of `photoIds` found in `photos`) carry no likeness, or one under the gate's line: no face check judged them. */
export function framesWithoutFaceCheck(photos: readonly PhotoSummary[], photoIds: readonly string[]): number {
  const ofRun = new Set(photoIds);
  return photos.filter((p) => ofRun.has(p.photoId) && (p.qa?.faceCos === undefined || underFaceLine(p.qa.faceCos))).length;
}

/** «3 кадра без проверки лица». */
export function faceMarksText(n: number): string {
  return `${countOf(n, ["кадр", "кадра", "кадров"])} без проверки лица`;
}
