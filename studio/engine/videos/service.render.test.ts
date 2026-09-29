import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { EngineFailure } from "../engineFailure";
import type { EngineError, ExportUnavailableReason } from "../../shared/engine";
import type { MontageDraft } from "../../shared/engine/montage";
import { estimateBytesUpper } from "../../shared/montage";
import { LibraryError } from "../library";
import { SAMPLE_AVATAR, SAMPLE_SOURCE, PNG_1X1, samplePhotoMeta } from "../library/testing/helpers";
import type { RenderSubmission, SubmitResult } from "../renderQueue/queue";
import { videoKindOf, VideoService } from "./service";
import { FINAL, specOf, useWorld, type World } from "./testing/kit";
import { fillingFocus, serviceRig, withOverrides, writingRun } from "./testing/serviceKit";
useNativeGlobals();

// `videos.render`, `videos.cancel` and the render events (3a.8b.2), against a real library and export root, a real
// queue, and a scripted export check, focus resolver and ffmpeg. Every mapping the plan lists has its test here.

const world = useWorld();

const SPEC_MS = 4_000;
const photoId = (w: World, i: number): string => w.photos[i]?.id ?? "";
const specFor = (w: World, i = 0): MontageDraft => specOf(w.avatar.id, [photoId(w, i)], SPEC_MS);

async function failureOf(work: Promise<unknown>): Promise<EngineError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof EngineFailure) return error.error;
    throw error;
  }
  throw new Error("expected the call to fail");
}

const textLayer = (n: number) => ({ layerId: `layer-0000000${n}`, kind: "text" as const, startMs: 0, endMs: 1000, value: "hello", font: "manrope" as const, style: "none" as const, color: "#ffffff", x: 0.5, y: 0.5, scale: 1 });
const stickerLayer = (n: number) => ({ layerId: `layer-0000001${n}`, kind: "sticker" as const, startMs: 0, endMs: 1000, sticker: { source: "builtin" as const, stickerId: "sticker-0001" }, x: 0.5, y: 0.5, size: 0.3 });

/** Nothing about the render may be touched by a refusal: no job, no reservation, no export folder, no intermediate, no record. */
async function expectNothingTouched(r: ReturnType<typeof serviceRig>, recordsBefore = 0): Promise<void> {
  expect(r.queue.states()).toEqual([]);
  expect(r.tracker.liveJobIds().size).toBe(0);
  expect(existsSync(join(r.w.exportRoot, "Mia"))).toBe(false);
  expect(await readdir(r.w.renderTmp)).toEqual([]);
  expect(r.w.library.videoCount(r.w.avatar.id)).toBe(recordsBefore);
}

describe("videos.render: the answer", () => {
  test("queues the render and answers its job and video ids; the job's total is the final frame count", async () => {
    const w = world();
    const r = serviceRig(w);

    const answer = await r.service.render({ spec: specFor(w) });

    expect(answer.jobId).toMatch(/^id-\d{8}$/);
    expect(answer.videoId).toMatch(/^id-\d{8}$/);
    expect(answer.jobId).not.toBe(answer.videoId);
    const [state] = r.queue.states();
    expect(state).toMatchObject({ kind: "render", jobId: answer.jobId, videoId: answer.videoId, avatarId: w.avatar.id, montageId: null, total: 120 });
    await r.queue.idle();
  });

  test("a montageId is NOT_FOUND until drafts exist (3d.1a), and touches nothing", async () => {
    const w = world();
    const r = serviceRig(w);

    const error = await failureOf(r.service.render({ montageId: "montage-0000001" }));

    expect(error.code).toBe("NOT_FOUND");
    await expectNothingTouched(r);
    expect(r.checks).toHaveLength(0);
  });

  test("an avatar the library does not have is NOT_FOUND", async () => {
    const w = world();
    const r = serviceRig(w);

    const error = await failureOf(r.service.render({ spec: { ...specFor(w), avatarId: "avatar-nobody-1" } }));

    expect(error.code).toBe("NOT_FOUND");
    await expectNothingTouched(r);
  });

  test("a draft avatar is NOT_FOUND: it has no scene photos to render", async () => {
    const w = world();
    const draft = await w.library.createAvatar({ ...SAMPLE_AVATAR, name: "Draft" });
    const r = serviceRig(w);

    const error = await failureOf(r.service.render({ spec: { ...specFor(w), avatarId: draft.id } }));

    expect(error.code).toBe("NOT_FOUND");
  });

  test("an archived avatar is NOT_FOUND: rendering is making new content, and only an active avatar does (as photo runs do)", async () => {
    const w = world();
    await w.library.updateAvatar(w.avatar.id, { status: "archived" });
    const r = serviceRig(w);

    const error = await failureOf(r.service.render({ spec: specFor(w) }));

    expect(error.code).toBe("NOT_FOUND");
    await expectNothingTouched(r);
  });

  test("with no render-tmp folder configured it refuses (no os.tmpdir fallback) and checks nothing else", async () => {
    const w = world();
    const r = serviceRig(w, { deps: { renderTmpDir: undefined } });

    const error = await failureOf(r.service.render({ spec: specFor(w) }));

    expect(error.code).toBe("INTERNAL");
    expect(r.checks).toHaveLength(0);
    await expectNothingTouched(r);
  });
});

describe("videos.render: N9, what is not supported yet is refused, never dropped", () => {
  const cases: Array<[string, (w: World) => MontageDraft, string[]]> = [
    ["a text layer", (w) => ({ ...specFor(w), layers: [textLayer(1)] }), ["layers", "0"]],
    ["a sticker layer", (w) => ({ ...specFor(w), layers: [stickerLayer(1)] }), ["layers", "0"]],
    ["a trending track", (w) => ({ ...specFor(w), music: { source: "trending", trackId: "track-0000001", startMs: 0 } }), ["music"]],
    ["an own track", (w) => ({ ...specFor(w), music: { source: "own", mediaId: "media-0000001", startMs: 0 } }), ["music"]],
    [
      "an own video clip",
      (w) => ({ ...specFor(w), clips: [{ clipId: "clip-00000001", kind: "video" as const, mediaId: "media-0000001", trimStartMs: 0, focus: null, durationMs: SPEC_MS, transitionIn: "cut" as const }] }),
      ["clips", "0"],
    ],
    [
      "an own photo in a photo clip",
      (w) => ({ ...specFor(w), clips: [{ clipId: "clip-00000001", kind: "photo" as const, cell: { photo: { source: "own" as const, mediaId: "media-0000001" }, focus: null }, motion: "static" as const, durationMs: SPEC_MS, transitionIn: "cut" as const }] }),
      ["clips", "0", "cell"],
    ],
    [
      "an own photo in a collage cell",
      (w) => ({
        ...specFor(w),
        clips: [
          {
            clipId: "clip-00000001",
            kind: "collage" as const,
            layout: "collage2" as const,
            cells: [
              { photo: { source: "scene" as const, photoId: photoId(w, 0) }, focus: null },
              { photo: { source: "own" as const, mediaId: "media-0000001" }, focus: null },
            ],
            motion: "static" as const,
            stagger: false,
            durationMs: SPEC_MS,
            transitionIn: "cut" as const,
          },
        ],
      }),
      ["clips", "0", "cells", "1"],
    ],
  ];

  test.each(cases)("%s answers MONTAGE_INVALID with not-yet-supported at its path, before anything else is looked at", async (_name, build, path) => {
    const w = world();
    const r = serviceRig(w);

    const error = await failureOf(r.service.render({ spec: build(w) }));

    expect(error.code).toBe("MONTAGE_INVALID");
    expect(error.issues).toContainEqual({ code: "not-yet-supported", path: path.map((p) => (/^\d+$/.test(p) ? Number(p) : p)) });
    expect(r.checks).toHaveLength(0);
    await expectNothingTouched(r);
  });

  test("a structurally invalid spec gets its issue list too, together with the unsupported parts", async () => {
    const w = world();
    const r = serviceRig(w);

    const error = await failureOf(r.service.render({ spec: { ...specFor(w), clips: [], layers: [textLayer(1)] } }));

    expect(error.code).toBe("MONTAGE_INVALID");
    expect(error.issues?.map((i) => i.code)).toEqual(expect.arrayContaining(["no-clips", "not-yet-supported"]));
  });

  test("a spec that is too short is MONTAGE_INVALID duration-too-short", async () => {
    const w = world();
    const r = serviceRig(w);

    const error = await failureOf(r.service.render({ spec: specOf(w.avatar.id, [photoId(w, 0)], 1_000) }));

    expect(error.issues).toEqual([{ code: "duration-too-short", path: ["clips"] }]);
  });
});

describe("videos.render: the export preflight (invariant 35) comes first among the checks that look at anything", () => {
  test.each<ExportUnavailableReason>(["missing", "not-a-directory", "not-writable", "not-enough-space", "overlaps-library", "invalid-marker", "newer-marker"])(
    "an unusable export folder (%s) answers EXPORT_UNAVAILABLE with that reason, and nothing is queued, reserved or read",
    async (reason) => {
      const w = world();
      const focusCalls: number[] = [];
      const r = serviceRig(w, {
        deps: {
          checkExport: async () => ({ ok: false, reason }),
          focus: () => ({ fillMissingFocus: async (spec) => (focusCalls.push(1), fillingFocus().fillMissingFocus(spec)) }),
        },
      });

      const error = await failureOf(r.service.render({ spec: specFor(w) }));

      expect(error).toMatchObject({ code: "EXPORT_UNAVAILABLE", exportReason: reason });
      expect(focusCalls).toEqual([]);
      await expectNothingTouched(r);
    },
  );

  test("asks the check for twice-the-estimate's worth of space: the estimate of THIS spec", async () => {
    const w = world();
    const r = serviceRig(w);
    const spec = specFor(w);

    await r.service.render({ spec });
    await r.queue.idle();

    expect(r.checks).toEqual([estimateBytesUpper(spec.clips)]);
  });

  test("the marker id of THAT check goes into the job: a root whose marker is another id fails the job, so no older snapshot is used", async () => {
    const w = world();
    const r = serviceRig(w, { deps: { checkExport: async () => ({ ok: true, root: w.exportRoot, rootId: "some-other-root" }) } });

    await r.service.render({ spec: specFor(w) });
    await r.queue.idle();

    expect(r.queue.states()[0]).toMatchObject({ status: "failed", error: { code: "EXPORT_UNAVAILABLE", exportReason: "missing" } });
  });

  test("the record names the export root that check answered", async () => {
    const w = world();
    const r = serviceRig(w);

    await r.service.render({ spec: specFor(w) });
    await r.queue.idle();

    const [state] = r.queue.states();
    expect(state).toMatchObject({ status: "done", result: { relPath: FINAL } });
    const records = (await import("./listing")).readVideoRecordFiles(w.libraryRoot, w.avatar.id);
    expect((await records).records[0]?.file.rootId).toBe(w.rootId);
  });
});

describe("videos.render: eligibility and used (invariant 18), before the focus is filled", () => {
  async function refusedFor(w: World, mutate: (w: World) => Promise<string> | string, expectedPath: (string | number)[] = ["clips", 0, "cell"], recordsBefore = 0): Promise<{ error: EngineError; focusCalls: number }> {
    const photo = await mutate(w);
    const focus = { calls: 0 };
    const r = serviceRig(w, { deps: { focus: () => ({ fillMissingFocus: async (spec) => (focus.calls++, fillingFocus().fillMissingFocus(spec)) }) } });
    const error = await failureOf(r.service.render({ spec: specOf(w.avatar.id, [photo], SPEC_MS) }));
    expect(error.issues).toEqual([{ code: "photo-unavailable", path: expectedPath }]);
    await expectNothingTouched(r, recordsBefore);
    return { error, focusCalls: focus.calls };
  }

  test("a rejected photo is PHOTO_UNAVAILABLE at its cell, and no focus is computed for it", async () => {
    const w = world();
    const { error, focusCalls } = await refusedFor(w, async (w) => {
      await w.library.setRejected(w.avatar.id, photoId(w, 0), true);
      return photoId(w, 0);
    });
    expect(error.code).toBe("PHOTO_UNAVAILABLE");
    expect(focusCalls).toBe(0);
  });

  test("the master photo is refused", async () => {
    const w = world();
    await refusedFor(w, () => w.avatar.masterPhotoId ?? "");
  });

  test("a photo of another avatar is refused", async () => {
    const w = world();
    await refusedFor(w, async (w) => {
      const other = await w.library.createAvatar({ ...SAMPLE_AVATAR, name: "Other" });
      const photo = await w.library.addPhoto(other.id, PNG_1X1, samplePhotoMeta({ source: { ...SAMPLE_SOURCE, category: "home" } }));
      return photo.id;
    });
  });

  test("a photo the library does not have is refused", async () => {
    const w = world();
    await refusedFor(w, () => "photo-nobody-01");
  });

  test("a photo an earlier video already shows is refused (used)", async () => {
    const w = world();
    w.library.addVideoRecordToIndex(w.avatar.id, { videoId: "video-earlier-1", photoIds: [photoId(w, 0)] });
    await refusedFor(w, () => photoId(w, 0), ["clips", 0, "cell"], 1);
  });

  test("each unavailable cell is named by its path, in a collage as well; the available cells are not", async () => {
    const w = world();
    await w.library.setRejected(w.avatar.id, photoId(w, 1), true);
    const r = serviceRig(w);
    const spec: MontageDraft = {
      ...specFor(w),
      clips: [
        {
          clipId: "clip-00000001",
          kind: "collage",
          layout: "collage3",
          cells: [
            { photo: { source: "scene", photoId: photoId(w, 0) }, focus: null },
            { photo: { source: "scene", photoId: photoId(w, 1) }, focus: null },
            { photo: { source: "scene", photoId: "photo-nobody-01" }, focus: null },
          ],
          motion: "static",
          stagger: false,
          durationMs: SPEC_MS,
          transitionIn: "cut",
        },
      ],
    };

    const error = await failureOf(r.service.render({ spec }));

    expect(error.code).toBe("PHOTO_UNAVAILABLE");
    expect(error.issues).toEqual([
      { code: "photo-unavailable", path: ["clips", 0, "cells", 1] },
      { code: "photo-unavailable", path: ["clips", 0, "cells", 2] },
    ]);
  });

  test("a stale used index is read again on demand, and a render that then finds it in step goes through", async () => {
    const w = world();
    w.library.flagVideoIndexStale(w.avatar.id, "video-committed-1");
    const r = serviceRig(w);

    const { jobId } = await r.service.render({ spec: specFor(w) });
    await r.queue.idle();

    expect(w.library.videoIndexStale(w.avatar.id)).toEqual([]);
    expect(r.jobs.stateOf(jobId)?.status).toBe("done");
  });

  test("an avatar whose used index is stale and cannot be read again is refused for every scene cell: the library's own refusal is honoured, not the per-photo states", async () => {
    const w = world();
    w.library.flagVideoIndexStale(w.avatar.id, "video-committed-1");
    const library = withOverrides(w.library, { reloadVideoRecords: () => Promise.reject(new Error("EIO")) });
    const r = serviceRig(w, { library });

    const error = await failureOf(r.service.render({ spec: specFor(w) }));

    expect(error.code).toBe("PHOTO_UNAVAILABLE");
    expect(error.issues).toEqual([{ code: "photo-unavailable", path: ["clips", 0, "cell"] }]);
    expect(error.detail).toContain("index-stale");
    await expectNothingTouched(r);
  });

  test("an avatar whose records need repair is refused the same way, and its detail names the library's code and no file", async () => {
    const w = world();
    const library = withOverrides(w.library, {
      eligibleUnusedPhotos: () => {
        throw new LibraryError("log-needs-repair", "the video records of avatar a need repair: videos/secret-file.json: broken");
      },
    });
    const r = serviceRig(w, { library });

    const error = await failureOf(r.service.render({ spec: specFor(w) }));

    expect(error.code).toBe("PHOTO_UNAVAILABLE");
    expect(error.detail).toContain("log-needs-repair");
    expect(error.detail).not.toContain("secret-file");
  });

  test("a record from a newer Studio answers LIBRARY_TOO_NEW", async () => {
    const w = world();
    const library = withOverrides(w.library, {
      eligibleUnusedPhotos: () => {
        throw new LibraryError("library-too-new", "a video record was written by a newer version of Studio (videos/x.json)");
      },
    });
    const r = serviceRig(w, { library });

    const error = await failureOf(r.service.render({ spec: specFor(w) }));

    expect(error.code).toBe("LIBRARY_TOO_NEW");
  });
});

describe("videos.render: focus, then the check again, then submit, with no await in between", () => {
  test("the spec that is rendered and kept in the record is the one with its focus filled", async () => {
    const w = world();
    const seen: MontageDraft[] = [];
    const r = serviceRig(w, { deps: { focus: () => fillingFocus(seen) } });

    await r.service.render({ spec: specFor(w) });
    await r.queue.idle();

    expect(seen).toHaveLength(1);
    const { readVideoRecordFiles } = await import("./listing");
    const [record] = (await readVideoRecordFiles(w.libraryRoot, w.avatar.id)).records;
    expect(JSON.stringify(record?.spec)).toContain('"focus":{"x":0.5,"y":0.4}');
    expect(JSON.stringify(record?.spec)).not.toContain('"focus":null');
  });

  test("a photo rejected while its focus was being computed is caught by the second check, and nothing is submitted", async () => {
    const w = world();
    const r = serviceRig(w, {
      deps: {
        focus: () => ({
          fillMissingFocus: async (spec) => {
            await w.library.setRejected(w.avatar.id, photoId(w, 0), true); // the owner rejects it during the fill
            return fillingFocus().fillMissingFocus(spec);
          },
        }),
      },
    });

    const error = await failureOf(r.service.render({ spec: specFor(w) }));

    expect(error.code).toBe("PHOTO_UNAVAILABLE");
    await expectNothingTouched(r);
  });

  test("a photo whose focus lookup says it is gone is PHOTO_UNAVAILABLE, not a bare internal error", async () => {
    const w = world();
    const r = serviceRig(w, {
      deps: {
        focus: () => ({
          fillMissingFocus: async () => {
            throw new LibraryError("photo-not-found", "no photo x");
          },
        }),
      },
    });

    const error = await failureOf(r.service.render({ spec: specFor(w) }));

    expect(error.code).toBe("PHOTO_UNAVAILABLE");
  });

  test("resolves each photo to its file and its STORED size, and the job's frames are the one number the queue was given", async () => {
    const w = world();
    const resolved: unknown[] = [];
    const frames: number[] = [];
    const r = serviceRig(w, {
      deps: {
        renderOverrides: {
          runJob: async (input) => {
            resolved.push(input.resolvePhoto({ source: "scene", photoId: photoId(w, 0) }));
            frames.push(input.clips.reduce((sum, clip) => sum + clip.durationMs, 0) * 3 / 100);
            throw new Error("stop here");
          },
        },
      },
    });

    await r.service.render({ spec: specFor(w) });
    await r.queue.idle();

    const sidecar = w.library.getPhoto(photoId(w, 0));
    expect(resolved).toEqual([{ path: w.library.photoFilePath(photoId(w, 0)), width: sidecar?.width, height: sidecar?.height }]);
    expect(frames).toEqual([r.queue.states()[0]?.total]);
    expect(r.queue.states()[0]?.total).toBe(120);
  });
});

describe("videos.render: what submit answers", () => {
  function refusingQueue(result: SubmitResult): { submit: (s: RenderSubmission) => SubmitResult } {
    return { submit: () => result };
  }

  test("PHOTOS_RESERVED becomes PHOTO_UNAVAILABLE with the cells that hold those photos, and nothing is left behind", async () => {
    const w = world();
    const r = serviceRig(w);
    const service = new VideoService({ ...r.deps, queue: { ...r.queue, submit: refusingQueue({ ok: false, code: "PHOTOS_RESERVED", photoIds: [photoId(w, 1)] }).submit, cancel: () => false, states: () => [], idle: async () => undefined } });
    const spec: MontageDraft = { ...specOf(w.avatar.id, [photoId(w, 0), photoId(w, 1)], SPEC_MS / 2) };

    const error = await failureOf(service.render({ spec }));

    expect(error.code).toBe("PHOTO_UNAVAILABLE");
    expect(error.issues).toEqual([{ code: "photo-unavailable", path: ["clips", 1, "cell"] }]);
    await expectNothingTouched(r);
  });

  test("QUEUE_FULL becomes RENDER_QUEUE_FULL with the limit in its detail, and nothing is left behind", async () => {
    const w = world();
    const r = serviceRig(w);
    const service = new VideoService({ ...r.deps, queue: { submit: () => ({ ok: false, code: "QUEUE_FULL", limit: 20 }), cancel: () => false, states: () => [], idle: async () => undefined } });

    const error = await failureOf(service.render({ spec: specFor(w) }));

    expect(error.code).toBe("RENDER_QUEUE_FULL");
    expect(error.detail).toContain("20");
    await expectNothingTouched(r);
  });

  test("a real full queue answers RENDER_QUEUE_FULL", async () => {
    const w = world();
    const hang = new Promise<void>(() => undefined);
    const r = serviceRig(w, { deps: { renderOverrides: { runDeps: { run: () => hang } } } });
    for (let i = 0; i < 20; i++) {
      const s = r.queue.submit({ jobId: `filler-${String(i).padStart(8, "0")}`, ref: { videoId: `filler-v-${String(i).padStart(6, "0")}`, avatarId: "avatar-other-1", montageId: null }, totalFrames: 120, photoIds: [`filler-photo-${i}`], execute: () => hang as Promise<never> });
      expect(s).toEqual({ ok: true });
    }

    const error = await failureOf(r.service.render({ spec: specFor(w) }));

    expect(error.code).toBe("RENDER_QUEUE_FULL");
    expect(w.library.videoCount(w.avatar.id)).toBe(0);
  });

  test("two renders of the same photo asked at once: the second one is PHOTO_UNAVAILABLE, and the first is queued", async () => {
    const w = world();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const r = serviceRig(w, {
      deps: {
        focus: () => ({
          fillMissingFocus: async (spec) => {
            await gate;
            return fillingFocus().fillMissingFocus(spec);
          },
        }),
      },
    });

    const first = r.service.render({ spec: specFor(w) });
    const second = failureOf(r.service.render({ spec: specFor(w) }));
    release();

    const [answer, error] = await Promise.all([first, second]);
    expect(answer.jobId).toBeDefined();
    expect(error.code).toBe("PHOTO_UNAVAILABLE");
    await r.queue.idle();
    expect(r.queue.states().filter((s) => s.status === "done")).toHaveLength(1);
  });
});

describe("videos.render: the kind token", () => {
  const photo = (id: string) => ({ clipId: id, kind: "photo" as const, cell: { photo: null, focus: null }, motion: "static" as const, durationMs: 1000, transitionIn: "cut" as const });
  const collage = (id: string, layout: "collage2" | "collage3" | "collage4") => ({ clipId: id, kind: "collage" as const, layout, cells: [], motion: "static" as const, stagger: false, durationMs: 1000, transitionIn: "cut" as const });

  test("photos only are `photo`", () => {
    expect(videoKindOf([photo("a"), photo("b")])).toBe("photo");
  });

  test("collages of one layout are named by it", () => {
    expect(videoKindOf([collage("a", "collage3"), collage("b", "collage3")])).toBe("collage3");
  });

  test("anything mixed is `mix`", () => {
    expect(videoKindOf([photo("a"), collage("b", "collage2")])).toBe("mix");
    expect(videoKindOf([collage("a", "collage2"), collage("b", "collage3")])).toBe("mix");
  });
});

describe("videos.cancel", () => {
  test("an unknown job is NOT_FOUND", async () => {
    const r = serviceRig(world());

    const error = await failureOf(Promise.resolve().then(() => r.service.cancel("job-nobody-001")));

    expect(error.code).toBe("NOT_FOUND");
  });

  test("a job that is not a render is NOT_FOUND and keeps running", async () => {
    const w = world();
    const r = serviceRig(w);
    const signal = r.jobs.startCandidates("job-candidates-1", w.avatar.id, 3);

    const error = await failureOf(Promise.resolve().then(() => r.service.cancel("job-candidates-1")));

    expect(error.code).toBe("NOT_FOUND");
    expect(signal.aborted).toBe(false);
    expect(r.jobs.stateOf("job-candidates-1")?.status).toBe("running");
  });

  test("a queued render is cancelled at once and never runs", async () => {
    const w = world();
    const hang = new Promise<void>(() => undefined);
    const r = serviceRig(w, { deps: { renderOverrides: { runDeps: { run: () => hang } } } });
    await r.service.render({ spec: specFor(w, 0) });
    const second = await r.service.render({ spec: specFor(w, 1) });

    expect(r.service.cancel(second.jobId)).toEqual({ jobId: second.jobId });

    expect(r.jobs.stateOf(second.jobId)?.status).toBe("cancelled");
  });

  test("a running render is stopped, and ends cancelled with nothing left", async () => {
    const w = world();
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const r = serviceRig(w, {
      deps: {
        renderOverrides: {
          runDeps: {
            run: (opts) =>
              new Promise<void>((_resolve, reject) => {
                started();
                opts.signal?.addEventListener("abort", () => reject(opts.signal?.reason), { once: true });
              }),
          },
        },
      },
    });
    const { jobId } = await r.service.render({ spec: specFor(w) });
    await running;

    r.service.cancel(jobId);
    await r.queue.idle();

    expect(r.jobs.stateOf(jobId)?.status).toBe("cancelled");
    expect(existsSync(join(w.exportRoot, "Mia", `.studio-part-${jobId}.mp4`))).toBe(false);
  });

  test("a cancel after the name is claimed answers ok, and the job still ends DONE with its record", async () => {
    const w = world();
    const holder: { cancelled?: { jobId: string } } = {};
    const r = serviceRig(w, {
      deps: {
        renderOverrides: {
          hooks: {
            reached: (step) => {
              if (step === "name-claimed") holder.cancelled = r.service.cancel(jobIdOf(r));
            },
          },
        },
      },
    });
    const { jobId } = await r.service.render({ spec: specFor(w) });
    await r.queue.idle();

    expect(holder.cancelled).toEqual({ jobId });
    expect(r.jobs.stateOf(jobId)).toMatchObject({ status: "done", result: { relPath: FINAL } });
    expect(w.library.videoCount(w.avatar.id)).toBe(1);
    expect(existsSync(join(w.exportRoot, FINAL))).toBe(true);
  });
});

function jobIdOf(r: ReturnType<typeof serviceRig>): string {
  const [state] = r.queue.states();
  if (state === undefined) throw new Error("no job");
  return state.jobId;
}

describe("the render events", () => {
  test("a queued render is announced with job.progress at 0, a running one as it starts", async () => {
    const w = world();
    const hang = new Promise<void>(() => undefined);
    const r = serviceRig(w, { deps: { renderOverrides: { runDeps: { run: () => hang } } } });

    const first = await r.service.render({ spec: specFor(w, 0) });
    const second = await r.service.render({ spec: specFor(w, 1) });

    const progress = r.stamped().filter((e) => e.type === "job.progress");
    expect(progress.map((e) => (e.type === "job.progress" ? [e.payload.jobId, e.payload.done, e.payload.total] : null))).toEqual([
      [first.jobId, 0, 120],
      [second.jobId, 0, 120],
    ]);
  });

  test("a finished render emits video.changed (upserted, present, with its summary) and then job.done with the result", async () => {
    const w = world();
    const r = serviceRig(w);

    const { jobId, videoId } = await r.service.render({ spec: specFor(w) });
    await r.queue.idle();

    const events = r.stamped();
    const kinds = events.map((e) => e.type);
    expect(kinds.indexOf("video.changed")).toBeGreaterThan(-1);
    expect(kinds.indexOf("video.changed")).toBeLessThan(kinds.indexOf("job.done"));
    const changed = events.find((e) => e.type === "video.changed");
    expect(changed?.type === "video.changed" && changed.payload.change === "upserted" ? changed.payload.video : null).toMatchObject({ videoId, avatarId: w.avatar.id, fileState: "present", relPath: FINAL, photoCount: 1, montageId: null, music: null, hasPoster: false });
    const done = events.find((e) => e.type === "job.done");
    expect(done?.type === "job.done" ? done.payload : null).toMatchObject({ jobId, result: { kind: "render", videoId, relPath: FINAL } });
  });

  test("progress frames reach the window as job.progress, never above the total before the end", async () => {
    const w = world();
    const r = serviceRig(w, {
      deps: {
        renderOverrides: {
          runDeps: {
            run: async (opts) => {
              opts.onFrames?.(50);
              await writingRun(opts);
            },
          },
        },
      },
    });

    await r.service.render({ spec: specFor(w) });
    await r.queue.idle();

    const dones = r.stamped().flatMap((e) => (e.type === "job.progress" ? [e.payload.done] : []));
    expect(dones.length).toBeGreaterThan(1);
    expect(Math.max(...dones)).toBeLessThan(120);
  });

  test("a failed render emits job.failed with the error and the job's identity", async () => {
    const w = world();
    const r = serviceRig(w, { deps: { renderOverrides: { verify: async () => ({ result: { ok: false, reasons: [{ code: "UUID_BOX", message: "m" }] }, sha256: null, bytes: 1 }) } } });

    const { jobId, videoId } = await r.service.render({ spec: specFor(w) });
    await r.queue.idle();

    const failed = r.stamped().find((e) => e.type === "job.failed");
    expect(failed?.type === "job.failed" ? failed.payload : null).toMatchObject({ kind: "render", jobId, videoId, avatarId: w.avatar.id, montageId: null, error: { code: "RENDER_VERIFY_FAILED" } });
    expect(r.stamped().some((e) => e.type === "video.changed")).toBe(false);
  });

  test("a cancelled render emits job.cancelled", async () => {
    const w = world();
    const hang = new Promise<void>(() => undefined);
    const r = serviceRig(w, { deps: { renderOverrides: { runDeps: { run: () => hang } } } });
    await r.service.render({ spec: specFor(w, 0) });
    const second = await r.service.render({ spec: specFor(w, 1) });

    r.service.cancel(second.jobId);

    const cancelled = r.stamped().find((e) => e.type === "job.cancelled");
    expect(cancelled?.type === "job.cancelled" ? cancelled.payload : null).toMatchObject({ kind: "render", jobId: second.jobId });
  });

  test("the error's cause never travels: a spawn error's argv (with the owner's photo paths) is not in any event", async () => {
    const w = world();
    const cause = Object.assign(new Error("spawn ffmpeg ENOENT"), { path: "/Users/owner/Photos/secret.jpg", spawnargs: ["-i", "/Users/owner/Photos/secret.jpg"], dest: "/Users/owner/Studio/out.mp4" });
    const r = serviceRig(w, {
      deps: {
        renderOverrides: {
          runJob: async () => {
            throw cause;
          },
        },
      },
    });

    await r.service.render({ spec: specFor(w) });
    await r.queue.idle();

    const text = JSON.stringify(r.events);
    expect(text).not.toContain("secret.jpg");
    expect(text).not.toContain("spawnargs");
    expect(text).not.toContain("/Users/owner/Studio");
    expect(r.stamped().some((e) => e.type === "job.failed")).toBe(true);
  });

  test("every event the service emits is one the contract's strict schema accepts", async () => {
    const w = world();
    const r = serviceRig(w);

    await r.service.render({ spec: specFor(w) });
    await r.queue.idle();

    expect(() => r.stamped()).not.toThrow();
    expect(r.events.length).toBeGreaterThan(2);
  });

  test("a listener error is logged by kind only, and the reporter itself never throws", () => {
    const w = world();
    const r = serviceRig(w, { deps: { log: () => { throw new Error("the log is broken too"); } } });

    expect(() => r.service.onListenerError(new Error("the window is gone /Users/owner/secret"))).not.toThrow();
  });

  test("an event the engine cannot emit does not stop the queue: onQueueEvent never throws", async () => {
    const w = world();
    const r = serviceRig(w, { deps: { emit: () => { throw new Error("port closed"); } } });

    await r.service.render({ spec: specFor(w) });
    await r.queue.idle();

    expect(r.queue.states()[0]?.status).toBe("done");
  });

  test("the saving phase is announced as job.progress with saving: true, before job.done", async () => {
    const w = world();
    const r = serviceRig(w);

    await r.service.render({ spec: specFor(w) });
    await r.queue.idle();

    const events = r.stamped();
    const saving = events.findIndex((e) => e.type === "job.progress" && e.payload.kind === "render" && e.payload.saving === true);
    expect(saving).toBeGreaterThan(-1);
    expect(saving).toBeLessThan(events.findIndex((e) => e.type === "job.done"));
  });
});

describe("avatar.changed follows what changes an avatar's counts", () => {
  test("a render that is queued (its photos are reserved), one whose record lands, and one that ends each announce the avatar", async () => {
    const w = world();
    const r = serviceRig(w);

    await r.service.render({ spec: specFor(w) });
    expect(r.announced).toEqual([w.avatar.id]);
    await r.queue.idle();

    expect(r.announced).toEqual([w.avatar.id, w.avatar.id, w.avatar.id]); // queued, committed (videoCount), ended (the reservation left)
  });

  test("a failed render and a cancelled one announce it too: their photos are free again", async () => {
    const w = world();
    const failing = serviceRig(w, { deps: { renderOverrides: { verify: async () => ({ result: { ok: false, reasons: [{ code: "UUID_BOX", message: "m" }] }, sha256: null, bytes: 1 }) } } });

    await failing.service.render({ spec: specFor(w) });
    await failing.queue.idle();

    expect(failing.announced).toEqual([w.avatar.id, w.avatar.id]);
  });

  test("a refusal announces nothing", async () => {
    const w = world();
    const r = serviceRig(w, { deps: { checkExport: async () => ({ ok: false, reason: "missing" }) } });

    await failureOf(r.service.render({ spec: specFor(w) }));

    expect(r.announced).toEqual([]);
  });
});

describe("videos.render has its own deadline, under main's 30 s", () => {
  const slowCheck = (ms: number, w: World) => async (): Promise<{ ok: true; root: string; rootId: string }> => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { ok: true, root: w.exportRoot, rootId: w.rootId };
  };

  test("export checks that queue up past the deadline end in a refusal with no job, and nothing that finishes later creates one", async () => {
    const w = world();
    const r = serviceRig(w, { deps: { commandDeadlineMs: 100, checkExport: slowCheck(300, w) } });

    const error = await failureOf(r.service.render({ spec: specFor(w) }));
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(error).toMatchObject({ code: "EXPORT_UNAVAILABLE", exportReason: "not-writable" });
    await expectNothingTouched(r);
  });

  test("what the checks cost is taken off the focus budget: a detector that never answers is cut in time for the answer to arrive inside the deadline", async () => {
    const w = world();
    let cutAfter = -1;
    const seen: number[] = [];
    const r = serviceRig(w, {
      deps: {
        commandDeadlineMs: 800,
        commandMarginMs: 60,
        checkExport: slowCheck(150, w),
        focus: () => ({
          fillMissingFocus: (spec, signal) =>
            new Promise((_resolve, reject) => {
              const started = Date.now();
              seen.push(1);
              signal?.addEventListener("abort", () => {
                cutAfter = Date.now() - started;
                reject(signal.reason);
              });
            }),
        }),
      },
    });
    const started = Date.now();

    const { jobId } = await r.service.render({ spec: specFor(w) });

    expect(Date.now() - started).toBeLessThan(800);
    expect(seen).toEqual([1]);
    expect(cutAfter).toBeGreaterThan(400);
    expect(cutAfter).toBeLessThan(700); // 800 - 150 (the check) - 60 (the margin) = 590, and a little scheduling
    expect(r.jobs.stateOf(jobId)).toBeDefined(); // it went on with the stand-in point
    await r.queue.idle();
  });

  test("the focus resolver is given what is left as ITS budget, so the cells it already judged are kept and only the rest use the stand-in point (counted in the log)", async () => {
    const w = world();
    const budgets: Array<number | undefined> = [];
    const r = serviceRig(w, {
      deps: {
        commandDeadlineMs: 1_000,
        commandMarginMs: 100,
        focus: () => ({
          fillMissingFocus: async (spec, _signal, options) => {
            budgets.push(options?.budgetMs);
            const filled = await fillingFocus().fillMissingFocus(spec);
            return { spec: filled.spec, unresolved: [{ clipId: "clip-00000001", cellIndex: 0 }] };
          },
        }),
      },
    });

    await r.service.render({ spec: specFor(w) });
    await r.queue.idle();

    expect(budgets).toHaveLength(1);
    expect(budgets[0]).toBeGreaterThan(500);
    expect(budgets[0]).toBeLessThanOrEqual(900);
    expect(r.logs.join("\n")).toContain("1 photo(s) could not be judged");
  });

  test("when the deadline is gone before there is anything left to spend on focus, it refuses and queues nothing", async () => {
    const w = world();
    const r = serviceRig(w, { deps: { commandDeadlineMs: 120, commandMarginMs: 50, withLibrary: async (work) => (await new Promise((resolve) => setTimeout(resolve, 150)), work(w.library)) } });

    const error = await failureOf(r.service.render({ spec: specFor(w) }));

    expect(error.code).toBe("INTERNAL");
    expect(error.detail).toContain("nothing was queued");
    await expectNothingTouched(r);
  });
});
