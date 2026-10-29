import { describe, expect, test } from "bun:test";
import { JobProgress } from "../../shared/engine";
import { CLIP_PHOTOS, makeClipMock, progressOf, runClip } from "./mockEngine.clips.testkit";

// Stage 5, 5b.1, S5.V8b: the mock's clip create job carries the facts its tile shows, on the same jobs and at the same moments as the engine's (engine.clips.job.test.ts,
// engine.clips.restart.test.ts): from its first event, in the snapshot, and after `restart()`, where a recovery job takes them from the mock's journal and nothing else.

const FACTS = {
  photoId: CLIP_PHOTOS.plain.photoId,
  request: { model: "kling", quality: "std", seconds: 5, fallback: "auto" },
  motion: { source: "code", label: "Моргает и улыбается" },
  acceptedWorstMicros: 850_000,
} as const;


describe("a fresh clip create job in the mock", () => {
  test("every event of it carries the photo, the request, the motion's label and the accepted worst case", async () => {
    const m = makeClipMock();
    const jobId = await runClip(m);

    const events = progressOf(m.events, jobId);
    expect(events.length).toBeGreaterThan(1);
    for (const event of events) {
      expect(event).toMatchObject(FACTS);
      expect(JobProgress.safeParse(event).success).toBe(true);
    }
  });

});

