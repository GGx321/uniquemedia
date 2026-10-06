import { z } from "zod";
import { CategoryRef, PhotoCategory, PoolShot, MAX_RUN_CATEGORIES } from "./categories";
import { EngineError } from "./errors";
import { Count, Id, Micros, ModelId } from "./primitives";

// CS.4a: the scene set on the contract. A scene set is one avatar's planned run held BEFORE any image is paid for: the planner's scenes, the sentence
// the scene writer wrote for each (a paid job, chunk by chunk) and the owner's free edits. Pure data: the engine builds the view from the set's file
// and the ledger, and the renderer only draws it.

/** The most scenes a set holds. A compose plans at most `MAX_COMPOSE_SCENES`; the rest of the room is for scenes the owner adds later. */
export const MAX_SCENES_PER_SET = 200;
/** A compose plans at most this many scenes (a run's own most). */
export const MAX_COMPOSE_SCENES = 100;
/** One edit removes or restores at most this many scenes at once. */
export const MAX_SCENES_PER_EDIT = 100;
/** A scene's text is 1..600 chars on one line (technical bounds; the assembler's own word rules apply on top). */
export const SCENE_TEXT_MAX = 600;
/** What an edit's text may weigh before the contract itself refuses it; between `SCENE_TEXT_MAX` and this the engine answers a `too-long` problem. */
export const SCENE_TEXT_INPUT_MAX = 4_000;
/** The scene writer's answered attempts per chunk (money/estimate.ts's `WRITER_CALL.maxAttempts`): `attemptsLeft` is never above it. */
export const SCENE_CHUNK_ATTEMPTS = 2;
/** The scene writer's chunk: at most this many scenes in one request (money/estimate.ts's `WRITER_CALL.slotsPerCall`). */
export const SCENE_CHUNK_SIZE = 25;

/** A scene's id inside its set: stable for the set's life, never reused (a removed scene keeps its id). */
export const SceneId = z.number().int().min(1).max(10_000);
export type SceneId = z.infer<typeof SceneId>;

const unique = (items: readonly unknown[]): boolean => new Set(items).size === items.length;

/** Where a scene came from: drawn by the planner from a category's pool, or the owner's own (a later task adds them). */
export const SceneOrigin = z.enum(["planned", "own"]);
export type SceneOrigin = z.infer<typeof SceneOrigin>;

/**
 * - writing: a scenes job runs for this set now.
 * - stopped: a compose or a «Дописать» did not finish and nothing runs, and something is still left for it to write. Never stored: derived (`stoppedBy` says why).
 * - ready: nothing runs and nothing is waiting to be written (some scenes may be «не составлена»: removed, typed or left as they are).
 * - used: its run was started (the run's folder exists), so it is read-only and names that run.
 */
export const SceneSetStatus = z.enum(["writing", "stopped", "ready", "used"]);
export type SceneSetStatus = z.infer<typeof SceneSetStatus>;

/**
 * Why a write stopped. `closed` is never stored (a dying process cannot write it): a write with no outcome and no live job reads `closed`.
 * `failed` is any other failure (a key, a limit, a ledger problem, our own bug): `stoppedError` says which.
 */
export const SceneStoppedBy = z.enum(["closed", "cancelled", "rate-limited", "provider-error", "network", "timeout", "failed"]);
export type SceneStoppedBy = z.infer<typeof SceneStoppedBy>;

/** Why a scene is «не составлена» for good: two rejected answers, a provider's refusal (final), or every attempt of its chunk is used up. */
export const SceneGaveUpBy = z.enum(["rejected", "refused", "no-attempts"]);
export type SceneGaveUpBy = z.infer<typeof SceneGaveUpBy>;

/** A scene with no text: still waiting for its write («ждёт»), or given up. */
export const SceneUnwritten = z.enum(["pending", "gave-up"]);
export type SceneUnwritten = z.infer<typeof SceneUnwritten>;

/** The poses a scene can have (the face gate's own vocabulary). */
export const ScenePose = z.enum(["front", "three-quarter", "profile", "back"]);
export type ScenePose = z.infer<typeof ScenePose>;

const PlaceText = z.string().min(1).max(120);

/** What the planner drew for a scene: where, when, doing what, wearing what. English, as they go into the prompt. */
export const ScenePlace = z.strictObject({ location: PlaceText, timeOfDay: PlaceText, activity: PlaceText, outfit: PlaceText });
export type ScenePlace = z.infer<typeof ScenePlace>;

/** The idea an own scene was written from (CS.4b): any script, up to 500 chars. */
export const SceneIdea = z.string().min(1).max(500);

export const SceneText = z.string().min(1).max(SCENE_TEXT_MAX);

export const SceneView = z
  .strictObject({
    sceneId: SceneId,
    origin: SceneOrigin,
    category: PhotoCategory,
    /** The owner's name for a custom category (from the set's snapshot); null for a built-in (the renderer owns those names) and for own scenes. */
    categoryName: z.string().min(1).max(40).nullable(),
    shot: PoolShot,
    pose: ScenePose,
    /** Null for an own scene, which has no place. */
    place: ScenePlace.nullable(),
    idea: SceneIdea.nullable(),
    /** The accepted sentence, or the owner's own text; null while nothing is written. */
    text: SceneText.nullable(),
    /** The owner typed the text himself. */
    edited: z.boolean(),
    /** Removed scenes are kept, greyed, until the set is used: a mis-click is undone with «Вернуть». */
    removed: z.boolean(),
    unwritten: SceneUnwritten.nullable(),
    gaveUpBy: SceneGaveUpBy.nullable(),
    /** The writer chunk the scene belongs to (1-based); null for an own scene. */
    chunk: z.number().int().min(1).nullable(),
  })
  .refine((s) => (s.text === null) === (s.unwritten !== null), { message: "a scene is unwritten exactly when it has no text", path: ["unwritten"] })
  .refine((s) => (s.unwritten === "gave-up") === (s.gaveUpBy !== null), { message: "a gave-up scene says by what, and only a gave-up scene does", path: ["gaveUpBy"] })
  .refine((s) => (s.origin === "planned") === (s.place !== null), { message: "a planned scene has a place and an own scene has none", path: ["place"] });
export type SceneView = z.infer<typeof SceneView>;

/** A writer chunk as the owner's «Дописать» sees it: its scenes and how many answered attempts it may still use across ALL jobs of the set. */
export const SceneChunkView = z.strictObject({
  chunk: z.number().int().min(1),
  sceneIds: z.array(SceneId).min(1).max(SCENE_CHUNK_SIZE),
  /** `min(2 − answered, unused ids)`: an open or reconciled reserve counts as answered. 0 means no job will ever ask this chunk again. */
  attemptsLeft: z.number().int().min(0).max(SCENE_CHUNK_ATTEMPTS),
  gaveUpBy: SceneGaveUpBy.nullable(),
});
export type SceneChunkView = z.infer<typeof SceneChunkView>;

/** A category the set was planned from, as the set's own snapshot says (a rename or a delete later changes none of it). */
export const SceneSetCategory = z.strictObject({ ref: CategoryRef, name: z.string().min(1).max(40).nullable() });
export type SceneSetCategory = z.infer<typeof SceneSetCategory>;

/** The write that runs now: placeholders and the task line read it. */
export const SceneLiveWrite = z.strictObject({ kind: z.enum(["compose", "unwritten"]), count: Count });
export type SceneLiveWrite = z.infer<typeof SceneLiveWrite>;

/** Counters of the planned scenes that are not removed: how many, how many have a text, how many are «не составлена». */
export const SceneComposeTally = z.strictObject({ total: Count, written: Count, gaveUp: Count });
export type SceneComposeTally = z.infer<typeof SceneComposeTally>;

export const SceneSetView = z
  .strictObject({
    sceneSetId: Id,
    avatarId: Id,
    createdAt: z.iso.datetime(),
    /** Grows on every change of the file; every edit and every paid write carries the one it was made on. */
    revision: z.number().int().min(1),
    status: SceneSetStatus,
    stoppedBy: SceneStoppedBy.nullable(),
    /** Only when `stoppedBy` is `failed`. */
    stoppedError: EngineError.nullable(),
    /** The run id issued at compose; named only once the set is used. */
    runId: Id.nullable(),
    poses: z.strictObject({ profile: z.boolean(), back: z.boolean() }),
    categories: z.array(SceneSetCategory).max(MAX_RUN_CATEGORIES),
    textModel: ModelId,
    /**
     * What the set cost: its closed attempts and its open reserves that are NOT in flight (an interrupted request, at its worst case until the owner
     * reconciles). A request at the model right now is not in it. Null (with `openReserveMicros`) when the ledger cannot be read.
     */
    spentMicros: Micros.nullable(),
    /** The part of `spentMicros` that is an open reserve: «учтён по худшей цене до сверки» is true exactly when this is above 0. */
    openReserveMicros: Micros.nullable(),
    write: SceneLiveWrite.nullable(),
    lastCompose: SceneComposeTally.nullable(),
    chunks: z.array(SceneChunkView).max(Math.ceil(MAX_SCENES_PER_SET / SCENE_CHUNK_SIZE)),
    scenes: z.array(SceneView).max(MAX_SCENES_PER_SET),
  })
  .refine((v) => (v.status === "stopped") === (v.stoppedBy !== null), { message: "a stopped set says why, and only a stopped set does", path: ["stoppedBy"] })
  .refine((v) => (v.stoppedError !== null) === (v.stoppedBy === "failed"), { message: "the error belongs to a set that stopped by a failure", path: ["stoppedError"] })
  .refine((v) => (v.status === "writing") === (v.write !== null), { message: "a set is writing exactly when it has a live write", path: ["write"] })
  .refine((v) => (v.status === "used") === (v.runId !== null), { message: "a set names its run exactly when it is used", path: ["runId"] })
  .refine((v) => (v.spentMicros === null) === (v.openReserveMicros === null), { message: "the spend and its open reserve are both known or both unknown", path: ["openReserveMicros"] })
  .refine((v) => v.spentMicros === null || v.openReserveMicros === null || v.openReserveMicros <= v.spentMicros, { message: "the open reserve is part of the spend", path: ["openReserveMicros"] })
  .refine((v) => unique(v.scenes.map((s) => s.sceneId)), { message: "a scene id must not repeat", path: ["scenes"] });
export type SceneSetView = z.infer<typeof SceneSetView>;

// ---------- requests ----------

/** What a compose plans: `count` scenes over `categories` (none when the count is 0: an empty set). The same shape as a run's request. */
export const COMPOSE_REQUEST_FIELDS = {
  avatarId: Id,
  count: z.number().int().min(0).max(MAX_COMPOSE_SCENES),
  categories: z.array(CategoryRef).max(MAX_RUN_CATEGORIES).refine(unique, "categories must not repeat"),
  poses: z.strictObject({ profile: z.boolean(), back: z.boolean() }),
};

/** Scenes need a category to be drawn from; an empty set needs none. */
export function composeNeedsCategory(request: { count: number; categories: readonly unknown[] }): boolean {
  return request.count === 0 || request.categories.length > 0;
}
export const COMPOSE_NEEDS_CATEGORY: { message: string; path: string[] } = { message: "name at least one category for the scenes", path: ["categories"] };

export const ComposeRequest = z.strictObject(COMPOSE_REQUEST_FIELDS).refine(composeNeedsCategory, COMPOSE_NEEDS_CATEGORY);
export type ComposeRequest = z.infer<typeof ComposeRequest>;

/** A free change of a set, made on the revision the window shows. */
export const SceneEditOp = z.discriminatedUnion("op", [
  /** The owner's own text for a scene: verbatim, checked at once by the assembler's own rule (`SceneProblem`). On an unwritten scene it makes the scene written. */
  z.strictObject({ op: z.literal("text"), sceneId: SceneId, text: z.string().max(SCENE_TEXT_INPUT_MAX) }),
  /** One or many scenes in one revision (works on written, pending and gave-up scenes). */
  z.strictObject({ op: z.literal("remove"), sceneIds: z.array(SceneId).min(1).max(MAX_SCENES_PER_EDIT).refine(unique, "a scene must not repeat") }),
  z.strictObject({ op: z.literal("restore"), sceneIds: z.array(SceneId).min(1).max(MAX_SCENES_PER_EDIT).refine(unique, "a scene must not repeat") }),
]);
export type SceneEditOp = z.infer<typeof SceneEditOp>;

/** Why a text does not go through: it changes nothing, and the window names the word in Russian. */
export const SCENE_PROBLEM_REASONS = ["empty", "too-long", "not-one-line", "control-char", "youth-word", "revealing-word"] as const;
export const SceneProblem = z.strictObject({
  reason: z.enum(SCENE_PROBLEM_REASONS),
  words: z.array(z.string().min(1).max(64)).max(12),
});
export type SceneProblem = z.infer<typeof SceneProblem>;

/** What a paid write targets. CS.4a writes the scenes still waiting; later tasks add a rewrite and an idea. */
export const SceneWriteTarget = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("unwritten") })]);
export type SceneWriteTarget = z.infer<typeof SceneWriteTarget>;

/** `scenes.get`'s answer: the avatar's newest set (open, or used and read-only), and how many set files could not be read (kept as they are). */
export const ScenesGetResult = z.strictObject({ sceneSet: SceneSetView.nullable(), unreadable: Count });
export type ScenesGetResult = z.infer<typeof ScenesGetResult>;

/** `scenes.edit`'s answer: the set as it is now, or the problem with the text (a normal result: nothing was changed). */
export const ScenesEditResult = z.union([z.strictObject({ sceneSet: SceneSetView }), z.strictObject({ problem: SceneProblem })]);
export type ScenesEditResult = z.infer<typeof ScenesEditResult>;

/** A finished scenes job: how many scenes it wrote and how many of its targets are still without text. */
export const ScenesResult = z.strictObject({
  kind: z.literal("scenes"),
  sceneSetId: Id,
  avatarId: Id,
  written: Count,
  unwritten: Count,
});
export type ScenesResult = z.infer<typeof ScenesResult>;
