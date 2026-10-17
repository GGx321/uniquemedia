import { describe, expect, test } from "bun:test";
import { fireEvent, screen, within } from "@testing-library/react";
import { CLIP_REASONS_RU, type AvatarSummary, type PhotoSummary } from "../../shared/engine";
import { MOCK_SUGGEST_PRICE, MOCK_TRANSLATE_PRICE, mockIdeaAnswer, type MockModelReply } from "../engine/mockClipMotions";
import type { MockEngineOptions } from "../engine/mockEngine";
import { MIA, scenePhoto } from "../engine/mockEngine.testkit";
import { callsOf, flush, setup } from "../testing";

// 5b.2 part C, S5.WC5 (plan s5b2 §5.3 «Batch rows list stored suggestions and ideas. The batch sheet makes no paid call.», r2.1 N10; mockups 59d, 59e and README §S5.WCD decision 10): the batch sheet's rows
// list each photo's stored suggestions and own ideas, and «Оживить N» waits while a part C call runs — before the click when the window knows the call, after it (`motion-busy`) when it does not.

const NINI: AvatarSummary = { ...MIA, avatarId: "avatar-nini-0001", name: "Nini", masterPhotoId: "photo-nini-master" };
/** Newest first in the gallery: the bold frame is «Фото 1», the one with no face score «Фото 2», the plain judged one «Фото 3». */
const PLAIN = scenePhoto(1, {}, NINI);
const HIDDEN = scenePhoto(2, {}, NINI);
const BOLD = scenePhoto(3, { category: "nightwear", route: "seedream" }, NINI);
const PHOTOS: PhotoSummary[] = [PLAIN, HIDDEN, BOLD];
const MOTION_BUSY = CLIP_REASONS_RU["motion-busy"];
const plain = (text: string | null | undefined): string => (text ?? "").replace(/ /g, " ");

async function openNini(options: MockEngineOptions = {}) {
  const h = setup({ avatars: [{ ...NINI, photoCount: PHOTOS.length, eligibleUnusedCount: PHOTOS.length }], photos: PHOTOS, ...options });
  fireEvent.click(await screen.findByRole("button", { name: "Nini" }));
  await screen.findByRole("heading", { level: 1, name: "Nini" });
  await flush();
  return h;
}
type Harness = Awaited<ReturnType<typeof openNini>>;

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await flush();
}

/** Stores, as earlier sheets left them: Фото 3's three suggestions and one idea, and Фото 1's («Смелая») idea of 63a #bold. */
async function seedStores(h: Harness): Promise<void> {
  const avatarId = NINI.avatarId;
  await h.client.request("clips.suggestMotions", { avatarId, photoId: PLAIN.photoId, acceptedWorstMicros: MOCK_SUGGEST_PRICE.worstMicros });
  h.engine.scriptNextMotionReplies([mockIdeaAnswer("she slowly turns her head toward the window")]);
  await h.client.request("clips.translateIdea", { avatarId, photoId: PLAIN.photoId, text: "медленно поворачивает голову, прислушиваясь к шуму за окном", acceptedWorstMicros: MOCK_TRANSLATE_PRICE.worstMicros });
  h.engine.scriptNextMotionReplies([mockIdeaAnswer("she slowly lets her robe fall from her shoulders")]);
  await h.client.request("clips.translateIdea", { avatarId, photoId: BOLD.photoId, text: "медленно снимает халат с плеч", acceptedWorstMicros: MOCK_TRANSLATE_PRICE.worstMicros });
}

async function openBatch(): Promise<HTMLElement> {
  fireEvent.click(within(screen.getByRole("group", { name: "Выбор" })).getByRole("button", { name: "для клипов" }));
  await flush();
  fireEvent.click(screen.getByRole("button", { name: /^Выбрать для клипов: фото 3, Дом/ }));
  fireEvent.click(screen.getByRole("button", { name: /^Выбрать для клипов: фото 1, Ночнушки и бельё/ }));
  await flush();
  fireEvent.click(screen.getByRole("button", { name: /^Оживить выбранные · 2$/ }));
  await settle();
  return screen.getByRole("dialog", { name: "Оживить 2 фото" });
}

const rowOf = (s: HTMLElement, label: string): HTMLElement => {
  const row = Array.from(s.querySelectorAll<HTMLElement>(".batch-row")).find((r) => r.querySelector(".batch-label")?.textContent === label);
  if (row === undefined) throw new Error(`no row ${label}`);
  return row;
};
const selectOf = (row: HTMLElement): HTMLSelectElement => row.querySelector("select") as HTMLSelectElement;
const mainButton = (s: HTMLElement): HTMLElement => within(s).getByRole("button", { name: /^Оживить( \d+ · до \$[\d.]+)?$/ });
const cancelButton = (s: HTMLElement): HTMLElement => within(s).getByRole("button", { name: "Отмена" });
const isOff = (button: HTMLElement): boolean => button.getAttribute("aria-disabled") === "true";
const describedText = (el: HTMLElement): string => plain((el.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent ?? "").join(" | "));
/** The list as it reads: the plain options, then each group's name and its options. */
function listOf(select: HTMLSelectElement): string[] {
  return Array.from(select.children).flatMap((child) =>
    child instanceof HTMLOptGroupElement ? [`[${child.label}]`, ...Array.from(child.children).map((o) => o.textContent ?? "")] : [child.textContent ?? ""],
  );
}

describe("59d: the rows list the stored suggestions and ideas", () => {
  test("the code motions, then «Предложено» and «Свои идеи» with their labels alone; the sheet's list column widens for them", async () => {
    const h = await openNini();
    await seedStores(h);
    const s = await openBatch();
    expect(s.classList.contains("mc-batch")).toBe(true);
    expect(listOf(selectOf(rowOf(s, "Фото 3 · Дом")))).toEqual([
      "Моргает и улыбается",
      "Наклоняет голову",
      "Медленный вдох",
      "[Предложено]",
      "Движение 1",
      "Движение 2",
      "Движение 3",
      "[Свои идеи]",
      "медленно поворачивает голову…",
    ]);
    expect(listOf(selectOf(rowOf(s, "Фото 1 · Ночнушки и бельё")))).toEqual(["Моргает и улыбается", "Наклоняет голову", "Медленный вдох", "[Свои идеи]", "медленно снимает халат с плеч"]);
    // The batch sheet makes no paid part C call: no button of part C in it.
    expect(within(s).queryByRole("button", { name: /^Предложить движения|^Своя идея|^Перевести/ }) == null).toBe(true);
  });

  test("a chosen suggestion or idea shows its mark and its English under the photo; the sum does not move; «Оживить 2» sends its id", async () => {
    const h = await openNini();
    await seedStores(h);
    const s = await openBatch();
    const row = rowOf(s, "Фото 3 · Дом");
    const price = plain(s.querySelector(".clip-price-line")?.textContent);
    expect(row.querySelector(".mc-ben") == null).toBe(true);
    fireEvent.change(selectOf(row), { target: { value: "v-1" } });
    await flush();
    expect(plain(row.querySelector(".mc-ben .mc-tag")?.textContent)).toBe("предложено");
    expect(row.querySelector(".mc-ben [lang='en']")?.textContent).toBe("she slowly tucks a strand of hair behind her ear");
    fireEvent.change(selectOf(row), { target: { value: "o-1" } });
    await flush();
    expect(plain(row.querySelector(".mc-ben .mc-tag")?.textContent)).toBe("своя идея");
    expect(row.querySelector(".mc-ben .mc-tag")?.classList.contains("mc-tag-own")).toBe(true);
    expect(row.querySelector(".mc-ben [lang='en']")?.textContent).toBe("she slowly turns her head toward the window");
    const bold = rowOf(s, "Фото 1 · Ночнушки и бельё");
    fireEvent.change(selectOf(bold), { target: { value: "o-1" } });
    await flush();
    expect(bold.querySelector(".mc-ben [lang='en']")?.textContent).toBe("she slowly lets her robe fall from her shoulders");
    expect(plain(s.querySelector(".clip-price-line")?.textContent)).toBe(price);
    fireEvent.click(mainButton(s));
    await settle();
    const items = callsOf(h.engine, "clips.createBatch")[0]?.payload.items;
    expect(items).toEqual([
      { photoId: PLAIN.photoId, motionId: "o-1" },
      { photoId: BOLD.photoId, motionId: "o-1" },
    ]);
  });

  test("without stored motions the rows are 59's as approved: no groups, no mark, the list column as it was", async () => {
    await openNini();
    const s = await openBatch();
    expect(s.classList.contains("mc-batch")).toBe(false);
    expect(listOf(selectOf(rowOf(s, "Фото 3 · Дом")))).toEqual(["Моргает и улыбается", "Наклоняет голову", "Медленный вдох"]);
    expect(s.querySelector(".mc-ben") == null).toBe(true);
  });
});

describe("59e: «Оживить N» and a running part C call (r2.1 N10)", () => {
  test("a call this window sent: «Оживить 2» waits before the click, described by «Подождите: идёт подбор движения или перевод.»; a click sends nothing; once it ends the batch goes", async () => {
    const h = await openNini();
    fireEvent.click(screen.getByRole("button", { name: "Открыть фото 3: Дом" }));
    await flush();
    fireEvent.click(within(screen.getByRole("dialog", { name: /^Фото \d+ из \d+$/ })).getByRole("button", { name: "Оживить" }));
    await settle();
    const clipSheet = screen.getByRole("dialog", { name: "Оживить фото" });
    h.engine.holdMotionCalls(true);
    fireEvent.click(within(clipSheet).getByRole("button", { name: /^Предложить движения/ }));
    await settle();
    // The sheet closes; the call goes on.
    fireEvent.click(within(clipSheet).getByRole("button", { name: "Отмена" }));
    await flush();
    fireEvent.click(within(screen.getByRole("dialog", { name: /^Фото \d+ из \d+$/ })).getByRole("button", { name: "Закрыть" }));
    await flush();
    const s = await openBatch();
    const go = mainButton(s);
    expect(isOff(go)).toBe(true);
    expect(describedText(go)).toBe(MOTION_BUSY);
    expect(plain(s.querySelector(".mc-guard")?.textContent)).toBe(MOTION_BUSY);
    fireEvent.click(go);
    await flush();
    expect(callsOf(h.engine, "clips.createBatch")).toHaveLength(0);
    h.engine.holdMotionCalls(false);
    await settle();
    expect(isOff(mainButton(s))).toBe(false);
    expect(s.querySelector(".mc-guard")?.textContent).toBe("");
    fireEvent.click(mainButton(s));
    await settle();
    expect(callsOf(h.engine, "clips.createBatch")).toHaveLength(1);
  });

  test("#after-click: a call the window did not know of — the engine refuses `motion-busy`: one alert above the price, the focus on «Отмена», «Оживить 2» stays and goes once the call has ended", async () => {
    const h = await openNini();
    h.engine.holdMotionCalls(true);
    void h.client.request("clips.suggestMotions", { avatarId: NINI.avatarId, photoId: PLAIN.photoId, acceptedWorstMicros: MOCK_SUGGEST_PRICE.worstMicros });
    await flush();
    const s = await openBatch();
    expect(isOff(mainButton(s))).toBe(false);
    fireEvent.click(mainButton(s));
    await settle();
    // One alert, as the sheet's other after-click answers say theirs (WBD-13): the only live region of the sheet.
    expect(plain(within(s).getByRole("alert").textContent)).toBe(MOTION_BUSY);
    expect(within(s).getByRole("alert").classList.contains("notice-info")).toBe(true);
    expect(s.querySelector("[aria-live]") == null).toBe(true);
    expect(document.activeElement === cancelButton(s)).toBe(true);
    expect(isOff(mainButton(s))).toBe(false);
    h.engine.holdMotionCalls(false);
    await settle();
    fireEvent.click(mainButton(s));
    await settle();
    expect(callsOf(h.engine, "clips.createBatch")).toHaveLength(2);
    // The batch started: the sheet is gone.
    expect(screen.queryByRole("dialog", { name: "Оживить 2 фото" }) == null).toBe(true);
  });
});

/** The writer's answer with these labels and texts (the mock's own helper numbers its labels). */
function labelled(pairs: readonly [string, string][]): MockModelReply {
  const content = JSON.stringify({ motions: pairs.map(([label_ru, text_en]) => ({ label_ru, text_en })), frame: { capture: "unknown", phoneVisible: false, faceVisible: true } });
  return { kind: "answer", content, costMicros: 3_400 };
}
const FIRST_THREE = labelled([
  ["Дует на чай", "she slowly tucks a strand of hair behind her ear"],
  ["Прячет улыбку", "she tilts her head a little to one side and smiles"],
  ["Глубоко вдыхает", "she slowly takes a breath and relaxes her shoulders"],
]);
const NEXT_THREE = labelled([
  ["Смотрит вниз", "she slowly looks down and smiles to herself"],
  ["Смотрит в сторону", "she slowly glances to the side and looks back"],
  ["Поправляет волосы", "she slowly tucks a strand of hair behind her ear"],
]);

describe("S5.WC5b (M2): the batch rows follow the photo's stored motions", () => {
  test("a call for a listed photo ends while the sheet is open: the rows are read again, the options kept; a chosen suggestion pushed out is said, its row on the first motion", async () => {
    const h = await openNini();
    h.engine.scriptNextMotionReplies([FIRST_THREE]);
    await h.client.request("clips.suggestMotions", { avatarId: NINI.avatarId, photoId: PLAIN.photoId, acceptedWorstMicros: MOCK_SUGGEST_PRICE.worstMicros });
    // A sheet of Фото 3 asks for three more and is closed while the call runs (the window knows the call).
    fireEvent.click(screen.getByRole("button", { name: "Открыть фото 3: Дом" }));
    await flush();
    fireEvent.click(within(screen.getByRole("dialog", { name: /^Фото \d+ из \d+$/ })).getByRole("button", { name: "Оживить" }));
    await settle();
    const clipSheet = screen.getByRole("dialog", { name: "Оживить фото" });
    h.engine.holdMotionCalls(true);
    h.engine.scriptNextMotionReplies([NEXT_THREE]);
    fireEvent.click(within(clipSheet).getByRole("button", { name: /^Предложить движения/ }));
    await settle();
    fireEvent.click(within(clipSheet).getByRole("button", { name: "Отмена" }));
    await flush();
    fireEvent.click(within(screen.getByRole("dialog", { name: /^Фото \d+ из \d+$/ })).getByRole("button", { name: "Закрыть" }));
    await flush();
    const s = await openBatch();
    const row = rowOf(s, "Фото 3 · Дом");
    fireEvent.change(selectOf(row), { target: { value: "v-1" } });
    fireEvent.click(within(s).getByRole("radio", { name: "Чётче · 1080p" }));
    await flush();
    const asked = callsOf(h.engine, "clips.batchOptions").length;
    h.engine.holdMotionCalls(false);
    await settle();
    expect(callsOf(h.engine, "clips.batchOptions").length).toBe(asked + 1);
    const again = rowOf(s, "Фото 3 · Дом");
    expect(listOf(selectOf(again)).includes("Дует на чай")).toBe(false);
    expect(selectOf(again).value).toBe("g-blink");
    expect(again.querySelector(".mc-ben") == null).toBe(true);
    expect(plain(within(s).getByRole("status").textContent)).toBe("Фото 3 · Дом: движение «Дует на чай» больше не в списке — выбрано «Моргает и улыбается».");
    expect((within(s).getByRole("radio", { name: "Чётче · 1080p" }) as HTMLInputElement).checked).toBe(true);
  });

  test("`unknown-motion` after «Оживить 2»: the row stays (not struck) with «Движение больше недоступно — выберите другое.», one alert, the rows read again; the next click goes", async () => {
    const h = await openNini();
    await seedStores(h);
    const s = await openBatch();
    fireEvent.change(selectOf(rowOf(s, "Фото 3 · Дом")), { target: { value: "v-1" } });
    await flush();
    h.engine.tamperMotionStore(PLAIN.photoId, (store) => {
      store.items = store.items.filter((item) => item.id !== "v-1");
    });
    const asked = callsOf(h.engine, "clips.batchOptions").length;
    fireEvent.click(mainButton(s));
    await settle();
    const row = rowOf(s, "Фото 3 · Дом");
    expect(row.classList.contains("batch-row-off")).toBe(false);
    expect(plain(row.querySelector(".batch-note")?.textContent)).toBe("Движение больше недоступно — выберите другое.");
    expect(plain(within(s).getByRole("alert").textContent)).toBe("Фото 3 · Дом: движение больше недоступно — выберите другое.");
    expect(callsOf(h.engine, "clips.batchOptions").length).toBe(asked + 1);
    expect(selectOf(row).value).toBe("g-blink");
    expect(document.activeElement === cancelButton(s)).toBe(true);
    // Another choice ends the line; the click goes.
    fireEvent.change(selectOf(row), { target: { value: "v-2" } });
    await flush();
    expect(row.querySelector(".batch-note") == null).toBe(true);
    fireEvent.click(mainButton(s));
    await settle();
    expect(callsOf(h.engine, "clips.createBatch").at(-1)?.payload.items).toEqual([
      { photoId: PLAIN.photoId, motionId: "v-2" },
      { photoId: BOLD.photoId, motionId: "g-blink" },
    ]);
  });
});

describe("S5.WC5b round 2 (M-2): a drop never hides why «Оживить 2» waits", () => {
  test("the month does not fit and a call ends that drops the chosen motion: the month line stays, the drop added to it; «Оживить 2» still points at the month line", async () => {
    const h = await openNini({ money: { spentMicros: 9_600_000, monthlyBudgetMicros: 10_000_000 } });
    h.engine.scriptNextMotionReplies([FIRST_THREE]);
    await h.client.request("clips.suggestMotions", { avatarId: NINI.avatarId, photoId: PLAIN.photoId, acceptedWorstMicros: MOCK_SUGGEST_PRICE.worstMicros });
    // A sheet of Фото 3 asks for three more and is closed while the call runs.
    fireEvent.click(screen.getByRole("button", { name: "Открыть фото 3: Дом" }));
    await flush();
    fireEvent.click(within(screen.getByRole("dialog", { name: /^Фото \d+ из \d+$/ })).getByRole("button", { name: "Оживить" }));
    await settle();
    const clipSheet = screen.getByRole("dialog", { name: "Оживить фото" });
    h.engine.holdMotionCalls(true);
    h.engine.scriptNextMotionReplies([NEXT_THREE]);
    fireEvent.click(within(clipSheet).getByRole("button", { name: /^Предложить движения/ }));
    await settle();
    fireEvent.click(within(clipSheet).getByRole("button", { name: "Отмена" }));
    await flush();
    fireEvent.click(within(screen.getByRole("dialog", { name: /^Фото \d+ из \d+$/ })).getByRole("button", { name: "Закрыть" }));
    await flush();
    const s = await openBatch();
    fireEvent.change(selectOf(rowOf(s, "Фото 3 · Дом")), { target: { value: "v-1" } });
    await flush();
    const footNotices = (): string[] => Array.from(s.querySelectorAll(".clip-sheet-foot .notice")).map((n) => plain(n.textContent));
    const [month] = footNotices();
    expect(month?.startsWith("Не хватает месячного бюджета: пакету нужно до ")).toBe(true);
    h.engine.holdMotionCalls(false);
    await settle();
    expect(selectOf(rowOf(s, "Фото 3 · Дом")).value).toBe("g-blink");
    // One status: the month line (its room read again, the call's reserve settled), then the drop.
    const drop = " Фото 3 · Дом: движение «Дует на чай» больше не в списке — выбрано «Моргает и улыбается».";
    const after = footNotices();
    expect(after).toHaveLength(1);
    const [both = ""] = after;
    expect(both.startsWith("Не хватает месячного бюджета: пакету нужно до ")).toBe(true);
    expect(both.endsWith(drop)).toBe(true);
    expect(plain(within(s).getByRole("status").textContent)).toBe(both);
    // «Оживить 2» waits, described by the month line alone.
    expect(isOff(mainButton(s))).toBe(true);
    expect(describedText(mainButton(s))).toBe(both.slice(0, both.length - drop.length));
  });
});
