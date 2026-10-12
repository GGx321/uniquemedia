import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { CategoryRef, ScenePlace, SceneView } from "../../shared/engine";
import { describeElement, flush, withText } from "../testing";
import { BED, BED_POOL, category, MIA } from "./photos/categoryScreenKit";
import { card, column, describedText, goButton, openReview, sceneCard } from "./photos/sceneScreenKit";

// CS.8b: angles on the review screen (README «CS.8 — angles from descriptions»; ReviewAngles, ReviewAddIdea, ReviewEmpty, ReviewIdeaWriting, ReviewRecompose;
// the ReviewStates sheet, section I, and its keyboard rows), against the mock engine: the strip's angle line, the pose tag on a scene card, ⟳ «Другая
// сцена» for a category with angles of its own, and the idea form's hint by shot.

const SET = "set-seed-0001";
const PLACE: ScenePlace = { location: "unmade bed with white linen", timeOfDay: "morning", activity: "lying on her stomach, reading", outfit: "striped pyjamas" };

type Planned = { category: CategoryRef; shot: SceneView["shot"]; pose: SceneView["pose"]; place: ScenePlace; text: string };
type Own = { idea: string; shot: SceneView["shot"]; pose: SceneView["pose"]; text: string };

function planned(category: CategoryRef, shot: SceneView["shot"], pose: SceneView["pose"], text: string): Planned {
  return { category, shot, pose, place: PLACE, text };
}

/** ReviewAngles: a set with «Домашнее у кровати» (its own angles), a built-in, and an own scene. */
function angledSet(categories: readonly CategoryRef[] = ["home", BED.categoryId], scenes: readonly (Planned | Own)[] = BED_SCENES) {
  return openReview({ categories: [BED], sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: SET, count: scenes.length, categories, scenes }] });
}

const BED_SCENES: readonly (Planned | Own)[] = [
  planned("home", "mirror", "front", "Mirror selfie in a brightly lit bathroom, phone in one hand, simple grey tank top."),
  planned(BED.categoryId, "selfie", "three-quarter", "Front-camera selfie at a three-quarter angle, lying on the pillows, phone in one hand."),
  planned("home", "photographer", "profile", "Studio portrait in profile against a warm-grey backdrop, black turtleneck."),
  planned(BED.categoryId, "friend", "back", "Lying on her stomach across an unmade bed, seen from behind, reading a magazine."),
  { idea: "Иду по пляжу на закате, вид сзади", shot: "candid", pose: "back", text: "Walking barefoot along the waterline at sunset, seen from behind." },
];

// S5.7c (mockup 28): the strip's line no longer lists the set's «Ракурсы» — the angle comes from the scene — but still names who keeps angles of their own.
// These sets are seeded as a build before «Подача» stored them (with toggles), so the line names no «Подача» (PhotosSceneLevel.test.tsx has it).
describe("the strip's angle line (ReviewAngles; contract note 9)", () => {
  test("it names the category with its own angles and own scenes, then «Пересоставить…» as before", async () => {
    await angledSet();
    await waitFor(() => expect(goButton().textContent).toContain("Отрисовать"));
    expect(within(card()).getByText(withText(/^Ракурс — из сцены; у «Домашнее у кровати» — свои; у своих сцен — по описанию\. Настройки набора не меняются — Пересоставить… начнёт заново\.$/))).toBeDefined();
    expect(within(card()).queryByRole("button", { name: /^ещё / , expanded: false }) === null).toBe(true);
  });

  test("several such categories: «и ещё N» is a button that opens them with their angles, the focus staying on it", async () => {
    const yoga = category(5, "Йога дома", { ...BED_POOL, poses: ["profile"] });
    const city = category(6, "Ночной город", { ...BED_POOL, poses: ["back"] });
    await openReview({
      categories: [BED, yoga, city],
      sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: SET, count: 3, written: 3, categories: [BED.categoryId, yoga.categoryId, city.categoryId] }],
    });
    await waitFor(() => expect(goButton().textContent).toContain("Отрисовать"));
    expect(within(card()).getByText(withText(/^Ракурс — из сцены; у «Домашнее у кровати» и ещё 2 — свои\. Настройки набора/))).toBeDefined();
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

  test("neither: the line as before", async () => {
    await openReview({ sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: SET, count: 3, written: 3 }] });
    await waitFor(() => expect(goButton().textContent).toContain("Отрисовать"));
    expect(card().textContent).toContain("Ракурс — из сцены. Настройки набора не меняются");
  });
});

describe("the pose tag on a scene card (ReviewStates I)", () => {
  test("profile and back carry «ракурс: …» after the shot tag; front and three-quarter carry none; the card's name stays", async () => {
    await angledSet();
    await waitFor(() => expect(goButton().textContent).toContain("Отрисовать"));
    const back = within(sceneCard(4)).getByText(withText(/^ракурс: со спины$/));
    expect(back.className).toContain("scene-tag-pose");
    expect(within(sceneCard(3)).getByText(withText(/^ракурс: профиль$/))).toBeDefined();
    expect(within(sceneCard(5)).getByText(withText(/^ракурс: со спины$/))).toBeDefined();
    expect(sceneCard(2).textContent?.includes("ракурс:") ?? true).toBe(false);
    expect(sceneCard(1).textContent?.includes("ракурс:") ?? true).toBe(false);
    // The tag comes after the shot tag.
    const tags = Array.from(back.parentElement?.children ?? []).map((tag) => tag.textContent);
    expect(tags).toEqual(["Домашнее у кровати", "Попросила снять", "ракурс: со спины"]);
  });
});

describe("⟳ «Другая сцена» of a category with angles of its own", () => {
  /** The popover of scene `n`, once its free price is in (the app's template writes both categories here, so ⟳ costs nothing — S5.7c's words). */
  async function popoverOf(n: number): Promise<HTMLElement> {
    fireEvent.click(within(sceneCard(n)).getByRole("button", { name: `Другая сцена вместо ${String(n).padStart(2, "0")}` }));
    await flush();
    const pop = within(sceneCard(n)).getByRole("dialog", { name: "Другая сцена" });
    await within(pop).findByRole("button", { name: "Заменить · бесплатно" });
    return pop;
  }
  const free = (category: string): string => `Новое место, наряд, действие, время дня и ракурс из категории «${category}» и новый текст — его пишет приложение, поэтому бесплатно.`;

  test("a selfie: the angle is drawn again and the shot may change; another shot: no clause; a built-in: no clause", async () => {
    await angledSet();
    await waitFor(() => expect(goButton().textContent).toContain("Отрисовать"));
    const selfie = await popoverOf(2);
    expect(selfie.textContent).toContain(`${free("Домашнее у кровати")} Со спины селфи не снять — тогда кадр сменится. Сцена 02 заменится сразу.`);
    fireEvent.click(within(selfie).getByRole("button", { name: "Отмена" }));
    await flush();
    const friend = await popoverOf(4);
    expect(friend.textContent).toContain(`${free("Домашнее у кровати")} Сцена 04 заменится сразу.`);
    fireEvent.click(within(friend).getByRole("button", { name: "Отмена" }));
    await flush();
    const home = await popoverOf(1);
    expect(home.textContent).toContain(`${free("Дом")} Сцена 01 заменится сразу.`);
  });

  test("it reads the category's angles as they are now: cleared in «Мои категории», ⟳ says the text without them", async () => {
    const { client } = await angledSet();
    await waitFor(() => expect(goButton().textContent).toContain("Отрисовать"));
    await act(async () => {
      await client.request("categories.update", { categoryId: BED.categoryId, poses: null });
    });
    await flush();
    const selfie = await popoverOf(2);
    expect(selfie.textContent).toContain(`${free("Домашнее у кровати")} Сцена 02 заменится сразу.`);
    expect(selfie.textContent?.includes("не снять") ?? true).toBe(false);
  });
});

describe("«+ Своя сцена»: the hint follows the shot (ReviewAddIdea, ReviewEmpty; ReviewStates I)", () => {
  test("«Авто», a shot without a phone, a selfie, the mirror — the idea and the shot picker point to it", async () => {
    await openReview({ sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: SET, count: 3, written: 3 }] });
    await waitFor(() => expect(goButton().textContent).toContain("Отрисовать"));
    fireEvent.click(within(column()).getByRole("button", { name: "Своя сцена" }));
    await flush();
    const form = within(column()).getByRole("region", { name: "Своя сцена · по описанию" });
    const idea = within(form).getByRole("textbox", { name: "Идея · на любом языке" });
    const shot = within(form).getByRole("combobox", { name: "Кадр" });
    const auto = "Модель выберет кадр и ракурс по идее: «вид сзади» — со спины, «сбоку» — профиль; селфи — только анфас или три четверти. Зеркало — только если оно есть в идее.";
    expect(describedText(idea)).toContain(auto);
    expect(describedText(shot)).toBe(auto);
    fireEvent.change(shot, { target: { value: "candid" } });
    await flush();
    expect(describedText(shot)).toBe("Ракурс модель выберет по идее: «вид сзади» — со спины, «сбоку» — профиль.");
    fireEvent.change(shot, { target: { value: "selfie" } });
    await flush();
    expect(describedText(shot)).toBe("Селфи — только анфас или три четверти: ракурс модель выберет из них. Нужен вид сзади или сбоку — выберите «Авто» или другой кадр.");
    fireEvent.change(shot, { target: { value: "mirror" } });
    await flush();
    expect(describedText(idea)).toContain("Зеркало — только анфас или три четверти: ракурс модель выберет из них.");
  });
});
