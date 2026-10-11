import { describe, expect, test } from "bun:test";
import { fireEvent, screen, within } from "@testing-library/react";
import { chipsGroup, openPhotos } from "./photos/categoryScreenKit";

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

describe("the chips kept for «Смелая»", () => {
  test("lists «Ночнушки и бельё» and «Пляж и бассейн» as dimmed chips that are not buttons", async () => {
    await openPhotos();
    for (const name of ["Ночнушки и бельё", "Пляж и бассейн"]) {
      const reserved = within(chipsGroup()).getByText(name);
      expect(reserved.getAttribute("aria-disabled")).toBe("true");
      expect(reserved.closest("button") === null).toBe(true);
    }
  });

  test("says they come later, with «Смелая»", async () => {
    await openPhotos();
    expect(screen.getByText("Со «Смелой» — появятся позже.")).toBeDefined();
  });
});
