import { describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { encodePhotoCursor, MAX_LISTED_PHOTOS } from "../shared/engine";
import { manifestTraits } from "./avatars/records";
import { openLibrary } from "./library";
import { PNG_1X1, samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import { command, failed, GOOD, ok, startEngine, TRAITS, useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// S4.P2: photos.list with a cursor, against a real library in a temp dir. Photos past the first page are eligible for the autopilot,
// so the owner must be able to page to every one of them. Seeding follows engine.photos.test.ts (plain files, read only by the engine).

const dir = useEngineDir("studio-engine-photos-cursor-");

let seeded = 0;
const SEED_CHUNK = 50;

function runPhotoMeta(n: number) {
  return samplePhotoMeta({
    source: {
      kind: "generated",
      model: "x-ai/grok-imagine-image-2.0",
      provider: "openrouter",
      jobId: "job-0001",
      attemptId: `run-00000001:slot-${n}#1`,
      promptSha: "a".repeat(64),
      prompt: "A friend catches her mid-laugh at the kitchen counter.",
      slot: `slot-${n}`,
      category: "home",
      costMicros: 50_000,
    },
  });
}

/** A saved, active avatar with `count` run photos, oldest first, each one second newer than the one before. */
async function seedAvatar(count: number): Promise<{ avatarId: string; photoIds: string[]; firstCreatedAt: string }> {
  const { library } = await openLibrary(join(dir(), "library"), { now: steppingClock(), newId: sequentialIds(`cur${++seeded}`) });
  const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
  const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  if (count === 0) return { avatarId: avatar.id, photoIds: [], firstCreatedAt: master.createdAt };
  const first = await library.addPhoto(avatar.id, PNG_1X1, runPhotoMeta(1));
  const photoIds = [first.id];
  const photosDir = join(dir(), "library", "avatars", avatar.id, "photos");
  const rest = Array.from({ length: count - 1 }, (_unused, k) => {
    const n = k + 2;
    const id = `bulk${seeded}-${String(n).padStart(5, "0")}`;
    photoIds.push(id);
    return { id, sidecar: { ...first, id, file: `${id}.png`, source: runPhotoMeta(n).source, createdAt: new Date(Date.parse(first.createdAt) + n * 1000).toISOString() } };
  });
  for (let from = 0; from < rest.length; from += SEED_CHUNK) {
    await Promise.all(
      rest.slice(from, from + SEED_CHUNK).map(async ({ id, sidecar }) => {
        await writeFile(join(photosDir, `${id}.png`), PNG_1X1);
        await writeFile(join(photosDir, `${id}.json`), `${JSON.stringify(sidecar, null, 2)}\n`);
      }),
    );
  }
  return { avatarId: avatar.id, photoIds, firstCreatedAt: first.createdAt };
}

type Page = { photoIds: string[]; nextCursor: string | null; remainingTotal: number; skippedTotal: number };

async function listPage(engine: Awaited<ReturnType<typeof startEngine>>["engine"], avatarId: string, cursor?: string): Promise<Page> {
  const answer = ok(await engine.handle(command("photos.list", cursor === undefined ? { avatarId } : { avatarId, cursor })));
  if (answer.type !== "photos.list") throw new Error(`expected photos.list, got ${answer.type}`);
  const { photos, nextCursor, remainingTotal, skippedTotal } = answer.result;
  return { photoIds: photos.map((p) => p.photoId), nextCursor, remainingTotal, skippedTotal };
}

async function walk(engine: Awaited<ReturnType<typeof startEngine>>["engine"], avatarId: string): Promise<Page[]> {
  const pages: Page[] = [];
  let cursor: string | undefined;
  do {
    const page = await listPage(engine, avatarId, cursor);
    pages.push(page);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return pages;
}

describe("photos.list cursor", () => {
  test("0 photos: an empty page, no cursor, nothing remaining", async () => {
    const { avatarId } = await seedAvatar(0);
    const { engine } = await startEngine(dir());
    const page = await listPage(engine, avatarId);
    expect(page.photoIds).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(page.remainingTotal).toBe(0);
  });

  test("exactly the page size: one page, no cursor", async () => {
    const { avatarId } = await seedAvatar(MAX_LISTED_PHOTOS);
    const { engine } = await startEngine(dir());
    const page = await listPage(engine, avatarId);
    expect(page.photoIds).toHaveLength(MAX_LISTED_PHOTOS);
    expect(page.nextCursor).toBeNull();
    expect(page.remainingTotal).toBe(0);
  }, 30_000);

  test("one past the page size: a cursor and one photo remaining, and the cursor leads to the oldest photo", async () => {
    const { avatarId, photoIds } = await seedAvatar(MAX_LISTED_PHOTOS + 1);
    const { engine } = await startEngine(dir());
    const first = await listPage(engine, avatarId);
    expect(first.photoIds).toHaveLength(MAX_LISTED_PHOTOS);
    expect(first.remainingTotal).toBe(1);
    expect(first.nextCursor).not.toBeNull();
    const second = await listPage(engine, avatarId, first.nextCursor ?? "");
    expect(second.photoIds).toEqual([photoIds[0] ?? ""]);
    expect(second.nextCursor).toBeNull();
  }, 30_000);

  test("1000 + 1 photos page as 500, 500, 1: newest first, no overlap, no gap", async () => {
    const { avatarId, photoIds } = await seedAvatar(2 * MAX_LISTED_PHOTOS + 1);
    const { engine } = await startEngine(dir());
    const pages = await walk(engine, avatarId);
    expect(pages.map((p) => p.photoIds.length)).toEqual([500, 500, 1]);
    expect(pages.flatMap((p) => p.photoIds)).toEqual([...photoIds].reverse());
    expect(pages.map((p) => p.remainingTotal)).toEqual([501, 1, 0]);
  }, 60_000);

  test("a call without a cursor answers exactly the first page (old callers)", async () => {
    const { avatarId, photoIds } = await seedAvatar(MAX_LISTED_PHOTOS + 3);
    const { engine } = await startEngine(dir());
    const page = await listPage(engine, avatarId);
    expect(page.photoIds).toEqual([...photoIds].reverse().slice(0, MAX_LISTED_PHOTOS));
  }, 30_000);

  test("a cursor naming a photo that was deleted still resumes right after its position", async () => {
    const { avatarId, photoIds, firstCreatedAt } = await seedAvatar(5);
    const deletedId = photoIds[2] ?? "";
    const photosDir = join(dir(), "library", "avatars", avatarId, "photos");
    await rm(join(photosDir, `${deletedId}.png`));
    await rm(join(photosDir, `${deletedId}.json`));
    const { engine } = await startEngine(dir());
    const deletedAt = new Date(Date.parse(firstCreatedAt) + 3 * 1000).toISOString();
    const page = await listPage(engine, avatarId, encodePhotoCursor(deletedAt, deletedId));
    expect(page.photoIds).toEqual([photoIds[1] ?? "", photoIds[0] ?? ""]);
  }, 30_000);

  test("photos added between calls do not move the next page", async () => {
    const { avatarId, photoIds, firstCreatedAt } = await seedAvatar(MAX_LISTED_PHOTOS + 2);
    const { engine } = await startEngine(dir());
    const first = await listPage(engine, avatarId);
    const photosDir = join(dir(), "library", "avatars", avatarId, "photos");
    const template = JSON.parse(await Bun.file(join(photosDir, `${photoIds[0]}.json`)).text());
    for (const n of [1, 2, 3]) {
      const id = `late${seeded}-${n}`;
      const sidecar = { ...template, id, file: `${id}.png`, createdAt: new Date(Date.parse(firstCreatedAt) + (10_000 + n) * 1000).toISOString() };
      await writeFile(join(photosDir, `${id}.png`), PNG_1X1);
      await writeFile(join(photosDir, `${id}.json`), `${JSON.stringify(sidecar)}\n`);
    }
    const reopened = await startEngine(dir());
    const second = await listPage(reopened.engine, avatarId, first.nextCursor ?? "");
    expect(second.photoIds).toEqual([photoIds[1] ?? "", photoIds[0] ?? ""]);
    expect(first.photoIds.some((id) => second.photoIds.includes(id))).toBe(false);
  }, 30_000);

  test("skippedTotal keeps its own meaning: unreadable photos, never the ones beyond the page", async () => {
    const { avatarId } = await seedAvatar(MAX_LISTED_PHOTOS + 2);
    const { engine } = await startEngine(dir());
    const page = await listPage(engine, avatarId);
    expect(page.remainingTotal).toBe(2);
    expect(page.skippedTotal).toBe(0);
  }, 30_000);

  test.each([
    ["free text", "next"],
    ["an empty string", ""],
    ["a path in the id", "2026-09-24T11:00:00.000Z|../../etc/passwd"],
    ["an oversized value", "x".repeat(10_000)],
  ])("a forged cursor is refused with VALIDATION and the engine keeps answering: %s", async (_label, cursor) => {
    const { avatarId } = await seedAvatar(3);
    const { engine } = await startEngine(dir());
    expect(failed(await engine.handle(command("photos.list", { avatarId, cursor }))).error.code).toBe("VALIDATION");
    expect((await listPage(engine, avatarId)).photoIds).toHaveLength(3);
  });

  test("a cursor for an avatar the library does not have is NOT_FOUND, like a call without one", async () => {
    const { engine } = await startEngine(dir());
    const cursor = encodePhotoCursor("2026-09-24T11:00:00.000Z", "photo-0002");
    expect(failed(await engine.handle(command("photos.list", { avatarId: "avatar-00000404", cursor }))).error.code).toBe("NOT_FOUND");
  });
});
