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
