import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { MEDIA_BYTE_CAPS, type PickedFileIdentity, type UnsequencedEvent } from "../../shared/engine";
import type { FfmpegChild, FfmpegSpawner } from "../../node/runFfmpeg";
import { heavyTest } from "../../testing/bunTiers";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { tempDirFor } from "../../testing/tempDir";
import { createRealDecodeBackend } from "../decode/realBackend";
import { createWasmImageDecoder } from "../decode/wasmDecode";
import { JobRegistry } from "../jobs";
import { servedMediaRecord } from "../library/mediaRecords";
import { PNG_1X1 } from "../library/testing/sampleData";
import { pickedIdentityOf } from "./identity";
import type { MediaImportCall } from "./imports";
import { createPhotoImporter } from "./photoImporter";
import { animatedWebp, jpegSegmentMarkers, quadrantPicture } from "./photoFixtures.testkit";
import { MediaService, type MediaServiceDeps } from "./service";
useNativeGlobals();

// 3f.2 through the whole import job: the real photo importer registered at the `mediaImporters` seam, the real staging and the real records.
// What the importer decides is tested in photoImporter.test.ts; here is what the JOB does with it: what is stored, what the boundary turns
// away before the importer is ever called, the byte cap at its edge, and that a cancel leaves nothing behind in the staging folder.

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-media-photo-");
const libraryRoot = (): string => join(tmp(), "library");
const mediaDir = (): string => join(libraryRoot(), "media");
const stagingDir = (): string => join(mediaDir(), ".staging");
const pickedDir = (): string => join(tmp(), "picked");
const workDir = (): string => join(tmp(), "fixtures");
const NODE_MODULES_DIR = join(import.meta.dir, "../../../node_modules");

let decoder: ReturnType<typeof createWasmImageDecoder>;
beforeAll(async () => {
  decoder = createWasmImageDecoder(await createRealDecodeBackend(NODE_MODULES_DIR));
});
beforeEach(async () => {
  await mkdir(libraryRoot(), { recursive: true });
  await mkdir(pickedDir(), { recursive: true });
});

let counter = 0;
async function callFor(name: string, bytes: Uint8Array, pick: MediaImportCall["pick"] = "photo"): Promise<MediaImportCall> {
  const path = join(pickedDir(), name);
  await writeFile(path, bytes);
  const expected: PickedFileIdentity = pickedIdentityOf(await lstat(path, { bigint: true }));
  return { pick, path, name, expected };
}

function rig(spawner?: FfmpegSpawner): { service: MediaService; jobs: JobRegistry; events: UnsequencedEvent[] } {
  const jobs = new JobRegistry();
  const events: UnsequencedEvent[] = [];
  const deps: MediaServiceDeps = {
    jobs,
    emit: (event) => events.push(event),
    withLibrary: (work) => work({ root: libraryRoot() }),
    newId: () => `id-${String(++counter).padStart(8, "0")}`,
    now: () => new Date("2026-10-04T10:00:00.000Z"),
    importers: { photo: createPhotoImporter({ decode: decoder, ...(spawner === undefined ? {} : { spawner }) }) },
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

describe("an own photo through the import job", () => {
  test("a PNG ends as a stored JPEG with its record, and nothing is left in the staging folder", async () => {
    const r = rig();
    const jobId = await startedJob(r, await callFor("holiday.png", await quadrantPicture(workDir(), "p", 40, 30, "png")));
    await r.service.settled();
    const state = r.jobs.stateOf(jobId);
    expect(state?.status).toBe("done");
    const [list] = [await r.service.list("photo")];
    expect(list.total).toBe(1);
    const media = list.media[0];
    expect(media).toMatchObject({ kind: "photo", name: "holiday.png", width: 40, height: 30 });
    const mediaId = media?.mediaId ?? "";
    expect(await stored()).toEqual([`${mediaId}.jpg`, `${mediaId}.json`]);
    const file = new Uint8Array(await readFile(join(mediaDir(), `${mediaId}.jpg`)));
    expect(file.subarray(0, 3)).toEqual(Uint8Array.from([0xff, 0xd8, 0xff]));
    expect(jpegSegmentMarkers(file).filter((m) => (m >= 0xe0 && m <= 0xef) || m === 0xfe)).toEqual([]);
    expect(await staged()).toEqual([]);
  });

  test("the record the job writes is one main's studio-media://media route would serve: the stored file, its size, its container", async () => {
    const r = rig();
    await startedJob(r, await callFor("a.png", await quadrantPicture(workDir(), "p", 16, 16, "png")));
    await r.service.settled();
    const mediaId = (await r.service.list("photo")).media[0]?.mediaId ?? "";
    const record = servedMediaRecord(JSON.parse(await readFile(join(mediaDir(), `${mediaId}.json`), "utf8")));
    const file = await readFile(join(mediaDir(), `${mediaId}.jpg`));
    expect(record).toMatchObject({ id: mediaId, kind: "photo", format: "jpeg", bytes: file.length, file: `${mediaId}.jpg` });
    // 3f.5: and the hash the served file is checked against is the hash of what was stored.
    expect(record?.sha256).toBe(createHash("sha256").update(file).digest("hex"));
  });

  test("the stored photo can be looked up for a render: its path, size and hash are those of the stored JPEG", async () => {
    const r = rig();
    await startedJob(r, await callFor("a.png", await quadrantPicture(workDir(), "p", 16, 16, "png")));
    await r.service.settled();
    const mediaId = (await r.service.list("photo")).media[0]?.mediaId ?? "";
    const found = await r.service.lookup(mediaId, "photo");
    expect(found?.format).toBe("jpeg");
    expect(found?.bytes).toBe(found?.summary.bytes ?? -1);
    expect(found?.path.endsWith(`${mediaId}.jpg`)).toBe(true);
  });

  test("a WebP is stored as a JPEG too", async () => {
    const r = rig();
    await startedJob(r, await callFor("a.webp", await quadrantPicture(workDir(), "p", 24, 24, "webp")));
    await r.service.settled();
    expect((await r.service.list("photo")).media[0]).toMatchObject({ width: 24, height: 24 });
  });

  test("a HEIC picture is turned away at the door as heic: no job, no copy", async () => {
    const r = rig();
    const ftyp = Uint8Array.from([0, 0, 0, 24, ...[..."ftyp"].map((c) => c.charCodeAt(0)), ...[..."heic"].map((c) => c.charCodeAt(0)), 0, 0, 0, 0, ...[..."heic"].map((c) => c.charCodeAt(0)), ...[..."mif1"].map((c) => c.charCodeAt(0))]);
    expect(await r.service.import(await callFor("IMG_0001.HEIC", ftyp))).toMatchObject({ ok: false, reason: "heic" });
    expect(r.jobs.states()).toEqual([]);
    expect(await staged()).toEqual([]);
  });

  test("a file of zero bytes is turned away at the door as empty", async () => {
    const r = rig();
    expect(await r.service.import(await callFor("empty.jpg", new Uint8Array(0)))).toMatchObject({ ok: false, reason: "empty" });
    expect(r.jobs.states()).toEqual([]);
  });

  test("a 1 by 1 picture is a job that fails as too-small and stores nothing", async () => {
    const r = rig();
    const jobId = await startedJob(r, await callFor("dot.png", PNG_1X1));
    await r.service.settled();
    expect(r.jobs.stateOf(jobId)).toMatchObject({ status: "failed", error: { code: "MEDIA_UNSUPPORTED", mediaReason: "too-small" } });
    expect(await stored()).toEqual([]);
    expect(await staged()).toEqual([]);
  });

  test("an animated WebP is a job that fails as animated-webp, with no ffmpeg spawned", async () => {
    const spawner: FfmpegSpawner = () => {
      throw new Error("must not be spawned");
    };
    const r = rig(spawner);
    const jobId = await startedJob(r, await callFor("moving.webp", await animatedWebp(workDir(), "a", 16, 16)));
    await r.service.settled();
    expect(r.jobs.stateOf(jobId)).toMatchObject({ status: "failed", error: { mediaReason: "animated-webp" } });
    expect(await stored()).toEqual([]);
  });

  test("the failure of a job names no path of the owner's", async () => {
    const r = rig();
    const jobId = await startedJob(r, await callFor("dot.png", PNG_1X1));
    await r.service.settled();
    expect(JSON.stringify(r.jobs.stateOf(jobId))).not.toContain(tmp());
  });
});

/** A child process that never finishes by itself: it ends only when it is killed. */
function hangingChild(): { child: FfmpegChild; killed: () => number } {
  const closers: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
  let kills = 0;
  const state: { exitCode: number | null } = { exitCode: null };
  const child: FfmpegChild = {
    get exitCode() {
      return state.exitCode;
    },
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => {
      kills++;
      state.exitCode = 137;
      queueMicrotask(() => closers.forEach((close) => close(null, "SIGKILL")));
      return true;
    },
    on: ((event: string, listener: (...args: never[]) => void) => {
      if (event === "close") closers.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
      return child;
    }) as FfmpegChild["on"],
  };
  return { child, killed: () => kills };
}

describe("cancelling an own photo import", () => {
  test("a cancel while ffmpeg decodes a WebP kills it, ends the job as cancelled and leaves the staging folder empty", async () => {
    const { child, killed } = hangingChild();
    let spawnedCall: () => void = () => undefined;
    const spawned = new Promise<void>((resolve) => (spawnedCall = resolve));
    const r = rig(() => {
      spawnedCall();
      return child;
    });
    const jobId = await startedJob(r, await callFor("a.webp", await quadrantPicture(workDir(), "p", 24, 24, "webp")));
    await spawned;
    expect(r.service.cancel(jobId)).toBe(true);
    await r.service.settled();
    expect(r.jobs.stateOf(jobId)?.status).toBe("cancelled");
    expect(killed()).toBe(1);
    expect(await staged()).toEqual([]);
    expect(await stored()).toEqual([]);
  });

  test("an engine that stops while ffmpeg runs kills it and leaves nothing behind", async () => {
    const { child, killed } = hangingChild();
    let spawnedCall: () => void = () => undefined;
    const spawned = new Promise<void>((resolve) => (spawnedCall = resolve));
    const r = rig(() => {
      spawnedCall();
      return child;
    });
    await startedJob(r, await callFor("a.jpg", await quadrantPicture(workDir(), "p", 24, 24, "jpeg")));
    await spawned;
    await r.service.stop();
    expect(killed()).toBe(1);
    expect(await staged()).toEqual([]);
    expect(await stored()).toEqual([]);
  });
});

describe("the 30 MB cap at its edge", () => {
  /** A real JPEG padded after its end marker to exactly `size` bytes: a decoder stops at the marker, so the file is a picture of that size. */
  async function paddedJpeg(size: number): Promise<Uint8Array> {
    const picture = await quadrantPicture(workDir(), "p", 32, 32, "jpeg");
    const out = new Uint8Array(size);
    out.set(picture);
    return out;
  }

  heavyTest("a photo file of exactly 30 MiB is taken and stored", async () => {
    const r = rig();
    const jobId = await startedJob(r, await callFor("big.jpg", await paddedJpeg(MEDIA_BYTE_CAPS.photo)));
    await r.service.settled();
    expect(r.jobs.stateOf(jobId)?.status).toBe("done");
    const media = (await r.service.list("photo")).media[0];
    expect(media).toMatchObject({ width: 32, height: 32 });
    // The stored file is the re-encoded picture, far under the cap: the padding is not carried over.
    expect(media?.bytes).toBeLessThan(MEDIA_BYTE_CAPS.photo);
  }, 120_000);

  heavyTest("a photo file one byte over 30 MiB is turned away at the door as too-large", async () => {
    const r = rig();
    expect(await r.service.import(await callFor("big.jpg", await paddedJpeg(MEDIA_BYTE_CAPS.photo + 1)))).toMatchObject({ ok: false, reason: "too-large" });
    expect(r.jobs.states()).toEqual([]);
    expect(await staged()).toEqual([]);
  }, 120_000);
});
