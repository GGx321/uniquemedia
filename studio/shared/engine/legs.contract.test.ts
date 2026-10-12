import { describe, expect, test } from "bun:test";
import { OkResponse } from "./commands";
import { LaunchDraft, LaunchDraftInput, LaunchSettings } from "./autopilot";
import { draftSettings } from "./autopilot.fixtures";
import { LegsShare } from "./categories";
import { PROTOCOL_VERSION } from "./envelope";
import { parseEngineCommand } from "./messages";
import { ComposeRequest, SceneSetView, SceneView } from "./scenes";
import { RunRequest } from "./state";

// S5.8a (plan s5a2 §7.2): «Ножки» joins the contract ADDITIVELY. `legsShare` (0, 15 or 30) is optional on the four sites that carry a run's presentation (a run
// request, a compose request, a launch's settings, the stored set request), and `framing: "legs"` is optional on a plan slot and on a scene view. Every shape is
// tried first in its old form, then with the new field, then with it broken. Absent reads as «Нет» (0), and is never written as a value that says nothing.

const AVATAR = "avatar-aaaa-0001";

const command = (type: string, payload: unknown) => ({ v: PROTOCOL_VERSION, id: "msg-00000001", kind: "command", type, payload });
const accepts = (type: string, payload: unknown): boolean => parseEngineCommand(command(type, payload)).ok;
const answers = (type: string, result: unknown): boolean => OkResponse.safeParse({ v: PROTOCOL_VERSION, id: "msg-00000001", kind: "response", type, ok: true, result }).success;

const run = { avatarId: AVATAR, count: 5, categories: ["home"] };
const compose = { avatarId: AVATAR, count: 5, categories: ["home"] };

describe("LegsShare", () => {
  test.each([0, 15, 30])("accepts %i", (share) => {
    expect(LegsShare.safeParse(share).success).toBe(true);
  });

  test.each([1, 10, 14, 16, 20, 29, 31, 45, 100, -15, 7.5])("refuses %p: only the three chips exist", (share) => {
    expect(LegsShare.safeParse(share).success).toBe(false);
  });

  test("refuses a string, null and a boolean", () => {
    expect(LegsShare.safeParse("15").success).toBe(false);
    expect(LegsShare.safeParse(null).success).toBe(false);
    expect(LegsShare.safeParse(true).success).toBe(false);
  });
});

describe("RunRequest legsShare", () => {
  test("parses without it, as before", () => {
    expect(RunRequest.safeParse(run).success).toBe(true);
  });

  test.each([0, 15, 30])("parses with %i, beside a level", (legsShare) => {
    expect(RunRequest.safeParse({ ...run, legsShare }).success).toBe(true);
    expect(RunRequest.safeParse({ ...run, legsShare, level: "flirty" }).success).toBe(true);
  });

  test("refuses a share that is not a chip", () => {
    expect(RunRequest.safeParse({ ...run, legsShare: 20 }).success).toBe(false);
  });

  test("the commands built on it take the same shapes", () => {
    const worst = { acceptedWorstMicros: 1_000_000 };
    for (const type of ["runs.estimate", "runs.start"]) {
      const extra = type === "runs.start" ? worst : {};
      expect(accepts(type, { ...run, ...extra })).toBe(true);
      expect(accepts(type, { ...run, legsShare: 15, ...extra })).toBe(true);
      expect(accepts(type, { ...run, legsShare: 20, ...extra })).toBe(false);
    }
  });
});

describe("ComposeRequest legsShare", () => {
  test("parses without it, and with each chip", () => {
    expect(ComposeRequest.safeParse(compose).success).toBe(true);
    for (const legsShare of [0, 15, 30]) expect(ComposeRequest.safeParse({ ...compose, legsShare }).success).toBe(true);
  });

  test("refuses a share that is not a chip", () => {
    expect(ComposeRequest.safeParse({ ...compose, legsShare: 25 }).success).toBe(false);
  });

  test("the scenes.compose command takes the same shapes", () => {
    const worst = { acceptedWorstMicros: 1_000_000 };
    expect(accepts("scenes.compose", { ...compose, ...worst })).toBe(true);
    expect(accepts("scenes.compose", { ...compose, legsShare: 30, ...worst })).toBe(true);
    expect(accepts("scenes.compose", { ...compose, legsShare: 25, ...worst })).toBe(false);
  });
});

describe("LaunchSettings legsShare", () => {
  const { planSeed: _unused, ...settings } = { ...draftSettings, planSeed: 1 };

  test("parses without it, as before", () => {
    expect(LaunchSettings.safeParse(settings).success).toBe(true);
  });

  test("parses with each chip and refuses another share", () => {
    for (const legsShare of [0, 15, 30]) expect(LaunchSettings.safeParse({ ...settings, legsShare }).success).toBe(true);
    expect(LaunchSettings.safeParse({ ...settings, legsShare: 5 }).success).toBe(false);
  });

  test("the draft and the estimate's draft take both shapes", () => {
    expect(LaunchDraft.safeParse({ ...settings, legsShare: 15, planSeed: 3 }).success).toBe(true);
    expect(LaunchDraftInput.safeParse({ ...settings, legsShare: 30 }).success).toBe(true);
    expect(accepts("autopilot.estimate", { draft: { ...settings, legsShare: 15 } })).toBe(true);
    expect(accepts("autopilot.estimate", { draft: { ...settings, legsShare: 16 } })).toBe(false);
  });
});

const place = { location: "her bed", timeOfDay: "evening", activity: "stretches her legs along the bed", outfit: "grey lounge shorts and a fitted tee" };
const scene = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  sceneId: 1,
  origin: "planned",
  category: "home",
  categoryName: null,
  shot: "selfie",
  pose: "front",
  place,
  idea: null,
  text: "On her bed, she stretches her legs.",
  edited: false,
  removed: false,
  unwritten: null,
  gaveUpBy: null,
  chunk: 1,
  ...over,
});

describe("SceneView framing", () => {
  test("a scene from before it parses and gains no field", () => {
    expect("framing" in SceneView.parse(scene())).toBe(false);
  });

  test("a legs scene parses, with its capture beside it", () => {
    const parsed = SceneView.parse(scene({ framing: "legs", capture: "pov-legs" }));
    expect(parsed.framing).toBe("legs");
    expect(parsed.capture).toBe("pov-legs");
  });

  test("refuses a framing that is not legs", () => {
    expect(SceneView.safeParse(scene({ framing: "face" })).success).toBe(false);
    expect(SceneView.safeParse(scene({ framing: "ordinary" })).success).toBe(false);
  });
});

describe("SceneSetView with legs scenes", () => {
  const view = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    sceneSetId: "set-aaaa-0001",
    avatarId: AVATAR,
    createdAt: "2026-10-07T10:00:00.000Z",
    revision: 1,
    status: "ready",
    stoppedBy: null,
    stoppedError: null,
    runId: null,
    categories: [{ ref: "home", name: null }],
    textModel: "x-ai/grok-4.3",
    spentMicros: 0,
    openReserveMicros: 0,
    write: null,
    lastCompose: { total: 1, written: 1, gaveUp: 0 },
    chunks: [{ chunk: 1, sceneIds: [1], attemptsLeft: 1, gaveUpBy: null }],
    scenes: [scene()],
    ...over,
  });

  test("parses without it, and with a legs scene in it", () => {
    expect(SceneSetView.safeParse(view()).success).toBe(true);
    expect(SceneSetView.safeParse(view({ scenes: [scene({ framing: "legs", capture: "pov-legs" })] })).success).toBe(true);
  });

  test("the scenes.get answer carries a legs scene", () => {
    expect(answers("scenes.get", { sceneSet: view({ scenes: [scene({ framing: "legs", capture: "pov-legs" })] }), unreadable: 0 })).toBe(true);
  });
});
