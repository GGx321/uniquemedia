import { describe, expect, test } from "bun:test";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AvatarSummary, PhotoSummary } from "../shared/engine";
import { manifestTraits } from "./avatars/records";
import { NODE_FOLDER_FS, type FolderFs } from "./folderIdentity";
import { openLibrary } from "./library";
import { PNG_1X1, samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import { sceneSpec, writeVideoRecord } from "./library/testing/videoRecords";
import { command, failed, GOOD, ok, startEngine, TRAITS, useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Task 3a.2 through the engine: photos.list, the avatar counts and
// photos.setRejected all answer from the library's one eligibility function,
// the video records and the reject marks. Records are written straight to
// disk; the render queue's reserved set is injected.

const dir = useEngineDir("studio-engine-eligibility-");
const libraryRoot = () => join(dir(), "library");

let seeded = 0;

interface Seeded {
  avatarId: string;
  masterId: string;
  /** Scene photos, oldest first. */
  photoIds: string[];
}

/** A saved avatar with a master portrait and `count` scene photos, the first `failing` of them carrying a failing age verdict. */
async function seedAvatar(count: number, opts: { failing?: number; unchecked?: boolean } = {}): Promise<Seeded> {
  const { library } = await openLibrary(libraryRoot(), { now: steppingClock(), newId: sequentialIds(`elig${++seeded}`) });
  const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
  const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  const photoIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const base = samplePhotoMeta().source;
    if (base.kind !== "generated") throw new Error("expected a generated sample source");
    const failing = i < (opts.failing ?? 0);
    const qa = failing ? { age: { adult: false, confidence: 0.9 } } : opts.unchecked ? {} : { age: { adult: true, confidence: 0.95 } };
    const photo = await library.addPhoto(
      avatar.id,
      PNG_1X1,
      samplePhotoMeta({ source: { ...base, category: "home", attemptId: `run-00000001:slot-${i + 1}#1`, slot: `slot-${i + 1}` }, qa }),
    );
    photoIds.push(photo.id);
  }
  return { avatarId: avatar.id, masterId: master.id, photoIds };
}

async function listPhotos(engine: Awaited<ReturnType<typeof startEngine>>["engine"], avatarId: string): Promise<PhotoSummary[]> {
  const answer = ok(await engine.handle(command("photos.list", { avatarId })));
  if (answer.type !== "photos.list") throw new Error(`expected photos.list, got ${answer.type}`);
  return answer.result.photos;
}

async function avatarSummary(engine: Awaited<ReturnType<typeof startEngine>>["engine"], avatarId: string): Promise<AvatarSummary> {
  const answer = ok(await engine.handle(command("avatars.list", {})));
  if (answer.type !== "avatars.list") throw new Error(`expected avatars.list, got ${answer.type}`);
  const found = answer.result.avatars.find((a) => a.avatarId === avatarId);
  if (found === undefined) throw new Error("the avatar is not listed");
  return found;
}

function rejectedAnswer(response: Parameters<typeof ok>[0]): PhotoSummary {
  const answer = ok(response);
  if (answer.type !== "photos.setRejected") throw new Error(`expected photos.setRejected, got ${answer.type}`);
  return answer.result.photo;
}

const byId = (photos: readonly PhotoSummary[], photoId: string): PhotoSummary => {
  const found = photos.find((p) => p.photoId === photoId);
  if (found === undefined) throw new Error(`photo ${photoId} is not listed`);
  return found;
};

describe("photos.list reports the derived state", () => {
  test("a photo a video record lists is used, with the video in usedIn, and the others are not", async () => {
    const { avatarId, photoIds } = await seedAvatar(3);
    await writeVideoRecord(libraryRoot(), "video-00000001", sceneSpec(avatarId, [photoIds[0] ?? ""]));
    const { engine } = await startEngine(dir());
    const photos = await listPhotos(engine, avatarId);
    expect(byId(photos, photoIds[0] ?? "")).toMatchObject({ used: true, usedIn: ["video-00000001"], eligible: true });
    expect(byId(photos, photoIds[1] ?? "")).toMatchObject({ used: false, usedIn: [] });
  });

  test("an age-failed photo is listed but not eligible, and a photo with no verdict is eligible", async () => {
    const { avatarId, photoIds } = await seedAvatar(2, { failing: 1 });
    const { engine } = await startEngine(dir());
    const photos = await listPhotos(engine, avatarId);
    expect(byId(photos, photoIds[0] ?? "").eligible).toBe(false);
    expect(byId(photos, photoIds[1] ?? "").eligible).toBe(true);

    const unchecked = await seedAvatar(1, { unchecked: true });
    const restarted = await startEngine(dir());
    expect((await listPhotos(restarted.engine, unchecked.avatarId))[0]?.eligible).toBe(true);
  });

  test("a photo the injected reserved provider names is reserved, and only while it names it", async () => {
    const { avatarId, photoIds } = await seedAvatar(2);
    const reserved = new Set<string>([photoIds[1] ?? ""]);
    const { engine } = await startEngine(dir(), { deps: { reservedPhotos: () => reserved } });
    expect(byId(await listPhotos(engine, avatarId), photoIds[1] ?? "")).toMatchObject({ reserved: true, eligible: true });
    reserved.clear();
    expect(byId(await listPhotos(engine, avatarId), photoIds[1] ?? "").reserved).toBe(false);
  });
});

describe("the avatar counts", () => {
  test("videoCount counts the records and eligibleUnusedCount is eligible minus used minus rejected minus reserved", async () => {
    const { avatarId, photoIds } = await seedAvatar(5, { failing: 1 });
    const [, used, rejected, held, free] = photoIds;
    await writeVideoRecord(libraryRoot(), "video-00000001", sceneSpec(avatarId, [used ?? ""]));
    const reserved = new Set<string>([held ?? ""]);
    const { engine } = await startEngine(dir(), { deps: { reservedPhotos: () => reserved } });
    ok(await engine.handle(command("photos.setRejected", { avatarId, photoId: rejected ?? "", rejected: true })));

    const summary = await avatarSummary(engine, avatarId);
    expect(summary).toMatchObject({ photoCount: 5, videoCount: 1, eligibleUnusedCount: 1 });
    const photos = await listPhotos(engine, avatarId);
    expect(photos.filter((p) => p.eligible && !p.used && !p.reserved).map((p) => p.photoId)).toEqual([free ?? ""]);
  });

  test("the snapshot carries the same counts as avatars.list", async () => {
    const { avatarId, photoIds } = await seedAvatar(2);
    await writeVideoRecord(libraryRoot(), "video-00000001", sceneSpec(avatarId, [photoIds[0] ?? ""]));
    const { engine } = await startEngine(dir());
    const snapshot = ok(await engine.handle(command("engine.snapshot")));
    if (snapshot.type !== "engine.snapshot") throw new Error(`expected engine.snapshot, got ${snapshot.type}`);
    expect(snapshot.result.avatars.find((a) => a.avatarId === avatarId)).toEqual(await avatarSummary(engine, avatarId));
  });
});

describe("photos.setRejected", () => {
  test("marks a photo rejected: it is answered as it now stands, not eligible", async () => {
    const { avatarId, photoIds } = await seedAvatar(2);
    const { engine } = await startEngine(dir());
    const photo = rejectedAnswer(await engine.handle(command("photos.setRejected", { avatarId, photoId: photoIds[0] ?? "", rejected: true })));
    expect(photo).toMatchObject({ photoId: photoIds[0], rejected: true, eligible: false });
  });

  test("restoring the photo makes it eligible again", async () => {
    const { avatarId, photoIds } = await seedAvatar(1);
    const { engine } = await startEngine(dir());
    ok(await engine.handle(command("photos.setRejected", { avatarId, photoId: photoIds[0] ?? "", rejected: true })));
    const photo = rejectedAnswer(await engine.handle(command("photos.setRejected", { avatarId, photoId: photoIds[0] ?? "", rejected: false })));
    expect(photo).toMatchObject({ rejected: false, eligible: true });
  });

  test("announces the avatar with its new eligibleUnusedCount, down on a reject and up on a restore", async () => {
    const { avatarId, photoIds } = await seedAvatar(2);
    const { engine, events } = await startEngine(dir());
    ok(await engine.handle(command("photos.setRejected", { avatarId, photoId: photoIds[0] ?? "", rejected: true })));
    ok(await engine.handle(command("photos.setRejected", { avatarId, photoId: photoIds[0] ?? "", rejected: false })));
    const counts = events().flatMap((e) => (e.type === "avatar.changed" ? [e.payload.avatar.eligibleUnusedCount] : []));
    expect(counts).toEqual([1, 2]);
  });

  test("a mark survives an engine restart", async () => {
    const { avatarId, photoIds } = await seedAvatar(2);
    const first = await startEngine(dir());
    ok(await first.engine.handle(command("photos.setRejected", { avatarId, photoId: photoIds[0] ?? "", rejected: true })));

    const second = await startEngine(dir());
    const photos = await listPhotos(second.engine, avatarId);
    expect(byId(photos, photoIds[0] ?? "")).toMatchObject({ rejected: true, eligible: false });
    expect(byId(photos, photoIds[1] ?? "").rejected).toBe(false);
    expect((await avatarSummary(second.engine, avatarId)).eligibleUnusedCount).toBe(1);
  });

  test("is NOT_FOUND for an unknown avatar, an unknown photo, another avatar's photo and the master", async () => {
    const mia = await seedAvatar(1);
    const lena = await seedAvatar(1);
    const { engine } = await startEngine(dir());
    const notFound = async (avatarId: string, photoId: string) =>
      failed(await engine.handle(command("photos.setRejected", { avatarId, photoId, rejected: true }))).error.code;
    expect(await notFound("avatar-00000404", mia.photoIds[0] ?? "")).toBe("NOT_FOUND");
    expect(await notFound(mia.avatarId, "photo-00000404")).toBe("NOT_FOUND");
    expect(await notFound(mia.avatarId, lena.photoIds[0] ?? "")).toBe("NOT_FOUND");
    expect(await notFound(mia.avatarId, mia.masterId)).toBe("NOT_FOUND");
  });

  test("refuses while the avatar's rejected.jsonl is unreadable, and changes nothing", async () => {
    const { avatarId, photoIds } = await seedAvatar(1);
    await appendFile(join(libraryRoot(), "avatars", avatarId, "rejected.jsonl"), "not json\n");
    const { engine } = await startEngine(dir());
    const refusal = failed(await engine.handle(command("photos.setRejected", { avatarId, photoId: photoIds[0] ?? "", rejected: true }))).error;
    expect(refusal.code).toBe("INTERNAL");
    expect(refusal.detail).toContain("rejected.jsonl");
    expect(byId(await listPhotos(engine, avatarId), photoIds[0] ?? "").eligible).toBe(false);
  });

  test("is allowed while a job or command holds that avatar busy", async () => {
    const { avatarId, photoIds } = await seedAvatar(1);
    let holdFirst = false;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slowOnce = async <T>(path: string, work: () => Promise<T>): Promise<T> => {
      if (holdFirst && basename(path) === "library") {
        holdFirst = false;
        await gate;
      }
      return work();
    };
    const folderFs: FolderFs = { stat: (p) => slowOnce(p, () => NODE_FOLDER_FS.stat(p)), realpath: (p) => slowOnce(p, () => NODE_FOLDER_FS.realpath(p)) };
    const { engine } = await startEngine(dir(), { deps: { folderFs } });
    holdFirst = true;
    const archiving = engine.handle(command("avatars.archive", { avatarId })); // claims the avatar busy, held at its live-library check
    const photo = rejectedAnswer(await engine.handle(command("photos.setRejected", { avatarId, photoId: photoIds[0] ?? "", rejected: true })));
    expect(photo.rejected).toBe(true);
    release();
    ok(await archiving);
  });

  test("announces the avatar only when the mark changed something", async () => {
    const { avatarId, photoIds } = await seedAvatar(1);
    const { engine, events } = await startEngine(dir());
    const mark = (rejected: boolean) => engine.handle(command("photos.setRejected", { avatarId, photoId: photoIds[0] ?? "", rejected }));
    ok(await mark(false));
    ok(await mark(true));
    ok(await mark(true));
    expect(events().filter((e) => e.type === "avatar.changed")).toHaveLength(1);
  });

  test("blocks a library switch while it is in flight, like the other writes", async () => {
    const { avatarId, photoIds } = await seedAvatar(1);
    let hold: Promise<void> | null = null;
    // Only the live library's own re-check is slowed: that is what a write waits on before it writes.
    const slow = async <T>(path: string, work: () => Promise<T>): Promise<T> => {
      if (hold !== null && basename(path) === "library") await hold;
      return work();
    };
    const folderFs: FolderFs = { stat: (p) => slow(p, () => NODE_FOLDER_FS.stat(p)), realpath: (p) => slow(p, () => NODE_FOLDER_FS.realpath(p)) };
    const { engine, posted } = await startEngine(dir(), { deps: { folderFs } });
    let release: () => void = () => {};
    hold = new Promise<void>((resolve) => (release = resolve));

    const marking = engine.handle(command("photos.setRejected", { avatarId, photoId: photoIds[0] ?? "", rejected: true }));
    const other = join(dir(), "other-library");
    await mkdir(other);
    await engine.receive({ kind: "control", type: "library.open", callId: "call-00000001", path: other });
    const replies = () => posted.flatMap((m) => (typeof m === "object" && m !== null && "kind" in m && m.kind === "control" ? [m] : []));
    expect(replies()).toMatchObject([{ callId: "call-00000001", error: { code: "IN_FLIGHT" } }]);

    release();
    ok(await marking);
    await engine.receive({ kind: "control", type: "library.open", callId: "call-00000002", path: other });
    expect(replies().at(-1)).toMatchObject({ callId: "call-00000002" });
    expect(replies().at(-1)).not.toHaveProperty("error");
  });
});

describe("opening a library with unreadable records", () => {
  test("logs each problem once, with the avatar, the relative file and the reason class, and no path or content", async () => {
    const { avatarId } = await seedAvatar(1);
    await writeFile(join(libraryRoot(), "avatars", avatarId, "rejected.jsonl"), "SECRET-CONTENT\n");
    await mkdir(join(libraryRoot(), "avatars", avatarId, "videos"));
    await writeFile(join(libraryRoot(), "avatars", avatarId, "videos", "video-00000001.json"), "SECRET-CONTENT");
    await writeFile(join(libraryRoot(), "avatars", avatarId, "videos", "video-00000002.json"), JSON.stringify({ schemaVersion: 2 }));
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
    try {
      await startEngine(dir());
    } finally {
      console.warn = original;
    }
    const lines = warnings.filter((w) => w.includes(avatarId));
    expect(lines).toHaveLength(3);
    expect(lines.some((l) => l.includes("rejected.jsonl") && l.includes("unreadable"))).toBe(true);
    expect(lines.some((l) => l.includes("videos/video-00000001.json") && l.includes("unreadable"))).toBe(true);
    const newer = lines.find((l) => l.includes("videos/video-00000002.json") && l.includes("too-new"));
    expect(newer).toContain("update the app");
    expect(newer).not.toContain("repaired");
    for (const line of lines) {
      expect(line).not.toContain(dir());
      expect(line).not.toContain("SECRET-CONTENT");
    }
  });

  /** The warnings `startEngine` prints while opening the seeded library. */
  async function warningsAtOpen(): Promise<string[]> {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
    try {
      await startEngine(dir());
    } finally {
      console.warn = original;
    }
    return warnings;
  }

  test("a file name with a newline or control characters cannot forge a log line", async () => {
    const { avatarId } = await seedAvatar(1);
    await mkdir(join(libraryRoot(), "avatars", avatarId, "videos"));
    await writeFile(join(libraryRoot(), "avatars", avatarId, "videos", "video-00000001\nstudio engine: all is well\u001b[2J.json"), "{ nope");
    const lines = (await warningsAtOpen()).filter((w) => w.includes(avatarId));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  test("a record misfiled under one avatar that names another closes the other, and both are logged", async () => {
    const mia = await seedAvatar(1);
    const lena = await seedAvatar(1);
    await mkdir(join(libraryRoot(), "avatars", mia.avatarId, "videos"));
    await writeFile(
      join(libraryRoot(), "avatars", mia.avatarId, "videos", "video-00000001.json"),
      JSON.stringify({ schemaVersion: 1, id: "video-00000001", avatarId: lena.avatarId, spec: { clips: [{ kind: "photo", cell: { photo: { source: "scene", photoId: lena.photoIds[0] }, focus: null } }] } }),
    );
    const warnings = await warningsAtOpen();
    expect(warnings.filter((w) => w.includes(mia.avatarId) && w.includes("videos/video-00000001.json"))).toHaveLength(1);
    expect(warnings.filter((w) => w.includes(`avatar ${lena.avatarId}`) && w.includes(mia.avatarId))).toHaveLength(1);
  });
});
