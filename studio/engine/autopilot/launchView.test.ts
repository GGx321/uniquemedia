import { describe, expect, test } from "bun:test";
import { LaunchView } from "../../shared/engine/autopilot";
import type { ViewContext } from "./launchView";
import type { AvatarMirror } from "./steps";
import { launchViewOf } from "./launchView";
import { A, B, stampedFile } from "./testing/launchFixtures";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 4, S4.6a (plan §9, §19): a launch file as the window sees it. One `spent` feeds both «Потрачено» and R = max(0, W′ − spent); the view always passes the contract.

const base = (over: Partial<ViewContext> = {}): ViewContext => ({
  status: "running",
  nowMs: Date.parse("2026-10-09T10:10:00.000Z"),
  spentMicros: 0,
  inFlight: { requests: 0, openMicros: 0 },
  resumeBlockedBy: null,
  logTail: [],
  ...over,
});

const parsed = (file = stampedFile(), ctx = base()) => LaunchView.parse(launchViewOf(file, ctx));

describe("launchViewOf", () => {
  test("a fresh launch passes the contract and carries the click, the figures and the plan", () => {
    const file = stampedFile();
    const view = parsed(file);
    expect(view).toMatchObject({
      launchId: file.launchId,
      status: "running",
      paused: null,
      endedAt: null,
      acceptedMicros: file.acceptedMicros,
      plannedWorstMicros: file.plannedWorstMicros,
      plannedExpectedMicros: file.plannedExpectedMicros,
      plan: file.plan,
      draft: file.draft,
      paidHold: null,
      freeHold: null,
      reviewWritesMicros: 0,
      waitingMusic: 0,
    });
  });

  test("spent is the context's, and R is W′ less that, never below zero", () => {
    const file = stampedFile();
    const worst = file.plannedWorstMicros;
    expect(parsed(file, base({ spentMicros: 1_000 })).remainingMicros).toBe(worst - 1_000);
    expect(parsed(file, base({ spentMicros: 1_000 })).spentMicros).toBe(1_000);
    expect(parsed(file, base({ spentMicros: worst })).remainingMicros).toBe(0);
    expect(parsed(file, base({ spentMicros: worst + 5 })).remainingMicros).toBe(0);
  });

  test("active time is the stored time plus the time since the clock started, while the launch runs", () => {
    const file = stampedFile({}, { activeMs: 1_000, activeSince: "2026-10-09T10:09:00.000Z" });
    expect(parsed(file).activeMs).toBe(1_000 + 60_000);
  });

  test("a paused launch's time stands still", () => {
    const file = stampedFile({}, { status: "paused", activeMs: 7_000, activeSince: null, paused: { cause: "owner", at: "2026-10-09T10:05:00.000Z" } });
    const view = parsed(file, base({ status: "paused" }));
    expect(view.activeMs).toBe(7_000);
    expect(view.paused).toEqual({ cause: "owner", at: "2026-10-09T10:05:00.000Z" });
  });

  test("a clock that ran backwards adds nothing", () => {
    const file = stampedFile({}, { activeMs: 500, activeSince: "2026-10-09T11:00:00.000Z" });
    expect(parsed(file).activeMs).toBe(500);
  });

  test("pausing is a view state: the file says running and the window says pausing", () => {
    expect(parsed(stampedFile(), base({ status: "pausing" })).status).toBe("pausing");
  });

  test("a stopped launch has its end", () => {
    const file = stampedFile({}, { status: "stopped", activeSince: null, endedAt: "2026-10-09T10:20:00.000Z", spentMicros: 40 });
    const view = parsed(file, base({ status: "stopped", spentMicros: 40 }));
    expect(view.endedAt).toBe("2026-10-09T10:20:00.000Z");
  });

  test("rows follow the draft's avatars, each with its photos and videos counted from the file", () => {
    const file = stampedFile({ avatarIds: [A, B] });
    const view = parsed(file);
    expect(view.avatars.map((a) => a.avatarId)).toEqual([A, B]);
    expect(view.avatars[0]).toMatchObject({
      phase: "planned",
      photos: { done: 0, total: 10 },
      videos: { done: 0, total: 4 },
      montage: { done: 0, total: 4 },
      waiting: null,
      skipped: null,
      sceneSetId: null,
      setRevision: null,
      slice: null,
      waitingMusic: 0,
      drawAllocationMicros: 10 * 210_000,
    });
  });

  test("a video that is done or dropped is counted, and a dropped one is not part of the total", () => {
    const file = stampedFile();
    const row = file.avatars[0];
    if (row === undefined) throw new Error("no row");
    const [v1, v2, v3, v4] = row.videos;
    if (v1 === undefined || v2 === undefined || v3 === undefined || v4 === undefined) throw new Error("no videos");
    const videos = [{ ...v1, state: "done" as const, videoId: "video-00000001" }, { ...v2, state: "waiting-music" as const }, { ...v3, state: "dropped" as const, dropReason: "render-failed" as const }, v4];
    const view = parsed({ ...file, avatars: [{ ...row, videos }] });
    expect(view.avatars[0]).toMatchObject({ videos: { done: 1, total: 3 }, waitingMusic: 1, dropped: { count: 1, reason: "render-failed" } });
    expect(view.waitingMusic).toBe(1);
  });

  test("a waiting avatar and a skipped avatar carry their reason", () => {
    const file = stampedFile({ avatarIds: [A, B] });
    const [a, b] = file.avatars;
    if (a === undefined || b === undefined) throw new Error("no rows");
    const view = parsed({ ...file, avatars: [{ ...a, phase: "waiting", waiting: { reason: "avatar-busy" } }, { ...b, phase: "skipped", skipped: { reason: "archived" } }] });
    expect(view.avatars[0]).toMatchObject({ phase: "waiting", waiting: { reason: "avatar-busy" }, skipped: null });
    expect(view.avatars[1]).toMatchObject({ phase: "skipped", waiting: null, skipped: { reason: "archived" } });
  });

  test("holds, what is in flight, the resume block and the log tail come through", () => {
    const hold = { reason: "credits", at: "2026-10-09T10:06:00.000Z", detail: {} } as const;
    const tail = [{ at: "2026-10-09T10:00:00.000Z", kind: "start", acceptedMicros: 1 }] as const;
    const view = parsed(stampedFile({}, { paidHold: hold }), base({ spentMicros: 420_000, inFlight: { requests: 2, openMicros: 420_000 }, resumeBlockedBy: "reconcile-required", logTail: tail }));
    expect(view).toMatchObject({ paidHold: hold, inFlight: { requests: 2, openMicros: 420_000 }, resumeBlockedBy: "reconcile-required", logTail: tail });
  });

  test("a library-only avatar has no draw allocation", () => {
    const file = stampedFile({ generate: false });
    expect(parsed(file).avatars[0]?.drawAllocationMicros).toBeNull();
  });

  describe("S4.6v: what the live card reads", () => {
    const mirrorOf = (sceneSetId: string): AvatarMirror => ({ sceneSetId, setRevision: 4, scenes: 10, scenesWithoutText: 2, continuePhotos: 8, slice: { index: 2, total: 3 }, undrawnScenes: 5, resumableSlots: 3 });

    test("a row with its set's mirror carries every field of the card, and the view passes the contract", () => {
      const file = stampedFile();
      const sceneSetId = file.avatars[0]?.generation?.sceneSetId ?? "";
      const view = parsed(file, base({ mirror: () => mirrorOf(sceneSetId) }));
      expect(view.avatars[0]).toMatchObject({
        sceneSetId,
        setRevision: 4,
        scenes: 10,
        scenesWithoutText: 2,
        continuePhotos: 8,
        slice: { index: 2, total: 3 },
        undrawnScenes: 5,
        resumableSlots: 3,
        drawAllocationMicros: 10 * 210_000,
      });
    });

    test("the dropped count is every dropped video of the row, and its reason the one most of them share", () => {
      const file = stampedFile();
      const row = file.avatars[0];
      if (row === undefined) throw new Error("no row");
      const [v1, v2, v3, v4] = row.videos;
      if (v1 === undefined || v2 === undefined || v3 === undefined || v4 === undefined) throw new Error("no videos");
      const videos = [
        { ...v1, state: "dropped" as const, dropReason: "not-enough-photos" as const },
        { ...v2, state: "dropped" as const, dropReason: "render-failed" as const },
        { ...v3, state: "dropped" as const, dropReason: "render-failed" as const },
        v4,
      ];
      expect(parsed({ ...file, avatars: [{ ...row, videos }] }).avatars[0]?.dropped).toEqual({ count: 3, reason: "render-failed" });
    });

    test("videos waiting for a track are counted per avatar and over the launch", () => {
      const file = stampedFile({ avatarIds: [A, B] });
      const rows = file.avatars.map((row, i) => ({ ...row, videos: row.videos.map((v, j) => (j <= i ? { ...v, state: "waiting-music" as const } : v)) }));
      const view = parsed({ ...file, avatars: rows });
      expect(view.avatars.map((a) => a.waitingMusic)).toEqual([1, 2]);
      expect(view.waitingMusic).toBe(3);
    });

    test("the free hold of the file comes through", () => {
      const hold = { reason: "export", at: "2026-10-09T10:06:00.000Z", detail: { exportReason: "not-enough-space", neededBytes: 5_000_000, freeBytes: 1_000_000 } } as const;
      expect(parsed(stampedFile({}, { freeHold: hold })).freeHold).toEqual(hold);
    });

    test("the review writes and the unsettled reserves come from the context, and read 0 where the context has none", () => {
      const withBoth = parsed(stampedFile(), base({ spentMicros: 90_000, reviewWritesMicros: 12_000, unsettled: { requests: 2, openMicros: 80_000 } }));
      expect(withBoth).toMatchObject({ reviewWritesMicros: 12_000, unsettled: { requests: 2, openMicros: 80_000 } });
      expect(parsed(stampedFile())).toMatchObject({ reviewWritesMicros: 0, unsettled: { requests: 0, openMicros: 0 } });
    });
  });
});
