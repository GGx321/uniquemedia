import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { manifestTraits } from "../engine/avatars/records";
import { copyOfPlanted, startRenderEngine } from "../engine/clips/testing/renderKit";
import { command, jobEnd, photoJpeg } from "../engine/clips/testing/engineClipKit";
import { openLibrary } from "../engine/library";
import { PNG_1X1, samplePhotoMeta, sequentialIds, steppingClock } from "../engine/library/testing/helpers";
import { SAMPLE_SOURCE } from "../engine/library/testing/sampleData";
import { probeVideo } from "../engine/render/ffmpeg.testkit";
import { GOOD, TRAITS, useEngineDir } from "../engine/testing/engineHarness";
import { verifyRenderedMp4 } from "../engine/verify";
import { useNativeGlobals } from "../testing/nativeGlobals";
import {
  copySummaryProblems,
  fixtureClipArgv,
  fixturePosterArgv,
  frameUseProblems,
  montageSmokeExpectation,
  montageSmokeSpec,
  plantSmokeClip,
  providerFileProblems,
  runFixtureFfmpeg,
  storedCopyProblems,
} from "./clipMontageSmoke";
import { mp4Facts } from "./mp4Facts";
import { renderedFileProblems } from "./renderSmokeChecks";
useNativeGlobals();

// Stage 5, 5b.2, S5.WA3: the packaged smoke's clip-montage scenario (smoke-engine.ts, `--only clipmontage`), without Electron. The REAL engine (the real video importer, the real render queue and
// ffmpeg, the real verifier) over a real library and export folder, with no network: a fixture clip made by ffmpeg (24 fps H.264 and AAC, 2 s, 720 x 1280) is planted as TWO ready clips of two
// photos, each is imported as its copy, and a Reel of ONE photo and the TWO copies is rendered for real. The checks are clipMontageSmoke.ts's, the very ones the packaged run makes: the Reel passes
// the render verifier at 1080 x 1920, 30 fps, with the exact frame count (the 5b.2 plan, §8 S5.WA3). Needs ffmpeg and ffprobe, which a test machine has; no Electron.

setDefaultTimeout(180_000);

const dir = useEngineDir("studio-clip-montage-smoke-");

async function answer(started: Awaited<ReturnType<typeof startRenderEngine>>, type: string, payload: object) {
  const response = await started.engine.handle(command(type, payload));
  if (!response.ok) throw new Error(`${type} answered ${response.error.code}: ${response.error.detail ?? ""}`);
  return response.result;
}

describe("the smoke's clip-montage scenario, against the real engine", () => {
  test("two clips become copies and a Reel of a photo and the two copies renders for real and passes the render verifier at 1080 x 1920, 30 fps, with the exact frame count", async () => {
    const libraryDir = join(dir(), "library");
    const fixtures = join(dir(), "fixtures");
    const source = join(fixtures, "fixture-clip.mp4");
    const poster = join(fixtures, "fixture-poster.jpg");
    await Bun.$`mkdir -p ${fixtures}`.quiet();
    await runFixtureFfmpeg(fixtureClipArgv(source));
    await runFixtureFfmpeg(fixturePosterArgv(source, poster));

    // An active avatar with three gallery photos (real 720 x 1280 pictures): the scene photo of the Reel and the two photos the clips were made from.
    const { library } = await openLibrary(libraryDir, { now: steppingClock(), newId: sequentialIds("cms") });
    const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
    const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ qa: { age: { adult: true, confidence: 0.95 } } }));
    await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
    const photoIds: string[] = [];
    for (let n = 1; n <= 3; n++) {
      const meta = { mediaType: "image/jpeg" as const, width: 720, height: 1280, source: { ...SAMPLE_SOURCE, category: "home", attemptId: `run-00000099:slot-${n}#1`, slot: `slot-${n}` }, qa: { faceCos: 0.7 } };
      photoIds.push((await library.addPhoto(avatar.id, await photoJpeg(720, 1280), meta)).id);
    }
    const [scenePhoto = "", photoA = "", photoB = ""] = photoIds;
    const clipA = await plantSmokeClip(libraryDir, avatar.id, photoA, "clip-0000001", source, poster);
    const clipB = await plantSmokeClip(libraryDir, avatar.id, photoB, "clip-0000002", source, poster);

    // The engine renders for real: no scripted ffmpeg, and its own verifier decides before the commit.
    const started = await startRenderEngine(dir(), { deps: { videos: {} } });

    // 1. Each clip becomes its copy, and the provider's file is not touched.
    const mediaA = await copyOfPlanted(started, clipA);
    const mediaB = await copyOfPlanted(started, clipB);
    const listed = await answer(started, "media.list", { kind: "video" });
    const copies = "media" in listed && Array.isArray(listed.media) ? listed.media : [];
    expect(copySummaryProblems(copies.find((m: { mediaId: string }) => m.mediaId === mediaA), clipA)).toEqual([]);
    expect(copySummaryProblems(copies.find((m: { mediaId: string }) => m.mediaId === mediaB), clipB)).toEqual([]);
    for (const [clip, mediaId] of [[clipA, mediaA], [clipB, mediaB]] as const) {
      expect(providerFileProblems(clip.clipId, clip.sha256, createHash("sha256").update(await readFile(clip.file)).digest("hex"))).toEqual([]);
      expect(storedCopyProblems(await probeVideo(join(libraryDir, "media", `${mediaId}.mp4`)))).toEqual([]);
    }

    // 2. A second import of a clip answers its copy (one copy per clip).
    expect(await answer(started, "media.importClip", { avatarId: avatar.id, clipId: clipA.clipId })).toEqual({ mediaId: mediaA });

    // 3. The Reel: one photo and the two copies, rendered for real.
    const render = await answer(started, "videos.render", { spec: montageSmokeSpec(avatar.id, scenePhoto, [mediaA, mediaB]) });
    const jobId = "jobId" in render && typeof render.jobId === "string" ? render.jobId : "";
    expect(jobId).not.toBe("");
    const end = await jobEnd(started, jobId);
    expect(end.type).toBe("job.done");
    const relPath = end.type === "job.done" && end.payload.result.kind === "render" ? end.payload.result.relPath : "";
    expect(relPath).toMatch(/^Mia\/\d{4}-\d{2}-\d{2}_mix_\d{3}\.mp4$/);

    // 4. The committed file passes the engine's verifier run again and the smoke's second opinion: 1080 x 1920, 30 fps, 180 frames.
    const path = join(dir(), "export", relPath);
    const expected = montageSmokeExpectation();
    const verified = await verifyRenderedMp4(path, { frames: expected.frames });
    expect(verified.ok).toBe(true);
    const bytes = new Uint8Array(await readFile(path));
    expect(renderedFileProblems(expected, { probe: await probeVideo(path), facts: mp4Facts(bytes) })).toEqual([]);

    // 5. One frame, one video: the three photos are used by the Reel, both clips say so, and the provider's files are still not touched.
    const clips = (await answer(started, "clips.list", { avatarId: avatar.id })) as { clips: { clipId: string; use?: { inVideo?: string } }[] };
    const photos = (await answer(started, "photos.list", { avatarId: avatar.id })) as { photos: { photoId: string; used: boolean; reserved: boolean }[] };
    expect(frameUseProblems(clips.clips, [clipA.clipId, clipB.clipId], photos.photos, [scenePhoto, photoA, photoB])).toEqual([]);
    for (const clip of [clipA, clipB]) expect(providerFileProblems(clip.clipId, clip.sha256, createHash("sha256").update(await readFile(clip.file)).digest("hex"))).toEqual([]);
  });
});
