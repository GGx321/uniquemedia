import { describe, expect, test } from "bun:test";
import { fireEvent, screen, within } from "@testing-library/react";
import { callsOf, describeElement, flush, openSection, setup, withText } from "../testing";
import { BED, BED_POOL, category, chipsGroup, MIA, MONO, openPhotos, PARIS, WINTER } from "./photos/categoryScreenKit";
import { LEVEL_KEY_PREFIX } from "./photos/level";

// S5.7c (plan s5a2 §6.1, §6.3; mockups 24, 25 and 27 of .omc/stage5/design): the generate card loses «Ракурсы» — the angle comes from the scene — and gains
// «Подача»: «Обычная» by default, «Кокетливая» with its count of flirty frames, «Смелая» drawn disabled. The choice goes into the request (no poses), and is
// remembered per avatar.

const BOLD_LATER = "Смелая — ночнушки, бельё и пляж — появится позже.";
const ANGLE_NOTE = "Ракурс берётся из сцены: «через плечо», «со спины», «в профиль». Со спины и в профиль — без проверки сходства, не больше 1 кадра из 5.";

function card(): HTMLElement {
  return screen.getByRole("region", { name: "Генерация фото" });
}
function levelGroup(): HTMLElement {
  return within(card()).getByRole("radiogroup", { name: "Подача" });
}
function level(name: "Обычная" | "Кокетливая" | "Смелая"): HTMLInputElement {
  const radio = within(levelGroup()).getByRole("radio", { name });
  if (!(radio instanceof HTMLInputElement)) throw new Error("a level is a native radio");
  return radio;
}
/** The text of the elements the group's `aria-describedby` names, in order. */
function described(el: HTMLElement): string[] {
  return (el.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? "");
}
async function toggleChip(name: string): Promise<void> {
  fireEvent.click(within(chipsGroup()).getByRole("button", { name: new RegExp(`^${name}`) }));
  await flush();
}

describe("«Подача» on the card (mockup 24)", () => {
  test("is a radio group «Обычная · Кокетливая · Смелая», «Обычная» checked, «Смелая» disabled with its caption", async () => {
    await openPhotos();
    expect(within(levelGroup()).getAllByRole("radio").map((r) => r.getAttribute("value"))).toEqual(["ordinary", "flirty", "bold"]);
    expect(level("Обычная").checked).toBe(true);
    expect(level("Кокетливая").checked).toBe(false);
    expect(level("Смелая").disabled).toBe(true);
    expect(within(card()).getByText(BOLD_LATER)).toBeDefined();
    expect(described(level("Смелая"))).toEqual([BOLD_LATER]);
    // No flirty count while «Обычная» is on.
    expect(within(card()).queryByText(/кокетливые: взгляд, улыбка, поза/) === null).toBe(true);
  });

  test("has no «Ракурсы» any more: no toggles, no profile or back chip; the angle note stands where they were", async () => {
    await openPhotos();
    expect(within(card()).queryByRole("group", { name: "Ракурсы" }) === null).toBe(true);
    expect(within(card()).queryByRole("button", { name: "Профиль" }) === null).toBe(true);
    expect(within(card()).queryByRole("button", { name: "Со спины" }) === null).toBe(true);
    expect(card().textContent?.includes("Ракурсы") ?? true).toBe(false);
    expect(within(card()).getByText(ANGLE_NOTE)).toBeDefined();
  });

  test("asks the price with no poses and no level while it is «Обычная»", async () => {
    const { engine } = await openPhotos();
    const asked = callsOf(engine, "runs.estimate").at(-1)?.payload;
    expect(asked === undefined ? [] : Object.keys(asked).sort()).toEqual(["avatarId", "categories", "count"]);
  });
});

describe("«Кокетливая» (mockup 25)", () => {
  test("says how many of the frames are flirty: 12 of 20 over «Дом», «Виды» and «Гламур»", async () => {
    await openPhotos();
    await toggleChip("Улица");
    await toggleChip("Фитнес");
    fireEvent.click(level("Кокетливая"));
    await flush();
    expect(level("Кокетливая").checked).toBe(true);
    const caption = within(card()).getByText(withText(/^12 из 20\s?кадров — кокетливые: взгляд, улыбка, поза\. Одежда — из категорий\.$/));
    expect(described(levelGroup())).toEqual([caption.textContent ?? ""]);
    // The count follows the form.
    fireEvent.click(within(card()).getByRole("button", { name: "Больше" }));
    await flush();
    expect(within(card()).getByText(withText(/^15 из 25\s?кадров — кокетливые/))).toBeDefined();
  });

  test("with only a custom category on, says the level works in the built-in ones instead of «0 из N»", async () => {
    await openPhotos({ categories: [PARIS] });
    for (const name of ["Дом", "Виды", "Улица", "Гламур", "Фитнес"]) await toggleChip(name);
    await toggleChip("Кофейни Парижа");
    fireEvent.click(level("Кокетливая"));
    await flush();
    expect(within(card()).getByText("Подача — только во встроенных категориях")).toBeDefined();
    expect(within(card()).queryByText(/из \d+\s?кадров — кокетливые/) === null).toBe(true);
    await toggleChip("Дом");
    expect(within(card()).queryByText("Подача — только во встроенных категориях") === null).toBe(true);
    expect(within(card()).getByText(withText(/^\d+ из \d+\s?кадров? — кокетливые/))).toBeDefined();
  });

  test("goes into the price and the run as `level`, never with poses", async () => {
    const { engine } = await openPhotos();
    fireEvent.click(level("Кокетливая"));
    await flush();
    const go = await within(card()).findByRole("button", { name: /^Сгенерировать 20 фото · до \$/ });
    expect(callsOf(engine, "runs.estimate").at(-1)?.payload).toEqual({ avatarId: MIA.avatarId, count: 20, categories: ["home", "travel", "shoot", "glam", "fit"], level: "flirty" });
    fireEvent.click(go);
    await flush();
    const started = callsOf(engine, "runs.start").at(-1)?.payload;
    expect(started?.level).toBe("flirty");
    expect(started !== undefined && "poses" in started).toBe(false);
  });

  test("is composed into the set as `level` too, with the review on", async () => {
    const { engine } = setup({ avatars: [MIA], sceneReview: "on" });
    await screen.findByRole("heading", { level: 2, name: "Mia" });
    await openSection("Фото");
    await within(await screen.findByRole("region", { name: "Генерация фото" })).findByRole("button", { name: /^Составить 20\sсцен/ });
    fireEvent.click(level("Кокетливая"));
    await flush();
    const compose = await within(card()).findByRole("button", { name: /^Составить 20\sсцен/ });
    fireEvent.click(compose);
    await flush();
    const sent = callsOf(engine, "scenes.compose").at(-1)?.payload;
    expect(sent?.level).toBe("flirty");
    expect(sent !== undefined && "poses" in sent).toBe(false);
  });

  test("moves by the keyboard as any radio group does: «Смелая» is skipped, being disabled", async () => {
    await openPhotos();
    level("Обычная").focus();
    expect(describeElement(document.activeElement)).toBe(describeElement(level("Обычная")));
    expect(level("Смелая").disabled).toBe(true);
    expect(level("Обычная").name).toBe(level("Кокетливая").name);
  });
});

describe("«Подача» remembered per avatar (owner: «Обычная» by default, remembered per avatar)", () => {
  test("stays «Кокетливая» after a look at another screen", async () => {
    await openPhotos();
    fireEvent.click(level("Кокетливая"));
    await flush();
    await openSection("Настройки");
    await openSection("Фото");
    await screen.findByRole("heading", { level: 1, name: "Mia" });
    expect(level("Кокетливая").checked).toBe(true);
  });

  test("comes back «Кокетливая» in a new window, for this avatar only", async () => {
    const first = await openPhotos();
    fireEvent.click(level("Кокетливая"));
    await flush();
    expect(localStorage.getItem(`${LEVEL_KEY_PREFIX}${MIA.avatarId}`)).toBe("flirty");
    first.unmount();
    // A new window: the form starts afresh, «Подача» from what this machine remembers for Mia.
    const second = await openPhotos({ keepLevels: true });
    expect(level("Кокетливая").checked).toBe(true);
    fireEvent.click(level("Обычная"));
    await flush();
    expect(localStorage.getItem(`${LEVEL_KEY_PREFIX}${MIA.avatarId}`) === null).toBe(true);
    second.unmount();
  });
});

describe("a category with angles of its own (mockup 27)", () => {
  test("one: «У «{имя}» свои ракурсы: {список}.» under the angle note, while it is in the run", async () => {
    await openPhotos({ categories: [PARIS, BED] });
    expect(within(card()).queryByText(/свои ракурсы/) === null).toBe(true);
    await toggleChip("Домашнее у кровати");
    expect(within(card()).getByText(withText(/^У «Домашнее у кровати» свои ракурсы: три четверти, со спины\.$/))).toBeDefined();
    await toggleChip("Домашнее у кровати");
    expect(within(card()).queryByText(/свои ракурсы/) === null).toBe(true);
  });

  test("several: «У «{имя}» и ещё N — свои ракурсы.», «ещё N» opening every one with its angles, the focus staying on it", async () => {
    const yoga = category(5, "Йога дома", { ...BED_POOL, poses: ["profile"] });
    const city = category(6, "Ночной город", { ...BED_POOL, poses: ["back"] });
    await openPhotos({ categories: [BED, yoga, city, MONO, WINTER] });
    for (const name of ["Домашнее у кровати", "Йога дома", "Ночной город"]) await toggleChip(name);
    expect(within(card()).getByText(withText(/^У «Домашнее у кровати» и ещё 2 — свои ракурсы\.$/))).toBeDefined();
    const more = within(card()).getByRole("button", { name: "ещё 2" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    more.focus();
    fireEvent.click(more);
    await flush();
    expect(more.getAttribute("aria-expanded")).toBe("true");
    const list = document.getElementById(more.getAttribute("aria-controls") ?? "");
    expect(list?.hidden).toBe(false);
    expect(Array.from(list?.querySelectorAll("li") ?? []).map((li) => li.textContent)).toEqual(["Домашнее у кровати — три четверти, со спины", "Йога дома — профиль", "Ночной город — со спины"]);
    expect(describeElement(document.activeElement)).toBe(describeElement(more));
  });
});
