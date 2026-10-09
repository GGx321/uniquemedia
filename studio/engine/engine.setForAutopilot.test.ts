import { describe, expect, test } from "bun:test";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PickedFileIdentity } from "../shared/engine";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { EngineReply } from "./control";
import { pickedIdentityOf } from "./media/identity";
import { command, failed, jobEnd, ok, startEngine, useEngineDir } from "./testing/engineHarness";
useNativeGlobals();

// `media.setForAutopilot` in the engine (Stage 4, S4.5d; plan §7): the owner's «для автопилота» flag on an own track. Free, a line in `<library>/media/autopilot-tracks.jsonl`.
// The answer is the track as it now stands; `media.list` reads the flag back; a media that is not an own track is refused the way `music.peaks` refuses it.

const dir = useEngineDir("studio-engine-for-autopilot-");
const pickedDir = (): string => join(dir(), "picked");
const flagLog = (): string => join(dir(), "library", "media", "autopilot-tracks.jsonl");

const TRACK_FACTS = { width: null, height: null, durationMs: 12_000, sourceFps: null, hdrToSdr: false, loopFrames: null, delayFrames: null } as const;
const PHOTO_FACTS = { width: 10, height: 10, durationMs: null, sourceFps: null, hdrToSdr: false, loopFrames: null, delayFrames: null } as const;
const m4aBytes = (): Uint8Array => Uint8Array.from([0, 0, 0, 32, ...Buffer.from("ftypM4A "), ...new Array<number>(20).fill(0)]);
const mp3Bytes = (): Uint8Array => Uint8Array.from([...Buffer.from("ID3"), ...new Array<number>(60).fill(1)]);
const jpegBytes = (): Uint8Array => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);

type Started = Awaited<ReturnType<typeof startEngine>>;

async function start(): Promise<Started> {
  const started = await startEngine(dir(), {
    deps: { mediaImporters: { audio: async () => ({ ok: true, facts: TRACK_FACTS }), photo: async () => ({ ok: true, facts: PHOTO_FACTS }) } },
  });
  await started.engine.settled();
  return started;
}

let calls = 0;
/** Imports one file through the engine and answers the id it was stored under. */
async function importFile(started: Started, name: string, bytes: Uint8Array, pick: "audio" | "photo"): Promise<string> {
  await mkdir(pickedDir(), { recursive: true });
  const path = join(pickedDir(), `${++calls}-${name}`);
  await writeFile(path, bytes);
  const expected: PickedFileIdentity = pickedIdentityOf(await lstat(path, { bigint: true }));
  const callId = `call-${String(++calls).padStart(8, "0")}`;
  await started.engine.receive({ kind: "control", type: "media.import", callId, pick, path, name, expected });
  const reply = started.posted.map((m) => EngineReply.safeParse(m)).find((r) => r.success && r.data.callId === callId);
  if (reply === undefined || !reply.success || reply.data.mediaJobId === undefined) throw new Error("the import was not started");
  await started.engine.mediaSettled();
  expect((await jobEnd(started.events, reply.data.mediaJobId)).type).toBe("job.done");
  const listed = ok(await started.engine.handle(command("media.list", { kind: pick }))).result as { media: { mediaId: string; name: string }[] };
  const found = listed.media.find((media) => media.name === name);
  if (found === undefined) throw new Error("nothing was stored");
  return found.mediaId;
}

const setFlag = (started: Started, mediaId: string, on: boolean) => started.engine.handle(command("media.setForAutopilot", { mediaId, on }));
const listed = async (started: Started, kind: "audio" | "photo" = "audio"): Promise<{ mediaId: string; forAutopilot?: boolean }[]> =>
  (ok(await started.engine.handle(command("media.list", { kind }))).result as { media: { mediaId: string; forAutopilot?: boolean }[] }).media;

describe("media.setForAutopilot", () => {
  test("flags an own track: the answer carries the track with forAutopilot, and media.list reads it back", async () => {
    const started = await start();
    const mediaId = await importFile(started, "loop.m4a", m4aBytes(), "audio");
    const answer = ok(await setFlag(started, mediaId, true));
    expect(answer.result).toMatchObject({ media: { mediaId, kind: "audio", forAutopilot: true } });
    expect((await listed(started)).find((media) => media.mediaId === mediaId)?.forAutopilot).toBe(true);
  });

  test("clears the flag: media.list no longer carries the field", async () => {
    const started = await start();
    const mediaId = await importFile(started, "loop.m4a", m4aBytes(), "audio");
    ok(await setFlag(started, mediaId, true));
    ok(await setFlag(started, mediaId, false));
    const shown = (await listed(started)).find((media) => media.mediaId === mediaId);
    expect(shown !== undefined && "forAutopilot" in shown).toBe(false);
  });

  test("tells every window with a media.changed event that carries the flag", async () => {
    const started = await start();
    const mediaId = await importFile(started, "loop.m4a", m4aBytes(), "audio");
    const before = started.events().length;
    ok(await setFlag(started, mediaId, true));
    const changed = started
      .events()
      .slice(before)
      .filter((event) => event.type === "media.changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]?.payload).toMatchObject({ change: "upserted", media: { mediaId, forAutopilot: true } });
  });

  test("an id the library does not hold is NOT_FOUND with the own-music detail, as music.peaks says it", async () => {
    const started = await start();
    expect(failed(await setFlag(started, "media-nobody-0404", true)).error).toEqual({ code: "NOT_FOUND", detail: "own music is not available yet" });
  });

  test("a photo is NOT_FOUND, and no flag log is made", async () => {
    const started = await start();
    const photo = await importFile(started, "p.jpg", jpegBytes(), "photo");
    expect(failed(await setFlag(started, photo, true)).error.code).toBe("NOT_FOUND");
    await expect(readFile(flagLog(), "utf8")).rejects.toThrow();
  });

  test("a track stored as an mp3 is MEDIA_UNSUPPORTED (format): the render cannot read it as a track", async () => {
    const started = await start();
    const mediaId = await importFile(started, "old.mp3", mp3Bytes(), "audio");
    expect(failed(await setFlag(started, mediaId, true)).error).toMatchObject({ code: "MEDIA_UNSUPPORTED", mediaReason: "format" });
    await expect(readFile(flagLog(), "utf8")).rejects.toThrow();
  });

  test("a flag log with a line that cannot be read is INTERNAL, names no path, and the log is left as it was", async () => {
    const started = await start();
    const mediaId = await importFile(started, "loop.m4a", m4aBytes(), "audio");
    await writeFile(flagLog(), "not json\n");
    const error = failed(await setFlag(started, mediaId, true)).error;
    expect(error.code).toBe("INTERNAL");
    expect(error.detail).not.toContain(dir());
    expect(await readFile(flagLog(), "utf8")).toBe("not json\n");
  });

  test("an id that is not an id is VALIDATION, before any lookup", async () => {
    const started = await start();
    expect(failed(await setFlag(started, "../media", true)).error.code).toBe("VALIDATION");
  });

  test("the flag survives an engine restart over the same directories", async () => {
    const first = await start();
    const mediaId = await importFile(first, "loop.m4a", m4aBytes(), "audio");
    ok(await setFlag(first, mediaId, true));
    await first.engine.shutdown();
    const second = await start();
    expect((await listed(second)).find((media) => media.mediaId === mediaId)?.forAutopilot).toBe(true);
  });
});
