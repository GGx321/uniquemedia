import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MediaOrigin, PickedFileIdentity, UnsequencedEvent } from "../../shared/engine";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { tempDirFor } from "../../testing/tempDir";
import { JobRegistry } from "../jobs";
import { pickedIdentityOf } from "./identity";
import type { MediaImporter, MediaImportCall } from "./imports";
import { MediaService } from "./service";
useNativeGlobals();

// 5b.2, S5.WA2: what the engine's lifetime rules ask of the media service about clip copies: the live copy of a clip, every copy (with no cap), whether the library's media could be read at all, and
// the copy ids of an avatar without a wait.

const rigs: MediaService[] = [];
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((service) => service.stop()));
});
const tmp = tempDirFor({ beforeEach, afterEach }, "studio-media-copies-");
const libraryRoot = (): string => join(tmp(), "library");
const pickedDir = (): string => join(tmp(), "picked");
beforeEach(async () => {
  await mkdir(libraryRoot(), { recursive: true });
  await mkdir(pickedDir(), { recursive: true });
});

const origin = (clip: number, avatar = "avatar-mia-0001"): MediaOrigin => ({ kind: "clip", avatarId: avatar, clipId: `clip-000000${clip}`, photoId: "photo-0000001" });
const FACTS = { width: 720, height: 1280, durationMs: 5_000, sourceFps: 24, hdrToSdr: false, loopFrames: null, delayFrames: null } as const;
const video: MediaImporter = async () => ({ ok: true, facts: FACTS });
const mp4 = (): Buffer => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(100)]);

let counter = 0;
function rig() {
  const jobs = new JobRegistry();
  const events: UnsequencedEvent[] = [];
  const reserved = new Set<string>();
  const service = new MediaService({
    jobs,
    emit: (event) => events.push(event),
    withLibrary: (work) => work({ root: libraryRoot() }),
    newId: () => `id-${String(++counter).padStart(8, "0")}`,
    now: () => new Date("2026-10-14T10:00:00.000Z"),
    importers: { video },
    reservedMedia: (mediaId) => reserved.has(mediaId),
    log: () => undefined,
  });
  rigs.push(service);
  return { service, events, reserved };
}

async function importVideo(r: ReturnType<typeof rig>, name: string, extra: Partial<MediaImportCall> = {}): Promise<string> {
  const path = join(pickedDir(), name);
  await writeFile(path, mp4());
  const expected: PickedFileIdentity = pickedIdentityOf(await lstat(path, { bigint: true }));
  const result = await r.service.import({ pick: "video", path, name, expected, ...extra });
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  await r.service.settled();
  const done = r.events.filter((e) => e.type === "job.done").at(-1);
  if (done?.type !== "job.done" || done.payload.result.kind !== "import") throw new Error("the import did not finish");
  return done.payload.result.mediaId;
}

describe("copies()", () => {
  test("lists the copies, newest first, and leaves an ordinary video out", async () => {
    const r = rig();
    const first = await importVideo(r, "a.mp4", { origin: origin(1) });
    await importVideo(r, "own.mp4");
    const second = await importVideo(r, "b.mp4", { origin: origin(2) });

    const listed = await r.service.copies();

    expect(listed.readable).toBe(true);
    expect(listed.copies.map((c) => c.mediaId)).toEqual([second, first]);
    expect(listed.copies.every((c) => c.origin !== undefined)).toBe(true);
  });

  test("says the media cannot be read when the library's media folder is a link", async () => {
    await symlink(tmp(), join(libraryRoot(), "media"));
    const r = rig();
    const listed = await r.service.copies();
    expect(listed).toEqual({ readable: false, copies: [] });
  });

  test("for a root, lists that library's copies without taking the library's hold (the sweep must not refuse the owner's next switch)", async () => {
    const r = rig();
    const one = await importVideo(r, "a.mp4", { origin: origin(1) });
    const holds: number[] = [];
    const counting = new MediaService({
      jobs: new JobRegistry(),
      emit: () => undefined,
      withLibrary: (work) => {
        holds.push(1);
        return work({ root: libraryRoot() });
      },
      newId: () => `id-${String(++counter).padStart(8, "0")}`,
      now: () => new Date("2026-10-14T10:00:00.000Z"),
      importers: { video },
      log: () => undefined,
    });
    rigs.push(counting);
    counting.libraryOpened({ root: libraryRoot() });

    const listed = await counting.copies(libraryRoot());

    expect(listed.copies.map((c) => c.mediaId)).toEqual([one]);
    expect(holds).toEqual([]);
  });

  test("for a root this service has not opened, says nothing: not readable, no copies", async () => {
    expect(await rig().service.copies(join(tmp(), "never-opened"))).toEqual({ readable: false, copies: [] });
  });

  test("says it is readable for a library that has no media folder yet", async () => {
    expect(await rig().service.copies()).toEqual({ readable: true, copies: [] });
  });
});

describe("origins()", () => {
  test("is every copy's origin by media id, and says whether the media could be read", async () => {
    const r = rig();
    const one = await importVideo(r, "a.mp4", { origin: origin(1) });
    await importVideo(r, "own.mp4");
    const two = await importVideo(r, "b.mp4", { origin: origin(2) });

    const read = await r.service.origins();

    expect(read.readable).toBe(true);
    expect([...read.origins.keys()].sort()).toEqual([one, two].sort());
    expect(read.origins.get(one)).toEqual(origin(1));
  });

  test("is not readable when the library's media folder is a link", async () => {
    await symlink(tmp(), join(libraryRoot(), "media"));
    expect(await rig().service.origins()).toMatchObject({ readable: false });
  });
});

describe("copyOfClip()", () => {
  test("finds the live copy of a clip and only of that clip", async () => {
    const r = rig();
    const one = await importVideo(r, "a.mp4", { origin: origin(1) });
    await importVideo(r, "b.mp4", { origin: origin(2) });
    expect((await r.service.copyOfClip("avatar-mia-0001", "clip-0000001"))?.mediaId).toBe(one);
    expect(await r.service.copyOfClip("avatar-mia-0001", "clip-0000009")).toBeUndefined();
  });

  test("does not find another avatar's clip with the same id, and copiesOfClip lists every copy of the clip", async () => {
    const r = rig();
    const one = await importVideo(r, "a.mp4", { origin: origin(1) });
    const twin = await importVideo(r, "b.mp4", { origin: origin(1) });
    await importVideo(r, "c.mp4", { origin: origin(1, "avatar-zed-0002") });
    expect(await r.service.copyOfClip("avatar-nobody-0009", "clip-0000001")).toBeUndefined();
    expect((await r.service.copiesOfClip("avatar-mia-0001", "clip-0000001")).map((c) => c.mediaId).sort()).toEqual([one, twin].sort());
  });

  test("does not find a copy that was deleted", async () => {
    const r = rig();
    const one = await importVideo(r, "a.mp4", { origin: origin(1) });
    expect(await r.service.delete(one)).toBe("deleted");
    expect(await r.service.copyOfClip("avatar-mia-0001", "clip-0000001")).toBeUndefined();
  });

  test("does not find a copy that a render holds as gone: the delete says in-use and the copy stays", async () => {
    const r = rig();
    const one = await importVideo(r, "a.mp4", { origin: origin(1) });
    r.reserved.add(one);
    expect(await r.service.delete(one)).toBe("in-use");
    expect((await r.service.copyOfClip("avatar-mia-0001", "clip-0000001"))?.mediaId).toBe(one);
  });
});

describe("copyIdsOf()", () => {
  test("answers an avatar's copy ids at once, from the records in memory", async () => {
    const r = rig();
    const mine = await importVideo(r, "a.mp4", { origin: origin(1) });
    await importVideo(r, "b.mp4", { origin: origin(2, "avatar-zed-0002") });
    expect(r.service.copyIdsOf(libraryRoot(), "avatar-mia-0001")).toEqual([mine]);
  });

  test("is empty for a library this service has not opened, and for an avatar with no copy", async () => {
    const r = rig();
    await importVideo(r, "a.mp4", { origin: origin(1) });
    expect(r.service.copyIdsOf(join(tmp(), "elsewhere"), "avatar-mia-0001")).toEqual([]);
    expect(r.service.copyIdsOf(libraryRoot(), "avatar-nobody-0009")).toEqual([]);
  });

  test("forgets a copy once it is deleted", async () => {
    const r = rig();
    const one = await importVideo(r, "a.mp4", { origin: origin(1) });
    await r.service.delete(one);
    expect(r.service.copyIdsOf(libraryRoot(), "avatar-mia-0001")).toEqual([]);
  });
});

