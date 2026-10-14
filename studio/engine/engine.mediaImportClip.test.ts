import { describe, expect, test } from "bun:test";
import { command, failed, ledgerLines, startEngine, useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.2, S5.WA1: until S5.WA2 builds the import, the engine answers `media.importClip` with its one refusal for a command it cannot serve, INTERNAL
// «<type> is not implemented yet» (the `default` branch). A payload that breaks the contract is still VALIDATION: the contract guards the handler.

const dir = useEngineDir("studio-engine-media-import-clip-");
const PAYLOAD = { avatarId: "avatar-mia-0001", clipId: "clip-0000001" };

describe("media.importClip before S5.WA2", () => {
  test("answers INTERNAL «not implemented yet» and moves no money", async () => {
    const { engine } = await startEngine(dir());
    const response = failed(await engine.handle(command("media.importClip", PAYLOAD)));
    expect(response.error.code).toBe("INTERNAL");
    expect(response.error.detail).toBe("media.importClip is not implemented yet");
    expect(ledgerLines(dir())).toEqual([]);
  });

  test("a payload with a path is VALIDATION, never the stub's answer", async () => {
    const { engine } = await startEngine(dir());
    expect(failed(await engine.handle(command("media.importClip", { ...PAYLOAD, path: "/tmp/x.mp4" }))).error.code).toBe("VALIDATION");
  });
});
