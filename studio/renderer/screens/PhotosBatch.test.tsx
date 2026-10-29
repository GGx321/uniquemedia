import { describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { CLIP_REASONS_RU, type AvatarSummary, type PhotoSummary } from "../../shared/engine";
import { App } from "../App";
import { type MockEngineOptions } from "../engine/mockEngine";
import { MIA, scenePhoto } from "../engine/mockEngine.testkit";
import { callsOf, flush, focusedLabel, setup, tick } from "../testing";

// 5b.2, S5.WB4 (plan s5b2 §5.2, §6 rows 58–60f, 37e; the mockups .omc/stage5/design/58-*.html … 60f-*.html, 37e; README §S5.WBD): «Оживить выбранные» against the mock engine, which runs the batch as the
// engine does (`mockClipBatch.ts`). The pick mode and its own set, the bar's lines, the sheet with its rows and the engine's sums, the after-click refusals, the «Клипы» header counted by batchIndex, the
// calm tiles of the members waiting, «Отменить оставшиеся», the stops, the restart, the sidebar's one row per batch, and «Оживить» waiting in the viewer while a batch runs.

const NBSP = " ";
const NINI: AvatarSummary = { ...MIA, avatarId: "avatar-nini-0001", name: "Nini", masterPhotoId: "photo-nini-master" };
// Newest first in the gallery: Фото 1 is n9, Фото 2 n7 (rejected), Фото 3 n5 (in a video), Фото 4 n3 («Смелая»), Фото 5 n2 (no face score: no motion), Фото 6 n1.
const PLAIN = scenePhoto(9, { qa: { faceCos: 0.86 } }, NINI);
const REJECTED = scenePhoto(7, { rejected: true, eligible: false, qa: { faceCos: 0.86 } }, NINI);
const USED = scenePhoto(5, { used: true, usedIn: ["video-0000001"], qa: { faceCos: 0.86 } }, NINI);
const BOLD = scenePhoto(3, { category: "nightwear", route: "seedream", qa: { faceCos: 0.86 } }, NINI);
const NO_FACE = scenePhoto(2, {}, NINI);
const OTHER = scenePhoto(1, { qa: { faceCos: 0.86 } }, NINI);
const PHOTOS: PhotoSummary[] = [OTHER, NO_FACE, BOLD, USED, REJECTED, PLAIN];
/** The README's month: $10 budget, $3.80 spent — $6.20 left. */
const MONTH = { spentMicros: 3_800_000, monthlyBudgetMicros: 10_000_000 };

async function openNini(options: MockEngineOptions = {}) {
  const photos = options.photos ?? PHOTOS;
  const h = setup({ avatars: [{ ...NINI, photoCount: photos.length, eligibleUnusedCount: photos.length }], photos, money: MONTH, ...options });
  fireEvent.click(await screen.findByRole("button", { name: "Nini" }));
  await screen.findByRole("heading", { level: 1, name: "Nini" });
  await flush();
  return h;
}

type Harness = Awaited<ReturnType<typeof openNini>>;

const modeButton = (label: "для монтажа" | "для клипов"): HTMLElement => within(screen.getByRole("group", { name: "Выбор" })).getByRole("button", { name: label });
async function clipsMode(): Promise<void> {
  fireEvent.click(modeButton("для клипов"));
  await flush();
}
const pickFor = (mode: "монтажа" | "клипов", n: number, category = "Дом"): HTMLElement => screen.getByRole("button", { name: new RegExp(`^Выбрать для ${mode}: фото ${n}, ${category}`) });
async function pickClips(...photos: readonly [number, string?][]): Promise<void> {
  for (const [n, category] of photos) fireEvent.click(pickFor("клипов", n, category));
  await flush();
}
const bar = (): HTMLElement => screen.getByRole("button", { name: /^Оживить выбранные · \d+$/ });
function whyOf(button: HTMLElement): string {
  const id = button.getAttribute("aria-describedby");
  return id === null ? "" : (document.getElementById(id)?.textContent ?? "");
}
const sheet = (): HTMLElement => screen.getByRole("dialog", { name: /^Оживить \d+ фото$/ });
async function openBatchSheet(): Promise<HTMLElement> {
  fireEvent.click(bar());
  await flush();
  await flush();
  return sheet();
}
/** The five of 59, in its order: Фото 1, the «Смелая» frame, the photo in a video, the rejected one, the one with no face. */
const FIVE: readonly [number, string?][] = [[1], [4, "Ночнушки и бельё"], [3], [2], [5]];
const rowLabels = (s: HTMLElement): string[] => Array.from(s.querySelectorAll(".batch-label")).map((n) => n.textContent ?? "");
const rowOf = (s: HTMLElement, label: string): HTMLElement => {
  const row = Array.from(s.querySelectorAll<HTMLElement>(".batch-row")).find((r) => r.querySelector(".batch-label")?.textContent === label);
  if (row === undefined) throw new Error(`no row ${label}`);
  return row;
};
const priceLine = (s: HTMLElement): string => s.querySelector(".clip-price-line")?.textContent ?? "";
const mainButton = (s: HTMLElement): HTMLElement => within(s).getByRole("button", { name: /^Оживить( \d+ · до \$[\d.]+)?$/ });
const sidebarQueue = (): HTMLElement => screen.getByRole("region", { name: "Очередь" });
const batchHead = (): HTMLElement => {
  const head = document.querySelector<HTMLElement>(".batch-head");
  if (head === null) throw new Error("no batch header");
  return head;
};
const headTitle = (): string => document.querySelector(".batch-head .batch-title")?.textContent ?? "";
const headLine = (): string | null => document.querySelector(".batch-head .batch-line")?.textContent ?? null;
const clipsHeading = (): HTMLElement => screen.getByRole("heading", { level: 2, name: "Клипы" });

async function until(h: Harness, done: () => boolean, what: string, max = 600): Promise<void> {
  for (let i = 0; i < max && !done(); i++) {
    tick(h.scheduler);
    await flush();
  }
  await flush();
  if (!done()) throw new Error(`never reached ${what}: «${document.querySelector(".clips-tab")?.textContent ?? "(no «Клипы» tab)"}»`);
}

/** Picks `photos` for clips, opens the sheet and sends «Оживить N»: the batch starts and «Клипы» shows it. */
async function startBatch(photos: readonly [number, string?][]): Promise<void> {
  await clipsMode();
  await pickClips(...photos);
  const s = await openBatchSheet();
  fireEvent.click(mainButton(s));
  await flush();
  await flush();
}

describe("58: the gallery's «Выбор: для монтажа · для клипов»", () => {
  test("under «Галерея», a montage by default; each mode keeps its own picks; a clip pick shows its turn, and the others move up when one goes", async () => {
    await openNini();
    expect(modeButton("для монтажа").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(pickFor("монтажа", 1));
    await flush();
    expect(screen.getByRole("button", { name: "Монтаж из выбранных · 1" })).toBeDefined();

    await clipsMode();
    expect(modeButton("для клипов").getAttribute("aria-pressed")).toBe("true");
    expect(pickFor("клипов", 1).getAttribute("aria-pressed")).toBe("false");
    await pickClips([6], [1], [4, "Ночнушки и бельё"]);
    expect([6, 1].map((n) => pickFor("клипов", n).textContent)).toEqual(["1", "2"]);
    expect(pickFor("клипов", 4, "Ночнушки и бельё").textContent).toBe("3");
    expect(bar().textContent).toBe("Оживить выбранные · 3");

    fireEvent.click(pickFor("клипов", 6));
    await flush();
    expect(pickFor("клипов", 1).textContent).toBe("1");
    expect(pickFor("клипов", 4, "Ночнушки и бельё").textContent).toBe("2");

    fireEvent.click(modeButton("для монтажа"));
    await flush();
    expect(pickFor("монтажа", 1).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Монтаж из выбранных · 1" })).toBeDefined();
    await clipsMode();
    expect(bar().textContent).toBe("Оживить выбранные · 2");
  });

});

describe("58a: the bar's line", () => {
  test("picks within the cap: the month's room from MoneyStatus, rounded down, over the worst clip — «В этом месяце осталось $6.20 — это примерно 7 клипов»", async () => {
    await openNini();
    await clipsMode();
    await pickClips([1]);
    expect(whyOf(bar())).toBe(`В этом месяце осталось $6.20${NBSP}— это примерно 7${NBSP}клипов`);
    expect(bar().hasAttribute("aria-disabled")).toBe(false);
  });

  test("21 picks: «Не больше 20 клипов в одном пакете — снимите лишние», and the button waits", async () => {
    const many = Array.from({ length: 21 }, (_, i) => scenePhoto(i + 1, { qa: { faceCos: 0.86 } }, NINI));
    await openNini({ photos: many });
    await clipsMode();
    for (let n = 1; n <= 21; n++) fireEvent.click(pickFor("клипов", n));
    await flush();
    expect(whyOf(bar())).toBe(`Не больше 20 клипов в одном пакете${NBSP}— снимите лишние`);
    expect(bar().getAttribute("aria-disabled")).toBe("true");
  });
});

describe("59: the sheet «Оживить N фото»", () => {
  test("rows in pick order with their notes and motions, the struck row's own reason, the engine's sums, the room and «Оживить 4 · до $3.06»", async () => {
    await openNini();
    await clipsMode();
    await pickClips(...FIVE);
    const s = await openBatchSheet();
    expect(within(s).getByRole("heading", { name: "Оживить 5 фото" })).toBeDefined();
    expect(rowLabels(s)).toEqual(["Фото 1 · Дом", "Фото 4 · Ночнушки и бельё", "Фото 3 · Дом", "Фото 2 · Дом", "Фото 5 · Дом"]);
    expect(rowOf(s, "Фото 4 · Ночнушки и бельё").textContent).toContain("без запасной модели");
    expect(rowOf(s, "Фото 3 · Дом").textContent).toContain(`фото уже в видео${NBSP}— клип в монтаж не ставится`);
    expect(rowOf(s, "Фото 2 · Дом").textContent).toContain("пока фото отклонено, клип в монтаж не ставится");
    const struck = rowOf(s, "Фото 5 · Дом");
    expect(struck.classList.contains("batch-row-off")).toBe(true);
    expect(struck.textContent).toContain(CLIP_REASONS_RU["no-motion"]);
    expect((within(struck).queryByRole("combobox") ?? null) === null).toBe(true);
    expect(within(s).getByRole("combobox", { name: "Движение · Фото 1 · Дом" })).toBeDefined();
    expect(priceLine(s)).toBe("Обычно $1.68 · не больше $3.06");
    expect(s.querySelector(".batch-room")?.textContent).toBe("Осталось в месяце $6.20");
    expect(within(s).getByText("Клипы снимаются по очереди и появятся во вкладке «Клипы».")).toBeDefined();
    expect(mainButton(s).textContent).toBe("Оживить 4 · до $3.06");
  });

  test("«Оживить 4» sends the members in pick order with their motions and the engine's sum; «Клипы» shows the batch, its heading focused, and the picks are done with", async () => {
    const h = await openNini();
    await clipsMode();
    await pickClips(...FIVE);
    const s = await openBatchSheet();
    fireEvent.change(within(s).getByRole("combobox", { name: "Движение · Фото 3 · Дом" }), { target: { value: "g-tilt" } });
    await flush();
    fireEvent.click(mainButton(s));
    await flush();
    await flush();
    const [sent] = callsOf(h.engine, "clips.createBatch");
    expect(sent?.payload).toEqual({
      avatarId: NINI.avatarId,
      items: [
        { photoId: PLAIN.photoId, motionId: "g-blink" },
        { photoId: BOLD.photoId, motionId: "g-blink" },
        { photoId: USED.photoId, motionId: "g-tilt" },
        { photoId: REJECTED.photoId, motionId: "g-blink" },
      ],
      quality: "std",
      seconds: 5,
      fallback: "auto",
      acceptedWorstMicros: 3_054_000,
    });
    expect(screen.getByRole("tab", { name: /^Клипы/ }).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement === clipsHeading()).toBe(true);
    expect(headTitle()).toMatch(/^Пакет · (снимается 1 · )?в очереди \d$/);
    fireEvent.click(screen.getByRole("tab", { name: "Фото" }));
    await flush();
    expect(bar().textContent).toBe("Оживить выбранные · 0");
  });

  test("59a: PRICE_CHANGED after the click — «Цена изменилась: теперь не больше $X. Подтвердите ещё раз.», the focus on «Отмена»; a change of the option takes the alert away", async () => {
    const h = await openNini();
    await clipsMode();
    await pickClips(...FIVE);
    const s = await openBatchSheet();
    h.engine.setClipRates({ std: { perSecondMicros: 84_000, perInputImageMicros: 0 }, pro: { perSecondMicros: 112_000, perInputImageMicros: 0 }, grok: { perSecondMicros: 160_000, perInputImageMicros: 10_000 } });
    act(() => h.engine.passClipTime(11 * 60_000));
    fireEvent.click(mainButton(s));
    await flush();
    await flush();
    // 3 × (6 × $0.16 + $0.01) + $0.504 = $3.414 → «$3.42».
    expect(within(s).getByRole("alert").textContent).toBe("Цена изменилась: теперь не больше $3.42. Подтвердите ещё раз.");
    expect(mainButton(s).textContent).toBe("Оживить 4 · до $3.42");
    expect(focusedLabel()).toBe("button «Отмена»");
    fireEvent.click(within(s).getByRole("radio", { name: "10 секунд" }));
    await flush();
    expect((within(s).queryByRole("alert") ?? null) === null).toBe(true);
  });

  test("59b at open: the month holds Kling alone — «Оживить 4» waits, described by the notice; «Оживить без запасной модели · до $2.02» sends fallback none", async () => {
    const h = await openNini({ money: { spentMicros: 7_400_000, monthlyBudgetMicros: 10_000_000 } });
    await clipsMode();
    await pickClips(...FIVE);
    const s = await openBatchSheet();
    const main = mainButton(s);
    expect(main.getAttribute("aria-disabled")).toBe("true");
    expect(whyOf(main)).toBe("Не хватает месячного бюджета: пакету нужно до $3.06, осталось $2.60. Уберите часть фото или поднимите бюджет в Настройках.");
    expect(within(s).getByRole("status").textContent).toContain("пакету нужно до $3.06");
    expect(within(s).getByText("Если Kling откажет, Grok снимать не будем")).toBeDefined();
    fireEvent.click(main);
    await flush();
    expect(callsOf(h.engine, "clips.createBatch")).toHaveLength(0);
    fireEvent.click(within(s).getByRole("button", { name: "Оживить без запасной модели · до $2.02" }));
    await flush();
    await flush();
    expect(callsOf(h.engine, "clips.createBatch")[0]?.payload).toMatchObject({ fallback: "none", acceptedWorstMicros: 2_016_000 });
  });

  test("59b #after-click: another run held the month while the sheet was open — BUDGET_EXCEEDED is an alert with the room asked again, the Kling-only way offered, the focus on «Отмена»", async () => {
    const h = await openNini();
    await clipsMode();
    await pickClips(...FIVE);
    const s = await openBatchSheet();
    h.engine.openForeignReserve("run-mia:attempt-1", 3_600_000);
    fireEvent.click(mainButton(s));
    await flush();
    await flush();
    expect(within(s).getByRole("alert").textContent).toBe("Не хватает месячного бюджета: пакету нужно до $3.06, осталось $2.60. Уберите часть фото или поднимите бюджет в Настройках.");
    expect(within(s).getByRole("button", { name: "Оживить без запасной модели · до $2.02" })).toBeDefined();
    expect(focusedLabel()).toBe("button «Отмена»");
  });

  test("59c: PRICE_UNAVAILABLE `video` — the rows bare, 38f's notice, «Цена —», «Оживить» waits described by it", async () => {
    const h = await openNini();
    h.engine.setVideoPrices("missing");
    await clipsMode();
    await pickClips(...FIVE);
    const s = await openBatchSheet();
    expect(within(s).getByRole("status").textContent).toBe(`Цены видео у OpenRouter сейчас не читаются${NBSP}— клип не запустить. Фото работают как обычно.`);
    expect(priceLine(s)).toBe("—");
    expect(within(s).queryAllByRole("combobox")).toHaveLength(0);
    expect(s.querySelectorAll(".batch-note")).toHaveLength(0);
    const main = mainButton(s);
    expect(main.getAttribute("aria-disabled")).toBe("true");
    expect(whyOf(main)).toContain("Цены видео у OpenRouter сейчас не читаются");
  });
});

describe("60: «Клипы» while the batch runs", () => {
  test("the header by batchIndex, the members waiting calm with their place, one sidebar row «Клип 1/4 · Nini», every member in «Очередь»", async () => {
    const h = await openNini();
    await startBatch([[1], [4, "Ночнушки и бельё"], [3], [2]]);
    await until(h, () => document.querySelector(".clip-tile-work:not(.clip-tile-queued)") !== null, "the first member at work");
    expect(headTitle()).toBe("Пакет · снимается 1 · в очереди 3");
    expect(within(batchHead()).getByRole("button", { name: "Отменить оставшиеся" })).toBeDefined();
    expect((within(batchHead()).queryByRole("button", { name: "Закрыть" }) ?? null) === null).toBe(true);
    const waiting = screen.getAllByRole("article", { name: /^Клип в очереди: / });
    expect(waiting).toHaveLength(3);
    const second = waiting[0];
    if (second === undefined) throw new Error("no waiting tile");
    expect(second.querySelector(".batch-index")?.textContent).toBe("2/4");
    expect(second.querySelector(".batch-index")?.getAttribute("title")).toBe("Клип 2 из 4 в пакете");
    expect(second.querySelector(".clip-phase")?.textContent).toBe("В очереди");
    expect((second.querySelector(".spin") ?? null) === null).toBe(true);
    expect((second.querySelector(".shim") ?? null) === null).toBe(true);
    expect((within(second).queryByRole("status") ?? null) === null).toBe(true);
    expect((within(second).queryByRole("button") ?? null) === null).toBe(true);
    expect(second.textContent).toContain("до $0.51");
    expect(within(sidebarQueue()).getByText("Клип 1/4 · Nini")).toBeDefined();
    expect(within(sidebarQueue()).getByText("4 задачи")).toBeDefined();
    expect(sidebarQueue().querySelectorAll(".side-clip")).toHaveLength(1);
    expect(sidebarQueue().querySelector(".side-clip")?.classList.contains("side-clip-batch")).toBe(true);
    // One live region on the tab (README decision 13): the phase of the clip at work. The header is not one.
    const tab = document.querySelector<HTMLElement>(".clips-tab");
    if (tab === null) throw new Error("no «Клипы» tab");
    expect(within(tab).getAllByRole("status")).toHaveLength(1);
    expect(batchHead().getAttribute("role")).toBeNull();
  });

  test("#photo-gone: a member's photo left the gallery before its turn — «· не снимался 1» and «Это фото удалено из галереи — клип не снимался, бесплатно.»; the batch goes on", async () => {
    const h = await openNini();
    await startBatch([[1], [3], [6]]);
    h.engine.removeClipPhoto(USED.photoId);
    await until(h, () => headTitle().includes("не снимался 1"), "the member whose photo went");
    expect(headLine()).toBe(`Это фото удалено из галереи${NBSP}— клип не снимался, бесплатно.`);
    await until(h, () => headTitle().startsWith("Пакет готов"), "the batch's end");
    expect(headTitle()).toBe("Пакет готов: 2 клипа · не снимался 1 · $0.84");
    expect(headLine()).toBe(`Это фото удалено из галереи${NBSP}— клип не снимался, бесплатно.`);
  });

  test("«Отменить оставшиеся»: free, no question — the waiting tiles go, «· не снимались 3» and «Отменено: 3 клипа не снимались — бесплатно» from the engine's count, the focus on the header's line", async () => {
    const h = await openNini();
    await startBatch([[1], [4, "Ночнушки и бельё"], [3], [2]]);
    await until(h, () => document.querySelector(".clip-tile-work:not(.clip-tile-queued)") !== null, "the first member at work");
    fireEvent.click(within(batchHead()).getByRole("button", { name: "Отменить оставшиеся" }));
    await flush();
    await flush();
    expect(callsOf(h.engine, "clips.cancelBatch")).toHaveLength(1);
    expect(headTitle()).toBe("Пакет · снимается 1 · не снимались 3");
    expect(headLine()).toBe(`Отменено: 3 клипа не снимались${NBSP}— бесплатно`);
    expect(screen.queryAllByRole("article", { name: /^Клип в очереди: / })).toHaveLength(0);
    expect(document.activeElement?.classList.contains("batch-title")).toBe(true);
    expect(within(sidebarQueue()).getByText("1 задача")).toBeDefined();
    await until(h, () => headTitle().startsWith("Пакет · 1 из 4 готов"), "the member at work done");
    expect(headTitle()).toBe("Пакет · 1 из 4 готов · не снимались 3");
    expect(within(batchHead()).getByRole("button", { name: "Закрыть" })).toBeDefined();
  });

});

describe("60b–60f: the end and the stops", () => {
  test("60b: a refusal proven free — «Пакет готов: 1 клип · 1 отказ бесплатно · $0.42»; ✕ puts the header away and the focus on «Клипы»", async () => {
    const h = await openNini();
    h.engine.scriptNextBatch(["ok", "refused-free"]);
    await startBatch([[1], [4, "Ночнушки и бельё"]]);
    await until(h, () => document.querySelector(".batch-head")?.textContent?.startsWith("Пакет готов") === true, "the batch's end");
    expect(headTitle()).toBe("Пакет готов: 1 клип · 1 отказ бесплатно · $0.42");
    expect(batchHead().classList.contains("batch-head-ok")).toBe(true);
    fireEvent.click(within(batchHead()).getByRole("button", { name: "Закрыть" }));
    await flush();
    expect((document.querySelector(".batch-head") ?? null) === null).toBe(true);
    expect(document.activeElement === clipsHeading()).toBe(true);
  });

  test("60b #worst: a refusal that could not be proven free — no «бесплатно», the sum holds its ceiling, and the line says why", async () => {
    const h = await openNini();
    h.engine.scriptNextBatch(["ok", "refused-uncounted"]);
    await startBatch([[1], [4, "Ночнушки и бельё"]]);
    await until(h, () => document.querySelector(".batch-head")?.textContent?.startsWith("Пакет готов") === true, "the batch's end");
    expect(headTitle()).toBe("Пакет готов: 1 клип · 1 отказ · $0.93");
    expect(headLine()).toBe("Отказ учтён по максимуму $0.51: не удалось доказать, что он бесплатный.");
    expect(batchHead().classList.contains("batch-head-info")).toBe(true);
  });

  test("60e: the price rose at a member's turn — the stop's words, «Отметить их снова» picks the photos not shot in «для клипов» and focuses the bar", async () => {
    const h = await openNini();
    await clipsMode();
    await pickClips([1], [3], [2]);
    const s = await openBatchSheet();
    fireEvent.click(mainButton(s));
    await flush();
    await flush();
    // Taken at the old price; before the first member's turn the listing moves and the price cache runs out: the turn reads a worst above the member's share.
    h.engine.setClipRates({ std: { perSecondMicros: 90_000, perInputImageMicros: 0 }, pro: { perSecondMicros: 112_000, perInputImageMicros: 0 }, grok: { perSecondMicros: 160_000, perInputImageMicros: 10_000 } });
    act(() => h.engine.passClipTime(11 * 60_000));
    await flush();
    await until(h, () => headLine()?.startsWith("Цена у OpenRouter выросла") === true, "the price stop");
    expect(headTitle()).toBe("Пакет · не снимались 3");
    expect(headLine()).toBe(`Цена у OpenRouter выросла${NBSP}— оставшиеся 3 клипа не снимались, бесплатно. Запустите их заново.`);
    expect(batchHead().classList.contains("batch-head-warn")).toBe(true);
    fireEvent.click(within(batchHead()).getByRole("button", { name: "Отметить их снова" }));
    await flush();
    await flush();
    expect(screen.getByRole("tab", { name: "Фото" }).getAttribute("aria-selected")).toBe("true");
    expect(modeButton("для клипов").getAttribute("aria-pressed")).toBe("true");
    expect([1, 3, 2].map((n) => pickFor("клипов", n).textContent)).toEqual(["1", "2", "3"]);
    expect(focusedLabel()).toBe("button «Оживить выбранные · 3»");
  });

  test("60f: a member's money is uncertain — the rest is not spent blind: «Клип задержался или не ясно, оплачен ли он — оставшиеся 2 не снимались…»", async () => {
    const h = await openNini();
    h.engine.scriptNextBatch(["uncertain"]);
    await startBatch([[1], [3], [2]]);
    await until(h, () => headLine()?.startsWith("Клип задержался") === true, "the money stop");
    expect(headTitle()).toBe("Пакет · не снимались 2");
    expect(headLine()).toBe(`Клип задержался или не ясно, оплачен ли он${NBSP}— оставшиеся 2 не снимались, чтобы не тратить вслепую. Бесплатно.`);
  });

  test("60c #restart: a restart dropped the member still queued; the one in flight recovers as a single clip does — then «Оставшийся 1 клип не снимался — бесплатно.»", async () => {
    const h = await openNini();
    await startBatch([[1], [3], [2]]);
    await until(h, () => headTitle() === "Пакет · 1 из 3 готов · снимается 1 · в очереди 1", "the second member in flight");
    await until(h, () => screen.queryByText(/^Снимается · /) !== null, "the second member rendering");
    act(() => h.engine.restart());
    await flush();
    await flush();
    await until(h, () => headLine() !== null, "the recovered member's end");
    expect(headTitle()).toBe("Пакет · 2 из 3 готовы · не снимался 1");
    expect(headLine()).toBe(`Оставшийся 1 клип не снимался${NBSP}— бесплатно.`);
    expect(batchHead().classList.contains("batch-head-info")).toBe(true);
    expect(screen.queryAllByRole("article", { name: /^Клип в очереди: / })).toHaveLength(0);
  });
});

describe("round 2 (S5.WB4b): the header from the engine's summary", () => {
  test("M1: a made clip of the batch the owner deletes stays «готов», its money stays in the total — the tile goes", async () => {
    const h = await openNini();
    await startBatch([[1], [3]]);
    await until(h, () => headTitle().startsWith("Пакет готов"), "the batch's end");
    expect(headTitle()).toBe("Пакет готов: 2 клипа · $0.84");
    const listed = await h.client.request("clips.list", { avatarId: NINI.avatarId });
    const clip = listed.ok ? listed.result.clips[0] : undefined;
    if (clip === undefined) throw new Error("no clip listed");
    await act(async () => {
      await h.client.request("clips.delete", { avatarId: NINI.avatarId, clipId: clip.clipId });
    });
    // Deleted elsewhere (another window): the avatar's screen opened again lists the clips afresh.
    fireEvent.click(screen.getByRole("button", { name: "Аватары" }));
    await flush();
    fireEvent.click(await screen.findByRole("button", { name: "Nini" }));
    await screen.findByRole("heading", { level: 1, name: "Nini" });
    await flush();
    fireEvent.click(screen.getByRole("tab", { name: /^Клипы/ }));
    await flush();
    await flush();
    expect(screen.getAllByRole("article", { name: /^Клип: / })).toHaveLength(1);
    expect(headTitle()).toBe("Пакет готов: 2 клипа · $0.84");
    expect(headTitle()).not.toContain("не снимал");
  });

});

describe("round 3 (S5.WB4c): the links and the words around a running batch", () => {
  const ZOE: AvatarSummary = { ...MIA, avatarId: "avatar-zoe-0001", name: "Zoe", masterPhotoId: "photo-zoe-master" };
  const ZOE_PHOTOS = [scenePhoto(1, { qa: { faceCos: 0.86 } }, ZOE), scenePhoto(3, { qa: { faceCos: 0.86 } }, ZOE)];

  /** Nini's batch of three, started straight on the engine (another window's), then Zoe's screen open. */
  async function ninisBatchSeenFromZoe() {
    const photos = [...PHOTOS, ...ZOE_PHOTOS];
    const h = setup({ avatars: [{ ...NINI, photoCount: PHOTOS.length, eligibleUnusedCount: PHOTOS.length }, { ...ZOE, photoCount: 2, eligibleUnusedCount: 2 }], photos, money: MONTH });
    const ids = [PLAIN.photoId, USED.photoId, OTHER.photoId];
    const options = await h.client.request("clips.batchOptions", { avatarId: NINI.avatarId, photoIds: ids });
    if (!options.ok) throw new Error("no batch options");
    const made = await h.client.request("clips.createBatch", {
      avatarId: NINI.avatarId,
      items: ids.map((photoId) => ({ photoId, motionId: "g-blink" })),
      quality: "std",
      seconds: 5,
      fallback: "auto",
      acceptedWorstMicros: options.result.sums.std5.worst,
    });
    if (!made.ok) throw new Error(`no batch: ${made.error.code}`);
    fireEvent.click(await screen.findByRole("button", { name: "Zoe" }));
    await screen.findByRole("heading", { level: 1, name: "Zoe" });
    await flush();
    tick(h.scheduler, 2);
    await flush();
    return h;
  }

  test("PRICE_CHANGED that leaves the new sum over the month says the month in the same alert, and does not ask to confirm", async () => {
    const h = await openNini({ money: { spentMicros: 6_800_000, monthlyBudgetMicros: 10_000_000 } });
    await clipsMode();
    await pickClips(...FIVE);
    const s = await openBatchSheet();
    h.engine.setClipRates({ std: { perSecondMicros: 84_000, perInputImageMicros: 0 }, pro: { perSecondMicros: 112_000, perInputImageMicros: 0 }, grok: { perSecondMicros: 160_000, perInputImageMicros: 10_000 } });
    act(() => h.engine.passClipTime(11 * 60_000));
    fireEvent.click(mainButton(s));
    await flush();
    await flush();
    const alerts = within(s).getAllByRole("alert");
    expect(alerts.map((a) => a.textContent)).toEqual(["Цена изменилась: теперь не больше $3.42. Не хватает месячного бюджета: пакету нужно до $3.42, осталось $3.20. Уберите часть фото или поднимите бюджет в Настройках."]);
    expect(within(s).queryAllByRole("status")).toHaveLength(0);
    expect(focusedLabel()).toBe("button «Отмена»");
  });

  test("PRICE_UNAVAILABLE at the click that reads again when asked: a short status says why nothing went", async () => {
    const h = await openNini();
    await clipsMode();
    await pickClips(...FIVE);
    const s = await openBatchSheet();
    // The listing did not read at the click and reads again when the sheet asks: the sheet looks as it did.
    h.engine.failNext("clips.createBatch", { code: "PRICE_UNAVAILABLE", priceScope: "video", detail: "the video listing did not read" });
    fireEvent.click(mainButton(s));
    await flush();
    await flush();
    expect(callsOf(h.engine, "clips.createBatch")).toHaveLength(1);
    expect(within(s).getByRole("status").textContent).toBe(`Цены видео не прочитались при отправке${NBSP}— запросили их снова. Подтвердите ещё раз.`);
    expect(mainButton(s).textContent).toBe("Оживить 4 · до $3.06");
    expect(focusedLabel()).toBe("button «Отмена»");
  });


  test("MEDIUM: Nini's batch seen on Zoe's screen names Nini, and «отмените оставшиеся» opens NINI's «Клипы», not Zoe's", async () => {
    await ninisBatchSeenFromZoe();
    await clipsMode();
    fireEvent.click(pickFor("клипов", 1));
    await flush();
    expect(whyOf(bar())).toBe(`Сейчас снимаются клипы пакета Nini${NBSP}— дождитесь окончания или отмените оставшиеся.`);
    fireEvent.click(screen.getByRole("button", { name: "отмените оставшиеся" }));
    await flush();
    await flush();
    expect(screen.getByRole("heading", { level: 1, name: "Nini" })).toBeDefined();
    expect(screen.getByRole("tab", { name: /^Клипы/ }).getAttribute("aria-selected")).toBe("true");
    expect(within(batchHead()).getByRole("button", { name: "Отменить оставшиеся" })).toBeDefined();
  });
});

describe("37e: «Оживить» waits while a batch runs", () => {
});
