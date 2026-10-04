import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MEDIA_BYTE_CAPS, type PickedFileIdentity, type UnsequencedEvent } from "../../shared/engine";
import { heavyTest } from "../../testing/bunTiers";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { tempDirFor } from "../../testing/tempDir";
import { JobRegistry } from "../jobs";
import { servedMediaRecord } from "../library/mediaRecords";
import { FIXTURE_TAGS, fixtureBytes, musicFixtures, type MusicFixtureName } from "./fixtures/music";
import { pickedIdentityOf } from "./identity";
import type { MediaImportCall } from "./imports";
import { isAlive, recordingSpawner, wavOf } from "./musicFixtures.testkit";
import { createMusicImporter, type MusicImporterDeps } from "./musicImporter";
import { MediaService, type MediaServiceDeps } from "./service";
useNativeGlobals();

// 3f.4 through the whole import job: the real music importer registered at the `mediaImporters` seam, the real staging and the real records.
// What the importer decides is in musicImporter.test.ts; here is what the JOB does with it: what is stored (an M4A, its record, its waveform), what the
// boundary turns away before the importer is called (by size and by the bytes), and that a cancel leaves nothing behind and kills ffmpeg.

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-media-music-");
const libraryRoot = (): string => join(tmp(), "library");
const mediaDir = (): string => join(libraryRoot(), "media");
const stagingDir = (): string => join(mediaDir(), ".staging");
const pickedDir = (): string => join(tmp(), "picked");

beforeEach(async () => {
  await mkdir(libraryRoot(), { recursive: true });
  await mkdir(pickedDir(), { recursive: true });
});

let counter = 0;
async function callFor(name: string, bytes: Uint8Array, pick: MediaImportCall["pick"] = "audio"): Promise<MediaImportCall> {
  const path = join(pickedDir(), name);
  await writeFile(path, bytes);
  const expected: PickedFileIdentity = pickedIdentityOf(await lstat(path, { bigint: true }));
  return { pick, path, name, expected };
}

function rig(importer: MusicImporterDeps = {}): { service: MediaService; jobs: JobRegistry; events: UnsequencedEvent[] } {
  const jobs = new JobRegistry();
  const events: UnsequencedEvent[] = [];
  const deps: MediaServiceDeps = {
    jobs,
    emit: (event) => events.push(event),
    withLibrary: (work) => work({ root: libraryRoot() }),
    newId: () => `id-${String(++counter).padStart(8, "0")}`,
    now: () => new Date("2026-10-04T10:00:00.000Z"),
    // The committed tones are under the shortest track the library keeps (3f.6); these tests are about what the JOB does with the importer's answer.
    importers: { audio: createMusicImporter({ minDurationMs: 0, ...importer }) },
    log: () => undefined,
  };
  return { service: new MediaService(deps), jobs, events };
}

const staged = async (): Promise<string[]> => (await readdir(stagingDir()).catch(() => [])).sort();
const stored = async (): Promise<string[]> => (await readdir(mediaDir()).catch(() => [])).filter((n) => n !== ".staging").sort();

async function startedJob(r: ReturnType<typeof rig>, call: MediaImportCall): Promise<string> {
  const result = await r.service.import(call);
  if (!result.ok) throw new Error(`refused at the door: ${result.reason}`);
  return result.jobId;
}

/** Imports a fixture and answers its job's state and the library's first track. */
async function importFixture(r: ReturnType<typeof rig>, name: MusicFixtureName, fileName = "song.bin"): Promise<{ jobId: string; mediaId: string }> {
  const jobId = await startedJob(r, await callFor(fileName, fixtureBytes(name)));
  await r.service.settled();
  return { jobId, mediaId: (await r.service.list("audio")).media[0]?.mediaId ?? "" };
}

describe("an own track through the import job", () => {
  test("an mp3 ends as a stored M4A with its record, and nothing is left in the staging folder", async () => {
    const r = rig();
    const { jobId, mediaId } = await importFixture(r, "mp3", "holiday.mp3");
    expect(r.jobs.stateOf(jobId)?.status).toBe("done");
    const list = await r.service.list("audio");
    expect(list.total).toBe(1);
    expect(list.media[0]).toMatchObject({ kind: "audio", name: "holiday.mp3", width: null, height: null, sourceFps: null, hdrToSdr: false });
    expect(Math.abs((list.media[0]?.durationMs ?? 0) - musicFixtures.mp3.durationMs)).toBeLessThanOrEqual(80);
    expect(await stored()).toEqual([`${mediaId}.json`, `${mediaId}.m4a`]);
    expect(await staged()).toEqual([]);
  });

  test.each<MusicFixtureName>(["mp3", "m4a", "aac", "wav", "flac", "alac", "ogg", "opus", "isomMp4", "surround", "wav24"])("%s is stored as an M4A", async (name) => {
    const r = rig();
    const { jobId, mediaId } = await importFixture(r, name);
    expect(r.jobs.stateOf(jobId)?.status).toBe("done");
    expect(await stored()).toEqual([`${mediaId}.json`, `${mediaId}.m4a`]);
  });

  test("the record is one main's studio-media://media route would serve: the stored file, its size, its container", async () => {
    const r = rig();
    const { mediaId } = await importFixture(r, "mp3");
    const record = servedMediaRecord(JSON.parse(await readFile(join(mediaDir(), `${mediaId}.json`), "utf8")));
    const file = await readFile(join(mediaDir(), `${mediaId}.m4a`));
    expect(record).toEqual({ id: mediaId, kind: "audio", format: "m4a", bytes: file.length, file: `${mediaId}.m4a`, sha256: createHash("sha256").update(file).digest("hex"), width: null, height: null, loopFrames: null });
    expect(Buffer.from(file.subarray(4, 12)).toString("latin1")).toBe("ftypM4A ");
  });

  test("the track's waveform is kept for `music.peaks`, and is no part of what a window is told", async () => {
    const r = rig();
    const { mediaId } = await importFixture(r, "mp3");
    const waveform = await r.service.waveform(mediaId);
    expect(waveform?.length).toBeGreaterThanOrEqual(11);
    expect(waveform?.length).toBeLessThanOrEqual(14);
    expect(Math.max(...(waveform ?? []))).toBeGreaterThan(50);
    expect(JSON.stringify(await r.service.list("audio"))).not.toContain("waveform");
    expect(JSON.stringify(r.events)).not.toContain("waveform");
  });

  test("a media that is not a track has no waveform", async () => {
    const r = rig();
    expect(await r.service.waveform("media-00000404")).toBeUndefined();
  });

  test("the stored track can be looked up for a render as an audio media: its path, size and hash are those of the stored M4A", async () => {
    const r = rig();
    const { mediaId } = await importFixture(r, "flac");
    const found = await r.service.lookup(mediaId, "audio");
    expect(found?.format).toBe("m4a");
    expect(found?.bytes).toBe(found?.summary.bytes ?? -1);
    expect(found?.path.endsWith(`${mediaId}.m4a`)).toBe(true);
    expect(await r.service.lookup(mediaId, "photo")).toBeUndefined();
  });

  test("the display name is the picked file's name, never a tag: the stored file carries neither the title nor the artist", async () => {
    const r = rig();
    const { mediaId } = await importFixture(r, "taggedMp3", "my mix.mp3");
    expect((await r.service.list("audio")).media[0]?.name).toBe("my mix.mp3");
    const bytes = Buffer.from(await readFile(join(mediaDir(), `${mediaId}.m4a`))).toString("latin1");
    for (const tag of Object.values(FIXTURE_TAGS)) {
      expect(bytes).not.toContain(tag);
      expect(bytes).not.toContain(Buffer.from(tag, "utf16le").toString("latin1"));
    }
    expect(JSON.stringify(await r.service.list("audio"))).not.toContain("Secret");
  });
});

describe("what the job turns away", () => {
  async function failureOf(name: MusicFixtureName, importer: MusicImporterDeps = {}): Promise<{ r: ReturnType<typeof rig>; status: string | undefined; reason: string | undefined }> {
    const r = rig(importer);
    const jobId = await startedJob(r, await callFor("x.bin", fixtureBytes(name)));
    await r.service.settled();
    const state = r.jobs.stateOf(jobId);
    return { r, status: state?.status, reason: state?.status === "failed" ? state.error?.mediaReason : undefined };
  }

  test("an M4A that holds a real video stream fails as a format and stores nothing", async () => {
    const { r, status, reason } = await failureOf("m4aWithVideo");
    expect([status, reason]).toEqual(["failed", "format"]);
    expect(await stored()).toEqual([]);
    expect(await staged()).toEqual([]);
    expect((await r.service.list("audio")).total).toBe(0);
  });

  test("a WAV in a codec Studio does not read fails as a codec", async () => {
    const { status, reason } = await failureOf("adpcmWav");
    expect([status, reason]).toEqual(["failed", "codec"]);
    expect(await stored()).toEqual([]);
  });

  test("a track longer than the limit fails as too-long and stores nothing", async () => {
    const { status, reason } = await failureOf("mp3", { maxDurationMs: 200 });
    expect([status, reason]).toEqual(["failed", "too-long"]);
    expect(await stored()).toEqual([]);
    expect(await staged()).toEqual([]);
  });

  test("a failed job is the contract's MEDIA_UNSUPPORTED with the importer's reason", async () => {
    const { r } = await failureOf("adpcmWav");
    expect(r.events.map((e) => e.type)).toContain("job.failed");
    expect(JSON.stringify(r.events.filter((e) => e.type === "job.failed"))).toContain("MEDIA_UNSUPPORTED");
  });

  test("a file named .mp3 that holds text is turned away at the door as a format: no job, no copy", async () => {
    const r = rig();
    expect(await r.service.import(await callFor("notes.mp3", Buffer.from("just some notes, not music")))).toMatchObject({ ok: false, reason: "format" });
    expect(r.jobs.states()).toEqual([]);
    expect(await staged()).toEqual([]);
  });

  test("a picture picked as music is turned away at the door as a format", async () => {
    const r = rig();
    expect(await r.service.import(await callFor("song.mp3", Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])))).toMatchObject({ ok: false, reason: "format" });
    expect(r.jobs.states()).toEqual([]);
  });

  test("a file of zero bytes is turned away at the door as empty", async () => {
    const r = rig();
    expect(await r.service.import(await callFor("empty.mp3", new Uint8Array(0)))).toMatchObject({ ok: false, reason: "empty" });
  });
});

describe("the format is the bytes', never the name's", () => {
  test("a FLAC under the name of an mp3 and a WAV is imported as the FLAC it is", async () => {
    const r = rig();
    const { jobId } = await importFixture(r, "flac", "really-a-song.mp3");
    expect(r.jobs.stateOf(jobId)?.status).toBe("done");
    const second = await startedJob(r, await callFor("other.wav", fixtureBytes("ogg")));
    await r.service.settled();
    expect(r.jobs.stateOf(second)?.status).toBe("done");
    expect((await r.service.list("audio")).total).toBe(2);
  });

  test("an mp3 under a .m4a name is the mp3 it is", async () => {
    const r = rig();
    const { jobId } = await importFixture(r, "mp3", "x.m4a");
    expect(r.jobs.stateOf(jobId)?.status).toBe("done");
  });
});

describe("the 100 MB cap, by the file's size and not by reading it", () => {
  const ID3 = Uint8Array.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]);

  test("the cap is 100 MiB", () => {
    expect(MEDIA_BYTE_CAPS.audio).toBe(100 * 1024 * 1024);
  });

  test("a file one byte over the cap is turned away at the door as too-large: no job, no copy", async () => {
    const r = rig();
    const call = await callFor("huge.mp3", ID3);
    // A sparse file: its size is the cap plus one, and not one byte of it was written.
    await truncate(call.path, MEDIA_BYTE_CAPS.audio + 1);
    const grown = { ...call, expected: pickedIdentityOf(await lstat(call.path, { bigint: true })) };
    expect(await r.service.import(grown)).toMatchObject({ ok: false, reason: "too-large" });
    expect(r.jobs.states()).toEqual([]);
    expect(await staged()).toEqual([]);
  });

  heavyTest("a file of exactly the cap passes the door (the importer then judges its bytes)", async () => {
    const r = rig();
    const call = await callFor("exact.mp3", ID3);
    await truncate(call.path, MEDIA_BYTE_CAPS.audio);
    const grown = { ...call, expected: pickedIdentityOf(await lstat(call.path, { bigint: true })) };
    const result = await r.service.import(grown);
    expect(result.ok).toBe(true);
    await r.service.settled();
    const state = r.jobs.states()[0];
    // Whatever the importer made of a 100 MiB of zeros after an ID3 head, it was not the door's size verdict.
    expect(state?.status === "failed" ? state.error?.mediaReason : "done").not.toBe("too-large");
  }, 120_000);
});

describe("a cancel", () => {
  test("during the encode kills ffmpeg, stores nothing and leaves nothing in the staging folder", async () => {
    const recorded = recordingSpawner();
    const r = rig({ spawner: recorded.spawner });
    const jobId = await startedJob(r, await callFor("long.wav", wavOf(150 * 8000), "audio"));
    // The probe is the first child, the encode the second.
    while (!recorded.argvs.some((argv) => argv.includes("-frames:a"))) await new Promise<void>((resolve) => setTimeout(resolve, 5));
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(r.service.cancel(jobId)).toBe(true);
    await r.service.settled();
    expect(r.jobs.stateOf(jobId)?.status).toBe("cancelled");
    expect(recorded.exits[6]?.signal).toBe("SIGKILL");
    for (const pid of recorded.pids) expect(isAlive(pid)).toBe(false);
    expect(await stored()).toEqual([]);
    expect(await staged()).toEqual([]);
  });
});
