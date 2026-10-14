import { describe, expect, test } from "bun:test";
import { command, failed, ledgerLines, startEngine, useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.2, S5.WC1: until S5.WC3 builds part C, the engine answers the four commands with its one refusal for a command it cannot serve, INTERNAL «<type> is not implemented yet»
// (the `default` branch). A payload that breaks the contract is still VALIDATION: the contract guards the handler.

const dir = useEngineDir("studio-engine-clip-motions-");
const AVATAR = "avatar-mia-0001";
const PAYLOADS = {
  "clips.estimateSuggest": { avatarId: AVATAR, photoId: "photo-0001" },
  "clips.suggestMotions": { avatarId: AVATAR, photoId: "photo-0001", acceptedWorstMicros: 12_500 },
  "clips.estimateIdea": { avatarId: AVATAR, photoId: "photo-0001" },
  "clips.translateIdea": { avatarId: AVATAR, photoId: "photo-0001", text: "медленно поворачивает голову", acceptedWorstMicros: 5_000 },
} as const;

describe("the part C commands before S5.WC3", () => {
  for (const type of ["clips.estimateSuggest", "clips.suggestMotions", "clips.estimateIdea", "clips.translateIdea"] as const) {
    test(`${type} answers INTERNAL «not implemented yet» and moves no money`, async () => {
      const { engine } = await startEngine(dir());
      const response = failed(await engine.handle(command(type, PAYLOADS[type])));
      expect(response.error.code).toBe("INTERNAL");
      expect(response.error.detail).toBe(`${type} is not implemented yet`);
      expect(ledgerLines(dir())).toEqual([]);
    });
  }

  test("an idea with a newline is VALIDATION, never the stub's answer", async () => {
    const { engine } = await startEngine(dir());
    const payload = { ...PAYLOADS["clips.translateIdea"], text: "медленно\nповорачивает голову" };
    expect(failed(await engine.handle(command("clips.translateIdea", payload))).error.code).toBe("VALIDATION");
  });

  test("an idea of 301 characters is VALIDATION, never the stub's answer", async () => {
    const { engine } = await startEngine(dir());
    const payload = { ...PAYLOADS["clips.translateIdea"], text: "я".repeat(301) };
    expect(failed(await engine.handle(command("clips.translateIdea", payload))).error.code).toBe("VALIDATION");
  });
});
