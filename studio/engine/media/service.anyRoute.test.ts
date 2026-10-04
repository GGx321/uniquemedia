import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PickedFileIdentity, UnsequencedEvent } from "../../shared/engine";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { tempDirFor } from "../../testing/tempDir";
import { JobRegistry } from "../jobs";
import { rampFrames, sourceFromRaw } from "../videos/testing/mezzanineKit";
import { runFfmpegOk } from "../render/ffmpeg.testkit";
import { pickedIdentityOf } from "./identity";
import type { MediaImportCall } from "./imports";
import { createMusicImporter } from "./musicImporter";
import { MediaService } from "./service";
import { buildMp4 } from "./video/testing/mp4VideoBuilder";
import { createVideoImporter } from "./videoImporter";
useNativeGlobals();
setDefaultTimeout(60_000);

// 3f.6 through the whole import job, on real ffmpeg: the ONE drop zone (`any`) takes an MP4 by its TRACKS. A voice note an Android recorder wrote (sound only, brand
// `isom`) was refused as a video before; now it imports as a track. A video is still a video, and a file with neither track is turned away with a reason at the door.

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-media-anyroute-");
const libraryRoot = (): string => join(tmp(), "library");
const pickedDir = (): string => join(tmp(), "picked");
const stagingDir = (): string => join(libraryRoot(), "media", ".staging");

beforeEach(async () => {
  await mkdir(libraryRoot(), { recursive: true });
  await mkdir(pickedDir(), { recursive: true });
});

let counter = 0;
function rig(): { service: MediaService; jobs: JobRegistry; events: UnsequencedEvent[] } {
  const jobs = new JobRegistry();
  const events: UnsequencedEvent[] = [];
  const service = new MediaService({
    jobs,
    emit: (event) => events.push(event),
    withLibrary: (work) => work({ root: libraryRoot() }),
    newId: () => `id-${String(++counter).padStart(8, "0")}`,
    now: () => new Date("2026-10-04T10:00:00.000Z"),
    importers: { audio: createMusicImporter(), video: createVideoImporter() },
    log: () => undefined,
  });
  return { service, jobs, events };
}

async function callFor(name: string, bytes: Uint8Array): Promise<MediaImportCall> {
  const path = join(pickedDir(), name);
  await writeFile(path, bytes);
  const expected: PickedFileIdentity = pickedIdentityOf(await lstat(path, { bigint: true }));
  return { pick: "any", path, name, expected };
}

/** A voice note as an Android recorder writes it: five seconds of AAC in an MP4 of brand `isom`, sound only, made by the bundled ffmpeg. */
async function voiceNote(): Promise<Uint8Array> {
  const out = join(tmp(), "voice-note.mp4");
  await runFfmpegOk(["-hide_banner", "-y", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=5", "-c:a", "aac", "-b:a", "96k", "-f", "mp4", out]);
  return new Uint8Array(await Bun.file(out).arrayBuffer());
}

async function imported(name: string, bytes: Uint8Array): Promise<{ r: ReturnType<typeof rig>; jobId: string }> {
  const r = rig();
  const result = await r.service.import(await callFor(name, bytes));
  if (!result.ok) throw new Error(`refused at the door: ${result.reason} (${result.detail})`);
  await r.service.settled();
  return { r, jobId: result.jobId };
}

describe("an MP4 through the one drop zone", () => {
  test("the voice note really is an isom file with no picture in it (so the sniff alone calls it a video)", async () => {
    const bytes = await voiceNote();
    expect(Buffer.from(bytes.subarray(4, 12)).toString("latin1")).toBe("ftypisom");
  });

  test("a sound-only isom MP4 picked as any imports as a TRACK: an audio record with a length and no picture, stored as an M4A", async () => {
    const { r, jobId } = await imported("voice-note.mp4", await voiceNote());
    expect(r.jobs.stateOf(jobId)).toMatchObject({ status: "done", mediaKind: "audio" });
    const listed = await r.service.list();
    expect(listed.total).toBe(1);
    expect(listed.media[0]).toMatchObject({ kind: "audio", name: "voice-note.mp4", width: null, height: null, sourceFps: null, hdrToSdr: false });
    expect(listed.media[0]?.durationMs).toBeGreaterThan(4800);
    expect(listed.media[0]?.durationMs).toBeLessThan(5300);
  });

  test("it leaves nothing in the staging folder", async () => {
    await imported("voice-note.mp4", await voiceNote());
    expect(await readdir(stagingDir()).catch(() => [])).toEqual([]);
  });

  test("an MP4 with a video track imports as a VIDEO, as before", async () => {
    const source = await sourceFromRaw(tmp(), "clip", rampFrames(64, 64, 30));
    const { r, jobId } = await imported("clip.mp4", source);
    expect(r.jobs.stateOf(jobId)).toMatchObject({ status: "done", mediaKind: "video" });
    expect((await r.service.list()).media[0]).toMatchObject({ kind: "video", width: 64, height: 64 });
  });

  test("an MP4 with neither a video nor a sound track is refused at the door with a clear reason, and no job starts", async () => {
    const r = rig();
    const result = await r.service.import(await callFor("empty.mp4", buildMp4({ tracks: [] })));
    expect(result).toMatchObject({ ok: false, reason: "format" });
    if (!result.ok) expect(result.detail).toBe("the file holds neither a video nor a sound track");
    expect(r.jobs.activeImports()).toBe(0);
    expect(r.events).toEqual([]);
  });

  test("a voice note shorter than the shortest montage is a track that is refused too-short, with its own text's reason", async () => {
    const out = join(tmp(), "blip.mp4");
    await runFfmpegOk(["-hide_banner", "-y", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=1", "-c:a", "aac", "-f", "mp4", out]);
    const { r, jobId } = await imported("blip.mp4", new Uint8Array(await Bun.file(out).arrayBuffer()));
    expect(r.jobs.stateOf(jobId)).toMatchObject({ status: "failed", mediaKind: "audio", error: { code: "MEDIA_UNSUPPORTED", mediaReason: "too-short" } });
    expect((await r.service.list()).total).toBe(0);
  });
});
