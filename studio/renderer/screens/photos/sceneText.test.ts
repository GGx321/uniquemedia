import { describe, expect, test } from "bun:test";
import type { SceneSetView } from "../../../shared/engine";
import { gaveUp, pending, scene, sceneSet, written } from "./sceneFixtures";
import {
  approveReason,
  approveTitle,
  composeTitle,
  continueTitle,
  cyrillicHint,
  emptyButton,
  gaveUpNotice,
  gaveUpText,
  headerCounts,
  ideaHint,
  ideaLine,
  ideaNotice,
  ideaTitle,
  poseTag,
  stripAngles,
  stripAnglesText,
  offNoteSet,
  otherScenesButton,
  ownRewriteText,
  priceSourceText,
  problemText,
  progressLabel,
  progressNote,
  recomposeLosses,
  recomposeSpent,
  redrawGoneText,
  redrawText,
  rewriteNotice,
  runDoneText,
  stepScenes,
  stoppedNotice,
} from "./sceneText";

// CS.6: what the review UI says, word for word as the CS.0 artboards draw it (PhotosCS.dc.html, ReviewStates.dc.html), from the engine's view. Money
// follows «Деньги на экране»: three decimals below $0.10, a ceiling up, an estimate and money spent to the nearest.

/** A count stays on one line with its word (the app's countOf binds them with a no-break space). */
const nb = (text: string): string => text.replace(/(\d) (?=\p{L})/gu, "$1 ");

/** A set stopped mid-compose: 60 planned, the first chunk written, the rest waiting. */
function stopped(patch: Partial<SceneSetView> = {}): SceneSetView {
  return sceneSet([...written(25), ...Array.from({ length: 35 }, (_, i) => pending(26 + i))], {
    status: "stopped",
    stoppedBy: "closed",
    lastCompose: { total: 60, written: 25, gaveUp: 0 },
    chunks: [
      { chunk: 1, sceneIds: Array.from({ length: 25 }, (_, i) => i + 1), attemptsLeft: 1, gaveUpBy: null },
      { chunk: 2, sceneIds: Array.from({ length: 25 }, (_, i) => i + 26), attemptsLeft: 1, gaveUpBy: null },
      { chunk: 3, sceneIds: Array.from({ length: 10 }, (_, i) => i + 51), attemptsLeft: 2, gaveUpBy: null },
    ],
    spentMicros: 49_000,
    openReserveMicros: 37_500,
    ...patch,
  });
}

describe("button titles", () => {
  test("compose, continue, approve and the idea write, with the scene word in its case", () => {
    expect(composeTitle(20)).toBe(nb("Составить 20 сцен"));
    expect(composeTitle(21)).toBe(nb("Составить 21 сцену"));
    expect(composeTitle(22)).toBe(nb("Составить 22 сцены"));
    expect(composeTitle(0)).toBe("Начать пустой набор");
    expect(continueTitle(35)).toBe(nb("Дописать 35 сцен"));
    expect(continueTitle(1)).toBe(nb("Дописать 1 сцену"));
    expect(approveTitle(19)).toBe(nb("Отрисовать 19 фото"));
    expect(ideaTitle(2)).toBe(nb("Написать 2 сцены"));
    expect(ideaTitle(1)).toBe(nb("Написать 1 сцену"));
    expect(emptyButton(35)).toBe(nb("Убрать 35 пустых"));
    expect(emptyButton(2)).toBe(nb("Убрать 2 пустые"));
    expect(emptyButton(1)).toBe(nb("Убрать 1 пустую"));
    expect(otherScenesButton(5)).toBe("Другие сцены для 5");
    expect(otherScenesButton(1)).toBe("Другая сцена");
  });
});

describe("step 1 of the price column: «Сцены»", () => {
  test("what the set spent, three decimals; an open reserve at its ceiling; nothing spent is free", () => {
    expect(stepScenes(sceneSet(written(19)))).toEqual({ label: "Сцены", value: "$0.009", done: true, spent: null });
    expect(stepScenes(sceneSet(written(19), { spentMicros: 46_650, openReserveMicros: 37_500 }))).toEqual({ label: "Сцены", value: "до $0.047", done: true, spent: null });
    expect(stepScenes(sceneSet([], { spentMicros: 0 }))).toEqual({ label: "Сцены", value: "бесплатно", done: true, spent: null });
    expect(stepScenes(sceneSet(written(3), { spentMicros: null, openReserveMicros: null }))).toEqual({ label: "Сцены", value: "—", done: true, spent: null });
  });

  test("while a compose writes: «пишутся»; stopped: how many are written, and under it what it spent (README decision 20: «потраченное видно на шаге 1»)", () => {
    expect(stepScenes(sceneSet([pending(1)], { status: "writing", write: { kind: "compose", count: 20 }, spentMicros: 0, openReserveMicros: 0 }))).toEqual({ label: "Сцены", value: "пишутся", done: false, spent: null });
    expect(stepScenes(stopped())).toEqual({ label: "Сцены", value: "25 из 60", done: false, spent: "потрачено до $0.049" });
    expect(stepScenes(stopped({ openReserveMicros: 0 }))).toEqual({ label: "Сцены", value: "25 из 60", done: false, spent: "потрачено $0.049" });
  });

  test("«Дописываем…» after earlier spending keeps the spend on step 1; a fresh compose that spent nothing shows none", () => {
    const writing: Partial<SceneSetView> = { status: "writing", write: { kind: "unwritten", count: 35 } };
    expect(stepScenes(stopped({ ...writing, openReserveMicros: 0 }))).toEqual({ label: "Сцены", value: "пишутся", done: false, spent: "потрачено $0.049" });
    expect(stepScenes(stopped({ ...writing }))).toEqual({ label: "Сцены", value: "пишутся", done: false, spent: "потрачено до $0.049" });
    expect(stepScenes(stopped({ ...writing, spentMicros: 0, openReserveMicros: 0 })).spent).toBeNull();
  });
});

describe("the column header's counts", () => {
  test("ready: active, removed, the problem counter as a button to the first one", () => {
    expect(headerCounts(sceneSet([...written(19), scene(20, { removed: true })]), null)).toEqual([{ text: "19" }, { text: nb("1 убрана") }]);
    expect(headerCounts(sceneSet([...written(3), gaveUp(4), scene(5, { removed: true })]), null)).toEqual([
      { text: "4" },
      { text: nb("1 убрана") },
      { text: nb("1 не составлена"), problem: { first: 4, aria: nb("1 сцена не составлена — перейти к сцене 04") } },
    ]);
    const many = sceneSet([...written(35), ...Array.from({ length: 25 }, (_, i) => gaveUp(36 + i))]);
    expect(headerCounts(many, null)).toEqual([{ text: "60" }, { text: nb("25 не составлены"), problem: { first: 36, aria: nb("25 сцен не составлены — перейти к первой, сцене 36") } }]);
  });

  test("composing, stopped, an idea write, an empty set, a used one", () => {
    expect(headerCounts(sceneSet(Array.from({ length: 20 }, (_, i) => pending(i + 1)), { status: "writing", write: { kind: "compose", count: 20 } }), null)).toEqual([{ text: "0 из 20" }]);
    expect(headerCounts(stopped(), null)).toEqual([{ text: "25 из 60 составлены" }]);
    expect(headerCounts(sceneSet([...written(19), scene(20, { removed: true })], { status: "writing", write: { kind: "idea", count: 2 } }), null)).toEqual([
      { text: "19" },
      { text: nb("1 убрана") },
      { text: nb("2 пишутся") },
    ]);
    expect(headerCounts(sceneSet([]), null)).toEqual([{ text: "0" }, { text: "пустой набор" }]);
    const used = sceneSet([...written(19), scene(20, { removed: true })], { status: "used", runId: "run-0001" });
    expect(headerCounts(used, "active")).toEqual([{ text: "19" }, { text: "набор в запуске" }]);
    expect(headerCounts(used, "ended")).toEqual([{ text: "19" }, { text: "набор стал запуском" }]);
  });
});

describe("why «Отрисовать» waits", () => {
  test("a scene with no text, named as a link", () => {
    expect(approveReason({ kind: "no-text", first: 4, others: 0 })).toEqual({ pre: "", link: { text: "Сцена 04", sceneId: 4 }, post: " без текста — напишите её, попросите другую или уберите." });
    expect(approveReason({ kind: "no-text", first: 26, others: 24 })).toEqual({ pre: "", link: { text: "Сцена 26", sceneId: 26 }, post: " и ещё 24 без текста — уберите их, попросите другие или напишите сами." });
  });

  test("the model writing, an empty set, too many scenes", () => {
    expect(approveReason({ kind: "writing", write: { kind: "rewrite", count: 1, sceneIds: [2] } })).toEqual({
      pre: "Модель пишет ",
      link: { text: "сцену 02", sceneId: 2 },
      post: " — отрисовать можно, когда она закончит.",
    });
    expect(approveReason({ kind: "writing", write: { kind: "idea", count: 2 } }, 21)).toEqual({
      pre: "Модель пишет ",
      link: { text: nb("2 своих сцены"), sceneId: 21 },
      post: " — отрисовать можно, когда она закончит.",
    });
    expect(approveReason({ kind: "empty" })).toEqual({ pre: "Добавьте хотя бы одну сцену.", link: null, post: "" });
    expect(approveReason({ kind: "too-many", photos: 120 })).toEqual({ pre: "Больше 100 сцен в одном запуске нельзя — уберите лишние.", link: null, post: "" });
  });
});

describe("a scene card", () => {
  test("given up: each reason its own text", () => {
    expect(gaveUpText("rejected")).toBe("Отброшена при проверке: модель дважды вернула неподходящий текст. Напишите сами, попросите другую или уберите — без текста набор не отрисовать.");
    expect(gaveUpText("refused")).toBe("Модель отказалась писать эту сцену (отказ провайдера) — тот же запрос откажут снова. Напишите сами, попросите другую или уберите.");
    expect(gaveUpText("no-attempts")).toBe("У её запроса не осталось попыток. Напишите сами, попросите другую или уберите.");
  });

  test("an own scene's idea under its text, cut", () => {
    expect(ideaLine("Читаю на подоконнике в дождь, большое худи, чай")).toBe("по описанию: «Читаю на подоконнике в дождь, большое худи, чай»");
    expect(ideaLine("Утренний кофе на балконе с видом на море, в пижаме, а потом прогулка по пляжу с собакой")).toBe("по описанию: «Утренний кофе на балконе с видом на море…»");
  });

  test("the edit's problem, in the design's words", () => {
    expect(problemText({ reason: "revealing-word", words: ["bikini"] })).toBe("Слово «bikini» не пройдёт в промпт — замените его. Откровенных нарядов нет ни в одной категории.");
    expect(problemText({ reason: "revealing-word", words: ["bikini", "thong"] })).toBe("Слова «bikini», «thong» не пройдут в промпт — замените их. Откровенных нарядов нет ни в одной категории.");
    expect(problemText({ reason: "youth-word", words: ["teen"] })).toBe("Слово «teen» не пройдёт в промпт — замените его: в сценах только взрослый человек.");
    expect(problemText({ reason: "empty", words: [] })).toBe("Пустой текст не сохранить — напишите сцену или уберите её.");
    expect(problemText({ reason: "too-long", words: [] })).toBe("Не больше 600 знаков.");
    expect(problemText({ reason: "not-one-line", words: [] })).toBe("Текст сцены — одна строка: уберите переносы.");
    expect(problemText({ reason: "control-char", words: [] })).toBe("В тексте есть невидимые служебные символы — уберите их.");
  });

  test("a Russian text: the hint names the way to an English one, by the scene's origin", () => {
    expect(cyrillicHint("planned")).toBe(
      "Текст на русском уйдёт в промпт без перевода. Написать его по-английски модель может только как новую сцену: «+ Своя сцена» напишет её по этому описанию, а эту тогда уберите — правка здесь её не переведёт.",
    );
    expect(cyrillicHint("own")).toBe(
      "Текст на русском уйдёт в промпт без перевода. ⟳ «Переписать» напишет текст по-английски заново — по идее этой сцены, а не по правке; другую идею добавьте через «+ Своя сцена».",
    );
  });
});

describe("the ⟳ price popover", () => {
  test("a redraw names place, outfit, action AND time of day (owner decision 3)", () => {
    expect(redrawText("Кофейни Парижа", 2)).toBe(
      "Новое место, наряд, действие и время дня из «Кофейни Парижа» и новый текст. Сцена 02 заменится, когда новая будет готова; если не выйдет — останется как есть.",
    );
  });

  test("an own scene is written again from its stored idea; a deleted category cannot give a new place", () => {
    expect(ownRewriteText("Утренний кофе на балконе с видом на море, в пижаме")).toBe("Новый текст по вашему описанию «Утренний кофе на балконе…». Кадр и ракурс те же.");
    expect(redrawGoneText("Студия ч/б")).toBe("Категории «Студия ч/б» больше нет — новое место из неё не взять. Перепишите текст карандашом или уберите сцену.");
  });

  test("CS.8: a category with its own angles redraws the angle too; a selfie or mirror scene whose list can turn away may change its shot", () => {
    const tail = "Сцена 02 заменится, когда новая будет готова; если не выйдет — останется как есть.";
    const lead = "Новое место, наряд, действие, время дня и ракурс из «Домашнее у кровати» и новый текст";
    expect(redrawText("Домашнее у кровати", 2, { poses: ["three-quarter", "back"], shot: "selfie" })).toBe(`${lead}; со спины селфи не снять — тогда кадр сменится. ${tail}`);
    expect(redrawText("Домашнее у кровати", 2, { poses: ["profile", "three-quarter"], shot: "mirror" })).toBe(`${lead}; в профиль в зеркале не снять — тогда кадр сменится. ${tail}`);
    expect(redrawText("Домашнее у кровати", 2, { poses: ["profile", "back"], shot: "selfie" })).toBe(`${lead}; со спины селфи не снять — тогда кадр сменится. ${tail}`);
    // Not a phone shot, or nothing in the list that turns away: no clause.
    expect(redrawText("Домашнее у кровати", 2, { poses: ["three-quarter", "back"], shot: "friend" })).toBe(`${lead}. ${tail}`);
    expect(redrawText("Домашнее у кровати", 2, { poses: ["front", "three-quarter"], shot: "selfie" })).toBe(`${lead}. ${tail}`);
  });
});

describe("CS.8: angles on the review screen", () => {
  const BED = { ref: "cat-bed-0001", name: "Домашнее у кровати", poses: ["back", "three-quarter"] } as const;

  test("the strip's line names who does not follow the set's toggles: categories with their own angles (not their lists) and own scenes", () => {
    const both = sceneSet([scene(1), scene(2, { origin: "own" })], { categories: [{ ref: "home", name: null }, { ref: BED.ref, name: BED.name, poses: [...BED.poses] }] });
    expect(stripAnglesText(both)).toBe("Ракурсы: анфас, три четверти; у «Домашнее у кровати» — свои; у своих сцен — по описанию");
    expect(stripAngles(both)).toEqual({ lead: "Ракурсы: анфас, три четверти", first: "Домашнее у кровати", more: 0, rows: [{ name: "Домашнее у кровати", list: "три четверти, со спины" }], own: true });

    const several = sceneSet(written(3), {
      poses: { profile: false, back: true },
      categories: [
        { ref: BED.ref, name: BED.name, poses: [...BED.poses] },
        { ref: "cat-yoga-0002", name: "Йога дома", poses: ["profile"] },
        { ref: "home", name: null },
        { ref: "cat-city-0003", name: "Ночной город", poses: ["back"] },
        { ref: "cat-cafe-0004", name: "Кофейни Парижа" },
      ],
    });
    expect(stripAnglesText(several)).toBe("Ракурсы: анфас, три четверти, со спины; у «Домашнее у кровати» и ещё 2 — свои");
    expect(stripAngles(several).rows.map((r) => r.name)).toEqual(["Домашнее у кровати", "Йога дома", "Ночной город"]);

    expect(stripAnglesText(sceneSet([scene(1), scene(21, { origin: "own" })]))).toBe("Ракурсы: анфас, три четверти; у своих сцен — по описанию");
    expect(stripAnglesText(sceneSet(written(2)))).toBe("Ракурсы: анфас, три четверти");
    expect(stripAnglesText(sceneSet(written(2), { poses: { profile: true, back: true } }))).toBe("Ракурсы: анфас, три четверти, профиль, со спины");
  });

  test("own scenes being written from an idea count as own scenes already", () => {
    expect(stripAnglesText(sceneSet(written(2), { write: { kind: "idea", count: 2 } }))).toBe("Ракурсы: анфас, три четверти; у своих сцен — по описанию");
  });

  test("the idea form's hint follows the shot: «Авто» picks shot and angle (the mirror only when the idea names one), a selfie or mirror faces the camera", () => {
    expect(ideaHint(null)).toBe("Модель выберет кадр и ракурс по идее: «вид сзади» — со спины, «сбоку» — профиль; селфи — только анфас или три четверти. Зеркало — только если оно есть в идее.");
    for (const shot of ["friend", "candid", "photographer"] as const) expect(ideaHint(shot)).toBe("Ракурс модель выберет по идее: «вид сзади» — со спины, «сбоку» — профиль.");
    expect(ideaHint("selfie")).toBe("Селфи — только анфас или три четверти: ракурс модель выберет из них. Нужен вид сзади или сбоку — выберите «Авто» или другой кадр.");
    expect(ideaHint("mirror")).toBe("Зеркало — только анфас или три четверти: ракурс модель выберет из них. Нужен вид сзади или сбоку — выберите «Авто» или другой кадр.");
  });

  test("a scene card tags profile and back only", () => {
    expect(poseTag("back")).toBe("со спины");
    expect(poseTag("profile")).toBe("профиль");
    expect(poseTag("front")).toBe(null);
    expect(poseTag("three-quarter")).toBe(null);
  });
});

describe("column notices", () => {
  test("a compose stopped by a closed Studio, before the reconcile and after it", () => {
    expect(stoppedNotice(stopped(), null)).toEqual({
      title: "Составление прервано · готово 25 из 60",
      text: "Studio закрылась, пока модель писала сцены. Готовые сохранены. Прерванный запрос до сверки расходов учтён по худшей цене — дописать остальные можно после неё. Отрисовать можно только сцены с текстом: пустые допишите или уберите.",
    });
    expect(stoppedNotice(stopped({ openReserveMicros: 0 }), 37_500)).toEqual({
      title: "Составление прервано · готово 25 из 60",
      text: nb("Studio закрылась, пока модель писала сцены. Готовые сохранены; прерванный запрос закрыт при сверке по худшей цене — $0.038 — и считается попыткой: у его 25 сцен осталась одна. Допишите остальные кнопкой «Дописать» или уберите пустые."),
    });
    // A window that never saw the reserve open (opened after the reconcile): nothing it cannot know.
    expect(stoppedNotice(stopped({ openReserveMicros: 0 }), null).text).toBe("Studio закрылась, пока модель писала сцены. Готовые сохранены. Допишите остальные кнопкой «Дописать» или уберите пустые.");
  });

  test("the other reasons a compose stops", () => {
    expect(stoppedNotice(stopped({ stoppedBy: "cancelled" }), null)).toEqual({
      title: "Составление остановлено · готово 25 из 60",
      text: "Вы отменили составление. Готовые сцены сохранены. Оборванный запрос до сверки расходов учтён по худшей цене — дописать остальные можно после неё.",
    });
    expect(stoppedNotice(stopped({ stoppedBy: "rate-limited", openReserveMicros: 0 }), null).text).toBe(
      "OpenRouter ответил 429 — слишком много запросов. Готовые сцены сохранены; ответ с ошибкой не списывается. Допишите остальные, когда он снова ответит, или уберите пустые.",
    );
    expect(stoppedNotice(stopped({ stoppedBy: "network" }), null).text).toBe(
      "Связь с OpenRouter оборвалась. Готовые сцены сохранены. Запрос мог дойти — до сверки расходов он учтён по худшей цене; дописать остальные можно после неё.",
    );
  });

  test("a compose that ended with scenes left out", () => {
    const set = sceneSet([...written(35), ...Array.from({ length: 25 }, (_, i) => gaveUp(36 + i))], { lastCompose: { total: 60, written: 35, gaveUp: 25 } });
    expect(gaveUpNotice(set)).toEqual({
      title: "Готово 35 из 60 · 25 не составлены",
      text: "Отброшены при проверке: модель дважды вернула для них неподходящий текст. Уберите их, попросите другие или напишите сами.",
    });
    const refused = sceneSet([...written(35), ...Array.from({ length: 25 }, (_, i) => gaveUp(36 + i, "refused"))], { lastCompose: { total: 60, written: 35, gaveUp: 25 } });
    expect(gaveUpNotice(refused).text).toBe("Модель отказалась писать их — отказ провайдера, тот же запрос откажут снова. Уберите их, попросите другие (новое место) или напишите сами.");
  });

  test("a rewrite cut short: the scene stayed as it was; the reserve told by what the window knows of it", () => {
    const group = { write: 3, stoppedBy: "closed" as const, sceneIds: [2], removed: [] };
    expect(rewriteNotice(group, "planned", "open")).toEqual({
      title: "Замена сцены 02 прервана",
      text: "Studio закрылась, пока модель писала другую сцену 02, — сцена осталась как была. Остальной набор в порядке.",
    });
    expect(rewriteNotice(group, "planned", "reconciled").text).toBe("Studio закрылась, пока модель писала другую сцену 02, — сцена осталась как была. Прерванный запрос закрыт при сверке по худшей цене.");
    expect(rewriteNotice({ ...group, stoppedBy: "cancelled" }, "planned", "open")).toEqual({
      title: "Замена сцены 02 отменена",
      text: "Вы отменили замену сцены 02 посреди запроса — сцена осталась как была. Оборванный запрос до сверки расходов учтён по худшей цене.",
    });
    expect(rewriteNotice({ ...group, stoppedBy: "rate-limited" }, "planned", "none")).toEqual({
      title: "Замена сцены 02 не удалась",
      text: "OpenRouter ответил 429 — слишком много запросов. Сцена 02 осталась как была; ответ с ошибкой не списывается.",
    });
    expect(rewriteNotice({ ...group, stoppedBy: "network" }, "planned", "open").text).toBe(
      "Связь с OpenRouter оборвалась. Сцена 02 осталась как была. Запрос мог дойти — до сверки расходов он учтён по худшей цене.",
    );
  });

  test("a rewrite of a scene since removed says how to carry it on", () => {
    expect(rewriteNotice({ write: 3, stoppedBy: "closed", sceneIds: [5], removed: [5] }, "planned", "none").text).toBe(
      "Studio закрылась, пока модель писала другую сцену 05, — сцена осталась как была. Остальной набор в порядке. Сцена 05 убрана — верните её, чтобы повторить.",
    );
  });

  test("an idea write cut short: nothing was added, the idea is kept", () => {
    const idea = { write: 4, idea: "Утренний кофе на балконе", count: 2, shot: null, stoppedBy: "closed" as const };
    expect(ideaNotice(idea, "open")).toEqual({
      title: "Свои сцены не написаны",
      text: nb("Studio закрылась, пока модель писала 2 сцены по вашему описанию, — они не добавлены. Текст идеи сохранён."),
    });
    expect(ideaNotice({ ...idea, count: 1 }, "open").title).toBe("Своя сцена не написана");
  });

  test("a set made into a run, once the run is drawn", () => {
    expect(runDoneText(19)).toBe(nb("В галерее 19 фото этого набора. Новый набор — кнопкой «Составить» в карточке."));
  });

  test("review off with a set open", () => {
    expect(offNoteSet(sceneSet([...written(19), scene(20, { removed: true })]))).toBe(nb("Открытый набор — 19 сцен с вашими правками — сохранён. Включите проверку, чтобы вернуться к нему."));
    expect(offNoteSet(sceneSet(written(20)))).toBe(nb("Открытый набор — 20 сцен — сохранён. Включите проверку, чтобы вернуться к нему."));
  });

  test("review off while a write of the set runs (another window's): the set is being written, not saved (CS.7 M3)", () => {
    expect(offNoteSet(sceneSet(written(20), { status: "writing", write: { kind: "compose", count: 20 } }))).toBe(
      nb("Открытый набор — 20 сцен — пишется. Включите проверку, чтобы вернуться к нему."),
    );
  });
});

describe("the task line of a scenes job", () => {
  test("its label", () => {
    expect(progressLabel({ kind: "compose", count: 20 }, 0, 20, [])).toBe("Составляем сцены: 0 из 20");
    // «Дописать» says what its button says («Дописываем…»), CS.7 L2.
    expect(progressLabel({ kind: "unwritten", count: 35 }, 25, 35, [])).toBe("Дописываем сцены: 25 из 35");
    expect(progressLabel({ kind: "rewrite", count: 1, sceneIds: [2] }, 0, 1, [scene(2)])).toBe("Пишем другую сцену вместо 02");
    expect(progressLabel({ kind: "rewrite", count: 1, sceneIds: [21] }, 0, 1, [scene(21, { origin: "own" })])).toBe("Переписываем сцену 21");
    expect(progressLabel({ kind: "rewrite", count: 3, sceneIds: [26, 27, 28] }, 0, 3, [])).toBe("Пишем другие сцены вместо 26, 27, 28");
    expect(progressLabel({ kind: "idea", count: 2 }, 0, 2, [])).toBe(nb("Пишем 2 своих сцены по описанию"));
    expect(progressLabel({ kind: "idea", count: 1 }, 0, 1, [])).toBe(nb("Пишем 1 свою сцену по описанию"));
  });

  test("its note: the model and the requests, or what the request in flight may cost", () => {
    expect(progressNote({ kind: "compose", count: 20 }, 0, 20, "x-ai/grok-4.3", null)).toBe("grok-4.3 · до 25 сцен за запрос · обычно 10–20 с");
    expect(progressNote({ kind: "compose", count: 60 }, 25, 60, "x-ai/grok-4.3", null)).toBe("запрос 2 из 3 · grok-4.3 · по 25 сцен за запрос");
    const price = { expectedMicros: 2_300, worstMicros: 75_000, prices: "fallback" as const, pricesAsOf: "2026-10-05" };
    expect(progressNote({ kind: "rewrite", count: 1, sceneIds: [2] }, 0, 1, "x-ai/grok-4.3", price)).toBe("≈ $0.002 · до $0.075 · правки набора — после неё");
    expect(progressNote({ kind: "idea", count: 2 }, 0, 2, "x-ai/grok-4.3", price)).toBe("≈ $0.002 · до $0.075 · правки набора — после них");
    expect(progressNote({ kind: "idea", count: 2 }, 0, 2, "x-ai/grok-4.3", null)).toBe("правки набора — после них");
  });
});

describe("the price source beside «Цены» (CS.7 V1)", () => {
  test("the day and month; the year only when it is not this one, so the line fits at both widths", () => {
    const now = new Date("2026-10-07T12:00:00Z");
    expect(priceSourceText("live", "2026-09-24", now)).toBe("OpenRouter · 24 сент.");
    expect(priceSourceText("fallback", "2026-09-24", now)).toBe("резервные · 24 сент.");
    expect(priceSourceText("fallback", "2025-12-30", now)).toBe("резервные · 30 дек. 2025 г.");
    expect(priceSourceText(null, null, now)).toBe("—");
  });
});

describe("«Пересоставить сцены?»", () => {
  test("what goes with the set, and what it already cost", () => {
    const set = sceneSet([scene(1), scene(2, { edited: true }), scene(3, { removed: true }), scene(21, { origin: "own" }), scene(22, { origin: "own" })], { spentMicros: 15_000 });
    expect(recomposeLosses(set, 2)).toEqual([
      nb("2 свои сцены — написаны по описанию, за них заплачено;"),
      nb("2 сцены, заменённые моделью («Другая сцена»);"),
      nb("1 правка текста и 1 убранная сцена."),
    ]);
    expect(recomposeLosses(sceneSet(written(3)), 0)).toEqual([]);
    // The amount on its own, to be set in mono (CS.7 V5), the sentence around it.
    const spent = recomposeSpent(set);
    expect(spent === null ? null : `${spent.before}${spent.amount}${spent.after}`).toBe("Набор уже стоил $0.015. Эти деньги потрачены и не вернутся.");
    expect(spent?.amount).toBe("$0.015");
    const open = recomposeSpent(sceneSet(written(3), { spentMicros: 46_500, openReserveMicros: 37_500 }));
    expect(open === null ? null : `${open.before}${open.amount}${open.after}`).toBe("Набор уже стоил до $0.047. Эти деньги потрачены и не вернутся.");
    expect(open?.amount).toBe("$0.047");
    expect(recomposeSpent(sceneSet([], { spentMicros: 0 }))).toBe(null);
  });
});
