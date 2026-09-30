import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EngineError } from "../shared/engine";
import { MontageDraft, type Montage } from "../shared/engine/montage";
import { defaultSpec } from "../shared/montage";
import { manifestTraits } from "./avatars/records";
import { openLibrary } from "./library";
import { PNG_1X1, samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import { command, engineSettings, failed, GOOD, jobEnd, ok, startEngine, TRAITS, until, useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// The montage drafts through the engine (3d.1a): every command as main sends it, parsed by the contract both ways, with the
// events a window would see, over a real library on disk. The render of a saved draft runs the real ffmpeg, like
// engine.videos.test.ts.

const dir = useEngineDir("studio-engine-montages-");
const exportDir = () => join(dir(), "export");
const draftsDir = (avatarId: string) => join(dir(), "library", "avatars", avatarId, "montages");
const FIXTURES = join(import.meta.dir, "face/fixtures/images");
const PHOTO_FILES = ["render-best-home-1.jpg", "render-median-travel-2.jpg", "render-worst-fitness-3.jpg"];
const REAL_RENDER_TIMEOUT_MS = 90_000;

const settingsOf = () => engineSettings(dir(), { renderConcurrency: 1 });

/** An avatar with a master and three real scene photos (and `extra` tiny ones), seeded before the engine opens the library. */
async function seedAvatar(extra = 0): Promise<{ avatarId: string; photoIds: string[] }> {
  const { library } = await openLibrary(join(dir(), "library"), { now: steppingClock(), newId: sequentialIds("mon") });
  const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
  const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  const base = samplePhotoMeta().source;
  if (base.kind !== "generated") throw new Error("expected a generated sample source");
  const photoIds: string[] = [];
  for (const [i, file] of PHOTO_FILES.entries()) {
    const bytes = new Uint8Array(readFileSync(join(FIXTURES, file)));
    const photo = await library.addPhoto(avatar.id, bytes, samplePhotoMeta({ mediaType: "image/jpeg", width: 720, height: 1280, source: { ...base, category: "home", attemptId: `run-00000001:slot-${i + 1}#1`, slot: `slot-${i + 1}` }, qa: { age: { adult: true, confidence: 0.95 } } }));
    photoIds.push(photo.id);
  }
  for (let i = 0; i < extra; i++) {
    const photo = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ source: { ...base, category: "home", attemptId: `run-00000002:slot-${i + 1}#1`, slot: `slot-${i + 1}` } }));
    photoIds.push(photo.id);
  }
  return { avatarId: avatar.id, photoIds };
}

type Started = Awaited<ReturnType<typeof startEngine>>;

const start = (over: Parameters<typeof startEngine>[1] = {}): Promise<Started> =>
  startEngine(dir(), { ...over, init: { renderTmpDir: join(dir(), "userData", "render-tmp"), settings: settingsOf(), ...over.init }, deps: { ...over.deps } });

const scene = (photoId: string) => ({ source: "scene" as const, photoId });

async function answer(engine: Started["engine"], type: string, payload: unknown): Promise<Record<string, unknown>> {
  const done = ok(await engine.handle(command(type, payload)));
  if (done.type !== type) throw new Error(`expected ${type}, got ${done.type}`);
  return done.result as Record<string, unknown>;
}

async function create(engine: Started["engine"], avatarId: string, photoIds: string[]): Promise<Montage> {
  const result = await answer(engine, "montages.create", { avatarId, photoIds });
  return result.montage as Montage;
}

async function refusal(engine: Started["engine"], type: string, payload: unknown): Promise<EngineError> {
  return failed(await engine.handle(command(type, payload))).error;
}

const draftEvents = (events: Started["events"]) => events().flatMap((e) => (e.type === "montage.changed" ? [e.payload] : []));

describe("the draft lifecycle through the engine", () => {
  test("create, get, list, save and delete: each answers as the contract says, and each change is announced", async () => {
    const { avatarId } = await seedAvatar();
    const { engine, events } = await start();

    const created = await create(engine, avatarId, []);
    expect(created).toMatchObject({ name: null, spec: { avatarId, clips: [] } });
    const got = (await answer(engine, "montages.get", { montageId: created.montageId })) as { montage: Montage; issues: unknown[] };
    expect(got.montage).toEqual(created);
    expect(got.issues).toEqual([{ code: "no-clips", path: ["clips"] }]);

    const saved = (await answer(engine, "montages.save", { montageId: created.montageId, spec: { ...created.spec, seed: 99 }, name: "Кафе и город" })) as { montage: Montage };
    expect(saved.montage).toMatchObject({ montageId: created.montageId, name: "Кафе и город", spec: { seed: 99 } });

    const listed = (await answer(engine, "montages.list", { avatarId })) as { items: { montage: Montage; issues: unknown[]; videoCount: number }[]; total: number; skippedTotal: number };
    expect(listed.total).toBe(1);
    expect(listed.items[0]).toMatchObject({ montage: { montageId: created.montageId, name: "Кафе и город" }, videoCount: 0 });

    expect(await answer(engine, "montages.delete", { montageId: created.montageId })).toEqual({ montageId: created.montageId });
    expect((await refusal(engine, "montages.get", { montageId: created.montageId })).code).toBe("NOT_FOUND");
    expect(draftEvents(events)).toEqual([
      { change: "upserted", montage: created },
      { change: "upserted", montage: saved.montage },
      { change: "removed", montageId: created.montageId, avatarId },
    ]);
  });

  test("a draft is a file under its avatar's folder, and survives an engine restart", async () => {
    const { avatarId } = await seedAvatar();
    const first = await start();
    const created = await create(first.engine, avatarId, []);
    expect(await readdir(draftsDir(avatarId))).toEqual([`${created.montageId}.json`]);

    const second = await start();
    const got = (await answer(second.engine, "montages.get", { montageId: created.montageId })) as { montage: Montage };

    expect(got.montage).toEqual(created);
  });

  test("the announcements are in the engine's event log: a window that reconnects catches up on them", async () => {
    const { avatarId } = await seedAvatar();
    const { engine } = await start();
    const created = await create(engine, avatarId, []);

    const since = ok(await engine.handle(command("engine.events", { afterSeq: 0, bootId: "boot-0000-aaaa" })));

    const kinds = since.type === "engine.events" && !since.result.gap ? since.result.events.map((e) => e.type) : [];
    expect(kinds).toContain("montage.changed");
    void created;
  });
});

describe("montages.create through the engine", () => {
  test("a photo's focus comes from the resolver, and the draft answered is the draft stored", async () => {
    const { avatarId, photoIds } = await seedAvatar();
    const { engine } = await start({ deps: { montages: { focus: () => ({ focusFor: async () => ({ focus: { x: 0.3, y: 0.2 }, resolved: true }) }) } } });

    const created = await create(engine, avatarId, photoIds.slice(0, 2));

    expect(created.spec.clips[0]).toMatchObject({ kind: "collage", cells: [{ focus: { x: 0.3, y: 0.2 } }, { focus: { x: 0.3, y: 0.2 } }] });
    const stored = JSON.parse(await readFile(join(draftsDir(avatarId), `${created.montageId}.json`), "utf8"));
    expect(MontageDraft.safeParse(stored.spec).success).toBe(true);
    expect(stored.spec).toEqual(created.spec);
  });

  test("with no face models the real resolver judges nothing: every focus is null, and the log says how many, with no path", async () => {
    const { avatarId, photoIds } = await seedAvatar();
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { engine } = await start();

      const created = await create(engine, avatarId, photoIds.slice(0, 3));

      const [clip] = created.spec.clips;
      expect(clip?.kind === "collage" ? clip.cells.map((cell) => cell.focus) : null).toEqual([null, null, null]);
      const said = warn.mock.calls.map((call) => String(call[0])).join("\n");
      expect(said).toMatch(/3 of 3 photo/);
      expect(said).not.toContain(dir());
    } finally {
      warn.mockRestore();
    }
  });

  test("a detector that never answers costs create its budget, not main's whole deadline, and the draft is stored with null focus", async () => {
    const { avatarId, photoIds } = await seedAvatar();
    const { engine } = await start({ deps: { montages: { focus: () => ({ focusFor: () => new Promise<never>(() => undefined) }), focusBudgetMs: 80 } } });
    const started = Date.now();

    const created = await create(engine, avatarId, photoIds);

    expect(Date.now() - started).toBeLessThan(3_000);
    expect(created.spec.clips.length).toBeGreaterThan(0);
    expect((await readdir(draftsDir(avatarId))).length).toBe(1);
  });

  test("20 photos are 20 slides; the 21st is refused by the contract before the engine looks at anything", async () => {
    const { avatarId, photoIds } = await seedAvatar(18); // 3 + 18 = 21 scene photos
    const { engine } = await start();

    const twenty = await create(engine, avatarId, photoIds.slice(0, 20));
    expect(twenty.spec.clips).toHaveLength(20);

    const error = await refusal(engine, "montages.create", { avatarId, photoIds });
    expect(error.code).toBe("VALIDATION");
    expect((await readdir(draftsDir(avatarId))).length).toBe(1);
  });

  test("a photo the owner rejected is refused at its index, in the shape the contract gives the window", async () => {
    const { avatarId, photoIds } = await seedAvatar();
    const { engine } = await start();
    ok(await engine.handle(command("photos.setRejected", { avatarId, photoId: photoIds[1], rejected: true })));

    const error = await refusal(engine, "montages.create", { avatarId, photoIds: [photoIds[0], photoIds[1]] });

    expect(error).toMatchObject({ code: "PHOTO_UNAVAILABLE", issues: [{ code: "photo-unavailable", path: ["photoIds", 1] }] });
    await expect(readdir(draftsDir(avatarId))).rejects.toThrow();
  });

  test("a repeated photo is refused by the contract", async () => {
    const { avatarId, photoIds } = await seedAvatar();
    const { engine } = await start();

    expect((await refusal(engine, "montages.create", { avatarId, photoIds: [photoIds[0], photoIds[0]] })).code).toBe("VALIDATION");
  });

  test("an avatar the library does not have is NOT_FOUND", async () => {
    await seedAvatar();
    const { engine } = await start();

    expect((await refusal(engine, "montages.create", { avatarId: "avatar-nobody-1", photoIds: [] })).code).toBe("NOT_FOUND");
  });
});

describe("montages.save and get through the engine", () => {
  test("a spec that breaks the draft's structure is VALIDATION, and the stored draft is unchanged", async () => {
    const { avatarId, photoIds } = await seedAvatar();
    const { engine } = await start();
    const created = await create(engine, avatarId, [photoIds[0] ?? ""]);
    const [clip] = created.spec.clips;
    const twice = { ...created.spec, clips: [clip, { ...clip, clipId: "clip-002" }] };

    const error = await refusal(engine, "montages.save", { montageId: created.montageId, spec: twice, name: null });

    expect(error.code).toBe("VALIDATION");
    const got = (await answer(engine, "montages.get", { montageId: created.montageId })) as { montage: Montage };
    expect(got.montage).toEqual(created);
  });

  test("a spec of another avatar is VALIDATION", async () => {
    const { avatarId } = await seedAvatar();
    const { engine } = await start();
    const created = await create(engine, avatarId, []);

    const error = await refusal(engine, "montages.save", { montageId: created.montageId, spec: defaultSpec("avatar-other-01", [], 1), name: null });

    expect(error.code).toBe("VALIDATION");
  });

  test("a draft may be saved with a photo that was rejected, and get then names it", async () => {
    const { avatarId, photoIds } = await seedAvatar();
    const { engine } = await start();
    const created = await create(engine, avatarId, [photoIds[0] ?? ""]);
    ok(await engine.handle(command("photos.setRejected", { avatarId, photoId: photoIds[0], rejected: true })));

    ok(await engine.handle(command("montages.save", { montageId: created.montageId, spec: { ...created.spec, seed: 5 }, name: null })));
    const got = (await answer(engine, "montages.get", { montageId: created.montageId })) as { issues: unknown[] };

    expect(got.issues).toEqual([{ code: "photo-unavailable", path: ["clips", 0, "cell"] }]);
  });

  test("twenty saves at once through the engine: the last one asked is the one stored", async () => {
    const { avatarId } = await seedAvatar();
    const { engine } = await start();
    const created = await create(engine, avatarId, []);

    const answers = await Promise.all(Array.from({ length: 20 }, (_, n) => engine.handle(command("montages.save", { montageId: created.montageId, spec: { ...created.spec, seed: n }, name: `save-${n}` }))));

    expect(answers.every((a) => a.ok)).toBe(true);
    const got = (await answer(engine, "montages.get", { montageId: created.montageId })) as { montage: Montage };
    expect(got.montage).toMatchObject({ name: "save-19", spec: { seed: 19 } });
    expect((await readdir(draftsDir(avatarId))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("a save racing a delete: never a draft left behind by the save", async () => {
    const { avatarId } = await seedAvatar();
    const { engine } = await start();
    const created = await create(engine, avatarId, []);

    const [deleted, saved] = await Promise.all([
      engine.handle(command("montages.delete", { montageId: created.montageId })),
      engine.handle(command("montages.save", { montageId: created.montageId, spec: created.spec, name: "ghost" })),
    ]);

    expect(deleted.ok).toBe(true);
    expect(!saved.ok && saved.error.code).toBe("NOT_FOUND");
    expect(await readdir(draftsDir(avatarId))).toEqual([]);
  });

  test("a torn draft file is left out of the list and counted, and get says it cannot be read", async () => {
    const { avatarId } = await seedAvatar();
    const { engine } = await start();
    const created = await create(engine, avatarId, []);
    await writeFile(join(draftsDir(avatarId), "montage-torn-0001.json"), '{ "schemaVersion": 1, "montageId"');

    const listed = (await answer(engine, "montages.list", {})) as { items: unknown[]; total: number; skippedTotal: number };

    expect(listed).toMatchObject({ total: 1, skippedTotal: 1 });
    expect(listed.items).toHaveLength(1);
    expect((await refusal(engine, "montages.get", { montageId: "montage-torn-0001" })).code).toBe("INTERNAL");
    void created;
  });
});

describe("montages.focus through the engine", () => {
  test("answers the resolver's point, or null when nothing was judged", async () => {
    const { avatarId, photoIds } = await seedAvatar();
    const judged = await start({ deps: { montages: { focus: () => ({ focusFor: async () => ({ focus: { x: 0.6, y: 0.25 }, resolved: true }) }) } } });
    const unjudged = await start();

    expect(await answer(judged.engine, "montages.focus", { avatarId, photo: scene(photoIds[0] ?? "") })).toEqual({ focus: { x: 0.6, y: 0.25 } });
    expect(await answer(unjudged.engine, "montages.focus", { avatarId, photo: scene(photoIds[0] ?? "") })).toEqual({ focus: null });
  });

  test("refuses a photo that is not the avatar's to use", async () => {
    const { avatarId } = await seedAvatar();
    const { engine } = await start();

    const error = await refusal(engine, "montages.focus", { avatarId, photo: scene("photo-nobody-1") });

    expect(error).toMatchObject({ code: "PHOTO_UNAVAILABLE", issues: [{ code: "photo-unavailable", path: ["photo"] }] });
  });
});

describe("rendering a saved draft through the engine", () => {
  /** A draft of two 2 s static clips over the first two photos: the shortest complete montage the real ffmpeg renders quickly. */
  async function twoClipDraft(engine: Started["engine"], avatarId: string, photoIds: string[]): Promise<Montage> {
    const created = await create(engine, avatarId, []);
    const clips = photoIds.slice(0, 2).map((photoId, i) => ({ clipId: `clip-0000000${i + 1}`, kind: "photo", cell: { photo: scene(photoId), focus: null }, motion: "static", durationMs: 2_000, transitionIn: "cut" }));
    const saved = (await answer(engine, "montages.save", { montageId: created.montageId, spec: { ...created.spec, clips }, name: "Кафе и город" })) as { montage: Montage };
    return saved.montage;
  }

  test(
    "renders the draft, and the video, the draft's list entry and the photos all follow; deleting the draft leaves the video and unlinks it",
    async () => {
      await mkdir(exportDir());
      const { avatarId, photoIds } = await seedAvatar();
      const { engine, events } = await start();
      await engine.settled();
      const draft = await twoClipDraft(engine, avatarId, photoIds);

      const rendered = (await answer(engine, "videos.render", { montageId: draft.montageId })) as { jobId: string; videoId: string };
      expect((await jobEnd(events, rendered.jobId)).type).toBe("job.done");

      const [video] = ((await answer(engine, "videos.list", { avatarId })) as { videos: { videoId: string; montageId: string | null }[] }).videos;
      expect(video).toMatchObject({ videoId: rendered.videoId, montageId: draft.montageId });
      const listed = (await answer(engine, "montages.list", { avatarId })) as { items: { videoCount: number; issues: { code: string }[] }[] };
      expect(listed.items[0]?.videoCount).toBe(1);
      // its photos are in a video now: one photo, one video
      expect(listed.items[0]?.issues.map((i) => i.code)).toEqual(["photo-unavailable", "photo-unavailable"]);
      expect((await refusal(engine, "videos.render", { montageId: draft.montageId })).code).toBe("PHOTO_UNAVAILABLE");

      ok(await engine.handle(command("montages.delete", { montageId: draft.montageId })));
      const [after] = ((await answer(engine, "videos.list", { avatarId })) as { videos: { montageId: string | null }[] }).videos;
      expect(after?.montageId).toBeNull();
    },
    REAL_RENDER_TIMEOUT_MS,
  );

  test(
    "a draft deleted while its render runs: the job finishes, and the video's record and event name no draft",
    async () => {
      await mkdir(exportDir());
      const { avatarId, photoIds } = await seedAvatar();
      const { engine, events } = await start();
      await engine.settled();
      const draft = await twoClipDraft(engine, avatarId, photoIds);
      const rendered = (await answer(engine, "videos.render", { montageId: draft.montageId })) as { jobId: string; videoId: string };

      ok(await engine.handle(command("montages.delete", { montageId: draft.montageId }))); // right after the job was queued

      expect((await jobEnd(events, rendered.jobId)).type).toBe("job.done");
      await until(() => events().some((e) => e.type === "video.changed"), "the video's announcement");
      const upserted = events().flatMap((e) => (e.type === "video.changed" && e.payload.change === "upserted" ? [e.payload.video] : []));
      expect(upserted).toHaveLength(1);
      expect(upserted[0]).toMatchObject({ videoId: rendered.videoId, montageId: null });
      const [video] = ((await answer(engine, "videos.list", { avatarId })) as { videos: { montageId: string | null }[] }).videos;
      expect(video?.montageId).toBeNull();
      // the job itself was queued from the draft, so its own events say so
      const progress = events().flatMap((e) => (e.type === "job.progress" && e.payload.kind === "render" ? [e.payload.montageId] : []));
      expect(progress.length).toBeGreaterThan(0);
      expect(progress.every((id) => id === draft.montageId)).toBe(true);
    },
    REAL_RENDER_TIMEOUT_MS,
  );
});
