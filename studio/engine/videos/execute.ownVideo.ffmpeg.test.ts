import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { copyFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { MontageDraft } from "../../shared/engine/montage";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { CaseSensitivityProbe } from "../exportCase";
import { JobRegistry } from "../jobs";
import { SAMPLE_SOURCE, samplePhotoMeta } from "../library/testing/helpers";
import { ffmpegPath } from "../../node/ffmpegBinary";
import { probeVideo, runBinary, videoFrames } from "../render/ffmpeg.testkit";
import { RenderQueue } from "../renderQueue/queue";
import { CommitTracker, createRenderExecute, totalFramesOf, type RenderPlan } from "./execute";
import type { OwnVideoSource } from "./ownVideos";
import { RAMP } from "./testing/fixtures/index";
import { frameNumbersOf } from "./testing/mezzanineKit";
import { exportFiles, jpegWithArtist, specOf, useWorld, type World } from "./testing/kit";
useNativeGlobals();
setDefaultTimeout(120_000);

// A real own-video render, end to end (3f.3b): a spec of a scene photo and an own video clip through the REAL runner, the REAL verifier and the commit, by way of the real
// RenderQueue, from a small COMMITTED mezzanine (`testing/fixtures`, made by 3f.3a's importer). The mezzanine is in a folder standing in for the library's `media/`; the
// render streams a verified copy into its own job folder and the library file is never an ffmpeg input.

const world = useWorld();
const PHOTO_FILE = join(import.meta.dir, "../face/fixtures/images/render-best-home-1.jpg");
const MEDIA_ID = "media-0000007";

let libraryFile = "";
beforeEach(async () => {
  libraryFile = join(world().renderTmp, "..", "library-media", `${MEDIA_ID}.mp4`);
  await mkdir(dirname(libraryFile), { recursive: true });
  await copyFile(RAMP.file, libraryFile);
});
afterEach(async () => {
  await rm(dirname(libraryFile), { recursive: true, force: true });
});

const source = (over: Partial<OwnVideoSource> = {}): OwnVideoSource => ({ mediaId: MEDIA_ID, path: libraryFile, sha256: RAMP.sha256, bytes: RAMP.bytes, width: RAMP.width, height: RAMP.height, durationMs: RAMP.durationMs, ...over });

async function renderMix(w: World, own: OwnVideoSource, video: { trimStartMs: number; durationMs: number }) {
  const photo = await w.library.addPhoto(w.avatar.id, jpegWithArtist("Jane Q. Photographer"), samplePhotoMeta({ mediaType: "image/jpeg", width: 720, height: 1280, source: { ...SAMPLE_SOURCE, category: "beach" } }));
  const photoSpec = specOf(w.avatar.id, [photo.id], 1_000);
  const spec: MontageDraft = {
    ...photoSpec,
    clips: [...photoSpec.clips, { clipId: "clip-00000099", kind: "video", mediaId: MEDIA_ID, trimStartMs: video.trimStartMs, focus: { x: 0.5, y: 0.5 }, durationMs: video.durationMs, transitionIn: "cut" }],
  };
  const plan: RenderPlan = {
    jobId: "job-00000001",
    videoId: "video-00000001",
    avatarId: w.avatar.id,
    safeName: "Mia",
    exportRoot: { root: w.exportRoot, rootId: w.rootId },
    spec,
    resolvePhoto: () => ({ path: PHOTO_FILE, width: 720, height: 1280 }),
    ownVideos: [own],
    audio: { kind: "silent" },
    montageId: null,
    title: null,
    videoKind: "mix",
    music: null,
  };
  const now = () => new Date(2026, 9, 4, 10, 0, 0);
  const execute = createRenderExecute({ library: w.library, tracker: new CommitTracker(), renderTmpDir: w.renderTmp, caseProbe: new CaseSensitivityProbe(), now });
  const queue = new RenderQueue({ jobs: new JobRegistry(), size: () => 1 });
  const submitted = queue.submit({ jobId: plan.jobId, ref: { videoId: plan.videoId, avatarId: plan.avatarId, montageId: null }, totalFrames: totalFramesOf(spec.clips), photoIds: [photo.id], mediaIds: [MEDIA_ID], execute: execute(plan) });
  expect(submitted).toEqual({ ok: true });
  await queue.idle();
  const [state] = queue.states();
  return { state, photoId: photo.id };
}

describe("a real render of a scene photo and an own video clip", () => {
  test("renders, verifies and commits: the file has exactly the clips' frames, 1080 x 1920 H.264, and the right frames of the mezzanine", async () => {
    const w = world();
    const { state } = await renderMix(w, source(), { trimStartMs: 1_000, durationMs: 1_000 });

    expect(state).toMatchObject({ status: "done", done: 60, total: 60, result: { kind: "render", durationMs: 2_000, videoKind: "mix" } });
    const files = await exportFiles(w);
    expect(files).toHaveLength(1);
    const file = join(w.exportRoot, files[0] ?? "");
    expect((await probeVideo(file)).streams.find((s) => s.codec_type === "video")).toMatchObject({ codec_name: "h264", width: 1080, height: 1920 });
    expect(await videoFrames(file)).toBe(60);
    // The video clip is the second second: frames 30 to 59 of the output are frames 30 to 59 of the mezzanine (trim 1.0 s = frame 30).
    const played = frameNumbersOf(file).slice(30);
    expect(played).toEqual(Array.from({ length: 30 }, (_, i) => 30 + i));
  });

  test("the finished video's only sound is the montage's own silence (the clip's audio is never used), and it carries no metadata of the mezzanine's or the photo's", async () => {
    const w = world();
    await renderMix(w, source(), { trimStartMs: 0, durationMs: 1_000 });
    const [name = ""] = await exportFiles(w);
    const file = join(w.exportRoot, name);
    expect((await probeVideo(file)).streams.map((s) => s.codec_type)).toEqual(["video", "audio"]);
    const run = await runBinary(ffmpegPath(), ["-hide_banner", "-nostdin", "-i", file, "-vn", "-af", "volumedetect", "-f", "null", "-"]);
    expect(run.stderr).toMatch(/max_volume: -91\.0 dB|max_volume: -inf dB/);
    expect(Buffer.from(await readFile(file)).includes(Buffer.from("Jane Q. Photographer"))).toBe(false);
  });

  test("the library file is untouched, and nothing is left in the render's folder", async () => {
    const w = world();
    const before = await readFile(libraryFile);
    await renderMix(w, source(), { trimStartMs: 0, durationMs: 1_000 });
    expect(Buffer.compare(before, await readFile(libraryFile))).toBe(0);
    expect(await readdir(w.renderTmp)).toEqual([]);
  });

  test("a clip that ends exactly at the mezzanine's end renders (frames 60 to 89)", async () => {
    const w = world();
    const { state } = await renderMix(w, source(), { trimStartMs: 2_000, durationMs: 1_000 });
    expect(state).toMatchObject({ status: "done" });
    const [name = ""] = await exportFiles(w);
    expect(await videoFrames(join(w.exportRoot, name))).toBe(60);
  });

  test("a mezzanine whose record says it is longer than the file really is fails the job, never a silent shorter clip", async () => {
    // The record says 3000 ms (90 frames) for a 90-frame file; ask for 1 s from 2.5 s (frames 75 to 104): the plan's own length check lets it through only if the record lies.
    const w = world();
    const { state } = await renderMix(w, source({ durationMs: 3_600 }), { trimStartMs: 2_500, durationMs: 1_000 });
    expect(state).toMatchObject({ status: "failed", error: { code: "RENDER_FAILED" } });
    expect(state?.error?.detail).toMatch(/frames/);
    expect(JSON.stringify(state)).not.toContain(w.dir);
    expect(await exportFiles(w)).toEqual([]);
    expect(await readdir(w.renderTmp)).toEqual([]);
  });
});
