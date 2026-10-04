import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MediaSummary } from "../../shared/engine";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { tempDirFor } from "../../testing/tempDir";
import { MediaCommitError, MediaRecords, type MediaCommitInput } from "./mediaRecords";
useNativeGlobals();

// 3f.4: a track's waveform is kept in its record (one value per 50 ms, 0 to 1000) for `music.peaks`. It is the engine's own data, but a record is a file on
// disk: the commit judges what it writes, and the read judges what it finds, and neither lets the waveform into the summary a window sees.

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-media-waveform-");
const root = (): string => join(tmp(), "library");
const mediaDir = (): string => join(root(), "media");
const stagingDir = (): string => join(mediaDir(), ".staging");

beforeEach(async () => {
  await mkdir(stagingDir(), { recursive: true });
});

let ids = 0;
let clock = Date.parse("2026-10-04T10:00:00.000Z");
const TRACK_FACTS = { width: null, height: null, durationMs: 4_000, sourceFps: null, hdrToSdr: false, loopFrames: null, delayFrames: null } as const;
const PHOTO_FACTS = { width: 100, height: 100, durationMs: null, sourceFps: null, hdrToSdr: false, loopFrames: null, delayFrames: null } as const;

const records = (): MediaRecords => new MediaRecords({ root: root(), newId: () => `media-${String(++ids).padStart(8, "0")}`, now: () => new Date((clock += 1000)), warn: () => undefined });

async function staged(bytes = "m4a bytes"): Promise<string> {
  const path = join(stagingDir(), `staged-${String(++ids).padStart(8, "0")}.media`);
  await writeFile(path, bytes);
  return path;
}

const WAVE = Array.from({ length: 80 }, (_, i) => (i * 37) % 1001);

async function track(extra: Partial<MediaCommitInput> = {}): Promise<MediaCommitInput> {
  return { sourcePath: await staged(), kind: "audio", format: "m4a", name: "song.mp3", facts: TRACK_FACTS, waveform: WAVE, ...extra };
}

const recordPath = (id: string): string => join(mediaDir(), `${id}.json`);

describe("a track's waveform in its record", () => {
  test("is read back as it was written", async () => {
    const store = records();
    const { mediaId } = await store.commit(await track());
    expect(await store.waveformOf(mediaId)).toEqual(WAVE);
  });

  test("is in the record on disk", async () => {
    const { mediaId } = await records().commit(await track());
    const record: unknown = JSON.parse(await readFile(recordPath(mediaId), "utf8"));
    expect(record).toMatchObject({ kind: "audio", waveform: WAVE });
  });

  test("is never in the summary a window sees, nor in a listing", async () => {
    const store = records();
    const summary = await store.commit(await track());
    expect(summary).not.toHaveProperty("waveform");
    expect(MediaSummary.safeParse(summary).success).toBe(true);
    expect(JSON.stringify(store.list().media)).not.toContain("waveform");
    expect(JSON.stringify(store.get(summary.mediaId))).not.toContain("waveform");
  });

  test("survives a restart: a new instance of the records reads it from the disk", async () => {
    const first = records();
    const { mediaId } = await first.commit(await track());
    const second = records();
    await second.recover();
    expect(await second.waveformOf(mediaId)).toEqual(WAVE);
    expect(JSON.stringify(second.list().media)).not.toContain("waveform");
  });

  test("a record with none answers nothing", async () => {
    const store = records();
    const { mediaId } = await store.commit(await track({ waveform: undefined }));
    expect(await store.waveformOf(mediaId)).toBeUndefined();
  });

  test("an id the library does not hold answers nothing", async () => {
    expect(await records().waveformOf("media-00000404")).toBeUndefined();
  });

  test("a media that is not a track answers nothing", async () => {
    const store = records();
    const { mediaId } = await store.commit({ sourcePath: await staged("p"), kind: "photo", format: "jpeg", name: "a.jpg", facts: PHOTO_FACTS });
    expect(await store.waveformOf(mediaId)).toBeUndefined();
  });

  test("is gone with the media", async () => {
    const store = records();
    const { mediaId } = await store.commit(await track());
    await store.remove(mediaId);
    expect(await store.waveformOf(mediaId)).toBeUndefined();
  });
});

describe("the commit judges the waveform it is given", () => {
  const refused = async (waveform: readonly number[] | undefined, over: Partial<MediaCommitInput> = {}): Promise<MediaCommitError> => {
    const store = records();
    const input = await track({ waveform, ...over });
    try {
      await store.commit(input);
    } catch (error) {
      if (error instanceof MediaCommitError) {
        // Refused before anything moved: the staged copy is still where it was, and media/ holds nothing.
        expect(await readdir(mediaDir()).then((names) => names.filter((n) => n !== ".staging"))).toEqual([]);
        expect(await readFile(input.sourcePath, "utf8")).toBe("m4a bytes");
        return error;
      }
      throw error;
    }
    throw new Error("expected the commit to be refused");
  };

  test.each<[string, number[]]>([
    ["a fraction", [1, 2.5, 3]],
    ["a negative value", [1, -1, 3]],
    ["a value over 1000", [1, 1001, 3]],
    ["NaN", [1, Number.NaN, 3]],
    ["Infinity", [1, Number.POSITIVE_INFINITY]],
  ])("%s is invalid", async (_label, waveform) => {
    expect((await refused(waveform)).code).toBe("invalid");
  });

  test("more values than ten minutes hold (12000 at 50 ms, with a margin) is invalid", async () => {
    expect((await refused(new Array<number>(20_001).fill(5))).code).toBe("invalid");
  });

  test("exactly the most there is, is taken", async () => {
    const store = records();
    const { mediaId } = await store.commit(await track({ waveform: new Array<number>(20_000).fill(1000) }));
    expect((await store.waveformOf(mediaId))?.length).toBe(20_000);
  });

  test("an empty waveform is invalid: a track that decoded has at least one step", async () => {
    expect((await refused([])).code).toBe("invalid");
  });

  test("a photo with a waveform is invalid", async () => {
    expect((await refused(WAVE, { kind: "photo", format: "jpeg", facts: PHOTO_FACTS })).code).toBe("invalid");
  });
});

describe("the read judges what it finds", () => {
  async function tampered(change: (record: Record<string, unknown>) => Record<string, unknown>): Promise<{ store: MediaRecords; mediaId: string }> {
    const store = records();
    const { mediaId } = await store.commit(await track());
    const record = JSON.parse(await readFile(recordPath(mediaId), "utf8")) as Record<string, unknown>;
    await writeFile(recordPath(mediaId), JSON.stringify(change(record)));
    return { store, mediaId };
  }

  test("a waveform of strings is no waveform, and the media is still listed", async () => {
    const { store, mediaId } = await tampered((record) => ({ ...record, waveform: ["a", "b"] }));
    expect(await store.waveformOf(mediaId)).toBeUndefined();
    expect(store.has(mediaId)).toBe(true);
  });

  test("a waveform with a value out of range is no waveform", async () => {
    const { store, mediaId } = await tampered((record) => ({ ...record, waveform: [1, 2, 5000] }));
    expect(await store.waveformOf(mediaId)).toBeUndefined();
  });

  test("a waveform that is not a list is no waveform", async () => {
    const { store, mediaId } = await tampered((record) => ({ ...record, waveform: { 0: 1 } }));
    expect(await store.waveformOf(mediaId)).toBeUndefined();
  });

  test("a record that names another media is not this media's waveform", async () => {
    const store = records();
    const a = await store.commit(await track({ waveform: [10, 20, 30] }));
    const b = await store.commit(await track({ waveform: [900, 800, 700] }));
    // The record of b is put in the place of a's: what a reads is b's record, which is not a's.
    await writeFile(recordPath(a.mediaId), await readFile(recordPath(b.mediaId)));
    expect(await store.waveformOf(a.mediaId)).toBeUndefined();
  });

  test("a record file that is gone answers nothing, and does not throw", async () => {
    const store = records();
    const { mediaId } = await store.commit(await track());
    await rename(recordPath(mediaId), join(tmp(), "moved.json"));
    expect(await store.waveformOf(mediaId)).toBeUndefined();
  });

  test("a record that is larger than any record is read as nothing, not parsed", async () => {
    const { store, mediaId } = await tampered((record) => ({ ...record, padding: "x".repeat(2 * 1024 * 1024) }));
    expect(await store.waveformOf(mediaId)).toBeUndefined();
  });

  test.skipIf(process.platform === "win32")("a record that is a symlink is not followed", async () => {
    const store = records();
    const { mediaId } = await store.commit(await track());
    const real = join(tmp(), "elsewhere.json");
    await writeFile(real, await readFile(recordPath(mediaId)));
    await rename(recordPath(mediaId), join(tmp(), "original.json"));
    await symlink(real, recordPath(mediaId));
    expect(await store.waveformOf(mediaId)).toBeUndefined();
  });
});
