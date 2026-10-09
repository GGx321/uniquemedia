import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { videoPaths, type VideoProvenance } from "../videos/record";
import { CrashError, failureOf, rig, useWorld, type Rig } from "../videos/testing/kit";
import { lookupVideo, scanProvenance } from "./provenanceScan";
useNativeGlobals();

// S4.6c1 (plan §3.6 step 9, §19): what the library says of a launch's videos, by the provenance the records and the pending intents carry. «The record file exists but does not read» is NOT
// «no record»: the scan says `complete: false` and the steps wait, they never render again. `lookupVideo` tells the three answers for one video id apart (a record, none, one that does not read).

const world = useWorld();
const LAUNCH = "launch-0a1b2c3d4e5f";
const provenance = (key: string, launchId = LAUNCH): VideoProvenance => ({ origin: "autopilot", launchId, launchVideoKey: key });

let counter = 0;
async function commit(key: string, launchId = LAUNCH): Promise<Rig & { videoId: string }> {
  counter += 1;
  const n = String(counter).padStart(8, "0");
  const r = await rig(world, { input: { provenance: provenance(key, launchId), jobId: `job-${n}`, videoId: `video-${n}` } });
  await r.run();
  return { ...r, videoId: `video-${n}` };
}

/** A commit that dies right after the intent is durable: an intent with its provenance, no record. */
async function commitToIntent(key: string): Promise<string> {
  counter += 1;
  const n = String(counter).padStart(8, "0");
  const r = await rig(world, { input: { provenance: provenance(key), jobId: `job-${n}`, videoId: `video-${n}` } });
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
  return `video-${n}`;
}

describe("scanProvenance", () => {
  test("a library with no videos folder has no finding and is complete", async () => {
    const w = world();
    const scan = await scanProvenance(w.libraryRoot, w.avatar.id, LAUNCH);
    expect(scan.byKey.size).toBe(0);
    expect(scan.complete).toBe(true);
  });

  test("a record of the launch is found by its video key, with its length and size", async () => {
    const r = await commit("0-3");
    const scan = await scanProvenance(r.w.libraryRoot, r.w.avatar.id, LAUNCH);
    expect(scan.complete).toBe(true);
    expect(scan.byKey.get("0-3")).toMatchObject({ kind: "record", durationMs: 1000 });
  });

  test("a record of another launch, and a manual one, are not this launch's", async () => {
    const other = await commit("0-1", "launch-ffffffffffff");
    const scan = await scanProvenance(other.w.libraryRoot, other.w.avatar.id, LAUNCH);
    expect(scan.byKey.size).toBe(0);
    expect(scan.complete).toBe(true);
  });

  test("an intent whose commit died before the record is found as an intent", async () => {
    const videoId = await commitToIntent("1-2");
    const w = world();
    const scan = await scanProvenance(w.libraryRoot, w.avatar.id, LAUNCH);
    expect(scan.byKey.get("1-2")).toEqual({ kind: "intent", videoId });
    expect(scan.complete).toBe(true);
  });

  test("a record file that does not read makes the scan incomplete: «no finding» is then not «no video»", async () => {
    const w = world();
    const paths = videoPaths(w.libraryRoot, w.avatar.id);
    await mkdir(paths.videosDir, { recursive: true });
    await writeFile(paths.record("video-0000bad1"), "{ this is not json");
    const scan = await scanProvenance(w.libraryRoot, w.avatar.id, LAUNCH);
    expect(scan.complete).toBe(false);
    expect(scan.byKey.size).toBe(0);
  });

  test("an incomplete scan still reports what it did find", async () => {
    const r = await commit("0-1");
    const paths = videoPaths(r.w.libraryRoot, r.w.avatar.id);
    await writeFile(paths.record("video-0000bad1"), "[]");
    const scan = await scanProvenance(r.w.libraryRoot, r.w.avatar.id, LAUNCH);
    expect(scan.complete).toBe(false);
    expect(scan.byKey.get("0-1")?.kind).toBe("record");
  });

  test("an intent file that does not read makes the scan incomplete too", async () => {
    const w = world();
    const paths = videoPaths(w.libraryRoot, w.avatar.id);
    await mkdir(paths.pendingDir, { recursive: true });
    await writeFile(paths.intent("video-0000bad2"), "nope");
    const scan = await scanProvenance(w.libraryRoot, w.avatar.id, LAUNCH);
    expect(scan.complete).toBe(false);
  });

  test("a temp file of an intent being written is not an intent", async () => {
    const w = world();
    const paths = videoPaths(w.libraryRoot, w.avatar.id);
    await mkdir(paths.pendingDir, { recursive: true });
    await writeFile(`${paths.pendingDir}/.video-0000bad3.json.abcdef.tmp`, "half");
    const scan = await scanProvenance(w.libraryRoot, w.avatar.id, LAUNCH);
    expect(scan.complete).toBe(true);
  });

  test("more record files than one read takes is incomplete: the one that matters may be past the bound", async () => {
    await commit("0-1");
    await commit("0-2");
    const w = world();
    const scan = await scanProvenance(w.libraryRoot, w.avatar.id, LAUNCH, { maxFiles: 1 });
    expect(scan.complete).toBe(false);
  });

  test("the key of a record wins over an intent of the same key", async () => {
    const r = await commit("0-5");
    const paths = videoPaths(r.w.libraryRoot, r.w.avatar.id);
    await mkdir(paths.pendingDir, { recursive: true });
    const record = await Bun.file(paths.record(r.videoId)).text();
    await writeFile(paths.intent("video-00000999"), record.replace(`"${r.videoId}"`, '"video-00000999"'));
    const scan = await scanProvenance(r.w.libraryRoot, r.w.avatar.id, LAUNCH);
    expect(scan.byKey.get("0-5")?.kind).toBe("record");
  });
});

describe("lookupVideo: a record, none, or one that does not read", () => {
  test("a committed video is a record", async () => {
    const r = await commit("0-1");
    const found = await lookupVideo(r.w.libraryRoot, r.w.avatar.id, r.videoId);
    expect(found.kind).toBe("record");
  });

  test("a video with no file is missing", async () => {
    const w = world();
    expect((await lookupVideo(w.libraryRoot, w.avatar.id, "video-00000042")).kind).toBe("missing");
  });

  test("a file that exists and does not read is unreadable, NOT missing", async () => {
    const w = world();
    const paths = videoPaths(w.libraryRoot, w.avatar.id);
    await mkdir(paths.videosDir, { recursive: true });
    await writeFile(paths.record("video-00000042"), "{ torn");
    expect((await lookupVideo(w.libraryRoot, w.avatar.id, "video-00000042")).kind).toBe("unreadable");
  });

  test("a record of another avatar's name is unreadable here, never a record of this avatar", async () => {
    const r = await commit("0-1");
    const paths = videoPaths(r.w.libraryRoot, r.w.avatar.id);
    const text = await Bun.file(paths.record(r.videoId)).text();
    await writeFile(paths.record("video-00000077"), text);
    expect((await lookupVideo(r.w.libraryRoot, r.w.avatar.id, "video-00000077")).kind).toBe("unreadable");
  });
});
