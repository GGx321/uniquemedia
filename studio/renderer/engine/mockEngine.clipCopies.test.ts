import { describe, expect, test } from "bun:test";
import { runUntilEnd } from "./mockEngine.clips.testkit";
import {
  AVATAR,
  clipOf,
  errorOf,
  eventsOfType,
  importCopy,
  importReply,
  makeCopyMock,
  readyClip,
  startImport,
} from "./mockEngine.clipCopies.testkit";

// Stage 5, 5b.2, S5.WA3 (plan s5b2 §5.1, I5.59): `media.importClip` in the mock, refusal for refusal and number for number as the engine answers it (engine.importClip.test.ts is the reference).
// The frame rule, the copy lifetime and `ClipSummary.use` have their own files beside this one.

describe("media.importClip: the job", () => {
  test("a clip with no copy answers a job id and starts an import job that names the clip in its ref", async () => {
    const m = makeCopyMock();
    const clipId = await readyClip(m);
    const jobId = await startImport(m, clipId);
    const first = eventsOfType(m.events, "job.progress").find((e) => e.payload.kind === "import" && e.payload.jobId === jobId);
    expect(first?.payload).toMatchObject({ kind: "import", mediaKind: "video", mediaId: null, done: 0, origin: { kind: "clip", avatarId: AVATAR, clipId } });
    expect(first?.payload.kind === "import" && first.payload.origin?.photoId).toBe((await clipOf(m, clipId)).photoId);
  });

});

describe("media.importClip: refusals, in the engine's order", () => {
  test("no library is LIBRARY_UNAVAILABLE, before the avatar or the clip is looked at", async () => {
    const m = makeCopyMock();
    const clipId = await readyClip(m);
    m.engine.setLibraryAvailable(false);
    expect((await errorOf(importReply(m, clipId))).code).toBe("LIBRARY_UNAVAILABLE");
    expect((await errorOf(importReply(m, "clip-nobody", "avatar-nobody"))).code).toBe("LIBRARY_UNAVAILABLE");
  });

});

describe("media.importClip: the job fails or is cancelled", () => {

  test("a failed import gives the clip back: it can be imported again", async () => {
    const m = makeCopyMock();
    const clipId = await readyClip(m);
    m.engine.failNextClipImport("codec");
    runUntilEnd(m, await startImport(m, clipId));
    expect(typeof (await importCopy(m, clipId))).toBe("string");
  });

});

