import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { EngineReply } from "./control";
import { EventMessage, RelativePath, type AvatarSummary } from "../shared/engine";
import { manifestTraits } from "./avatars/records";
import { checkExportRoot, NODE_EXPORT_ROOT_FS } from "./exportRoot";
import { JobRegistry } from "./jobs";
import { openLibrary } from "./library";
import { PNG_1X1, SAMPLE_SOURCE, samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import { NODE_COMMIT_FS } from "./videos/commitFs";
import { commitIntent, writeIntent } from "./videos/intents";
import { parseRecordSpec, type VideoRecord } from "./videos/record";
import { fakeVideoBytes, sha256Of, specOf } from "./videos/testing/kit";
import { command, engineSettings, failed, generate, GOOD, NOW, ok, startEngine, TRAITS, until, useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// «Удалить аватар», the engine's side: `avatars.deletePreview` (what the confirmation counts) and the two control calls main makes around the move
// to the system Trash: `avatar.deletePrepare` (refuse while anything of the avatar runs, take it out of the indexes, hand back the paths) and
// `avatar.deleteFinish` (the folder went: forget the avatar and announce it; the folder stayed: put the avatar back as it was).

const dir = useEngineDir("studio-avatar-delete-");
const libraryDir = () => join(dir(), "library");
const exportDir = () => join(dir(), "export");

type Started = Awaited<ReturnType<typeof startEngine>>;

let callSeq = 0;
const TOKEN = "token-00000001";
const prepareCall = (avatarId: string, token = TOKEN) => ({ kind: "control", type: "avatar.deletePrepare", callId: `call-${String(++callSeq).padStart(8, "0")}`, avatarId, token });
const finishCall = (avatarId: string, outcome: "trashed" | "kept", token = TOKEN) => ({ kind: "control", type: "avatar.deleteFinish", callId: `call-${String(++callSeq).padStart(8, "0")}`, avatarId, token, outcome });

async function ask(started: Started, call: unknown): Promise<EngineReply> {
  await started.engine.receive(call);
  return EngineReply.parse(started.posted.at(-1));
}

interface Seeded {
  readonly avatarId: string;
  readonly draftId: string;
  readonly photoIds: readonly string[];
  readonly videoFiles: readonly string[];
}

/** An active avatar «Mia» (a master, two scene photos, two montage draft files, two videos with their files), a draft with two candidates, and the export folder marked. */
async function seed(): Promise<Seeded> {
  await mkdir(exportDir(), { recursive: true });
  const check = await checkExportRoot({ fs: NODE_EXPORT_ROOT_FS, exportPath: exportDir(), libraryPath: libraryDir(), mayCreate: false, newId: randomUUID, now: () => new Date(NOW), caseInsensitive: false });
  if (!check.ok) throw new Error(`the test export folder is unusable: ${check.reason}`);
  const { library } = await openLibrary(libraryDir(), { now: steppingClock(), newId: sequentialIds("del") });
  const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
  const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  const photoIds: string[] = [];
  for (const category of ["home", "travel"]) {
    photoIds.push((await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ source: { ...SAMPLE_SOURCE, category, attemptId: `run-00000001:slot-${category}#1` } }))).id);
  }
  await mkdir(library.montagesDir(avatar.id), { recursive: true });
  await writeFile(join(library.montagesDir(avatar.id), "montage-00000001.json"), "{}");
  await writeFile(join(library.montagesDir(avatar.id), "montage-00000002.json"), "{}");
  const videoFiles: string[] = [];
  await mkdir(join(exportDir(), "Mia"), { recursive: true });
  for (let i = 1; i <= 2; i++) {
    const videoId = `video-0000000${i}`;
    const bytes = fakeVideoBytes(2048, i);
    const name = `2026-09-29_photo_00${i}.mp4`;
    await writeFile(join(exportDir(), "Mia", name), bytes);
    videoFiles.push(join(exportDir(), "Mia", name));
    const record: VideoRecord = {
      schemaVersion: 1,
      id: videoId,
      avatarId: avatar.id,
      jobId: `job-0000000${i}`,
      createdAt: `2026-09-29T10:0${i}:00.000Z`,
      kind: "photo",
      durationMs: 1000,
      frames: 30,
      montageId: null,
      music: null,
      file: { rootId: check.rootId, relPath: RelativePath.parse(`Mia/${name}`), bytes: bytes.length, sha256: sha256Of(bytes) },
      spec: parseRecordSpec(specOf(avatar.id, [photoIds[i - 1] ?? ""])),
    };
    await writeIntent(NODE_COMMIT_FS, libraryDir(), record);
    await commitIntent(NODE_COMMIT_FS, libraryDir(), avatar.id, videoId);
  }
  const draft = await library.createAvatar({ name: "Draft", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
  await library.addPhoto(draft.id, PNG_1X1, samplePhotoMeta());
  await library.addPhoto(draft.id, PNG_1X1, samplePhotoMeta());
  return { avatarId: avatar.id, draftId: draft.id, photoIds, videoFiles };
}

async function start(over: Parameters<typeof startEngine>[1] = {}): Promise<Started> {
  const started = await startEngine(dir(), { ...over, init: { renderTmpDir: join(dir(), "userData", "render-tmp"), settings: engineSettings(dir(), { renderConcurrency: 1 }), ...over.init } });
  await started.engine.settled();
  return started;
}

async function avatarsOf(started: Started): Promise<{ avatars: AvatarSummary[]; draftIds: string[] }> {
  const snapshot = ok(await started.engine.handle(command("engine.snapshot")));
  if (snapshot.type !== "engine.snapshot") throw new Error(`expected a snapshot, got ${snapshot.type}`);
  return { avatars: snapshot.result.avatars, draftIds: snapshot.result.drafts.map((d) => d.avatarId) };
}

async function preview(started: Started, avatarId: string) {
  return await started.engine.handle(command("avatars.deletePreview", { avatarId }));
}

const removedEvents = (started: Started): string[] =>
  started.posted.flatMap((m) => {
    const event = EventMessage.safeParse(m);
    return event.success && event.data.type === "avatar.removed" ? [event.data.payload.avatarId] : [];
  });

describe("avatars.deletePreview", () => {
  test("counts the photos, the drafts, the videos and the video files that would go", async () => {
    const seeded = await seed();
    const started = await start();

    const answer = ok(await preview(started, seeded.avatarId));

    expect(answer.type === "avatars.deletePreview" ? answer.result : null).toEqual({ avatarId: seeded.avatarId, photos: 2, candidates: 0, drafts: 2, videos: 2, videoFilesFound: 2, videoFilesUnchecked: 0 });
  });

  test("a video whose file the owner already removed is a record but not a file found", async () => {
    const seeded = await seed();
    await rm(seeded.videoFiles[0] ?? "");
    const started = await start();

    const answer = ok(await preview(started, seeded.avatarId));

    expect(answer.type === "avatars.deletePreview" ? answer.result : null).toMatchObject({ videos: 2, videoFilesFound: 1 });
  });

  test("an export folder that is not there finds no file, and the preview still answers", async () => {
    const seeded = await seed();
    const started = await start();
    await rm(exportDir(), { recursive: true, force: true });

    const answer = ok(await preview(started, seeded.avatarId));

    expect(answer.type === "avatars.deletePreview" ? answer.result : null).toMatchObject({ videos: 2, videoFilesFound: 0 });
  });

  test("a draft counts its candidates", async () => {
    const seeded = await seed();
    const started = await start();

    const answer = ok(await preview(started, seeded.draftId));

    expect(answer.type === "avatars.deletePreview" ? answer.result : null).toEqual({ avatarId: seeded.draftId, photos: 0, candidates: 2, drafts: 0, videos: 0, videoFilesFound: 0, videoFilesUnchecked: 0 });
  });

  test("an avatar the library does not have is NOT_FOUND", async () => {
    await seed();
    const started = await start();

    expect(failed(await preview(started, "avatar-nobody-1")).error.code).toBe("NOT_FOUND");
  });

  test("changes nothing: the avatar is still listed afterwards", async () => {
    const seeded = await seed();
    const started = await start();

    await preview(started, seeded.avatarId);

    expect((await avatarsOf(started)).avatars.map((a) => a.avatarId)).toEqual([seeded.avatarId]);
    expect(removedEvents(started)).toEqual([]);
  });
});

describe("avatar.deletePrepare", () => {
  test("hands main the avatar's folder inside the library and each of its video files inside the export folder", async () => {
    const seeded = await seed();
    const started = await start();

    const reply = await ask(started, prepareCall(seeded.avatarId));

    expect(reply.error).toBeUndefined();
    const plan = reply.deletePlan;
    expect(plan?.avatarId).toBe(seeded.avatarId);
    expect(plan?.folder).toBe(join(libraryDir(), "avatars", seeded.avatarId));
    expect(plan?.libraryRoot).toBe(libraryDir());
    expect(plan?.exportRoot).toBe(exportDir());
    expect([...(plan?.files ?? [])].sort()).toEqual([...seeded.videoFiles].sort());
    for (const file of plan?.files ?? []) expect(file.startsWith(`${exportDir()}${sep}`)).toBe(true);
    expect(plan?.unlisted).toBe(0);
  });

  test("touches nothing on disk: the folder and the video files are still there", async () => {
    const seeded = await seed();
    const started = await start();

    await ask(started, prepareCall(seeded.avatarId));

    expect(existsSync(join(libraryDir(), "avatars", seeded.avatarId, "avatar.json"))).toBe(true);
    for (const file of seeded.videoFiles) expect(existsSync(file)).toBe(true);
  });

  test("takes the avatar out of every list at once", async () => {
    const seeded = await seed();
    const started = await start();

    await ask(started, prepareCall(seeded.avatarId));

    expect((await avatarsOf(started)).avatars).toEqual([]);
    expect(failed(await started.engine.handle(command("photos.list", { avatarId: seeded.avatarId }))).error.code).toBe("NOT_FOUND");
    expect(failed(await started.engine.handle(command("videos.list", { avatarId: seeded.avatarId }))).error.code).toBe("NOT_FOUND");
    expect(failed(await started.engine.handle(command("montages.create", { avatarId: seeded.avatarId, photoIds: [] }))).error.code).toBe("NOT_FOUND");
  });

  test("a draft is deleted too: its folder is the plan, and it has no video files", async () => {
    const seeded = await seed();
    const started = await start();

    const reply = await ask(started, prepareCall(seeded.draftId));

    expect(reply.deletePlan).toMatchObject({ avatarId: seeded.draftId, folder: join(libraryDir(), "avatars", seeded.draftId), files: [] });
    expect((await avatarsOf(started)).draftIds).toEqual([]);
  });

  test("an archived avatar is deleted too", async () => {
    const seeded = await seed();
    const started = await start();
    ok(await started.engine.handle(command("avatars.archive", { avatarId: seeded.avatarId })));

    const reply = await ask(started, prepareCall(seeded.avatarId));

    expect(reply.deletePlan?.avatarId).toBe(seeded.avatarId);
  });

  test("an avatar the library does not have is NOT_FOUND", async () => {
    await seed();
    const started = await start();

    expect((await ask(started, prepareCall("avatar-nobody-1"))).error?.code).toBe("NOT_FOUND");
  });

  test("an export folder that cannot be used leaves the video files out and still deletes the avatar", async () => {
    const seeded = await seed();
    const started = await start();
    await rm(exportDir(), { recursive: true, force: true });

    const reply = await ask(started, prepareCall(seeded.avatarId));

    expect(reply.error).toBeUndefined();
    expect(reply.deletePlan).toMatchObject({ exportRoot: null, files: [] });
  });

  test("one delete at a time: a second avatar is refused while the first is pending", async () => {
    const seeded = await seed();
    const started = await start();
    await ask(started, prepareCall(seeded.avatarId));

    expect((await ask(started, prepareCall(seeded.draftId))).error?.code).toBe("IN_FLIGHT");
    expect((await avatarsOf(started)).draftIds).toEqual([seeded.draftId]);
  });

  test("the same avatar twice is refused too, and the first plan stays pending", async () => {
    const seeded = await seed();
    const started = await start();
    await ask(started, prepareCall(seeded.avatarId));

    expect((await ask(started, prepareCall(seeded.avatarId))).error?.code).toBe("IN_FLIGHT");
    expect((await ask(started, finishCall(seeded.avatarId, "trashed"))).error).toBeUndefined();
  });

  test("a library switch is refused while it is pending", async () => {
    const seeded = await seed();
    const started = await start();
    await ask(started, prepareCall(seeded.avatarId));
    await mkdir(join(dir(), "other-library"));

    const reply = await ask(started, { kind: "control", type: "library.open", callId: "call-0000a001", path: join(dir(), "other-library") });

    expect(reply.error?.code).toBe("IN_FLIGHT");
  });
});

describe("two prepares at once", () => {
  test("exactly one gets the plan, the other is IN_FLIGHT, and the loser's avatar is untouched", async () => {
    const seeded = await seed();
    const started = await start();
    const a = prepareCall(seeded.avatarId);
    const b = prepareCall(seeded.draftId);

    await Promise.all([started.engine.receive(a), started.engine.receive(b)]);

    const replies = [a, b].map((call) => EngineReply.parse(started.posted.find((m) => typeof m === "object" && m !== null && "callId" in m && m.callId === call.callId)));
    expect(replies.filter((r) => r.error?.code === "IN_FLIGHT")).toHaveLength(1);
    expect(replies.filter((r) => r.deletePlan !== undefined)).toHaveLength(1);
    const winner = replies.find((r) => r.deletePlan !== undefined)?.deletePlan?.avatarId ?? "";
    const loser = winner === seeded.avatarId ? seeded.draftId : seeded.avatarId;
    // the winner finishes as kept and BOTH are listed as they were; a new delete of either goes through
    expect((await ask(started, finishCall(winner, "kept"))).error).toBeUndefined();
    const listed = await avatarsOf(started);
    expect([...listed.avatars.map((x) => x.avatarId), ...listed.draftIds].sort()).toEqual([seeded.avatarId, seeded.draftId].sort());
    expect((await ask(started, prepareCall(loser))).deletePlan?.avatarId).toBe(loser);
  });

  test("the same avatar twice at once: one plan, one IN_FLIGHT", async () => {
    const seeded = await seed();
    const started = await start();
    const a = prepareCall(seeded.avatarId);
    const b = prepareCall(seeded.avatarId);

    await Promise.all([started.engine.receive(a), started.engine.receive(b)]);

    const replies = [a, b].map((call) => EngineReply.parse(started.posted.find((m) => typeof m === "object" && m !== null && "callId" in m && m.callId === call.callId)));
    expect(replies.filter((r) => r.error?.code === "IN_FLIGHT")).toHaveLength(1);
    expect(replies.filter((r) => r.deletePlan !== undefined)).toHaveLength(1);
  });
});

describe("a delete that ends as kept shows the avatar to the windows again", () => {
  test("an avatar is announced again with avatar.changed", async () => {
    const seeded = await seed();
    const started = await start();
    await ask(started, prepareCall(seeded.avatarId));
    const mark = started.posted.length;

    await ask(started, finishCall(seeded.avatarId, "kept"));

    const events = started.posted.slice(mark).flatMap((m) => {
      const e = EventMessage.safeParse(m);
      return e.success ? [e.data] : [];
    });
    expect(events.map((e) => e.type)).toContain("avatar.changed");
  });

  test("a draft is announced again with draft.changed", async () => {
    const seeded = await seed();
    const started = await start();
    await ask(started, prepareCall(seeded.draftId));
    const mark = started.posted.length;

    await ask(started, finishCall(seeded.draftId, "kept"));

    const types = started.posted.slice(mark).flatMap((m) => {
      const e = EventMessage.safeParse(m);
      return e.success ? [e.data.type] : [];
    });
    expect(types).toContain("draft.changed");
  });

  test("a used index that was stale is read again on its own", async () => {
    const seeded = await seed();
    const started = await start({ deps: { videos: { staleRetryDelaysMs: [1] } } });
    started.engine.library?.flagVideoIndexStale(seeded.avatarId, "video-0000000f");
    await ask(started, prepareCall(seeded.avatarId));
    await ask(started, finishCall(seeded.avatarId, "kept"));

    await until(() => started.engine.library?.videoIndexStale(seeded.avatarId).length === 0, "the stale index to be read again");
  });
});

describe("a paid command for an avatar whose folder is no longer on the disk", () => {
  // The control and the guard use the very same stand: with the folder there the command reaches its paid call (the stub saw it); with the folder gone it is
  // refused NOT_FOUND and the stub saw nothing. Removing the guard from the engine turns the second test red.
  test("avatars.generateCandidates: with the folder there it pays", async () => {
    const seeded = await seed();
    const started = await start();

    ok(await started.engine.handle(generate(seeded.draftId)));

    await until(() => started.net.paidCalls().length > 0, "a paid request");
  });

  test("avatars.generateCandidates: with the folder gone it is NOT_FOUND before it reserves or sends anything", async () => {
    const seeded = await seed();
    const started = await start();
    // Only the manifest is removed, so without the guard the batch would carry on to its paid image requests (the control above).
    await rm(join(libraryDir(), "avatars", seeded.draftId, "avatar.json"));

    const refused = failed(await started.engine.handle(generate(seeded.draftId)));

    expect(refused.error.code).toBe("NOT_FOUND");
    expect(refused.error.detail).toContain("no longer on the disk");
    expect(started.net.paidCalls()).toEqual([]);
    expect(existsSync(join(dir(), "userData", "ledger.jsonl"))).toBe(false);
  });
});

describe("avatars.pruneMissing", () => {
  test("drops the avatars whose folder is gone from the disk, announces each, and keeps the rest", async () => {    const seeded = await seed();
    const started = await start();
    await rm(join(libraryDir(), "avatars", seeded.avatarId), { recursive: true });

    const reply = await ask(started, { kind: "control", type: "avatars.pruneMissing", callId: "call-0000b001" });

    expect(reply.error).toBeUndefined();
    expect(removedEvents(started)).toEqual([seeded.avatarId]);
    const listed = await avatarsOf(started);
    expect(listed.avatars).toEqual([]);
    expect(listed.draftIds).toEqual([seeded.draftId]);
  });

  test("changes nothing when every avatar is still on the disk", async () => {
    await seed();
    const started = await start();

    await ask(started, { kind: "control", type: "avatars.pruneMissing", callId: "call-0000b002" });

    expect(removedEvents(started)).toEqual([]);
    expect((await avatarsOf(started)).avatars).toHaveLength(1);
  });

  test("leaves an avatar a delete is under way for alone", async () => {
    const seeded = await seed();
    const started = await start();
    await ask(started, prepareCall(seeded.avatarId));

    await ask(started, { kind: "control", type: "avatars.pruneMissing", callId: "call-0000b003" });

    expect(removedEvents(started)).toEqual([]);
    expect((await ask(started, finishCall(seeded.avatarId, "kept"))).error).toBeUndefined();
  });

  test("an avatar with a live job is NOT pruned even when its folder is gone: a job holds it", async () => {
    const seeded = await seed();
    const jobs = new JobRegistry();
    const started = await start({ deps: { jobs } });
    jobs.startCandidates("job-00000001", seeded.avatarId, 4);
    await rm(join(libraryDir(), "avatars", seeded.avatarId), { recursive: true });

    await ask(started, { kind: "control", type: "avatars.pruneMissing", callId: "call-0000b004" });

    expect(removedEvents(started)).toEqual([]);
    expect((await avatarsOf(started)).avatars.map((a) => a.avatarId)).toEqual([seeded.avatarId]);
  });

  test("an avatar that becomes busy while its manifest is being looked at is NOT pruned: the look is checked again after the wait", async () => {
    const seeded = await seed();
    const jobs = new JobRegistry();
    const started = await start({ deps: { jobs } });
    const library = started.engine.library;
    if (library === null) throw new Error("expected a library");
    await rm(join(libraryDir(), "avatars", seeded.avatarId), { recursive: true });
    // The look at the disk is slow: a job for the avatar starts while it waits.
    Reflect.set(library, "manifestOnDisk", async () => {
      jobs.startCandidates("job-00000002", seeded.avatarId, 4);
      return false;
    });

    await ask(started, { kind: "control", type: "avatars.pruneMissing", callId: "call-0000b005" });

    expect(removedEvents(started)).toEqual([]);
    expect((await avatarsOf(started)).avatars.map((a) => a.avatarId)).toEqual([seeded.avatarId]);
  });

  test("an avatar with a render queued is NOT pruned either", async () => {
    const seeded = await seed();
    const jobs = new JobRegistry();
    const started = await start({ deps: { jobs } });
    jobs.queueRender("job-00000003", { videoId: "video-0000000f", avatarId: seeded.avatarId, montageId: null }, 90);
    await rm(join(libraryDir(), "avatars", seeded.avatarId), { recursive: true });

    await ask(started, { kind: "control", type: "avatars.pruneMissing", callId: "call-0000b006" });

    expect(removedEvents(started)).toEqual([]);
  });

  test("a library whose folder or library.json is not there is pruned of NOTHING: an unmounted disk must not make the engine forget every avatar", async () => {
    const seeded = await seed();
    const started = await start();
    await rm(libraryDir(), { recursive: true });

    await ask(started, { kind: "control", type: "avatars.pruneMissing", callId: "call-0000b007" });

    expect(removedEvents(started)).toEqual([]);
    expect(started.engine.library?.listAvatars().map((a) => a.id).sort()).toEqual([seeded.avatarId, seeded.draftId].sort());
  });

  test("the same when only library.json is gone", async () => {
    const seeded = await seed();
    const started = await start();
    await rm(join(libraryDir(), "library.json"));
    await rm(join(libraryDir(), "avatars", seeded.avatarId), { recursive: true });

    await ask(started, { kind: "control", type: "avatars.pruneMissing", callId: "call-0000b008" });

    expect(removedEvents(started)).toEqual([]);
  });
});

describe("avatar.deletePrepare is refused while anything of the avatar is running or reserved", () => {
  async function expectUntouched(started: Started, seeded: Seeded, then: () => Promise<void> | void): Promise<void> {
    const reply = await ask(started, prepareCall(seeded.avatarId));
    expect(reply.error?.code).toBe("IN_FLIGHT");
    expect(reply.deletePlan).toBeUndefined();
    expect(failed(await preview(started, seeded.avatarId)).error.code).toBe("IN_FLIGHT");
    expect((await avatarsOf(started)).avatars.map((a) => a.avatarId)).toEqual([seeded.avatarId]);
    await then();
    // and once it is over the delete goes through
    expect((await ask(started, prepareCall(seeded.avatarId))).error).toBeUndefined();
  }

  test("a candidates job of the avatar", async () => {
    const seeded = await seed();
    const jobs = new JobRegistry();
    const started = await start({ deps: { jobs } });
    jobs.startCandidates("job-00000001", seeded.avatarId, 4);

    await expectUntouched(started, seeded, () => void jobs.finish("job-00000001", { status: "cancelled" }));
  });

  test("a photo run of the avatar", async () => {
    const seeded = await seed();
    const jobs = new JobRegistry();
    const started = await start({ deps: { jobs } });
    jobs.startRun("job-00000001", { runId: "run-00000001", avatarId: seeded.avatarId, total: 6, done: 0 });

    await expectUntouched(started, seeded, () => void jobs.finishRun("job-00000001", { status: "cancelled" }));
  });

  test("a render of the avatar, queued", async () => {
    const seeded = await seed();
    const jobs = new JobRegistry();
    const started = await start({ deps: { jobs } });
    jobs.queueRender("job-00000001", { videoId: "video-0000000f", avatarId: seeded.avatarId, montageId: null }, 90);

    await expectUntouched(started, seeded, () => void jobs.finishRender("job-00000001", { status: "cancelled" }));
  });

  test("a video intent that is pending", async () => {
    const seeded = await seed();
    const started = await start();
    started.engine.library?.holdPendingPhotos(seeded.avatarId, "video-0000000e", [seeded.photoIds[0] ?? ""]);

    await expectUntouched(started, seeded, () => started.engine.library?.releasePendingPhotos("video-0000000e"));
  });

  test("a focus request of the avatar", async () => {
    const seeded = await seed();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = await start({ deps: { montages: { focus: () => ({ focusFor: async () => (await gate, { focus: { x: 0.5, y: 0.4 }, resolved: false }) }) } } });
    const focusing = started.engine.handle(command("montages.focus", { avatarId: seeded.avatarId, photo: { source: "scene", photoId: seeded.photoIds[0] } }));

    await expectUntouched(started, seeded, async () => {
      release();
      await focusing;
    });
  });

  test("a draft being saved", async () => {
    const seeded = await seed();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = await start({ deps: { montages: { beforeRename: () => gate } } });
    const creating = started.engine.handle(command("montages.create", { avatarId: seeded.avatarId, photoIds: [] }));

    await expectUntouched(started, seeded, async () => {
      release();
      await creating;
    });
  });

  test("a job of ANOTHER avatar does not stop the delete", async () => {
    const seeded = await seed();
    const jobs = new JobRegistry();
    const started = await start({ deps: { jobs } });
    jobs.startCandidates("job-00000001", seeded.draftId, 4);

    expect((await ask(started, prepareCall(seeded.avatarId))).error).toBeUndefined();
  });
});

describe("avatar.deleteFinish: trashed", () => {
  test("announces avatar.removed once and forgets the avatar for good", async () => {
    const seeded = await seed();
    const started = await start();
    await ask(started, prepareCall(seeded.avatarId));

    const reply = await ask(started, finishCall(seeded.avatarId, "trashed"));

    expect(reply.error).toBeUndefined();
    expect(removedEvents(started)).toEqual([seeded.avatarId]);
    expect((await avatarsOf(started)).avatars).toEqual([]);
  });

  test("lets go of the claim: another avatar can be deleted next", async () => {
    const seeded = await seed();
    const started = await start();
    await ask(started, prepareCall(seeded.avatarId));
    await ask(started, finishCall(seeded.avatarId, "trashed"));

    expect((await ask(started, prepareCall(seeded.draftId))).error).toBeUndefined();
  });

  test("a library switch is allowed again", async () => {
    const seeded = await seed();
    const started = await start();
    await ask(started, prepareCall(seeded.avatarId));
    await ask(started, finishCall(seeded.avatarId, "trashed"));
    await mkdir(join(dir(), "other-library"));

    expect((await ask(started, { kind: "control", type: "library.open", callId: "call-0000a002", path: join(dir(), "other-library") })).error).toBeUndefined();
  });

  test("a draft's removal is announced too, and the draft leaves the snapshot", async () => {
    const seeded = await seed();
    const started = await start();
    await ask(started, prepareCall(seeded.draftId));

    await ask(started, finishCall(seeded.draftId, "trashed"));

    expect(removedEvents(started)).toEqual([seeded.draftId]);
    expect((await avatarsOf(started)).draftIds).toEqual([]);
  });

  test("the finished jobs of the avatar are no longer in the snapshot", async () => {
    const seeded = await seed();
    const jobs = new JobRegistry();
    const started = await start({ deps: { jobs } });
    jobs.startCandidates("job-00000001", seeded.avatarId, 4);
    jobs.finish("job-00000001", { status: "cancelled" });
    await ask(started, prepareCall(seeded.avatarId));

    await ask(started, finishCall(seeded.avatarId, "trashed"));

    const snapshot = ok(await started.engine.handle(command("engine.snapshot")));
    expect(snapshot.type === "engine.snapshot" ? snapshot.result.jobs : null).toEqual([]);
  });

  test("a restarted engine over the folder the Trash took lists no such avatar", async () => {
    const seeded = await seed();
    const started = await start();
    await ask(started, prepareCall(seeded.avatarId));
    await ask(started, finishCall(seeded.avatarId, "trashed"));
    await rm(join(libraryDir(), "avatars", seeded.avatarId), { recursive: true }); // what main's trash did

    const again = await start({ bootId: "boot-0000-bbbb" });

    expect((await avatarsOf(again)).avatars).toEqual([]);
  });
});

describe("avatar.deleteFinish: kept", () => {
  test("puts the avatar back as it was, with its photos, videos and counts, and announces nothing", async () => {
    const seeded = await seed();
    const started = await start();
    const before = await avatarsOf(started);
    await ask(started, prepareCall(seeded.avatarId));

    const reply = await ask(started, finishCall(seeded.avatarId, "kept"));

    expect(reply.error).toBeUndefined();
    expect(await avatarsOf(started)).toEqual(before);
    expect(removedEvents(started)).toEqual([]);
    const photos = ok(await started.engine.handle(command("photos.list", { avatarId: seeded.avatarId })));
    expect(photos.type === "photos.list" ? photos.result.photos.length : -1).toBe(2);
    const videos = ok(await started.engine.handle(command("videos.list", { avatarId: seeded.avatarId })));
    expect(videos.type === "videos.list" ? videos.result.videos.length : -1).toBe(2);
  });

  test("a draft is put back in the draft list", async () => {
    const seeded = await seed();
    const started = await start();
    await ask(started, prepareCall(seeded.draftId));

    await ask(started, finishCall(seeded.draftId, "kept"));

    expect((await avatarsOf(started)).draftIds).toEqual([seeded.draftId]);
  });

  test("lets go of the claim: the avatar can be archived again", async () => {
    const seeded = await seed();
    const started = await start();
    await ask(started, prepareCall(seeded.avatarId));
    await ask(started, finishCall(seeded.avatarId, "kept"));

    expect(ok(await started.engine.handle(command("avatars.archive", { avatarId: seeded.avatarId }))).type).toBe("avatars.archive");
  });

  test("the avatar can be deleted again afterwards", async () => {
    const seeded = await seed();
    const started = await start();
    await ask(started, prepareCall(seeded.avatarId));
    await ask(started, finishCall(seeded.avatarId, "kept"));

    expect((await ask(started, prepareCall(seeded.avatarId))).deletePlan?.avatarId).toBe(seeded.avatarId);
  });
});

/** The reply the engine posted to one call, by its call id (the replies of calls made at once do not come in the order they were sent). */
function replyOf(started: Started, call: { callId: string }): EngineReply {
  return EngineReply.parse(started.posted.find((m) => typeof m === "object" && m !== null && "callId" in m && m.callId === call.callId));
}

describe("a finish is tied to ITS prepare by the delete token", () => {
  test("a finish with another token is NOT_FOUND and releases nothing: the delete under way stays, and finishes with its own token", async () => {
    const seeded = await seed();
    const started = await start();
    await ask(started, prepareCall(seeded.avatarId, "token-aaaaaaaa"));

    const stray = await ask(started, finishCall(seeded.avatarId, "kept", "token-bbbbbbbb"));

    expect(stray.error?.code).toBe("NOT_FOUND");
    expect((await ask(started, prepareCall(seeded.draftId, "token-cccccccc"))).error?.code).toBe("IN_FLIGHT");
    expect((await avatarsOf(started)).avatars).toEqual([]); // still taken out: the delete is still pending
    expect((await ask(started, finishCall(seeded.avatarId, "kept", "token-aaaaaaaa"))).error).toBeUndefined();
    expect((await avatarsOf(started)).avatars.map((a) => a.avatarId)).toEqual([seeded.avatarId]);
  });

  test("a stray `trashed` with another token forgets nothing", async () => {
    const seeded = await seed();
    const started = await start();
    await ask(started, prepareCall(seeded.avatarId, "token-aaaaaaaa"));

    expect((await ask(started, finishCall(seeded.avatarId, "trashed", "token-bbbbbbbb"))).error?.code).toBe("NOT_FOUND");

    expect(removedEvents(started)).toEqual([]);
  });
});

describe("a `kept` that arrives while its prepare is still waiting", () => {
  /** A folderFs whose stat of the library, once armed, waits at a gate: the prepare is then inside `#liveLibrary()`. */
  function libraryGate() {
    let armed = false;
    let reached: () => void = () => undefined;
    const atGate = new Promise<void>((resolve) => (reached = resolve));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const folderFs = {
      stat: async (path: string) => {
        if (armed && path === libraryDir()) {
          armed = false;
          reached();
          await gate;
        }
        return stat(path, { bigint: true });
      },
      realpath: (path: string) => realpath(path),
    };
    return { folderFs, arm: () => (armed = true), atGate, release };
  }

  /** A case probe that waits at a gate: the prepare is then past the detach, reading the avatar's files. */
  function probeGate() {
    let armed = false;
    let reached: () => void = () => undefined;
    const atGate = new Promise<void>((resolve) => (reached = resolve));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const caseProbe = {
      isCaseInsensitive: async () => {
        if (armed) {
          armed = false;
          reached();
          await gate;
        }
        return false;
      },
    };
    return { caseProbe, arm: () => (armed = true), atGate, release };
  }

  test("before the avatar is taken out: the late prepare answers an error, the slot and the claim are free, and the avatar is still listed", async () => {
    const seeded = await seed();
    const g = libraryGate();
    const started = await start({ deps: { folderFs: g.folderFs } });
    g.arm();
    const late = prepareCall(seeded.avatarId, "token-aaaaaaaa");
    const preparing = started.engine.receive(late);
    await g.atGate;

    const kept = await ask(started, finishCall(seeded.avatarId, "kept", "token-aaaaaaaa"));
    const mark = started.posted.length;
    g.release();
    await preparing;

    expect(kept.error).toBeUndefined();
    // the avatar was never taken out, so it is not announced as coming back
    const announced = started.posted.slice(mark).flatMap((m) => {
      const e = EventMessage.safeParse(m);
      return e.success ? [e.data.type] : [];
    });
    expect(announced).not.toContain("avatar.changed");
    expect(replyOf(started, late).error).toBeDefined();
    expect(replyOf(started, late).deletePlan).toBeUndefined();
    expect((await avatarsOf(started)).avatars.map((a) => a.avatarId)).toEqual([seeded.avatarId]);
    // slot and claim are free: a new delete of the same avatar, and an archive of it, go through
    expect((await ask(started, prepareCall(seeded.avatarId, "token-bbbbbbbb"))).deletePlan?.avatarId).toBe(seeded.avatarId);
    expect((await ask(started, finishCall(seeded.avatarId, "kept", "token-bbbbbbbb"))).error).toBeUndefined();
    expect(ok(await started.engine.handle(command("avatars.archive", { avatarId: seeded.avatarId }))).type).toBe("avatars.archive");
  });

  test("after the avatar was taken out: it is put back and announced again, and everything is released", async () => {
    const seeded = await seed();
    const g = probeGate();
    const started = await start({ deps: { caseProbe: g.caseProbe } });
    g.arm();
    const late = prepareCall(seeded.avatarId, "token-aaaaaaaa");
    const preparing = started.engine.receive(late);
    await g.atGate;
    expect((await avatarsOf(started)).avatars).toEqual([]); // taken out while it reads the files

    const kept = await ask(started, finishCall(seeded.avatarId, "kept", "token-aaaaaaaa"));
    const mark = started.posted.length;
    g.release();
    await preparing;

    expect(kept.error).toBeUndefined();
    expect(replyOf(started, late).deletePlan).toBeUndefined();
    expect((await avatarsOf(started)).avatars.map((a) => a.avatarId)).toEqual([seeded.avatarId]);
    const types = started.posted.slice(mark).flatMap((m) => {
      const e = EventMessage.safeParse(m);
      return e.success ? [e.data.type] : [];
    });
    expect(types).toContain("avatar.changed");
    expect((await ask(started, prepareCall(seeded.avatarId, "token-bbbbbbbb"))).deletePlan?.avatarId).toBe(seeded.avatarId);
  });

  test("a `kept` with another token does not abandon it: the prepare goes on and hands over its plan", async () => {
    const seeded = await seed();
    const g = libraryGate();
    const started = await start({ deps: { folderFs: g.folderFs } });
    g.arm();
    const late = prepareCall(seeded.avatarId, "token-aaaaaaaa");
    const preparing = started.engine.receive(late);
    await g.atGate;

    const stray = await ask(started, finishCall(seeded.avatarId, "kept", "token-bbbbbbbb"));
    g.release();
    await preparing;

    expect(stray.error?.code).toBe("NOT_FOUND");
    expect(replyOf(started, late).deletePlan?.avatarId).toBe(seeded.avatarId);
  });
});

describe("avatar.deleteFinish with nothing to finish", () => {  test("without a prepare it is NOT_FOUND and changes nothing", async () => {
    const seeded = await seed();
    const started = await start();

    expect((await ask(started, finishCall(seeded.avatarId, "trashed"))).error?.code).toBe("NOT_FOUND");
    expect(removedEvents(started)).toEqual([]);
    expect((await avatarsOf(started)).avatars.map((a) => a.avatarId)).toEqual([seeded.avatarId]);
  });

  test("for another avatar than the pending one it is NOT_FOUND, and the pending delete stays", async () => {
    const seeded = await seed();
    const started = await start();
    await ask(started, prepareCall(seeded.avatarId));

    expect((await ask(started, finishCall(seeded.draftId, "trashed"))).error?.code).toBe("NOT_FOUND");
    expect((await ask(started, finishCall(seeded.avatarId, "trashed"))).error).toBeUndefined();
  });

  test("a second finish of the same delete is NOT_FOUND and announces nothing more", async () => {
    const seeded = await seed();
    const started = await start();
    await ask(started, prepareCall(seeded.avatarId));
    await ask(started, finishCall(seeded.avatarId, "trashed"));

    expect((await ask(started, finishCall(seeded.avatarId, "trashed"))).error?.code).toBe("NOT_FOUND");
    expect(removedEvents(started)).toEqual([seeded.avatarId]);
  });
});

describe("the delete costs nothing and leaves the money alone", () => {
  test("no paid request is made and the ledger is not written", async () => {
    const seeded = await seed();
    const started = await start();

    await ask(started, prepareCall(seeded.avatarId));
    await ask(started, finishCall(seeded.avatarId, "trashed"));

    expect(started.net.paidCalls()).toEqual([]);
    expect(existsSync(join(dir(), "userData", "ledger.jsonl"))).toBe(false);
  });
});
