import { describe, expect, test } from "bun:test";
import { AVATAR, makeClipMock, refusal } from "./mockEngine.clips.testkit";

// Stage 5, 5b.2, S5.WA1: the mock mirrors the engine's stub word for word, so a window built on the mock meets the same refusal until S5.WA3 builds the import.

describe("media.importClip in the mock before S5.WA3", () => {
  test("answers INTERNAL «not implemented yet», as the engine does", async () => {
    const m = makeClipMock();
    const error = await refusal(m.client.request("media.importClip", { avatarId: AVATAR, clipId: "clip-0000001" }));
    expect(error.code).toBe("INTERNAL");
    expect(error.detail).toBe("media.importClip is not implemented yet");
  });

  test("lists no copy afterwards: the stub made none", async () => {
    const m = makeClipMock();
    await refusal(m.client.request("media.importClip", { avatarId: AVATAR, clipId: "clip-0000001" }));
    const listed = await m.client.request("media.list", {});
    expect(listed.ok && listed.result.media.filter((x) => x.origin !== undefined)).toEqual([]);
  });
});
