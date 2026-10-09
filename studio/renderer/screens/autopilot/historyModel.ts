import {
  isCustomCategory,
  type CategoryRef,
  type DropReason,
  type EngineError,
  type LaunchDraft,
  type LaunchStatus,
  type LaunchSummary,
  type LaunchVideo,
  type LaunchView,
  type LogLine,
  type UnreadableLaunch,
  type VideoShape,
  type VideoSummary,
} from "../../../shared/engine";
import { countOf, NBSP, plural } from "../../lib/format";
import { CATEGORY_LABEL } from "../photos/runForm";
import { clockSeconds, logText, spentUsd } from "./liveModel";
import { ceilingUsd, clockLabel, videosOf } from "./planModel";

// S4.9c: «История запусков», a launch's page and its results worded from the engine's own answers (AutopilotS4.dc.html states history, launch and
// delete-published; LaunchStates «История», «Результаты», «Удалить видео», «Журнал»). Every sum is the engine's (`spentMicros`, W′ = `plannedWorstMicros`),
// only formatted; the renderer adds up counts and sizes for a sentence and nothing else (plan §4.2). Since S4.6g the «Опубликовано» marks and the deleted videos are
// the engine's word on each `LaunchVideo` (`publishedAt`, `publishedUnknown`, `removed`); `videos.list` only gives a finished video its record to draw (poster, time, music).

const AVATARS = ["аватар", "аватара", "аватаров"] as const;
const VIDEOS = ["видео", "видео", "видео"] as const;
const LAUNCHES = ["запуск", "запуска", "запусков"] as const;
const ENTRIES = ["запись", "записи", "записей"] as const;
const MB = 1_000_000;

// ---------- the status of a launch ----------

export type StatusTone = "acc" | "warn" | "ok" | "off";

const STATUS_TAG: Record<LaunchStatus, { readonly text: string; readonly tone: StatusTone }> = {
  running: { text: "идёт", tone: "acc" },
  pausing: { text: "ставим на паузу", tone: "warn" },
  paused: { text: "на паузе", tone: "warn" },
  stopping: { text: "останавливаем", tone: "warn" },
  done: { text: "завершён", tone: "ok" },
  stopped: { text: "остановлен", tone: "off" },
};

/** The tag of a launch's status: «идёт», «на паузе», «завершён», «остановлен». */
export function statusTag(status: LaunchStatus): { readonly text: string; readonly tone: StatusTone } {
  return STATUS_TAG[status];
}

const DAY = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });

/** «8 окт.»: the day a launch started, in the viewer's own time. */
export function dayLabel(iso: string): string {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? iso : DAY.format(at);
}

/** «14:02–14:31» for a launch that ended, «с 14:02» for one that has not. */
export function spanLabel(createdAt: string, endedAt: string | null): string {
  return endedAt === null ? `с ${clockLabel(createdAt)}` : `${clockLabel(createdAt)}–${clockLabel(endedAt)}`;
}

/** A launch that paid for nothing and spent nothing: «бесплатно». One with W′ 0 that still spent (an A2 breach) shows the engine's figures, never hidden. */
export const isFree = (spentMicros: number, plannedWorstMicros: number): boolean => plannedWorstMicros === 0 && spentMicros === 0;

/** «$1.69» and «из $4.14» (W′, the launch's limit), or «$0» and «бесплатно» for a launch that pays for nothing (round 1 M4: «из» is W′ on every screen). */
export function spentOf(spentMicros: number, plannedWorstMicros: number): { readonly spent: string; readonly of: string } {
  return isFree(spentMicros, plannedWorstMicros) ? { spent: "$0", of: "бесплатно" } : { spent: spentUsd(spentMicros), of: `из ${ceilingUsd(plannedWorstMicros)}` };
}

/** The names of a launch's avatars, in its order; one that is gone from the library says so. */
export function launchNames(avatarIds: readonly string[], nameOf: (avatarId: string) => string | null): string[] {
  return avatarIds.map((id) => nameOf(id) ?? "удалённый аватар");
}

// ---------- «История запусков» ----------

export interface HistoryRow {
  readonly launchId: string;
  readonly day: string;
  readonly span: string;
  readonly names: string;
  /** The avatars whose faces stack before the names (the ones the library still holds). */
  readonly faces: readonly string[];
  readonly videos: string;
  readonly spent: string;
  readonly of: string;
  readonly tag: { readonly text: string; readonly tone: StatusTone };
  /** What a screen reader hears for the row's button. */
  readonly aria: string;
}

export function historyRow(summary: LaunchSummary, nameOf: (avatarId: string) => string | null): HistoryRow {
  const day = dayLabel(summary.createdAt);
  const span = spanLabel(summary.createdAt, summary.endedAt);
  const names = launchNames(summary.avatarIds, nameOf).join(", ");
  const videos = `${summary.videosDone} из ${summary.videosPlanned}`;
  const money = spentOf(summary.spentMicros, summary.plannedWorstMicros);
  const tag = statusTag(summary.status);
  return {
    launchId: summary.launchId,
    day,
    span,
    names,
    faces: summary.avatarIds.filter((id) => nameOf(id) !== null),
    videos,
    spent: money.spent,
    of: money.of,
    tag,
    aria: `Запуск ${day}, ${span} · ${names} · ${videos}${NBSP}видео · ${money.spent} ${money.of} · ${tag.text}`,
  };
}

/** «5 запусков · 1 запись не читается · новые сверху». */
export function historySub(launches: number, unreadable: number): string {
  const head = countOf(launches, LAUNCHES);
  const bad = unreadable === 0 ? null : `${countOf(unreadable, ENTRIES)} не ${plural(unreadable, ["читается", "читаются", "читаются"])}`;
  return [head, bad, launches > 1 ? "новые сверху" : null].filter((part) => part !== null).join(" · ");
}

export interface UnreadableEntry {
  readonly title: string;
  readonly text: string;
  /** «Убрать запись» moves the file to the library's quarantine; never for `io-error`: no file could be read, so there is none to move. */
  readonly removable: boolean;
  readonly note: string;
}

const BLOCKS = "Пока она здесь, новый запуск недоступен — она может описывать незаконченный.";

/** An entry of the library's `autopilot/` folder that is not a launch this Studio can read (`autopilot.list` `unreadable`). `scope` (S4.6g) says where an `io-error` failed. */
export function unreadableEntry(reason: UnreadableLaunch["reason"], scope?: UnreadableLaunch["scope"]): UnreadableEntry {
  switch (reason) {
    case "invalid":
      return { title: "Не читается", text: `Запись запуска повреждена. ${BLOCKS}`, removable: true, note: "Файл уйдёт в карантин библиотеки — ничего не удаляется." };
    case "too-new":
      return { title: "Не читается", text: `Запись от более новой Studio. ${BLOCKS}`, removable: true, note: "Файл уйдёт в карантин библиотеки — ничего не удаляется. В новой Studio его можно вернуть." };
    // Nothing is offered to move for an `io-error`: a file nobody could read is not taken anywhere, and a folder is not a file. Since S4.6g the engine says which of the two
    // failed (`scope`) and the words name it; an engine that does not say gets the words that fit both.
    case "io-error":
      if (scope === "file")
        return {
          title: "Не читается",
          text: "Studio не смог открыть файл записи запуска: диск не ответил или нет доступа. Убрать запись нельзя — сначала файл должен прочитаться. Пока так, новый запуск недоступен.",
          removable: false,
          note: "Проверьте диск библиотеки и прочитайте историю снова.",
        };
      if (scope === "folder")
        return {
          title: "Не читается",
          text: "Studio не смог прочитать папку запусков в библиотеке: диск не ответил или нет доступа. Убирать нечего — сначала папка должна открыться. Пока так, новый запуск недоступен.",
          removable: false,
          note: "Проверьте диск библиотеки и прочитайте историю снова.",
        };
      return {
        title: "Не читается",
        text: "Studio не смог прочитать запись запуска с диска: диск не ответил или нет доступа. Убрать её отсюда нельзя — сначала она должна прочитаться. Пока так, новый запуск недоступен.",
        removable: false,
        note: "Проверьте диск библиотеки и прочитайте историю снова.",
      };
  }
}

// ---------- a launch's page ----------

/** «Запуск 8 окт., 14:02». */
export function launchHeading(createdAt: string): string {
  return `Запуск ${dayLabel(createdAt)}, ${clockLabel(createdAt)}`;
}

/** «3 аватара · 28 из 30 видео · потрачено $1.69 из $4.14 · 14:02–14:31». */
export function launchMeta(launch: LaunchView): string {
  const { done, planned } = videosOf(launch);
  const money = isFree(launch.spentMicros, launch.plannedWorstMicros) ? "бесплатно" : `потрачено ${spentUsd(launch.spentMicros)} из ${ceilingUsd(launch.plannedWorstMicros)}`;
  return [countOf(launch.draft.avatarIds.length, AVATARS), `${done} из ${planned}${NBSP}видео`, money, spanLabel(launch.createdAt, launch.endedAt)].join(" · ");
}

/** A category of the draft by its name: a built-in's label, a custom one's name from the library, or «своя категория» for one that is gone. */
export function categoryName(ref: CategoryRef, customName: (categoryId: string) => string | null): string {
  return isCustomCategory(ref) ? (customName(ref) ?? "своя категория") : CATEGORY_LABEL[ref];
}

/** The launch's settings as one wrapping mono line of bits (ApLaunch): what it was run with, read only. */
export function settingsBits(draft: LaunchDraft, customName: (categoryId: string) => string | null): string[] {
  const { mix } = draft;
  const angles = ["анфас и три четверти", ...(draft.poses.profile ? ["профиль"] : []), ...(draft.poses.back ? ["со спины"] : [])].join(", ");
  const source = draft.library && draft.generate ? "сначала библиотека, недостающее — новыми" : draft.library ? "только фото из библиотеки" : "только новые фото";
  return [
    `${draft.videosPerAvatar} на аватар`,
    `одно фото / коллаж / слайды · ${mix.single} / ${mix.collage} / ${mix.slides}`,
    draft.categories.map((ref) => categoryName(ref, customName)).join(", "),
    angles,
    source,
    ...(draft.generate ? [draft.sceneReview ? "сцены на проверку" : "сцены без проверки"] : []),
    "музыка: тренды + мои",
    draft.stickers ? "со стикерами" : "без стикеров",
  ];
}

// ---------- the results ----------

/**
 * What `videos.list` answered for one avatar of the launch: the records to draw a finished video with (its poster, its time, its music, its file's state). It says nothing of
 * which videos were deleted or marked — that is `autopilot.get`'s (S4.6g) — so a list cut at 500 or one that failed costs a tile its picture, never its mark or its trash.
 */
export type AvatarVideos =
  | { readonly state: "ready"; readonly byId: ReadonlyMap<string, VideoSummary> }
  | { readonly state: "failed"; readonly error: EngineError }
  /**
   * Fix round 1: the avatar was deleted after the launch (`videos.list` NOT_FOUND for an avatar the library no longer lists): its tiles stay, inert. The engine (S4.6g) calls
   * such an avatar's finished videos `removed` once it can tell, so this is what shows only while it cannot.
   */
  | { readonly state: "gone" };

/** The avatar's list as the tiles read it: a NOT_FOUND for an avatar the library no longer holds is the avatar gone, not an error to retry. */
export function listOf(list: AvatarVideos | undefined, avatarKnown: boolean): AvatarVideos | undefined {
  return list !== undefined && list.state === "failed" && list.error.code === "NOT_FOUND" && !avatarKnown ? { state: "gone" } : list;
}

export type ResultState = LaunchVideo["state"];

export interface ResultTile {
  readonly key: string;
  readonly avatarId: string;
  /** «Mia · видео 1». */
  readonly name: string;
  /** «видео 1 · Mia», for a screen reader's label of the tile's controls. */
  readonly label: string;
  readonly state: ResultState;
  readonly shape: VideoShape;
  /** The cells of the stand-in poster: 1 for one photo and slides, 2 to 4 for a collage. */
  readonly cells: number;
  /** Slides show their bars on the poster. */
  readonly bars: number;
  readonly length: string;
  readonly meta: string;
  readonly when: string | null;
  readonly music: { readonly text: string; readonly own: boolean } | null;
  readonly videoId: string | null;
  readonly summary: VideoSummary | null;
  readonly published: boolean;
  /** The avatar's «Опубликовано» marks could not be read (S4.6g): the video shows unmarked, and the window says why. */
  readonly markUnknown: boolean;
  /** The avatar was deleted since the launch and the engine could not yet say so: the tile is inert and is no finished video of the count. */
  readonly gone: boolean;
  /** «Опубликовано» and the trash: a finished video whose record stands (the engine's word) and whose avatar is still there. */
  readonly actionable: boolean;
  /** How many photos the video holds: what «отклонить фото» rejects. */
  readonly photos: number;
  /** The line at the foot of a tile that is not finished: «ждёт музыку», «Не собралось: …». */
  readonly status: { readonly text: string; readonly tone: "warn" | "danger" | "faint" } | null;
}

const SHAPE: Record<VideoShape, string> = { single: "одно фото", collage: "коллаж", slides: "слайды" };

/** «одно фото», «коллаж 3», «слайды 6». */
export function shapeText(shape: VideoShape, size: number): string {
  return shape === "single" ? SHAPE.single : `${SHAPE[shape]} ${size}`;
}

/** «7.5 с»: a video's length, to a tenth of a second. */
export function lengthText(ms: number): string {
  return `${(Math.round(ms / 100) / 10).toFixed(1)}${NBSP}с`;
}

/** «1.8 МБ». */
export function megabytesText(bytes: number): string {
  return `${(Math.round(bytes / (MB / 10)) / 10).toFixed(1)}${NBSP}МБ`;
}

/** Why a video of the launch did not come out, as the tile and the summary say it. */
export const DROP_REASON_TEXT: Record<DropReason, string> = {
  "not-enough-photos": "не хватило фото",
  "render-failed": "рендер не удался",
  "avatar-gone": "аватара больше нет",
  "launch-stopped": "запуск остановлен",
  "avatar-skipped": "аватар пропущен",
};

/** The number of a video inside its avatar's part of the launch: the key is «<avatar>-<video>». */
const numberOf = (key: string): string => key.split("-")[1] ?? key;

function musicOf(video: LaunchVideo, summary: VideoSummary | null): { text: string; own: boolean } | null {
  const own = video.track?.source === "own";
  const title = summary?.music?.title ?? video.track?.title ?? null;
  if (title === null) return null;
  const artist = summary?.music?.artist ?? video.track?.artist ?? null;
  return own ? { text: `${title} · мой`, own } : { text: artist === null ? title : `${title} — ${artist}`, own };
}

const WHEN = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** «8 окт., 14:17»: when a video's record was made. */
export function madeAt(iso: string): string {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? iso : WHEN.format(at);
}

/**
 * The launch's videos as tiles, in its own order with the ones that did not come out last. A finished video is drawn with its record from `videos.list` (its poster, its
 * time, its music) when the list holds it; its «Опубликовано» mark and whether it was deleted are the engine's word on the video (S4.6g): a `removed` one is left out, and a
 * mark the engine could not read shows unmarked (`markUnknown`). A list that is cut or failed leaves the tile without its picture, nothing else. An avatar deleted since that
 * the engine could not yet call removed (`gone`) keeps its tiles, inert: no mark, no trash, «аватар удалён», and none of them is counted.
 */
export function resultTiles(videos: readonly LaunchVideo[], lists: ReadonlyMap<string, AvatarVideos>, nameOf: (avatarId: string) => string): ResultTile[] {
  const tiles: ResultTile[] = [];
  for (const video of videos) {
    const list = lists.get(video.avatarId);
    const ready = list?.state === "ready" ? list : null;
    const gone = list?.state === "gone";
    const summary = video.videoId === null || ready === null ? null : (ready.byId.get(video.videoId) ?? null);
    if (video.state === "done" && video.removed === true) continue;
    const name = nameOf(video.avatarId);
    const number = numberOf(video.key);
    const done = video.state === "done" && !gone;
    const markUnknown = done && video.publishedUnknown === true;
    const published = done && !markUnknown && video.publishedAt !== null;
    const shape = shapeText(video.shape, video.size);
    const meta =
      video.state === "waiting-music"
        ? `${shape} · ждёт трек`
        : video.state === "dropped"
          ? `${shape} → не собралось`
          : video.bytes !== null
            ? `${shape} · ${megabytesText(video.bytes)}`
            : video.state === "rendering"
              ? `${shape} · рендер`
              : shape;
    tiles.push({
      key: video.key,
      avatarId: video.avatarId,
      name: `${name} · видео ${number}`,
      label: `видео ${number} · ${name}`,
      state: video.state,
      shape: video.shape,
      cells: video.shape === "collage" ? video.size : 1,
      bars: video.shape === "slides" ? video.size : 0,
      length: video.durationMs === null ? "—" : lengthText(video.durationMs),
      meta,
      when: summary === null ? null : madeAt(summary.createdAt),
      music: musicOf(video, summary),
      videoId: video.videoId,
      summary,
      published,
      markUnknown,
      gone,
      actionable: done && video.videoId !== null,
      photos: summary?.photoCount ?? video.size,
      status: gone
        ? { text: "аватар удалён", tone: "faint" }
        : video.state === "waiting-music"
          ? { text: "ждёт музыку", tone: "warn" }
          : video.state === "dropped" && video.dropReason !== null
            ? { text: `Не собралось: ${DROP_REASON_TEXT[video.dropReason]}.`, tone: "danger" }
            : null,
    });
  }
  return [...tiles.filter((t) => t.state !== "dropped"), ...tiles.filter((t) => t.state === "dropped")];
}

export interface ResultCounts {
  /** Finished videos shown, all and per avatar (the filter's numbers). */
  readonly done: number;
  readonly byAvatar: ReadonlyMap<string, number>;
  readonly published: number;
  /** «61 МБ»: the finished videos' sizes added up. */
  readonly megabytes: string;
}

export function resultCounts(tiles: readonly ResultTile[]): ResultCounts {
  const finished = tiles.filter((t) => t.state === "done" && !t.gone);
  const byAvatar = new Map<string, number>();
  for (const t of finished) byAvatar.set(t.avatarId, (byAvatar.get(t.avatarId) ?? 0) + 1);
  const bytes = finished.reduce((sum, t) => sum + (t.summary?.bytes ?? 0), 0);
  return { done: finished.length, byAvatar, published: finished.filter((t) => t.published).length, megabytes: `${Math.round(bytes / MB)}${NBSP}МБ` };
}

/** «2 видео не собрались: у Sofia — не хватило фото.»; null when every video came out. */
export function droppedLine(videos: readonly LaunchVideo[], nameOf: (avatarId: string) => string): string | null {
  const dropped = videos.filter((v) => v.state === "dropped" && v.dropReason !== null);
  if (dropped.length === 0) return null;
  const groups = new Map<string, { avatarId: string; reason: DropReason; count: number }>();
  for (const v of dropped) {
    const reason = v.dropReason ?? "not-enough-photos";
    const id = `${v.avatarId}:${reason}`;
    const group = groups.get(id) ?? { avatarId: v.avatarId, reason, count: 0 };
    groups.set(id, { ...group, count: group.count + 1 });
  }
  const many = groups.size > 1;
  const parts = [...groups.values()].map((g) => `у ${nameOf(g.avatarId)} — ${DROP_REASON_TEXT[g.reason]}${many ? ` (${g.count})` : ""}`);
  return `${countOf(dropped.length, VIDEOS)} не ${plural(dropped.length, ["собралось", "собрались", "собрались"])}: ${parts.join("; ")}.`;
}

/** The notice over the tiles while an avatar's «Опубликовано» marks cannot be read (LaunchStates «Результаты», L8). */
export function marksUnknownText(names: readonly string[], all: boolean): string {
  const whose = all || names.length === 0 ? "" : ` у ${names.join(", ")}`;
  return `Отметки «Опубликовано»${whose} не читаются — эти видео показаны без отметки. Studio по ним ничего не удаляет; новая отметка допишется.`;
}

// ---------- the launch's log ----------

export interface JournalRow {
  readonly key: string;
  readonly at: string;
  readonly who: string;
  readonly text: string;
  readonly tone: string;
}

/** The launch's whole log as `autopilot.get` answers it (the newest ≤ 500), newest first, each line worded by its kind (LaunchStates «Журнал»). */
export function journalRows(log: readonly LogLine[], sceneReview: boolean, nameOf: (avatarId: string) => string): JournalRow[] {
  return log
    .map((line, i) => {
      const { text, tone } = logText(line, sceneReview);
      return { key: `${i}-${line.at}-${line.kind}`, at: clockSeconds(line.at), who: line.avatarId === undefined ? "—" : nameOf(line.avatarId), text, tone };
    })
    .reverse();
}

/** «214 записей», or «последние 500 записей» when the engine cut the log. */
export function journalCount(lines: number, cut: boolean): string {
  return cut ? `последние ${countOf(lines, ENTRIES)}` : countOf(lines, ENTRIES);
}

/**
 * The history's count of finished videos whose records stand, for the card of `launchId` in `status` (S4.6g): a row in another status is the answer of another moment (a
 * `running` one for an ended card), so its count is not shown. Undefined: the card keeps the view's own count.
 */
export function resultsDoneOf(launches: readonly LaunchSummary[] | null, launchId: string, status: LaunchStatus): number | undefined {
  return launches?.find((l) => l.launchId === launchId && l.status === status)?.videosDone;
}

// ---------- «Последний запуск» ----------

/** «7 окт., 18:40 · Mia, Lina · 20 из 20 видео · $1.12 из $3.20» (ApPlan, the right column under the plan). */
export function lastLaunchLine(summary: LaunchSummary, nameOf: (avatarId: string) => string | null): string {
  const money = spentOf(summary.spentMicros, summary.plannedWorstMicros);
  return [
    `${dayLabel(summary.createdAt)}, ${clockLabel(summary.createdAt)}`,
    launchNames(summary.avatarIds, nameOf).join(", "),
    `${summary.videosDone} из ${summary.videosPlanned}${NBSP}видео`,
    isFree(summary.spentMicros, summary.plannedWorstMicros) ? "бесплатно" : `${money.spent} ${money.of}`,
  ].join(" · ");
}
