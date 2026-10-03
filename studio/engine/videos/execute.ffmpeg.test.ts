import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { CaseSensitivityProbe } from "../exportCase";
import { formatExportDate } from "../exportName";
import { JobRegistry } from "../jobs";
import { probeVideo, videoFrames } from "../render/ffmpeg.testkit";
import { RenderQueue } from "../renderQueue/queue";
import { SAMPLE_SOURCE, samplePhotoMeta } from "../library/testing/helpers";
import { CommitTracker, createRenderExecute, totalFramesOf, type RenderPlan } from "./execute";
import { FileStateChecker } from "./fileState";
import { recoverVideos } from "./recovery";
import { VideoRecordSchema, videoPaths } from "./record";
import { exportFiles, jpegWithArtist, libraryVideoFiles, sha256Of, specOf, useWorld } from "./testing/kit";
useNativeGlobals();

// Task 3a.8b.1, the one end-to-end test: a 1-clip spec through the REAL runner,
// the REAL verifier and the commit, into a temp export root, by way of the real
// RenderQueue. Then the record, the used index and `fileState` are checked, and a
// library restart finds nothing to settle. 1 s, 30 frames.

const world = useWorld();
const PHOTO_FILE = join(import.meta.dir, "../face/fixtures/images/render-best-home-1.jpg");

describe("a real render, end to end", () => {
  test("renders, verifies, commits: the file, the record, the used index and fileState `present` all agree", async () => {
    const w = world();
    // A scene photo whose own EXIF names an artist: that text is handed to the real verifier and must not be in the output.
    const artist = "Jane Q. Photographer";
    const photo = await w.library.addPhoto(w.avatar.id, jpegWithArtist(artist), samplePhotoMeta({ mediaType: "image/jpeg", width: 720, height: 1280, source: { ...SAMPLE_SOURCE, category: "beach" } }));
    const plan: RenderPlan = {
      jobId: "job-00000001",
      videoId: "video-00000001",
      avatarId: w.avatar.id,
      safeName: "Mia",
      exportRoot: { root: w.exportRoot, rootId: w.rootId },
      spec: specOf(w.avatar.id, [photo.id], 1000),
      resolvePhoto: () => ({ path: PHOTO_FILE, width: 720, height: 1280 }),
      audio: { kind: "silent" },
      montageId: null,
      videoKind: "photo",
      music: null,
    };
    const tracker = new CommitTracker();
    const now = () => new Date(2026, 8, 29, 10, 0, 0); // fixed: the file name carries the date, and a run across midnight must not fail
    const execute = createRenderExecute({ library: w.library, tracker, renderTmpDir: w.renderTmp, caseProbe: new CaseSensitivityProbe(), now });
    const queue = new RenderQueue({ jobs: new JobRegistry(), size: () => 1 });

    const submitted = queue.submit({ jobId: plan.jobId, ref: { videoId: plan.videoId, avatarId: plan.avatarId, montageId: null }, totalFrames: totalFramesOf(plan.spec.clips), photoIds: [photo.id], execute: execute(plan) });
    expect(submitted).toEqual({ ok: true });
    await queue.idle();

    // The job
    const relPath = `Mia/${formatExportDate(now())}_photo_001.mp4`;
    const [state] = queue.states();
    expect(state).toMatchObject({ status: "done", done: 30, total: 30, result: { kind: "render", videoId: plan.videoId, videoKind: "photo", durationMs: 1000, relPath } });

    // The file, once, in the export folder, and nothing else there
    const file = join(w.exportRoot, relPath);
    expect(await exportFiles(w)).toEqual([relPath]);
    const probed = await probeVideo(file);
    expect(probed.streams.find((s) => s.codec_type === "video")).toMatchObject({ codec_name: "h264", width: 1080, height: 1920 });
    expect(await videoFrames(file)).toBe(30);
    expect(readFileSync(file).includes(Buffer.from(artist))).toBe(false);

    // The record
    expect(await libraryVideoFiles(w)).toEqual([`${plan.videoId}.json`]);
    const record = VideoRecordSchema.parse(JSON.parse(readFileSync(videoPaths(w.libraryRoot, w.avatar.id).record(plan.videoId), "utf8")));
    expect(record.file).toMatchObject({ rootId: w.rootId, relPath, bytes: readFileSync(file).length, sha256: sha256Of(readFileSync(file)) });
    expect(record).toMatchObject({ jobId: plan.jobId, frames: 30, durationMs: 1000, kind: "photo" });

    // The used index, live and after a restart
    expect(w.library.photoStates(w.avatar.id).get(photo.id)?.usedIn).toEqual([plan.videoId]);
    const reopened = await w.reopen();
    expect(reopened.photoStates(w.avatar.id).get(photo.id)?.usedIn).toEqual([plan.videoId]);

    // fileState: present, from a stat alone (the record's mtime matches), and by the full check
    const rootRef = { root: w.exportRoot, rootId: w.rootId, caseInsensitive: false };
    const noHash = new FileStateChecker({ hashFile: () => Promise.reject(new Error("the cheap check must not read the file")) });
    expect(await noHash.check(record, rootRef, { verify: "cheap" })).toBe("present");
    expect(await new FileStateChecker().check(record, rootRef, { verify: "full" })).toBe("present");

    // A restart has nothing to settle: no temp, no placeholder, no intent, and nothing was deleted
    expect(tracker.tempPaths().size + tracker.placeholderPaths().size).toBe(0);
    const report = await recoverVideos({ library: reopened, exportRoot: rootRef });
    expect(report).toMatchObject({ adopted: [], dropped: [], deferred: [], left: [], removed: { placeholders: 0, intentTemps: 0, markerTemps: 0, probes: 0, partTemps: 0 } });
    expect(await exportFiles(w)).toEqual([relPath]);
  }, 60_000);
});
