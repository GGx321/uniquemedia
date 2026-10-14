import { describe, expect, test } from "bun:test";
import { command, failed, ledgerLines, startEngine, useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.2, S5.WA1 / S5.WA2: S5.WA1 pinned the compile stub (INTERNAL «<type> is not implemented yet»); S5.WA2 built the import, so the stub's answer is gone and the engine answers the
// contract's refusals (pinned in full by engine.importClip.test.ts). A payload that breaks the contract is still VALIDATION: the contract guards the handler.

const dir = useEngineDir("studio-engine-media-import-clip-");
const PAYLOAD = { avatarId: "avatar-mia-0001", clipId: "clip-0000001" };

describe("media.importClip at the door", () => {
  test("is no longer the stub: a clip of an avatar the library does not have is NOT_FOUND, and no money moves", async () => {
    const { engine } = await startEngine(dir());
    const response = failed(await engine.handle(command("media.importClip", PAYLOAD)));
    expect(response.error.code).toBe("NOT_FOUND");
    expect(response.error.detail).not.toContain("not implemented");
    expect(ledgerLines(dir())).toEqual([]);
  });

  test("a payload with a path is VALIDATION, never the stub's answer", async () => {
    const { engine } = await startEngine(dir());
    expect(failed(await engine.handle(command("media.importClip", { ...PAYLOAD, path: "/tmp/x.mp4" }))).error.code).toBe("VALIDATION");
  });
});
