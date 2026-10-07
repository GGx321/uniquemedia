import type { SceneSetView, SceneView } from "../../../shared/engine";

// CS.6 unit-test fixtures: a scene and a set as the engine's view gives them, with only what a test changes spelled out.

export function scene(sceneId: number, patch: Partial<SceneView> = {}): SceneView {
  const own = patch.origin === "own";
  const text = patch.text === undefined ? `Scene ${sceneId} text.` : patch.text;
  return {
    sceneId,
    origin: own ? "own" : "planned",
    category: own ? "own" : "home",
    categoryName: null,
    shot: "friend",
    pose: "front",
    place: own ? null : { location: "a sunny kitchen", timeOfDay: "morning", activity: "pouring coffee", outfit: "a linen shirt" },
    idea: own ? "Утренний кофе на балконе с видом на море" : null,
    text,
    edited: false,
    removed: false,
    unwritten: text === null ? "pending" : null,
    gaveUpBy: null,
    chunk: own ? null : Math.ceil(sceneId / 25),
    ...patch,
  };
}

export function gaveUp(sceneId: number, by: NonNullable<SceneView["gaveUpBy"]> = "rejected", patch: Partial<SceneView> = {}): SceneView {
  return scene(sceneId, { text: null, unwritten: "gave-up", gaveUpBy: by, ...patch });
}

export function pending(sceneId: number, patch: Partial<SceneView> = {}): SceneView {
  return scene(sceneId, { text: null, unwritten: "pending", ...patch });
}

export function sceneSet(scenes: readonly SceneView[], patch: Partial<SceneSetView> = {}): SceneSetView {
  return {
    sceneSetId: "set-0001",
    avatarId: "avatar-mia-0001",
    createdAt: "2026-10-05T14:02:00.000Z",
    revision: 3,
    status: "ready",
    stoppedBy: null,
    stoppedError: null,
    runId: null,
    poses: { profile: false, back: false },
    categories: [{ ref: "home", name: null }],
    textModel: "x-ai/grok-4.3",
    spentMicros: 9_150,
    openReserveMicros: 0,
    write: null,
    lastCompose: null,
    chunks: [],
    scenes: [...scenes],
    ...patch,
  };
}

/** `n` written planned scenes, ids 1..n. */
export function written(n: number, from = 1): SceneView[] {
  return Array.from({ length: n }, (_, i) => scene(from + i));
}
