import { describe, expect, test } from "bun:test";
import type { LaunchSummary, LaunchVideo, VideoSummary } from "../../../shared/engine";
import { draft as LAUNCH_DRAFT, view as LAUNCH_VIEW } from "../../../shared/engine/autopilot.fixtures";
import {
  dayLabel,
  droppedLine,
  historyRow,
  historySub,
  journalCount,
  lastLaunchLine,
  launchHeading,
  launchMeta,
  listOf as listOfAvatar,
  marksUnknownText,
  resultCounts,
  resultsDoneOf,
  resultTiles,
  settingsBits,
  spanLabel,
  spentOf,
  statusTag,
  unreadableEntry,
  type AvatarVideos,
} from "./historyModel";

// S4.9c: the words of «История запусков», a launch's page and its results (AutopilotS4.dc.html states history and launch; LaunchStates «История»,
// «Результаты»), from the engine's answers. Every sum is the engine's, only formatted; «из» is W′ on every screen (round 1 M4).

const NBSP = " ";
const at = (h: number, m: number, day = 8): string => new Date(2026, 9, day, h, m).toISOString();
const NAMES: Record<string, string> = { "avatar-mia-0001": "Mia", "avatar-sofia-0002": "Sofia", "avatar-elena-0004": "Elena" };
const nameOf = (id: string): string | null => NAMES[id] ?? null;
const named = (id: string): string => NAMES[id] ?? "удалённый аватар";

const summary = (over: Partial<LaunchSummary> = {}): LaunchSummary => ({
  launchId: "launch-00000001",
  createdAt: at(14, 2),
  endedAt: at(14, 31),
  status: "done",
  avatarCount: 3,
  avatarIds: ["avatar-mia-0001", "avatar-sofia-0002", "avatar-elena-0004"],
  videosDone: 28,
  videosPlanned: 30,
  spentMicros: 1_690_000,
  acceptedMicros: 4_140_000,
  plannedWorstMicros: 4_140_000,
  ...over,
});

describe("a row of «История запусков»", () => {
  test("the design's row: day, span, faces and names, videos done of planned, «Потрачено $S из $W′», the status", () => {
    const row = historyRow(summary(), nameOf);
    expect(row).toMatchObject({ day: "8 окт.", span: "14:02–14:31", names: "Mia, Sofia, Elena", videos: "28 из 30", spent: "$1.69", of: "из $4.14", tag: { text: "завершён", tone: "ok" } });
    expect(row.faces).toEqual(["avatar-mia-0001", "avatar-sofia-0002", "avatar-elena-0004"]);
    expect(row.aria).toBe(`Запуск 8 окт., 14:02–14:31 · Mia, Sofia, Elena · 28 из 30${NBSP}видео · $1.69 из $4.14 · завершён`);
  });

  test("«из» is W′ (the plan's worst case at the start), never the accepted sum above it", () => {
    expect(historyRow(summary({ acceptedMicros: 5_000_000, plannedWorstMicros: 4_140_000 }), nameOf).of).toBe("из $4.14");
  });

  test("a launch that paid for nothing reads «$0 бесплатно»; one not ended reads «с 14:02»; a gone avatar says so and has no face", () => {
    const row = historyRow(summary({ plannedWorstMicros: 0, acceptedMicros: 0, spentMicros: 0, status: "running", endedAt: null, avatarIds: ["avatar-mia-0001", "avatar-gone-0009"], avatarCount: 2 }), nameOf);
    expect([row.spent, row.of, row.span, row.names, row.tag.text]).toEqual(["$0", "бесплатно", "с 14:02", "Mia, удалённый аватар", "идёт"]);
    expect(row.faces).toEqual(["avatar-mia-0001"]);
  });

  test("«бесплатно» only when nothing was planned and nothing spent: a spend above a W′ of 0 (an A2 breach) shows the engine's figures (fix round 1)", () => {
    expect(spentOf(0, 0)).toEqual({ spent: "$0", of: "бесплатно" });
    // S4.9d (S4.9c N3): the limit of 0 reads «$0», not «$0.000».
    expect(spentOf(300_000, 0)).toEqual({ spent: "$0.30", of: "из $0" });
    const breach = summary({ plannedWorstMicros: 0, acceptedMicros: 0, spentMicros: 300_000 });
    expect([historyRow(breach, nameOf).spent, historyRow(breach, nameOf).of]).toEqual(["$0.30", "из $0"]);
    expect(historyRow(breach, nameOf).aria).toContain(" · $0.30 из $0 · ");
    expect(lastLaunchLine(breach, nameOf)).toEndWith("$0.30 из $0");
    expect(lastLaunchLine(summary({ plannedWorstMicros: 0, acceptedMicros: 0, spentMicros: 0 }), nameOf)).toEndWith("· бесплатно");
  });

  test("every status has its word and tone", () => {
    expect((["running", "pausing", "paused", "stopping", "done", "stopped"] as const).map((s) => `${statusTag(s).text}/${statusTag(s).tone}`)).toEqual([
      "идёт/acc",
      "ставим на паузу/warn",
      "на паузе/warn",
      "останавливаем/warn",
      "завершён/ok",
      "остановлен/off",
    ]);
  });

  test("the sub line counts launches and unreadable entries", () => {
    expect(historySub(5, 1)).toBe(`5${NBSP}запусков · 1${NBSP}запись не читается · новые сверху`);
    expect(historySub(2, 3)).toBe(`2${NBSP}запуска · 3${NBSP}записи не читаются · новые сверху`);
    expect(historySub(1, 0)).toBe(`1${NBSP}запуск`);
    expect(historySub(0, 2)).toBe(`0${NBSP}запусков · 2${NBSP}записи не читаются`);
  });

  test("dates and spans read in the viewer's own time", () => {
    expect(dayLabel(at(9, 5, 3))).toBe("3 окт.");
    expect(spanLabel(at(16, 5, 3), at(16, 9, 3))).toBe("16:05–16:09");
    expect(spentOf(1_250_000, 4_140_000)).toEqual({ spent: "$1.25", of: "из $4.14" });
    expect(spentOf(2_000, 4_140_000)).toEqual({ spent: "$0.002", of: "из $4.14" });
  });
});

describe("resultsDoneOf (S4.6g L2)", () => {
  const row = (over: Partial<LaunchSummary>): LaunchSummary => ({ launchId: "launch-00000001", createdAt: at(14, 2), endedAt: null, status: "running", avatarCount: 1, avatarIds: ["avatar-mia-0001"], videosDone: 3, videosPlanned: 5, spentMicros: 0, acceptedMicros: 0, plannedWorstMicros: 0, ...over });

  test("takes the history's count for the same launch in the same status", () => {
    expect(resultsDoneOf([row({ status: "done", endedAt: at(14, 31), videosDone: 4 })], "launch-00000001", "done")).toBe(4);
  });

  test("a history row still saying `running` gives an ended card nothing: the stale running count never shows", () => {
    expect(resultsDoneOf([row({})], "launch-00000001", "done")).toBeUndefined();
  });

  test("another launch's row, or no history yet, gives nothing", () => {
    expect(resultsDoneOf([row({ launchId: "launch-00000002", status: "done", endedAt: at(14, 31) })], "launch-00000001", "done")).toBeUndefined();
    expect(resultsDoneOf(null, "launch-00000001", "done")).toBeUndefined();
  });
});

describe("an entry that cannot be read", () => {
  test("a damaged or a newer file can be moved to the quarantine; one that did not read from the disk (a file or the folder) offers nothing to move", () => {
    expect(unreadableEntry("invalid")).toMatchObject({ title: "Не читается", removable: true, note: "Файл уйдёт в карантин библиотеки — ничего не удаляется." });
    expect(unreadableEntry("invalid").text).toBe("Запись запуска повреждена. Пока она здесь, новый запуск недоступен — она может описывать незаконченный.");
    expect(unreadableEntry("too-new")).toMatchObject({ removable: true });
    expect(unreadableEntry("too-new").text).toStartWith("Запись от более новой Studio.");
    const io = unreadableEntry("io-error");
    expect(io.removable).toBe(false);
    expect(io.title).toBe("Не читается");
    // The engine says io-error for the folder AND for one file (fix round 1): the words name neither.
    expect(io.text).toBe("Studio не смог прочитать запись запуска с диска: диск не ответил или нет доступа. Убрать её отсюда нельзя — сначала она должна прочитаться. Пока так, новый запуск недоступен.");
    expect(io.text).not.toContain("Папка");
    expect(io.text).not.toContain("файла не видно");
  });

  test("S4.6g: an io-error of a file names the file, one of the folder names the folder; neither can be moved, and both say the launch is blocked", () => {
    const file = unreadableEntry("io-error", "file");
    const folder = unreadableEntry("io-error", "folder");
    expect(file.removable).toBe(false);
    expect(folder.removable).toBe(false);
    expect(file.text).toBe("Studio не смог открыть файл записи запуска: диск не ответил или нет доступа. Убрать запись нельзя — сначала файл должен прочитаться. Пока так, новый запуск недоступен.");
    expect(folder.text).toBe("Studio не смог прочитать папку запусков в библиотеке: диск не ответил или нет доступа. Убирать нечего — сначала папка должна открыться. Пока так, новый запуск недоступен.");
    expect(file.text).not.toContain("папк");
    expect(folder.text).not.toContain("файл");
    expect(file.note).toBe("Проверьте диск библиотеки и прочитайте историю снова.");
  });

  test("S4.6g: a scope on a damaged or a newer entry changes nothing; no scope keeps the words that fit both", () => {
    expect(unreadableEntry("invalid", "file")).toEqual(unreadableEntry("invalid"));
    expect(unreadableEntry("too-new", "file")).toEqual(unreadableEntry("too-new"));
    expect(unreadableEntry("io-error", undefined)).toEqual(unreadableEntry("io-error"));
  });
});

describe("a launch's page", () => {
  const view = { ...LAUNCH_VIEW, createdAt: at(14, 2), endedAt: at(14, 31), status: "done" as const, paused: null, plannedWorstMicros: 4_140_000, acceptedMicros: 4_140_000, spentMicros: 1_690_000 };

  test("the heading and the meta line", () => {
    expect(launchHeading(at(14, 2))).toBe("Запуск 8 окт., 14:02");
    // The fixture: two avatars, 5 of 10 videos each done, 20 planned.
    expect(launchMeta(view)).toBe(`2${NBSP}аватара · 10 из 20${NBSP}видео · потрачено $1.69 из $4.14 · 14:02–14:31`);
    expect(launchMeta({ ...view, plannedWorstMicros: 0, acceptedMicros: 0, plannedExpectedMicros: 0, spentMicros: 0, remainingMicros: 0 })).toContain(" · бесплатно · ");
    // A W′ of 0 that still spent is never «бесплатно» (fix round 1).
    expect(launchMeta({ ...view, plannedWorstMicros: 0, acceptedMicros: 0, plannedExpectedMicros: 0, spentMicros: 300_000, remainingMicros: 0 })).toContain(" · потрачено $0.30 из $0 · ");
  });

  test("S4.9d (S4.6g L9): an ended launch's header counts the videos the results show — the engine's word on each, deleted ones out — not what the view says it made", () => {
    // The view says 10 were made; the owner deleted three since: the results show 7, and so does the header.
    expect(launchMeta(view, 7)).toBe(`2${NBSP}аватара · 7 из 20${NBSP}видео · потрачено $1.69 из $4.14 · 14:02–14:31`);
    expect(launchMeta(view, 0)).toContain(` · 0 из 20${NBSP}видео · `);
    // Without the engine's count (a launch that still runs), the view's own.
    expect(launchMeta(view, undefined)).toContain(` · 10 из 20${NBSP}видео · `);
  });

  test("the settings line says what the launch ran with", () => {
    const draft = { ...LAUNCH_DRAFT, videosPerAvatar: 10, mix: { single: 70, collage: 20, slides: 10 }, categories: ["home", "travel"] as const, poses: { profile: true, back: false }, library: true, generate: true, sceneReview: true, stickers: false };
    expect(settingsBits({ ...draft, categories: [...draft.categories] }, () => null)).toEqual([
      "10 на аватар",
      "одно фото / коллаж / слайды · 70 / 20 / 10",
      "Дом, Путешествия",
      "анфас и три четверти, профиль",
      "сначала библиотека, недостающее — новыми",
      "сцены на проверку",
      "музыка: тренды + мои",
      "без стикеров",
    ]);
    const custom = settingsBits({ ...draft, categories: ["cat-0a1b2c3d4e5f", "cat-ffffffffffff"], library: false, generate: true, sceneReview: false, stickers: true }, (id) => (id === "cat-0a1b2c3d4e5f" ? "Кофейни Парижа" : null));
    expect(custom).toContain("Кофейни Парижа, своя категория");
    expect(custom).toContain("только новые фото");
    expect(custom).toContain("сцены без проверки");
    expect(custom).toContain("со стикерами");
  });

  test("the log's count says when the engine cut it", () => {
    expect(journalCount(214, false)).toBe(`214${NBSP}записей`);
    expect(journalCount(500, true)).toBe(`последние 500${NBSP}записей`);
  });

  test("«Последний запуск» in one line", () => {
    expect(lastLaunchLine(summary({ createdAt: at(18, 40, 7), endedAt: at(19, 7, 7), avatarIds: ["avatar-mia-0001", "avatar-sofia-0002"], avatarCount: 2, videosDone: 20, videosPlanned: 20, spentMicros: 1_120_000, plannedWorstMicros: 3_200_000 }), nameOf)).toBe(
      `7 окт., 18:40 · Mia, Sofia · 20 из 20${NBSP}видео · $1.12 из $3.20`,
    );
  });
});

describe("the results", () => {
  const MIA = "avatar-mia-0001";
  const SOFIA = "avatar-sofia-0002";
  const record = (videoId: string, over: Partial<VideoSummary> = {}): VideoSummary => ({
    videoId,
    avatarId: MIA,
    kind: "photo",
    durationMs: 7_500,
    bytes: 1_800_000,
    createdAt: at(14, 17),
    relPath: "Mia_mia-0001/2026-10-08_photo_001.mp4",
    fileState: "present",
    montageId: null,
    photoCount: 1,
    music: { title: "Golden Hour Loop", artist: "Lumi", trackId: null },
    hasPoster: false,
    title: null,
    firstClip: null,
    origin: "autopilot",
    launchId: "launch-00000001",
    ...over,
  });
  const video = (key: string, over: Partial<LaunchVideo> = {}): LaunchVideo => ({
    key,
    avatarId: MIA,
    shape: "single",
    size: 1,
    durationMs: 7_500,
    bytes: 1_800_000,
    track: { source: "trending", title: "Golden Hour Loop", artist: "Lumi" },
    state: "done",
    dropReason: null,
    videoId: `video-${key}-0001`,
    publishedAt: null,
    ...over,
  });
  const listOf = (videos: VideoSummary[]): AvatarVideos => ({ state: "ready", byId: new Map(videos.map((v) => [v.videoId, v])) });

  test("a finished video with its record: name, length, shape and size, the track, when, its mark from the engine's word on the video", () => {
    const tiles = resultTiles([video("0-1", { publishedAt: at(15, 0) }), video("0-3", { shape: "slides", size: 6, bytes: 3_100_000, durationMs: 7_800, track: { source: "own", title: "summer-loop.m4a", artist: null } })], new Map([[MIA, listOf([record("video-0-1-0001"), record("video-0-3-0001", { music: { title: "summer-loop.m4a", artist: null, trackId: null } })])]]), named);
    expect(tiles.map((t) => [t.name, t.length, t.meta, t.music?.text, t.published, t.actionable, t.bars])).toEqual([
      ["Mia · видео 1", `7.5${NBSP}с`, `одно фото · 1.8${NBSP}МБ`, "Golden Hour Loop — Lumi", true, true, 0],
      ["Mia · видео 3", `7.8${NBSP}с`, `слайды 6 · 3.1${NBSP}МБ`, "summer-loop.m4a · мой", false, true, 6],
    ]);
    expect(tiles[0]?.label).toBe("видео 1 · Mia");
    expect(tiles[0]?.when).toBe("8 окт., 14:17");
  });

  test("S4.6g: a finished video the engine calls removed leaves, whatever videos.list holds; the others stay", () => {
    const videos = [video("0-1"), video("0-2", { removed: true })];
    const lists = new Map([[MIA, listOf([record("video-0-1-0001"), record("video-0-2-0001")])]]);
    expect(resultTiles(videos, lists, named).map((t) => t.key)).toEqual(["0-1"]);
    expect(resultTiles(videos, new Map(), named).map((t) => t.key)).toEqual(["0-1"]);
  });

  test("S4.6g: a video that videos.list does not hold (a list cut at 500, or a record it cannot show) is still a tile and still actionable: the engine said its record stands", () => {
    const [tile] = resultTiles([video("0-1")], new Map([[MIA, listOf([])]]), named);
    expect([tile?.key, tile?.actionable, tile?.summary === null, tile?.photos]).toEqual(["0-1", true, true, 1]);
  });

  test("S4.6g: the mark is the engine's publishedAt; while the avatar's marks cannot be read the video shows unmarked and says so", () => {
    expect(resultTiles([video("0-1", { publishedAt: at(15, 0) })], new Map([[MIA, listOf([record("video-0-1-0001")])]]), named)[0]).toMatchObject({ published: true, markUnknown: false });
    // A list that holds a mark the engine did not give is not believed: the engine's word is the one.
    expect(resultTiles([video("0-1")], new Map([[MIA, listOf([record("video-0-1-0001", { publishedAt: at(15, 0) })])]]), named)[0]?.published).toBe(false);
    const [unknown] = resultTiles([video("0-1", { publishedUnknown: true })], new Map([[MIA, listOf([record("video-0-1-0001")])]]), named);
    expect([unknown?.published, unknown?.markUnknown, unknown?.actionable]).toEqual([false, true, true]);
  });

  test("S4.6g: a list that failed changes nothing about a tile: its mark and its trash are the engine's, the summary is just missing", () => {
    const failed: AvatarVideos = { state: "failed", error: { code: "INTERNAL" } };
    const [tile] = resultTiles([video("0-1", { publishedAt: at(15, 0) })], new Map([[MIA, failed]]), named);
    expect([tile?.published, tile?.actionable, tile?.summary === null, tile?.markUnknown]).toEqual([true, true, true, false]);
  });

  test("an avatar deleted since the launch: NOT_FOUND for an avatar the library no longer holds is «gone» — its tiles stay, inert, «аватар удалён» (fix round 1)", () => {
    const notFound: AvatarVideos = { state: "failed", error: { code: "NOT_FOUND" } };
    expect(listOfAvatar(notFound, false)).toEqual({ state: "gone" });
    // A NOT_FOUND for an avatar the library still lists stays an error to retry; any other failure too.
    expect(listOfAvatar(notFound, true)).toEqual(notFound);
    expect(listOfAvatar({ state: "failed", error: { code: "INTERNAL" } }, false)?.state).toBe("failed");
    expect(listOfAvatar(undefined, false)).toBe(undefined);
    const [tile] = resultTiles([video("0-1", { publishedAt: at(15, 0) })], new Map([[MIA, { state: "gone" } as const]]), named);
    expect([tile?.state, tile?.actionable, tile?.published, tile?.status?.text, tile?.status?.tone]).toEqual(["done", false, false, "аватар удалён", "faint"]);
    expect(resultCounts(tile === undefined ? [] : [tile]).published).toBe(0);
  });

  test("S4.6g (N7): the tile of a deleted avatar is not a finished video of the count, nor of its bytes", () => {
    const tiles = resultTiles([video("0-1"), video("1-1", { avatarId: SOFIA })], new Map([[MIA, listOf([record("video-0-1-0001", { bytes: 30_000_000 })])], [SOFIA, { state: "gone" as const }]]), named);
    const counts = resultCounts(tiles);
    expect([tiles.length, counts.done, counts.byAvatar.get(MIA), counts.byAvatar.get(SOFIA) ?? 0, counts.megabytes]).toEqual([2, 1, 1, 0, `30${NBSP}МБ`]);
  });

  test("rendering, waiting for music and not made: their own lines, no mark, no trash; the ones not made come last", () => {
    const tiles = resultTiles(
      [
        video("1-1", { avatarId: SOFIA, state: "dropped", dropReason: "not-enough-photos", videoId: null, bytes: null, durationMs: null, track: null }),
        video("1-2", { avatarId: SOFIA, state: "waiting-music", videoId: null, bytes: null, durationMs: null, track: null }),
        video("1-3", { avatarId: SOFIA, state: "rendering", bytes: null, shape: "collage", size: 3 }),
      ],
      new Map([[SOFIA, listOf([])]]),
      named,
    );
    expect(tiles.map((t) => [t.key, t.meta, t.status?.text ?? null, t.actionable, t.cells])).toEqual([
      ["1-2", "одно фото · ждёт трек", "ждёт музыку", false, 1],
      ["1-3", "коллаж 3 · рендер", null, false, 3],
      ["1-1", "одно фото → не собралось", "Не собралось: не хватило фото.", false, 1],
    ]);
  });

  test("the counts: finished videos, per avatar, published, their size", () => {
    const tiles = resultTiles(
      [video("0-1", { publishedAt: at(15, 0) }), video("0-2", { bytes: 2_400_000 }), video("1-1", { avatarId: SOFIA, state: "waiting-music", videoId: null, bytes: null, durationMs: null, track: null })],
      new Map([
        [MIA, listOf([record("video-0-1-0001", { bytes: 31_000_000 }), record("video-0-2-0001", { bytes: 30_000_000 })])],
        [SOFIA, listOf([])],
      ]),
      named,
    );
    const counts = resultCounts(tiles);
    expect([counts.done, counts.byAvatar.get(MIA), counts.byAvatar.get(SOFIA) ?? 0, counts.published, counts.megabytes]).toEqual([2, 2, 0, 1, `61${NBSP}МБ`]);
  });

  test("what did not come out, by avatar and reason", () => {
    const drop = (key: string, avatarId: string, dropReason: LaunchVideo["dropReason"]): LaunchVideo => video(key, { avatarId, state: "dropped", dropReason, videoId: null, bytes: null, durationMs: null, track: null });
    expect(droppedLine([video("0-1")], named)).toBe(null);
    expect(droppedLine([drop("1-1", SOFIA, "not-enough-photos"), drop("1-2", SOFIA, "not-enough-photos")], named)).toBe(`2${NBSP}видео не собрались: у Sofia — не хватило фото.`);
    expect(droppedLine([drop("1-1", SOFIA, "not-enough-photos"), drop("0-4", MIA, "render-failed")], named)).toBe(`2${NBSP}видео не собрались: у Sofia — не хватило фото (1); у Mia — рендер не удался (1).`);
    expect(droppedLine([drop("1-1", SOFIA, "launch-stopped")], named)).toBe(`1${NBSP}видео не собралось: у Sofia — запуск остановлен.`);
  });

  test("the notice while marks cannot be read names whose", () => {
    expect(marksUnknownText(["Mia"], true)).toBe("Отметки «Опубликовано» не читаются — эти видео показаны без отметки. Studio по ним ничего не удаляет; новая отметка допишется.");
    expect(marksUnknownText(["Mia"], false)).toStartWith("Отметки «Опубликовано» у Mia не читаются");
  });
});
