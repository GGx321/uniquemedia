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
/** A head-and-shoulders photo: only the bust was read (an import never stores a proposal with no value). */
const HEAD: BodyProposal = { values: { bust: "small" }, seen: { ...HIDDEN, bust: "photo" }, at: AT };
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

/** The real path of an import: from the grid, a photo picked and named Zoe, «Импортировать», landing on her «Внешность». */
async function importZoe(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Импортировать аватара" }));
  await screen.findByRole("heading", { level: 1, name: "Импортировать аватара" });
  fireEvent.click(screen.getByRole("button", { name: /Выбрать фото/ }));
  await screen.findByRole("button", { name: /Импортировать · до/ });
  fireEvent.change(screen.getByPlaceholderText("Mia"), { target: { value: "Zoe" } });
  fireEvent.click(screen.getByRole("button", { name: /Импортировать · до/ }));
  await screen.findByRole("heading", { level: 1, name: "Zoe" });
  await flush();
}

/** The line over the tab after the landing. */
const landingLine = (): string => text(screen.getByText(/^Аватар «Zoe» импортирован\./));

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

});

describe("08 · «Изменить тело»", () => {
  const NINI: AvatarSummary = { ...MIA, name: "Nini", body: OLD };

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

  test("too long with the body, seen before the click: the reason, and «Сохранить тело» waits", async () => {
    // 590 characters of description leave 8 for «; » and a phrase.
    const long: AvatarSummary = { ...MIA, name: "Lena", descriptor: { age: 25, text: "25-year-old woman, ".padEnd(590, "z") } };
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

});

describe("05 · an import whose photo showed no body (S5.R2: the real path — no proposal is stored)", () => {
  test("«Тело» opens at once: nothing read, «Телосложение» guessed from the face, no marks on the fields, «Сохранить тело» and «Позже»", async () => {
    const { engine } = setup();
    await importZoe();
    expect(callsOf(engine, "avatars.importAvatar")).toHaveLength(1);
    // S5.3d re-pin: the import started its five reference portraits, still drawing here.
    expect(landingLine()).toBe("Аватар «Zoe» импортирован. Описание прочитано с фото и сверено с ним — осталось тело. Рисуем варианты мастер-портрета.");
    expect(bodyCard().className).toContain("look-body-edit");
    expect(text(bodyCard().querySelector(".look-body-hint") ?? bodyCard())).toBe("Тело с фото не прочитано — выберите сами или оставьте «не задано»");
    expect(text(bodyCard().querySelector(".body-build .src-guess") ?? bodyCard())).toBe("угадано по лицу");
    expect(bodyCard().querySelectorAll(".src-none, .src-photo").length).toBe(0);
    expect(inBody().getByRole("group", { name: "Длина ног" }).tagName).toBe("FIELDSET");
    expect(isChecked(radio(/^Рост/, "не задано"))).toBe(true);
    expect(inBody().getAllByRole("button").map(text)).toEqual(["Сохранить тело", "Позже"]);
    // Nothing chosen yet: nothing to save.
    expect(isDisabled(inBody().getByRole("button", { name: "Сохранить тело" }))).toBe(true);
    pick(/^Грудь/, "Средняя");
    expect(isDisabled(inBody().getByRole("button", { name: "Сохранить тело" }))).toBe(false);
    // Nothing to preview before a phrase: «Описание» stays editable.
    pick(/^Грудь/, "не задано");
    expect(within(descCard()).queryByText("предпросмотр") === null).toBe(true);
    expect(isDisabled(within(descCard()).getByRole("button", { name: "Изменить текст" }))).toBe(false);
  });

  test("a pick saved with «Сохранить тело»: free, the fields close, and the line no longer says the body is left", async () => {
    const { engine } = setup();
    await importZoe();
    pick(/^Рост/, "Невысокий");
    pick(/^Форма попы/, "Сердечком");
    await save();
    const zoe = callsOf(engine, "avatars.setBody")[0]?.payload;
    expect(zoe?.body).toEqual({ height: "short", bottomShape: "heart" });
    expect(bodyCard().className).not.toContain("look-body-edit");
    expect(summary()[5]).toEqual(["Попа", "Сердечком"]);
    // S5.3d re-pin: the import started its five reference portraits, still drawing here.
    expect(landingLine()).toBe("Аватар «Zoe» импортирован. Описание прочитано с фото и сверено с ним. Рисуем варианты мастер-портрета.");
  });

});

describe("an import's proposal waits (a head-and-shoulders photo)", () => {
  const LEA: AvatarSummary = { ...MIA, name: "Lea", bodyProposal: HEAD };

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

  test("the owner's picks are saved with «Сохранить тело», with what was read, and the proposal goes with them", async () => {
    const { engine } = await openLook(LEA);
    pick(/^Рост/, "Невысокий");
    pick(/^Форма попы/, "Сердечком");
    await save();
    expect(callsOf(engine, "avatars.setBody").map((c) => c.payload)).toEqual([{ avatarId: MIA.avatarId, body: { height: "short", bust: "small", bottomShape: "heart" } }]);
    expect(bodyCard().className).not.toContain("look-body-edit");
    expect(bodyCard().querySelector(".body-nudge") === null).toBe(true);
    expect(summary()[5]).toEqual(["Попа", "Сердечком"]);
  });
});

describe("06 · an import's proposal, photo to the waist", () => {
  const AVA: AvatarSummary = { ...MIA, name: "Ava", bodyProposal: WAIST };

  test("on the real path: the import stores the proposal, the landing says the body is left, and «Тело» opens with it", async () => {
    const { engine } = setup();
    engine.queueImportBodyProposal(WAIST);
    await importZoe();
    // S5.3d re-pin: the import started its five reference portraits, still drawing here.
    expect(landingLine()).toBe("Аватар «Zoe» импортирован. Описание прочитано с фото и сверено с ним — осталось тело. Рисуем варианты мастер-портрета.");
    expect(bodyCard().className).toContain("look-body-edit");
    expect(isChecked(radio(/^Фигура/, "Песочные часы"))).toBe(true);
    expect(inBody().getAllByRole("button").map(text)).toEqual(["Сохранить тело", "Позже", "Не нужно"]);
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

});

describe("the description beside a body phrase (L10)", () => {
  const BODY: AvatarBody = { height: "tall", legLength: "long", legShape: "slim" };
  const PHRASE = "tall and long slim legs";
  const LIMIT = 600 - 2 - PHRASE.length;
  const SOFIA: AvatarSummary = { ...MIA, name: "Sofia", body: BODY };

  test("a text that fits alone but not with the phrase is refused with the body's reason", async () => {
    const { engine } = await openLook(SOFIA);
    fireEvent.click(within(descCard()).getByRole("button", { name: "Изменить текст" }));
    fireEvent.change(within(descCard()).getByRole("textbox", { name: "Текст описания" }), { target: { value: TEXT.replace(/\.$/, "").padEnd(LIMIT + 1, "z") } });
    fireEvent.click(within(descCard()).getByRole("button", { name: "Сохранить" }));
    await flush();
    expect(callsOf(engine, "avatars.editDescriptor")).toHaveLength(1);
    expect(text(within(descCard()).getByRole("alert"))).toBe(DESCRIPTOR_REASONS_RU["too-long-with-body"]);
  });

});

describe("a body mismatch at the check", () => {
});

describe("a check's body verdict after «Сохранить тело» (S5.R2 LOW)", () => {
  const STALE = "Тело изменено после сверки — проверьте ещё раз.";

  async function checkThenSaveBody(body: "ok" | "mismatch" | "not-visible"): Promise<void> {
    const { engine } = await openLook(MIA);
    engine.setNextDescriptorCheck({
      matches: body !== "mismatch",
      aspects: {
        hair: { state: "ok" },
        eyes: { state: "ok" },
        marks: { state: "ok" },
        body: body === "mismatch" ? { state: "mismatch", descriptor: "спортивное", photo: "мягкие формы" } : { state: body },
      },
      proposal: null,
      checkedText: TEXT,
    });
    fireEvent.click(within(checkCard()).getByRole("button", { name: /Проверить описание/ }));
    await flush();
    expect(text(checkCard())).not.toContain(STALE);
    fireEvent.click(inBody().getByRole("button", { name: "Задать тело" }));
    await flush();
    pick(/^Фигура/, "Груша");
    await save();
  }

  test("a verdict that judged the body says the body changed since, and the check is offered again", async () => {
    await checkThenSaveBody("ok");
    expect(text(checkCard())).toContain(STALE);
    expect(text(checkCard())).toContain("Описание совпадает с фото");
    expect(within(checkCard()).getByRole("button", { name: /^Проверить снова/ }).hasAttribute("disabled")).toBe(false);
  });

});
