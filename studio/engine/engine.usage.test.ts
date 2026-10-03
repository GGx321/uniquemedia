import { describe, expect, test } from "bun:test";
import { appendFile, chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AvatarSummary, EventMessage, PhotoSummary } from "../shared/engine";
import { manifestTraits } from "./avatars/records";
import { openLibrary } from "./library";
import { PNG_1X1, samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import { sceneSpec, writeVideoRecord } from "./library/testing/videoRecords";
import { command, failed, GOOD, ok, startEngine, TRAITS, useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// 3e.2 through the engine: an avatar's usage on its summary (`AvatarSummary.usage`, K16), the two recoveries the «Фото» screen
// offers for it (`videos.quarantineRecords`, `photos.rebuildRejected`) with the `avatar.changed` that follows, and `videos.get`.

const dir = useEngineDir("studio-engine-usage-");
const libraryRoot = () => join(dir(), "library");

let seeded = 0;

/** A saved avatar with a master and `count` scene photos, written before the engine opens the library. */
async function seedAvatar(count = 3, name = "Mia"): Promise<{ avatarId: string; photoIds: string[] }> {
  const { library } = await openLibrary(libraryRoot(), { now: steppingClock(), newId: sequentialIds(`usg${++seeded}`) });
  const avatar = await library.createAvatar({ name, age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
  const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  const base = samplePhotoMeta().source;
  if (base.kind !== "generated") throw new Error("expected a generated sample source");
  const photoIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const photo = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ source: { ...base, category: "home", attemptId: `run-00000001:slot-${i + 1}#1`, slot: `slot-${i + 1}` }, qa: { age: { adult: true, confidence: 0.95 } } }));
    photoIds.push(photo.id);
  }
  return { avatarId: avatar.id, photoIds };
}

const videosDir = (avatarId: string) => join(libraryRoot(), "avatars", avatarId, "videos");
const rejectsPath = (avatarId: string) => join(libraryRoot(), "avatars", avatarId, "rejected.jsonl");

type Engine = Awaited<ReturnType<typeof startEngine>>["engine"];

async function summaryOf(engine: Engine, avatarId: string): Promise<AvatarSummary | undefined> {
  const answer = ok(await engine.handle(command("avatars.list")));
  if (answer.type !== "avatars.list") throw new Error("expected avatars.list");
  return answer.result.avatars.find((a) => a.avatarId === avatarId);
}

async function photosOf(engine: Engine, avatarId: string): Promise<PhotoSummary[]> {
  const answer = ok(await engine.handle(command("photos.list", { avatarId })));
  if (answer.type !== "photos.list") throw new Error("expected photos.list");
  return answer.result.photos;
}

const announced = (events: EventMessage[], avatarId: string) => events.flatMap((e) => (e.type === "avatar.changed" && e.payload.avatar.avatarId === avatarId ? [e.payload.avatar] : []));

async function quarantineFiles(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (path: string, rel: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) await walk(join(path, entry.name), `${rel}${entry.name}/`);
      else out.push(`${rel}${entry.name}`);
    }
  };
  await walk(join(libraryRoot(), "quarantine"), "");
  return out;
}

describe("AvatarSummary.usage through the engine", () => {
  test("a sound avatar is ok in the snapshot and in avatars.list", async () => {
    const { avatarId } = await seedAvatar();
    const { engine } = await startEngine(dir());

    const snapshot = ok(await engine.handle(command("engine.snapshot")));
    if (snapshot.type !== "engine.snapshot") throw new Error("expected a snapshot");
    expect(snapshot.result.avatars.find((a) => a.avatarId === avatarId)?.usage).toEqual({ state: "ok" });
    expect((await summaryOf(engine, avatarId))?.usage).toEqual({ state: "ok" });
  });

  test("a broken record, broken marks and a newer record each name their reason, with no unused photo counted", async () => {
    const a = await seedAvatar(2, "Mia");
    const b = await seedAvatar(2, "Lena");
    const c = await seedAvatar(2, "Nora");
    await mkdir(videosDir(a.avatarId), { recursive: true });
    await writeFile(join(videosDir(a.avatarId), "video-00000002.json"), "{ not json");
    await writeFile(rejectsPath(b.avatarId), "not json\n");
    await mkdir(videosDir(c.avatarId), { recursive: true });
    await writeFile(join(videosDir(c.avatarId), "video-00000003.json"), JSON.stringify({ schemaVersion: 2, id: "video-00000003", avatarId: c.avatarId }));
    const { engine } = await startEngine(dir());

    expect(await summaryOf(engine, a.avatarId)).toMatchObject({ eligibleUnusedCount: 0, usage: { state: "unknown", reasons: ["record-unreadable"] } });
    expect(await summaryOf(engine, b.avatarId)).toMatchObject({ eligibleUnusedCount: 0, usage: { state: "unknown", reasons: ["rejects-unreadable"] } });
    expect(await summaryOf(engine, c.avatarId)).toMatchObject({ eligibleUnusedCount: 0, usage: { state: "unknown", reasons: ["library-too-new"] } });
  });
});

describe("videos.quarantineRecords («Убрать повреждённую запись»)", () => {
  test("moves the broken record into the library's quarantine, answers how many, and the avatar is trusted again: avatar.changed says so", async () => {
    const { avatarId, photoIds } = await seedAvatar();
    await writeVideoRecord(libraryRoot(), "video-00000001", sceneSpec(avatarId, [photoIds[0] ?? ""]));
    await writeFile(join(videosDir(avatarId), "video-00000002.json"), "{ not json");
    const { engine, events } = await startEngine(dir());

    const answer = ok(await engine.handle(command("videos.quarantineRecords", { avatarId })));

    expect(answer.result).toEqual({ avatarId, quarantined: 1 });
    expect(await quarantineFiles()).toEqual([expect.stringMatching(new RegExp(`/avatars/${avatarId}/videos/video-00000002\\.json$`))]);
    expect(announced(events(), avatarId).at(-1)).toMatchObject({ videoCount: 1, eligibleUnusedCount: 2, usage: { state: "ok" } });
    expect((await summaryOf(engine, avatarId))?.usage).toEqual({ state: "ok" });
  });

  test("a repeat moves nothing and announces nothing new", async () => {
    const { avatarId } = await seedAvatar();
    await mkdir(videosDir(avatarId), { recursive: true });
    await writeFile(join(videosDir(avatarId), "video-00000002.json"), "{ not json");
    const { engine, events } = await startEngine(dir());
    ok(await engine.handle(command("videos.quarantineRecords", { avatarId })));
    const before = announced(events(), avatarId).length;

    const again = ok(await engine.handle(command("videos.quarantineRecords", { avatarId })));

    expect(again.result).toEqual({ avatarId, quarantined: 0 });
    expect(announced(events(), avatarId).length).toBe(before);
    expect(await quarantineFiles()).toHaveLength(1);
  });

  test("a record from a newer Studio is never moved: the answer is 0 and the avatar stays unknown", async () => {
    const { avatarId } = await seedAvatar();
    await mkdir(videosDir(avatarId), { recursive: true });
    await writeFile(join(videosDir(avatarId), "video-00000003.json"), JSON.stringify({ schemaVersion: 2, id: "video-00000003", avatarId }));
    const { engine } = await startEngine(dir());

    expect(ok(await engine.handle(command("videos.quarantineRecords", { avatarId }))).result).toEqual({ avatarId, quarantined: 0 });
    expect((await summaryOf(engine, avatarId))?.usage).toEqual({ state: "unknown", reasons: ["library-too-new"] });
    expect(await quarantineFiles()).toEqual([]);
  });

  // chmod 000 means nothing on Windows, and root reads through it; the library's own tests cover every platform with EBUSY.
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a sound record the disk will not open is record-inaccessible: the answer is 0, the file stays, and no photo is counted unused",
    async () => {
      const { avatarId, photoIds } = await seedAvatar();
      const record = await writeVideoRecord(libraryRoot(), "video-00000001", sceneSpec(avatarId, [photoIds[0] ?? ""]));
      await chmod(record, 0o000);
      try {
        const { engine } = await startEngine(dir());
        expect((await summaryOf(engine, avatarId))?.usage).toEqual({ state: "unknown", reasons: ["record-inaccessible"] });

        expect(ok(await engine.handle(command("videos.quarantineRecords", { avatarId }))).result).toEqual({ avatarId, quarantined: 0 });

        expect(await quarantineFiles()).toEqual([]);
        const summary = await summaryOf(engine, avatarId);
        expect(summary?.usage).toEqual({ state: "unknown", reasons: ["record-inaccessible"] });
        expect(summary?.eligibleUnusedCount).toBe(0);
      } finally {
        await chmod(record, 0o644);
      }
    },
  );

  test("an unknown avatar is NOT_FOUND", async () => {
    await seedAvatar();
    const { engine } = await startEngine(dir());
    expect(failed(await engine.handle(command("videos.quarantineRecords", { avatarId: "avatar-nobody" }))).error.code).toBe("NOT_FOUND");
  });

  test("a move that fails is INTERNAL with the disk's code alone: no library path reaches the window, and the record is where it was", async () => {
    const { avatarId } = await seedAvatar();
    await mkdir(videosDir(avatarId), { recursive: true });
    await writeFile(join(videosDir(avatarId), "video-00000002.json"), "{ not json");
    await writeFile(join(libraryRoot(), "quarantine"), "a file where the quarantine folder goes");
    const { engine } = await startEngine(dir());

    const error = failed(await engine.handle(command("videos.quarantineRecords", { avatarId }))).error;

    expect(error.code).toBe("INTERNAL");
    expect(error.detail ?? "").not.toContain(libraryRoot());
    expect(error.detail ?? "").not.toContain(dir());
    expect(await readFile(join(videosDir(avatarId), "video-00000002.json"), "utf8")).toBe("{ not json");
  });
});

describe("photos.rebuildRejected («Восстановить отметки»)", () => {
  test("keeps every mark that reads, copies the log aside, and the avatar is trusted again: avatar.changed says so", async () => {
    const { avatarId, photoIds } = await seedAvatar();
    const [a, b] = photoIds;
    await writeFile(
      rejectsPath(avatarId),
      `${JSON.stringify({ photoId: a, op: "reject", at: "2026-09-30T10:00:00.000Z" })}\nnot json\n${JSON.stringify({ photoId: b, op: "reject", at: "2026-09-30T10:01:00.000Z" })}\n`,
    );
    const { engine, events } = await startEngine(dir());
    expect((await summaryOf(engine, avatarId))?.usage).toEqual({ state: "unknown", reasons: ["rejects-unreadable"] });

    const answer = ok(await engine.handle(command("photos.rebuildRejected", { avatarId })));

    expect(answer.result).toEqual({ avatarId, rebuilt: true, kept: 2, dropped: 1 });
    expect(await quarantineFiles()).toEqual([expect.stringMatching(new RegExp(`/avatars/${avatarId}/rejected\\.jsonl$`))]);
    expect(announced(events(), avatarId).at(-1)).toMatchObject({ eligibleUnusedCount: 1, usage: { state: "ok" } });
    const states = new Map((await photosOf(engine, avatarId)).map((p) => [p.photoId, p.rejected]));
    expect([states.get(a ?? ""), states.get(b ?? ""), states.get(photoIds[2] ?? "")]).toEqual([true, true, false]);
  });

  test("a sound log answers rebuilt false and announces nothing", async () => {
    const { avatarId, photoIds } = await seedAvatar();
    await writeFile(rejectsPath(avatarId), `${JSON.stringify({ photoId: photoIds[0], op: "reject", at: "2026-09-30T10:00:00.000Z" })}\n`);
    const { engine, events } = await startEngine(dir());
    const before = announced(events(), avatarId).length;

    expect(ok(await engine.handle(command("photos.rebuildRejected", { avatarId }))).result).toEqual({ avatarId, rebuilt: false, kept: 1, dropped: 0 });
    expect(announced(events(), avatarId).length).toBe(before);
  });

  test("an unknown avatar is NOT_FOUND", async () => {
    await seedAvatar();
    const { engine } = await startEngine(dir());
    expect(failed(await engine.handle(command("photos.rebuildRejected", { avatarId: "avatar-nobody" }))).error.code).toBe("NOT_FOUND");
  });

  test("a copy that fails is INTERNAL with no path, and the log is as it was", async () => {
    const { avatarId } = await seedAvatar();
    await writeFile(rejectsPath(avatarId), "not json\n");
    await writeFile(join(libraryRoot(), "quarantine"), "a file where the quarantine folder goes");
    const { engine } = await startEngine(dir());

    const error = failed(await engine.handle(command("photos.rebuildRejected", { avatarId }))).error;

    expect(error.code).toBe("INTERNAL");
    expect(error.detail ?? "").not.toContain(dir());
    expect(await readFile(rejectsPath(avatarId), "utf8")).toBe("not json\n");
  });

  test("marking works again after the rebuild", async () => {
    const { avatarId, photoIds } = await seedAvatar();
    await appendFile(rejectsPath(avatarId), "not json\n");
    const { engine } = await startEngine(dir());
    expect(failed(await engine.handle(command("photos.setRejected", { avatarId, photoId: photoIds[0], rejected: true }))).error.code).not.toBe("NOT_FOUND");

    ok(await engine.handle(command("photos.rebuildRejected", { avatarId })));

    expect(ok(await engine.handle(command("photos.setRejected", { avatarId, photoId: photoIds[0], rejected: true }))).result).toMatchObject({ photo: { rejected: true } });
  });
});

describe("videos.get through the engine", () => {
  test("answers one video by id; an unknown one is NOT_FOUND", async () => {
    const { avatarId, photoIds } = await seedAvatar();
    await writeVideoRecord(libraryRoot(), "video-00000001", sceneSpec(avatarId, [photoIds[0] ?? ""]), { title: "утро дома", jobId: "job-00000001", montageId: null, music: null });
    const { engine } = await startEngine(dir());

    const answer = ok(await engine.handle(command("videos.get", { videoId: "video-00000001" })));
    if (answer.type !== "videos.get") throw new Error("expected videos.get");
    expect(answer.result.video).toMatchObject({ videoId: "video-00000001", avatarId, title: "утро дома" });
    expect(failed(await engine.handle(command("videos.get", { videoId: "video-0000ffff" }))).error.code).toBe("NOT_FOUND");
  });
});
