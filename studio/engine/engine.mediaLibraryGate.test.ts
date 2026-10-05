import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { command, engineSettings, failed, startEngine, useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// `media.list` and `media.delete` go through the live library like every write: with no library open they answer LIBRARY_UNAVAILABLE (the mock answers the same).

const dir = useEngineDir("studio-media-gate-");

async function withoutLibrary() {
  const started = await startEngine(dir());
  await started.engine.receive({ kind: "control", type: "settings.update", settings: engineSettings(dir(), { libraryPath: join(dir(), "does-not-exist") }) });
  return started;
}

describe("own-media commands without a library", () => {
  test("media.list answers LIBRARY_UNAVAILABLE", async () => {
    const { engine } = await withoutLibrary();

    expect(failed(await engine.handle(command("media.list", {}))).error.code).toBe("LIBRARY_UNAVAILABLE");
  });

  test("media.delete answers LIBRARY_UNAVAILABLE", async () => {
    const { engine } = await withoutLibrary();

    expect(failed(await engine.handle(command("media.delete", { mediaId: "media-00000001" }))).error.code).toBe("LIBRARY_UNAVAILABLE");
  });
});
