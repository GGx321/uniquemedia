import { describe, expect, test } from "bun:test";
import { fireEvent, screen, within } from "@testing-library/react";
import { bodyPhrase, DESCRIPTOR_REASONS_RU, type AvatarBody, type AvatarSummary, type BodyProposal } from "../../shared/engine";
import { MIA } from "../engine/mockEngine.testkit";
import { descriptorHead } from "../lib/body";
import { callsOf, describeElement, flush, focusedLabel, runAll, setup } from "../testing";
import { BODY_HELD_REASON } from "./look/lookModel";

// S5.2d: «Тело» on the avatar's «Внешность» against the mock engine (.omc/stage5/design 05–08): the summary and «Задать тело» (07), «Изменить тело»
// with «Описание» previewing the phrase (08), an import's proposal with «с фото» / «не видно на фото», «Сохранить тело» / «Позже» / «Не нужно»
// (05–06), the free `avatars.setBody` and its refusals, and the description's counter beside a body phrase (L10). «Телосложение» is read-only here
// (D1): the build word lives in the description's text.

const TEXT = MIA.descriptor.text;
const AT = "2026-10-10T10:00:00.000Z";
const HIDDEN: BodyProposal["seen"] = {
  height: "not-visible",
  bust: "not-visible",
  figure: "not-visible",
  legLength: "not-visible",
  legShape: "not-visible",
  bottomSize: "not-visible",
  bottomShape: "not-visible",
  bodyMarks: "not-visible",
};
const FACE_ONLY: BodyProposal = { values: {}, seen: HIDDEN, at: AT };
const WAIST: BodyProposal = { values: { bust: "medium", figure: "hourglass" }, seen: { ...HIDDEN, bust: "photo", figure: "photo" }, at: AT };
/** Nini's body before the mockup's 08. */
const OLD: AvatarBody = { height: "tall", bust: "full", figure: "straight" };

const text = (el: Element): string => el.textContent ?? "";
const isDisabled = (el: HTMLElement): boolean => el.hasAttribute("disabled");
const isChecked = (el: HTMLElement): boolean => el instanceof HTMLInputElement && el.checked;
const bodyCard = (): HTMLElement => screen.getByRole("region", { name: "Тело" });
const descCard = (): HTMLElement => screen.getByRole("region", { name: "Описание" });
const checkCard = (): HTMLElement => screen.getByRole("region", { name: "Сверка с фото" });
const inBody = () => within(bodyCard());
const radio = (group: RegExp, option: string): HTMLElement => within(inBody().getByRole("group", { name: group })).getByRole("radio", { name: option });
const pick = (group: RegExp, option: string): void => {
  fireEvent.click(radio(group, option));
};
const said = (card: HTMLElement): string => within(card).getAllByRole("status").map(text).join(" | ");
/** The summary as rows: «Рост» → «Средний». */
const summary = (): string[][] => Array.from(bodyCard().querySelectorAll(".body-sum > div")).map((row) => [text(row.querySelector("dt") ?? row), text(row.querySelector("dd") ?? row)]);
/** The phrase at the end of the description: kept, struck out (−) and inserted (+) runs. */
function tailRuns(): string[] {
  const tail = descCard().querySelector(".desc-body");
  if (tail === null) return [];
  return Array.from(tail.childNodes).map((node) => {
    const words = (node.textContent ?? "").replace(/^(убрать|вставить): /, "");
    return node.nodeName === "DEL" ? `−${words}` : node.nodeName === "INS" ? `+${words}` : words;
  });
}
const counter = (): string => text(descCard().querySelector(".look-desc-meta .mono") ?? descCard());

async function openLook(avatar: AvatarSummary, options: Parameters<typeof setup>[0] = {}) {
  const harness = setup({ avatars: [avatar], ...options });
  fireEvent.click(await screen.findByRole("button", { name: avatar.name }));
  await screen.findByRole("heading", { level: 1, name: avatar.name });
  fireEvent.click(screen.getByRole("tab", { name: "Внешность" }));
  await flush();
  return harness;
}

async function save(): Promise<void> {
  fireEvent.click(inBody().getByRole("button", { name: "Сохранить тело" }));
  await flush();
}

describe("07 · no body yet", () => {
  test("the summary says «не задано» for each field, the build as the description says it, and offers «Задать тело»", async () => {
    await openLook(MIA);
    expect(summary()).toEqual([
      ["Телосложение", "Спортивное"],
      ["Рост", "не задано"],
      ["Грудь", "не задано"],
      ["Фигура", "не задано"],
      ["Ноги", "не задано"],
      ["Попа", "не задано"],
      ["Тату и родинки на теле", "не задано"],
    ]);
    expect(text(bodyCard())).toContain("одно и то же в каждом фото и клипе");
    expect(text(bodyCard().querySelector(".body-nudge") ?? bodyCard())).toBe(
      "Тело не задано. Модель каждый раз рисует его по-своему — от фото к фото фигура разная. Достаточно двух-трёх полей.Задать тело",
    );
    expect(inBody().queryByRole("button", { name: "Изменить тело" }) === null).toBe(true);
    // «Описание» has no phrase to mark yet, and says where one will come from.
    expect(within(descCard()).getByText(TEXT).tagName).toBe("P");
    expect(counter()).toBe(`${TEXT.length} / 600`);
    expect(text(descCard())).toContain("фразы о теле пока нет — она появится, когда вы зададите тело");
  });

  test("«Задать тело» opens the fields, the focus inside; nothing to save until a field is set; the save is free and announced", async () => {
    const { engine, client } = await openLook(MIA);
    fireEvent.click(inBody().getByRole("button", { name: "Задать тело" }));
    await flush();
    expect(bodyCard().className).toContain("look-body-edit");
    expect(focusedLabel()).toBe(describeElement(radio(/^Рост/, "не задано")));
    expect(isDisabled(inBody().getByRole("button", { name: "Сохранить тело" }))).toBe(true);
    expect(text(bodyCard())).toContain("Бесплатно — описание меняется без запроса к модели.");
    expect(text(bodyCard())).not.toContain("$");

    pick(/^Рост/, "Высокий");
    pick(/^Длина ног/, "Длинные");
    expect(isDisabled(inBody().getByRole("button", { name: "Сохранить тело" }))).toBe(false);
    const before = await client.request("money.status", {});
    await save();

    expect(callsOf(engine, "avatars.setBody").map((c) => c.payload)).toEqual([{ avatarId: MIA.avatarId, body: { height: "tall", legLength: "long" } }]);
    // Free: the month's spend is what it was.
    expect(await client.request("money.status", {})).toEqual(before);
    expect(bodyCard().className).not.toContain("look-body-edit");
    expect(summary().slice(1, 5)).toEqual([
      ["Рост", "Высокий"],
      ["Грудь", "не задано"],
      ["Фигура", "не задано"],
      ["Ноги", "Длинные"],
    ]);
    expect(focusedLabel()).toBe(describeElement(inBody().getByRole("button", { name: "Изменить тело" })));
    expect(said(bodyCard())).toBe("Тело сохранено");
    // The phrase now ends the description, marked, and the text's limit leaves room for it (L10).
    const phrase = "tall and long legs";
    expect(text(descCard().querySelector(".descriptor-text") ?? descCard())).toBe(`${descriptorHead(TEXT)}; ${phrase}.`);
    expect(counter()).toBe(`${TEXT.length} / ${600 - 2 - phrase.length}`);
  });

  test("«Отмена» and Escape close the fields without a word to the engine", async () => {
    const { engine } = await openLook(MIA);
    fireEvent.click(inBody().getByRole("button", { name: "Задать тело" }));
    await flush();
    pick(/^Грудь/, "Большая");
    fireEvent.click(inBody().getByRole("button", { name: "Отмена" }));
    await flush();
    expect(bodyCard().className).not.toContain("look-body-edit");
    expect(focusedLabel()).toBe(describeElement(inBody().getByRole("button", { name: "Задать тело" })));

    fireEvent.click(inBody().getByRole("button", { name: "Задать тело" }));
    await flush();
    expect(isChecked(radio(/^Грудь/, "не задано"))).toBe(true);
    fireEvent.keyDown(radio(/^Грудь/, "не задано"), { key: "Escape" });
    await flush();
    expect(bodyCard().className).not.toContain("look-body-edit");
    expect(callsOf(engine, "avatars.setBody")).toHaveLength(0);
  });
});

describe("08 · «Изменить тело»", () => {
  const NINI: AvatarSummary = { ...MIA, name: "Nini", body: OLD };

  test("the summary and the description carry her body; «Изменить тело» opens it in two columns with «Телосложение» read-only", async () => {
    await openLook(NINI);
    expect(summary().slice(0, 4)).toEqual([
      ["Телосложение", "Спортивное"],
      ["Рост", "Высокий"],
      ["Грудь", "Большая"],
      ["Фигура", "Прямая"],
    ]);
    const phrase = bodyPhrase(OLD) ?? "";
    expect(phrase).toBe("tall, a full bust and a straight figure");
    expect(text(descCard().querySelector(".descriptor-text") ?? descCard())).toBe(`${descriptorHead(TEXT)}; ${phrase}.`);
    expect(text(descCard().querySelector(".desc-body") ?? descCard())).toBe(phrase);
    expect(text(descCard())).toContain("фраза о теле — её пишет блок «Тело», не модель");

    fireEvent.click(inBody().getByRole("button", { name: "Изменить тело" }));
    await flush();
    expect(bodyCard().querySelector(".body-grid .body-col") === null).toBe(false);
    expect(Array.from(bodyCard().querySelectorAll(".body-rows .body-legend")).map(text)).toEqual(["Ноги · длина и форма", "Попа · размер и форма"]);
    // D1: no control for the build here — it is the description's word, changed through «Изменить текст».
    expect(inBody().queryByRole("group", { name: /^Телосложение/ }) === null).toBe(true);
    expect(text(bodyCard().querySelector(".body-build") ?? bodyCard())).toBe("ТелосложениеСпортивноеменяется в «Описании»");
    expect(text(bodyCard())).toContain("изменения — только в новых фото и клипах; готовые не меняются");
    expect(isChecked(radio(/^Рост/, "Высокий"))).toBe(true);
    expect(isChecked(radio(/^Фигура/, "Прямая"))).toBe(true);
    expect(text(inBody().getByRole("group", { name: /^Тату и родинки на теле/ }).querySelector("legend") ?? bodyCard())).toBe("Тату и родинки на теле, до двух");
  });

  test("«Описание» previews the change slot by slot, and its limit follows the new phrase; the text edit waits meanwhile", async () => {
    await openLook(NINI);
    fireEvent.click(inBody().getByRole("button", { name: "Изменить тело" }));
    await flush();
    expect(within(descCard()).getByText("предпросмотр").className).toBe("tag tag-info");
    expect(within(descCard()).queryByRole("button", { name: "Изменить текст" }) === null).toBe(true);
    expect(text(descCard())).toContain("меняется только фраза о теле — остальной текст не трогается");
    // Nothing changed yet: the phrase as it is.
    expect(tailRuns()).toEqual(["tall, a full bust and a straight figure"]);

    pick(/^Рост/, "Средний");
    pick(/^Грудь/, "Небольшая");
    pick(/^Фигура/, "Перевёрнутый треугольник");
    pick(/^Длина ног/, "Длинные");
    pick(/^Форма ног/, "Стройные");
    pick(/^Размер попы/, "Небольшая");
    pick(/^Форма попы/, "Подтянутая");
    fireEvent.click(screen.getByRole("checkbox", { name: "Родинка, ключица" }));
    expect(tailRuns()).toEqual([
      "−tall",
      "+average height",
      ", ",
      "−a full bust",
      "+a small bust",
      ", ",
      "−a straight figure",
      "+an inverted-triangle figure with shoulders broader than her hips",
      ", ",
      "+long slim legs",
      ", ",
      "+a small toned bottom",
      " and ",
      "+a small mole on her left collarbone",
    ]);
    const next = "average height, a small bust, an inverted-triangle figure with shoulders broader than her hips, long slim legs, a small toned bottom and a small mole on her left collarbone";
    expect(counter()).toBe(`${TEXT.length} / ${600 - 2 - next.length}`);
    expect(text(inBody().getByRole("group", { name: /^Тату и родинки на теле/ }).querySelector("legend") ?? bodyCard())).toBe("Тату и родинки на теле, 1 из 2");
  });

  test("a field put back to «не задано» leaves the body: setBody replaces the whole body", async () => {
    const { engine } = await openLook(NINI);
    fireEvent.click(inBody().getByRole("button", { name: "Изменить тело" }));
    await flush();
    pick(/^Рост/, "не задано");
    expect(tailRuns()).toEqual(["−tall, ", "a full bust and a straight figure"]);
    await save();
    expect(callsOf(engine, "avatars.setBody").map((c) => c.payload.body)).toEqual([{ bust: "full", figure: "straight" }]);
    expect(summary()[1]).toEqual(["Рост", "не задано"]);
  });

  test("every field back to «не задано» clears the body: the summary offers «Задать тело» again", async () => {
    const { engine } = await openLook(NINI);
    fireEvent.click(inBody().getByRole("button", { name: "Изменить тело" }));
    await flush();
    pick(/^Рост/, "не задано");
    pick(/^Грудь/, "не задано");
    pick(/^Фигура/, "не задано");
    // The whole phrase goes, its «; » and period with it: the text then ends the descriptor (review L5).
    expect(tailRuns()).toEqual(["−; tall, a full bust and a straight figure."]);
    expect(text(descCard().querySelector(".descriptor-text") ?? descCard())).toBe(`${descriptorHead(TEXT)}убрать: ; tall, a full bust and a straight figure.`);
    expect(counter()).toBe(`${TEXT.length} / 600`);
    await save();
    expect(callsOf(engine, "avatars.setBody").map((c) => c.payload.body)).toEqual([{}]);
    expect(inBody().getByRole("button", { name: "Задать тело" }).tagName).toBe("BUTTON");
    expect(within(descCard()).getByText(TEXT).tagName).toBe("P");
    expect(counter()).toBe(`${TEXT.length} / 600`);
  });
});

describe("setBody refused", () => {
  const NINI: AvatarSummary = { ...MIA, name: "Nini", body: OLD };

  async function editAndSave(avatar: AvatarSummary = NINI): Promise<ReturnType<typeof setup>> {
    const harness = await openLook(avatar);
    fireEvent.click(inBody().getByRole("button", { name: avatar.body === undefined ? "Задать тело" : "Изменить тело" }));
    await flush();
    pick(/^Рост/, "Средний");
    return harness;
  }

  test("IN_FLIGHT (another job holds her): the reason, and the fields stay open as they were", async () => {
    const harness = await editAndSave();
    harness.engine.setAvatarEditing(MIA.avatarId, true);
    await save();
    expect(text(inBody().getByRole("alert"))).toBe(BODY_HELD_REASON);
    expect(isChecked(radio(/^Рост/, "Средний"))).toBe(true);
    expect(summary()).toEqual([]);
    // Once the job ends, the same click saves.
    harness.engine.setAvatarEditing(MIA.avatarId, false);
    await save();
    expect(callsOf(harness.engine, "avatars.setBody").map((c) => c.payload.body.height)).toEqual(["average", "average"]);
    expect(summary()[1]).toEqual(["Рост", "Средний"]);
  });

  test("too long with the body, seen before the click: the reason, and «Сохранить тело» waits", async () => {
    // 590 characters of description leave 8 for «; » and a phrase.
    const long: AvatarSummary = { ...MIA, name: "Lena", descriptor: { age: 25, text: "25-year-old woman, ".padEnd(590, "x") } };
    const { engine } = await openLook(long);
    fireEvent.click(inBody().getByRole("button", { name: "Задать тело" }));
    await flush();
    pick(/^Рост/, "Высокий");
    expect(isDisabled(inBody().getByRole("button", { name: "Сохранить тело" }))).toBe(false);
    pick(/^Грудь/, "Большая");
    expect(text(inBody().getByRole("alert"))).toBe(DESCRIPTOR_REASONS_RU["too-long-with-body"]);
    expect(isDisabled(inBody().getByRole("button", { name: "Сохранить тело" }))).toBe(true);
    expect(counter()).toBe(`590 / ${600 - 2 - "tall and a full bust".length}`);
    expect(descCard().querySelector(".look-desc-meta .danger-text") === null).toBe(false);
    expect(callsOf(engine, "avatars.setBody")).toHaveLength(0);
  });

  test("too long with the body, answered by the engine (the text moved meanwhile): its reason", async () => {
    const { engine } = await editAndSave();
    engine.failNext("avatars.setBody", { code: "VALIDATION", descriptorReason: "too-long-with-body", detail: "over" });
    await save();
    expect(text(inBody().getByRole("alert"))).toBe(DESCRIPTOR_REASONS_RU["too-long-with-body"]);
  });

  test("invalid: the contract's reason, and the fields stay for another try", async () => {
    const { engine } = await editAndSave();
    engine.failNext("avatars.setBody", { code: "VALIDATION", descriptorReason: "invalid", detail: "the rules" });
    await save();
    expect(text(inBody().getByRole("alert"))).toBe(DESCRIPTOR_REASONS_RU.invalid);
    // A change clears the reason; the next save goes.
    pick(/^Рост/, "Высокий");
    expect(inBody().queryByRole("alert") === null).toBe(true);
  });

  test("while this window's own check runs, the save waits with the reason (the engine would answer IN_FLIGHT)", async () => {
    const { engine, scheduler } = await openLook(NINI);
    engine.delayNext("avatars.checkDescriptor", 1_000);
    fireEvent.click(within(checkCard()).getByRole("button", { name: /Проверить описание/ }));
    await flush();
    fireEvent.click(inBody().getByRole("button", { name: "Изменить тело" }));
    await flush();
    pick(/^Рост/, "Средний");
    expect(isDisabled(inBody().getByRole("button", { name: "Сохранить тело" }))).toBe(true);
    expect(text(bodyCard())).toContain(`${BODY_HELD_REASON}.`);
    runAll(scheduler);
    await flush();
    expect(isDisabled(inBody().getByRole("button", { name: "Сохранить тело" }))).toBe(false);
  });
});

describe("05 · an import's proposal, face only", () => {
  const LEA: AvatarSummary = { ...MIA, name: "Lea", bodyProposal: FACE_ONLY };

  test("«Тело» opens at once: every field «не видно на фото», the build «угадано по лицу», the hint, and three ways out", async () => {
    await openLook(LEA);
    expect(bodyCard().className).toContain("look-body-edit");
    expect(text(bodyCard().querySelector(".look-body-hint") ?? bodyCard())).toBe("на фото только лицо — тело выберите сами или оставьте «не задано»");
    expect(Array.from(bodyCard().querySelectorAll(".src-none")).length).toBe(6);
    expect(text(bodyCard().querySelector(".body-build .src-guess") ?? bodyCard())).toBe("угадано по лицу");
    expect(inBody().getByRole("group", { name: "Длина ног, не видно на фото" }).tagName).toBe("FIELDSET");
    expect(isChecked(radio(/^Рост/, "не задано"))).toBe(true);
    expect(inBody().getAllByRole("button").map(text)).toEqual(["Сохранить тело", "Позже", "Не нужно"]);
    // Saving what the photo could not show is still a decision: it clears the proposal.
    expect(isDisabled(inBody().getByRole("button", { name: "Сохранить тело" }))).toBe(false);
    // Nothing to preview: «Описание» is as it is, and can be edited.
    expect(within(descCard()).queryByText("предпросмотр") === null).toBe(true);
    expect(isDisabled(within(descCard()).getByRole("button", { name: "Изменить текст" }))).toBe(false);
  });

  test("«Позже» keeps the proposal: the card says it waits and «Посмотреть» brings it back", async () => {
    const { engine } = await openLook(LEA);
    pick(/^Грудь/, "Средняя");
    fireEvent.click(inBody().getByRole("button", { name: "Позже" }));
    await flush();
    expect(bodyCard().className).not.toContain("look-body-edit");
    expect(text(bodyCard().querySelector(".body-nudge") ?? bodyCard())).toBe("Тело с фото ждёт решения. Импорт прочитал его с фото — сохраните, поправьте или откажитесь.Посмотреть");
    expect(focusedLabel()).toBe(describeElement(inBody().getByRole("button", { name: "Посмотреть" })));
    expect(callsOf(engine, "avatars.setBody").length + callsOf(engine, "avatars.dismissBodyProposal").length).toBe(0);
    fireEvent.click(inBody().getByRole("button", { name: "Посмотреть" }));
    await flush();
    expect(bodyCard().className).toContain("look-body-edit");
    expect(isChecked(radio(/^Грудь/, "не задано"))).toBe(true);
  });

  test("«Позже», then a look at «Фото» and back: the proposal opens again", async () => {
    await openLook(LEA);
    fireEvent.click(inBody().getByRole("button", { name: "Позже" }));
    await flush();
    fireEvent.click(screen.getByRole("tab", { name: "Фото" }));
    await flush();
    fireEvent.click(screen.getByRole("tab", { name: "Внешность" }));
    await flush();
    expect(bodyCard().className).toContain("look-body-edit");
  });

  test("«Не нужно» drops the proposal (free) and leaves the body unset", async () => {
    const { engine } = await openLook(LEA);
    fireEvent.click(inBody().getByRole("button", { name: "Не нужно" }));
    await flush();
    expect(callsOf(engine, "avatars.dismissBodyProposal").map((c) => c.payload)).toEqual([{ avatarId: MIA.avatarId }]);
    expect(callsOf(engine, "avatars.setBody")).toHaveLength(0);
    expect(bodyCard().className).not.toContain("look-body-edit");
    expect(inBody().getByRole("button", { name: "Задать тело" }).tagName).toBe("BUTTON");
    expect(bodyCard().querySelector(".body-nudge-info") === null).toBe(true);
    expect(said(bodyCard())).toBe("Тело с фото не сохранено");
  });

  test("«Не нужно» refused IN_FLIGHT: the reason, and the proposal stays", async () => {
    const { engine } = await openLook(LEA);
    engine.setAvatarEditing(MIA.avatarId, true);
    fireEvent.click(inBody().getByRole("button", { name: "Не нужно" }));
    await flush();
    expect(text(inBody().getByRole("alert"))).toBe(BODY_HELD_REASON);
    expect(bodyCard().className).toContain("look-body-edit");
  });

  test("the owner's picks are saved with «Сохранить тело», and the proposal goes with them", async () => {
    const { engine } = await openLook(LEA);
    pick(/^Рост/, "Невысокий");
    pick(/^Форма попы/, "Сердечком");
    await save();
    expect(callsOf(engine, "avatars.setBody").map((c) => c.payload)).toEqual([{ avatarId: MIA.avatarId, body: { height: "short", bottomShape: "heart" } }]);
    expect(bodyCard().className).not.toContain("look-body-edit");
    expect(bodyCard().querySelector(".body-nudge") === null).toBe(true);
    expect(summary()[5]).toEqual(["Попа", "Сердечком"]);
  });
});

describe("06 · an import's proposal, photo to the waist", () => {
  const AVA: AvatarSummary = { ...MIA, name: "Ava", bodyProposal: WAIST };

  test("what the photo showed is chosen and tagged «с фото», the rest «не видно на фото»; the hint names what is missing", async () => {
    await openLook(AVA);
    expect(text(bodyCard().querySelector(".look-body-hint") ?? bodyCard())).toBe("рост, ноги, попу и тату или родинки на фото не видно — выберите сами или оставьте «не задано»");
    expect(isChecked(radio(/^Грудь/, "Средняя"))).toBe(true);
    expect(isChecked(radio(/^Фигура/, "Песочные часы"))).toBe(true);
    expect(inBody().getByRole("group", { name: /^Грудь/ }).querySelector(".src-photo")?.textContent).toBe("с фото");
    expect(inBody().getByRole("group", { name: /^Рост/ }).querySelector(".src-none")?.textContent).toBe("не видно на фото");
    expect(text(bodyCard().querySelector(".body-build .src-photo") ?? bodyCard())).toBe("с фото");
    // «Описание» previews the phrase the proposal would add: all of it new.
    expect(within(descCard()).getByText("предпросмотр").className).toBe("tag tag-info");
    expect(tailRuns()).toEqual(["+a medium bust", " and ", "+an hourglass figure"]);
  });

  test("«Сохранить тело» saves what the photo showed", async () => {
    const { engine } = await openLook(AVA);
    await save();
    expect(callsOf(engine, "avatars.setBody").map((c) => c.payload.body)).toEqual([{ bust: "medium", figure: "hourglass" }]);
    expect(summary().slice(2, 4)).toEqual([
      ["Грудь", "Средняя"],
      ["Фигура", "Песочные часы"],
    ]);
  });

  test("with a check's proposal too, «Описание» shows both: the text fix, then the body phrase to come", async () => {
    const { engine } = await openLook(AVA);
    engine.setNextDescriptorCheck({
      matches: false,
      aspects: { hair: { state: "ok" }, eyes: { state: "mismatch", descriptor: "ореховые", photo: "зелёные" }, marks: { state: "ok" }, body: { state: "ok" } },
      proposal: TEXT.replace("hazel eyes", "green eyes"),
      checkedText: TEXT,
    });
    fireEvent.click(within(checkCard()).getByRole("button", { name: /Проверить описание/ }));
    await flush();
    expect(within(descCard()).getByText("предложение сверки").className).toContain("tag-warn");
    const fixed = TEXT.replace("hazel eyes", "green eyes");
    // The fix is judged beside her STORED body (none yet), whatever the body edit previews (review L2).
    expect(counter()).toBe(`${fixed.length} / 600`);
    expect(Array.from(descCard().querySelectorAll(".descriptor-text > del, .descriptor-text > ins")).map(text)).toEqual(["убрать: hazel", "вставить: green"]);
    expect(tailRuns()).toEqual(["+a medium bust", " and ", "+an hourglass figure"]);
  });

  test("«Оставить» while the body is previewed: the focus stays in «Описание», not lost to the page (review M2)", async () => {
    const { engine } = await openLook(AVA);
    engine.setNextDescriptorCheck({
      matches: false,
      aspects: { hair: { state: "ok" }, eyes: { state: "mismatch", descriptor: "ореховые", photo: "зелёные" }, marks: { state: "ok" }, body: { state: "ok" } },
      proposal: TEXT.replace("hazel eyes", "green eyes"),
      checkedText: TEXT,
    });
    fireEvent.click(within(checkCard()).getByRole("button", { name: /Проверить описание/ }));
    await flush();
    fireEvent.click(within(descCard()).getByRole("button", { name: "Оставить" }));
    await flush();
    // The preview has no «Изменить текст» to go back to: the card itself takes the focus.
    expect(within(descCard()).queryByRole("button", { name: "Изменить текст" }) === null).toBe(true);
    expect(focusedLabel()).toBe(describeElement(descCard()));
    expect(descCard().getAttribute("tabindex")).toBe("-1");
  });
});

describe("the description beside a body phrase (L10)", () => {
  const BODY: AvatarBody = { height: "tall", legLength: "long", legShape: "slim" };
  const PHRASE = "tall and long slim legs";
  const LIMIT = 600 - 2 - PHRASE.length;
  const SOFIA: AvatarSummary = { ...MIA, name: "Sofia", body: BODY };

  test("«Изменить текст» counts against 600 less «; » and the phrase, and says why", async () => {
    await openLook(SOFIA);
    expect(counter()).toBe(`${TEXT.length} / ${LIMIT}`);
    fireEvent.click(within(descCard()).getByRole("button", { name: "Изменить текст" }));
    await flush();
    expect(counter()).toBe(`${TEXT.length} / ${LIMIT}`);
    expect(text(descCard())).toContain(`Ещё ${2 + PHRASE.length} знаков занимает фраза о теле — на текст остаётся ${LIMIT} из 600.`);
    expect(2 + PHRASE.length).toBe(25);
    fireEvent.change(within(descCard()).getByRole("textbox", { name: "Текст описания" }), { target: { value: TEXT.padEnd(LIMIT + 1, "x") } });
    expect(counter()).toBe(`${LIMIT + 1} / ${LIMIT}`);
    expect(descCard().querySelector(".look-desc-meta .danger-text") === null).toBe(false);
  });

  test("the count of characters the phrase takes is said in the right plural (review L6)", async () => {
    // «tall and a full bust» is 20 characters: with «; », 22 — «22 знака».
    await openLook({ ...MIA, name: "Lena", body: { height: "tall", bust: "full" } });
    fireEvent.click(within(descCard()).getByRole("button", { name: "Изменить текст" }));
    await flush();
    expect(text(descCard())).toContain(`Ещё 22 знака занимает фраза о теле — на текст остаётся ${600 - 22} из 600.`);
  });

  test("a text that fits alone but not with the phrase is refused with the body's reason", async () => {
    const { engine } = await openLook(SOFIA);
    fireEvent.click(within(descCard()).getByRole("button", { name: "Изменить текст" }));
    fireEvent.change(within(descCard()).getByRole("textbox", { name: "Текст описания" }), { target: { value: TEXT.replace(/\.$/, "").padEnd(LIMIT + 1, "x") } });
    fireEvent.click(within(descCard()).getByRole("button", { name: "Сохранить" }));
    await flush();
    expect(callsOf(engine, "avatars.editDescriptor")).toHaveLength(1);
    expect(text(within(descCard()).getByRole("alert"))).toBe(DESCRIPTOR_REASONS_RU["too-long-with-body"]);
  });

  test("a check's proposal counts the same way", async () => {
    const { engine } = await openLook(SOFIA);
    engine.setNextDescriptorCheck({
      matches: false,
      aspects: { hair: { state: "mismatch", descriptor: "волнистые", photo: "прямые" }, eyes: { state: "ok" }, marks: { state: "ok" }, body: { state: "not-visible" } },
      proposal: TEXT.replace("wavy", "straight"),
      checkedText: TEXT,
    });
    fireEvent.click(within(checkCard()).getByRole("button", { name: /Проверить описание/ }));
    await flush();
    expect(counter()).toBe(`${TEXT.replace("wavy", "straight").length} / ${LIMIT}`);
    expect(text(descCard().querySelector(".desc-body") ?? descCard())).toBe(PHRASE);
  });
});

describe("a body mismatch at the check", () => {
  test("points at the «Тело» card: a body is never fixed in text", async () => {
    const { engine } = await openLook(MIA);
    engine.setNextDescriptorCheck({
      matches: false,
      aspects: { hair: { state: "ok" }, eyes: { state: "ok" }, marks: { state: "ok" }, body: { state: "mismatch", descriptor: "спортивное", photo: "мягкие формы" } },
      proposal: null,
      checkedText: TEXT,
    });
    fireEvent.click(within(checkCard()).getByRole("button", { name: /Проверить описание/ }));
    await flush();
    expect(text(checkCard())).toContain("Тело на фото другое — поправьте его в карточке «Тело» справа, а телосложение — в «Описании».");
  });

  test("beside a text mismatch, both pointers show (review L1)", async () => {
    const { engine } = await openLook(MIA);
    engine.setNextDescriptorCheck({
      matches: false,
      aspects: {
        hair: { state: "mismatch", descriptor: "волнистые", photo: "прямые" },
        eyes: { state: "ok" },
        marks: { state: "ok" },
        body: { state: "mismatch", descriptor: "спортивное", photo: "мягкие формы" },
      },
      proposal: TEXT.replace("wavy", "straight"),
      checkedText: TEXT,
    });
    fireEvent.click(within(checkCard()).getByRole("button", { name: /Проверить описание/ }));
    await flush();
    expect(Array.from(checkCard().querySelectorAll(".chk-pointer")).map(text)).toEqual([
      "Исправленный текст — в «Описании» справа. Сам он не применится.",
      "Тело на фото другое — поправьте его в карточке «Тело» справа, а телосложение — в «Описании».",
    ]);
  });
});
