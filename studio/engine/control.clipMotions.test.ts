import { describe, expect, test } from "bun:test";
import { COMMAND_DEADLINE_MS } from "./control";
import { PRICE_FETCH_TIMEOUT_MS } from "./money/prices";
import { MAX_ATTEMPT_MS } from "./openrouter/transport";
import { LIVE_LIBRARY_IDENTITY_TIMEOUT_MS } from "./videos/timeouts";
import { MOTION_MAX_ATTEMPTS } from "../shared/engine";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.2, S5.WC1 (plan s5b2 §5.3, I5.68): the two paid calls answer with their result, so main waits for up to MOTION_MAX_ATTEMPTS model attempts, each at its slowest.
// The 30 s slack is the engine's own (control.ts keeps it private; the other deadline tests spell it out the same way).

describe("COMMAND_DEADLINE_MS for the part C commands", () => {
  const paid = PRICE_FETCH_TIMEOUT_MS + LIVE_LIBRARY_IDENTITY_TIMEOUT_MS + MOTION_MAX_ATTEMPTS * MAX_ATTEMPT_MS + 30_000;

  test("clips.suggestMotions waits for a price load, the library's identity, two attempts at their slowest and the slack", () => {
    expect(COMMAND_DEADLINE_MS["clips.suggestMotions"]).toBe(paid);
  });

  test("clips.translateIdea waits the same", () => {
    expect(COMMAND_DEADLINE_MS["clips.translateIdea"]).toBe(paid);
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
