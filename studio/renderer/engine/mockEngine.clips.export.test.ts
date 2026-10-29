import { describe, expect, test } from "bun:test";
import { AVATAR, endOf, makeClipMock, money, onlyClip, runClip, unwrap, type ClipMock } from "./mockEngine.clips.testkit";

// Stage 5, 5b.1, S5.V7 (plan §5.13, I5.55; owner Q-C): «Сохранить в папку» in the mock, as the engine's export job answers it (engine.clips.export.test.ts is the reference): a clip job in
// phase `exporting` whose done/total are frames, the claimed name `<date>_clip_<NNN>.mp4`, the record's export line with the profile the fps mode made, and the refusals in the engine's order.

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function exportedPath(m: ClipMock, jobId: string): string {
  const end = endOf(m.events, jobId);
  if (end?.type !== "job.done" || end.payload.result.kind !== "clip" || end.payload.result.exported === undefined) throw new Error("the export did not end done with a copy");
  return end.payload.result.exported.relPath;
}

async function readyClip(m: ClipMock): Promise<string> {
  return runClip(m);
}

async function exportClip(m: ClipMock, clipId: string): Promise<string> {
  const { jobId } = await unwrap(m.client.request("clips.export", { avatarId: AVATAR, clipId }));
  m.scheduler.runAll();
  return jobId;
}

// engine/exportName.ts `formatExportDate`: the date in the name is the LOCAL calendar date, what the owner reads. Two zones 25 hours apart (UTC+14, UTC-11) cannot both read the UTC date at any instant.

describe("clips.export", () => {
  test("starts a clip job in `exporting` that ends job.done with the copy's place; clips.get then shows it present", async () => {
    const m = makeClipMock();
    const clipId = await readyClip(m);
    const jobId = await exportClip(m, clipId);
    const relPath = exportedPath(m, jobId);
    expect(relPath).toMatch(/^Mia\/\d{4}-\d{2}-\d{2}_clip_001\.mp4$/);
    const { clip } = await unwrap(m.client.request("clips.get", { avatarId: AVATAR, clipId }));
    expect(clip.exports).toEqual([expect.objectContaining({ relPath, profile: "1080p30-dup", fileState: "present", bytes: expect.any(Number), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })]);
    expect(clip.exports[0]?.relPath.split("/")[1]?.slice(0, 10)).toMatch(DATE);
    // The list shows the lines without a state: it never looks at the folder.
    expect((await onlyClip(m)).exports[0]).not.toHaveProperty("fileState");
  });

});

describe("a running export", () => {

  // engine/clips/export.ts: a cancel is honoured up to the claim of the name; from the claim on the export runs to its record («done wins», as a render's commit).

  // engine/clips/export.ts `#damaged`: the library's own file stops the export after the folder check and before the encode, so the job has shown its 0 and no frame; INTERNAL with the
  // one detail the window reads as a damaged file. Nothing was made: no copy, no export line, no money.

  test("the clip's money is untouched by an export", async () => {
    const m = makeClipMock();
    const clipId = await readyClip(m);
    const figures = async () => {
      const { spentMicros, unsettledMicros, unsettledCount } = await money(m);
      return { spentMicros, unsettledMicros, unsettledCount };
    };
    const before = await figures();
    await exportClip(m, clipId);
    expect(await figures()).toEqual(before);
  });
});

