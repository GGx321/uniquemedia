import { describe, expect, test } from "bun:test";
import type { PhotoSummary } from "../../../shared/engine";
import { faceMarksText, framesWithoutFaceCheck } from "./faceMarks";

// S5.6e (mockup 32): a face-hidden or back frame is marked, never retried. The photo carries no verdict of the gate, only its likeness when one face was
// found, so a frame «without a face check» is one with no likeness at all, or one whose likeness sits under the gate's line (it was marked, not retried).

function photo(id: string, faceCos?: number): PhotoSummary {
  return {
    photoId: id,
    avatarId: "avatar-mia-0001",
    runId: "run-00000001",
    category: "home",
    createdAt: "2026-10-11T10:00:00.000Z",
    ...(faceCos === undefined ? {} : { qa: { faceCos } }),
    used: false,
    usedIn: [],
    rejected: false,
    reserved: false,
    eligible: true,
  };
}

describe("framesWithoutFaceCheck", () => {
  test("counts a frame with no likeness", () => {
    expect(framesWithoutFaceCheck([photo("p1"), photo("p2", 0.81)], ["p1", "p2"])).toBe(1);
  });

  test("counts a frame whose likeness is under the gate's line", () => {
    expect(framesWithoutFaceCheck([photo("p1", 0.48), photo("p2", 0.81)], ["p1", "p2"])).toBe(1);
  });

  test("does not count a frame exactly on the line", () => {
    expect(framesWithoutFaceCheck([photo("p1", 0.55)], ["p1"])).toBe(0);
  });

  test("reads a likeness the way the badge shows it: 0.549 is «0.55», on the line", () => {
    expect(framesWithoutFaceCheck([photo("p1", 0.549)], ["p1"])).toBe(0);
  });

  test("counts only the photos of the run", () => {
    expect(framesWithoutFaceCheck([photo("p1"), photo("other")], ["p1"])).toBe(1);
  });

  test("is 0 when the run's photos are not in the list", () => {
    expect(framesWithoutFaceCheck([photo("other")], ["p1"])).toBe(0);
  });

  test("is 0 for a run with no photos", () => {
    expect(framesWithoutFaceCheck([photo("p1")], [])).toBe(0);
  });
});

describe("faceMarksText", () => {
  test.each([
    [1, "1 кадр без проверки лица"],
    [2, "2 кадра без проверки лица"],
    [3, "3 кадра без проверки лица"],
    [4, "4 кадра без проверки лица"],
    [5, "5 кадров без проверки лица"],
    [11, "11 кадров без проверки лица"],
    [12, "12 кадров без проверки лица"],
    [14, "14 кадров без проверки лица"],
    [21, "21 кадр без проверки лица"],
    [22, "22 кадра без проверки лица"],
    [100, "100 кадров без проверки лица"],
  ])("for %i reads «%s»", (n, text) => {
    expect(faceMarksText(n).replace(/ /g, " ")).toBe(text);
  });
});
