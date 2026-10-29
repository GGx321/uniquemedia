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
  // 2026-10-12, S5.9g (plan s5a3 §13.1; mockup 47): «Смелая» ships, so the row «…«Смелая» disabled with its caption» («…появится позже.») now pins the live
  // radio and the caption's absence; «Смелая» itself is covered in PhotosBold.test.tsx.
  test("is a radio group «Обычная · Кокетливая · Смелая», «Обычная» checked, all three live, no caption", async () => {
    await openPhotos();
    expect(within(levelGroup()).getAllByRole("radio").map((r) => r.getAttribute("value"))).toEqual(["ordinary", "flirty", "bold"]);
    expect(level("Обычная").checked).toBe(true);
    expect(level("Кокетливая").checked).toBe(false);
    expect(level("Смелая").checked).toBe(false);
    expect(level("Смелая").disabled).toBe(false);
    expect(within(card()).queryByText(BOLD_LATER) === null).toBe(true);
    expect(level("Смелая").getAttribute("aria-describedby")).toBeNull();
    // No flirty count while «Обычная» is on.
    expect(within(card()).queryByText(/кокетливые: взгляд, улыбка, поза/) === null).toBe(true);
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

  // 2026-10-12, S5.9g: «Смелая» is no longer skipped (it was disabled); the three radios are one native group the keyboard moves through.
});

describe("«Подача» remembered per avatar (owner: «Обычная» by default, remembered per avatar)", () => {
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

describe("«Подача» of two avatars", () => {
  const SOFIA = { ...MIA, avatarId: "avatar-sofia-0002", name: "Sofia", masterPhotoId: "photo-sofia-0001" };

  /** Through the sidebar's «Аватары» to another avatar's Photos screen. */
  async function openAvatarPhotos(name: string): Promise<void> {
    fireEvent.click(screen.getByRole("button", { name: "Аватары" }));
    fireEvent.click(await screen.findByRole("button", { name }));
    await screen.findByRole("heading", { level: 1, name });
    await openSection("Фото");
    await screen.findByRole("heading", { level: 1, name });
  }

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

});
