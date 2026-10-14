import { describe, expect, test } from "bun:test";
import { COMMAND_DEADLINE_MS } from "./control";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.2, S5.WA1 round 2 (plan s5b2 §5.1.1): `media.importClip` answers after its pre-job checks, with the copy's media id or the import job's id, as `media.import`
// does. The encode runs in the job, so the command keeps main's default deadline and has no entry of its own.

describe("COMMAND_DEADLINE_MS['media.importClip']", () => {
  test("has no entry of its own: the command does not wait for the encode", () => {
    expect(COMMAND_DEADLINE_MS["media.importClip"]).toBeUndefined();
  });
});
