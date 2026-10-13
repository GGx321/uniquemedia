import { describe, expect, test } from "bun:test";
import { OkResponse } from "./commands";
import { LaunchDraft, LaunchDraftInput, LaunchSettings } from "./autopilot";
import { PROTOCOL_VERSION } from "./envelope";
import { parseEngineCommand } from "./messages";
import { ComposeRequest, SceneSetView, SceneView } from "./scenes";
import { RunRequest } from "./state";
import { SceneLevel } from "./categories";
import { draftSettings } from "./autopilot.fixtures";

// S5.7a (plan s5a2 §6.1): «Подача» (`level`) and the angle from the scene join the contract ADDITIVELY. `poses` stops being required (a request that still
// sends it is accepted and, for the angle, ignored by S5.7b); `level` is new and optional (absent = ordinary). Every shape is tried first in its old form, then
// with the new field, then with it broken. The engine does not act on `level` here: S5.7b implements the mix.

const AVATAR = "avatar-aaaa-0001";
const OLD_POSES = { profile: false, back: false };

const command = (type: string, payload: unknown) => ({ v: PROTOCOL_VERSION, id: "msg-00000001", kind: "command", type, payload });
const accepts = (type: string, payload: unknown): boolean => parseEngineCommand(command(type, payload)).ok;
const answers = (type: string, result: unknown): boolean => OkResponse.safeParse({ v: PROTOCOL_VERSION, id: "msg-00000001", kind: "response", type, ok: true, result }).success;

const run = { avatarId: AVATAR, count: 5, categories: ["home"] };
const compose = { avatarId: AVATAR, count: 5, categories: ["home"] };

describe("SceneLevel", () => {
  test("is ordinary, flirty or bold", () => {
    expect(SceneLevel.safeParse("ordinary").success).toBe(true);
    expect(SceneLevel.safeParse("flirty").success).toBe(true);
    expect(SceneLevel.safeParse("bold").success).toBe(true);
  });

  test("refuses a level that is none of the three", () => {
    expect(SceneLevel.safeParse("daring").success).toBe(false);
  });

  test("refuses an empty string and a non-string", () => {
    expect(SceneLevel.safeParse("").success).toBe(false);
    expect(SceneLevel.safeParse(1).success).toBe(false);
  });
});

describe("RunRequest", () => {
  test("still parses with the old poses", () => {
    expect(RunRequest.safeParse({ ...run, poses: OLD_POSES }).success).toBe(true);
  });

  test("parses without poses", () => {
    expect(RunRequest.safeParse(run).success).toBe(true);
  });

  test("parses with a level, flirty or ordinary, with or without poses", () => {
    expect(RunRequest.safeParse({ ...run, level: "flirty" }).success).toBe(true);
    expect(RunRequest.safeParse({ ...run, level: "ordinary", poses: OLD_POSES }).success).toBe(true);
  });

  test("accepts bold", () => {
    expect(RunRequest.safeParse({ ...run, level: "bold" }).success).toBe(true);
  });

  test("still refuses poses that are not a profile/back pair", () => {
    expect(RunRequest.safeParse({ ...run, poses: { profile: true } }).success).toBe(false);
  });

  test("the commands built on it take the same shapes", () => {
    const worst = { acceptedWorstMicros: 1_000_000 };
    for (const type of ["runs.estimate", "runs.start"]) {
      const extra = type === "runs.start" ? worst : {};
      expect(accepts(type, { ...run, poses: OLD_POSES, ...extra })).toBe(true);
      expect(accepts(type, { ...run, ...extra })).toBe(true);
      expect(accepts(type, { ...run, level: "flirty", ...extra })).toBe(true);
      expect(accepts(type, { ...run, level: "bold", ...extra })).toBe(true);
    }
  });
});

describe("ComposeRequest", () => {
  test("still parses with the old poses", () => {
    expect(ComposeRequest.safeParse({ ...compose, poses: OLD_POSES }).success).toBe(true);
  });

  test("parses without poses and with a level", () => {
    expect(ComposeRequest.safeParse(compose).success).toBe(true);
    expect(ComposeRequest.safeParse({ ...compose, level: "flirty" }).success).toBe(true);
  });

  test("accepts bold", () => {
    expect(ComposeRequest.safeParse({ ...compose, level: "bold" }).success).toBe(true);
  });

  test("the scenes.compose command takes the same shapes", () => {
    const worst = { acceptedWorstMicros: 1_000_000 };
    expect(accepts("scenes.compose", { ...compose, poses: OLD_POSES, ...worst })).toBe(true);
    expect(accepts("scenes.compose", { ...compose, ...worst })).toBe(true);
    expect(accepts("scenes.compose", { ...compose, level: "flirty", ...worst })).toBe(true);
    expect(accepts("scenes.compose", { ...compose, level: "bold", ...worst })).toBe(true);
  });
});

describe("LaunchSettings", () => {
  const { planSeed: _unused, ...settings } = { ...draftSettings, planSeed: 1 };

  test("still parses with the old poses", () => {
    expect(LaunchSettings.safeParse(settings).success).toBe(true);
  });

  test("parses without poses, and with a level", () => {
    const { poses: _poses, ...withoutPoses } = settings;
    expect(LaunchSettings.safeParse(withoutPoses).success).toBe(true);
    expect(LaunchSettings.safeParse({ ...withoutPoses, level: "flirty" }).success).toBe(true);
  });

  test("accepts bold", () => {
    expect(LaunchSettings.safeParse({ ...settings, level: "bold" }).success).toBe(true);
  });

  test("the draft and the estimate's draft take both shapes", () => {
    const { poses: _poses, ...withoutPoses } = settings;
    expect(LaunchDraft.safeParse({ ...settings, planSeed: 3 }).success).toBe(true);
    expect(LaunchDraft.safeParse({ ...withoutPoses, level: "flirty", planSeed: 3 }).success).toBe(true);
    expect(LaunchDraftInput.safeParse(withoutPoses).success).toBe(true);
    expect(accepts("autopilot.estimate", { draft: withoutPoses })).toBe(true);
    expect(accepts("autopilot.estimate", { draft: { ...withoutPoses, level: "bold" } })).toBe(true);
  });
});

const place = { location: "a kitchen", timeOfDay: "morning", activity: "pouring coffee", outfit: "a linen shirt" };
const scene = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  sceneId: 1,
  origin: "planned",
  category: "home",
  categoryName: null,
  shot: "friend",
  pose: "front",
  place,
  idea: null,
  text: "A friend catches her laughing at the counter.",
  edited: false,
  removed: false,
  unwritten: null,
  gaveUpBy: null,
  chunk: 1,
  ...over,
});

describe("SceneView level and capture", () => {
  test("a scene from before them parses and gains no field", () => {
    const parsed = SceneView.parse(scene());
    expect("level" in parsed).toBe(false);
    expect("capture" in parsed).toBe(false);
  });

  test("a flirty scene and a scene with a capture parse", () => {
    expect(SceneView.safeParse(scene({ level: "flirty" })).success).toBe(true);
    expect(SceneView.safeParse(scene({ capture: "timer" })).success).toBe(true);
  });

  test("ordinary is the absence of a level, never a stored value", () => {
    expect(SceneView.safeParse(scene({ level: "ordinary" })).success).toBe(false);
  });

  test("accepts bold and refuses an unknown capture", () => {
    expect(SceneView.safeParse(scene({ level: "bold" })).success).toBe(true);
    expect(SceneView.safeParse(scene({ capture: "drone" })).success).toBe(false);
  });
});

describe("SceneSetView poses", () => {
  const view = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    sceneSetId: "set-aaaa-0001",
    avatarId: AVATAR,
    createdAt: "2026-10-07T10:00:00.000Z",
    revision: 1,
    status: "ready",
    stoppedBy: null,
    stoppedError: null,
    runId: null,
    poses: OLD_POSES,
    categories: [{ ref: "home", name: null }],
    textModel: "x-ai/grok-4.3",
    spentMicros: 11_000,
    openReserveMicros: 0,
    write: null,
    lastCompose: { total: 1, written: 1, gaveUp: 0 },
    chunks: [{ chunk: 1, sceneIds: [1], attemptsLeft: 1, gaveUpBy: null }],
    scenes: [scene()],
    ...over,
  });

  test("parses with the stored poses, as before", () => {
    expect(SceneSetView.safeParse(view()).success).toBe(true);
  });

  test("parses without poses, with a level, and accepts bold", () => {
    const { poses: _poses, ...withoutPoses } = view();
    expect(SceneSetView.safeParse(withoutPoses).success).toBe(true);
    expect(SceneSetView.safeParse({ ...withoutPoses, level: "flirty" }).success).toBe(true);
    expect(SceneSetView.safeParse({ ...withoutPoses, level: "bold" }).success).toBe(true);
  });

  test("the scenes.get answer carries a set without poses", () => {
    const { poses: _poses, ...withoutPoses } = view();
    expect(answers("scenes.get", { sceneSet: withoutPoses, unreadable: 0 })).toBe(true);
  });
});
