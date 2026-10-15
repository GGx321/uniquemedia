import { describe, expect, test } from "bun:test";
import { CLIP_PLAN_READ_TIMEOUT_MS, COMMAND_DEADLINE_MS } from "./control";
import { REFERENCE_TIMEOUT_MS } from "./runs/timeouts";
import { PRICE_FETCH_TIMEOUT_MS } from "./money/prices";
import { MAX_ATTEMPT_MS } from "./openrouter/transport";
import { LIVE_LIBRARY_IDENTITY_TIMEOUT_MS } from "./videos/timeouts";
import { MOTION_MAX_ATTEMPTS } from "../shared/engine";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.2, S5.WC1 (plan s5b2 §5.3, I5.68): the two paid calls answer with their result, so main waits for up to MOTION_MAX_ATTEMPTS model attempts, each at its slowest.
// The 30 s slack is the engine's own (control.ts keeps it private; the other deadline tests spell it out the same way).

describe("COMMAND_DEADLINE_MS for the part C commands", () => {
  // L3 (review round 2): both calls read the photo's run plan first (CLIP_PLAN_READ_TIMEOUT_MS); the vision call also reads the photo and downscales it to 1024 px, which budgets REFERENCE_TIMEOUT_MS as
  // `avatars.checkDescriptor` does for its reference.
  const translate = PRICE_FETCH_TIMEOUT_MS + LIVE_LIBRARY_IDENTITY_TIMEOUT_MS + CLIP_PLAN_READ_TIMEOUT_MS + MOTION_MAX_ATTEMPTS * MAX_ATTEMPT_MS + 30_000;
  const suggest = translate + REFERENCE_TIMEOUT_MS;

  test("clips.translateIdea waits for a price load, the library's identity, the plan read, two attempts at their slowest and the slack", () => {
    expect(COMMAND_DEADLINE_MS["clips.translateIdea"]).toBe(translate);
  });

  test("clips.suggestMotions waits the same plus the photo read and downscale", () => {
    expect(COMMAND_DEADLINE_MS["clips.suggestMotions"]).toBe(suggest);
    expect(COMMAND_DEADLINE_MS["clips.suggestMotions"] ?? 0).toBeGreaterThan(COMMAND_DEADLINE_MS["clips.translateIdea"] ?? Infinity);
  });

  test("the free estimates wait for a price load and the slack, like clips.options", () => {
    expect(COMMAND_DEADLINE_MS["clips.estimateSuggest"]).toBe(PRICE_FETCH_TIMEOUT_MS + 30_000);
    expect(COMMAND_DEADLINE_MS["clips.estimateIdea"]).toBe(PRICE_FETCH_TIMEOUT_MS + 30_000);
    expect(COMMAND_DEADLINE_MS["clips.estimateSuggest"]).toBe(COMMAND_DEADLINE_MS["clips.options"]);
  });

  test("a paid call outwaits its estimate", () => {
    expect(COMMAND_DEADLINE_MS["clips.suggestMotions"] ?? 0).toBeGreaterThan(COMMAND_DEADLINE_MS["clips.estimateSuggest"] ?? Infinity);
  });
});
