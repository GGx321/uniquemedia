import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import type { AutopilotGetResult, AutopilotListResult, LaunchDraftInput } from "../shared/engine";
import { manifestTraits } from "./avatars/records";
import { openLibrary } from "./library";
import { PNG_1X1, samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import { LaunchFile } from "./autopilot/launchFile";
import { IDLE_STEPS } from "./autopilot/steps";
import { publishedPath } from "./videos/published";
import { parseRecordSpec, videoPaths } from "./videos/record";
import { specOf } from "./videos/testing/kit";
import { command, engineSettings, failed, GOOD, ok, startEngine, TRAITS, useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 4, S4.6g: what `autopilot.get` and `autopilot.list` say of a launch's videos once the owner has marked them «Опубликовано» or deleted them, on a real engine over a
// real library: the launch file, the video records and `published.jsonl` are files in a temp dir, the marks and the deletes are the engine's own commands. The steps are idle
// (nothing is composed or rendered); the launch file is given its finished videos by hand, as the free steps would have written them.

setDefaultTimeout(30_000);

const dir = useEngineDir("studio-engine-autopilot-videos-");
const libraryDir = () => join(dir(), "library");
const autopilotDir = () => join(libraryDir(), "autopilot");

const FIRST = "video-0000ad01";
const SECOND = "video-0000ad02";
const MUSIC = { source: "trending" as const, trackId: "track-00000001", startMs: 1500 };

type Started = Awaited<ReturnType<typeof startEngine>>;

interface Seeded {
  readonly avatarId: string;
  readonly photoIds: readonly string[];
}

/** An active avatar with two scene photos, and a record file for each of the two videos (as a commit leaves them), before the engine opens the library. */
async function seed(): Promise<Seeded> {
  const { library } = await openLibrary(libraryDir(), { now: steppingClock(), newId: sequentialIds("vidmarks") });
  const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
  const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  const photoIds: string[] = [];
  for (let n = 0; n < 2; n++) photoIds.push((await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta())).id);
  const paths = videoPaths(libraryDir(), avatar.id);
  await mkdir(paths.videosDir, { recursive: true });
  for (const [i, id] of [FIRST, SECOND].entries()) {
    const record = {
      schemaVersion: 1,
      id,
      avatarId: avatar.id,
      jobId: `job-0000ad0${i + 1}`,
      createdAt: `2026-10-09T10:0${i}:00.000Z`,
      kind: "photo",
      durationMs: 1000,
      frames: 30,
      montageId: null,
      music: null,
      file: { rootId: "root-00000001", relPath: `Mia/2026-10-09_photo_00${i + 1}.mp4`, bytes: 2048, sha256: "0".repeat(64) },
      spec: parseRecordSpec(specOf(avatar.id, [photoIds[i] ?? ""])),
    };
    await writeFile(paths.record(id), JSON.stringify(record));
  }
  return { avatarId: avatar.id, photoIds };
}

const draftOf = (avatarId: string): LaunchDraftInput => ({
  avatarIds: [avatarId],
  videosPerAvatar: 4,
  mix: { single: 50, collage: 25, slides: 25 },
  categories: ["home"],
  poses: { profile: false, back: false },
  library: false,
  generate: true,
  sceneReview: false,
  stickers: false,
});

async function boot(): Promise<Started> {
  await mkdir(join(dir(), "export"), { recursive: true });
  return startEngine(dir(), { init: { settings: engineSettings(dir(), { imageAgeCheck: "off", monthlyBudgetMicros: 10_000_000 }) }, deps: { launchSteps: IDLE_STEPS } });
}

async function startLaunch(started: Started, avatarId: string): Promise<string> {
  const draft = draftOf(avatarId);
  const estimated = ok(await started.engine.handle(command("autopilot.estimate", { draft })));
  if (estimated.type !== "autopilot.estimate") throw new Error("not an estimate");
  const { preview } = estimated.result;
  const answer = ok(await started.engine.handle(command("autopilot.start", { draft: { ...draft, planSeed: preview.planSeed }, acceptedWorstMicros: preview.estimate.worstMicros })));
  if (answer.type !== "autopilot.start") throw new Error("not a start");
  return answer.result.launch.launchId;
}

/** Gives the launch's first two videos their files, as the free steps write a finished video; the idle steps write nothing of their own. */
function finishTwo(launchId: string): void {
  const path = join(autopilotDir(), `${launchId}.json`);
  const file = LaunchFile.parse(JSON.parse(readFileSync(path, "utf8")));
  const ids = [FIRST, SECOND];
  const avatars = file.avatars.map((row, i) => (i === 0 ? { ...row, videos: row.videos.map((v, j) => (j < 2 ? { ...v, state: "done" as const, videoId: ids[j] ?? null, music: MUSIC, durationMs: 7_000, bytes: 4_096 } : v)) } : row));
  writeFileSync(path, JSON.stringify({ ...file, avatars }));
}

async function getLaunch(started: Started, launchId: string): Promise<AutopilotGetResult> {
  const answer = ok(await started.engine.handle(command("autopilot.get", { launchId })));
  if (answer.type !== "autopilot.get") throw new Error("not a get");
  return answer.result;
}

async function listLaunches(started: Started): Promise<z.infer<typeof AutopilotListResult>> {
  const answer = ok(await started.engine.handle(command("autopilot.list")));
  if (answer.type !== "autopilot.list") throw new Error("not a list");
  return answer.result;
}

const doneVideos = (got: AutopilotGetResult) => got.videos.filter((v) => v.state === "done");

describe("autopilot.get and autopilot.list after a mark and a delete (S4.6g)", () => {
  test("publish, then delete: the view shows the mark, then the removed video, and the history count drops", async () => {
    const { avatarId } = await seed();
    const started = await boot();
    const launchId = await startLaunch(started, avatarId);
    finishTwo(launchId);

    const before = await getLaunch(started, launchId);
    expect(doneVideos(before).map((v) => [v.videoId, v.publishedAt, v.removed ?? false])).toEqual([
      [FIRST, null, false],
      [SECOND, null, false],
    ]);
    expect("published" in before).toBe(false);
    expect((await listLaunches(started)).launches[0]?.videosDone).toBe(2);

    const marked = ok(await started.engine.handle(command("videos.setPublished", { videoId: FIRST, published: true })));
    const at = marked.type === "videos.setPublished" ? (marked.result.video.publishedAt ?? null) : null;
    expect(typeof at).toBe("string");
    const published = await getLaunch(started, launchId);
    expect(doneVideos(published).map((v) => [v.videoId, v.publishedAt])).toEqual([
      [FIRST, at],
      [SECOND, null],
    ]);
    expect(published.published).toBe("ok");

    ok(await started.engine.handle(command("videos.delete", { videoId: FIRST, mode: "record" })));
    const after = await getLaunch(started, launchId);
    expect(doneVideos(after).map((v) => [v.videoId, v.removed ?? false])).toEqual([
      [FIRST, true],
      [SECOND, false],
    ]);
    // The mark is the log's, and the log outlives the record.
    expect(doneVideos(after)[0]?.publishedAt).toBe(at);
    expect((await listLaunches(started)).launches[0]?.videosDone).toBe(1);
  });

  test("a published log that cannot be read says unknown on the avatar's finished videos, not null", async () => {
    const { avatarId } = await seed();
    await writeFile(publishedPath(libraryDir(), avatarId), "this is not a mark\n");
    const started = await boot();
    const launchId = await startLaunch(started, avatarId);
    finishTwo(launchId);

    const got = await getLaunch(started, launchId);
    expect(got.published).toBe("unknown");
    expect(doneVideos(got).map((v) => [v.publishedAt, v.publishedUnknown ?? false])).toEqual([
      [null, true],
      [null, true],
    ]);
    // The records stand whatever the log says.
    expect(doneVideos(got).some((v) => v.removed === true)).toBe(false);
  });

  test("an avatar whose videos folder is gone has every finished video removed, and the history counts none of them", async () => {
    const { avatarId } = await seed();
    const started = await boot();
    const launchId = await startLaunch(started, avatarId);
    finishTwo(launchId);
    await rm(videoPaths(libraryDir(), avatarId).videosDir, { recursive: true, force: true });

    expect(doneVideos(await getLaunch(started, launchId)).every((v) => v.removed === true)).toBe(true);
    expect((await listLaunches(started)).launches[0]?.videosDone).toBe(0);
  });

  test("a folder of launches that cannot be listed is one unreadable entry of scope folder", async () => {
    await seed();
    await rm(autopilotDir(), { recursive: true, force: true });
    await writeFile(autopilotDir(), "I am a file");
    const started = await boot();
    const listed = await listLaunches(started);
    expect(listed.unreadable).toEqual([{ entryId: expect.stringMatching(/^[0-9a-f]{16}$/), reason: "io-error", scope: "folder" }]);
  });

  test.skipIf(process.platform === "win32")("a launch file the disk will not open is an unreadable entry of scope file", async () => {
    const { avatarId } = await seed();
    const started = await boot();
    const launchId = await startLaunch(started, avatarId);
    const path = join(autopilotDir(), `${launchId}.json`);
    await writeFile(join(autopilotDir(), "launch-locked-0001.json"), "{}");
    await chmod(join(autopilotDir(), "launch-locked-0001.json"), 0o000);
    try {
      const listed = await listLaunches(started);
      expect(listed.unreadable).toEqual([{ entryId: expect.stringMatching(/^[0-9a-f]{16}$/), reason: "io-error", scope: "file" }]);
      expect(readFileSync(path, "utf8").length).toBeGreaterThan(0);
    } finally {
      await chmod(join(autopilotDir(), "launch-locked-0001.json"), 0o644);
    }
  });

  test("a launch that is not there is NOT_FOUND, as before", async () => {
    await seed();
    const started = await boot();
    expect(failed(await started.engine.handle(command("autopilot.get", { launchId: "launch-nobody0404" }))).error.code).toBe("NOT_FOUND");
  });
});
