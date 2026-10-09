import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { readVideoRecordFiles } from "./listing";
import { videoPaths, type VideoProvenance } from "./record";
import { recoverVideos, type ExportRootRef } from "./recovery";
import { CrashError, failureOf, rig, specOf, useWorld, type World } from "./testing/kit";
useNativeGlobals();

// S4.5c (plan §8.3, §3.6 step 9): the provenance the autopilot gives a render travels through the commit into the intent and the record, and a crash between the intent and the
// record loses none of it, because recovery adopts the intent's own file. Without provenance nothing is added (a manual video carries none, A15).

const world = useWorld();
const rootRef = (w: World): ExportRootRef => ({ root: w.exportRoot, rootId: w.rootId, caseInsensitive: false });
const provenance: VideoProvenance = { origin: "autopilot", launchId: "launch-0a1b2c3d4e5f", launchVideoKey: "2-7" };
const PROVENANCE_FIELDS = ["origin", "launchId", "launchVideoKey"] as const;

async function recordOf(w: World, videoId = "video-00000001"): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(videoPaths(w.libraryRoot, w.avatar.id).record(videoId), "utf8"));
  if (typeof parsed !== "object" || parsed === null) throw new Error("the record is not an object");
  return Object.fromEntries(Object.entries(parsed));
}

describe("a commit with provenance", () => {
  test("writes origin, launch and video key into the record", async () => {
    const r = await rig(world, { input: { provenance } });
    await r.run();
    expect(await recordOf(r.w)).toMatchObject(provenance);
  });

  test("a commit without provenance writes none of the three fields", async () => {
    const r = await rig(world);
    await r.run();
    const record = await recordOf(r.w);
    for (const key of PROVENANCE_FIELDS) expect(key in record).toBe(false);
  });

  test("the record reads back through the listing with its provenance", async () => {
    const r = await rig(world, { input: { provenance } });
    await r.run();
    const read = await readVideoRecordFiles(r.w.libraryRoot, r.w.avatar.id);
    expect(read.records[0]).toMatchObject(provenance);
  });
});

describe("a crash between the intent and the record", () => {
  test("recovery adopts the video and keeps its provenance", async () => {
    const r = await rig(world, { input: { provenance } });
    await failureOf(
      r.run({
        hooks: {
          reached: (step) => {
            if (step === "dir-synced") {
              r.fs.die();
              throw new CrashError(step);
            }
          },
        },
      }),
    );
    // The window is what we say it is: an intent with its provenance, and no record yet.
    const paths = videoPaths(r.w.libraryRoot, r.w.avatar.id);
    expect(JSON.parse(await readFile(paths.intent("video-00000001"), "utf8"))).toMatchObject(provenance);
    await expect(readFile(paths.record("video-00000001"), "utf8")).rejects.toBeDefined();

    const library = await r.w.reopen();
    const report = await recoverVideos({ library, exportRoot: rootRef(r.w) }, { scratchMinAgeMs: 0 });

    expect(report.adopted).toEqual(["video-00000001"]);
    expect(await recordOf(r.w)).toMatchObject(provenance);
  });
});

describe("spec.music in the record", () => {
  const withMusic = (w: World) => ({ ...specOf(w.avatar.id, [w.photos[0]?.id ?? ""]), music: { source: "trending" as const, trackId: "track-00000001", startMs: 1500 } });

  test("a manual video keeps the track its spec names", async () => {
    const r = await rig(world, { input: { spec: withMusic(world()) } });
    await r.run();
    const record = await recordOf(r.w);
    expect(record.spec).toMatchObject({ music: { source: "trending", trackId: "track-00000001", startMs: 1500 } });
    expect("origin" in record).toBe(false);
  });

  test("an autopilot video keeps the track its spec names, beside its provenance", async () => {
    const r = await rig(world, { input: { spec: withMusic(world()), provenance } });
    await r.run();
    const record = await recordOf(r.w);
    expect(record.spec).toMatchObject({ music: { source: "trending", trackId: "track-00000001", startMs: 1500 } });
    expect(record).toMatchObject(provenance);
  });

  test("an own track survives in an autopilot record too", async () => {
    const own = { ...specOf(world().avatar.id, [world().photos[0]?.id ?? ""]), music: { source: "own" as const, mediaId: "media-00000001", startMs: 0 } };
    const r = await rig(world, { input: { spec: own, provenance } });
    await r.run();
    expect((await recordOf(r.w)).spec).toMatchObject({ music: { source: "own", mediaId: "media-00000001", startMs: 0 } });
  });
});
