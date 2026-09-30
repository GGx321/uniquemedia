import { describe, expect, test } from "bun:test";
import { MAX_CLIPS as CONTRACT_MAX_CLIPS, MAX_TOTAL_MS as CONTRACT_MAX_TOTAL_MS, MIN_CLIP_MS as CONTRACT_MIN_CLIP_MS, MIN_TOTAL_MS as CONTRACT_MIN_TOTAL_MS, TIME_STEP_MS } from "../engine/montage";
import { FPS, FRAMES_PER_STEP, MAX_CLIPS, MAX_TOTAL_MS, MIN_CLIP_MS, MIN_TOTAL_MS, STEP_MS, TEXT_BASE_PX } from "./constants";

describe("constants mirror the contract", () => {
  test("the limits equal the contract's", () => {
    expect({ MIN_TOTAL_MS, MAX_TOTAL_MS, MIN_CLIP_MS, MAX_CLIPS }).toEqual({
      MIN_TOTAL_MS: CONTRACT_MIN_TOTAL_MS,
      MAX_TOTAL_MS: CONTRACT_MAX_TOTAL_MS,
      MIN_CLIP_MS: CONTRACT_MIN_CLIP_MS,
      MAX_CLIPS: CONTRACT_MAX_CLIPS,
    });
  });

  test("a timeline step is the contract's 100 ms, which is exactly 3 frames at 30 fps", () => {
    expect(STEP_MS).toBe(TIME_STEP_MS);
    expect((STEP_MS * FPS) / 1000).toBe(FRAMES_PER_STEP);
  });
});

describe("the text base size", () => {
  test("a caption at scale 1 is 56 px on the 1080 frame", () => {
    expect(TEXT_BASE_PX).toBe(56);
  });

  test("the size the editor shows for the contract's largest scale is a whole number of pixels", () => {
    expect(Number.isInteger(TEXT_BASE_PX * 2)).toBe(true);
    expect(Number.isInteger(TEXT_BASE_PX * 0.5)).toBe(true);
  });
});
