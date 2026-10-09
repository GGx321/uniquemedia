import type { LaunchAvatarView, LaunchView, RunSummary, SceneLiveWrite, SceneSetView } from "../../../shared/engine";
import { countOf } from "../../lib/format";
import { formatUsdTiered } from "../../lib/money";

// S4.9b: an avatar's scene set on «Фото» when it is a launch's (PhotosS4.dc.html states review, review-paused, overplan, drawing; HostStates «Фото»; plan
// §4.7). The launch's band over the set, «Продолжить запуск: M фото» in place of «Отрисовать», «Сцены принять» while the launch is paused, and «в запуске
// автопилота» wherever a paid action of the set or its batches would be. M, the scenes without text and the draw's allocation are the launch view's own
// (`continuePhotos`, `scenesWithoutText`, `drawAllocationMicros`): nothing is counted or priced here.

export interface LaunchLink {
  readonly launch: LaunchView;
  /** The avatar's row of the launch: its phase and the figures of its set. */
  readonly row: LaunchAvatarView;
}

const PHOTOS = ["фото", "фото", "фото"] as const;
const SCENES_ACC = ["сцену", "сцены", "сцен"] as const;
const TIME = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });
const DAY_TIME = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

const clock = (iso: string): string => {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? iso : TIME.format(at);
};

const unfinished = (launch: LaunchView): boolean => launch.status !== "done" && launch.status !== "stopped";

/**
 * The unfinished launch an avatar's set belongs to, with the avatar's row: the set names the launch (`SceneSetView.launchId`), or the launch's row names the
 * set. Null for the owner's own set, and once the launch has ended (the set is then an ordinary one, §3.7).
 */
export function launchLinkOf(launch: LaunchView | null, avatarId: string, set: SceneSetView | null | undefined): LaunchLink | null {
  if (launch === null || !unfinished(launch) || set === undefined || set === null) return null;
  const row = launch.avatars.find((a) => a.avatarId === avatarId);
  if (row === undefined) return null;
  const linked = (set.launchId !== undefined && set.launchId === launch.launchId) || (row.sceneSetId !== null && row.sceneSetId === set.sceneSetId);
  return linked ? { launch, row } : null;
}

/** The avatar's row of the unfinished launch, set or no set (a batch running for it is the launch's while the row draws). */
export function launchRowOf(launch: LaunchView | null, avatarId: string): LaunchLink | null {
  if (launch === null || !unfinished(launch)) return null;
  const row = launch.avatars.find((a) => a.avatarId === avatarId);
  return row === undefined ? null : { launch, row };
}

/** A batch of a launch (`RunSummary.launchId`): «Продолжить» and «Отменить» are the launch's («в запуске автопилота»). */
export function isLaunchRun(run: RunSummary): boolean {
  return run.launchId !== undefined;
}

/**
 * Whether the run drawing now is the launch's (round 1 M2). Its own `RunSummary.launchId` decides once `runs.list` names it. Before that — a batch the launch
 * has just started — only while the launch runs and the avatar's row draws: an owner's own run, resumed while the launch is paused, keeps its «Отменить».
 */
export function isLaunchBatch(runId: string | null, runs: readonly RunSummary[], link: LaunchLink | null): boolean {
  const listed = runId === null ? undefined : runs.find((r) => r.runId === runId);
  if (listed !== undefined) return isLaunchRun(listed);
  return link !== null && link.launch.status === "running" && link.row.phase === "drawing";
}

/** Whether the launch is paused, or on its way there: a review is then only recorded, the draw waits for «Продолжить» (§3.8, round 1 M7). */
export function launchPaused(launch: LaunchView): boolean {
  return launch.status === "paused" || launch.status === "pausing";
}

/** «Набор запуска от 14:02» and «запуск на паузе · в пределах запуска · до $2.94» (the draw's allocation: no new money is accepted here, §4.7). */
export function bandText(link: LaunchLink): { title: string; meta: string } {
  const allocation = link.row.drawAllocationMicros;
  const parts = [launchPaused(link.launch) ? "запуск на паузе" : null, "в пределах запуска", allocation === null ? null : `до ${formatUsdTiered(allocation, "up")}`];
  return { title: `Набор запуска от ${clock(link.launch.createdAt)}`, meta: parts.filter((p) => p !== null).join(" · ") };
}

/** The strip's set line: «14 сцен · составлен 8 окт., 14:03 · запуск автопилота». */
export function launchSetMeta(base: { count: string; detail: string | null }): string {
  return `${base.count}${base.detail === null ? "" : ` · ${base.detail}`} · запуск автопилота`;
}

/** The right column of a launch's strip, by the avatar's phase. */
export type LaunchGo =
  | {
      readonly kind: "continue";
      readonly paused: boolean;
      readonly help: string;
      readonly title: string;
      readonly sub: string | null;
      readonly why: string | null;
      readonly photos: number;
    }
  | { readonly kind: "accepted"; readonly text: string }
  | { readonly kind: "writing"; readonly text: string }
  | { readonly kind: "in-launch"; readonly text: string }
  | { readonly kind: "stopping"; readonly text: string };

/**
 * What the strip offers. Awaiting review: «Продолжить запуск: M фото» (running) or «Сцены принять: M фото · фото — после «Продолжить»» (paused), with what
 * happens to the scenes without text. Approved while paused: «принято — ждёт «Продолжить»». Scenes being written by the launch: wait. Anything later: the
 * set is the launch's — «в запуске автопилота».
 */
export function launchGo(link: LaunchLink): LaunchGo {
  const { row, launch } = link;
  // L1: «Стоп» is on its way: nothing more is asked of the set; it goes back to «Фото» as an ordinary one once the launch has stopped (§3.7).
  if (launch.status === "stopping") return { kind: "stopping", text: "Запуск останавливается — набор вернётся на «Фото» обычным." };
  const paused = launchPaused(launch);
  const photos = row.continuePhotos ?? 0;
  const without = row.scenesWithoutText ?? 0;
  const scenes = row.scenes ?? photos + without;
  switch (row.phase) {
    case "awaiting-review": {
      const removed = `${countOf(without, SCENES_ACC)} без текста уберём`;
      if (paused) {
        return {
          kind: "continue",
          paused,
          photos,
          help: "Запуск на паузе. Сцены можно принять сейчас — рисовать начнём после «Продолжить».",
          title: `Сцены принять: ${countOf(photos, PHOTOS)}`,
          sub: "фото — после «Продолжить»",
          why: `Фото нарисуем после «Продолжить» в «Автопилоте».${without > 0 ? ` ${removed.charAt(0).toUpperCase()}${removed.slice(1)} — или допишите их, тогда ${scenes}.` : ""}`,
        };
      }
      return {
        kind: "continue",
        paused,
        photos,
        help: "Проверьте сцены — потом запуск сам нарисует фото и соберёт видео.",
        title: `Продолжить запуск: ${countOf(photos, PHOTOS)}`,
        sub: without > 0 ? removed : null,
        why: without > 0 ? `Фото будет на ${without} меньше — или допишите ${without === 1 ? "эту сцену" : "эти сцены"}, тогда ${scenes}.` : null,
      };
    }
    case "approved-waiting":
      return { kind: "accepted", text: `Сцены приняты. ${countOf(photos, PHOTOS)} нарисуем после «Продолжить» в «Автопилоте» — набор уже только для чтения.` };
    case "planned":
    case "composing":
      return { kind: "writing", text: "Сцены пишет запуск — проверить их можно, когда допишутся." };
    default:
      return { kind: "in-launch", text: "Набор стал частью запуска — правки закрыты. Пауза и стоп — в «Автопилоте»." };
  }
}

/** «Сцен больше плана на 1 — уберите 1» (VALIDATION `over-plan`, A16): the plan is the avatar's photos at the launch's start. */
export function overPlanText(row: LaunchAvatarView): string {
  const extra = row.scenes === null ? 0 : row.scenes - row.photos.total;
  const lead = extra > 0 ? `Сцен больше плана на ${extra} — уберите ${extra}.` : "Сцен больше плана — уберите лишние.";
  return `${lead} Запуск не рисует больше, чем принято при «Запустить».`;
}

/** The set's scenes read only once the launch took them (approved, or drawing): the note the «Сцены» column shows instead of the edits; null while they can be edited. */
export function frozenNote(link: LaunchLink): string | null {
  switch (link.row.phase) {
    case "awaiting-review":
    case "planned":
    case "composing":
      return null;
    case "approved-waiting":
      return "Сцены приняты — набор только для чтения, пока идёт запуск.";
    default:
      return "Набор стал частью запуска — правки закрыты.";
  }
}

/**
 * The hint of «в запуске автопилота» where a write of a launch's set would show its «Отменить» (S4.9b L8). The launch's own compose and «Дописать» are its
 * to stop («Пауза», «Стоп»). A rewrite is the owner's own paid click during the review: it runs under its own job, paid apart («Правки сцен»), the launch's
 * «Пауза» and «Стоп» do not stop it, and the engine refuses `scenes.cancel` on a launch's set — so the hint says it finishes by itself.
 */
export function launchWriteHint(kind: SceneLiveWrite["kind"]): string {
  return kind === "rewrite"
    ? "Ваша правка сцен: платится отдельно от запуска («Правки сцен»). «Пауза» и «Стоп» её не останавливают — она допишется сама."
    : "Отменить и продолжить — в «Автопилоте»: «Пауза», «Стоп»";
}

/**
 * The open set that opens «по описанию» by itself (ReviewEmpty): an empty set of the owner's with nothing being written; null for any other. Never a launch's set
 * (S4.9b L2): the launch draws no own scene, and the form armed meanwhile would open on the set once it came back to the owner, scenes or not.
 */
export function emptySetToFill(set: SceneSetView | null | undefined, link: LaunchLink | null): string | null {
  if (link !== null || set === undefined || set === null) return null;
  return set.status !== "used" && set.scenes.length === 0 && set.write === null ? set.sceneSetId : null;
}

/** The running batch's line under its progress: «партия 1 из 1 · до $2.94 · запуск 8 окт., 14:02». */
export function batchNote(link: LaunchLink): string {
  const { row, launch } = link;
  const parts = [
    row.slice === null ? null : `партия ${row.slice.index} из ${row.slice.total}`,
    row.drawAllocationMicros === null ? null : `до ${formatUsdTiered(row.drawAllocationMicros, "up")}`,
    `запуск ${DAY_TIME.format(Date.parse(launch.createdAt))}`,
  ];
  return parts.filter((p) => p !== null).join(" · ");
}
