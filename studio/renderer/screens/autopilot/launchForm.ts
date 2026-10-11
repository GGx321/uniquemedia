import { createContext, useContext } from "react";
import {
  MAX_LAUNCH_AVATARS,
  MAX_VIDEOS_PER_AVATAR,
  orderCategories,
  type CategoryRef,
  type CustomCategoryId,
  type LaunchMix,
  type VideoShape,
} from "../../../shared/engine";
import { arrangeCategories } from "../photos/runForm";

// S4.9a: the «Автопилот» launch form (AutopilotS4.dc.html, columns 1 and 2) as plain data: what the owner chose before «Запустить», the two-handle mix
// control's arithmetic, and the mix the window remembers. Nothing here prices anything: the engine's `autopilot.estimate` does (plan §4.2).

/** The form as the window keeps it: the launch's settings without the seed (the preview draws it). */
export interface LaunchForm {
  readonly avatarIds: readonly string[];
  readonly videosPerAvatar: number;
  readonly mix: LaunchMix;
  readonly categories: readonly CategoryRef[];
  readonly poses: { readonly profile: boolean; readonly back: boolean };
  /** «Сначала свободные фото из библиотеки». */
  readonly library: boolean;
  /** «Догенерировать недостающие». */
  readonly generate: boolean;
  /** «Сцены на проверку». */
  readonly sceneReview: boolean;
  /** «GIF-стикеры». */
  readonly stickers: boolean;
}

/** The owner's mix (plan §5.2): 70 % one photo, 20 % collages, 10 % slides. */
export const DEFAULT_MIX: LaunchMix = { single: 70, collage: 20, slides: 10 };
/** The design's opening count: ten videos per avatar. */
export const DEFAULT_VIDEOS_PER_AVATAR = 10;
export const MIN_VIDEOS_PER_AVATAR = 1;
/** A mix handle moves by 5 % from the keyboard (the design's keyboard table). */
export const MIX_STEP = 5;
/**
 * The categories a first launch asks for: the four everyday built-ins. «Гламур» is opt-in, as the design draws it (AutopilotS4 `D0`), and the owner's
 * own categories are added by a click.
 */
export const DEFAULT_CATEGORIES: readonly CategoryRef[] = ["home", "travel", "shoot", "fit"];

/** A fresh form: nobody chosen yet, the remembered mix, «Сцены на проверку» as the «Фото» screen left it. */
export function defaultForm(sceneReview: boolean, mix: LaunchMix = DEFAULT_MIX): LaunchForm {
  return {
    avatarIds: [],
    videosPerAvatar: DEFAULT_VIDEOS_PER_AVATAR,
    mix,
    categories: DEFAULT_CATEGORIES,
    poses: { profile: false, back: false },
    library: true,
    generate: true,
    sceneReview,
    stickers: false,
  };
}

// ---------- the avatars ----------

/** An avatar chosen or not, the list kept in the screen's own order (`order`: the active avatars as the list shows them). */
export function toggleAvatar(form: LaunchForm, avatarId: string, order: readonly string[]): LaunchForm {
  const on = new Set(form.avatarIds);
  if (on.has(avatarId)) on.delete(avatarId);
  else on.add(avatarId);
  return { ...form, avatarIds: order.filter((id) => on.has(id)) };
}

/** «Все»: every active avatar, at most as many as a launch takes. */
export function selectAll(form: LaunchForm, order: readonly string[]): LaunchForm {
  return { ...form, avatarIds: order.slice(0, MAX_LAUNCH_AVATARS) };
}

export function selectNone(form: LaunchForm): LaunchForm {
  return { ...form, avatarIds: [] };
}

/** «Видео на аватар»: 1 to 50. */
export function stepVideos(form: LaunchForm, delta: number): LaunchForm {
  return { ...form, videosPerAvatar: Math.min(MAX_VIDEOS_PER_AVATAR, Math.max(MIN_VIDEOS_PER_AVATAR, form.videosPerAvatar + delta)) };
}

// ---------- the mix ----------

export type MixHandle = 1 | 2;

/** Where a handle stands on the bar, in percent: the first between «Одно фото» and «Коллаж», the second between «Коллаж» and «Слайды». */
export function handleAt(mix: LaunchMix, handle: MixHandle): number {
  return handle === 1 ? mix.single : mix.single + mix.collage;
}

/**
 * A handle moved to `to` percent. The first handle moves between the bar's start and the second handle (one photo against collages, slides untouched), the
 * second between the first handle and the bar's end (collages against slides). The sum stays 100: there is no «сумма не 100» to report.
 */
export function moveHandle(mix: LaunchMix, handle: MixHandle, to: number): LaunchMix {
  const first = mix.single;
  const second = mix.single + mix.collage;
  const at = Math.round(to);
  if (handle === 1) {
    const next = Math.min(second, Math.max(0, at));
    return { single: next, collage: second - next, slides: mix.slides };
  }
  const next = Math.min(100, Math.max(first, at));
  return { single: mix.single, collage: next - first, slides: 100 - next };
}

/** What a key does to a handle: ← → by 5 %, Home / End to the neighbouring handle or the bar's edge; null for any other key. */
export function mixKey(mix: LaunchMix, handle: MixHandle, key: string): LaunchMix | null {
  const at = handleAt(mix, handle);
  switch (key) {
    case "ArrowLeft":
    case "ArrowDown":
      return moveHandle(mix, handle, at - MIX_STEP);
    case "ArrowRight":
    case "ArrowUp":
      return moveHandle(mix, handle, at + MIX_STEP);
    case "Home":
      return moveHandle(mix, handle, handle === 1 ? 0 : mix.single);
    case "End":
      return moveHandle(mix, handle, handle === 1 ? mix.single + mix.collage : 100);
    default:
      return null;
  }
}

export function isDefaultMix(mix: LaunchMix): boolean {
  return mix.single === DEFAULT_MIX.single && mix.collage === DEFAULT_MIX.collage && mix.slides === DEFAULT_MIX.slides;
}

/** «одно фото 70 %, коллаж 20 %»: what a handle's value says. */
export function handleValueText(mix: LaunchMix, handle: MixHandle): string {
  return handle === 1 ? `одно фото ${mix.single} %, коллаж ${mix.collage} %` : `коллаж ${mix.collage} %, слайды ${mix.slides} %`;
}

const SHAPES: readonly VideoShape[] = ["single", "collage", "slides"];

/**
 * How many videos of each shape one avatar asks for (plan §5.2): the mix applied to the count by largest remainder, a tie going to the earlier shape. The
 * engine plans with the same rule; this only words the note under the bar («На аватар 7 · 2 · 1»). Whole numbers throughout.
 */
export function wantedShapes(total: number, mix: LaunchMix): Record<VideoShape, number> {
  const counts: Record<VideoShape, number> = { single: 0, collage: 0, slides: 0 };
  const rest: { shape: VideoShape; remainder: number; at: number }[] = [];
  let left = total;
  SHAPES.forEach((shape, at) => {
    const share = total * mix[shape];
    counts[shape] = Math.floor(share / 100);
    left -= counts[shape];
    rest.push({ shape, remainder: share % 100, at });
  });
  rest.sort((a, b) => b.remainder - a.remainder || a.at - b.at);
  for (const { shape } of rest.slice(0, left)) counts[shape] += 1;
  return counts;
}

// ---------- the mix, remembered per machine ----------

/** The mix in the viewer's localStorage (plan §5.2: a per-launch control, remembered per viewer). */
export const MIX_KEY = "studio.autopilot.mix";

type MixStorage = Pick<Storage, "getItem" | "setItem">;

/** The viewer's storage, or null where reading it throws (a blocked profile). */
export function mixStorage(): MixStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The remembered mix, or the owner's 70 / 20 / 10 when there is none or it does not read as three whole shares summing 100. */
export function readMix(storage: MixStorage | null): LaunchMix {
  if (storage === null) return DEFAULT_MIX;
  let text: string | null;
  try {
    text = storage.getItem(MIX_KEY);
  } catch {
    return DEFAULT_MIX;
  }
  const match = text === null ? null : /^(\d{1,3})\/(\d{1,3})\/(\d{1,3})$/.exec(text);
  if (match === null) return DEFAULT_MIX;
  const [single, collage, slides] = [match[1], match[2], match[3]].map(Number);
  if (single === undefined || collage === undefined || slides === undefined || single + collage + slides !== 100) return DEFAULT_MIX;
  return { single, collage, slides };
}

/** Keeps the mix. A storage that throws keeps nothing, silently: the mix still holds for this window. */
export function writeMix(storage: MixStorage | null, mix: LaunchMix): void {
  if (storage === null) return;
  try {
    storage.setItem(MIX_KEY, `${mix.single}/${mix.collage}/${mix.slides}`);
  } catch {
    // Blocked, full or gone: the mix holds for this window only.
  }
}

// ---------- what the estimate is asked for ----------

/** The form's settings as `autopilot.estimate` and `autopilot.start` take them (without the seed), or null when there is nothing to plan yet. */
export interface LaunchSettingsInput {
  avatarIds: string[];
  videosPerAvatar: number;
  mix: LaunchMix;
  categories: CategoryRef[];
  poses: { profile: boolean; back: boolean };
  library: boolean;
  generate: boolean;
  sceneReview: boolean;
  stickers: boolean;
}

/**
 * The settings to plan: the chosen avatars in the list's order, the categories the library holds (built-ins in their order, then the owner's in creation
 * order; one deleted since is dropped), and a fresh copy of every list. Null with no avatar or no category: the contract asks for at least one of each.
 */
export function launchSettings(form: LaunchForm, customOrder: readonly CustomCategoryId[]): LaunchSettingsInput | null {
  const categories = orderCategories(arrangeCategories(form.categories, customOrder));
  if (form.avatarIds.length === 0 || categories.length === 0) return null;
  return {
    avatarIds: [...form.avatarIds],
    videosPerAvatar: form.videosPerAvatar,
    mix: { ...form.mix },
    categories,
    poses: { profile: form.poses.profile, back: form.poses.back },
    library: form.library,
    generate: form.generate,
    sceneReview: form.sceneReview,
    stickers: form.stickers,
  };
}

/** A stable identity for the settings: a preview belongs to exactly one. */
export function settingsKey(settings: LaunchSettingsInput): string {
  return JSON.stringify(settings);
}

// ---------- the window keeps the form ----------

/**
 * The form while the window runs: the screen unmounts on every navigation (a look at Settings to raise the budget, the «Фото» link of a blocker), and the
 * owner's choices must not go with it. One per window (App provides it), forgotten on a library switch (its avatars and categories are another library's).
 */
export class LaunchForms {
  #form: LaunchForm | null = null;

  get(): LaunchForm | null {
    return this.#form;
  }

  set(form: LaunchForm): void {
    this.#form = form;
  }

  clear(): void {
    this.#form = null;
  }
}

const LaunchFormsContext = createContext<LaunchForms | null>(null);

export const LaunchFormsProvider = LaunchFormsContext.Provider;

export function useLaunchForms(): LaunchForms {
  const forms = useContext(LaunchFormsContext);
  if (!forms) throw new Error("useLaunchForms must be used inside <LaunchFormsProvider>");
  return forms;
}
