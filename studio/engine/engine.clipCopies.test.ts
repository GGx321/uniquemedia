import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { EngineReply } from "./control";
import { openLibrary } from "./library";
import { sequentialIds, steppingClock } from "./library/testing/helpers";
import { useClipFixtures } from "./clips/testing/clipFixtures";
import { copiesOf, importClipCommand, plantReadyClip, type PlantedClip } from "./clips/testing/copyKit";
import { command, jobEnd, until, type ClipEngine } from "./clips/testing/engineClipKit";
import { copyOfPlanted, gatedRender, montageOf, seedFramesAvatar, startRenderEngine, type FramesAvatar, type RenderEngineOptions } from "./clips/testing/renderKit";
import { useEngineDir } from "./testing/engineHarness";
useNativeGlobals();
setDefaultTimeout(120_000);

// 5b.2, S5.WA2 (I5.59, plan §5.1.2, r2.1 N2 and N5): how long a clip's montage copy lives, through the real engine and the real importer. A clip delete removes the copy first and refuses while a render
// holds it; an avatar delete waits for an import and for a render that holds a copy, removes the copies only at the `trashed` outcome, asynchronously, and never at `kept`; the library-open sweep removes
// a copy only when its avatar's folder is really gone. After every path, `media/` holds no copy whose clip is gone.

const dir = useEngineDir("studio-engine-clip-copies-");
const libraryDir = (): string => join(dir(), "library");
const mediaFolder = (): string => join(libraryDir(), "media");
const sourceClip = useClipFixtures();
const SMALL = { width: 360, height: 640, seconds: 3, fps: 24, audio: false } as const;
const PLANT = { width: 360, height: 640, durationMs: 3_000 } as const;

const deletePrepare = (avatarId: string, token = "token-00000001") => ({ kind: "control", type: "avatar.deletePrepare", callId: "call-00000001", avatarId, token });
const deleteFinish = (avatarId: string, outcome: "trashed" | "kept", token = "token-00000001") => ({ kind: "control", type: "avatar.deleteFinish", callId: "call-00000002", avatarId, token, outcome });

async function reply(started: ClipEngine, call: unknown) {
  await started.engine.receive(call);
  return EngineReply.parse(started.posted.at(-1));
}

/** The files of `media/` that are copies' (an mp4 and its record), by name. */
const storedFiles = async (): Promise<string[]> => (await readdir(mediaFolder()).catch(() => [])).filter((n) => n !== ".staging").sort();
const clipFiles = async (avatarId: string): Promise<string[]> => (await readdir(join(libraryDir(), "avatars", avatarId, "clips")).catch(() => [])).sort();

interface World {
  started: ClipEngine;
  a: FramesAvatar;
  b: FramesAvatar;
  clipA: PlantedClip;
  clipB: PlantedClip;
}

async function world(options: RenderEngineOptions = {}): Promise<World> {
  const a = await seedFramesAvatar(libraryDir(), 3, "Mia");
  const b = await seedFramesAvatar(libraryDir(), 3, "Zed");
  const started = await startRenderEngine(dir(), options);
  const source = await sourceClip(SMALL);
  const clipA = await plantReadyClip(libraryDir(), a.avatarId, a.photoIds[0] ?? "", source, PLANT);
  const clipB = await plantReadyClip(libraryDir(), b.avatarId, b.photoIds[0] ?? "", source, PLANT);
  return { started, a, b, clipA, clipB };
}

/** Polls an async condition every 25 ms for up to `timeoutMs`: the sweep runs in the background after the library opens. */
async function eventually(check: () => Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!(await check())) throw new Error(`timed out waiting for ${what}`);
}

const removedEvents = (started: ClipEngine): string[] => started.events().flatMap((e) => (e.type === "media.changed" && e.payload.change === "removed" ? [e.payload.mediaId] : []));

describe("a clip delete and its copy", () => {
  test("removes the copy, then the clip: no copy outlives its clip", async () => {
    const w = await world();
    const mediaId = await copyOfPlanted(w.started, w.clipA);
    expect(await storedFiles()).toEqual([`${mediaId}.json`, `${mediaId}.mp4`]);

    const deleted = await w.started.engine.handle(command("clips.delete", { avatarId: w.a.avatarId, clipId: w.clipA.clipId }));

    expect(deleted.ok).toBe(true);
    expect(await copiesOf(w.started)).toEqual([]);
    expect(await storedFiles()).toEqual([]);
    expect(await clipFiles(w.a.avatarId)).toEqual([]);
    expect(removedEvents(w.started)).toEqual([mediaId]);
  });

  test("a clip with no copy is deleted as before", async () => {
    const w = await world();
    const deleted = await w.started.engine.handle(command("clips.delete", { avatarId: w.a.avatarId, clipId: w.clipA.clipId }));
    expect(deleted.ok).toBe(true);
    expect(await clipFiles(w.a.avatarId)).toEqual([]);
  });

  test("a copy a render holds: IN_FLIGHT in-use, and the copy, the clip, its file and its poster all stay; once the render ends the delete goes through", async () => {
    const gate = gatedRender();
    const w = await world({ run: gate.run });
    const mediaId = await copyOfPlanted(w.started, w.clipA);
    const render = await w.started.engine.handle(command("videos.render", { spec: montageOf(w.a.avatarId, [{ scene: w.a.photoIds[1] ?? "" }, { copy: mediaId }]) }));
    if (!render.ok || render.type !== "videos.render") throw new Error(`the render was refused: ${JSON.stringify(render)}`);
    await until(() => gate.started() > 0, "the render's ffmpeg");
    const before = await clipFiles(w.a.avatarId);

    const refused = await w.started.engine.handle(command("clips.delete", { avatarId: w.a.avatarId, clipId: w.clipA.clipId }));

    expect(!refused.ok && refused.error).toMatchObject({ code: "IN_FLIGHT", clipReason: "in-use" });
    expect((await copiesOf(w.started)).map((c) => c.mediaId)).toEqual([mediaId]);
    expect(await clipFiles(w.a.avatarId)).toEqual(before);
    expect(before.length).toBeGreaterThanOrEqual(3);

    gate.open();
    expect((await jobEnd(w.started, render.result.jobId)).type).toBe("job.done");
    expect((await w.started.engine.handle(command("clips.delete", { avatarId: w.a.avatarId, clipId: w.clipA.clipId }))).ok).toBe(true);
    expect(await copiesOf(w.started)).toEqual([]);
  });
});

describe("an avatar delete waits (r2.1 N2)", () => {
  test("while a render holds a copy of one of its clips", async () => {
    const held = new Set<string>();
    const w = await world({ deps: { reservedMedia: (mediaId) => held.has(mediaId) } });
    const mediaId = await copyOfPlanted(w.started, w.clipA);
    held.add(mediaId);

    const refused = await reply(w.started, deletePrepare(w.a.avatarId));

    expect(refused.error?.code).toBe("IN_FLIGHT");
    expect(refused.error?.detail).toContain("copy");
    // Another avatar's delete is not held by it.
    held.delete(mediaId);
    expect((await reply(w.started, deletePrepare(w.a.avatarId))).error).toBeUndefined();
    await reply(w.started, deleteFinish(w.a.avatarId, "kept"));
  });

  test("while a clip import of the avatar runs, and goes through once it has ended", async () => {
    let open: () => void = () => undefined;
    const door = new Promise<void>((resolve) => (open = resolve));
    let enter: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => (enter = resolve));
    const w = await world({
      wrapImporter: (real) => async (request) => {
        enter();
        await door;
        return real(request);
      },
    });
    const answer = await w.started.engine.handle(importClipCommand(w.a.avatarId, w.clipA.clipId));
    if (!answer.ok || answer.type !== "media.importClip" || !("jobId" in answer.result)) throw new Error("expected an import job");
    await entered;

    const refused = await reply(w.started, deletePrepare(w.a.avatarId));
    expect(refused.error?.code).toBe("IN_FLIGHT");
    expect(refused.error?.detail).toContain("clip");

    open();
    await jobEnd(w.started, answer.result.jobId);
    await w.started.engine.mediaSettled();
    expect((await reply(w.started, deletePrepare(w.a.avatarId))).error).toBeUndefined();
    await reply(w.started, deleteFinish(w.a.avatarId, "kept"));
  });

  test("a clip import for an avatar whose delete is prepared is NOT_FOUND, and makes no copy", async () => {
    const w = await world();
    expect((await reply(w.started, deletePrepare(w.a.avatarId))).error).toBeUndefined();

    const answer = await w.started.engine.handle(importClipCommand(w.a.avatarId, w.clipA.clipId));

    expect(!answer.ok && answer.error.code).toBe("NOT_FOUND");
    expect(await storedFiles()).toEqual([]);
    await reply(w.started, deleteFinish(w.a.avatarId, "kept"));
  });
});

describe("the avatar's copies go only when the avatar does", () => {
  test("at the trashed outcome every copy of that avatar is removed, after the avatar is announced removed, and no other avatar's", async () => {
    const w = await world();
    const mediaA = await copyOfPlanted(w.started, w.clipA);
    const mediaB = await copyOfPlanted(w.started, w.clipB);
    expect((await reply(w.started, deletePrepare(w.a.avatarId))).error).toBeUndefined();
    // Prepared is not trashed: nothing is removed yet.
    expect((await copiesOf(w.started)).map((c) => c.mediaId).sort()).toEqual([mediaA, mediaB].sort());

    await reply(w.started, deleteFinish(w.a.avatarId, "trashed"));
    await until(() => removedEvents(w.started).includes(mediaA), "the copy's removal");

    expect((await copiesOf(w.started)).map((c) => c.mediaId)).toEqual([mediaB]);
    expect(await storedFiles()).toEqual([`${mediaB}.json`, `${mediaB}.mp4`]);
    const types = w.started.events().map((e) => (e.type === "media.changed" ? `media.changed:${e.payload.change}` : e.type));
    expect(types.indexOf("avatar.removed")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("avatar.removed")).toBeLessThan(types.indexOf("media.changed:removed"));
  });

  test("at the kept outcome every copy stays", async () => {
    const w = await world();
    const mediaA = await copyOfPlanted(w.started, w.clipA);
    expect((await reply(w.started, deletePrepare(w.a.avatarId))).error).toBeUndefined();
    await reply(w.started, deleteFinish(w.a.avatarId, "kept"));
    await w.started.engine.mediaSettled();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect((await copiesOf(w.started)).map((c) => c.mediaId)).toEqual([mediaA]);
    expect(removedEvents(w.started)).toEqual([]);
  });

  test("a copy that a render holds at that moment is left, and the other copies of the avatar still go", async () => {
    const held = new Set<string>();
    const w = await world({ deps: { reservedMedia: (mediaId) => held.has(mediaId) } });
    const second = await plantReadyClip(libraryDir(), w.a.avatarId, w.a.photoIds[1] ?? "", await sourceClip(SMALL), PLANT);
    const first = await copyOfPlanted(w.started, w.clipA);
    const other = await copyOfPlanted(w.started, second);
    expect((await reply(w.started, deletePrepare(w.a.avatarId))).error).toBeUndefined();
    held.add(first);

    await reply(w.started, deleteFinish(w.a.avatarId, "trashed"));
    await until(() => removedEvents(w.started).includes(other), "the other copy's removal");

    expect((await copiesOf(w.started)).map((c) => c.mediaId)).toEqual([first]);
  });
});

describe("a library switch and the background cleanup of a deleted avatar's copies", () => {
  /** A copy removal stalled in its disk call until `open()`. */
  function stalledUnlink() {
    let open: () => void = () => undefined;
    const door = new Promise<void>((resolve) => (open = resolve));
    let enter: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => (enter = resolve));
    return {
      open,
      entered,
      fs: {
        unlink: async (path: string): Promise<void> => {
          enter();
          await door;
          await rm(path, { force: true });
        },
      },
    };
  }

  test("library.open right after trashed is not refused while the cleanup is stalled, and the old library's copy goes once it is let go", async () => {
    const stall = stalledUnlink();
    const w = await world({ deps: { mediaRecords: { fs: stall.fs } } });
    const mediaA = await copyOfPlanted(w.started, w.clipA);
    const other = join(dir(), "other");
    await mkdir(other, { recursive: true });
    await openLibrary(other, { now: steppingClock(), newId: sequentialIds("other") });
    expect((await reply(w.started, deletePrepare(w.a.avatarId))).error).toBeUndefined();

    await reply(w.started, deleteFinish(w.a.avatarId, "trashed"));
    await stall.entered;
    const switched = await reply(w.started, { kind: "control", type: "library.open", callId: "call-00000009", path: other });

    expect(switched.error).toBeUndefined();
    stall.open();
    await eventually(async () => !(await storedFiles()).some((name) => name.startsWith(mediaA)), "the old library's copy to go");
  });

  test("a clip delete whose copy removal is stalled is in the library the clip is in: a switch landing meanwhile leaves no copy behind in the old library (S5.WA5, L1)", async () => {
    const stall = stalledUnlink();
    const w = await world({ deps: { mediaRecords: { fs: stall.fs } } });
    const mediaA = await copyOfPlanted(w.started, w.clipA);
    const other = join(dir(), "other");
    await mkdir(other, { recursive: true });
    await openLibrary(other, { now: steppingClock(), newId: sequentialIds("other") });

    const deleting = w.started.engine.handle(command("clips.delete", { avatarId: w.a.avatarId, clipId: w.clipA.clipId }));
    await stall.entered;
    const switched = await reply(w.started, { kind: "control", type: "library.open", callId: "call-00000009", path: other });
    stall.open();
    const deleted = await deleting;

    expect(switched.error).toBeUndefined();
    expect(deleted.ok).toBe(true);
    expect(await storedFiles()).toEqual([]);
    expect(await clipFiles(w.a.avatarId)).toEqual([]);
    expect(removedEvents(w.started)).toEqual([mediaA]);
  });
});

describe("avatars.pruneMissing (an avatar whose folder went to the Trash and the engine knew no delete for)", () => {
  test("removes the avatar's copies, asynchronously and after the avatar is announced removed, and keeps every other avatar's", async () => {
    const w = await world();
    const mediaA = await copyOfPlanted(w.started, w.clipA);
    const mediaB = await copyOfPlanted(w.started, w.clipB);
    await rm(join(libraryDir(), "avatars", w.b.avatarId), { recursive: true, force: true });

    await w.started.engine.receive({ kind: "control", type: "avatars.pruneMissing", callId: "call-00000007" });
    await until(() => removedEvents(w.started).includes(mediaB), "the copy's removal");

    expect((await copiesOf(w.started)).map((c) => c.mediaId)).toEqual([mediaA]);
    expect(await storedFiles()).toEqual([`${mediaA}.json`, `${mediaA}.mp4`]);
    const types = w.started.events().map((e) => (e.type === "media.changed" ? `media.changed:${e.payload.change}` : e.type));
    expect(types.indexOf("avatar.removed")).toBeLessThan(types.indexOf("media.changed:removed"));
  });

  test("leaves the copies of an avatar it did not forget", async () => {
    const w = await world();
    const mediaA = await copyOfPlanted(w.started, w.clipA);
    await w.started.engine.receive({ kind: "control", type: "avatars.pruneMissing", callId: "call-00000007" });
    await w.started.engine.mediaSettled();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await copiesOf(w.started)).map((c) => c.mediaId)).toEqual([mediaA]);
  });
});

describe("the library-open sweep", () => {
  test("removes the copies of an avatar whose folder is gone from the disk, and keeps every other avatar's", async () => {
    const first = await world();
    const mediaA = await copyOfPlanted(first.started, first.clipA);
    const mediaB = await copyOfPlanted(first.started, first.clipB);
    await first.started.engine.shutdown();
    // The avatar's folder went to the Trash while the engine was down (the delete's finish was lost).
    await rm(join(libraryDir(), "avatars", first.b.avatarId), { recursive: true, force: true });

    const second = await startRenderEngine(dir());
    await eventually(async () => !(await storedFiles()).some((name) => name.startsWith(mediaB)), "the sweep");

    expect((await copiesOf(second)).map((c) => c.mediaId)).toEqual([mediaA]);
    expect(await storedFiles()).toEqual([`${mediaA}.json`, `${mediaA}.mp4`]);
  });

  test("keeps the copies of every avatar whose folder is on the disk", async () => {
    const first = await world();
    const mediaA = await copyOfPlanted(first.started, first.clipA);
    const mediaB = await copyOfPlanted(first.started, first.clipB);
    await first.started.engine.shutdown();

    const second = await startRenderEngine(dir());
    await second.engine.mediaSettled();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect((await copiesOf(second)).map((c) => c.mediaId).sort()).toEqual([mediaA, mediaB].sort());
  });
});
