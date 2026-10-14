import { describe, expect, test } from "bun:test";
import { AVATAR, makeClipMock, refusal } from "./mockEngine.clips.testkit";

// Stage 5, 5b.2, S5.WB1: the mock mirrors the engine's stub word for word, so a window built on the mock meets the same refusal until S5.WB3 builds the batch.

describe("the batch commands in the mock before S5.WB3", () => {
  test("clips.batchOptions answers INTERNAL «not implemented yet», as the engine does", async () => {
    const m = makeClipMock();
    const error = await refusal(m.client.request("clips.batchOptions", { avatarId: AVATAR, photoIds: ["photo-0001"] }));
    expect(error.code).toBe("INTERNAL");
    expect(error.detail).toBe("clips.batchOptions is not implemented yet");
  });

  test("clips.createBatch answers INTERNAL «not implemented yet» and starts no job", async () => {
    const m = makeClipMock();
    const error = await refusal(
      m.client.request("clips.createBatch", { avatarId: AVATAR, items: [{ photoId: "photo-0001", motionId: "scene" }], quality: "std", seconds: 5, fallback: "auto", acceptedWorstMicros: 850_000 }),
    );
    expect(error.code).toBe("INTERNAL");
    expect(error.detail).toBe("clips.createBatch is not implemented yet");
    const snapshot = await m.client.request("engine.snapshot", {});
    expect(snapshot.ok && snapshot.result.jobs.filter((job) => job.kind === "clip")).toEqual([]);
  });

  test("clips.cancelBatch answers INTERNAL «not implemented yet», as the engine does", async () => {
    const m = makeClipMock();
    const error = await refusal(m.client.request("clips.cancelBatch", { avatarId: AVATAR, batchId: "batch-00000001" }));
    expect(error.code).toBe("INTERNAL");
    expect(error.detail).toBe("clips.cancelBatch is not implemented yet");
  });
});
