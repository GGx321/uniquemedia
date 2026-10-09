import { describe, expect, test } from "bun:test";
import type { TrackChoice } from "../../shared/autopilot/track";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { until } from "../testing/engineHarness";
import type { FreeStepsDeps } from "./freeSteps";
import type { LaunchFile } from "./launchFile";
import { A } from "./testing/launchFixtures";
import { distinctPhotos } from "./testing/planFixtures";
import { failure, rig, MUSIC, patchVideo, settleFor, useRigCleanup, videosOf } from "./testing/freeRig";
useNativeGlobals();
useRigCleanup();

// S4.6c1, fix round 1 (review): the waits and the second looks of the free steps. A refused submit is waited out, a draft saved after the assignment is honoured, a stale index is not a failed
// render, the launch's own generated photos are not the library's, a long wait is cheap and visible, and a live render is not lost.

const scenePhotoOf = (call: { spec: { clips: ReadonlyArray<{ kind: string; cell?: { photo: { source: string; photoId?: string } | null } }> } }): string[] =>
  call.spec.clips.flatMap((clip) => (clip.kind === "photo" && clip.cell?.photo?.source === "scene" && clip.cell.photo.photoId !== undefined ? [clip.cell.photo.photoId] : []));
const waitingMusic =
  (ready: () => boolean): NonNullable<FreeStepsDeps["chooseMusic"]> =>
  async (): Promise<TrackChoice> =>
    ready() ? { kind: "chosen", music: MUSIC } : { kind: "waiting", reason: "no-candidate" };

describe("a refused submit is waited out, not retried in a hot loop", () => {
  test.each([
    ["RENDER_QUEUE_FULL", () => failure({ code: "RENDER_QUEUE_FULL", detail: "full" })],
    ["INTERNAL", () => failure({ code: "INTERNAL", detail: "busy" })],
    ["IN_FLIGHT", () => failure({ code: "IN_FLIGHT", detail: "switching" })],
  ])("%s: no more attempts and no more file writes while the wait lasts", async (_name, make) => {
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: { recheckMs: 10_000 } });
    for (let i = 0; i < 1000; i++) r.videos.failNext(make());
    r.start();
    await until(() => r.videos.calls.length >= 1, "the first attempt");
    await settleFor(60);
    const calls = r.videos.calls.length;
    const writes = r.launch.updates;
    await settleFor(150);
    expect(r.videos.calls.length).toBe(calls);
    expect(r.launch.updates).toBe(writes);
    expect(calls).toBeLessThanOrEqual(2);
    expect(videosOf(r.launch)[0]?.state).toBe("assigned");
  });

  test("a track that keeps being refused is chosen again a few times and then the video is dropped", async () => {
    const r = rig({ draft: { videosPerAvatar: 1 } });
    for (let i = 0; i < 1000; i++) r.videos.failNext(failure({ code: "MONTAGE_INVALID", detail: "bad", issues: [{ code: "track-unavailable", path: ["music"] }] }));
    r.start();
    await until(() => r.launch.finished(), "the launch to finish");
    expect(r.videos.calls.length).toBeLessThanOrEqual(3);
    expect(videosOf(r.launch)[0]).toMatchObject({ state: "dropped", dropReason: "render-failed" });
  });
});

describe("A7: a draft saved after the assignment", () => {
  test("its photo is never rendered: the video takes another photo", async () => {
    let held = new Set<string>();
    let ready = false;
    const r = rig({ photos: 4, draft: { videosPerAvatar: 1 }, deps: { chooseMusic: waitingMusic(() => ready), photoIdsInDrafts: async () => ({ photoIds: held, complete: true }) } });
    r.start();
    // With no track yet the video waits for music (S4.6c2) with its photos kept: «assigned» is «has its photos».
    await until(() => (videosOf(r.launch)[0]?.photoIds.length ?? 0) > 0, "assigned");
    const assigned = videosOf(r.launch)[0]?.photoIds[0] ?? "";
    held = new Set([assigned]);
    ready = true;
    await until(() => r.launch.finished(), "the launch to finish");
    const used = r.videos.calls.flatMap(scenePhotoOf);
    expect(used).toHaveLength(1);
    expect(used).not.toContain(assigned);
  });

  test("when the drafts cannot be listed at the submit, the video waits", async () => {
    let complete = true;
    let ready = false;
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: { chooseMusic: waitingMusic(() => ready), photoIdsInDrafts: async () => ({ photoIds: new Set<string>(), complete }) } });
    r.start();
    // With no track yet the video waits for music (S4.6c2) with its photos kept: «assigned» is «has its photos».
    await until(() => (videosOf(r.launch)[0]?.photoIds.length ?? 0) > 0, "assigned");
    complete = false;
    ready = true;
    await settleFor(60);
    expect(r.videos.calls).toHaveLength(0);
    expect(videosOf(r.launch)[0]?.state).toBe("assigned");
    complete = true;
    await until(() => r.launch.finished(), "the launch to finish");
  });
});

describe("a stale index at the submit is not a failed render", () => {
  test("PHOTO_UNAVAILABLE with a distrusted usage waits, however many times, and the video is rendered once the index is back", async () => {
    const r = rig({ draft: { videosPerAvatar: 1 } });
    r.videos.failNext(() => {
      r.library.breakUsage(A);
      return failure({ code: "PHOTO_UNAVAILABLE", detail: "stale", photoReason: "index-stale" });
    });
    r.start();
    await settleFor(120);
    expect(videosOf(r.launch)[0]?.state).not.toBe("dropped");
    r.library.breakUsage(A, false);
    await until(() => r.launch.finished(), "the launch to finish");
    expect(videosOf(r.launch)[0]?.state).toBe("done");
  });

  test("an avatar whose usage is not known is not submitted for", async () => {
    let ready = false;
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: { chooseMusic: waitingMusic(() => ready) } });
    r.start();
    // With no track yet the video waits for music (S4.6c2) with its photos kept: «assigned» is «has its photos».
    await until(() => (videosOf(r.launch)[0]?.photoIds.length ?? 0) > 0, "assigned");
    r.library.breakUsage(A);
    ready = true;
    await settleFor(60);
    expect(r.videos.calls).toHaveLength(0);
    r.library.breakUsage(A, false);
    await until(() => r.launch.finished(), "the launch to finish");
  });
});

describe("the launch's own generated photos are not the library's", () => {
  test("a library video that lost its photo does not take a photo of the launch's slice; the generated video gets it", async () => {
    const run = { runIds: ["run-slice-0001"], over: true };
    const r = rig({ photos: 1, draft: { library: true, generate: true, videosPerAvatar: 2 }, slices: () => run });
    r.library.patch(r.photos[0]?.id ?? "", { usedIn: ["video-by-the-owner"] });
    const generated = distinctPhotos(1, { avatarId: A }, 9);
    r.library.add(A, generated);
    r.library.setRun(A, "run-slice-0001", [generated[0]?.id ?? ""]);
    r.start();
    await until(() => r.launch.finished(), "the launch to finish");
    const rows = videosOf(r.launch);
    expect(rows.find((v) => v.source === "library")?.state).toBe("dropped");
    const made = rows.find((v) => v.source === "generated");
    expect(made?.state).toBe("done");
    expect(made?.photoIds).toEqual([generated[0]?.id ?? ""]);
  });
});

describe("a long wait is cheap", () => {
  test("while generated videos wait and the slices do not change, the library and the drafts are not read again", async () => {
    let draftReads = 0;
    const r = rig({
      draft: { library: false, generate: true, videosPerAvatar: 2 },
      slices: () => ({ runIds: [], over: false }),
      deps: {
        photoIdsInDrafts: async () => {
          draftReads += 1;
          return { photoIds: new Set<string>(), complete: true };
        },
      },
    });
    r.start();
    await settleFor(40);
    const snapshots = r.library.snapshots;
    const reads = draftReads;
    await settleFor(200);
    expect(r.library.snapshots).toBe(snapshots);
    expect(draftReads).toBe(reads);
    expect(snapshots).toBeLessThanOrEqual(2);
  });

  test("a poke makes it look again at once", async () => {
    const run = { runIds: [] as string[], over: false };
    const r = rig({ draft: { library: false, generate: true, videosPerAvatar: 1 }, slices: () => run, deps: { idlePollMs: 60_000 } });
    r.start();
    await settleFor(40);
    r.library.setRun(A, "run-slice-0001", [r.photos[0]?.id ?? ""]);
    run.runIds.push("run-slice-0001");
    run.over = true;
    r.steps.poke();
    await until(() => r.launch.finished(), "the launch to finish");
  });

  test("with nothing running, the next look is at the idle interval, not the render interval", async () => {
    let calls = 0;
    const r = rig({
      draft: { library: false, generate: true, videosPerAvatar: 1 },
      deps: { pollMs: 2, idlePollMs: 100, sliceRuns: async () => ((calls += 1), { runIds: [], over: false }) },
    });
    r.start();
    await settleFor(350);
    expect(calls).toBeLessThanOrEqual(6);
  });
});

describe("a wait the owner can see in the log", () => {
  const rendering = (file: LaunchFile): LaunchFile => patchVideo(file, "0-1", { state: "rendering", photoIds: ["photo-held-0001"], videoId: null, music: MUSIC, previousStickerId: null });

  test("a key waiting for recovery says so once in the log, and the launch carries on when it resolves", async () => {
    const r = rig({ draft: { videosPerAvatar: 1 }, file: rendering });
    r.provenance.intents.set("0-1", "video-0000ad04");
    r.start();
    await until(() => r.launch.logs.some((l) => l.kind === "library-unknown"), "the log line");
    await settleFor(60);
    expect(r.launch.logs.filter((l) => l.kind === "library-unknown")).toHaveLength(1);
    expect(r.launch.logs.some((l) => l.kind === "avatar-busy")).toBe(false);

    r.provenance.intents.delete("0-1");
    r.provenance.records.set("0-1", { videoId: "video-0000ad04", durationMs: 7000, bytes: 4096 });
    await until(() => r.launch.finished(), "the launch to finish");
    expect(r.launch.file().avatars[0]?.phase).toBe("done");
  });
});

describe("a live render is not lost", () => {
  test("a video that says rendering, with a live job of its video id, is taken back and not rendered again", async () => {
    const r = rig({
      draft: { videosPerAvatar: 1 },
      file: (file) => patchVideo(file, "0-1", { state: "rendering", photoIds: ["photo-held-0001"], videoId: "video-0000beef", music: MUSIC, previousStickerId: null }),
      auto: false,
    });
    const job = r.videos.plant("0-1", "video-0000beef", A);
    r.start();
    await settleFor(60);
    expect(r.videos.calls).toHaveLength(0);
    expect(r.steps.inFlight().renders).toBe(1);
    r.videos.finish(job.jobId, "done");
    await until(() => r.launch.finished(), "the launch to finish");
    expect(r.videos.calls).toHaveLength(0);
  });
});

describe("cheap corrections", () => {
  test("a finish that fails once is tried again", async () => {
    const r = rig({ draft: { videosPerAvatar: 1 } });
    const real = r.launch.ctx.finish;
    let calls = 0;
    (r.launch.ctx as { finish: typeof real }).finish = async () => {
      calls += 1;
      if (calls === 1) throw new Error("disk");
      return real();
    };
    r.start();
    await until(() => r.launch.finished(), "the launch to finish");
    expect(calls).toBe(2);
  });

  test("a focus that was judged is kept; one that was not is asked again", async () => {
    const asked: string[] = [];
    const focus: FreeStepsDeps["focus"] = {
      prefetchFocus: async (_avatarId, photoId) => {
        asked.push(photoId);
        return { focus: { x: 0.5, y: 0.4 }, resolved: asked.length > 1 };
      },
    };
    const r = rig({ draft: { videosPerAvatar: 2 }, deps: { focus } });
    r.videos.failNext(failure({ code: "RENDER_QUEUE_FULL", detail: "full" }));
    r.start();
    await until(() => r.launch.finished(), "the launch to finish");
    // Two photos; the first was only a stand-in and a refused submit sent it round again, so it was asked twice.
    expect(new Set(asked).size).toBe(2);
    expect(asked).toHaveLength(3);
  });

  test("a log line the contract refuses is warned about, not lost silently", async () => {
    const warned: string[] = [];
    const r = rig({ draft: { videosPerAvatar: 1 }, auto: false, deps: { warn: (line) => void warned.push(line) } });
    r.start();
    await until(() => r.videos.calls.length === 1, "the render");
    const job = [...r.videos.jobs.values()][0];
    r.provenance.records.set("0-1", { videoId: job?.videoId ?? "", durationMs: 7000, bytes: 0 });
    r.videos.finish(job?.jobId ?? "", "done", { commit: false });
    await until(() => r.launch.finished(), "the launch to finish");
    expect(warned.some((w) => w.includes("log line"))).toBe(true);
  });

  test("a degrade is logged whenever a video is dropped, with at least one missing photo", async () => {
    const r = rig({ draft: { library: false, generate: true, videosPerAvatar: 1 }, slices: () => ({ runIds: ["run-slice-0001"], over: true }) });
    r.start();
    await until(() => r.launch.finished(), "the launch to finish");
    expect(r.launch.logs.some((l) => l.kind === "degrade" && l.fewerVideos === 1 && l.missingPhotos >= 1)).toBe(true);
  });
});
