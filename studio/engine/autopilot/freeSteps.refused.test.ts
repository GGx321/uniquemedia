import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { until } from "../testing/engineHarness";
import type { LaunchFile } from "./launchFile";
import { rig, settleFor, useRigCleanup, videosOf } from "./testing/freeRig";
import type { MemoryLaunch } from "./testing/freeHarness";
useNativeGlobals();
useRigCleanup();

// S4.6c1, fix round 2: a refused «rendering» write stops the submit (the disk must say «rendering» before a render exists), the draft check follows the focus prefetch, and a pass that
// changes nothing writes nothing.

type Update = MemoryLaunch["ctx"]["update"];
const scenePhotos = (call: { spec: { clips: ReadonlyArray<{ kind: string; cell?: { photo: { source: string; photoId?: string } | null } }> } }): string[] =>
  call.spec.clips.flatMap((clip) => (clip.kind === "photo" && clip.cell?.photo?.source === "scene" && clip.cell.photo.photoId !== undefined ? [clip.cell.photo.photoId] : []));

describe("the «rendering» write comes first", () => {
  test("a write that fails AFTER its change was computed does not let the render go: no job, no second job for the key", async () => {
    const r = rig({ draft: { videosPerAvatar: 1 }, auto: false });
    const real: Update = r.launch.ctx.update;
    let failed = 0;
    (r.launch.ctx as { update: Update }).update = async (change) => {
      if (failed === 0) {
        const next = change(r.launch.file());
        if (next !== null && next.avatars[0]?.videos[0]?.state === "rendering") {
          failed += 1;
          throw new Error("EIO");
        }
      }
      return real(change);
    };
    r.start();
    await until(() => r.videos.calls.length >= 1, "the render after the retry");
    await settleFor(60);
    expect(failed).toBe(1);
    // Exactly one render for the key, and the first attempt (whose write failed) never reached the video service.
    expect(r.videos.calls.filter((c) => c.provenance.launchVideoKey === "0-1")).toHaveLength(1);
    expect(r.videos.jobs.size).toBe(1);
    expect(r.steps.inFlight().renders).toBe(1);
    expect(videosOf(r.launch)[0]?.state).toBe("rendering");
  });

  test("a «rendering» write that is refused every time is tried once per backoff, not in a loop", async () => {
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: { recheckMs: 10_000 } });
    const real: Update = r.launch.ctx.update;
    let refused = 0;
    (r.launch.ctx as { update: Update }).update = async (change) => {
      // Every write that would mark the video «rendering» is refused (the launch file cannot be written).
      if (change(r.launch.file())?.avatars[0]?.videos[0]?.state === "rendering") {
        refused += 1;
        throw new Error("EIO");
      }
      return real(change);
    };
    r.start();
    await until(() => refused >= 1, "the first refused write");
    await settleFor(150);
    expect(refused).toBeLessThanOrEqual(2);
    expect(r.videos.calls).toHaveLength(0);
  });

  test("a video already in flight is never taken twice", async () => {
    const r = rig({ draft: { videosPerAvatar: 2 }, auto: false });
    r.start();
    await until(() => r.videos.calls.length === 2, "both renders");
    await settleFor(60);
    expect(r.videos.calls).toHaveLength(2);
    expect(new Set(r.videos.calls.map((c) => c.provenance.launchVideoKey)).size).toBe(2);
  });
});

describe("A7: the drafts are read after the focus, fresh for each submit", () => {
  test("a draft saved while the focus of its photos was being judged still holds the photo back", async () => {
    let held = new Set<string>();
    const r = rig({
      photos: 4,
      draft: { videosPerAvatar: 1 },
      deps: {
        photoIdsInDrafts: async () => ({ photoIds: held, complete: true }),
        focus: {
          prefetchFocus: async (_avatarId, photoId) => {
            if (held.size === 0) held = new Set([photoId]);
            return { focus: { x: 0.5, y: 0.4 }, resolved: true };
          },
        },
      },
    });
    r.start();
    await until(() => r.launch.finished(), "the launch to finish");
    const used = r.videos.calls.flatMap(scenePhotos);
    expect(used).toHaveLength(1);
    expect(held.has(used[0] ?? "")).toBe(false);
  });
});

describe("a pass that changes nothing writes nothing", () => {
  test("while renders are in flight the launch file is not rewritten (no autopilot.changed every poll)", async () => {
    const r = rig({ draft: { videosPerAvatar: 3 }, auto: false });
    let calls = 0;
    const real: Update = r.launch.ctx.update;
    (r.launch.ctx as { update: Update }).update = async (change: (file: LaunchFile) => LaunchFile | null) => {
      calls += 1;
      return real(change);
    };
    r.start();
    await until(() => r.videos.calls.length === 3, "three renders");
    await settleFor(40);
    const before = calls;
    await settleFor(120);
    expect(calls).toBe(before);
  });
});

describe("the wait is in the log and on the avatar's row (S4.6c2: `library-unknown`)", () => {
  test("a key held by recovery logs one line and the row waits with its own reason, not as avatar-busy", async () => {
    const r = rig({
      draft: { videosPerAvatar: 1 },
      file: (file) => ({ ...file, avatars: file.avatars.map((a) => ({ ...a, videos: a.videos.map((v) => ({ ...v, state: "rendering" as const, photoIds: ["photo-held-0001"], videoId: null, music: { source: "trending" as const, trackId: "track-00000001", startMs: 1500 } })) })) }),
    });
    r.provenance.intents.set("0-1", "video-0000ad04");
    r.start();
    await until(() => r.launch.logs.some((l) => l.kind === "library-unknown"), "the log line");
    await settleFor(60);
    expect(r.launch.logs.filter((l) => l.kind === "library-unknown")).toHaveLength(1);
    expect(r.launch.logs.some((l) => l.kind === "avatar-busy")).toBe(false);
    expect(r.launch.file().avatars[0]).toMatchObject({ phase: "waiting", waiting: { reason: "library-unknown" } });
  });
});
