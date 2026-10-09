import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MediaSummary, UnsequencedEvent } from "../../shared/engine";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { tempDirFor } from "../../testing/tempDir";
import { JobRegistry } from "../jobs";
import { PNG_1X1 } from "../library/testing/sampleData";
import { pickedIdentityOf } from "./identity";
import type { MediaImportCall } from "./imports";
import { MediaService } from "./service";
useNativeGlobals();

// The own-track flag «для автопилота» through the media service (Stage 4, S4.5d; plan §7): `setForAutopilot` appends to `<library>/media/autopilot-tracks.jsonl`, `media.list`
// reads the flag from it, and `autopilotTracks` lists the tracks the autopilot may take: flagged AND still valid own tracks (audio, stored as m4a, with a length).

const services: MediaService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
});

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-media-autopilot-");
const libraryRoot = (): string => join(tmp(), "library");
const flagLog = (): string => join(libraryRoot(), "media", "autopilot-tracks.jsonl");
const pickedDir = (): string => join(tmp(), "picked");
beforeEach(async () => {
  await mkdir(libraryRoot(), { recursive: true });
  await mkdir(pickedDir(), { recursive: true });
});

const TRACK_FACTS = { width: null, height: null, durationMs: 12_000, sourceFps: null, hdrToSdr: false, loopFrames: null, delayFrames: null } as const;
const PHOTO_FACTS = { width: 100, height: 200, durationMs: null, sourceFps: null, hdrToSdr: false, loopFrames: null, delayFrames: null } as const;

/** The head of an iTunes audio file: a `ftyp` box with the brand «M4A », which the staging reads as an m4a. */
const m4aBytes = (): Buffer => Buffer.concat([Buffer.from([0, 0, 0, 32]), Buffer.from("ftypM4A "), Buffer.alloc(20)]);
/** The head of an mp3 (an ID3 tag): a track the importer left in its own container, which the render cannot read. */
const mp3Bytes = (): Buffer => Buffer.concat([Buffer.from("ID3"), Buffer.alloc(60, 1)]);

let counter = 0;
function rig(): { service: MediaService; events: UnsequencedEvent[] } {
  const events: UnsequencedEvent[] = [];
  const service = new MediaService({
    jobs: new JobRegistry(),
    emit: (event) => events.push(event),
    withLibrary: (work) => work({ root: libraryRoot() }),
    newId: () => `id-${String(++counter).padStart(8, "0")}`,
    now: () => new Date("2026-10-09T10:00:00.000Z"),
    importers: { audio: async () => ({ ok: true, facts: TRACK_FACTS }), photo: async () => ({ ok: true, facts: PHOTO_FACTS }) },
    log: () => undefined,
  });
  services.push(service);
  return { service, events };
}

async function importOne(service: MediaService, name: string, bytes: Buffer, pick: MediaImportCall["pick"]): Promise<string> {
  const path = join(pickedDir(), name);
  await writeFile(path, bytes);
  const result = await service.import({ pick, path, name, expected: pickedIdentityOf(await lstat(path, { bigint: true })) });
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  await service.settled();
  const listed = await service.list();
  const found = listed.media.find((media) => media.name === name);
  if (found === undefined) throw new Error(`${name} was not stored`);
  return found.mediaId;
}

const track = (service: MediaService, name = "loop.m4a"): Promise<string> => importOne(service, name, m4aBytes(), "audio");
const flagOf = async (service: MediaService, mediaId: string): Promise<MediaSummary | undefined> => (await service.list()).media.find((media) => media.mediaId === mediaId);

describe("setForAutopilot", () => {
  test("flags an own track: the answer, media.list and the event all say forAutopilot", async () => {
    const { service, events } = rig();
    const mediaId = await track(service);
    const before = events.length;
    const result = await service.setForAutopilot(mediaId, true);
    expect(result).toMatchObject({ ok: true, media: { mediaId, kind: "audio", forAutopilot: true } });
    expect((await flagOf(service, mediaId))?.forAutopilot).toBe(true);
    const changed = events.slice(before).filter((event) => event.type === "media.changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]?.payload).toMatchObject({ change: "upserted", media: { mediaId, forAutopilot: true } });
  });

  test("clears the flag: the field is absent again, not false", async () => {
    const { service } = rig();
    const mediaId = await track(service);
    await service.setForAutopilot(mediaId, true);
    const result = await service.setForAutopilot(mediaId, false);
    expect(result.ok && "forAutopilot" in result.media).toBe(false);
    const shown = await flagOf(service, mediaId);
    expect(shown !== undefined && "forAutopilot" in shown).toBe(false);
  });

  test("a track that was never flagged has no forAutopilot field", async () => {
    const { service } = rig();
    const mediaId = await track(service);
    const shown = await flagOf(service, mediaId);
    expect(shown !== undefined && "forAutopilot" in shown).toBe(false);
  });

  test("the flag is per track: flagging one leaves the other as it was", async () => {
    const { service } = rig();
    const first = await track(service, "one.m4a");
    const second = await track(service, "two.m4a");
    await service.setForAutopilot(first, true);
    expect((await flagOf(service, first))?.forAutopilot).toBe(true);
    expect((await flagOf(service, second))?.forAutopilot).toBeUndefined();
  });

  test("survives a restart: a new service over the same library reads the same flag", async () => {
    const first = rig();
    const mediaId = await track(first.service);
    await first.service.setForAutopilot(mediaId, true);
    const second = rig();
    second.service.libraryOpened({ root: libraryRoot() });
    await second.service.settled();
    expect((await flagOf(second.service, mediaId))?.forAutopilot).toBe(true);
  });

  test("on and off called at once end in the state of the last call, and a repeated call does not grow the log", async () => {
    const { service } = rig();
    const mediaId = await track(service);
    await Promise.all([service.setForAutopilot(mediaId, true), service.setForAutopilot(mediaId, false)]);
    expect((await flagOf(service, mediaId))?.forAutopilot).toBeUndefined();
    await Promise.all([service.setForAutopilot(mediaId, false), service.setForAutopilot(mediaId, true), service.setForAutopilot(mediaId, true)]);
    expect((await flagOf(service, mediaId))?.forAutopilot).toBe(true);
    expect((await readFile(flagLog(), "utf8")).split("\n").filter((l) => l !== "")).toHaveLength(3);
  });

  test("refuses a photo as NOT_FOUND-class and writes nothing", async () => {
    const { service } = rig();
    const photoId = await importOne(service, "pic.png", Buffer.from(PNG_1X1), "photo");
    expect(await service.setForAutopilot(photoId, true)).toEqual({ ok: false, reason: "not-found" });
    await expect(readFile(flagLog(), "utf8")).rejects.toThrow();
  });

  test("refuses an id the library does not hold, and writes nothing", async () => {
    const { service } = rig();
    expect(await service.setForAutopilot("media-nobody-0404", true)).toEqual({ ok: false, reason: "not-found" });
    await expect(readFile(flagLog(), "utf8")).rejects.toThrow();
  });

  test("refuses a track the render cannot read (stored as an mp3, not an m4a) as a format problem, and writes nothing", async () => {
    const { service } = rig();
    const mediaId = await importOne(service, "old.mp3", mp3Bytes(), "audio");
    expect(await service.setForAutopilot(mediaId, true)).toEqual({ ok: false, reason: "format" });
    await expect(readFile(flagLog(), "utf8")).rejects.toThrow();
  });

  test("a log with a bad line refuses the write with an error, and leaves the log as it was", async () => {
    const { service } = rig();
    const mediaId = await track(service);
    await writeFile(flagLog(), "not json\n");
    await expect(service.setForAutopilot(mediaId, true)).rejects.toThrow();
    expect(await readFile(flagLog(), "utf8")).toBe("not json\n");
  });
});

describe("what a damaged log shows", () => {
  test("a torn log: media.list shows no track as flagged, and the autopilot gets no track", async () => {
    const { service } = rig();
    const mediaId = await track(service);
    await service.setForAutopilot(mediaId, true);
    const text = await readFile(flagLog(), "utf8");
    await writeFile(flagLog(), `${text}{"mediaId":"${mediaId}","on":tr`);
    expect((await flagOf(service, mediaId))?.forAutopilot).toBeUndefined();
    expect(await service.autopilotTracks()).toEqual([]);
  });

  test("a log with a bad line: no track is flagged", async () => {
    const { service } = rig();
    const mediaId = await track(service);
    await service.setForAutopilot(mediaId, true);
    await writeFile(flagLog(), `${await readFile(flagLog(), "utf8")}garbage\n`);
    expect((await flagOf(service, mediaId))?.forAutopilot).toBeUndefined();
    expect(await service.autopilotTracks()).toEqual([]);
  });
});

describe("autopilotTracks", () => {
  test("is the flagged tracks with their decoded length, and not the unflagged ones", async () => {
    const { service } = rig();
    const flagged = await track(service, "yes.m4a");
    await track(service, "no.m4a");
    await service.setForAutopilot(flagged, true);
    expect(await service.autopilotTracks()).toEqual([{ mediaId: flagged, durationMs: 12_000 }]);
  });

  test("leaves out a flagged track that was deleted since, and it does not come back with a new library read", async () => {
    const { service } = rig();
    const mediaId = await track(service);
    await service.setForAutopilot(mediaId, true);
    expect(await service.delete(mediaId)).toBe("deleted");
    expect(await service.autopilotTracks()).toEqual([]);
  });

  test("leaves out a flagged track that is not a valid own track: a flag line naming an mp3 in the log is not honoured", async () => {
    const { service } = rig();
    const mp3 = await importOne(service, "old.mp3", mp3Bytes(), "audio");
    await mkdir(join(libraryRoot(), "media"), { recursive: true });
    await writeFile(flagLog(), `${JSON.stringify({ mediaId: mp3, on: true, at: "2026-10-09T10:00:00.000Z" })}\n`);
    expect(await service.autopilotTracks()).toEqual([]);
    expect((await flagOf(service, mp3))?.forAutopilot).toBeUndefined();
  });

  test("a flagged photo id in the log is not a track", async () => {
    const { service } = rig();
    const photoId = await importOne(service, "pic.png", Buffer.from(PNG_1X1), "photo");
    await writeFile(flagLog(), `${JSON.stringify({ mediaId: photoId, on: true, at: "2026-10-09T10:00:00.000Z" })}\n`);
    expect(await service.autopilotTracks()).toEqual([]);
    expect((await flagOf(service, photoId))?.forAutopilot).toBeUndefined();
  });
});
