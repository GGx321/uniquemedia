import { describe, expect, test } from "bun:test";
import { emptyUsage, trackKey, type TrackChoice, type TrackUsage } from "../../shared/autopilot/track";
import type { LaunchDraft } from "../../shared/engine/autopilot";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { until } from "../testing/engineHarness";
import { within } from "../testing/within";
import { createFreeSteps, MAX_AUTOPILOT_RENDERS as RENDER_CAP, type FreeStepsDeps } from "./freeSteps";
import type { FileVideo, LaunchFile } from "./launchFile";
import type { PlanPhoto } from "./planner";
import { A, B, stampedFile } from "./testing/launchFixtures";
import { distinctPhotos } from "./testing/planFixtures";
import { LAUNCH, MUSIC, patchVideo, POLL, rig, settleFor, stopAfterTest, useRigCleanup, videosOf } from "./testing/freeRig";
import { failure, FakeLibrary, FakeProvenance, FakeVideos, fixedMusic, memoryLaunch, noDrafts, prefetching } from "./testing/freeHarness";
useNativeGlobals();

// S4.6c1 (plan §3.6 rows 7-10, §5.3, §5.4, §6, §8.1, §8.2; invariants A7, A8, A10): the free steps over doubles. The doubles keep the contracts of the real parts (the context refuses writes while
// paused, every write is re-parsed, a render is a job the test ends). The real video service is exercised in `freeSteps.e2e.test.ts`.

/** The number of the plan (section 8.1, A10), written out so that a change of the constant fails a test. */
const EIGHT = 8;
/** The bound on every await of a promise the steps own (a drain, a release): a loop that is never woken fails here, with the label, instead of hanging until the CI job is killed. */
const BOUND_MS = 4_000;
useRigCleanup();

describe("the order: videos.settled() first, nothing before it", () => {
  test("no render, no scan and no lookup is made until the background recovery of the open has settled", async () => {
    const r = rig();
    const release = r.videos.holdSettled();
    r.start();
    await settleFor(40);
    expect(r.videos.settledCalls).toBeGreaterThan(0);
    expect(r.videos.calls).toHaveLength(0);
    expect(r.provenance.scans + r.provenance.lookups).toBe(0);
    expect(videosOf(r.launch).every((v) => v.state === "planned")).toBe(true);

    release();
    await until(() => r.launch.finished(), "the launch to finish");
    expect(r.videos.calls).toHaveLength(3);
  });
});

describe("a library-only launch", () => {
  test("assigns, renders every video with its provenance and finishes the launch", async () => {
    const r = rig();
    r.start();
    await until(() => r.launch.finished(), "the launch to finish");

    expect(r.videos.calls).toHaveLength(3);
    for (const call of r.videos.calls) {
      expect(call.montageId).toBeNull();
      expect(call.provenance).toMatchObject({ origin: "autopilot", launchId: LAUNCH });
    }
    expect(new Set(r.videos.calls.map((c) => c.provenance.launchVideoKey)).size).toBe(3);
    const videos = videosOf(r.launch);
    expect(videos.every((v) => v.state === "done" && v.videoId !== null)).toBe(true);
    expect(r.launch.file().avatars[0]?.phase).toBe("done");
  });

  test("writes the music with the assignment, before the render", async () => {
    const r = rig({ auto: false });
    r.start();
    await until(() => r.videos.calls.length === 3, "three renders");
    for (const v of videosOf(r.launch)) expect(v.music).toEqual(MUSIC);
  });

  test("a video the log reports done carries its real length and size", async () => {
    const r = rig({ draft: { videosPerAvatar: 1 } });
    r.start();
    await until(() => r.launch.finished(), "the launch to finish");
    expect(r.launch.logs.find((l) => l.kind === "video-done")).toMatchObject({ kind: "video-done", key: "0-1", shape: "single", size: 1, bytes: 4096 });
  });
});

describe("A10: at most 8 unfinished renders", () => {
  test("the cap is 8 of the 20 the queue has, so the owner always has 12", () => {
    expect(RENDER_CAP).toBe(EIGHT);
  });

  test("a launch of 30 videos never has a 9th render unfinished", async () => {
    const r = rig({ auto: false, photos: 34, draft: { videosPerAvatar: 30 } });
    r.start();
    await until(() => r.videos.calls.length === EIGHT, "eight renders");
    await settleFor(40);
    expect(r.videos.calls).toHaveLength(EIGHT);
    expect(r.steps.inFlight()).toEqual({ requests: 0, renders: EIGHT });

    const first = [...r.videos.jobs.values()][0];
    r.videos.finish(first?.jobId ?? "", "done");
    await until(() => r.videos.calls.length === EIGHT + 1, "the ninth render after one ended");
    await settleFor(20);
    expect(r.videos.calls).toHaveLength(EIGHT + 1);

    r.videos.auto = true;
    r.videos.finishAll();
    await until(() => r.launch.finished(), "the launch to finish");
    expect(r.videos.calls).toHaveLength(30);
    expect(r.videos.maxUnfinished).toBeLessThanOrEqual(EIGHT);
  });

  test("a queue that refuses (the owner's renders filled it) is waited out, not dropped", async () => {
    const r = rig({ draft: { videosPerAvatar: 1 } });
    r.videos.failNext(failure({ code: "RENDER_QUEUE_FULL", detail: "full" }));
    r.start();
    await until(() => r.launch.finished(), "the launch to finish");
    expect(r.videos.calls).toHaveLength(2);
    expect(videosOf(r.launch)[0]?.state).toBe("done");
  });
});

describe("step 9: adoption by provenance, never a second video for a key", () => {
  const assignedAndRendering = (key: string, videoId: string | null) => (file: LaunchFile) => {
    const photoId = file.avatars[0]?.videos.find((v) => v.key === key) !== undefined ? "photo-held-0001" : "";
    return patchVideo(file, key, { state: "rendering", photoIds: [photoId], videoId, music: MUSIC, previousStickerId: null });
  };

  test("a crash between the intent and the record: the record that appeared is adopted and the key is not rendered again", async () => {
    const r = rig({ file: assignedAndRendering("0-1", null) });
    r.provenance.records.set("0-1", { videoId: "video-0000ad01", durationMs: 7000, bytes: 4096 });
    r.start();
    await until(() => r.launch.finished(), "the launch to finish");
    expect(r.videos.calls.map((c) => c.provenance.launchVideoKey)).not.toContain("0-1");
    expect(videosOf(r.launch).find((v) => v.key === "0-1")).toMatchObject({ state: "done", videoId: "video-0000ad01" });
  });

  test("a video id the file knew is looked up first: its record is adopted without a scan of the library", async () => {
    const r = rig({ file: assignedAndRendering("0-1", "video-0000ad02") });
    r.provenance.records.set("0-1", { videoId: "video-0000ad02", durationMs: 7000, bytes: 4096 });
    r.start();
    await until(() => r.launch.finished(), "the launch to finish");
    expect(videosOf(r.launch).find((v) => v.key === "0-1")?.state).toBe("done");
    expect(r.provenance.lookups).toBeGreaterThan(0);
  });

  test("a record file that exists and does not read is NOT «no record»: the key waits and is not rendered again", async () => {
    const r = rig({ file: assignedAndRendering("0-1", "video-0000ad03") });
    r.provenance.unreadable.add("video-0000ad03");
    r.provenance.complete = false;
    r.start();
    await until(() => videosOf(r.launch).filter((v) => v.state === "done").length === 2, "the other two videos");
    await settleFor(40);
    expect(r.videos.calls.map((c) => c.provenance.launchVideoKey)).not.toContain("0-1");
    expect(videosOf(r.launch).find((v) => v.key === "0-1")?.state).toBe("rendering");
    expect(r.launch.finished()).toBe(false);

    r.provenance.unreadable.delete("video-0000ad03");
    r.provenance.records.set("0-1", { videoId: "video-0000ad03", durationMs: 7000, bytes: 4096 });
    await until(() => r.launch.finished(), "the launch to finish once the record reads");
    expect(r.videos.calls.map((c) => c.provenance.launchVideoKey)).not.toContain("0-1");
  });

  test("a scan that could not read everything is not «no record» either", async () => {
    const r = rig({ file: assignedAndRendering("0-1", null) });
    r.provenance.complete = false;
    r.start();
    await until(() => videosOf(r.launch).filter((v) => v.state === "done").length === 2, "the other two videos");
    await settleFor(40);
    expect(r.videos.calls.map((c) => c.provenance.launchVideoKey)).not.toContain("0-1");
  });

  test("a pending intent with the key waits for recovery: no second render, and the record it becomes is adopted", async () => {
    const r = rig({ file: assignedAndRendering("0-1", null) });
    r.provenance.intents.set("0-1", "video-0000ad04");
    r.start();
    await until(() => videosOf(r.launch).filter((v) => v.state === "done").length === 2, "the other two videos");
    await settleFor(40);
    expect(r.videos.calls.map((c) => c.provenance.launchVideoKey)).not.toContain("0-1");

    r.provenance.intents.delete("0-1");
    r.provenance.records.set("0-1", { videoId: "video-0000ad04", durationMs: 7000, bytes: 4096 });
    await until(() => r.launch.finished(), "the launch to finish");
    expect(r.videos.calls.map((c) => c.provenance.launchVideoKey)).not.toContain("0-1");
  });

  test("neither an intent nor a record, in a scan that read everything: the key is submitted again", async () => {
    const r = rig({ file: assignedAndRendering("0-1", null) });
    r.start();
    await until(() => r.launch.finished(), "the launch to finish");
    expect(r.videos.calls.filter((c) => c.provenance.launchVideoKey === "0-1")).toHaveLength(1);
  });
});

describe("PHOTO_UNAVAILABLE (plan §5.4, L1)", () => {
  const unavailable = () => failure({ code: "PHOTO_UNAVAILABLE", detail: "taken", photoReason: "in-video" });

  test("with a pending intent for the key it waits for recovery: the photos are not re-picked and no second render is made", async () => {
    const r = rig({ draft: { videosPerAvatar: 1 } });
    r.videos.failNext(() => {
      r.provenance.intents.set("0-1", "video-0000ad05");
      return unavailable();
    });
    r.start();
    await until(() => r.videos.calls.length === 1, "the first render attempt");
    const held = videosOf(r.launch)[0]?.photoIds;
    await settleFor(40);
    expect(r.videos.calls).toHaveLength(1);
    expect(videosOf(r.launch)[0]).toMatchObject({ state: "rendering", photoIds: held });

    r.provenance.intents.delete("0-1");
    r.provenance.records.set("0-1", { videoId: "video-0000ad05", durationMs: 7000, bytes: 4096 });
    await until(() => r.launch.finished(), "the launch to finish");
    expect(r.videos.calls).toHaveLength(1);
  });

  test("when the scan could not read everything it waits too: it cannot rule an intent out", async () => {
    const r = rig({ draft: { videosPerAvatar: 1 } });
    r.videos.failNext(() => {
      r.provenance.complete = false;
      return unavailable();
    });
    r.start();
    await until(() => r.videos.calls.length === 1, "the first render attempt");
    await settleFor(40);
    expect(r.videos.calls).toHaveLength(1);
    expect(videosOf(r.launch)[0]?.state).toBe("rendering");
  });

  test("with no intent the video takes another free photo of its category and renders", async () => {
    const r = rig({ draft: { videosPerAvatar: 1 } });
    let taken = "";
    r.videos.failNext((input) => {
      const cell = input.spec.clips[0];
      taken = cell?.kind === "photo" && cell.cell.photo?.source === "scene" ? cell.cell.photo.photoId : "";
      r.library.patch(taken, { usedIn: ["video-by-the-owner"] });
      return unavailable();
    });
    r.start();
    await until(() => r.launch.finished(), "the launch to finish");
    expect(r.videos.calls).toHaveLength(2);
    const second = r.videos.calls[1]?.spec.clips[0];
    const secondId = second?.kind === "photo" && second.cell.photo?.source === "scene" ? second.cell.photo.photoId : "";
    expect(secondId).not.toBe("");
    expect(secondId).not.toBe(taken);
  });

  test("with no free photo left the video is dropped, the degrade is logged and the launch still ends", async () => {
    const r = rig({ draft: { videosPerAvatar: 1 }, photos: 1 });
    r.videos.failNext((input) => {
      const cell = input.spec.clips[0];
      const id = cell?.kind === "photo" && cell.cell.photo?.source === "scene" ? cell.cell.photo.photoId : "";
      r.library.patch(id, { usedIn: ["video-by-the-owner"] });
      return unavailable();
    });
    r.start();
    await until(() => r.launch.finished(), "the launch to finish");
    expect(videosOf(r.launch)[0]).toMatchObject({ state: "dropped", dropReason: "not-enough-photos" });
    expect(r.launch.logs.some((l) => l.kind === "degrade" && l.missingPhotos === 1 && l.fewerVideos === 1)).toBe(true);
  });
});

describe("what the library says right now (fail closed)", () => {
  test("an avatar whose usage cannot be trusted gets no photos until it can", async () => {
    const r = rig();
    r.library.breakUsage(A);
    r.start();
    await settleFor(40);
    expect(r.videos.calls).toHaveLength(0);
    expect(videosOf(r.launch).every((v) => v.state === "planned" && v.photoIds.length === 0)).toBe(true);

    r.library.breakUsage(A, false);
    await until(() => r.launch.finished(), "the launch to finish");
  });

  test("an avatar whose drafts cannot be listed in full gets no library photo", async () => {
    let complete = false;
    const r = rig({ deps: { photoIdsInDrafts: async () => ({ photoIds: new Set<string>(), complete }) } });
    r.start();
    await settleFor(40);
    expect(r.videos.calls).toHaveLength(0);

    complete = true;
    await until(() => r.launch.finished(), "the launch to finish");
  });

  test("a photo held by a saved draft is never put in a video", async () => {
    let heldIds = new Set<string>();
    const r = rig({ photos: 4, draft: { videosPerAvatar: 2 }, deps: { photoIdsInDrafts: async () => ({ photoIds: heldIds, complete: true }) } });
    heldIds = new Set(r.photos.slice(0, 2).map((p) => p.id));
    r.start();
    await until(() => r.launch.finished(), "the launch to finish");
    const used = r.videos.calls.flatMap((c) => c.spec.clips.flatMap((clip) => (clip.kind === "photo" && clip.cell.photo?.source === "scene" ? [clip.cell.photo.photoId] : [])));
    expect(used).toHaveLength(2);
    for (const id of used) expect(heldIds.has(id)).toBe(false);
  });

  test("the library being closed makes the steps wait, not fail", async () => {
    const r = rig();
    r.state.library = null;
    r.start();
    await settleFor(30);
    expect(r.videos.calls).toHaveLength(0);
    r.state.library = r.library;
    await until(() => r.launch.finished(), "the launch to finish");
  });
});

describe("generated photos arrive by slices (plan §5.4, §6.4)", () => {
  const generated = { library: false, generate: true, videosPerAvatar: 2 };

  test("a video is assigned when its photos have arrived and the draw has not ended; the other waits", async () => {
    const run = { runIds: [] as string[], over: false };
    const r = rig({ draft: generated, slices: () => run });
    r.start();
    await settleFor(30);
    expect(videosOf(r.launch).every((v) => v.photoIds.length === 0)).toBe(true);

    r.library.setRun(A, "run-slice-0001", [r.photos[0]?.id ?? ""]);
    run.runIds.push("run-slice-0001");
    await until(() => r.videos.calls.length === 1, "the first video");
    await settleFor(30);
    expect(r.videos.calls).toHaveLength(1);
    expect(videosOf(r.launch).find((v) => v.key === "0-2")?.state).toBe("planned");

    r.library.setRun(A, "run-slice-0002", [r.photos[1]?.id ?? ""]);
    run.runIds.push("run-slice-0002");
    run.over = true;
    await until(() => r.launch.finished(), "the launch to finish");
    expect(r.videos.calls).toHaveLength(2);
  });

  test("only the photos of the launch's own runs are used: a free library photo that is no slice's is left alone", async () => {
    const run = { runIds: ["run-slice-0001"], over: true };
    const r = rig({ draft: { ...generated, videosPerAvatar: 1 }, slices: () => run });
    r.library.setRun(A, "run-slice-0001", [r.photos[3]?.id ?? ""]);
    r.start();
    await until(() => r.launch.finished(), "the launch to finish");
    const cell = r.videos.calls[0]?.spec.clips[0];
    expect(cell?.kind === "photo" && cell.cell.photo?.source === "scene" ? cell.cell.photo.photoId : "").toBe(r.photos[3]?.id);
  });

  test("a photo the owner rejected after it arrived is not put in: the snapshot is read when the video is assigned", async () => {
    const run = { runIds: ["run-slice-0001"], over: true };
    const r = rig({ draft: { ...generated, videosPerAvatar: 1 }, slices: () => run });
    r.library.setRun(A, "run-slice-0001", [r.photos[0]?.id ?? "", r.photos[1]?.id ?? ""]);
    r.library.patch(r.photos[0]?.id ?? "", { rejected: true });
    r.start();
    await until(() => r.launch.finished(), "the launch to finish");
    const cell = r.videos.calls[0]?.spec.clips[0];
    expect(cell?.kind === "photo" && cell.cell.photo?.source === "scene" ? cell.cell.photo.photoId : "").toBe(r.photos[1]?.id);
  });

  test("when the draw is over and a video has no photo, it is dropped for not enough photos and the degrade is logged", async () => {
    const run = { runIds: ["run-slice-0001"], over: true };
    const r = rig({ draft: generated, slices: () => run });
    r.library.setRun(A, "run-slice-0001", [r.photos[0]?.id ?? ""]);
    r.start();
    await until(() => r.launch.finished(), "the launch to finish");
    expect(videosOf(r.launch).map((v) => v.state)).toEqual(["done", "dropped"]);
    expect(videosOf(r.launch)[1]?.dropReason).toBe("not-enough-photos");
    expect(r.launch.logs.some((l) => l.kind === "degrade")).toBe(true);
  });
});

describe("the track: chosen with the assignment, from the usage read once per avatar per launch", () => {
  test("trackUsage is called once for the avatar, however many videos it has", async () => {
    const r = rig({ draft: { videosPerAvatar: 5 }, photos: 8 });
    r.start();
    await until(() => r.launch.finished(), "the launch to finish");
    expect(r.usageCalls).toEqual([A]);
  });

  test("each choice sees the tracks this launch already gave (withUse), without reading the records again", async () => {
    const r = rig({ draft: { videosPerAvatar: 3 } });
    r.start();
    await until(() => r.launch.finished(), "the launch to finish");
    const key = trackKey("trending", "track-00000001");
    expect(r.music.asked.map((a) => a.usage.counts.get(key) ?? 0)).toEqual([0, 1, 2]);
  });

  test("the chooser is asked for the length the spec will have (the seed's total), so a fitting track is chosen", async () => {
    const r = rig({ draft: { videosPerAvatar: 1 } });
    r.start();
    await until(() => r.launch.finished(), "the launch to finish");
    const asked = r.music.asked[0];
    const total = r.videos.calls[0]?.spec.clips.reduce((sum, clip) => sum + clip.durationMs, 0);
    expect(asked?.totalMs).toBe(total);
  });

  test("begin called again (a resume that clears a hold) does not read the usage again", async () => {
    const r = rig({ auto: false });
    r.start();
    await until(() => r.videos.calls.length === 3, "three renders");
    r.steps.begin(r.launch.ctx);
    r.steps.begin(r.launch.ctx);
    await settleFor(30);
    expect(r.usageCalls).toEqual([A]);
    expect(r.videos.calls).toHaveLength(3);
  });

  test("with no chooser the video is assigned and waits: it is never rendered silent (A9)", async () => {
    const r = rig({ music: false });
    r.start();
    await until(() => videosOf(r.launch).every((v) => v.state === "assigned"), "all videos assigned");
    await settleFor(40);
    expect(r.videos.calls).toHaveLength(0);
    expect(videosOf(r.launch).every((v) => v.music === undefined && v.photoIds.length === 1)).toBe(true);
  });

  test("a chooser that finds no fitting track keeps the video waiting, then renders it when one appears", async () => {
    let found = false;
    const choose: NonNullable<FreeStepsDeps["chooseMusic"]> = async (): Promise<TrackChoice> => (found ? { kind: "chosen", music: MUSIC } : { kind: "waiting", reason: "no-candidate" });
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: { chooseMusic: choose } });
    r.start();
    await settleFor(40);
    expect(r.videos.calls).toHaveLength(0);
    found = true;
    await until(() => r.launch.finished(), "the launch to finish");
    expect(r.videos.calls).toHaveLength(1);
  });

  test("a usage read that fails is tried again, not guessed", async () => {
    let calls = 0;
    const trackUsage = async (): Promise<TrackUsage> => {
      calls += 1;
      if (calls === 1) throw new Error("disk");
      return emptyUsage();
    };
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: { trackUsage } });
    r.start();
    await until(() => r.launch.finished(), "the launch to finish");
    expect(calls).toBe(2);
  });
});

describe("the spec (A8, A9) and the focus (plan §8.2)", () => {
  test("every spec is at most 10 s, has no text layer, carries music and the provenance of its video", async () => {
    const r = rig({ draft: { videosPerAvatar: 6, mix: { single: 34, collage: 33, slides: 33 } }, photos: 40 });
    r.start();
    await until(() => r.launch.finished(), "the launch to finish");
    expect(r.videos.calls.length).toBeGreaterThan(0);
    for (const call of r.videos.calls) {
      const total = call.spec.clips.reduce((sum, clip) => sum + clip.durationMs, 0);
      expect(total).toBeLessThanOrEqual(10_000);
      expect(call.spec.layers.some((l) => l.kind === "text")).toBe(false);
      expect(call.spec.music).toEqual(MUSIC);
      expect(call.provenance.launchId).toBe(LAUNCH);
    }
  });

  test("stickers off: no layer; on: exactly one built-in sticker, never an own one", async () => {
    const off = rig({ draft: { videosPerAvatar: 2 } });
    off.start();
    await until(() => off.launch.finished(), "the launch to finish");
    expect(off.videos.calls.every((c) => c.spec.layers.length === 0)).toBe(true);

    const on = rig({ draft: { videosPerAvatar: 3, stickers: true } });
    on.start();
    await until(() => on.launch.finished(), "the launch to finish");
    for (const call of on.videos.calls) {
      expect(call.spec.layers).toHaveLength(1);
      expect(call.spec.layers[0]).toMatchObject({ kind: "sticker", sticker: { source: "builtin" } });
    }
  });

  test("a sticker differs from the one before it on the same avatar", async () => {
    const on = rig({ draft: { videosPerAvatar: 6, stickers: true }, photos: 8 });
    on.start();
    await until(() => on.launch.finished(), "the launch to finish");
    const ids = [...on.videos.calls]
      .sort((a, b) => a.provenance.launchVideoKey.localeCompare(b.provenance.launchVideoKey, undefined, { numeric: true }))
      .map((c) => {
        const layer = c.spec.layers[0];
        return layer?.kind === "sticker" && layer.sticker.source === "builtin" ? layer.sticker.stickerId : "";
      });
    for (let i = 1; i < ids.length; i++) expect(ids[i]).not.toBe(ids[i - 1]);
  });

  test("the focus of every photo is prefetched before its render, and the spec carries it filled in", async () => {
    const r = rig({ draft: { videosPerAvatar: 2 } });
    r.start();
    await until(() => r.launch.finished(), "the launch to finish");
    expect(r.focusLog.length).toBe(2);
    for (const call of r.videos.calls) {
      const clip = call.spec.clips[0];
      expect(clip?.kind === "photo" ? clip.cell.focus : null).toEqual({ x: 0.31, y: 0.27 });
    }
  });

  test("a photo whose focus could not be judged goes in with the stand-in point the prefetch returned", async () => {
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: { focus: { prefetchFocus: async () => ({ focus: { x: 0.5, y: 0.4 }, resolved: false }) } } });
    r.start();
    await until(() => r.launch.finished(), "the launch to finish");
    const clip = r.videos.calls[0]?.spec.clips[0];
    expect(clip?.kind === "photo" ? clip.cell.focus : null).toEqual({ x: 0.5, y: 0.4 });
  });

  test("the same assignment gives the same spec again (a re-submit after a crash renders the same video)", async () => {
    const first = rig({ draft: { videosPerAvatar: 1 }, auto: false });
    first.start();
    await until(() => first.videos.calls.length === 1, "the first render");
    const submitted = first.videos.calls[0]?.spec;
    // The crash: a new steps object over the same file, the video back at «rendering» with no job and nothing found.
    const file = first.launch.file();
    const again = rig({ draft: { videosPerAvatar: 1 }, file: () => file });
    again.start();
    await until(() => again.videos.calls.length === 1, "the re-submit");
    expect(again.videos.calls[0]?.spec).toEqual(submitted);
  });
});

describe("a render that does not make a video", () => {
  test("a job that failed with no record and no intent drops its video as render-failed, logs it, and the launch still ends", async () => {
    const r = rig({ auto: false, draft: { videosPerAvatar: 2 } });
    r.start();
    await until(() => r.videos.calls.length === 2, "both renders");
    const [one, two] = [...r.videos.jobs.values()];
    r.videos.finish(one?.jobId ?? "", "failed");
    r.videos.finish(two?.jobId ?? "", "done");
    await until(() => r.launch.finished(), "the launch to finish");
    const dropped = videosOf(r.launch).filter((v) => v.state === "dropped");
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.dropReason).toBe("render-failed");
    expect(r.launch.logs.some((l) => l.kind === "render-dropped" && l.key === dropped[0]?.key)).toBe(true);
  });

  test("a job that failed but left a record (cancelled after the commit) is a video, not a failure", async () => {
    const r = rig({ auto: false, draft: { videosPerAvatar: 1 } });
    r.start();
    await until(() => r.videos.calls.length === 1, "the render");
    const job = [...r.videos.jobs.values()][0];
    r.provenance.records.set("0-1", { videoId: job?.videoId ?? "", durationMs: 7000, bytes: 4096 });
    r.videos.finish(job?.jobId ?? "", "cancelled");
    await until(() => r.launch.finished(), "the launch to finish");
    expect(videosOf(r.launch)[0]?.state).toBe("done");
  });

  test("a spec the engine refuses is dropped as render-failed; one whose music is gone chooses again", async () => {
    const r = rig({ draft: { videosPerAvatar: 2 } });
    r.videos.failNext(
      failure({ code: "MONTAGE_INVALID", detail: "bad", issues: [{ code: "track-unavailable", path: ["music"] }] }),
      failure({ code: "MONTAGE_INVALID", detail: "bad", issues: [{ code: "duration-too-long", path: ["clips"] }] }),
    );
    r.start();
    await until(() => r.launch.finished(), "the launch to finish");
    const states = videosOf(r.launch).map((v) => v.state);
    expect(states.filter((s) => s === "done")).toHaveLength(1);
    expect(states.filter((s) => s === "dropped")).toHaveLength(1);
    // The video whose track vanished was given a track again and rendered once more.
    expect(r.music.asked.length).toBeGreaterThanOrEqual(3);
  });

  test("an avatar the launch skipped has its remaining videos dropped as avatar-skipped", async () => {
    const r = rig({ music: false, file: (f) => ({ ...f, avatars: f.avatars.map((a) => ({ ...a, phase: "skipped" as const, skipped: { reason: "archived" as const } })) }) });
    r.start();
    await until(() => r.launch.finished(), "the launch to finish");
    expect(videosOf(r.launch).every((v) => v.state === "dropped" && v.dropReason === "avatar-skipped")).toBe(true);
  });

  test("an avatar that is gone (NOT_FOUND from the render) has its video dropped as avatar-gone", async () => {
    const r = rig({ draft: { videosPerAvatar: 1 } });
    r.videos.failNext(failure({ code: "NOT_FOUND", detail: "no active avatar" }));
    r.start();
    await until(() => r.launch.finished(), "the launch to finish");
    expect(videosOf(r.launch)[0]).toMatchObject({ state: "dropped", dropReason: "avatar-gone" });
  });
});

describe("the soft stop and the steps' contract", () => {
  test("nothing starts while the launch is not running", async () => {
    const r = rig();
    r.launch.pause();
    r.start();
    await settleFor(40);
    expect(r.videos.calls).toHaveLength(0);
    expect(r.usageCalls).toHaveLength(0);
    expect(r.launch.updates).toBe(0);
  });

  test("drain waits for the renders in flight, writes their end, and starts nothing new", async () => {
    const r = rig({ auto: false, photos: 14, draft: { videosPerAvatar: 12 } });
    r.start();
    await until(() => r.videos.calls.length === EIGHT, "eight renders");
    r.launch.pause();
    let drained = false;
    const drain = r.steps.drain().then(() => {
      drained = true;
    });
    await settleFor(30);
    expect(drained).toBe(false);
    expect(r.steps.inFlight().renders).toBe(EIGHT);

    r.videos.finishAll();
    await within(drain, BOUND_MS, "the drain to resolve after the renders ended");
    r.launch.settlePause();
    expect(r.steps.inFlight()).toEqual({ requests: 0, renders: 0 });
    expect(videosOf(r.launch).filter((v) => v.state === "done")).toHaveLength(EIGHT);
    expect(r.videos.calls).toHaveLength(EIGHT);
    r.steps.poke();
    await settleFor(30);
    expect(r.videos.calls).toHaveLength(EIGHT);
  });

  test("drain with nothing in flight resolves at once and never rejects", async () => {
    const r = rig();
    await within(r.steps.drain(), BOUND_MS, "a drain before anything began");
    r.start();
    await within(r.steps.drain(), BOUND_MS, "a drain with nothing in flight");
    expect(r.steps.inFlight()).toEqual({ requests: 0, renders: 0 });
  });

  test("the loop's sleep is a ref'd timer: while a drain is pending, that timer is what keeps the process waiting (Bun on Windows idles for ever on an unref'd one)", async () => {
    const real = globalThis.setTimeout;
    let unrefs = 0;
    let sleeps = 0;
    globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
      const timer = real(fn, ms, ...rest) as ReturnType<typeof setTimeout> & { unref?: () => unknown };
      if (ms === POLL && typeof timer === "object" && timer !== null && typeof timer.unref === "function") {
        sleeps += 1;
        const unref = timer.unref.bind(timer);
        timer.unref = () => {
          unrefs += 1;
          return unref();
        };
      }
      return timer;
    }) as unknown as typeof setTimeout;
    try {
      const r = rig({ auto: false });
      r.start();
      await until(() => r.videos.calls.length === 3, "three renders");
      await settleFor(20);
      expect(sleeps).toBeGreaterThan(0);
      expect(unrefs).toBe(0);
    } finally {
      globalThis.setTimeout = real;
    }
  });

  test("a drain does not wait for a launch that is gone: its renders in flight end by themselves", async () => {
    const r = rig({ auto: false, photos: 4, draft: { videosPerAvatar: 3 } });
    let gone = false;
    const ctx = {
      ...r.launch.ctx,
      file: () => {
        if (gone) throw new Error("the launch is not on disk any more");
        return r.launch.file();
      },
    };
    r.steps.begin(ctx);
    await until(() => r.videos.calls.length === 3, "three renders");
    const drain = r.steps.drain();
    gone = true;
    await within(drain, BOUND_MS, "a drain of a launch whose file is gone, with renders still in flight");
  });

  test("after a drain, begin carries on from the file: the rest is rendered, none twice", async () => {
    const r = rig({ auto: false, photos: 12, draft: { videosPerAvatar: 10 } });
    r.start();
    await until(() => r.videos.calls.length === EIGHT, "eight renders");
    r.launch.pause();
    const drain = r.steps.drain();
    r.videos.finishAll();
    await within(drain, BOUND_MS, "the drain before the resume");
    r.launch.settlePause();

    r.launch.resume();
    r.videos.auto = true;
    r.steps.begin(r.launch.ctx);
    await until(() => r.launch.finished(), "the launch to finish");
    const keys = r.videos.calls.map((c) => c.provenance.launchVideoKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(10);
  });

  test("release is harmless when nothing ran, and when called twice", async () => {
    const r = rig();
    await within(r.steps.release(r.launch.ctx), BOUND_MS, "a release of nothing");
    r.start();
    await within(r.steps.release(r.launch.ctx), BOUND_MS, "the first release");
    await within(r.steps.release(r.launch.ctx), BOUND_MS, "the second release");
  });

  test("two avatars in one launch are both rendered and never share a photo", async () => {
    const aPhotos = distinctPhotos(4, { avatarId: A }, 3);
    const bPhotos = distinctPhotos(4, { avatarId: B }, 9);
    const library = new FakeLibrary().add(A, aPhotos).add(B, bPhotos);
    const file = stampedFile({ library: true, generate: false, avatarIds: [A, B], videosPerAvatar: 2, mix: { single: 100, collage: 0, slides: 0 } }, {}, { [A]: aPhotos, [B]: bPhotos });
    const launch = memoryLaunch(file);
    const provenance = new FakeProvenance();
    const videos = new FakeVideos(provenance);
    videos.auto = true;
    const steps = createFreeSteps({
      library: () => library,
      videos: videos.videos,
      renderLife: videos.lifeOf,
      focus: prefetching(),
      photoIdsInDrafts: noDrafts,
      sliceRuns: async () => ({ runIds: [], over: true }),
      trackUsage: async () => emptyUsage(),
      chooseMusic: fixedMusic().choose,
      provenance,
      pollMs: POLL,
      recheckMs: POLL,
    });
    stopAfterTest(() => steps.release(launch.ctx));
    steps.begin(launch.ctx);
    await until(() => launch.finished(), "the launch to finish");
    expect(videos.calls).toHaveLength(4);
    const ids = videos.calls.flatMap((c) => c.spec.clips.flatMap((clip) => (clip.kind === "photo" && clip.cell.photo?.source === "scene" ? [clip.cell.photo.photoId] : [])));
    expect(new Set(ids).size).toBe(4);
    expect(videos.calls.filter((c) => c.spec.avatarId === A)).toHaveLength(2);
  });
});
