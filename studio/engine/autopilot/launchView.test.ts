import { describe, expect, test } from "bun:test";
import { LaunchView } from "../../shared/engine/autopilot";
import type { ViewContext } from "./launchView";
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
    const view = parsed(stampedFile({}, { paidHold: hold }), base({ inFlight: { requests: 2, openMicros: 420_000 }, resumeBlockedBy: "reconcile-required", logTail: tail }));
    expect(view).toMatchObject({ paidHold: hold, inFlight: { requests: 2, openMicros: 420_000 }, resumeBlockedBy: "reconcile-required", logTail: tail });
  });

  test("a library-only avatar has no draw allocation", () => {
    const file = stampedFile({ generate: false });
    expect(parsed(file).avatars[0]?.drawAllocationMicros).toBeNull();
  });
});
