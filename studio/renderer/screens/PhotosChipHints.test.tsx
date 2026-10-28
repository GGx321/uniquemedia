import { describe, expect, test } from "bun:test";
import { fireEvent, screen, within } from "@testing-library/react";
import { flush } from "../testing";
import { category, chipsGroup, openPhotos, PARIS, PARIS_POOL } from "./photos/categoryScreenKit";

// S5.6e (mockups 24 and 24a): the built-in chips explain themselves in one hint line under the row, and two chips are kept for «Смелая».

const HINT = {
  home: "Дом — зеркало, кровать, свет лампы; в части кадров лицо закрыто телефоном.",
  shoot: "Улица — снимает подруга или прохожий, иногда телефон на таймере; город днём и ночью.",
  travel: "Виды — балкон над городом, сад, горы, набережная.",
  glam: "Гламур — вечер выхода: бар, ресторан, такси и сборы дома.",
} as const;

function chip(name: RegExp): HTMLElement {
  return within(chipsGroup()).getByRole("button", { name });
}

describe("the chip hint line", () => {
  test("shows the hint of the chip under the pointer in place of the Glamour one", async () => {
    await openPhotos();
    fireEvent.pointerEnter(chip(/^Дом/));
    expect(screen.getByText(HINT.home)).toBeDefined();
    expect(screen.queryByText(HINT.glam) === null).toBe(true);
  });

  test("gives the street chip its own hint", async () => {
    await openPhotos();
    fireEvent.pointerEnter(chip(/^Улица/));
    expect(screen.getByText(HINT.shoot)).toBeDefined();
  });

  test("gives the views chip its own hint", async () => {
    await openPhotos();
    fireEvent.pointerEnter(chip(/^Виды/));
    expect(screen.getByText(HINT.travel)).toBeDefined();
  });

  test("shows the hint of the chip that has the focus", async () => {
    await openPhotos();
    fireEvent.focus(chip(/^Улица/));
    expect(screen.getByText(HINT.shoot)).toBeDefined();
  });

  test("goes back to the Glamour hint once the pointer leaves, while Glamour is on", async () => {
    await openPhotos();
    fireEvent.pointerEnter(chip(/^Дом/));
    fireEvent.pointerLeave(chip(/^Дом/));
    expect(screen.getByText(HINT.glam)).toBeDefined();
    expect(screen.queryByText(HINT.home) === null).toBe(true);
  });

  test("keeps the Glamour hint under a chip that has none of its own (Фитнес)", async () => {
    await openPhotos();
    fireEvent.pointerEnter(chip(/^Фитнес/));
    expect(screen.getByText(HINT.glam)).toBeDefined();
  });

  test("shows no hint at rest once Glamour is off", async () => {
    await openPhotos();
    fireEvent.click(chip(/^Гламур/));
    expect(document.querySelector(".photos-cats-note") === null).toBe(true);
  });
});

// 2026-10-12, S5.9g (plan s5a3 §13.1; mockups 47, 48): the two chips kept for «Смелая» became real chips. The rows «dimmed chips: real disabled buttons» and
// «says they come later» pinned the placeholder; what replaces them pins the gating (the full states are in PhotosBold.test.tsx). The S5.6d review's point
// stays: `aria-disabled` sits on the button itself, never on a bare span.
describe("the two «Смелая» chips", () => {
  test("are buttons in the row, dimmed under «Обычная» with `aria-disabled` on the button itself, never a span", async () => {
    await openPhotos();
    for (const name of ["Ночнушки и бельё", "Пляж и бассейн"]) {
      const gated = within(chipsGroup()).getByRole("button", { name });
      expect(gated.getAttribute("aria-disabled")).toBe("true");
      expect(gated.getAttribute("title")).toBe("Только со «Смелой»");
      expect(Array.from(chipsGroup().querySelectorAll("span[aria-disabled]"))).toHaveLength(0);
    }
  });

  test("no longer say they come later", async () => {
    await openPhotos();
    expect(screen.queryByText("Со «Смелой» — появятся позже.") === null).toBe(true);
  });
});

// 5a.4 (S5.BA8b, plan s5a4 §5.9 rows 7–14; mockup 65c): at «Смелая» every category draws lingerie, so each chip says where and in what — no towel (the hint is per category, and an
// imported avatar never gets one). «Фитнес» and a custom category get a hint of their own; a custom one says «у воды — в купальнике» only with a water place (the planner's own rule).
// «Пляж и бассейн» says what it always said. «Ночнушки и бельё» draws only at «Смелая», so it says what it draws there at every «Подача».
describe("the chip hint line at «Смелая» (mockup 65c)", () => {
  const BOLD_HINT = {
    home: "Дом — в белье: кухня утром, диван, зеркало, ванная после душа.",
    travel: "Виды — номер или вилла с видом: балкон, окно, кровать, свой бассейн.",
    shoot: "Улица — до и после прогулки: сборы у зеркала, номер в отеле, окно с огнями города.",
    glam: "Гламур — сборы перед вечером и номер после: бельё, чулки, туфли сняты.",
    fit: "Фитнес — дома после тренировки: коврик, зеркало, ванная после душа.",
    nightwear: "Ночнушки и бельё — дома у зеркала и в кровати: бельё, атлас, чулки; в части кадров лицо закрыто телефоном.",
    beach: "Пляж и бассейн — пляж, море и бассейн; снимает подруга или прохожий, иногда телефон на таймере; купальники.",
  } as const;
  const [firstPlace] = PARIS_POOL.locations;
  if (firstPlace === undefined) throw new Error("the fixture pool has no place");
  // Paris with its first place by the water (its mirror place kept: a pool needs one).
  const POOLSIDE = category(7, "У бассейна", { ...PARIS_POOL, locations: [{ ...firstPlace, name: "hotel pool" }, ...PARIS_POOL.locations.slice(1)] });

  function card(): HTMLElement {
    return screen.getByRole("region", { name: "Генерация фото" });
  }
  async function pickLevel(name: "Обычная" | "Кокетливая" | "Смелая"): Promise<void> {
    fireEvent.click(within(within(card()).getByRole("radiogroup", { name: "Подача" })).getByRole("radio", { name }));
    await flush();
  }
  const line = (): string | null => document.querySelector(".photos-cats-note")?.textContent ?? null;

  test("at rest, Гламур's line while Гламур is on (mockup 65)", async () => {
    await openPhotos();
    await pickLevel("Смелая");
    expect(line()).toBe(BOLD_HINT.glam);
  });

  test("each built-in chip under the pointer says where she is and in what", async () => {
    await openPhotos();
    await pickLevel("Смелая");
    const chips = [
      [/^Дом/, BOLD_HINT.home],
      [/^Виды/, BOLD_HINT.travel],
      [/^Улица/, BOLD_HINT.shoot],
      [/^Гламур/, BOLD_HINT.glam],
      [/^Фитнес/, BOLD_HINT.fit],
      [/^Ночнушки и бельё/, BOLD_HINT.nightwear],
      [/^Пляж и бассейн/, BOLD_HINT.beach],
    ] as const;
    for (const [name, hint] of chips) {
      fireEvent.pointerEnter(chip(name));
      expect(line()).toBe(hint);
      fireEvent.pointerLeave(chip(name));
    }
  });

  test("no hint names the towel: the hint is per category, and an imported avatar never gets one", async () => {
    for (const hint of Object.values(BOLD_HINT)) expect(hint.includes("полотенц")).toBe(false);
  });

  test("a custom category: lingerie in a room or at home, in its world; at the water, swimwear (mockup 65c#cat-riviera)", async () => {
    await openPhotos({ categories: [PARIS, POOLSIDE] });
    await within(chipsGroup()).findByRole("button", { name: /^У бассейна/ });
    await pickLevel("Смелая");
    fireEvent.focus(chip(/^Кофейни Парижа/));
    expect(line()).toBe("Кофейни Парижа — в белье в номере или дома, в мире категории.");
    fireEvent.focus(chip(/^У бассейна/));
    expect(line()).toBe("У бассейна — в белье в номере или дома, в мире категории; у воды — в купальнике.");
  });

  test("back at «Обычная» the chips say what they always said; Фитнес and a custom chip leave Гламур's line", async () => {
    await openPhotos({ categories: [PARIS] });
    await within(chipsGroup()).findByRole("button", { name: /^Кофейни Парижа/ });
    await pickLevel("Смелая");
    await pickLevel("Обычная");
    fireEvent.pointerEnter(chip(/^Дом/));
    expect(line()).toBe(HINT.home);
    fireEvent.pointerLeave(chip(/^Дом/));
    fireEvent.pointerEnter(chip(/^Фитнес/));
    expect(line()).toBe(HINT.glam);
    fireEvent.pointerLeave(chip(/^Фитнес/));
    fireEvent.pointerEnter(chip(/^Кофейни Парижа/));
    expect(line()).toBe(HINT.glam);
  });

  test("«Ночнушки и бельё» says what it draws at «Смелая» while it waits for it, too", async () => {
    await openPhotos();
    fireEvent.pointerEnter(chip(/^Ночнушки и бельё/));
    expect(line()).toBe(BOLD_HINT.nightwear);
  });
});
