import {
  isCustomCategory,
  MAX_COMPOSE_SCENES,
  type CategoryRef,
  type EngineError,
  type PoolShot,
  type SceneLiveWrite,
  type SceneSetView,
  type SceneStoppedBy,
  type SceneView,
} from "../../../shared/engine";
import { CATEGORY_LABEL } from "./runForm";

// CS.6: what the review UI derives from the engine's scene set view (shared/engine/scenes.ts), as pure functions. The view is the engine's: nothing here
// is kept or guessed beyond what it says. The Russian words that go with these numbers are in sceneText.ts.

// ---------- the switch, remembered per machine ----------

/** «Сцены на проверку» in the viewer's localStorage (owner decision 1, 2026-10-07): ON unless it was turned off on this machine. */
export const SCENE_REVIEW_KEY = "studio.photos.sceneReview";

/** What the switch needs of a storage. */
export type SwitchStorage = Pick<Storage, "getItem" | "setItem">;

/** The viewer's storage, or null where reading it throws (a blocked profile). */
export function viewerStorage(): SwitchStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Whether review is on: true unless «off» is stored; a storage that cannot be read reads ON. */
export function readSceneReview(storage: SwitchStorage | null): boolean {
  if (storage === null) return true;
  try {
    return storage.getItem(SCENE_REVIEW_KEY) !== "off";
  } catch {
    return true;
  }
}

/** Keeps the switch's position. A storage that throws keeps nothing, silently: the switch is a convenience, it works for this window anyway. */
export function writeSceneReview(storage: SwitchStorage | null, on: boolean): void {
  if (storage === null) return;
  try {
    storage.setItem(SCENE_REVIEW_KEY, on ? "on" : "off");
  } catch {
    // Blocked, full or gone: the position holds for this window only.
  }
}

// ---------- labels ----------

/** The design's shot names (Photos.dc.html's legend). */
export const SHOT_LABEL: Record<PoolShot, string> = {
  friend: "Подруга снимает",
  selfie: "Селфи",
  mirror: "Зеркало",
  candid: "Кэндид",
  photographer: "Фотограф",
};

export const OWN_SCENE_LABEL = "Своя сцена";
/** A custom category whose name the set's snapshot did not keep (it always does; the contract allows null). */
const CUSTOM_FALLBACK = "Своя категория";

/** «02», «26», «120»: the artboards' scene numbers. */
export function sceneNumber(sceneId: number): string {
  return String(sceneId).padStart(2, "0");
}

/** A scene's category tag: a built-in by the app's own label, a custom one by the set's snapshot of its name, an own scene «Своя сцена». */
export function sceneCategoryLabel(scene: Pick<SceneView, "category" | "categoryName">): string {
  if (scene.category === "own") return OWN_SCENE_LABEL;
  if (isCustomCategory(scene.category)) return scene.categoryName ?? CUSTOM_FALLBACK;
  return CATEGORY_LABEL[scene.category];
}

/** A Cyrillic letter anywhere: the edit field's hint that such a text goes into the prompt as it is. */
export function hasCyrillic(text: string): boolean {
  return /[Ѐ-ӿ]/.test(text);
}

// ---------- counts ----------

export interface SceneTally {
  /** Every scene of the set, removed ones included. */
  readonly total: number;
  /** Not removed: what a run would draw. */
  readonly active: number;
  readonly removed: number;
  /** Active with a text: the «Отрисовать M фото». */
  readonly withText: number;
  /** Active and still waiting for its write («ждёт»): what «Дописать» writes. */
  readonly pending: number;
  /** Active and given up on («не составлена»). */
  readonly gaveUp: number;
  /** Own scenes (any), for the recompose dialog. */
  readonly own: number;
}

export function tallyScenes(scenes: readonly SceneView[]): SceneTally {
  const active = scenes.filter((s) => !s.removed);
  return {
    total: scenes.length,
    active: active.length,
    removed: scenes.length - active.length,
    withText: active.filter((s) => s.text !== null).length,
    pending: active.filter((s) => s.unwritten === "pending").length,
    gaveUp: active.filter((s) => s.unwritten === "gave-up").length,
    own: scenes.filter((s) => s.origin === "own").length,
  };
}

// ---------- the card's button ----------

/** Why «Отрисовать» waits. */
export type ApproveBlock =
  | { readonly kind: "writing"; readonly write: SceneLiveWrite }
  | { readonly kind: "no-text"; readonly first: number; readonly others: number }
  | { readonly kind: "empty" }
  | { readonly kind: "too-many"; readonly photos: number };

/** What the card's button does for an open set: wait for a compose or «Дописать», «Дописать» what still waits, or «Отрисовать». */
export type SetAction =
  | { readonly kind: "writing"; readonly write: SceneLiveWrite }
  | { readonly kind: "continue"; readonly scenes: number }
  | { readonly kind: "approve"; readonly photos: number; readonly block: ApproveBlock | null };

export function setAction(set: SceneSetView): SetAction {
  const write = set.write;
  if (write !== null && (write.kind === "compose" || write.kind === "unwritten")) return { kind: "writing", write };
  const tally = tallyScenes(set.scenes);
  if (tally.pending > 0) return { kind: "continue", scenes: tally.pending };
  const photos = tally.withText;
  if (write !== null) return { kind: "approve", photos, block: { kind: "writing", write } };
  const blank = set.scenes.filter((s) => !s.removed && s.text === null);
  const [first] = blank;
  if (first !== undefined) return { kind: "approve", photos, block: { kind: "no-text", first: first.sceneId, others: blank.length - 1 } };
  if (photos === 0) return { kind: "approve", photos, block: { kind: "empty" } };
  if (photos > MAX_COMPOSE_SCENES) return { kind: "approve", photos, block: { kind: "too-many", photos } };
  return { kind: "approve", photos, block: null };
}

// ---------- the column's bulk actions ----------

/** «Убрать N пустых»: every active scene with no text (waiting or given up), in one `remove`. */
export function emptySceneIds(set: SceneSetView): number[] {
  return set.scenes.filter((s) => !s.removed && s.text === null).map((s) => s.sceneId);
}

/** At most this many scenes in one rewrite (the contract's `MAX_SCENES_PER_WRITE`). */
const PER_WRITE = 5;

/** «Другие сцены для N»: the first five active scenes given up on, redrawn in one rewrite (README, CS.4b). */
export function otherSceneTargets(set: SceneSetView): number[] {
  return set.scenes
    .filter((s) => !s.removed && s.unwritten === "gave-up")
    .slice(0, PER_WRITE)
    .map((s) => s.sceneId);
}

/** A rewrite left unresolved: its scenes (the removed ones named apart: the engine resumes none while one is removed). */
export interface InterruptedRewrite {
  readonly write: number;
  readonly stoppedBy: SceneStoppedBy;
  readonly sceneIds: readonly number[];
  readonly removed: readonly number[];
}

/** The scenes' markers grouped by the write that left them, oldest write first. */
export function interruptedRewrites(set: SceneSetView): InterruptedRewrite[] {
  const groups = new Map<number, { stoppedBy: SceneStoppedBy; sceneIds: number[]; removed: number[] }>();
  for (const scene of set.scenes) {
    const marker = scene.rewriteInterrupted;
    if (marker === undefined) continue;
    const group = groups.get(marker.write) ?? { stoppedBy: marker.stoppedBy, sceneIds: [], removed: [] };
    group.sceneIds.push(scene.sceneId);
    if (scene.removed) group.removed.push(scene.sceneId);
    groups.set(marker.write, group);
  }
  return [...groups.entries()].sort(([a], [b]) => a - b).map(([write, group]) => ({ write, ...group }));
}

/** The placeholders of an idea write that runs: as many as it writes, numbered after the set's last scene (README «Keyboard and focus»). */
export function placeholderIds(set: SceneSetView): number[] {
  const write = set.write;
  if (write === null || write.kind !== "idea") return [];
  const last = set.scenes.reduce((max, s) => Math.max(max, s.sceneId), 0);
  return Array.from({ length: write.count }, (_, i) => last + 1 + i);
}

export interface SetCategoryTag {
  readonly ref: CategoryRef;
  readonly label: string;
  /** The active planned scenes drawn from it. */
  readonly count: number;
}

/** The strip's tags: the set's own snapshot of its categories (a rename or a delete since changes none), with their active scenes. */
export function setCategoryTags(set: SceneSetView): SetCategoryTag[] {
  return set.categories.map(({ ref, name }) => ({
    ref,
    label: isCustomCategory(ref) ? (name ?? CUSTOM_FALLBACK) : CATEGORY_LABEL[ref],
    count: set.scenes.filter((s) => !s.removed && s.category === ref).length,
  }));
}

// ---------- refusals ----------

/** The engine's refusal of a write once a set recorded its 500 review writes (engine/sceneSets/reviewPlan.ts): its own Russian line, not the generic one. */
export function writeCapRefusal(error: EngineError): boolean {
  return error.code === "VALIDATION" && error.sceneReason === "write-record-cap";
}
