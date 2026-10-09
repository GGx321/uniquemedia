import { describe, expect, test } from "bun:test";
import { launchEstimate } from "../../shared/autopilot/estimate";
import { monthFit } from "../../shared/autopilot/money";
import { LaunchPreview } from "../../shared/engine/autopilot";
import { buildLaunchPreview, DISK_PER_VIDEO_BYTES, SECONDS_PER_NEW_PHOTO, SECONDS_PER_VIDEO, type PreviewInput } from "./preview";
import { planLaunch } from "./planner";
import { avatar, input } from "./testing/planFixtures";
import { A, B, settings, UNIT } from "./testing/launchFixtures";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 4, S4.6a (plan §4.2, §4.4, §9): the preview built from the planner's plan, the launch estimate and the month's room.

const MUSIC = { candidates: 0, ownFlagged: 0, explicitSkipped: 0, autoRefresh: "not-needed", quotaRemaining: null } as const;

function previewInput(over: Partial<PreviewInput> = {}, draftExtra: Parameters<typeof settings>[0] = {}): PreviewInput {
  const draft = settings(draftExtra);
  const plan = planLaunch(input({ draft, avatars: draft.avatarIds.map((avatarId) => avatar([], { avatarId })) }));
  const estimate = launchEstimate(
    plan.avatars.filter((a) => a.blocked === null).map((a) => ({ avatarId: a.avatarId, photos: a.toGenerate })),
    UNIT,
  );
  return { draft, plan, estimate, unit: UNIT, month: { budgetMicros: 10_000_000, committedMicros: 0, freeMicros: 10_000_000 }, busy: new Set(), launchBlockers: [], music: MUSIC, balance: null, freeBytes: null, ...over };
}

describe("buildLaunchPreview", () => {
  test("passes the contract and echoes the plan seed", () => {
    const preview = buildLaunchPreview(previewInput());
    expect(LaunchPreview.safeParse(preview).success).toBe(true);
    expect(preview.planSeed).toBe(77);
  });

  test("one row per avatar with its shapes, its library and new photos and its usage", () => {
    const preview = buildLaunchPreview(previewInput({}, { avatarIds: [A, B] }));
    expect(preview.avatars.map((a) => a.avatarId)).toEqual([A, B]);
    expect(preview.avatars[0]).toMatchObject({ videos: 4, shapes: { single: 2, collage: 1, slides: 1 }, free: 0, fromLibrary: 0, toGenerate: 10, busy: false, blocked: null, usage: { state: "ok" } });
    expect(preview.totals).toEqual({ videos: 8, photosNeeded: 20, fromLibrary: 0, toGenerate: 20 });
  });

  test("the estimate is the launch estimate's, with its price source", () => {
    const base = previewInput({}, { avatarIds: [A, B] });
    const preview = buildLaunchPreview(base);
    expect(preview.estimate).toEqual({ expectedMicros: base.estimate.expectedMicros, worstMicros: base.estimate.worstMicros, prices: "fallback", pricesAsOf: "2026-10-09" });
  });

  test("a shape costs one, three or five expected photos when its photos are new", () => {
    expect(buildLaunchPreview(previewInput()).perShapeExpectedMicros).toEqual({ single: 70_000, collage: 210_000, slides: 350_000 });
  });

  test("without unit prices a shape's cost is zero: nothing is claimed that is not known", () => {
    expect(buildLaunchPreview(previewInput({ unit: null }, { generate: false, library: true })).perShapeExpectedMicros).toEqual({ single: 0, collage: 0, slides: 0 });
  });

  test.each([
    ["fits", 100_000_000],
    ["fits-expected", 1],
    ["short", 0],
  ] as const)("the month's fit is %s when the room is %i µ$ against the expected cost and the worst case", (_name, free) => {
    const base = previewInput();
    const room = _name === "fits-expected" ? base.estimate.expectedMicros : free;
    const month = { budgetMicros: 100_000_000, committedMicros: 100_000_000 - room, freeMicros: room };
    const preview = buildLaunchPreview({ ...base, month });
    expect(preview.month.fit).toBe(monthFit(room, base.estimate.expectedMicros, base.estimate.worstMicros));
    expect(preview.month.fit).toBe(_name);
  });

  test("an avatar the plan blocks is a blocker of its own, and counts for nothing in the totals", () => {
    const draft = settings({ avatarIds: [A, B] });
    const plan = planLaunch(input({ draft, avatars: [avatar([], { avatarId: A, hasOpenSet: true }), avatar([], { avatarId: B })] }));
    const estimate = launchEstimate(
      plan.avatars.filter((a) => a.blocked === null).map((a) => ({ avatarId: a.avatarId, photos: a.toGenerate })),
      UNIT,
    );
    const preview = buildLaunchPreview({ ...previewInput({}, { avatarIds: [A, B] }), draft, plan, estimate });
    expect(preview.blockers).toEqual([{ code: "open-set", avatarId: A }]);
    expect(preview.avatars[0]?.blocked).toBe("open-set");
    expect(preview.totals.videos).toBe(4);
    expect(preview.estimate.worstMicros).toBe(estimate.worstMicros);
  });

  test("the launch's own blockers come after the avatars' and name no avatar", () => {
    const draft = settings({ avatarIds: [A] });
    const plan = planLaunch(input({ draft, avatars: [avatar([], { avatarId: A, hasOpenSet: true })] }));
    const preview = buildLaunchPreview({ ...previewInput(), draft, plan, estimate: launchEstimate([], UNIT), launchBlockers: ["launch-active", "no-key"] });
    expect(preview.blockers).toEqual([{ code: "open-set", avatarId: A }, { code: "launch-active" }, { code: "no-key" }]);
  });

  test("a busy avatar is information, not a blocker", () => {
    const preview = buildLaunchPreview(previewInput({ busy: new Set([A]) }));
    expect(preview.avatars[0]?.busy).toBe(true);
    expect(preview.blockers).toEqual([]);
  });

  test("the disk need is a video's upper bound times the videos, and the time is an estimate from the new photos and the videos", () => {
    const preview = buildLaunchPreview(previewInput({ freeBytes: 5_000_000_000 }));
    expect(preview.disk).toEqual({ neededBytes: 4 * DISK_PER_VIDEO_BYTES, freeBytes: 5_000_000_000 });
    expect(preview.timeSeconds).toBe(10 * SECONDS_PER_NEW_PHOTO + 4 * SECONDS_PER_VIDEO);
  });

  test("the balance and the music card are passed through", () => {
    const balance = { micros: 3_500_000, asOf: "2026-10-09T10:00:00.000Z" };
    const preview = buildLaunchPreview(previewInput({ balance, music: { candidates: 12, ownFlagged: 2, explicitSkipped: 1, autoRefresh: "will", quotaRemaining: 21 } }));
    expect(preview.balance).toEqual(balance);
    expect(preview.music).toEqual({ candidates: 12, ownFlagged: 2, explicitSkipped: 1, autoRefresh: "will", quotaRemaining: 21 });
  });
});
