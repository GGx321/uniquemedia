import { describe, expect, test } from "bun:test";
import { fireEvent, screen, within } from "@testing-library/react";
import { callsOf, describeElement, flush, runAll, withText } from "../testing";
import { BED, BED_POOL, category, MIA, MONO, openPhotos, PARIS, WINTER } from "./photos/categoryScreenKit";
import { isDisabled, nb, openReview } from "./photos/sceneScreenKit";

// CS.8b: a custom category's angles on the categories' side (README «CS.8 — angles from descriptions»; CatCreateDone, CatCreateDoneAngles, CatSheet,
// CatSheetAngles, CatChipsAngles; the CategoryStates sheet, section F, and its keyboard rows), against the mock engine.

const BED_NOTE = "Её сцены — поровну в этих ракурсах; «Ракурсы» карточки их не касаются. Селфи станет меньше: только три четверти; со спины — без проверки сходства.";
const NONE_HINT = "Как в карточке генерации: анфас и три четверти всегда, профиль и со спины — если они включены там.";

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
  test("the hint under «Описание» names the pose and the angle", async () => {
    await openPhotos();
    fireEvent.click(screen.getByRole("button", { name: "Своя" }));
    await flush();
    const dialog = screen.getByRole("dialog", { name: "Новая категория" });
    expect(within(dialog).getByText(/^Где она бывает, что там делает и в какой позе, во что одета, с какого ракурса снимать \(«вид сзади», «в профиль»\)\./)).toBeDefined();
  });

  test("a description that names the angle: the row shows its angles sorted, «из описания», and what that means; the footer says where to change them", async () => {
    await openPhotos();
    const done = await createFromDialog("Лежит дома", "Лежит на животе в домашних шортиках и топике. Вид сзади");
    const angles = within(done).getByRole("list", { name: "Ракурсы" });
    expect(within(angles).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Со спины"]);
    expect(within(done).getByText("из описания")).toBeDefined();
    // The mock's deck for this description; whatever it holds, the line starts with the one-angle sentence.
    expect(within(done).getByText(/^Все её сцены — в этом ракурсе; «Ракурсы» карточки их не касаются\./)).toBeDefined();
    expect(within(done).getByText("Категория уже включена в запуск. Убрать место или наряд, поменять ракурсы — в «Мои категории».")).toBeDefined();
    // Display only: no tag takes the focus, which stays on «Готово».
    expect(describeElement(document.activeElement)).toBe(describeElement(within(done).getByRole("button", { name: "Готово" })));
  });

  test("a description that names none: «как в карточке генерации», «в описании не названы», no note", async () => {
    await openPhotos();
    const done = await createFromDialog("Рынки", "Рынки и прилавки с фруктами");
    expect(within(done).queryByRole("list", { name: "Ракурсы" }) === null).toBe(true);
    expect(within(done).getByText("как в карточке генерации")).toBeDefined();
    expect(within(done).getByText("в описании не названы")).toBeDefined();
    expect(done.textContent?.includes("«Ракурсы» карточки их не касаются") ?? true).toBe(false);
  });
});

describe("«Мои категории»: the «Ракурсы» block (CatSheet, CatSheetAngles)", () => {
  test("own angles: pressed chips, «× Как в карточке», the consequences; free and saved at once", async () => {
    await openPhotos({ categories: [PARIS, BED] });
    await openSheet();
    selectRow("Домашнее у кровати");
    await flush();
    expect(within(sheet()).getByText("бесплатно, сохраняется сразу")).toBeDefined();
    expect(["Анфас", "Три четверти", "Профиль", "Со спины"].map((name) => chip(name).getAttribute("aria-pressed"))).toEqual(["false", "true", "false", "true"]);
    const clear = within(sheet()).getByRole("button", { name: "Как в карточке" });
    expect(clear.getAttribute("title")).toBe("Убрать свои ракурсы — сцены этой категории возьмут их из «Ракурсов» карточки генерации");
    expect(hintText()).toBe(BED_NOTE);
    const hint = document.getElementById(anglesGroup().getAttribute("aria-describedby") ?? "");
    expect(hint?.getAttribute("aria-live")).toBe("polite");
  });

  test("no angles of its own: «Анфас» and «Три четверти» dimmed-on with what the card gives, no «Как в карточке»", async () => {
    await openPhotos({ categories: [PARIS, BED] });
    await openSheet();
    expect(["Анфас", "Три четверти", "Профиль", "Со спины"].map((name) => chip(name).getAttribute("aria-pressed"))).toEqual(["true", "true", "false", "false"]);
    expect(chip("Анфас").getAttribute("title")).toBe("Как в карточке: анфас и три четверти всегда. Нажмите — свои ракурсы без анфаса");
    expect(chip("Три четверти").getAttribute("title")).toBe("Как в карточке: анфас и три четверти всегда. Нажмите — свои ракурсы без трёх четвертей");
    expect(chip("Анфас").className).toContain("cat-angle-implied");
    expect(chip("Профиль").className.includes("cat-angle-implied")).toBe(false);
    expect(within(sheet()).queryByRole("button", { name: "Как в карточке" }) === null).toBe(true);
    expect(hintText()).toBe(NONE_HINT);
  });

  test("the first press from «как в карточке» starts at front and three-quarter; the focus stays on the chip; the hint follows", async () => {
    const { engine } = await openPhotos({ categories: [PARIS] });
    await openSheet();
    const back = chip("Со спины");
    back.focus();
    fireEvent.click(back);
    await flush();
    expect(callsOf(engine, "categories.update").map((c) => c.payload)).toEqual([{ categoryId: PARIS.categoryId, poses: ["front", "three-quarter", "back"] }]);
    expect(["Анфас", "Три четверти", "Профиль", "Со спины"].map((name) => chip(name).getAttribute("aria-pressed"))).toEqual(["true", "true", "false", "true"]);
    expect(chip("Анфас").className.includes("cat-angle-implied")).toBe(false);
    expect(describeElement(document.activeElement)).toBe(describeElement(chip("Со спины")));
    // Paris's deck holds a selfie and a mirror shot.
    expect(hintText()).toBe("Её сцены — поровну в этих ракурсах; «Ракурсы» карточки их не касаются. Селфи и кадров в зеркале станет меньше: только анфас или три четверти; со спины — без проверки сходства.");
    expect(within(sheet()).getByRole("button", { name: "Как в карточке" })).toBeDefined();
  });

  test("«Как в карточке» clears them (null) and the focus goes to «Анфас»; turning the last chip off clears them too, the focus staying there", async () => {
    const solo = category(5, "Ночной город", { ...BED_POOL, poses: ["back"] });
    const { engine } = await openPhotos({ categories: [BED, solo] });
    await openSheet();
    fireEvent.click(within(sheet()).getByRole("button", { name: "Как в карточке" }));
    await flush();
    expect(callsOf(engine, "categories.update").at(-1)?.payload).toEqual({ categoryId: BED.categoryId, poses: null });
    expect(describeElement(document.activeElement)).toBe(describeElement(chip("Анфас")));
    expect(hintText()).toBe(NONE_HINT);
    expect(within(sheet()).queryByRole("button", { name: "Как в карточке" }) === null).toBe(true);

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

  test("one save at a time: «сохраняем…», the group busy, the chips waiting; a press meanwhile sends nothing", async () => {
    const { engine, scheduler } = await openPhotos({ categories: [BED] });
    await openSheet();
    engine.delayNext("categories.update", 50);
    fireEvent.click(chip("Анфас"));
    await flush();
    expect(anglesGroup().getAttribute("aria-busy")).toBe("true");
    expect(within(sheet()).getByText("сохраняем…")).toBeDefined();
    expect(within(sheet()).queryByRole("button", { name: "Как в карточке" }) === null).toBe(true);
    // The press shows at once.
    expect(chip("Анфас").getAttribute("aria-pressed")).toBe("true");
    expect(isDisabled(chip("Профиль"))).toBe(true);
    fireEvent.click(chip("Профиль"));
    await flush();
    expect(callsOf(engine, "categories.update")).toHaveLength(1);
    runAll(scheduler);
    await flush();
    expect(anglesGroup().getAttribute("aria-busy")).toBe("false");
    expect(isDisabled(chip("Профиль"))).toBe(false);
    expect(callsOf(engine, "categories.update").map((c) => c.payload.poses)).toEqual([["front", "three-quarter", "back"]]);
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

  test("while the category is regenerated the chips and «Как в карточке» wait, saying why", async () => {
    const { engine } = await openPhotos({ categories: [BED] });
    await openSheet();
    fireEvent.click(within(sheet()).getByRole("button", { name: "Пересоздать…" }));
    await flush();
    engine.delayNext("categories.regenerate", 100);
    fireEvent.click(within(sheet()).getByRole("button", { name: /^Пересоздать · до/ }));
    await flush();
    expect(isDisabled(chip("Со спины"))).toBe(true);
    expect(chip("Со спины").getAttribute("title")).toBe("Пока идёт пересоздание, эту категорию не изменить");
    expect(isDisabled(within(sheet()).getByRole("button", { name: "Как в карточке" }))).toBe(true);
    fireEvent.click(chip("Профиль"));
    await flush();
    expect(callsOf(engine, "categories.update")).toHaveLength(0);
  });

  test("an open set holding the category's scenes: the hint adds that an edit moves «Другая сцена» there", async () => {
    await openReview({ categories: [BED], sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-seed-0001", count: 3, written: 3, categories: [BED.categoryId] }] });
    await openSheet();
    expect(hintText()).toBe(`${BED_NOTE} Правка меняет и «Другую сцену» в открытом наборе; уже составленные сцены остаются как были.`);
  });

  test("the regenerate box and its outcome name the angles and what ⟳ takes (CatSheetRegen, CatSheetRegenDone)", async () => {
    const { scheduler } = await openPhotos({ categories: [PARIS] });
    await openSheet();
    fireEvent.click(within(sheet()).getByRole("button", { name: "Пересоздать…" }));
    await flush();
    expect(
      within(sheet()).getByText(
        "Новый набор заменит места, наряды, кадры и ракурсы — ракурсы снова возьмутся из описания; название останется. Составленные сцены и идущие запуски не изменятся; «Другая сцена» возьмёт уже новый.",
      ),
    ).toBeDefined();
    fireEvent.click(within(sheet()).getByRole("button", { name: /^Пересоздать · до/ }));
    runAll(scheduler);
    await flush();
    expect(
      within(sheet()).getByText(
        "Ниже — новые места, наряды, кадры и ракурсы. Они идут в следующие наборы и запуски. Уже составленные сцены остались как были; «Другая сцена» в открытом наборе возьмёт новые. Идущий запуск — со старым, у него своя копия.",
      ),
    ).toBeDefined();
  });
});

describe("the generate card: the line under «Ракурсы» (CatChipsAngles)", () => {
  function anglesRow(): HTMLElement {
    return screen.getByRole("group", { name: "Ракурсы" });
  }

  test("a category of the run with its own angles: one line, the message first; a screen reader hears it with the group's hint", async () => {
    const harness = await openPhotos({ categories: [PARIS, BED] });
    const chips = screen.getByRole("group", { name: "Категории · фото в каждой" });
    // Not in the run: no line.
    expect(screen.queryByText(/^Эти переключатели не касаются/) === null).toBe(true);
    fireEvent.click(within(chips).getByRole("button", { name: /^Домашнее у кровати/ }));
    await flush();
    // The visible line, whole, is hidden from a screen reader (which hears the full text the group names); its title repeats it.
    const line = screen.getByText(withText(/^Эти переключатели не касаются «Домашнее у кровати» — у неё свои ракурсы: три четверти, со спины\.$/));
    expect(line.getAttribute("aria-hidden")).toBe("true");
    expect(line.closest("[title]")?.getAttribute("title")).toBe("Свои ракурсы — Домашнее у кровати: три четверти, со спины");
    const described = (anglesRow().getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent ?? "");
    expect(described).toEqual([
      "профиль и со спины — только если разрешите, без проверки сходства",
      "Эти переключатели не касаются категорий со своими ракурсами: «Домашнее у кровати» — три четверти, со спины.",
    ]);
    fireEvent.click(within(chips).getByRole("button", { name: /^Домашнее у кровати/ }));
    await flush();
    expect(screen.queryByText(/^Эти переключатели не касаются/) === null).toBe(true);
    harness.unmount();
  });

  test("several: «ещё N категорий» is a button that opens every category with its angles under the line, the focus staying on it", async () => {
    const yoga = category(5, "Йога дома", { ...BED_POOL, poses: ["profile"] });
    const city = category(6, "Ночной город", { ...BED_POOL, poses: ["back"] });
    await openPhotos({ categories: [BED, yoga, city, MONO, WINTER] });
    const chips = screen.getByRole("group", { name: "Категории · фото в каждой" });
    for (const name of ["Домашнее у кровати", "Йога дома", "Ночной город"]) {
      fireEvent.click(within(chips).getByRole("button", { name: new RegExp(`^${name}`) }));
      await flush();
    }
    const more = screen.getByRole("button", { name: nb("ещё 2 категорий") });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    const list = document.getElementById(more.getAttribute("aria-controls") ?? "");
    expect(list === null || list.hidden).toBe(true);
    more.focus();
    fireEvent.click(more);
    await flush();
    expect(more.getAttribute("aria-expanded")).toBe("true");
    const open = document.getElementById(more.getAttribute("aria-controls") ?? "");
    expect(open?.hidden).toBe(false);
    expect(Array.from(open?.querySelectorAll("li") ?? []).map((li) => li.textContent)).toEqual(["Домашнее у кровати — три четверти, со спины", "Йога дома — профиль", "Ночной город — со спины"]);
    expect(describeElement(document.activeElement)).toBe(describeElement(more));
    fireEvent.click(more);
    await flush();
    expect(more.getAttribute("aria-expanded")).toBe("false");
  });
});
