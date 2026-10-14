import { describe, expect, test } from "bun:test";
import { command, failed, ledgerLines, startEngine, useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.2, S5.WB1: until S5.WB2 builds the batch, the engine answers the three batch commands with its one refusal for a command it cannot serve, INTERNAL
// «<type> is not implemented yet» (the `default` branch). A payload that breaks the contract is still VALIDATION: the contract guards the handler.

const dir = useEngineDir("studio-engine-clip-batch-");
const AVATAR = "avatar-mia-0001";
const PAYLOADS = {
  "clips.batchOptions": { avatarId: AVATAR, photoIds: ["photo-0001"] },
  "clips.createBatch": { avatarId: AVATAR, items: [{ photoId: "photo-0001", motionId: "scene" }], quality: "std", seconds: 5, fallback: "auto", acceptedWorstMicros: 850_000 },
  "clips.cancelBatch": { avatarId: AVATAR, batchId: "batch-00000001" },
} as const;

describe("the batch commands before S5.WB2", () => {
  for (const type of ["clips.batchOptions", "clips.createBatch", "clips.cancelBatch"] as const) {
    test(`${type} answers INTERNAL «not implemented yet» and moves no money`, async () => {
      const { engine } = await startEngine(dir());
      const response = failed(await engine.handle(command(type, PAYLOADS[type])));
      expect(response.error.code).toBe("INTERNAL");
      expect(response.error.detail).toBe(`${type} is not implemented yet`);
      expect(ledgerLines(dir())).toEqual([]);
    });
  }

  test("a payload with a free motion text is VALIDATION, never the stub's answer", async () => {
    const { engine } = await startEngine(dir());
    const payload = { ...PAYLOADS["clips.createBatch"], motion: "she waves" };
    expect(failed(await engine.handle(command("clips.createBatch", payload))).error.code).toBe("VALIDATION");
  });

  test("twenty-one photos are VALIDATION, never the stub's answer", async () => {
    const { engine } = await startEngine(dir());
    const photoIds = Array.from({ length: 21 }, (_, i) => `photo-${String(i + 1).padStart(4, "0")}`);
    expect(failed(await engine.handle(command("clips.batchOptions", { avatarId: AVATAR, photoIds }))).error.code).toBe("VALIDATION");
  });
});
