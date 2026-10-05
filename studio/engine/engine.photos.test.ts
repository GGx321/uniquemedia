import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MAX_LISTED_PHOTOS, type PhotoSummary } from "../shared/engine";
import { manifestTraits } from "./avatars/records";
import { openLibrary } from "./library";
import { PNG_1X1, samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import { command, engineSettings, failed, GOOD, ok, startEngine, TRAITS, useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// T8b: photos.list, the Photos screen's gallery — an avatar's stored run
// photos, newest first. Against a real library in a temp dir; nothing here
// touches the network or spends money, so photos are seeded directly through
// the library, the way runJob.ts's photoMeta would leave them (a scene
// category, a resolution, an attemptId carrying the run's own id).

const dir = useEngineDir("studio-engine-photos-");

let seeded = 0;

/** A run photo's own NewPhotoMeta, as runJob.ts's photoMeta would build it. */
function runPhotoMeta(runId: string, slot: number, extra: Parameters<typeof samplePhotoMeta>[0] = {}) {
  return samplePhotoMeta({
    source: {
      kind: "generated",
      model: "x-ai/grok-imagine-image-2.0",
      provider: "openrouter",
      jobId: "job-0001",
      attemptId: `${runId}:slot-${slot}#1`,
      promptSha: "a".repeat(64),
      prompt: "A friend catches her mid-laugh at the kitchen counter.",
      slot: `slot-${slot}`,
      category: "home",
      costMicros: 50_000,
    },
    ...extra,
  });
}

/** How many plain photo files are written at once when seeding. */
const SEED_CHUNK = 50;

/** A saved avatar (active by default), with `count` run photos already stored, oldest first. */
async function seedAvatar(opts: { count?: number; status?: "active" | "draft" | "archived"; runId?: string } = {}): Promise<{ avatarId: string; photoIds: string[] }> {
  const count = opts.count ?? 0;
  const runId = opts.runId ?? "run-00000001";
  const { library } = await openLibrary(join(dir(), "library"), { now: steppingClock(), newId: sequentialIds(`seed${++seeded}`) });
  const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
  if (opts.status !== "draft") {
    const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ qa: { age: { adult: true, confidence: 0.95 } } }));
    await library.updateAvatar(avatar.id, { status: opts.status ?? "active", masterPhotoId: master.id });
  }
  // The first run photo goes through the library (its real record is the template); the rest are written as plain files, without
  // the library's fsync and rename per file. On Windows each durable add cost 10 to 25 ms, so the boundary test's 501 of them
  // took 9 to 13 s and once outlasted 30 s; the engine only READS these, so plain files of the same shape are what it meets.
  const photoIds: string[] = [];
  if (count > 0) {
    const first = await library.addPhoto(avatar.id, PNG_1X1, runPhotoMeta(runId, 1));
    photoIds.push(first.id);
    const photosDir = join(dir(), "library", "avatars", avatar.id, "photos");
    const rest = Array.from({ length: count - 1 }, (_unused, k) => {
      const n = k + 2;
      const id = `bulk${seeded}-${String(n).padStart(5, "0")}`;
      const sidecar = { ...first, id, file: `${id}.png`, source: runPhotoMeta(runId, n).source, createdAt: new Date(Date.parse(first.createdAt) + n * 1000).toISOString() };
      photoIds.push(id);
      return { id, sidecar };
    });
    for (let from = 0; from < rest.length; from += SEED_CHUNK) {
      await Promise.all(
        rest.slice(from, from + SEED_CHUNK).map(async ({ id, sidecar }) => {
          await writeFile(join(photosDir, `${id}.png`), PNG_1X1);
          await writeFile(join(photosDir, `${id}.json`), `${JSON.stringify(sidecar, null, 2)}\n`);
        }),
      );
    }
  }
  return { avatarId: avatar.id, photoIds };
}

function listed(response: Parameters<typeof ok>[0]): PhotoSummary[] {
  const answer = ok(response);
  if (answer.type !== "photos.list") throw new Error(`expected a photos.list answer, got ${answer.type}`);
  return answer.result.photos;
}

function skippedTotalOf(response: Parameters<typeof ok>[0]): number {
  const answer = ok(response);
  if (answer.type !== "photos.list") throw new Error(`expected a photos.list answer, got ${answer.type}`);
  return answer.result.skippedTotal;
}

describe("photos.list", () => {
  test("is NOT_FOUND for an avatar id the library does not have at all", async () => {
    const { engine } = await startEngine(dir());
    expect(failed(await engine.handle(command("photos.list", { avatarId: "avatar-00000404" }))).error.code).toBe("NOT_FOUND");
  });

  test("an avatar with no run photos gets an empty list, not NOT_FOUND", async () => {
    const { avatarId } = await seedAvatar({ count: 0 });
    const { engine } = await startEngine(dir());
    expect(listed(await engine.handle(command("photos.list", { avatarId })))).toEqual([]);
  });

  test("a draft avatar (candidates only, no run photos) gets an empty list, not NOT_FOUND", async () => {
    const { avatarId } = await seedAvatar({ count: 0, status: "draft" });
    const { engine } = await startEngine(dir());
    expect(listed(await engine.handle(command("photos.list", { avatarId })))).toEqual([]);
  });

  test("an archived avatar still gets its photos: only a missing avatarId is NOT_FOUND, like avatars.list already lists archived avatars normally", async () => {
    const { avatarId, photoIds } = await seedAvatar({ count: 2, status: "archived" });
    const { engine } = await startEngine(dir());
    const photos = listed(await engine.handle(command("photos.list", { avatarId })));
    expect(photos.map((p) => p.photoId).sort()).toEqual([...photoIds].sort());
  });

  test("lists newest first", async () => {
    const { avatarId, photoIds } = await seedAvatar({ count: 3 });
    const { engine } = await startEngine(dir());
    const photos = listed(await engine.handle(command("photos.list", { avatarId })));
    expect(photos.map((p) => p.photoId)).toEqual([...photoIds].reverse());
  });

  // AvatarSummary.photoCount is the gallery's own count: the master, candidates and imports are not gallery photos.
  test("avatars.list counts the gallery's photos: the master portrait is not one of them", async () => {
    const { avatarId } = await seedAvatar({ count: 3 });
    const { engine } = await startEngine(dir());
    const answer = ok(await engine.handle(command("avatars.list", {})));
    if (answer.type !== "avatars.list") throw new Error(`expected avatars.list, got ${answer.type}`);
    expect(answer.result.avatars.find((a) => a.avatarId === avatarId)?.photoCount).toBe(3);
  });

  test("an avatar with only its master portrait has a photoCount of 0", async () => {
    const { avatarId } = await seedAvatar({ count: 0 });
    const { engine } = await startEngine(dir());
    const answer = ok(await engine.handle(command("avatars.list", {})));
    if (answer.type !== "avatars.list") throw new Error(`expected avatars.list, got ${answer.type}`);
    expect(answer.result.avatars.find((a) => a.avatarId === avatarId)?.photoCount).toBe(0);
  });

  test("photoCount agrees with the gallery: listed photos plus the skipped ones", async () => {
    const { avatarId, photoIds } = await seedAvatar({ count: 3 });
    const sidecarPath = join(dir(), "library", "avatars", avatarId, "photos", `${photoIds[0]}.json`);
    const sidecar = JSON.parse(await readFile(sidecarPath, "utf8")) as { source: { category: string } };
    sidecar.source.category = "retired-category";
    await writeFile(sidecarPath, JSON.stringify(sidecar));
    const { engine } = await startEngine(dir());

    const gallery = await engine.handle(command("photos.list", { avatarId }));
    const answer = ok(await engine.handle(command("avatars.list", {})));
    if (answer.type !== "avatars.list") throw new Error(`expected avatars.list, got ${answer.type}`);
    expect(answer.result.avatars.find((a) => a.avatarId === avatarId)?.photoCount).toBe(listed(gallery).length + skippedTotalOf(gallery));
  });

  test("skippedTotal is 0 when nothing was skipped", async () => {
    const { avatarId } = await seedAvatar({ count: 2 });
    const { engine } = await startEngine(dir());
    expect(skippedTotalOf(await engine.handle(command("photos.list", { avatarId })))).toBe(0);
  });

  test("each photo carries its run and category", async () => {
    const { avatarId } = await seedAvatar({ count: 1, runId: "run-00000042" });
    const { engine } = await startEngine(dir());
    const [photo] = listed(await engine.handle(command("photos.list", { avatarId })));
    expect(photo).toMatchObject({ runId: "run-00000042", category: "home" });
  });

  test("a legacy sidecar that still carries a resolution (2K removed, 2026-09-29) lists, and the summary has none", async () => {
    const { avatarId, photoIds } = await seedAvatar({ count: 1 });
    const sidecarPath = join(dir(), "library", "avatars", avatarId, "photos", `${photoIds[0]}.json`);
    const sidecar: unknown = JSON.parse(await readFile(sidecarPath, "utf8"));
    await writeFile(sidecarPath, JSON.stringify({ ...(typeof sidecar === "object" && sidecar !== null ? sidecar : {}), resolution: "2k", width: 1584, height: 2816 }));

    const { engine } = await startEngine(dir());
    const photos = listed(await engine.handle(command("photos.list", { avatarId })));
    expect(photos.map((p) => p.photoId)).toEqual([photoIds[0]]);
    expect("resolution" in (photos[0] ?? {})).toBe(false);
  });

  test("a custom-category photo lists with the name its sidecar kept, beside a built-in one, and nothing is skipped (CS.1)", async () => {
    const { avatarId, photoIds } = await seedAvatar({ count: 2 });
    const sidecarPath = join(dir(), "library", "avatars", avatarId, "photos", `${photoIds[0]}.json`);
    const sidecar = JSON.parse(await readFile(sidecarPath, "utf8")) as { source: { category: string; categoryLabel?: string } };
    sidecar.source.category = "cat-paris-cafes";
    sidecar.source.categoryLabel = "Кофейни Парижа";
    await writeFile(sidecarPath, JSON.stringify(sidecar));

    const { engine } = await startEngine(dir());
    const response = await engine.handle(command("photos.list", { avatarId }));
    const photos = listed(response);
    expect(photos.find((p) => p.photoId === photoIds[0])).toMatchObject({ category: "cat-paris-cafes", categoryLabel: "Кофейни Парижа" });
    expect(photos.find((p) => p.photoId === photoIds[1])).toMatchObject({ category: "home" });
    expect("categoryLabel" in (photos.find((p) => p.photoId === photoIds[1]) ?? {})).toBe(false);
    expect(skippedTotalOf(response)).toBe(0);
  });

  test("a corrupt sidecar (a category the contract no longer recognises) is skipped, not a failure of the whole list, and counted in skippedTotal", async () => {
    const { avatarId, photoIds } = await seedAvatar({ count: 2 });
    const sidecarPath = join(dir(), "library", "avatars", avatarId, "photos", `${photoIds[0]}.json`);
    const sidecar = JSON.parse(await readFile(sidecarPath, "utf8")) as { source: { category: string } };
    sidecar.source.category = "retired-category";
    await writeFile(sidecarPath, JSON.stringify(sidecar));

    const { engine } = await startEngine(dir());
    const response = await engine.handle(command("photos.list", { avatarId }));
    expect(listed(response).map((p) => p.photoId)).toEqual([photoIds[1]]);
    expect(skippedTotalOf(response)).toBe(1);
  });

  test(`the limit boundary: bounded at ${MAX_LISTED_PHOTOS}, keeping the newest`, async () => {
    const { avatarId, photoIds } = await seedAvatar({ count: MAX_LISTED_PHOTOS + 1 });
    const { engine } = await startEngine(dir());
    const photos = listed(await engine.handle(command("photos.list", { avatarId })));
    expect(photos).toHaveLength(MAX_LISTED_PHOTOS);
    expect(photos.map((p) => p.photoId)).not.toContain(photoIds[0]);
    expect(photos[0]?.photoId).toBe(photoIds.at(-1) ?? "");
  }, 30_000);
});
