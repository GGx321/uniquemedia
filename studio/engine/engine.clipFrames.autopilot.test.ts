import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { useClipFixtures } from "./clips/testing/clipFixtures";
import { answerOf, plantReadyClip } from "./clips/testing/copyKit";
import { montageOf } from "./clips/testing/renderKit";
import { openLibrary } from "./library";
import { sequentialIds, steppingClock } from "./library/testing/helpers";
import { createVideoImporter } from "./media/videoImporter";
import { crashKit, fakeRender } from "./testing/crashKit";
import { jobEnd, ok, useEngineDir } from "./testing/engineHarness";
import { draftOf, network } from "./testing/wiringKit";
import { within } from "./testing/within";
import { readVideoRecordFiles } from "./videos/listing";
import { scenePhotoIds } from "./videos/record";
useNativeGlobals();

// 5b.2, S5.WA2 (I5.60) through the autopilot's FREE steps: a photo whose clip a saved draft holds is not taken for a launch video, at the moment the video is assigned and submitted (the drafts are read
// afresh there, with the copies' origins). The avatar has twelve photos and two slides of five need ten, so a pool that forgets the draft's copies has the held photos to choose from.

setDefaultTimeout(300_000);
afterEach(() => kit.shutdownAll());
const dir = useEngineDir("studio-engine-clip-frames-autopilot-");
const kit = crashKit(dir);
beforeEach(() => kit.reset());
const sourceClip = useClipFixtures();

describe("the autopilot's free steps and a draft that holds clip copies", () => {
  test("do not use the clips' photos in a library-only launch", async () => {
    const avatarId = await kit.seedAvatar(12);
    const { library } = await openLibrary(join(dir(), "library"), { now: steppingClock(), newId: sequentialIds("probe") });
    const photoIds = library
      .photosByAvatar(avatarId)
      .map((photo) => photo.id)
      .filter((id) => id !== library.getAvatar(avatarId)?.masterPhotoId);
    expect(photoIds).toHaveLength(12);
    const [first = "", second = "", other = ""] = photoIds;
    const source = await sourceClip({ width: 360, height: 640, seconds: 3, fps: 24, audio: false });
    const plant = (photoId: string) => plantReadyClip(join(dir(), "library"), avatarId, photoId, source, { width: 360, height: 640, durationMs: 3_000 });
    const planted = [await plant(first), await plant(second)];

    const started = await kit.boot(network(), { ...fakeRender(), mediaImporters: { video: createVideoImporter() } });
    const mediaIds: string[] = [];
    for (const clip of planted) {
      const imported = answerOf(ok(await kit.call(started, "media.importClip", { avatarId, clipId: clip.clipId })));
      if (!("jobId" in imported)) throw new Error("expected an import job");
      await within(jobEnd(started.events, imported.jobId), 60_000, "the copy");
      await started.engine.mediaSettled();
      const listed = ok(await kit.call(started, "media.list", { kind: "video" }));
      if (listed.type !== "media.list") throw new Error("wrong answer");
      const found = listed.result.media.find((media) => media.origin?.clipId === clip.clipId)?.mediaId;
      if (found === undefined) throw new Error("no copy");
      mediaIds.push(found);
    }
    // The draft holds the two copies and no scene photo at all: the only photos it holds are the clips' photos, through the copies' origins.
    const created = ok(await kit.call(started, "montages.create", { avatarId, photoIds: [other] }));
    if (created.type !== "montages.create") throw new Error("wrong answer");
    const saved = await kit.call(started, "montages.save", { montageId: created.result.montage.montageId, spec: montageOf(avatarId, mediaIds.map((copy) => ({ copy }))), name: null });
    expect(saved.ok).toBe(true);

    const launch = await kit.startLaunch(started, draftOf([avatarId], { library: true, generate: false, videosPerAvatar: 2, planSeed: 7 }));
    await within(kit.driveToDone(started, launch.launchId), 150_000, "the launch");

    const used = (await readVideoRecordFiles(join(dir(), "library"), avatarId)).records.flatMap((record) => scenePhotoIds(record.spec.clips));
    expect(used).toHaveLength(10);
    expect(used).not.toContain(first);
    expect(used).not.toContain(second);
  });
});
