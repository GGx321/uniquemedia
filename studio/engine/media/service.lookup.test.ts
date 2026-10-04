import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PickedFileIdentity } from "../../shared/engine";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { tempDirFor } from "../../testing/tempDir";
import { JobRegistry } from "../jobs";
import { pickedIdentityOf } from "./identity";
import type { MediaImportCall } from "./imports";
import { MediaService } from "./service";
useNativeGlobals();

// The render's ADMISSION of an own media (3f.2, fix round 3 M1): it looks the media up and reserves it with NO await between the two, and
// `media.delete` takes a media out of lookup SYNCHRONOUSLY in its first tick and only then asks the reserved provider. Together the two
// orders are the whole race: either the reservation lands first and the delete is refused `in-use`, or the delete's first tick lands first
// and the lookup finds nothing. A render can never hold a media whose file is being removed.

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-media-lookup-");
const libraryRoot = (): string => join(tmp(), "library");
const mediaDir = (): string => join(libraryRoot(), "media");
const pickedDir = (): string => join(tmp(), "picked");

beforeEach(async () => {
  await mkdir(libraryRoot(), { recursive: true });
  await mkdir(pickedDir(), { recursive: true });
});

const jpeg = (): Buffer<ArrayBuffer> => {
  const buffer = Buffer.alloc(200, 9);
  buffer.set([0xff, 0xd8, 0xff, 0xe0]);
  return buffer;
};
const FACTS = { width: 100, height: 200, durationMs: null, sourceFps: null, hdrToSdr: false, loopFrames: null, delayFrames: null } as const;

let counter = 0;
async function callFor(name: string): Promise<MediaImportCall> {
  const path = join(pickedDir(), name);
  await writeFile(path, jpeg());
  const expected: PickedFileIdentity = pickedIdentityOf(await lstat(path, { bigint: true }));
  return { pick: "photo", path, name, expected };
}

/** A service with the real staging and records, a stand-in importer, and a reserved provider the test controls. */
async function rigWithOneMedia(): Promise<{ service: MediaService; mediaId: string; reserved: Set<string> }> {
  const reserved = new Set<string>();
  const service = new MediaService({
    jobs: new JobRegistry(),
    emit: () => undefined,
    withLibrary: (work) => work({ root: libraryRoot() }),
    newId: () => `id-${String(++counter).padStart(8, "0")}`,
    now: () => new Date("2026-10-04T10:00:00.000Z"),
    importers: { photo: async () => ({ ok: true, facts: FACTS }) },
    log: () => undefined,
    reservedMedia: (mediaId) => reserved.has(mediaId),
  });
  const result = await service.import(await callFor("a.jpg"));
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  await service.settled();
  const mediaId = (await service.list("photo")).media[0]?.mediaId;
  if (mediaId === undefined) throw new Error("nothing was stored");
  return { service, mediaId, reserved };
}

describe("MediaService.lookup with an admission callback", () => {
  test("runs the callback with the record it found, before the lookup's own answer", async () => {
    const { service, mediaId } = await rigWithOneMedia();
    const seen: string[] = [];
    const found = await service.lookup(mediaId, "photo", (record) => void seen.push(`found ${record.summary.mediaId}`));
    seen.push("answered");
    expect(found?.summary.mediaId).toBe(mediaId);
    expect(seen).toEqual([`found ${mediaId}`, "answered"]);
  });

  test("does not run it for a media that is not there", async () => {
    const { service } = await rigWithOneMedia();
    let calls = 0;
    expect(await service.lookup("media-00000404", "photo", () => void calls++)).toBeUndefined();
    expect(calls).toBe(0);
  });

  test("does not run it for a media of another kind", async () => {
    const { service, mediaId } = await rigWithOneMedia();
    let calls = 0;
    expect(await service.lookup(mediaId, "video", () => void calls++)).toBeUndefined();
    expect(calls).toBe(0);
  });

  test("a callback that throws makes the lookup throw and leaves the media stored", async () => {
    const { service, mediaId } = await rigWithOneMedia();
    await expect(
      service.lookup(mediaId, "photo", () => {
        throw new Error("no room to reserve");
      }),
    ).rejects.toThrow("no room to reserve");
    expect(await service.lookup(mediaId, "photo")).toBeDefined();
  });
});

describe("the admission and media.delete cannot both win (fix round 3 M1)", () => {
  test("a lookup that reserves first is followed by a delete that is refused in-use; the media stays", async () => {
    const { service, mediaId, reserved } = await rigWithOneMedia();
    const lookup = service.lookup(mediaId, "photo", () => void reserved.add(mediaId));
    const removal = service.delete(mediaId);
    expect(await lookup).toBeDefined();
    expect(await removal).toBe("in-use");
    expect((await readdir(mediaDir())).filter((n) => n !== ".staging")).toHaveLength(2);
  });

  test("a delete asked first takes the media out of lookup in its first tick: the lookup finds nothing and reserves nothing", async () => {
    const { service, mediaId, reserved } = await rigWithOneMedia();
    const removal = service.delete(mediaId);
    const lookup = service.lookup(mediaId, "photo", () => void reserved.add(mediaId));
    expect(await removal).toBe("deleted");
    expect(await lookup).toBeUndefined();
    expect(reserved.size).toBe(0);
    expect((await readdir(mediaDir())).filter((n) => n !== ".staging")).toEqual([]);
  });

  test("a lookup that arrives while the delete is still removing the file finds nothing", async () => {
    const { service, mediaId } = await rigWithOneMedia();
    const removal = service.delete(mediaId);
    // The delete has taken its first tick; its disk work is still going.
    await Promise.resolve();
    expect(await service.lookup(mediaId, "photo")).toBeUndefined();
    await removal;
  });

  test("whatever the order, a media is never both held by a render and deleted", async () => {
    for (const lookupFirst of [true, false]) {
      const { service, mediaId, reserved } = await rigWithOneMedia();
      const doLookup = (): ReturnType<MediaService["lookup"]> => service.lookup(mediaId, "photo", () => void reserved.add(mediaId));
      const [lookup, removal] = lookupFirst ? [doLookup(), service.delete(mediaId)] : (() => {
        const r = service.delete(mediaId);
        return [doLookup(), r] as const;
      })();
      const [held, deleted] = await Promise.all([lookup, removal]);
      expect(held !== undefined && deleted === "deleted").toBe(false);
      expect(held !== undefined || deleted === "deleted").toBe(true);
    }
  });
});

describe("MediaService.holding: which of these ids the library holds as a kind", () => {
  test("answers the ids it holds as that kind and leaves out the rest", async () => {
    const { service, mediaId } = await rigWithOneMedia();
    expect(await service.holding([mediaId, "media-00000404"], "photo")).toEqual(new Set([mediaId]));
  });

  test("leaves out an id held as another kind", async () => {
    const { service, mediaId } = await rigWithOneMedia();
    expect(await service.holding([mediaId], "video")).toEqual(new Set());
  });

  test("answers nothing for no ids, and nothing for ids of a library with no media", async () => {
    const { service } = await rigWithOneMedia();
    expect(await service.holding([], "photo")).toEqual(new Set());
    expect(await service.holding(["media-00000001"], "sticker")).toEqual(new Set());
  });

  test("does not hold a media that is being deleted, from the delete's first tick", async () => {
    const { service, mediaId } = await rigWithOneMedia();
    const removal = service.delete(mediaId);
    expect(await service.holding([mediaId], "photo")).toEqual(new Set());
    await removal;
  });
});
