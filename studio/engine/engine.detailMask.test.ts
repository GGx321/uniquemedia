import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { EngineReply } from "./control";
import { engineErrorFrom } from "./engine";
import { startEngine, useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// 3a.8b.2: the other engine commands put an fs error's message into `detail`, and that message names the owner's
// library path. It reaches the renderer, so the home folder is masked as `~` there, as it is in a render job's errors.

const dir = useEngineDir("studio-engine-detail-mask-");
const HOME = homedir();

describe("an error's detail never carries the user's home folder", () => {
  test("engineErrorFrom masks the home folder in the message of an unclassified error", () => {
    const error = new Error(`ENOENT: no such file or directory, open '${join(HOME, "Studio", "library", "avatars", "a", "avatar.json")}'`);

    const mapped = engineErrorFrom(error);

    expect(mapped.code).toBe("INTERNAL");
    expect(mapped.detail).toContain("~");
    expect(mapped.detail).not.toContain(HOME);
  });

  test("a library folder that cannot be opened answers with its path masked, not spelled out", async () => {
    const { engine, posted } = await startEngine(dir());
    const missing = join(HOME, "studio-a8b2-a-folder-that-does-not-exist");

    await engine.receive({ kind: "control", type: "library.open", callId: "call-00000001", path: missing });

    const reply = EngineReply.parse(posted.at(-1));
    expect(reply.error?.code).toBe("INTERNAL");
    expect(reply.error?.detail).toContain("studio-a8b2-a-folder-that-does-not-exist");
    expect(reply.error?.detail).not.toContain(HOME);
  });
});
