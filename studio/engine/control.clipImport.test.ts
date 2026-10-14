import { describe, expect, test } from "bun:test";
import { COMMAND_DEADLINE_MS } from "./control";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.2, S5.WA1 (plan s5b2 §5.1.1): `media.importClip` answers with the copy's media id, so the answer waits for the importer's encode. Main's default of 30 s would answer
// INTERNAL while the copy is still being made and the window would ask again. The command has its own deadline.

describe("COMMAND_DEADLINE_MS['media.importClip']", () => {
  test("is set, so main does not give up at its 30 s default", () => {
    const deadline = COMMAND_DEADLINE_MS["media.importClip"];
    expect(deadline).toBeDefined();
    expect(deadline ?? 0).toBeGreaterThan(30_000);
  });

  test("covers the encode of a 10 s clip with room to spare: at least a minute and no more than the export's ten", () => {
    const deadline = COMMAND_DEADLINE_MS["media.importClip"] ?? 0;
    expect(deadline).toBeGreaterThanOrEqual(60_000);
    expect(deadline).toBeLessThanOrEqual(10 * 60_000);
  });
});
