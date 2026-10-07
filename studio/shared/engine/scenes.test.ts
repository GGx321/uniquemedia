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
  SceneWriteTarget,
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

  test("a text is shown whole above the owner's own bound: it may be a writer's accepted sentence, which the run's journal accepts at any length", () => {
    expect(SceneView.safeParse(scene({ text: "a".repeat(SCENE_TEXT_MAX) })).success).toBe(true);
    expect(SceneView.safeParse(scene({ text: "a".repeat(SCENE_TEXT_MAX + 100) })).success).toBe(true);
  });

  test("a text is never empty", () => {
    expect(SceneView.safeParse(scene({ text: "" })).success).toBe(false);
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

// CS.4b: the review-time writes on the contract — the rewrite and idea targets, the resume of an interrupted write, the dismiss op and the per-scene markers.

describe("SceneWriteTarget, CS.4b", () => {
  const ok = (target: unknown) => SceneWriteTarget.safeParse(target).success;

  test("a rewrite names one to five scenes and whether to redraw them", () => {
    expect(ok({ kind: "rewrite", sceneIds: [4], redraw: true })).toBe(true);
    expect(ok({ kind: "rewrite", sceneIds: [1, 2, 3, 4, 5], redraw: false })).toBe(true);
  });

  test("a rewrite of none, of six, of one scene twice, or with no redraw flag is refused", () => {
    expect(ok({ kind: "rewrite", sceneIds: [], redraw: true })).toBe(false);
    expect(ok({ kind: "rewrite", sceneIds: [1, 2, 3, 4, 5, 6], redraw: true })).toBe(false);
    expect(ok({ kind: "rewrite", sceneIds: [2, 2], redraw: true })).toBe(false);
    expect(ok({ kind: "rewrite", sceneIds: [2] })).toBe(false);
  });

  test("an idea is 1..500 chars of any script, for one to five scenes, in a shot or on auto", () => {
    expect(ok({ kind: "idea", idea: "кофе на балконе утром", count: 3, shot: null })).toBe(true);
    expect(ok({ kind: "idea", idea: "я".repeat(500), count: 5, shot: "mirror" })).toBe(true);
  });

  test("an idea that is empty, blank, over 500 chars, for 0 or 6 scenes, or in an unknown shot is refused", () => {
    expect(ok({ kind: "idea", idea: "", count: 1, shot: null })).toBe(false);
    expect(ok({ kind: "idea", idea: "   ", count: 1, shot: null })).toBe(false);
    expect(ok({ kind: "idea", idea: "я".repeat(501), count: 1, shot: null })).toBe(false);
    expect(ok({ kind: "idea", idea: "a walk", count: 0, shot: null })).toBe(false);
    expect(ok({ kind: "idea", idea: "a walk", count: 6, shot: null })).toBe(false);
    expect(ok({ kind: "idea", idea: "a walk", count: 1, shot: "drone" })).toBe(false);
    expect(ok({ kind: "idea", idea: "a walk", count: 1 })).toBe(false);
  });

  test("an idea whose JSON form would weigh more than three bytes a character is refused: it would push the writer's prompt past the ceiling its price was set at", () => {
    // Control characters and lone surrogates JSON-escape to six bytes each; a quote, a newline and a CJK character to at most three.
    expect(ok({ kind: "idea", idea: "\u0001".repeat(500), count: 5, shot: null })).toBe(false);
    expect(ok({ kind: "idea", idea: "\ud800".repeat(500), count: 5, shot: null })).toBe(false);
    expect(ok({ kind: "idea", idea: "中".repeat(500), count: 5, shot: null })).toBe(true);
    expect(ok({ kind: "idea", idea: '"'.repeat(500), count: 5, shot: null })).toBe(true);
    expect(ok({ kind: "idea", idea: "a balcony\nwith coffee\tat dawn", count: 1, shot: null })).toBe(true);
  });

  test("a resume names the write it carries on", () => {
    expect(ok({ kind: "resume", write: 3 })).toBe(true);
    expect(ok({ kind: "resume", write: 0 })).toBe(false);
    expect(ok({ kind: "resume" })).toBe(false);
  });

  test("the scenes still waiting stay a target of their own", () => {
    expect(ok({ kind: "unwritten" })).toBe(true);
  });
});

describe("SceneEditOp dismissInterrupted, CS.4b", () => {
  const ok = (op: unknown) => SceneEditOp.safeParse(op).success;

  test("dismisses by scenes or by write, one of the two", () => {
    expect(ok({ op: "dismissInterrupted", sceneIds: [2, 3] })).toBe(true);
    expect(ok({ op: "dismissInterrupted", write: 4 })).toBe(true);
  });

  test("names neither, both, no scenes, or six scenes: refused", () => {
    expect(ok({ op: "dismissInterrupted" })).toBe(false);
    expect(ok({ op: "dismissInterrupted", sceneIds: [1], write: 4 })).toBe(false);
    expect(ok({ op: "dismissInterrupted", sceneIds: [] })).toBe(false);
    expect(ok({ op: "dismissInterrupted", sceneIds: [1, 2, 3, 4, 5, 6] })).toBe(false);
  });

  test("there is still no op that adds an own scene for free", () => {
    expect(ok({ op: "addOwn", text: "x", shot: "friend", pose: "front" })).toBe(false);
  });
});

describe("the markers of an interrupted write, CS.4b", () => {
  test("a scene carries the write that was interrupted and why", () => {
    expect(SceneView.safeParse(scene({ rewriteInterrupted: { write: 2, stoppedBy: "network" } })).success).toBe(true);
  });

  test("a scene with no marker parses as it did (the field is optional)", () => {
    expect(SceneView.safeParse(scene()).success).toBe(true);
  });

  test("a marker never says 'failed' without being one of the known reasons", () => {
    expect(SceneView.safeParse(scene({ rewriteInterrupted: { write: 2, stoppedBy: "sulking" } })).success).toBe(false);
  });

  test("the set lists an idea write that was interrupted, with what it was asked", () => {
    const idea = { write: 3, idea: "кофе на балконе", count: 2, shot: null, stoppedBy: "closed" };
    expect(SceneSetView.safeParse(view({ interruptedIdeas: [idea] })).success).toBe(true);
    expect(SceneSetView.safeParse(view({ interruptedIdeas: [{ ...idea, count: 6 }] })).success).toBe(false);
  });

  test("an own scene has an idea and no place; a planned scene has a place", () => {
    expect(SceneView.safeParse(scene({ origin: "own", category: "own", categoryName: null, place: null, idea: "кофе на балконе", chunk: null })).success).toBe(true);
  });

  test("a live rewrite names its scenes, and a live idea its count", () => {
    expect(SceneSetView.safeParse(view({ status: "writing", write: { kind: "rewrite", count: 2, sceneIds: [1, 2] } })).success).toBe(true);
    expect(SceneSetView.safeParse(view({ status: "writing", write: { kind: "idea", count: 3 } })).success).toBe(true);
  });
});

describe("scenes.write and scenes.estimateWrite carry the new targets, CS.4b", () => {
  const command = (type: string, payload: unknown) => CommandMessage.safeParse({ v: 5, id: "msg-000001", kind: "command", type, payload }).success;
  const worst = { acceptedWorstMicros: 75_000 };

  test.each([
    { kind: "rewrite", sceneIds: [2], redraw: true },
    { kind: "idea", idea: "кофе на балконе", count: 2, shot: null },
    { kind: "resume", write: 2 },
  ])("scenes.write takes a $kind target", (target) => {
    expect(command("scenes.write", { sceneSetId: SET, revision: 2, target, ...worst })).toBe(true);
    expect(command("scenes.estimateWrite", { sceneSetId: SET, target })).toBe(true);
  });
});
