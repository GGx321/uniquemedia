import { describe, expect, test } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { SCENE_REASONS_RU } from "../../shared/engine";
import { callsOf, describeElement, flush, focusedLabel, openSection, setup, withText } from "../testing";
import { BED_POOL, category, chipsGroup, MIA, openPhotos, PARIS } from "./photos/categoryScreenKit";

// S5.8b (plan s5a2 §7, I5.29; mockups 33 and 34#card of .omc/stage5/design): the generate card gains «Ножки» — «Нет · Немного 15 % · Много 30 %» under
// «Подача», «Нет» by default, a pick saying how many of the frames are legs and feet filling the frame. The pick goes into the request as `legsShare`. Legs
// come from the built-in categories only: with none on, the chips are off on «Нет» and say why, and a built-in back brings the pick back.

const WHAT = "ножки и стопы крупно; лицо может не попасть в кадр, сходство на таких кадрах только отмечается.";
const BUILT_IN_ONLY = "Ножки — только во встроенных категориях";

function card(): HTMLElement {
  return screen.getByRole("region", { name: "Генерация фото" });
}
function legsGroup(): HTMLElement {
  return within(card()).getByRole("radiogroup", { name: "Ножки" });
}
function legs(name: "Нет" | "Немного" | "Много"): HTMLInputElement {
  const radio = within(legsGroup()).getByRole("radio", { name: new RegExp(`^${name}`) });
  if (!(radio instanceof HTMLInputElement)) throw new Error("a legs share is a native radio");
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
async function pick(name: "Нет" | "Немного" | "Много"): Promise<void> {
  fireEvent.click(legs(name));
  await flush();
}
/** The chip a radio wears, as drawn: its text and whether it reads on. */
function chipOf(radio: HTMLInputElement): { text: string; on: boolean } {
  const chip = radio.nextElementSibling;
  return { text: chip?.textContent?.replace(/\s+/g, " ") ?? "", on: chip?.classList.contains("chip-on") === true };
}

describe("«Ножки» on the card (mockup 33)", () => {
  test("a pick says how many of the frames are legs: 3 of 20 over the five built-ins at «Немного», 6 at «Много»; the count follows", async () => {
    await openPhotos();
    await pick("Немного");
    expect(legs("Немного").checked).toBe(true);
    expect(chipOf(legs("Немного")).on).toBe(true);
    expect(chipOf(legs("Нет")).on).toBe(false);
    const caption = within(card()).getByText(withText(new RegExp(`^3 из 20\\sкадров — ${WHAT}$`)));
    expect(caption.classList.contains("gen-cap")).toBe(true);
    expect(described(legsGroup())).toEqual([caption.textContent ?? ""]);
    await pick("Много");
    expect(within(card()).getByText(withText(new RegExp(`^6 из 20\\sкадров — ${WHAT}$`)))).toBeDefined();
    // 25 photos: 30 % of 25 built-in ones rounds to 8, the cap of ⌊0.3 × 25⌋ makes it 7 (I5.29).
    fireEvent.click(within(card()).getByRole("button", { name: "Больше" }));
    await flush();
    expect(within(card()).getByText(withText(new RegExp(`^7 из 25\\sкадров — ${WHAT}$`)))).toBeDefined();
    await pick("Нет");
    expect(within(card()).queryByText(/ножки и стопы крупно/) === null).toBe(true);
  });

  test("goes into the price and the run as `legsShare`; «Нет» sends none", async () => {
    const { engine } = await openPhotos();
    expect("legsShare" in (callsOf(engine, "runs.estimate").at(-1)?.payload ?? {})).toBe(false);
    await pick("Немного");
    const go = await within(card()).findByRole("button", { name: /^Сгенерировать 20 фото · до \$/ });
    expect(callsOf(engine, "runs.estimate").at(-1)?.payload).toEqual({ avatarId: MIA.avatarId, count: 20, categories: ["home", "travel", "shoot", "glam", "fit"], legsShare: 15 });
    fireEvent.click(go);
    await flush();
    expect(callsOf(engine, "runs.start").at(-1)?.payload.legsShare).toBe(15);
  });

  test("is composed into the set as `legsShare` too, with the review on; an empty set asks for none", async () => {
    const { engine } = setup({ avatars: [MIA], sceneReview: "on" });
    await screen.findByRole("heading", { level: 2, name: "Mia" });
    await openSection("Фото");
    await within(await screen.findByRole("region", { name: "Генерация фото" })).findByRole("button", { name: /^Составить 20\sсцен/ });
    await pick("Много");
    await waitFor(() => expect(callsOf(engine, "scenes.estimateCompose").at(-1)?.payload.legsShare).toBe(30));
    // An empty set draws from no category: a share would be refused, so none is asked for.
    for (let i = 0; i < 4; i++) fireEvent.click(within(card()).getByRole("button", { name: "Меньше" }));
    await flush();
    await waitFor(() => expect(callsOf(engine, "scenes.estimateCompose").at(-1)?.payload.count).toBe(0));
    expect("legsShare" in (callsOf(engine, "scenes.estimateCompose").at(-1)?.payload ?? {})).toBe(false);
    expect(within(card()).queryByText(/ножки и стопы крупно/) === null).toBe(true);
    // Back to 20 and composed: the set is asked for with the share.
    for (let i = 0; i < 4; i++) fireEvent.click(within(card()).getByRole("button", { name: "Больше" }));
    await flush();
    fireEvent.click(await within(card()).findByRole("button", { name: /^Составить 20\sсцен/ }));
    await flush();
    expect(callsOf(engine, "scenes.compose").at(-1)?.payload.legsShare).toBe(30);
  });

});

describe("«Ножки» with only custom categories on (mockup 34#card)", () => {
  test("the chips are off on «Нет», saying why; the request asks for none; a built-in back brings the pick back", async () => {
    const { engine } = await openPhotos({ categories: [PARIS] });
    await pick("Немного");
    for (const name of ["Дом", "Виды", "Улица", "Гламур", "Фитнес"]) await toggleChip(name);
    await toggleChip("Кофейни Парижа");
    const radios = [legs("Нет"), legs("Немного"), legs("Много")];
    expect(radios.every((r) => r.disabled)).toBe(true);
    expect(legs("Нет").checked).toBe(true);
    expect(chipOf(legs("Нет")).on).toBe(true);
    expect(chipOf(legs("Немного")).on).toBe(false);
    const why = within(card()).getByText(BUILT_IN_ONLY);
    expect(why.classList.contains("gen-cap-why")).toBe(true);
    expect(described(legsGroup())).toEqual([BUILT_IN_ONLY]);
    expect(within(card()).queryByText(/ножки и стопы крупно/) === null).toBe(true);
    await waitFor(() => expect(callsOf(engine, "runs.estimate").at(-1)?.payload.categories).toEqual([PARIS.categoryId]));
    expect("legsShare" in (callsOf(engine, "runs.estimate").at(-1)?.payload ?? {})).toBe(false);
    // «Дом» back: «Немного» again, the chips on, the count of legs frames.
    await toggleChip("Дом");
    expect(legs("Немного").checked).toBe(true);
    expect(legs("Немного").disabled).toBe(false);
    expect(within(card()).queryByText(BUILT_IN_ONLY) === null).toBe(true);
    expect(within(card()).getByText(withText(/^\d+ из 20\sкадров — ножки и стопы крупно/))).toBeDefined();
    await waitFor(() => expect(callsOf(engine, "runs.estimate").at(-1)?.payload.legsShare).toBe(15));
  });
});

// Wave 5e (S5.8b review): at «Немного» a run whose built-in photos are few rounds to no legs frame; «0 из 5 кадров — …» would read as a fault, so the card says where it works.
describe("«Ножки» that round to no frame", () => {
  const FEW = "Ножки — слишком мало кадров во встроенных категориях";

});

describe("the refusal «legs-built-in-only»", () => {
});

// Owner decision (wave 5e): «Ножки» is remembered per avatar on this machine like «Подача»; «Нет», the default, is not stored.
const LEGS_KEY = (avatarId: string): string => `studio.photos.legs.${avatarId}`;

describe("«Ножки» remembered per avatar", () => {
  const SOFIA = { ...MIA, avatarId: "avatar-sofia-0002", name: "Sofia", masterPhotoId: "photo-sofia-0001" };

  /** Through the sidebar's «Аватары» to another avatar's Photos screen. */
  async function openAvatarPhotos(name: string): Promise<void> {
    fireEvent.click(screen.getByRole("button", { name: "Аватары" }));
    fireEvent.click(await screen.findByRole("button", { name }));
    await screen.findByRole("heading", { level: 1, name });
    await openSection("Фото");
    await screen.findByRole("heading", { level: 1, name });
  }

  test("comes back as picked in a new window, and «Нет» forgets it", async () => {
    const first = await openPhotos();
    await pick("Много");
    expect(localStorage.getItem(LEGS_KEY(MIA.avatarId))).toBe("30");
    first.unmount();
    const second = await openPhotos({ keepLevels: true });
    expect(legs("Много").checked).toBe(true);
    await pick("Нет");
    expect(localStorage.getItem(LEGS_KEY(MIA.avatarId)) === null).toBe(true);
    second.unmount();
  });

});
