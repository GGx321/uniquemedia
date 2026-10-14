import { describe, expect, test } from "bun:test";
import { AVATAR, makeClipMock, refusal } from "./mockEngine.clips.testkit";

// Stage 5, 5b.2, S5.WC1: the mock mirrors the engine's stub word for word, so a window built on the mock meets the same refusal until S5.WC4 builds part C.

const PHOTO = "photo-0001";

describe("the part C commands in the mock before S5.WC4", () => {
  const PAYLOADS = {
    "clips.estimateSuggest": { avatarId: AVATAR, photoId: PHOTO },
    "clips.suggestMotions": { avatarId: AVATAR, photoId: PHOTO, acceptedWorstMicros: 12_500 },
    "clips.estimateIdea": { avatarId: AVATAR, photoId: PHOTO },
    "clips.translateIdea": { avatarId: AVATAR, photoId: PHOTO, text: "медленно поворачивает голову", acceptedWorstMicros: 5_000 },
  } as const;

  for (const type of ["clips.estimateSuggest", "clips.suggestMotions", "clips.estimateIdea", "clips.translateIdea"] as const) {
    test(`${type} answers INTERNAL «not implemented yet», as the engine does`, async () => {
      const m = makeClipMock();
      const error = await refusal(m.client.request(type, PAYLOADS[type]));
      expect(error.code).toBe("INTERNAL");
      expect(error.detail).toBe(`${type} is not implemented yet`);
    });
  }

  test("a paid call starts no job", async () => {
    const m = makeClipMock();
    await refusal(m.client.request("clips.suggestMotions", PAYLOADS["clips.suggestMotions"]));
    const snapshot = await m.client.request("engine.snapshot", {});
    expect(snapshot.ok && snapshot.result.jobs.filter((job) => job.kind === "clip")).toEqual([]);
  });
});
