import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JobState, MediaSummary, type MediaOrigin, type PickedFileIdentity, type UnsequencedEvent } from "../../shared/engine";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { tempDirFor } from "../../testing/tempDir";
import { JobRegistry } from "../jobs";
import { pickedIdentityOf } from "./identity";
import type { MediaImporter, MediaImportCall } from "./imports";
import { MediaService, type MediaServiceDeps } from "./service";
useNativeGlobals();

// 5b.2, S5.WA2: the `origin` of a clip's montage copy travels from the import call through the job ref and the record to the summary. The importer is a fake: this file pins the
// passthrough and the job's ends, not the encode (the real encode is pinned by engine.importClip.test.ts).

const rigs: MediaService[] = [];
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((service) => service.stop()));
});

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-media-origin-");
const libraryRoot = (): string => join(tmp(), "library");
const mediaDir = (): string => join(libraryRoot(), "media");
const stagingDir = (): string => join(mediaDir(), ".staging");
const pickedDir = (): string => join(tmp(), "picked");

beforeEach(async () => {
  await mkdir(libraryRoot(), { recursive: true });
  await mkdir(pickedDir(), { recursive: true });
});

const ORIGIN: MediaOrigin = { kind: "clip", avatarId: "avatar-mia-0001", clipId: "clip-0000001", photoId: "photo-0000001" };
const VIDEO_FACTS = { width: 720, height: 1280, durationMs: 5_000, sourceFps: 24, hdrToSdr: false, loopFrames: null, delayFrames: null } as const;
const PHOTO_FACTS = { width: 100, height: 200, durationMs: null, sourceFps: null, hdrToSdr: false, loopFrames: null, delayFrames: null } as const;

/** The head of an MP4: a `ftyp` box with the brand `isom`. */
const mp4Bytes = (size = 200): Buffer => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(size - 12)]);
const jpegBytes = (size = 200): Buffer => {
  const buffer = Buffer.alloc(size, 9);
  buffer.set([0xff, 0xd8, 0xff, 0xe0]);
  return buffer;
};

let counter = 0;
async function callFor(name: string, bytes: Buffer, pick: MediaImportCall["pick"], extra: Partial<MediaImportCall> = {}): Promise<MediaImportCall> {
  const path = join(pickedDir(), name);
  await writeFile(path, bytes);
  const expected: PickedFileIdentity = pickedIdentityOf(await lstat(path, { bigint: true }));
  return { pick, path, name, expected, ...extra };
}

function rig(importers: MediaServiceDeps["importers"], root: string = libraryRoot()) {
  const jobs = new JobRegistry();
  const events: UnsequencedEvent[] = [];
  const service = new MediaService({
    jobs,
    emit: (event) => events.push(event),
    withLibrary: (work) => work({ root }),
    newId: () => `id-${String(++counter).padStart(8, "0")}`,
    now: () => new Date("2026-10-14T10:00:00.000Z"),
    importers,
    log: () => undefined,
  });
  rigs.push(service);
  return { service, jobs, events };
}

const videoOk: MediaImporter = async () => ({ ok: true, facts: VIDEO_FACTS });
const photoOk: MediaImporter = async () => ({ ok: true, facts: PHOTO_FACTS });
const stagedNames = async (): Promise<string[]> => (await readdir(stagingDir()).catch(() => [])).sort();
const storedNames = async (): Promise<string[]> => (await readdir(mediaDir()).catch(() => [])).filter((n) => n !== ".staging").sort();

async function start(r: ReturnType<typeof rig>, call: MediaImportCall): Promise<string> {
  const result = await r.service.import(call);
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.jobId;
}

describe("the origin of a clip's montage copy", () => {
  test("is in the summary the job answers with, and in the media list", async () => {
    const r = rig({ video: videoOk });
    const jobId = await start(r, await callFor("copy.mp4", mp4Bytes(), "video", { origin: ORIGIN }));
    await r.service.settled();

    const state = r.jobs.stateOf(jobId);
    if (state?.kind !== "import" || state.result === undefined) throw new Error("the import did not finish");
    expect(state.result.media.origin).toEqual(ORIGIN);
    expect(MediaSummary.safeParse(state.result.media).success).toBe(true);
    const listed = await r.service.list();
    expect(listed.media.map((m) => m.origin)).toEqual([ORIGIN]);
  });

  test("is in the record on disk, so a library opened afresh lists the copy with it", async () => {
    const first = rig({ video: videoOk });
    await start(first, await callFor("copy.mp4", mp4Bytes(), "video", { origin: ORIGIN }));
    await first.service.settled();

    const second = rig({ video: videoOk });
    const listed = await second.service.list();
    expect(listed.media).toHaveLength(1);
    expect(listed.media[0]?.origin).toEqual(ORIGIN);
  });

  test("an import without an origin has none: the key is absent, not null", async () => {
    const r = rig({ video: videoOk });
    await start(r, await callFor("own.mp4", mp4Bytes(), "video"));
    await r.service.settled();
    const [media] = (await r.service.list()).media;
    expect(media).toBeDefined();
    expect(media !== undefined && "origin" in media).toBe(false);
    const record = JSON.parse(await readFile(join(mediaDir(), (await storedNames()).filter((n) => n.endsWith(".json"))[0] ?? ""), "utf8")) as Record<string, unknown>;
    expect("origin" in record).toBe(false);
  });

  test("on a photo is refused as a failed import and stores nothing", async () => {
    const r = rig({ photo: photoOk });
    const jobId = await start(r, await callFor("a.jpg", jpegBytes(), "photo", { origin: ORIGIN }));
    await r.service.settled();
    expect(r.jobs.stateOf(jobId)?.status).toBe("failed");
    expect(await storedNames()).toEqual([]);
    expect(await stagedNames()).toEqual([]);
  });
});

describe("the import job of a clip's copy carries the origin", () => {
  test("in its state while it runs, in its progress, and in its final state", async () => {
    const r = rig({ video: videoOk });
    const jobId = await start(r, await callFor("copy.mp4", mp4Bytes(), "video", { origin: ORIGIN }));
    expect(r.jobs.stateOf(jobId)).toMatchObject({ kind: "import", origin: ORIGIN });
    await r.service.settled();

    const progress = r.events.flatMap((e) => (e.type === "job.progress" && e.payload.kind === "import" ? [e.payload] : []));
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every((p) => p.origin?.clipId === ORIGIN.clipId)).toBe(true);
    const final = r.jobs.stateOf(jobId);
    expect(final).toMatchObject({ status: "done", origin: ORIGIN });
    expect(JobState.safeParse(final).success).toBe(true);
  });

  test("and so do job.failed and job.cancelled", async () => {
    const failing = rig({ video: async () => ({ ok: false, reason: "no-space" }) });
    await start(failing, await callFor("a.mp4", mp4Bytes(), "video", { origin: ORIGIN }));
    await failing.service.settled();
    const failed = failing.events.find((e) => e.type === "job.failed");
    expect(failed?.type === "job.failed" && failed.payload.kind === "import" ? failed.payload.origin : undefined).toEqual(ORIGIN);

    const cancelled = rig({ video: async () => ({ ok: false, reason: "cancelled" }) });
    await start(cancelled, await callFor("b.mp4", mp4Bytes(), "video", { origin: ORIGIN }));
    await cancelled.service.settled();
    const ended = cancelled.events.find((e) => e.type === "job.cancelled");
    expect(ended?.type === "job.cancelled" && ended.payload.kind === "import" ? ended.payload.origin : undefined).toEqual(ORIGIN);
  });

  test("an ordinary import's job has no origin", async () => {
    const r = rig({ video: videoOk });
    const jobId = await start(r, await callFor("own.mp4", mp4Bytes(), "video"));
    await r.service.settled();
    const state = r.jobs.stateOf(jobId);
    expect(state !== undefined && "origin" in state).toBe(false);
  });
});

describe("how a failed clip import is told (the contract left the pin to this task)", () => {
  async function failureOf(reason: Parameters<typeof failingImporter>[0], origin: MediaOrigin | undefined) {
    const r = rig({ video: failingImporter(reason) });
    const jobId = await start(r, await callFor(`f-${reason}.mp4`, mp4Bytes(), "video", origin === undefined ? {} : { origin }));
    await r.service.settled();
    return r.jobs.stateOf(jobId)?.error;
  }

  test("a full disk is MEDIA_UNSUPPORTED with mediaReason no-space", async () => {
    expect(await failureOf("no-space", ORIGIN)).toMatchObject({ code: "MEDIA_UNSUPPORTED", mediaReason: "no-space" });
  });

  for (const reason of ["failed", "structure", "codec", "too-short", "changed", "unreadable", "too-large", "format"] as const) {
    test(`${reason} is INTERNAL and says no media reason`, async () => {
      const error = await failureOf(reason, ORIGIN);
      expect(error?.code).toBe("INTERNAL");
      expect(error !== undefined && "mediaReason" in error).toBe(false);
    });
  }

  test("an ordinary video import keeps its media reason (the mapping is the clip import's only)", async () => {
    expect(await failureOf("codec", undefined)).toMatchObject({ code: "MEDIA_UNSUPPORTED", mediaReason: "codec" });
  });
});

function failingImporter(reason: "no-space" | "failed" | "structure" | "codec" | "too-short" | "changed" | "unreadable" | "too-large" | "format"): MediaImporter {
  return async () => ({ ok: false, reason });
}

describe("the last look before the record (the import-delete race)", () => {
  test("a copy that is no longer wanted is cancelled, its staged file is removed and no record is written", async () => {
    const r = rig({ video: videoOk });
    const jobId = await start(r, await callFor("copy.mp4", mp4Bytes(), "video", { origin: ORIGIN, stillWanted: () => false }));
    await r.service.settled();

    expect(r.jobs.stateOf(jobId)?.status).toBe("cancelled");
    expect(await storedNames()).toEqual([]);
    expect(await stagedNames()).toEqual([]);
    expect(r.events.some((e) => e.type === "media.changed")).toBe(false);
  });

  test("is asked after the importer has answered and before the record, and a yes lets the record through", async () => {
    const order: string[] = [];
    const r = rig({
      video: async () => {
        order.push("importer");
        return { ok: true, facts: VIDEO_FACTS };
      },
    });
    const jobId = await start(
      r,
      await callFor("copy.mp4", mp4Bytes(), "video", {
        origin: ORIGIN,
        stillWanted: async () => {
          order.push(`look (records: ${(await storedNames()).filter((n) => n.endsWith(".json")).length})`);
          return true;
        },
      }),
    );
    await r.service.settled();
    expect(order).toEqual(["importer", "look (records: 0)"]);
    expect(r.jobs.stateOf(jobId)?.status).toBe("done");
  });
});

describe("onEnd", () => {
  test("runs once after a job that is done, failed or cancelled has told its end, and not for a refused call", async () => {
    const seen: string[] = [];
    for (const [label, importer] of [
      ["done", videoOk],
      ["failed", failingImporter("failed")],
      ["cancelled", async () => ({ ok: false as const, reason: "cancelled" as const })],
    ] as const) {
      const r = rig({ video: importer });
      await start(r, await callFor(`${label}.mp4`, mp4Bytes(), "video", { origin: ORIGIN, onEnd: () => seen.push(`${label}: ${r.events.some((e) => e.type.startsWith("job.") && e.type !== "job.progress") ? "told" : "silent"}`) }));
      await r.service.settled();
    }
    expect(seen).toEqual(["done: told", "failed: told", "cancelled: told"]);

    const refused = rig({ video: videoOk });
    let ended = 0;
    const result = await refused.service.import(await callFor("bad.mp4", jpegBytes(), "video", { onEnd: () => void ended++ }));
    expect(result.ok).toBe(false);
    expect(ended).toBe(0);
  });
});
