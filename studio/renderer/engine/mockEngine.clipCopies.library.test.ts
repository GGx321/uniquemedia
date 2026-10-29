import { describe, expect, test } from "bun:test";
import { create, runUntilEnd, unwrap } from "./mockEngine.clips.testkit";
import {
  errorOf,
  importReply,
  makeCopyMock,
  readyClip,
} from "./mockEngine.clipCopies.testkit";

// Stage 5, 5b.2, S5.WA3 (round 2): the corners of the mirror: the importer's fit, the library under a switch or gone, and the avatar delete's words for a clip job.

describe("the library under a switch or gone", () => {
  test("a library switch under way refuses the import IN_FLIGHT, after `not-ready` is told", async () => {
    const m = makeCopyMock();
    const clipId = await readyClip(m);
    m.engine.scriptNextClip("refused-free");
    const { jobId: failed } = await unwrap(create(m, { fallback: "none", acceptedWorstMicros: 504_000 }));
    runUntilEnd(m, failed);
    m.engine.setLibrarySwitching(true);
    expect((await errorOf(importReply(m, failed))).clipReason).toBe("not-ready");
    expect((await errorOf(importReply(m, clipId))).code).toBe("IN_FLIGHT");
  });

});

