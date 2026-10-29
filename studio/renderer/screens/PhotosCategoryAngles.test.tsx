import { describe, expect, test } from "bun:test";
import { fireEvent, screen, within } from "@testing-library/react";
import { callsOf, describeElement, flush, runAll } from "../testing";
import { BED, BED_POOL, category, MIA, openPhotos, PARIS } from "./photos/categoryScreenKit";
import { isDisabled, openReview } from "./photos/sceneScreenKit";

// CS.8b: a custom category's angles on the categories' side (README «CS.8 — angles from descriptions»; CatCreateDone, CatCreateDoneAngles, CatSheet,
// CatSheetAngles; the CategoryStates sheet, section F, and its keyboard rows), against the mock engine.

// S5.7c (mockup 35): the card has no «Ракурсы» any more, so the sheet no longer measures a category's angles against them.
const BED_NOTE = "Её сцены — поровну в этих ракурсах. Селфи станет меньше: только три четверти; со спины — без проверки сходства.";
// 5a.4 (S5.BA8b, plan s5a4 §5.9 row 4b; mockup 66#created): the sheet's hint ends with «Смелая»'s own rule for a custom category's angles.
const BOLD_TAIL = "На «Смелой» ракурс берётся из сцены.";
const NONE_HINT = `Без своих ракурсов: анфас и три четверти. Профиль и со спины — только если отметить их здесь. ${BOLD_TAIL}`;

function sheet(): HTMLElement {
  return screen.getByRole("dialog", { name: "Мои категории" });
}

async function openSheet(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: /^Мои категории/ }));
  await flush();
  await within(sheet()).findByRole("navigation", { name: "Категории" }).catch(() => null);
}

function selectRow(name: string): void {
  fireEvent.click(within(within(sheet()).getByRole("navigation", { name: "Категории" })).getByRole("button", { name: new RegExp(`^${name}`) }));
}

function anglesGroup(): HTMLElement {
  return within(sheet()).getByRole("group", { name: "Ракурсы" });
}

function chip(name: string): HTMLElement {
  return within(anglesGroup()).getByRole("button", { name });
}

/** The text of what the group is described by (the hint under the chips). */
function hintText(): string {
  const id = anglesGroup().getAttribute("aria-describedby") ?? "";
  return document.getElementById(id)?.textContent ?? "";
}

async function createFromDialog(name: string, description: string): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: "Своя" }));
  await flush();
  const dialog = screen.getByRole("dialog", { name: "Новая категория" });
  await within(dialog).findByRole("button", { name: /до \$0\.045$/ });
  fireEvent.change(within(dialog).getByLabelText(/^Название/), { target: { value: name } });
  fireEvent.change(within(dialog).getByLabelText(/^Описание/), { target: { value: description } });
  await flush();
  fireEvent.click(within(dialog).getByRole("button", { name: /^Создать · до/ }));
  await flush();
  return screen.getByRole("dialog", { name });
}

describe("«Новая категория»: the description hint and the «готово» row (CatCreate, CatCreateDone, CatCreateDoneAngles)", () => {

  test("a description that names the angle: the row shows its angles sorted, «из описания», and what that means; the footer says where to change them", async () => {
    await openPhotos();
    const done = await createFromDialog("Лежит дома", "Лежит на животе в домашних шортиках и топике. Вид сзади");
    const angles = within(done).getByRole("list", { name: "Ракурсы" });
    expect(within(angles).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Со спины"]);
    expect(within(done).getByText("из описания")).toBeDefined();
    // The mock's deck for this description; whatever it holds, the line starts with the one-angle sentence.
    expect(within(done).getByText(/^Все её сцены — в этом ракурсе\./)).toBeDefined();
    expect(within(done).getByText("Категория уже включена в запуск. Убрать место или наряд, поменять ракурсы — в «Мои категории».")).toBeDefined();
    // Display only: no tag takes the focus, which stays on «Готово».
    expect(describeElement(document.activeElement)).toBe(describeElement(within(done).getByRole("button", { name: "Готово" })));
  });

});

describe("«Мои категории»: the «Ракурсы» block (CatSheet, CatSheetAngles)", () => {
  test("own angles: pressed chips, «× Убрать свои ракурсы», the consequences; free and saved at once", async () => {
    await openPhotos({ categories: [PARIS, BED] });
    await openSheet();
    selectRow("Домашнее у кровати");
    await flush();
    expect(within(sheet()).getByText("бесплатно, сохраняется сразу")).toBeDefined();
    expect(["Анфас", "Три четверти", "Профиль", "Со спины"].map((name) => chip(name).getAttribute("aria-pressed"))).toEqual(["false", "true", "false", "true"]);
    const clear = within(sheet()).getByRole("button", { name: "Убрать свои ракурсы" });
    expect(clear.getAttribute("title")).toBe("Сцены этой категории будут в анфас и три четверти");
    expect(hintText()).toBe(`${BED_NOTE} ${BOLD_TAIL}`);
    const hint = document.getElementById(anglesGroup().getAttribute("aria-describedby") ?? "");
    expect(hint?.getAttribute("aria-live")).toBe("polite");
  });

  test("«Убрать свои ракурсы» clears them (null) and the focus goes to «Анфас»; turning the last chip off clears them too, the focus staying there", async () => {
    const solo = category(5, "Ночной город", { ...BED_POOL, poses: ["back"] });
    const { engine } = await openPhotos({ categories: [BED, solo] });
    await openSheet();
    fireEvent.click(within(sheet()).getByRole("button", { name: "Убрать свои ракурсы" }));
    await flush();
    expect(callsOf(engine, "categories.update").at(-1)?.payload).toEqual({ categoryId: BED.categoryId, poses: null });
    expect(describeElement(document.activeElement)).toBe(describeElement(chip("Анфас")));
    expect(hintText()).toBe(NONE_HINT);
    expect(within(sheet()).queryByRole("button", { name: "Убрать свои ракурсы" }) === null).toBe(true);

    selectRow("Ночной город");
    await flush();
    const back = chip("Со спины");
    back.focus();
    fireEvent.click(back);
    await flush();
    expect(callsOf(engine, "categories.update").at(-1)?.payload).toEqual({ categoryId: solo.categoryId, poses: null });
    expect(describeElement(document.activeElement)).toBe(describeElement(chip("Со спины")));
    expect(chip("Со спины").getAttribute("aria-pressed")).toBe("false");
    expect(hintText()).toBe(NONE_HINT);
  });

  test("a save that fails: the chip flips back, the hint says why (an alert), the focus stays on the chip", async () => {
    const { engine } = await openPhotos({ categories: [BED] });
    await openSheet();
    engine.failNext("categories.update", { code: "INTERNAL" });
    const profile = chip("Профиль");
    profile.focus();
    fireEvent.click(profile);
    await flush();
    expect(chip("Профиль").getAttribute("aria-pressed")).toBe("false");
    expect(within(sheet()).getByRole("alert").textContent).toBe("Не сохранилось: внутренняя ошибка движка — ракурсы остались прежними.");
    expect(describeElement(document.activeElement)).toBe(describeElement(chip("Профиль")));
  });

});
