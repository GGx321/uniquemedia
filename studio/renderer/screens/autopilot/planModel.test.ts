import { describe, expect, test } from "bun:test";
import { raiseBudgetToMicros } from "../../../shared/autopilot/money";
import { LaunchPreview, LaunchView, type LaunchAvatarView, type LaunchPreviewAvatar } from "../../../shared/engine";
import {
  avatarRow,
  diskLine,
  figuresOf,
  GO_WHY,
  goTitle,
  goWhy,
  launchPlanBits,
  limitText,
  monthMeter,
  musicLine,
  planNotes,
  planTiles,
  sidebarMark,
  stoppingLine,
  stopTexts,
  timeLabel,
  wordsText,
} from "./planModel";

// S4.9a: the plan card's words for every state the design draws (LaunchStates «Бюджет месяца», «Почему не собрать», «Музыка»; HostStates «Боковая панель»),
// worded from the engine's figures only. The fixtures are parsed by the contract, so every one is a preview the engine could send.

const NBSP = " ";

const avatar = (avatarId: string, over: Partial<LaunchPreviewAvatar> = {}): LaunchPreviewAvatar => ({
  avatarId,
  videos: 10,
  shapes: { single: 7, collage: 2, slides: 1 },
  free: 20,
  fromLibrary: 14,
  toGenerate: 5,
  busy: false,
  blocked: null,
  usage: { state: "ok" },
  ...over,
});

interface Fixture {
  avatars?: LaunchPreviewAvatar[];
  expected?: number;
  worst?: number;
  budget?: number;
  committed?: number;
  blockers?: LaunchPreview["blockers"];
  balance?: number | null;
  music?: Partial<LaunchPreview["music"]>;
  disk?: LaunchPreview["disk"];
}

/** A preview as the engine sends it: totals and the month's fit follow from the figures (the contract checks both). */
function preview({ avatars = [avatar("avatar-mia"), avatar("avatar-sofia")], expected = 1_340_000, worst = 4_140_000, budget = 10_000_000, committed = 1_640_000, blockers, balance = null, music, disk }: Fixture = {}): LaunchPreview {
  const counted = avatars.filter((a) => a.blocked === null);
  const sum = (pick: (a: LaunchPreviewAvatar) => number): number => counted.reduce((n, a) => n + pick(a), 0);
  const free = Math.max(0, budget - committed);
  return LaunchPreview.parse({
    planSeed: 7,
    avatars,
    totals: { videos: sum((a) => a.videos), photosNeeded: sum((a) => a.fromLibrary + a.toGenerate), fromLibrary: sum((a) => a.fromLibrary), toGenerate: sum((a) => a.toGenerate) },
    estimate: { expectedMicros: expected, worstMicros: worst, prices: "live", pricesAsOf: "2026-10-09" },
    perShapeExpectedMicros: { single: 70_000, collage: 210_000, slides: 350_000 },
    month: {
      budgetMicros: budget,
      committedMicros: committed,
      freeMicros: free,
      fit: free >= worst ? "fits" : free >= expected ? "fits-expected" : "short",
      // The engine's own figure (the window never computes it): the budget in whole dollars that covers the worst case.
      raiseToMicros: raiseBudgetToMicros({ budgetMicros: budget, committedMicros: committed, freeMicros: free }, worst),
    },
    balance: balance === null ? null : { micros: balance, asOf: "2026-10-09T10:00:00.000Z" },
    music: { candidates: 21, ownFlagged: 2, explicitSkipped: 3, autoRefresh: "will", quotaRemaining: 21, ...music },
    disk: disk ?? { neededBytes: 140_000_000, freeBytes: 212_000_000_000 },
    timeSeconds: 700,
    blockers: blockers ?? avatars.flatMap((a) => (a.blocked === null ? [] : [{ code: a.blocked, avatarId: a.avatarId }])),
  });
}

const NAMES: Record<string, string> = { "avatar-mia": "Mia", "avatar-sofia": "Sofia", "avatar-nora": "Nora", "avatar-vera": "Vera", "avatar-ava": "Ava" };
const nameOf = (id: string): string => NAMES[id] ?? id;
const notes = (p: LaunchPreview, over: { videosPerAvatar?: number; generate?: boolean } = {}) => planNotes({ preview: p, videosPerAvatar: over.videosPerAvatar ?? 10, generate: over.generate ?? true, nameOf });
const noteText = (p: LaunchPreview, id: string, over?: { videosPerAvatar?: number; generate?: boolean }): string | null => {
  const note = notes(p, over).find((n) => n.id === id);
  if (note === undefined) return null;
  const sentence = (t: { before: string; link: { label: string } | null; after: string }): string => `${t.before}${t.link?.label ?? ""}${t.after}`;
  return [note.title, note.text === null ? null : sentence(note.text), ...note.items.map((i) => `${i.name ?? ""}${sentence(i)}`)].filter((x) => x !== null).join(" | ");
};

describe("the tiles", () => {
  test("the plan's totals, the library's photos in green, the new ones in the accent, the expected price and the time", () => {
    expect(planTiles(preview(), 10).map((t) => [t.label, t.value, t.tone])).toEqual([
      ["Видео", "20", "text"],
      ["Нужно фото", "38", "text"],
      ["Из библиотеки", "28", "ok"],
      ["Сгенерировать", "10", "acc"],
      ["Ожидаемая", "≈ $1.34", "text"],
      ["Время", `≈ 12${NBSP}мин`, "text"],
    ]);
  });

  test("«12 из 30» in amber when the library cannot fill every video; «$0» and a faint 0 with nothing to generate", () => {
    const p = preview({ avatars: [avatar("avatar-mia", { toGenerate: 0, fromLibrary: 23 }), avatar("avatar-sofia", { videos: 2, shapes: { single: 2, collage: 0, slides: 0 }, toGenerate: 0, fromLibrary: 2, free: 4 })], expected: 0, worst: 0 });
    const tiles = planTiles(p, 10);
    expect(tiles[0]).toEqual({ label: "Видео", value: "12 из 20", tone: "warn" });
    expect(tiles[3]).toEqual({ label: "Сгенерировать", value: "0", tone: "faint" });
    expect(tiles[4]?.value).toBe("$0");
  });

  test("a blocked avatar counts for nothing; no plan is six dashes", () => {
    const p = preview({ avatars: [avatar("avatar-mia"), avatar("avatar-nora", { blocked: "usage-unknown", free: 0, fromLibrary: 0, usage: { state: "unknown", reasons: ["record-unreadable"] } })] });
    expect(planTiles(p, 10)[0]?.value).toBe("10");
    expect(planTiles(null, 10).every((t) => t.value === "—" && t.tone === "faint")).toBe(true);
  });

  test.each([
    [30, `≈ 1${NBSP}мин`],
    [700, `≈ 12${NBSP}мин`],
    [3600, `≈ 1${NBSP}ч`],
    [3900, `≈ 1${NBSP}ч 05${NBSP}мин`],
  ])("%i s reads %s", (seconds, label) => {
    expect(timeLabel(seconds)).toBe(label);
  });
});

describe("the month", () => {
  test("fits: the room, the budget, what is committed, the expected cost and the worst case on one bar", () => {
    const meter = monthMeter(preview());
    expect(meter).toMatchObject({ fit: "fits", free: "$8.36", budget: "$10.00", used: "$1.64", expected: "$1.34", worst: "$4.14", over: false });
    expect(meter).toMatchObject({ usedPct: 16.4, expectedPct: 13.4, worstLeftPct: 29.8, worstPct: 28 });
  });

  test("fits-expected: the hatch stops at the bar's end and a mark says the worst case does not fit; the hint is ⌈W − R + B⌉", () => {
    // The plan's worked example (§4.4): 50 videos, library off, $10 budget with $1.64 committed.
    const p = preview({ avatars: [avatar("avatar-mia", { videos: 50, shapes: { single: 35, collage: 10, slides: 5 }, fromLibrary: 0, toGenerate: 90 })], expected: 6_340_000, worst: 19_200_000 });
    const meter = monthMeter(p);
    expect(meter?.fit).toBe("fits-expected");
    expect(meter?.over).toBe(true);
    expect((meter?.worstLeftPct ?? 0) + (meter?.worstPct ?? 0)).toBeCloseTo(100, 5);
    expect(p.month.raiseToMicros).toBe(21_000_000);
    expect(noteText(p, "fits-expected")).toBe("Хватит, если без повторов | При неудачах запуск встанет на паузу по бюджету. Чтобы такого не было, поднимите бюджет до $21.");
  });

  test("short: the room is below the expected cost, said in red with a link to the budget", () => {
    const p = preview({ committed: 9_380_000 });
    expect(monthMeter(p)?.fit).toBe("short");
    expect(noteText(p, "short")).toBe("Бюджета не хватит | Не хватит даже на ожидаемую цену: свободно $0.62, нужно ≈ $1.34. Уменьшите число видео или поднимите бюджет.");
    expect(notes(p).find((n) => n.id === "short")?.text?.link).toEqual({ kind: "settings", focus: "money", label: "поднимите бюджет" });
  });

  test("a launch that pays for nothing has no bar and no budget notes", () => {
    const p = preview({ expected: 0, worst: 0, committed: 9_990_000, avatars: [avatar("avatar-mia", { toGenerate: 0 })] });
    expect(monthMeter(p)).toBeNull();
    expect(notes(p).map((n) => n.id)).toEqual([]);
  });

  test("the balance warns below the launch's worst case, never above, and never without a key (no balance)", () => {
    expect(noteText(preview({ balance: 3_000_000 }), "balance")).toBe("На балансе OpenRouter $3.00 — меньше предела запуска $4.14. При нехватке запуск встанет на паузу.");
    expect(noteText(preview({ balance: 42_180_000 }), "balance")).toBeNull();
    expect(noteText(preview({ balance: null }), "balance")).toBeNull();
  });

  test("what is left is never overstated: the room and the balance round down, three decimals below $0.10", () => {
    // $0.0629 free: «$0.062», not «$0.06» (two decimals) nor «$0.063» (rounded up).
    const p = preview({ committed: 9_937_100, balance: 61_999 });
    expect(monthMeter(p)?.free).toBe("$0.062");
    expect(monthMeter(p)?.used).toBe("$9.94");
    expect(noteText(p, "short")).toBe("Бюджета не хватит | Не хватит даже на ожидаемую цену: свободно $0.062, нужно ≈ $1.34. Уменьшите число видео или поднимите бюджет.");
    expect(noteText(p, "balance")).toBe("На балансе OpenRouter $0.061 — меньше предела запуска $4.14. При нехватке запуск встанет на паузу.");
    // Spent money to the nearest, below $0.10 too.
    expect(monthMeter(preview({ committed: 45_500 }))?.used).toBe("$0.046");
  });

  test("the raise is said as the engine answered it, in whole dollars; without one the link only asks to raise", () => {
    const p = preview({ avatars: [avatar("avatar-mia", { toGenerate: 90 })], expected: 6_340_000, worst: 19_200_000, committed: 13_000_000, budget: 20_000_000 });
    expect(p.month.raiseToMicros).toBe(33_000_000);
    expect(notes(p).find((n) => n.id === "fits-expected")?.text?.link).toEqual({ kind: "settings", focus: "money", label: "поднимите бюджет до $33" });
  });
});

describe("what blocks the launch", () => {
  test("every avatar's reason in one list, with a link to «Фото» for an open set; the budget notes give way", () => {
    const p = preview({
      avatars: [
        avatar("avatar-sofia", { blocked: "open-set" }),
        avatar("avatar-mia", { blocked: "too-many-photos", toGenerate: 104 }),
        avatar("avatar-nora", { blocked: "usage-unknown", free: 0, fromLibrary: 0, usage: { state: "unknown", reasons: ["record-unreadable"] } }),
        avatar("avatar-vera"),
      ],
      committed: 9_380_000,
      blockers: [
        { code: "open-set", avatarId: "avatar-sofia" },
        { code: "too-many-photos", avatarId: "avatar-mia" },
        { code: "usage-unknown", avatarId: "avatar-nora" },
        { code: "launch-unreadable" },
      ],
    });
    expect(noteText(p, "blocked")).toBe(
      [
        "Запуск не собрать",
        "Sofia: открыт набор сцен — завершите или удалите его на «Фото».",
        "Mia: нужно 104 новых фото, больше 100 за запуск нельзя — уменьшите слайды или число видео.",
        "Nora: не читается, какие её фото заняты, — из библиотеки её не собрать. Уберите Nora из запуска.",
        "Одна запись запуска не читается — уберите её в «Истории запусков».",
      ].join(" | "),
    );
    expect(notes(p).find((n) => n.id === "blocked")?.items[0]?.link).toEqual({ kind: "photos", avatarId: "avatar-sofia", label: "«Фото»" });
    expect(noteText(p, "short")).toBeNull();
    expect(goWhy({ activeCount: 11, chosen: 4, categories: 5, library: true, generate: true, preview: p })).toBe(GO_WHY.blocked);
  });

  test("over 100 new photos alone has its own title and its own «почему»", () => {
    const p = preview({ avatars: [avatar("avatar-mia", { videos: 50, shapes: { single: 25, collage: 10, slides: 15 }, blocked: "too-many-photos", toGenerate: 104 })] });
    expect(notes(p)[0]?.title).toBe("Больше 100 новых фото на аватара");
    expect(goWhy({ activeCount: 11, chosen: 1, categories: 5, library: true, generate: true, preview: p })).toBe(GO_WHY.tooMany);
    // Every chosen avatar blocked: no figures to show — never «0 видео · бесплатно», which would read as a free launch.
    expect(figuresOf(p)).toBeNull();
    expect(goTitle(figuresOf(p))).toBe("Запустить");
    expect(figuresOf(preview())).not.toBeNull();
  });

  test("«почему» is the first reason in the design's order, and none when the launch can go", () => {
    const base = { activeCount: 11, chosen: 3, categories: 5, library: true, generate: true, preview: preview() };
    expect(goWhy({ ...base, activeCount: 0, chosen: 0 })).toBe(GO_WHY.noAvatars);
    expect(goWhy({ ...base, chosen: 0 })).toBe(GO_WHY.noneChosen);
    expect(goWhy({ ...base, categories: 0 })).toBe(GO_WHY.noCategory);
    expect(goWhy({ ...base, library: false, generate: false })).toBe(GO_WHY.nothingEnabled);
    expect(goWhy({ ...base, preview: preview({ blockers: [{ code: "launch-active" }] }) })).toBe(GO_WHY.launchActive);
    expect(goWhy({ ...base, preview: preview({ blockers: [{ code: "no-key" }] }) })).toBe(GO_WHY.noKey);
    expect(goWhy({ ...base, preview: preview({ blockers: [{ code: "reconcile-required" }] }) })).toBe(GO_WHY.reconcile);
    expect(goWhy({ ...base, preview: preview({ blockers: [{ code: "halt" }] }) })).toBe(GO_WHY.halt);
    expect(goWhy({ ...base, preview: preview({ blockers: [{ code: "ledger" }] }) })).toBe(GO_WHY.ledger);
    expect(goWhy({ ...base, preview: preview({ blockers: [{ code: "export-unavailable" }] }) })).toBe(GO_WHY.export);
    expect(goWhy({ ...base, preview: preview({ committed: 9_380_000 }) })).toBe(GO_WHY.short);
    expect(goWhy({ ...base, preview: preview({ avatars: [avatar("avatar-mia", { videos: 0, shapes: { single: 0, collage: 0, slides: 0 }, fromLibrary: 0, toGenerate: 0 })], expected: 0, worst: 0 }) })).toBe(GO_WHY.noVideos);
    expect(goWhy(base)).toBeNull();
    // A preview still being asked closes nothing by itself (the button waits for it instead).
    expect(goWhy({ ...base, preview: null })).toBeNull();
  });

  test("the button names its videos and its ceiling, or «бесплатно» when nothing is paid", () => {
    expect(goTitle(preview())).toBe(`Запустить: 20${NBSP}видео · до $4.14`);
    expect(goTitle(preview({ expected: 0, worst: 0 }))).toBe(`Запустить: 20${NBSP}видео · бесплатно`);
    expect(goTitle(null)).toBe("Запустить");
    expect(limitText(4_140_000)).toBe("до $4.14");
    expect(limitText(45_000)).toBe("до $0.045");
    expect(limitText(0)).toBe("бесплатно");
    expect(limitText(null)).toBe("—");
  });
});

describe("the library without generation, the music, a busy avatar", () => {
  test("«Видео: 12 из 30 — не хватает фото», one line per avatar short of photos", () => {
    const p = preview({
      avatars: [
        avatar("avatar-mia", { toGenerate: 0, fromLibrary: 23 }),
        avatar("avatar-sofia", { videos: 2, shapes: { single: 2, collage: 0, slides: 0 }, free: 4, fromLibrary: 2, toGenerate: 0 }),
        avatar("avatar-vera", { videos: 0, shapes: { single: 0, collage: 0, slides: 0 }, free: 0, fromLibrary: 0, toGenerate: 0 }),
      ],
      expected: 0,
      worst: 0,
    });
    expect(noteText(p, "library-short", { generate: false })).toBe(
      "Видео: 12 из 30 — не хватает фото | Sofia: 2 из 10 — свободных фото в этих категориях 4. | Vera: 0 из 10 — свободных фото нет. Включите «Догенерировать».",
    );
    expect(noteText(p, "library-short", { generate: true })).toBeNull();
  });

  test("no fitting track and no refresh coming: the videos would wait, said with a link to Settings", () => {
    expect(noteText(preview({ music: { candidates: 0, autoRefresh: "no-quota", quotaRemaining: 9 } }), "music")).toBe(
      "Подходящей музыки нет — видео будут ждать | Обновите тренды в Настройках или отметьте свои треки «для автопилота».",
    );
    expect(noteText(preview({ music: { candidates: 0, autoRefresh: "will" } }), "music")).toBeNull();
    expect(noteText(preview({ music: { candidates: 5 } }), "music")).toBeNull();
  });

  test("a chosen avatar that is busy is said politely: the launch waits for it", () => {
    expect(noteText(preview({ avatars: [avatar("avatar-ava", { busy: true }), avatar("avatar-mia")] }), "busy")).toBe("Ava занята вашей генерацией на «Фото». Запуск начнёт её, когда генерация закончится.");
  });

  test.each([
    [{ autoRefresh: "will", quotaRemaining: 21, candidates: 21 }, `Тренды + мои · 21${NBSP}трек`, "обновим тренды при запуске — осталось 21 из 30", false],
    [{ autoRefresh: "not-needed", candidates: 22 }, `Тренды + мои · 22${NBSP}трека`, "тренды свежие — обновлять не нужно", false],
    [{ autoRefresh: "no-quota", quotaRemaining: 9, candidates: 8 }, `Тренды + мои · 8${NBSP}треков`, "тренды не обновим сами: осталось 9 из 30 — бережём для вас", true],
    [{ autoRefresh: "no-key", candidates: 5 }, `Тренды + мои · 5${NBSP}треков`, "нет ключа музыки — тренды не обновить", true],
  ] as const)("music %o", (music, chip, sub, warn) => {
    const base: LaunchPreview["music"] = { candidates: 0, ownFlagged: 0, explicitSkipped: 0, autoRefresh: "will", quotaRemaining: 21 };
    expect(musicLine({ ...base, ...music })).toEqual({ chip, sub, warn });
  });

  test("the disk: what the videos need, rounded up, and what the folder has, rounded down", () => {
    expect(diskLine({ neededBytes: 140_000_000, freeBytes: 212_000_000_000 })).toEqual({ text: `Диск: нужно ≈ 140${NBSP}МБ · свободно 212${NBSP}ГБ`, short: false });
    expect(diskLine({ neededBytes: 1_250_000_000, freeBytes: null })).toEqual({ text: `Диск: нужно ≈ 1.3${NBSP}ГБ`, short: false });
    expect(diskLine({ neededBytes: 140_000_000, freeBytes: 90_000_000 }).short).toBe(true);
  });
});

describe("the avatar rows", () => {
  test("«N своб.» from the plan; a tag says why an avatar will not go before why it waits", () => {
    expect(avatarRow("Mia", avatar("avatar-mia", { free: 31 }), undefined)).toEqual({ free: "31 своб.", freeWarn: false, tag: null });
    expect(avatarRow("Vera", undefined, avatar("avatar-vera", { free: 0 }))).toMatchObject({ free: "0 своб.", freeWarn: true });
    expect(avatarRow("Ava", undefined, avatar("avatar-ava", { busy: true, free: 9 })).tag?.text).toBe("занята");
    expect(avatarRow("Sofia", avatar("avatar-sofia", { blocked: "open-set", busy: true }), undefined).tag).toEqual({ text: "набор сцен", tone: "warn", title: "Открыт набор сцен — завершите или удалите его на «Фото»" });
    expect(avatarRow("Mia", avatar("avatar-mia", { blocked: "too-many-photos", toGenerate: 104 }), undefined).tag).toEqual({ text: "> 100 фото", tone: "danger", title: "Нужно 104 новых фото — больше 100 за запуск нельзя" });
    const unknown = avatar("avatar-nora", { free: 0, fromLibrary: 0, usage: { state: "unknown", reasons: ["record-unreadable"] } });
    expect(avatarRow("Nora", unknown, undefined)).toEqual({ free: "— своб.", freeWarn: true, tag: { text: "нет данных", tone: "warn", title: "Не читается, какие фото Nora заняты" } });
    expect(avatarRow("Zoe", undefined, undefined)).toEqual({ free: null, freeWarn: false, tag: null });
  });
});

// ---------- a launch ----------

const row = (avatarId: string, over: Partial<LaunchAvatarView> = {}): LaunchAvatarView => ({
  avatarId,
  phase: "montage",
  waiting: null,
  skipped: null,
  photos: { done: 0, total: 0 },
  montage: { done: 5, total: 10 },
  videos: { done: 4, total: 10 },
  sceneSetId: null,
  setRevision: null,
  scenes: null,
  scenesWithoutText: null,
  continuePhotos: null,
  slice: null,
  dropped: null,
  waitingMusic: 0,
  undrawnScenes: 0,
  resumableSlots: 0,
  drawAllocationMicros: null,
  ...over,
});

function launch(over: Partial<LaunchView> = {}): LaunchView {
  return LaunchView.parse({
    launchId: "launch-00000001",
    createdAt: "2026-10-08T14:02:00.000Z",
    endedAt: null,
    activeMs: 161_000,
    status: "running",
    paused: null,
    paidHold: null,
    freeHold: null,
    draft: {
      avatarIds: ["avatar-mia", "avatar-sofia", "avatar-elena"],
      videosPerAvatar: 10,
      mix: { single: 70, collage: 20, slides: 10 },
      categories: ["home"],
      poses: { profile: false, back: false },
      library: true,
      generate: true,
      sceneReview: true,
      stickers: false,
      planSeed: 1,
    },
    acceptedMicros: 4_140_000,
    plannedWorstMicros: 4_140_000,
    plannedExpectedMicros: 1_340_000,
    plan: { videos: 30, photos: 56, fromLibrary: 37, toGenerate: 19 },
    spentMicros: 1_250_000,
    remainingMicros: 2_890_000,
    reviewWritesMicros: 0,
    inFlight: { requests: 4, openMicros: 280_000 },
    waitingMusic: 0,
    resumeBlockedBy: null,
    avatars: [row("avatar-mia", { videos: { done: 8, total: 10 } }), row("avatar-sofia", { videos: { done: 2, total: 10 } }), row("avatar-elena", { videos: { done: 4, total: 10 } })],
    logTail: [],
    ...over,
  });
}

describe("a launch that runs", () => {
  test("the folded plan says what the click accepted", () => {
    expect(launchPlanBits(launch())).toEqual([`30${NBSP}видео`, `56${NBSP}фото: 37 из библиотеки, 19 новых`, "≈ $1.34", "предел до $4.14"]);
  });

  test("«Остановить запуск?» says what stops, what stays and what was spent of W′ (ApStopConfirm, short form)", () => {
    const texts = stopTexts(launch());
    expect(wordsText(texts.lead)).toBe("Новых запросов и рендеров не будет. Запросы, что уже в работе (4), закончатся сами — ничего не обрывается. Вернуть запуск после «Стоп» нельзя.");
    expect(texts.stays.map(wordsText)).toEqual([`14${NBSP}готовых видео — в «Готовых видео»;`, "все новые фото — в библиотеке, свободными для следующего запуска."]);
    expect(texts.spent === null ? null : wordsText(texts.spent)).toBe("Потрачено $1.25 из $4.14 — остальное запуск уже не потратит.");
    const quiet = launch({ inFlight: { requests: 0, openMicros: 0 }, avatars: [row("avatar-mia", { videos: { done: 1, total: 10 } }), row("avatar-sofia", { videos: { done: 0, total: 10 } }), row("avatar-elena", { videos: { done: 0, total: 10 } })] });
    expect(wordsText(stopTexts(quiet).lead)).toBe("Новых запросов и рендеров не будет. Вернуть запуск после «Стоп» нельзя.");
    expect(wordsText(stopTexts(quiet).stays[0] ?? [])).toBe(`1${NBSP}готовое видео — в «Готовых видео»;`);
    expect(stoppingLine(launch())).toBe(`Новых трат не будет. Ждём ответов на 4${NBSP}запроса — обычно до минуты, не дольше 3 минут.`);
    expect(stoppingLine(quiet)).toBe("Новых трат не будет.");
  });

  test("S4.9d (S4.9b L4): the figures of «Остановить запуск?» are drawn mono, as ApStopConfirm draws them", () => {
    const texts = stopTexts(launch());
    expect(texts.lead).toContainEqual({ mono: "4" });
    expect(texts.stays[0]?.[0]).toEqual({ mono: "14" });
    expect(texts.spent).toEqual(["Потрачено ", { mono: "$1.25" }, " из ", { mono: "$4.14" }, " — остальное запуск уже не потратит."]);
  });

  test("S4.9d (S4.9c N2, N3): «Остановить запуск?» of a free launch says nothing of money; an A2 breach shows its figures «из $0»", () => {
    const free = { acceptedMicros: 0, plannedWorstMicros: 0, plannedExpectedMicros: 0, remainingMicros: 0 };
    expect(stopTexts(launch({ ...free, spentMicros: 0 })).spent).toBeNull();
    const breach = stopTexts(launch({ ...free, spentMicros: 300_000 })).spent;
    expect(breach === null ? null : wordsText(breach)).toBe("Потрачено $0.30 из $0 — остальное запуск уже не потратит.");
  });

  test("the sidebar's mark: the count, «сцены», «ждёт», «пауза», «стоп», «готово» until seen, nothing once stopped", () => {
    expect(sidebarMark(null, null)).toBeNull();
    expect(sidebarMark(launch(), null)).toEqual({ text: "14 / 30", tone: "run", description: "идёт: готово 14 из 30 видео" });
    const review = launch({ avatars: [row("avatar-mia"), row("avatar-sofia", { phase: "awaiting-review", sceneSetId: "set-sofia-0001", setRevision: 1, scenes: 14, scenesWithoutText: 2, continuePhotos: 12 }), row("avatar-elena")] });
    expect(sidebarMark(review, null)?.text).toBe("сцены");
    expect(sidebarMark(launch({ waitingMusic: 3 }), null)?.text).toBe("ждёт");
    expect(sidebarMark(launch({ paidHold: { reason: "credits", at: "2026-10-08T14:05:00.000Z", detail: {} } }), null)).toEqual({ text: "ждёт", tone: "hold", description: "запуск ждёт" });
    expect(sidebarMark(launch({ status: "paused", paused: { cause: "owner", at: "2026-10-08T14:05:00.000Z" } }), null)?.text).toBe("пауза");
    expect(sidebarMark(launch({ status: "pausing" }), null)?.text).toBe("пауза");
    expect(sidebarMark(launch({ status: "stopping" }), null)?.text).toBe("стоп");
    const done = launch({ status: "done", endedAt: "2026-10-08T14:31:00.000Z" });
    expect(sidebarMark(done, null)).toEqual({ text: "готово", tone: "done", description: "запуск завершён" });
    expect(sidebarMark(done, done.launchId)).toBeNull();
    expect(sidebarMark(launch({ status: "stopped", endedAt: "2026-10-08T14:09:00.000Z" }), null)).toBeNull();
  });
});
