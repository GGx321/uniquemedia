import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { EngineFailure } from "../engineFailure";
import type { EngineError } from "../../shared/engine";
import { Montage, type MontageDraft } from "../../shared/engine/montage";
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

  test("a headless spec has no draft, before and after a delete", async () => {
    const w = world();
    const store = drafts();
    const r = serviceRig(w, { deps: { drafts: store } });
    await r.service.render({ spec: specFor(w) });
    await r.queue.idle();

    expect((await r.service.list(w.avatar.id)).map((v) => v.montageId)).toEqual([null]);
  });
});
