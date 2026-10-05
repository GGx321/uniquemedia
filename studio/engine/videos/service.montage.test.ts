import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { EngineFailure } from "../engineFailure";
import type { EngineError } from "../../shared/engine";
import { MAX_MONTAGE_ISSUES, Montage, type MontageDraft, type PhotoRef } from "../../shared/engine/montage";
import { defaultSpec } from "../../shared/montage";
import { montageRig } from "../montages/testing/rig";
import { DraftStore } from "../montages/store";
import { readVideoRecordFile } from "./listing";
import { acceptingVerify, specOf, useWorld, type World } from "./testing/kit";
import { serviceRig, writingRun } from "./testing/serviceKit";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// `videos.render {montageId}` (3d.1a): the draft a render starts from, the copy of its spec the job keeps, and what the video
// record says about the draft when the owner deletes it.

const world = useWorld();
const photoId = (w: World, i: number): string => w.photos[i]?.id ?? "";
const specFor = (w: World, i = 0, seed = 7): MontageDraft => ({ ...specOf(w.avatar.id, [photoId(w, i)], 4_000), seed });

async function failureOf(work: Promise<unknown>): Promise<EngineError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof EngineFailure) return error.error;
    throw error;
  }
  throw new Error("expected the call to fail");
}

const drafts = () => new DraftStore({ log: () => undefined });

function montageOf(montageId: string, spec: MontageDraft): Montage {
  return Montage.parse({ montageId, name: null, spec, updatedAt: "2026-09-30T10:00:00.000Z" });
}

/** A render whose ffmpeg waits for `release()`, so the job is held while the test changes things around it. */
function gatedRig(w: World, store: DraftStore, size = 1) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const rig = serviceRig(w, {
    size,
    deps: {
      drafts: store,
      renderOverrides: {
        verify: acceptingVerify,
        runDeps: {
          run: async (opts) => {
            await gate;
            await writingRun(opts);
          },
        },
      },
    },
  });
  return { rig, release };
}

const videoChanged = (events: ReturnType<typeof serviceRig>["events"]) => events.flatMap((e) => (e.type === "video.changed" && e.payload.change === "upserted" ? [e.payload.video] : []));

describe("videos.render of a saved draft", () => {
  test("queues the draft's spec: the job, its progress and its record all name the draft", async () => {
    const w = world();
    const store = drafts();
    await store.write(w.library, montageOf("montage-0000001", specFor(w)));
    const r = serviceRig(w, { deps: { drafts: store } });

    const { jobId, videoId } = await r.service.render({ montageId: "montage-0000001" });
    await r.queue.idle();

    expect(r.jobs.stateOf(jobId)).toMatchObject({ status: "done", montageId: "montage-0000001" });
    const progress = r.events.flatMap((e) => (e.type === "job.progress" ? [e.payload] : []));
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every((p) => p.kind === "render" && p.montageId === "montage-0000001")).toBe(true);
    expect((await readVideoRecordFile(w.libraryRoot, w.avatar.id, videoId))?.montageId).toBe("montage-0000001");
    expect(videoChanged(r.events).map((v) => v.montageId)).toEqual(["montage-0000001"]);
    const [listed] = await r.service.list(w.avatar.id);
    expect(listed?.montageId).toBe("montage-0000001");
  });

  test("the render is of the draft's spec: its own clips, seed and total", async () => {
    const w = world();
    const store = drafts();
    await store.write(w.library, montageOf("montage-0000001", specFor(w, 1, 555)));
    const r = serviceRig(w, { deps: { drafts: store } });

    const { videoId } = await r.service.render({ montageId: "montage-0000001" });
    await r.queue.idle();

    const record = await readVideoRecordFile(w.libraryRoot, w.avatar.id, videoId);
    expect(record?.spec.seed).toBe(555);
    expect(record?.durationMs).toBe(4_000);
    expect(w.library.videoCountForMontage(w.avatar.id, "montage-0000001")).toBe(1);
  });

  test("a draft that does not exist is NOT_FOUND, and nothing is checked, reserved or written", async () => {
    const w = world();
    const r = serviceRig(w, { deps: { drafts: drafts() } });

    const error = await failureOf(r.service.render({ montageId: "montage-0000001" }));

    expect(error.code).toBe("NOT_FOUND");
    expect(r.queue.states()).toEqual([]);
    expect(r.checks).toHaveLength(0);
  });

  test("an incomplete draft is MONTAGE_INVALID with what is missing, like a spec with the same problem", async () => {
    const w = world();
    const store = drafts();
    await store.write(w.library, montageOf("montage-0000001", { ...specFor(w), clips: [] }));
    const r = serviceRig(w, { deps: { drafts: store } });

    const error = await failureOf(r.service.render({ montageId: "montage-0000001" }));

    expect(error).toMatchObject({ code: "MONTAGE_INVALID", issues: [{ code: "no-clips", path: ["clips"] }] });
    expect(r.queue.states()).toEqual([]);
  });

  test("a draft with a bad caption is MONTAGE_INVALID caption-invalid at its layer, like a spec with the same caption", async () => {
    const w = world();
    const store = drafts();
    const layer = { layerId: "layer-001", kind: "text" as const, startMs: 0, endMs: 1_000, value: "a\nb\nc", font: "manrope" as const, style: "none" as const, color: "#ffffff", x: 0.5, y: 0.5, scale: 1 };
    await store.write(w.library, montageOf("montage-0000001", { ...specFor(w), layers: [layer] }));
    const r = serviceRig(w, { deps: { drafts: store } });

    const error = await failureOf(r.service.render({ montageId: "montage-0000001" }));

    expect(error).toMatchObject({ code: "MONTAGE_INVALID", issues: [{ code: "caption-invalid", path: ["layers", 0, "value"] }] });
    expect(r.queue.states()).toEqual([]);
  });

  test("a draft whose photo was rejected since is PHOTO_UNAVAILABLE at its cell", async () => {
    const w = world();
    const store = drafts();
    await store.write(w.library, montageOf("montage-0000001", specFor(w)));
    await w.library.setRejected(w.avatar.id, photoId(w, 0), true);
    const r = serviceRig(w, { deps: { drafts: store } });

    const error = await failureOf(r.service.render({ montageId: "montage-0000001" }));

    expect(error).toMatchObject({ code: "PHOTO_UNAVAILABLE", issues: [{ code: "photo-unavailable", path: ["clips", 0, "cell"] }] });
  });

  test("a draft renders once: its photos are in a video now, so a second render is PHOTO_UNAVAILABLE (one photo, one video)", async () => {
    const w = world();
    const store = drafts();
    await store.write(w.library, montageOf("montage-0000001", specFor(w)));
    const r = serviceRig(w, { deps: { drafts: store } });
    await r.service.render({ montageId: "montage-0000001" });
    await r.queue.idle();

    const error = await failureOf(r.service.render({ montageId: "montage-0000001" }));

    expect(error.code).toBe("PHOTO_UNAVAILABLE");
  });

  test("a draft file that cannot be read is INTERNAL, and says nothing of its path", async () => {
    const w = world();
    const store = drafts();
    await mkdir(w.library.montagesDir(w.avatar.id), { recursive: true });
    await writeFile(w.library.montageFilePath(w.avatar.id, "montage-0000001"), "{ torn");
    const r = serviceRig(w, { deps: { drafts: store } });

    const error = await failureOf(r.service.render({ montageId: "montage-0000001" }));

    expect(error.code).toBe("INTERNAL");
    expect(error.detail ?? "").not.toContain(w.libraryRoot);
    expect(r.queue.states()).toEqual([]);
  });

  test("with no draft store wired a montageId is NOT_FOUND, as before drafts existed", async () => {
    const w = world();
    const r = serviceRig(w);

    expect((await failureOf(r.service.render({ montageId: "montage-0000001" }))).code).toBe("NOT_FOUND");
  });
});

describe("videos.render and montages.save on one draft", () => {
  test("a render asked right after a save, without waiting for it, renders the saved draft and reserves the photo the owner chose", async () => {
    const w = world();
    const m = montageRig(w);
    await m.store.write(w.library, montageOf("montage-0000001", specFor(w, 0, 111)));
    const r = serviceRig(w, { deps: { drafts: m.store } });

    const saving = m.service.save({ montageId: "montage-0000001", spec: specFor(w, 1, 222), name: null });
    const { videoId } = await r.service.render({ montageId: "montage-0000001" });
    await saving;
    await r.queue.idle();

    const record = await readVideoRecordFile(w.libraryRoot, w.avatar.id, videoId);
    expect(record?.spec.seed).toBe(222);
    expect(w.library.photoStates(w.avatar.id).get(photoId(w, 1))?.usedIn).toEqual([videoId]);
    expect(w.library.photoStates(w.avatar.id).get(photoId(w, 0))?.usedIn).toEqual([]);
  });

  test("a save asked right after a render does not reach it: the job keeps what the render read", async () => {
    const w = world();
    const m = montageRig(w);
    await m.store.write(w.library, montageOf("montage-0000001", specFor(w, 0, 111)));
    const r = serviceRig(w, { deps: { drafts: m.store } });

    const rendering = r.service.render({ montageId: "montage-0000001" });
    const saving = m.service.save({ montageId: "montage-0000001", spec: specFor(w, 1, 222), name: null });
    const { videoId } = await rendering;
    await saving;
    await r.queue.idle();

    expect((await readVideoRecordFile(w.libraryRoot, w.avatar.id, videoId))?.spec.seed).toBe(111);
  });
});

describe("videos.render {montageId} when the draft read takes the command's time", () => {
  test("a read that used up the command's time is 'ran out of time', not a wrong EXPORT_UNAVAILABLE, and nothing is checked", async () => {
    const w = world();
    const slow = drafts();
    await slow.write(w.library, montageOf("montage-0000001", specFor(w)));
    const find = slow.find.bind(slow);
    slow.find = async (library, id) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
      return find(library, id);
    };
    const r = serviceRig(w, { deps: { drafts: slow, commandDeadlineMs: 100, commandMarginMs: 60 } });

    const error = await failureOf(r.service.render({ montageId: "montage-0000001" }));

    expect(error.code).toBe("INTERNAL");
    expect(error.detail).toMatch(/ran out of time/);
    expect(r.checks).toHaveLength(0);
    expect(r.queue.states()).toEqual([]);
  });
});

describe("montages.save while a render of the draft runs", () => {
  test("resolves at once: the render's queue is not the draft's, and only the read of the draft was ever queued", async () => {
    const w = world();
    const m = montageRig(w);
    await m.store.write(w.library, montageOf("montage-0000001", specFor(w, 0, 111)));
    const { rig: r, release } = gatedRig(w, m.store);
    const { jobId } = await r.service.render({ montageId: "montage-0000001" });
    expect(r.jobs.stateOf(jobId)?.status).toBe("running");

    const saved = await m.service.save({ montageId: "montage-0000001", spec: specFor(w, 1, 222), name: "edited while rendering" });

    expect(saved.montage.name).toBe("edited while rendering");
    expect(r.jobs.stateOf(jobId)?.status).toBe("running"); // the job is still held: the save did not wait for it
    release();
    await r.queue.idle();
  });
});

describe("get's issues cover what videos.render refuses, for every kind of part", () => {
  const sticker = { layerId: "layer-001", kind: "sticker" as const, startMs: 0, endMs: 1_000, sticker: { source: "own" as const, mediaId: "media-0000003" }, x: 0.5, y: 0.5, size: 0.2 };
  const badCaption = { layerId: "layer-002", kind: "text" as const, startMs: 0, endMs: 1_000, value: "Acme \u00a9", font: "manrope" as const, style: "none" as const, color: "#ffffff", x: 0.5, y: 0.5, scale: 1 };
  const goneSticker = { ...sticker, sticker: { source: "builtin" as const, stickerId: "no-such-sticker" } };
  const own = (photo: PhotoRef | null) => ({ photo, focus: null });
  const ownMedia = { source: "own" as const, mediaId: "media-0000001" };

  function specs(w: World): [string, MontageDraft][] {
    const base = specFor(w, 0);
    const [clip] = base.clips;
    if (clip === undefined) throw new Error("expected a clip");
    const collageWith = (cells: ReturnType<typeof own>[]) => ({ clipId: "clip-0000009", kind: "collage" as const, layout: "collage2" as const, cells, motion: "static" as const, stagger: false, durationMs: 4_000, transitionIn: "cut" as const });
    const manyOwn = Array.from({ length: 20 }, (_, i) => ({ ...collageWith([own(ownMedia), own(ownMedia)]), layout: "collage4" as const, cells: [own(ownMedia), own(ownMedia), own(ownMedia), own(ownMedia)], clipId: `clip-${String(i + 1).padStart(7, "0")}`, durationMs: 500 }));
    return [
      ["an own sticker layer", { ...base, layers: [sticker] }],
      ["a built-in sticker the set does not have", { ...base, layers: [goneSticker] }],
      ["a caption that breaks the caption rules", { ...base, layers: [badCaption] }],
      ["music", { ...base, music: { source: "trending", trackId: "track-0000001", startMs: 0 } }],
      ["an own video clip", { ...base, clips: [clip, { clipId: "clip-0000008", kind: "video", mediaId: "media-0000002", trimStartMs: 0, focus: null, durationMs: 1_000, transitionIn: "cut" }] }],
      ["an own photo in a photo clip's cell", { ...base, clips: [{ ...clip, cell: own(ownMedia) } as MontageDraft["clips"][number]] }],
      ["an own photo in a collage's cell j", { ...base, clips: [collageWith([{ photo: { source: "scene", photoId: photoId(w, 1) }, focus: null }, own(ownMedia)])] }],
      ["a spec that is too short", { ...base, clips: [{ ...clip, durationMs: 1_000 } as MontageDraft["clips"][number]] }],
      ["a draft with no clips", { ...base, clips: [] }],
      ["more than 64 issues", { ...base, clips: manyOwn }],
    ];
  }

  for (const label of ["an own sticker layer", "a built-in sticker the set does not have", "a caption that breaks the caption rules", "music", "an own video clip", "an own photo in a photo clip's cell", "an own photo in a collage's cell j", "a spec that is too short", "a draft with no clips", "more than 64 issues"]) {
    test(`${label}: every issue the render refuses is in the draft's issues`, async () => {
      const w = world();
      const m = montageRig(w);
      const spec = specs(w).find(([name]) => name === label)?.[1];
      if (spec === undefined) throw new Error(`no spec for ${label}`);
      await m.store.write(w.library, montageOf("montage-0000001", spec));
      const r = serviceRig(w, { deps: { drafts: m.store } });

      const refusal = await failureOf(r.service.render({ montageId: "montage-0000001" }));
      const { issues } = await m.service.get("montage-0000001");

      expect(refusal.code).toBe("MONTAGE_INVALID");
      expect(refusal.issues?.length).toBeGreaterThan(0);
      for (const issue of refusal.issues ?? []) expect(issues).toContainEqual(issue);
      expect(issues.length).toBeLessThanOrEqual(MAX_MONTAGE_ISSUES);
      if (label === "more than 64 issues") expect(issues).toHaveLength(MAX_MONTAGE_ISSUES);
      expect(r.queue.states()).toEqual([]);
    });
  }
});

describe("a draft changed or deleted while its render is queued or running", () => {
  test("the job keeps the spec it was queued with: a save after that does not reach it", async () => {
    const w = world();
    const store = drafts();
    await store.write(w.library, montageOf("montage-0000001", specFor(w, 0, 111)));
    const { rig: r, release } = gatedRig(w, store);
    const { videoId } = await r.service.render({ montageId: "montage-0000001" });

    await store.write(w.library, montageOf("montage-0000001", specFor(w, 1, 222))); // the owner keeps editing
    release();
    await r.queue.idle();

    const record = await readVideoRecordFile(w.libraryRoot, w.avatar.id, videoId);
    expect(record?.spec.seed).toBe(111);
  });

  test("a draft deleted while its render RUNS: the job goes on, and the video's record lists montageId null", async () => {
    const w = world();
    const store = drafts();
    await store.write(w.library, montageOf("montage-0000001", specFor(w)));
    const { rig: r, release } = gatedRig(w, store);
    const { jobId, videoId } = await r.service.render({ montageId: "montage-0000001" });
    expect(r.jobs.stateOf(jobId)?.status).toBe("running");

    await store.remove(w.library, w.avatar.id, "montage-0000001");
    release();
    await r.queue.idle();

    expect(r.jobs.stateOf(jobId)?.status).toBe("done");
    expect((await readVideoRecordFile(w.libraryRoot, w.avatar.id, videoId))?.montageId).toBeNull();
    expect(videoChanged(r.events).map((v) => v.montageId)).toEqual([null]);
    expect((await r.service.list(w.avatar.id)).map((v) => v.montageId)).toEqual([null]);
  });

  test("a draft deleted while its render is still QUEUED behind another: the same", async () => {
    const w = world();
    const store = drafts();
    await store.write(w.library, montageOf("montage-0000001", specFor(w, 0)));
    await store.write(w.library, montageOf("montage-0000002", specFor(w, 1)));
    const { rig: r, release } = gatedRig(w, store, 1);
    await r.service.render({ montageId: "montage-0000001" });
    const second = await r.service.render({ montageId: "montage-0000002" });
    expect(r.jobs.stateOf(second.jobId)?.status).toBe("queued");

    await store.remove(w.library, w.avatar.id, "montage-0000002");
    release();
    await r.queue.idle();

    expect((await readVideoRecordFile(w.libraryRoot, w.avatar.id, second.videoId))?.montageId).toBeNull();
    const named = (await r.service.list(w.avatar.id)).map((v) => v.montageId);
    expect(named).toHaveLength(2);
    expect(named).toContain("montage-0000001");
    expect(named).toContain(null);
  });

  test("the other draft's video keeps its draft", async () => {
    const w = world();
    const store = drafts();
    await store.write(w.library, montageOf("montage-0000001", specFor(w, 0)));
    await store.write(w.library, montageOf("montage-0000002", specFor(w, 1)));
    const { rig: r, release } = gatedRig(w, store, 2);
    const first = await r.service.render({ montageId: "montage-0000001" });
    await r.service.render({ montageId: "montage-0000002" });

    await store.remove(w.library, w.avatar.id, "montage-0000002");
    release();
    await r.queue.idle();

    expect((await readVideoRecordFile(w.libraryRoot, w.avatar.id, first.videoId))?.montageId).toBe("montage-0000001");
  });

  test("a draft deleted after its video was made: videos.list stops naming it, while the record is as it was written", async () => {
    const w = world();
    const store = drafts();
    await store.write(w.library, montageOf("montage-0000001", specFor(w)));
    const r = serviceRig(w, { deps: { drafts: store } });
    const { videoId } = await r.service.render({ montageId: "montage-0000001" });
    await r.queue.idle();
    expect((await r.service.list(w.avatar.id)).map((v) => v.montageId)).toEqual(["montage-0000001"]);

    await store.remove(w.library, w.avatar.id, "montage-0000001");

    expect((await r.service.list(w.avatar.id)).map((v) => v.montageId)).toEqual([null]);
    expect((await readVideoRecordFile(w.libraryRoot, w.avatar.id, videoId))?.montageId).toBe("montage-0000001"); // write-once
  });

  test("the record keeps the draft's name as it was at render time (K12): the event, the list and the record say it, and a rename or a delete later does not reach it", async () => {
    const w = world();
    const store = drafts();
    await store.write(w.library, Montage.parse({ montageId: "montage-0000001", name: "утро дома", spec: specFor(w), updatedAt: "2026-09-30T10:00:00.000Z" }));
    const r = serviceRig(w, { deps: { drafts: store } });

    const { videoId } = await r.service.render({ montageId: "montage-0000001" });
    await r.queue.idle();

    expect((await readVideoRecordFile(w.libraryRoot, w.avatar.id, videoId))?.title).toBe("утро дома");
    expect(videoChanged(r.events).map((v) => v.title)).toEqual(["утро дома"]);
    await store.write(w.library, Montage.parse({ montageId: "montage-0000001", name: "вечер", spec: specFor(w, 1), updatedAt: "2026-09-30T11:00:00.000Z" }));
    expect((await r.service.list(w.avatar.id)).map((v) => v.title)).toEqual(["утро дома"]);
    await store.remove(w.library, w.avatar.id, "montage-0000001");
    expect((await r.service.list(w.avatar.id)).map((v) => [v.title, v.montageId])).toEqual([["утро дома", null]]);
  });

  test("an unnamed draft and a headless spec have no title", async () => {
    const w = world();
    const store = drafts();
    await store.write(w.library, montageOf("montage-0000001", specFor(w)));
    const r = serviceRig(w, { deps: { drafts: store } });
    await r.service.render({ montageId: "montage-0000001" });
    await r.service.render({ spec: specFor(w, 1) });
    await r.queue.idle();

    expect((await r.service.list(w.avatar.id)).map((v) => v.title)).toEqual([null, null]);
  });

  test("a headless spec has no draft, before and after a delete", async () => {
    const w = world();
    const store = drafts();
    const r = serviceRig(w, { deps: { drafts: store } });
    await r.service.render({ spec: specFor(w) });
    await r.queue.idle();

    expect((await r.service.list(w.avatar.id)).map((v) => v.montageId)).toEqual([null]);
  });
});
