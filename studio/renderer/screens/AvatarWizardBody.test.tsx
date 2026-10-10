import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { bodyPhrase, type AvatarBody, type Draft } from "../../shared/engine";
import { MOCK_ESTIMATE, mockDescriptor } from "../engine/mockEngine";
import { bodyOfTraits, bodySetCount, descriptorHead, withBody } from "../lib/body";
import { DEFAULT_TRAITS, randomTraits } from "../lib/traits";
import { callsOf, estimateText, flush, focusedLabel, describeElement, openWizard, setup } from "../testing";

// S5.2d: the wizard's «Тело» (.omc/stage5/design 01–03): the «Лицо и волосы» | «Тело N / 6» tabs, «Телосложение» moved into «Тело», the optional
// fields with a quiet «не задано», at most two body marks, the live preview of the body phrase Studio adds (only that phrase, at the end — never the
// build word: plan r2.1 · N4), «Случайно» filling the body too, and the fixed draft's descriptor with the phrase marked.

const text = (el: Element): string => el.textContent ?? "";
const isChecked = (el: HTMLElement): boolean => el instanceof HTMLInputElement && el.checked;
const isDisabled = (el: HTMLElement): boolean => el.hasAttribute("disabled");

const bodyTab = (): HTMLElement => screen.getByRole("tab", { name: /^Тело/ });
const faceTab = (): HTMLElement => screen.getByRole("tab", { name: "Лицо и волосы" });
const group = (name: RegExp): HTMLElement => screen.getByRole("group", { name });
const radio = (groupName: RegExp, option: string): HTMLElement => within(group(groupName)).getByRole("radio", { name: option });
const pick = (groupName: RegExp, option: string): void => {
  fireEvent.click(radio(groupName, option));
};
const descriptorCard = (): HTMLElement => {
  const card = screen.getByRole("heading", { name: "Дескриптор" }).closest("section");
  if (card === null) throw new Error("no «Дескриптор» card");
  return card;
};
/** The «N / 6» the body tab shows. */
const tabCount = (): string => bodyTab().querySelector(".tab-count")?.textContent ?? "(none)";

/** Mia's body in the mockup's 02: every field set, one mark. */
const BODY: AvatarBody = {
  height: "average",
  bust: "medium",
  figure: "hourglass",
  legLength: "long",
  legShape: "slim",
  bottomSize: "medium",
  bottomShape: "round",
  bodyMarks: ["tattoo-ankle"],
};

function fillBody(): void {
  pick(/^Рост/, "Средний");
  pick(/^Грудь/, "Средняя");
  pick(/^Фигура/, "Песочные часы");
  pick(/^Длина ног/, "Длинные");
  pick(/^Форма ног/, "Стройные");
  pick(/^Размер попы/, "Средняя");
  pick(/^Форма попы/, "Округлая");
  fireEvent.click(screen.getByRole("checkbox", { name: "Тату, щиколотка" }));
}

async function openBody(): Promise<ReturnType<typeof setup>> {
  const harness = setup();
  await openWizard();
  fireEvent.click(bodyTab());
  return harness;
}

describe("01 · the «Тело» tab, empty", () => {
  test("the card opens on «Лицо и волосы»; «Телосложение» is no longer there, and «Тело 0 / 6» waits beside it", async () => {
    setup();
    await openWizard();
    expect(screen.getAllByRole("tab").map(text)).toEqual(["Лицо и волосы", "Тело0 / 6, задано 0 из 6"]);
    expect(faceTab().getAttribute("aria-selected")).toBe("true");
    expect(bodyTab().getAttribute("aria-selected")).toBe("false");
    expect(tabCount()).toBe("0 / 6");
    // The face panel keeps its fields; the build moved to «Тело».
    expect(within(group(/^Типаж$/)).getAllByRole("radio").length).toBe(5);
    expect(screen.queryByRole("group", { name: /^Телосложение/ }) === null).toBe(true);
    // Mockup decision 10: the cheek mole says where it is, so it is never taken for a mole on the body.
    expect(isChecked(screen.getByRole("checkbox", { name: "Родинка на щеке" }))).toBe(false);
  });

  test("«Тело»: «Телосложение» as before, every new field «не задано», the figures as chips, up to two marks", async () => {
    await openBody();
    expect(bodyTab().getAttribute("aria-selected")).toBe("true");
    const panel = document.getElementById(bodyTab().getAttribute("aria-controls") ?? "");
    expect(panel?.getAttribute("role")).toBe("tabpanel");
    expect(panel?.hasAttribute("hidden")).toBe(false);
    expect(document.getElementById(faceTab().getAttribute("aria-controls") ?? "")?.hasAttribute("hidden")).toBe(true);
    // The face's fields are out of the way while the body is shown.
    expect(screen.queryByRole("group", { name: /^Типаж$/ }) === null).toBe(true);

    expect(within(group(/^Телосложение/)).getAllByRole("radio").map((r) => r.getAttribute("value"))).toEqual(["slim", "athletic", "soft", "curvy"]);
    expect(isChecked(radio(/^Телосложение/, "Спортивное"))).toBe(true);
    expect(within(group(/^Телосложение/)).queryByRole("radio", { name: "не задано" }) === null).toBe(true);

    for (const name of [/^Рост/, /^Грудь/, /^Фигура/, /^Длина ног/, /^Форма ног/, /^Размер попы/, /^Форма попы/]) {
      expect(isChecked(radio(name, "не задано"))).toBe(true);
    }
    expect(within(group(/^Рост/)).getAllByRole("radio").map((r) => r.parentElement?.textContent)).toEqual(["не задано", "Невысокий", "Средний", "Высокий"]);
    // «не задано» is a face like the others, only quieter.
    expect(radio(/^Рост/, "не задано").nextElementSibling?.className).toBe("choice-face unset on");
    expect(within(group(/^Фигура/)).getAllByRole("radio").map((r) => r.parentElement?.textContent)).toEqual([
      "не задано",
      "Прямая",
      "Песочные часы",
      "Груша",
      "Перевёрнутый треугольник",
      "Яблоко",
    ]);
    expect(radio(/^Фигура/, "Груша").nextElementSibling?.className).toBe("chip");
    expect(text(group(/^Фигура/).querySelector("legend") ?? document.body)).toBe("Фигура · плечи, талия и бёдра");
    expect(within(group(/^Форма попы/)).getAllByRole("radio").map((r) => r.parentElement?.textContent)).toEqual(["не задано", "Округлая", "Сердечком", "Подтянутая", "Широкая"]);

    const marks = group(/^Тату и родинки на теле/);
    expect(text(marks.querySelector("legend") ?? document.body)).toBe("Тату и родинки на теле, до двух");
    // Each name holds its visible word, its row first (WCAG 2.5.3; review L8).
    expect(within(marks).getAllByRole("checkbox").map((c) => c.closest("label")?.textContent)).toEqual([
      "Тату, щиколотка",
      "Тату, бедро",
      "Тату, лопатка",
      "Тату, рёбра",
      "Родинка, ключица",
      "Родинка, плечо",
      "Родинка, поясница",
    ]);
    expect(within(marks).getAllByRole("checkbox").map((c) => c.closest("label")?.querySelector(".chip")?.textContent)).toEqual([
      "щиколотка",
      "бедро",
      "лопатка",
      "рёбра",
      "ключица",
      "плечо",
      "поясница",
    ]);
    expect(Array.from(marks.querySelectorAll(".mark-row-cap")).map(text)).toEqual(["Тату", "Родинка"]);
  });

  test("«Дескриптор» previews what Studio adds before the draft: nothing yet, and it says so (never the build word, N4)", async () => {
    await openBody();
    const card = descriptorCard();
    expect(within(card).getByText("предпросмотр тела").className).toBe("tag tag-o desc-pre-tag");
    expect(text(card)).toContain("Лицо, волосы и телосложение опишет модель после оплаты. Тело Studio допишет сама — одной фразой в конце описания.");
    expect(text(card)).toContain("Поля «Тела» пустые — Studio ничего не допишет. Тогда тело решает модель, и от фото к фото оно будет разным.");
    expect(text(card)).not.toContain("build");
    expect(card.querySelector(".desc-body") === null).toBe(true);
  });

  test("← and → move between the two tabs, and the focus goes with them", async () => {
    setup();
    await openWizard();
    fireEvent.keyDown(faceTab(), { key: "ArrowRight" });
    expect(bodyTab().getAttribute("aria-selected")).toBe("true");
    expect(focusedLabel()).toBe(describeElement(bodyTab()));
    expect(bodyTab().getAttribute("tabindex")).toBe("0");
    expect(faceTab().getAttribute("tabindex")).toBe("-1");
    fireEvent.keyDown(bodyTab(), { key: "ArrowLeft" });
    expect(faceTab().getAttribute("aria-selected")).toBe("true");
    expect(focusedLabel()).toBe(describeElement(faceTab()));
    fireEvent.keyDown(faceTab(), { key: "End" });
    expect(bodyTab().getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(bodyTab(), { key: "Home" });
    expect(faceTab().getAttribute("aria-selected")).toBe("true");
  });
});

describe("02 · the body set", () => {
  test("the count follows each field; «Ноги» and «Попа» count once whichever part is set", async () => {
    await openBody();
    pick(/^Рост/, "Средний");
    expect(tabCount()).toBe("1 / 6");
    pick(/^Форма ног/, "Подтянутые");
    expect(tabCount()).toBe("2 / 6");
    pick(/^Длина ног/, "Длинные");
    expect(tabCount()).toBe("2 / 6");
    pick(/^Форма попы/, "Широкая");
    expect(tabCount()).toBe("3 / 6");
    pick(/^Рост/, "не задано");
    expect(tabCount()).toBe("2 / 6");
    expect(bodyTab().getAttribute("aria-label") === null).toBe(true);
    expect(text(bodyTab())).toBe("Тело2 / 6, задано 2 из 6");
  });

  test("every field set: 6 / 6, and the preview is the phrase `bodyPhrase` writes, marked, at the end", async () => {
    await openBody();
    fillBody();
    expect(tabCount()).toBe("6 / 6");
    const phrase = bodyPhrase(BODY) ?? "(none)";
    expect(phrase).toBe("average height, a medium bust, an hourglass figure, long slim legs, a medium-sized round bottom and a small tattoo on her left ankle");
    const card = descriptorCard();
    expect(text(card.querySelector(".descriptor-text") ?? document.body)).toBe(`…; ${phrase}.`);
    expect(text(card.querySelector(".desc-body") ?? document.body)).toBe(phrase);
    expect(text(card)).toContain("одной фразой в конце описания:");
    expect(text(card)).not.toContain("Поля «Тела» пустые");
  });

  test("two marks at most: the third waits until one is taken off; «до двух» counts them", async () => {
    await openBody();
    const marks = group(/^Тату и родинки на теле/);
    fireEvent.click(screen.getByRole("checkbox", { name: "Тату, щиколотка" }));
    expect(text(marks.querySelector(".body-count") ?? document.body)).toBe("1 из 2");
    fireEvent.click(screen.getByRole("checkbox", { name: "Родинка, ключица" }));
    expect(text(marks.querySelector(".body-count") ?? document.body)).toBe("2 из 2");
    const third = screen.getByRole("checkbox", { name: "Тату, бедро" });
    expect(isDisabled(third)).toBe(true);
    expect(third.parentElement?.querySelector(".chip")?.className).toBe("chip chip-off");
    expect(isDisabled(screen.getByRole("checkbox", { name: "Тату, щиколотка" }))).toBe(false);
    fireEvent.click(screen.getByRole("checkbox", { name: "Тату, щиколотка" }));
    expect(isDisabled(third)).toBe(false);
    expect(text(marks.querySelector(".body-count") ?? document.body)).toBe("1 из 2");
    // The phrase orders marks by the list, not by the clicks.
    fireEvent.click(third);
    expect(text(descriptorCard().querySelector(".desc-body") ?? document.body)).toBe("a small tattoo on her right hip and a small mole on her left collarbone");
  });

  test("a vibe refused while «Тело» is shown says which tab holds it (review L7)", async () => {
    setup();
    await openWizard();
    fireEvent.change(screen.getByRole("textbox", { name: "Вайб" }), { target: { value: "teen" } });
    expect(screen.getByText("Исправьте поле «Вайб».").className).toBe("field-hint");
    fireEvent.click(bodyTab());
    expect(screen.getByText("Исправьте поле «Вайб» на вкладке «Лицо и волосы».").className).toBe("field-hint");
    expect(screen.getByRole("button", { name: "Оценить стоимость" }).hasAttribute("disabled")).toBe(true);
  });

  test("a body change asks for the price again, as any change of the look does", async () => {
    await openBody();
    fireEvent.click(screen.getByRole("button", { name: "Оценить стоимость" }));
    await waitFor(() => expect(estimateText()).not.toBeNull());
    pick(/^Грудь/, "Большая");
    expect(estimateText()).toBeNull();
    expect(screen.getByRole("button", { name: "Оценить стоимость" }).hasAttribute("disabled")).toBe(false);
  });

  test("createDraft carries the body with the traits: set keys only, no empty list, the build as chosen", async () => {
    const { engine } = await openBody();
    fillBody();
    pick(/^Телосложение/, "Фигуристое");
    fireEvent.click(screen.getByRole("checkbox", { name: "Тату, щиколотка" }));
    pick(/^Форма попы/, "не задано");
    fireEvent.click(screen.getByRole("button", { name: "Оценить стоимость" }));
    await waitFor(() => expect(estimateText()).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /Сгенерировать 4 варианта/ }));
    await screen.findByText(/Рисуем портреты/);
    const sent = callsOf(engine, "avatars.createDraft")[0]?.payload.traits;
    expect(sent === undefined ? null : bodyOfTraits(sent)).toEqual({ height: "average", bust: "medium", figure: "hourglass", legLength: "long", legShape: "slim", bottomSize: "medium" });
    expect(sent?.build).toBe("curvy");
    expect(sent !== undefined && "bodyMarks" in sent).toBe(false);
    expect(sent !== undefined && "bottomShape" in sent).toBe(false);
  });
});

describe("«Случайно» fills the body too (owner's decision)", () => {
  /** A small deterministic generator (LCG), as the traits tests use. */
  function seeded(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
  }
  let spy: ReturnType<typeof spyOn> | null = null;
  afterEach(() => {
    spy?.mockRestore();
    spy = null;
  });

  test("each field a value or «не задано», 0–1 marks: the form, the count and the preview are exactly what was drawn", async () => {
    await openBody();
    for (const seed of [1, 2, 3, 9]) {
      const expected = bodyOfTraits(randomTraits(seeded(seed)));
      spy?.mockRestore();
      spy = spyOn(Math, "random").mockImplementation(seeded(seed));
      fireEvent.click(screen.getByRole("button", { name: "Случайно" }));
      spy.mockRestore();
      spy = null;
      expect(tabCount()).toBe(`${bodySetCount(expected)} / 6`);
      const phrase = bodyPhrase(expected);
      expect(descriptorCard().querySelector(".desc-body")?.textContent ?? null).toBe(phrase ?? null);
      expect(isChecked(radio(/^Рост/, "не задано"))).toBe(expected.height === undefined);
      expect(within(group(/^Тату и родинки на теле/)).getAllByRole("checkbox").filter(isChecked).length).toBe(expected.bodyMarks?.length ?? 0);
    }
  });
});

describe("03 · the fixed draft", () => {
  const traits = withBody(DEFAULT_TRAITS, BODY);
  function draftWithBody(): Draft {
    return {
      avatarId: "avatar-body-0001",
      traits,
      descriptor: mockDescriptor(traits),
      candidates: ["a", "b", "c", "d"].map((x) => ({ avatarId: "avatar-body-0001", photoId: `photo-body-000${x}` })),
      hiddenBelowThreshold: 0,
      estimate: { ...MOCK_ESTIMATE },
    };
  }

  async function continueDraft(): Promise<void> {
    setup({ drafts: [draftWithBody()] });
    const card = await screen.findByRole("article", { name: "Черновик" });
    fireEvent.click(within(card).getByRole("button", { name: "Продолжить" }));
    await screen.findByRole("heading", { level: 1, name: "Новый аватар" });
    await flush();
  }

  test("the lock is said under the form; the body still shows on its tab, read-only", async () => {
    await continueDraft();
    expect(text(screen.getByText(/^Внешность и тело зафиксированы в черновике\./))).toBe(
      "Внешность и тело зафиксированы в черновике. Тело можно поменять потом — на странице аватара, бесплатно.",
    );
    expect(tabCount()).toBe("6 / 6");
    fireEvent.click(bodyTab());
    expect(bodyTab().getAttribute("aria-selected")).toBe("true");
    expect(isChecked(radio(/^Рост/, "Средний"))).toBe(true);
    expect(radio(/^Рост/, "Средний").closest("fieldset.lock")?.hasAttribute("disabled")).toBe(true);
    expect(isChecked(screen.getByRole("checkbox", { name: "Тату, щиколотка" }))).toBe(true);
    expect(screen.queryByRole("button", { name: "Случайно" }) === null).toBe(true);
  });

  test("«Дескриптор» is the draft's text, its period dropped, then «; » and the body phrase marked — as every prompt carries it", async () => {
    await continueDraft();
    const card = descriptorCard();
    const phrase = bodyPhrase(BODY) ?? "(none)";
    const stored = mockDescriptor(traits).text;
    expect(text(card.querySelector(".descriptor-text") ?? document.body)).toBe(`${descriptorHead(stored)}; ${phrase}.`);
    expect(text(card.querySelector(".desc-body") ?? document.body)).toBe(phrase);
    expect(text(card)).toContain("тело — из вкладки «Тело»");
    expect(within(card).queryByText("предпросмотр тела") === null).toBe(true);
  });

  test("a draft without a body shows its text as it was, with no mark", async () => {
    setup({
      drafts: [
        {
          avatarId: "avatar-nobody-0001",
          traits: DEFAULT_TRAITS,
          descriptor: mockDescriptor(DEFAULT_TRAITS),
          candidates: [],
          hiddenBelowThreshold: 0,
          estimate: { ...MOCK_ESTIMATE },
        },
      ],
    });
    const card = await screen.findByRole("article", { name: "Черновик" });
    fireEvent.click(within(card).getByRole("button", { name: "Продолжить" }));
    await screen.findByRole("heading", { level: 1, name: "Новый аватар" });
    expect(text(descriptorCard().querySelector(".descriptor-text") ?? document.body)).toBe(mockDescriptor(DEFAULT_TRAITS).text);
    expect(descriptorCard().querySelector(".desc-body") === null).toBe(true);
    expect(tabCount()).toBe("0 / 6");
  });
});
