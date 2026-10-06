import { describe, expect, test } from "bun:test";
import { CommandMessage, OkResponse } from "./commands";
import { ERROR_CODES, ErrorCode } from "./errors";
import { ERROR_MESSAGES_RU } from "./errorMessagesRu";
import { EventMessage } from "./events";
import {
  ComposeRequest,
  MAX_COMPOSE_SCENES,
  MAX_SCENES_PER_SET,
  SCENE_TEXT_MAX,
  SceneEditOp,
  SceneProblem,
  SceneSetView,
  SceneView,
  ScenesResult,
} from "./scenes";
import { JobFailed, JobProgress, JobResult, JobState } from "./state";

// CS.4a: the scene set on the contract — its view, the compose request, the free edit ops, the `scenes` job kind and `scenes.changed`.

const AVATAR = "avatar-aaaa-0001";
const SET = "set-aaaa-0001";
const JOB = "job-aaaa-0001";
const RUN = "run-aaaa-0001";

function scene(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sceneId: 1,
    origin: "planned",
    category: "home",
    categoryName: null,
    shot: "friend",
    pose: "front",
    place: { location: "a kitchen", timeOfDay: "morning", activity: "pouring coffee", outfit: "a linen shirt" },
    idea: null,
    text: "A friend catches her laughing at the counter.",
    edited: false,
    removed: false,
    unwritten: null,
    gaveUpBy: null,
    chunk: 1,
    ...over,
  };
}

function view(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sceneSetId: SET,
    avatarId: AVATAR,
    createdAt: "2026-10-07T10:00:00.000Z",
    revision: 1,
    status: "ready",
    stoppedBy: null,
    stoppedError: null,
    runId: null,
    poses: { profile: false, back: false },
    categories: [{ ref: "home", name: null }],
    textModel: "x-ai/grok-4.3",
    spentMicros: 11_000,
    openReserveMicros: 0,
    write: null,
    lastCompose: { total: 1, written: 1, gaveUp: 0 },
    chunks: [{ chunk: 1, sceneIds: [1], attemptsLeft: 1, gaveUpBy: null }],
    scenes: [scene()],
    ...over,
  };
}

describe("ComposeRequest", () => {
  const base = { avatarId: AVATAR, count: 20, categories: ["home", "travel"], poses: { profile: false, back: false } };

  test("accepts 1..100 scenes of one or more categories", () => {
    expect(ComposeRequest.safeParse(base).success).toBe(true);
    expect(ComposeRequest.safeParse({ ...base, count: MAX_COMPOSE_SCENES }).success).toBe(true);
  });

  test("refuses 101 scenes", () => {
    expect(ComposeRequest.safeParse({ ...base, count: MAX_COMPOSE_SCENES + 1 }).success).toBe(false);
  });

  test("accepts 0 scenes with no category: an empty set", () => {
    expect(ComposeRequest.safeParse({ ...base, count: 0, categories: [] }).success).toBe(true);
  });

  test("refuses scenes with no category", () => {
    expect(ComposeRequest.safeParse({ ...base, categories: [] }).success).toBe(false);
  });

  test("refuses a repeated category", () => {
    expect(ComposeRequest.safeParse({ ...base, categories: ["home", "home"] }).success).toBe(false);
  });

  test("accepts a custom category next to the built-ins", () => {
    expect(ComposeRequest.safeParse({ ...base, categories: ["home", "cat-paris-cafes"] }).success).toBe(true);
  });
});

describe("SceneSetView", () => {
  test("accepts a ready set", () => {
    expect(SceneSetView.safeParse(view()).success).toBe(true);
  });

  test("accepts a stopped set that says why", () => {
    expect(SceneSetView.safeParse(view({ status: "stopped", stoppedBy: "rate-limited" })).success).toBe(true);
  });

  test("refuses a stopped set that does not say why", () => {
    expect(SceneSetView.safeParse(view({ status: "stopped" })).success).toBe(false);
  });

  test("refuses a ready set that names a reason it stopped", () => {
    expect(SceneSetView.safeParse(view({ stoppedBy: "closed" })).success).toBe(false);
  });

  test("accepts a writing set with the write that runs", () => {
    expect(SceneSetView.safeParse(view({ status: "writing", write: { kind: "compose", count: 20 } })).success).toBe(true);
  });

  test("refuses a writing set with no live write, and a live write on a set that is not writing", () => {
    expect(SceneSetView.safeParse(view({ status: "writing" })).success).toBe(false);
    expect(SceneSetView.safeParse(view({ write: { kind: "compose", count: 20 } })).success).toBe(false);
  });

  test("a used set names its run, and only a used set does", () => {
    expect(SceneSetView.safeParse(view({ status: "used", runId: RUN })).success).toBe(true);
    expect(SceneSetView.safeParse(view({ status: "used" })).success).toBe(false);
    expect(SceneSetView.safeParse(view({ runId: RUN })).success).toBe(false);
  });

  test("refuses a stopped error on a set that did not stop by a failure", () => {
    expect(SceneSetView.safeParse(view({ status: "stopped", stoppedBy: "cancelled", stoppedError: { code: "INTERNAL" } })).success).toBe(false);
    expect(SceneSetView.safeParse(view({ status: "stopped", stoppedBy: "failed", stoppedError: { code: "AUTH_INVALID" } })).success).toBe(true);
  });

  test("an open reserve is part of the spend, never above it", () => {
    expect(SceneSetView.safeParse(view({ spentMicros: 37_500, openReserveMicros: 37_500 })).success).toBe(true);
    expect(SceneSetView.safeParse(view({ spentMicros: 10, openReserveMicros: 11 })).success).toBe(false);
  });

  test("an unreadable ledger is a spend and a reserve both unknown, not one of them", () => {
    expect(SceneSetView.safeParse(view({ spentMicros: null, openReserveMicros: null })).success).toBe(true);
    expect(SceneSetView.safeParse(view({ spentMicros: 5, openReserveMicros: null })).success).toBe(false);
  });

  test("holds at most the most scenes a set may have", () => {
    const many = Array.from({ length: MAX_SCENES_PER_SET + 1 }, (_, i) => scene({ sceneId: i + 1 }));
    expect(SceneSetView.safeParse(view({ scenes: many })).success).toBe(false);
  });

  test("a scene id never repeats", () => {
    expect(SceneSetView.safeParse(view({ scenes: [scene(), scene()] })).success).toBe(false);
  });

  test("a chunk's attempts left are 0, 1 or 2", () => {
    expect(SceneSetView.safeParse(view({ chunks: [{ chunk: 1, sceneIds: [1], attemptsLeft: 3, gaveUpBy: null }] })).success).toBe(false);
  });
});

describe("SceneView", () => {
  test("accepts a scene still waiting for its sentence", () => {
    expect(SceneView.safeParse(scene({ text: null, unwritten: "pending" })).success).toBe(true);
  });

  test("a gave-up scene says by what, and only a gave-up scene does", () => {
    expect(SceneView.safeParse(scene({ text: null, unwritten: "gave-up", gaveUpBy: "refused" })).success).toBe(true);
    expect(SceneView.safeParse(scene({ text: null, unwritten: "gave-up" })).success).toBe(false);
    expect(SceneView.safeParse(scene({ text: null, unwritten: "pending", gaveUpBy: "rejected" })).success).toBe(false);
  });

  test("a scene with a text is not unwritten", () => {
    expect(SceneView.safeParse(scene({ unwritten: "pending" })).success).toBe(false);
  });

  test("a scene with no text is unwritten", () => {
    expect(SceneView.safeParse(scene({ text: null })).success).toBe(false);
  });

  test("a planned scene has a place", () => {
    expect(SceneView.safeParse(scene({ place: null })).success).toBe(false);
  });

  test("a custom category's scene carries its name", () => {
    expect(SceneView.safeParse(scene({ category: "cat-paris-cafes", categoryName: "Кофейни Парижа" })).success).toBe(true);
  });

  test("a text is at most the bound", () => {
    expect(SceneView.safeParse(scene({ text: "a".repeat(SCENE_TEXT_MAX) })).success).toBe(true);
    expect(SceneView.safeParse(scene({ text: "a".repeat(SCENE_TEXT_MAX + 1) })).success).toBe(false);
  });
});

describe("SceneEditOp", () => {
  test("accepts a text edit of one scene", () => {
    expect(SceneEditOp.safeParse({ op: "text", sceneId: 3, text: "She waves from the pier." }).success).toBe(true);
  });

  test("accepts removing and restoring one to 100 scenes", () => {
    for (const op of ["remove", "restore"] as const) {
      expect(SceneEditOp.safeParse({ op, sceneIds: [1] }).success).toBe(true);
      expect(SceneEditOp.safeParse({ op, sceneIds: Array.from({ length: 100 }, (_, i) => i + 1) }).success).toBe(true);
    }
  });

  test("refuses removing none or 101, or a scene twice", () => {
    expect(SceneEditOp.safeParse({ op: "remove", sceneIds: [] }).success).toBe(false);
    expect(SceneEditOp.safeParse({ op: "remove", sceneIds: Array.from({ length: 101 }, (_, i) => i + 1) }).success).toBe(false);
    expect(SceneEditOp.safeParse({ op: "remove", sceneIds: [2, 2] }).success).toBe(false);
  });

  test("an unknown op is refused", () => {
    expect(SceneEditOp.safeParse({ op: "addOwn", text: "x" }).success).toBe(false);
  });
});

describe("SceneProblem", () => {
  test("names a reason and the words that broke the rule", () => {
    expect(SceneProblem.safeParse({ reason: "revealing-word", words: ["bikini"] }).success).toBe(true);
    expect(SceneProblem.safeParse({ reason: "empty", words: [] }).success).toBe(true);
  });

  test("refuses a reason the contract does not know", () => {
    expect(SceneProblem.safeParse({ reason: "rude", words: [] }).success).toBe(false);
  });
});

describe("commands", () => {
  const command = (type: string, payload: unknown) => CommandMessage.safeParse({ v: 5, id: "msg-000001", kind: "command", type, payload }).success;
  const worst = { acceptedWorstMicros: 75_000 };

  test("scenes.compose carries the request and the accepted worst case", () => {
    const request = { avatarId: AVATAR, count: 20, categories: ["home"], poses: { profile: false, back: false } };
    expect(command("scenes.compose", { ...request, ...worst })).toBe(true);
    expect(command("scenes.compose", request)).toBe(false);
  });

  test("scenes.compose refuses scenes with no category as the request does", () => {
    expect(command("scenes.compose", { avatarId: AVATAR, count: 5, categories: [], poses: { profile: false, back: false }, ...worst })).toBe(false);
  });

  test("scenes.estimateCompose takes the request alone", () => {
    expect(command("scenes.estimateCompose", { avatarId: AVATAR, count: 20, categories: ["home"], poses: { profile: false, back: false } })).toBe(true);
  });

  test("scenes.write takes the set, its revision, a target and the accepted worst case", () => {
    expect(command("scenes.write", { sceneSetId: SET, revision: 2, target: { kind: "unwritten" }, ...worst })).toBe(true);
    expect(command("scenes.write", { sceneSetId: SET, target: { kind: "unwritten" }, ...worst })).toBe(false);
    expect(command("scenes.write", { sceneSetId: SET, revision: 2, target: { kind: "rewrite" }, ...worst })).toBe(false);
  });

  test("scenes.edit takes the revision the edit was made on", () => {
    expect(command("scenes.edit", { sceneSetId: SET, revision: 2, op: { op: "remove", sceneIds: [4] } })).toBe(true);
    expect(command("scenes.edit", { sceneSetId: SET, op: { op: "remove", sceneIds: [4] } })).toBe(false);
  });

  test.each(["scenes.cancel", "scenes.discard"] as const)("%s names the set", (type) => {
    expect(command(type, { sceneSetId: SET })).toBe(true);
  });

  test("scenes.get names the avatar", () => {
    expect(command("scenes.get", { avatarId: AVATAR })).toBe(true);
  });

  const respond = (type: string, result: unknown) => OkResponse.safeParse({ v: 5, id: "msg-000001", kind: "response", type, ok: true, result }).success;

  test("scenes.edit answers the set or a problem, never both and never neither", () => {
    expect(respond("scenes.edit", { sceneSet: view() })).toBe(true);
    expect(respond("scenes.edit", { problem: { reason: "empty", words: [] } })).toBe(true);
    expect(respond("scenes.edit", { sceneSet: view(), problem: { reason: "empty", words: [] } })).toBe(false);
    expect(respond("scenes.edit", {})).toBe(false);
  });

  test("scenes.get answers the open set or none, and how many files it could not read", () => {
    expect(respond("scenes.get", { sceneSet: view(), unreadable: 0 })).toBe(true);
    expect(respond("scenes.get", { sceneSet: null, unreadable: 2 })).toBe(true);
  });

  test("scenes.compose answers no job for an empty set", () => {
    expect(respond("scenes.compose", { sceneSetId: SET, jobId: null })).toBe(true);
    expect(respond("scenes.compose", { sceneSetId: SET, jobId: JOB })).toBe(true);
  });

  test("scenes.estimateCompose and scenes.estimateWrite answer an estimate", () => {
    const estimate = { expectedMicros: 9_000, worstMicros: 75_000, prices: "fallback", pricesAsOf: "2026-09-24" };
    expect(respond("scenes.estimateCompose", { estimate })).toBe(true);
    expect(respond("scenes.estimateWrite", { estimate })).toBe(true);
  });
});

describe("scenes.changed", () => {
  const event = (payload: unknown) => EventMessage.safeParse({ v: 5, id: "msg-000001", kind: "event", seq: 1, bootId: "boot-0000-aaaa", type: "scenes.changed", payload }).success;

  test("carries the whole set when it changed", () => {
    expect(event({ change: "upserted", sceneSet: view() })).toBe(true);
  });

  test("names the set and its avatar when it is gone", () => {
    expect(event({ change: "removed", sceneSetId: SET, avatarId: AVATAR })).toBe(true);
    expect(event({ change: "removed", sceneSetId: SET })).toBe(false);
  });
});

describe("the scenes job kind", () => {
  const ref = { kind: "scenes", jobId: JOB, sceneSetId: SET, avatarId: AVATAR };

  test("progress counts scenes and never goes past the total", () => {
    expect(JobProgress.safeParse({ ...ref, done: 10, total: 25 }).success).toBe(true);
    expect(JobProgress.safeParse({ ...ref, done: 26, total: 25 }).success).toBe(false);
  });

  test("a failed job names its set and its avatar", () => {
    expect(JobFailed.safeParse({ ...ref, error: { code: "RATE_LIMITED" } }).success).toBe(true);
    expect(JobFailed.safeParse({ kind: "scenes", jobId: JOB, error: { code: "RATE_LIMITED" } }).success).toBe(false);
  });

  test("a result tells how many scenes were written and how many were left", () => {
    const result = { kind: "scenes", sceneSetId: SET, avatarId: AVATAR, written: 25, unwritten: 10 };
    expect(ScenesResult.safeParse(result).success).toBe(true);
    expect(JobResult.safeParse(result).success).toBe(true);
  });

  test("a done job state carries a result of its own set", () => {
    const state = { ...ref, status: "done", done: 25, total: 25, result: { kind: "scenes", sceneSetId: SET, avatarId: AVATAR, written: 25, unwritten: 0 } };
    expect(JobState.safeParse(state).success).toBe(true);
    expect(JobState.safeParse({ ...state, result: { ...state.result, sceneSetId: "set-bbbb-0002" } }).success).toBe(false);
  });

  test("a running job state has no result", () => {
    expect(JobState.safeParse({ ...ref, status: "running", done: 0, total: 25 }).success).toBe(true);
  });
});

describe("SCENES_CHANGED", () => {
  test("is an error code with a Russian text that says nothing was changed", () => {
    expect(ERROR_CODES).toContain("SCENES_CHANGED");
    expect(ErrorCode.safeParse("SCENES_CHANGED").success).toBe(true);
    expect((ERROR_MESSAGES_RU as Record<string, string>).SCENES_CHANGED).toContain("изменён");
  });
});
