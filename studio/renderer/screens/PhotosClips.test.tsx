import { describe, expect, setSystemTime, test } from "bun:test";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { StrictMode } from "react";
import { MAX_LISTED_PHOTOS, CLIP_EXPORT_FAILED_RU, CLIP_FILE_DAMAGED_RU, CLIP_REASONS_RU, ERROR_MESSAGES_RU, PRICE_SCOPES_RU, type AvatarSummary, type PhotoSummary } from "../../shared/engine";
import { CLIP_RESTART_BANNER } from "../../shared/engine/clipRestartTexts";
import { App } from "../App";
import { MockEngine, mockEngineClient, type MockEngineOptions } from "../engine/mockEngine";
import { MIA, scenePhoto } from "../engine/mockEngine.testkit";
import { ManualScheduler } from "../engine/scheduler";
import { callsOf, describeElement, flush, focusedLabel, setup, tick } from "../testing";

// Stage 5, 5b.1, S5.V8 (plan s5b1 §6 states 37–46 and the VD2 variants; the mockups .omc/stage5/design/37-*.html … 46-*.html): «Оживить» in the photo viewer, the sheet, the «Клипы»
// tab and its tiles, the clip viewer with «Сохранить в папку», the delete, the queue row and the restart — against the mock, which answers what the engine answers. Every figure on screen is
// the engine's (`clips.options`, `clips.list`): the window computes no money.

const NINI: AvatarSummary = { ...MIA, avatarId: "avatar-nini-0001", name: "Nini", masterPhotoId: "photo-nini-master" };
/** Newest first in the gallery: the bold frame is «Фото 1 из 3», the one with no face score «Фото 2», the plain judged one «Фото 3». */
const PLAIN = scenePhoto(1, {}, NINI);
const HIDDEN = scenePhoto(2, {}, NINI);
const BOLD = scenePhoto(3, { category: "nightwear", route: "seedream" }, NINI);
const PHOTOS: PhotoSummary[] = [PLAIN, HIDDEN, BOLD];

const summary = (list: readonly PhotoSummary[]): AvatarSummary => ({ ...NINI, photoCount: list.length, eligibleUnusedCount: list.length });

async function openNini(options: MockEngineOptions = {}) {
  const photos = options.photos ?? PHOTOS;
  const h = setup({ avatars: [summary(photos)], photos, ...options });
  fireEvent.click(await screen.findByRole("button", { name: "Nini" }));
  await screen.findByRole("heading", { level: 1, name: "Nini" });
  await flush();
  return h;
}

const tabNames = (): string[] => screen.getAllByRole("tab").map((t) => t.textContent ?? "");
const clipsTab = (): HTMLElement => screen.getByRole("tab", { name: /^Клипы/ });
async function showClips(): Promise<void> {
  fireEvent.click(clipsTab());
  await flush();
}
const viewer = (): HTMLElement => screen.getByRole("dialog", { name: /^Фото \d+ из \d+$/ });
async function openPhoto(n: number, category = "Дом"): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: `Открыть фото ${n}: ${category}` }));
  await flush();
  return viewer();
}
const animateIn = (root: HTMLElement): HTMLElement => within(root).getByRole("button", { name: "Оживить" });
function whyOf(button: HTMLElement): string {
  const id = button.getAttribute("aria-describedby");
  return id === null ? "" : (document.getElementById(id)?.textContent ?? "");
}
const sheet = (): HTMLElement => screen.getByRole("dialog", { name: "Оживить фото" });
async function openSheet(n = 3, category = "Дом"): Promise<HTMLElement> {
  const v = await openPhoto(n, category);
  fireEvent.click(animateIn(v));
  await flush();
  return sheet();
}
const priceLine = (root: HTMLElement): string => root.querySelector(".clip-price-line")?.textContent ?? "";
const notes = (root: HTMLElement): string[] => Array.from(root.querySelectorAll(".clip-note")).map((n) => n.textContent ?? "");
const radio = (root: HTMLElement, name: string): HTMLElement => within(root).getByRole("radio", { name });
const tile = (name: RegExp | string): HTMLElement => screen.getByRole("article", { name });
const tilesNamed = (): string[] => screen.queryAllByRole("article").map((a) => a.getAttribute("aria-label") ?? "");
function runJobs(scheduler: ManualScheduler, steps = 400): void {
  tick(scheduler, steps);
}
async function animateFromSheet(s: HTMLElement, label = /^Оживить · до/): Promise<void> {
  fireEvent.click(within(s).getByRole("button", { name: label }));
  await flush();
  await flush();
}
const sidebarQueue = (): HTMLElement => screen.getByRole("region", { name: "Очередь" });

describe("the «Клипы» tab among the avatar's tabs (39, R-14)", () => {
  test("«Фото · Клипы · История сцен · Видео · Внешность», and the arrows go round the ones that work, «Клипы» included", async () => {
    await openNini();
    expect(tabNames()).toEqual(["Фото", "Клипы", "История сцен", "Видео", "Внешность"]);
    const photos = screen.getByRole("tab", { name: "Фото" });
    photos.focus();
    fireEvent.keyDown(photos, { key: "ArrowRight" });
    expect(clipsTab().getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement === clipsTab()).toBe(true);
    fireEvent.keyDown(clipsTab(), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Видео" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Видео" }), { key: "ArrowLeft" });
    expect(clipsTab().getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(clipsTab(), { key: "ArrowLeft" });
    expect(photos.getAttribute("aria-selected")).toBe("true");
  });

  test("a clip just started puts the focus on the tab's heading once; coming back to «Клипы» with → leaves it on the tab, and the arrows keep going", async () => {
    await openNini();
    await animateFromSheet(await openSheet());
    expect(document.activeElement === screen.getByRole("heading", { level: 2, name: "Клипы" })).toBe(true);
    const photos = screen.getByRole("tab", { name: "Фото" });
    fireEvent.click(photos);
    await flush();
    photos.focus();
    fireEvent.keyDown(photos, { key: "ArrowRight" });
    await flush();
    expect(clipsTab().getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement === clipsTab()).toBe(true);
    fireEvent.keyDown(clipsTab(), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Видео" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Видео" }), { key: "ArrowLeft" });
    fireEvent.keyDown(clipsTab(), { key: "ArrowLeft" });
    expect(photos.getAttribute("aria-selected")).toBe("true");
  });

  test("39: no clips yet — «Клипов пока нет» and «Откройте фото и нажмите «Оживить».», no count on the tab", async () => {
    await openNini();
    await showClips();
    expect(screen.getByRole("heading", { level: 2, name: "Клипы" })).toBeDefined();
    expect(screen.getByText("Клипов пока нет")).toBeDefined();
    expect(screen.getByText("Откройте фото и нажмите «Оживить».")).toBeDefined();
    expect(clipsTab().querySelector(".tab-new") === null).toBe(true);
  });
});

describe("37: «Оживить» in the photo viewer", () => {
  test("between «Выбрать для монтажа» and «Отклонить», opening a dialog", async () => {
    await openNini();
    const v = await openPhoto(3);
    const names = within(v.querySelector(".viewer-actions") as HTMLElement)
      .getAllByRole("button")
      .map((b) => b.textContent?.trim());
    expect(names.slice(0, 3)).toEqual(["Выбрать для монтажа", "Оживить", "Отклонить"]);
    expect(animateIn(v).getAttribute("aria-haspopup")).toBe("dialog");
    expect(animateIn(v).hasAttribute("disabled")).toBe(false);
  });

  test("37a: a frame whose face is not known to show waits, with the engine's reason under it", async () => {
    await openNini();
    const v = await openPhoto(2);
    const button = animateIn(v);
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(whyOf(button)).toBe("Для этого кадра движение не подобрать: лица не видно.");
  });

  test("37c: while paid calls wait for a reconcile — «Сначала сверка расходов»", async () => {
    const h = await openNini();
    act(() => h.engine.requireReconcile(["open-reserves"]));
    await flush();
    const button = animateIn(await openPhoto(3));
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(whyOf(button)).toBe("Сначала сверка расходов");
  });

  test("37c #nokey: without a key — «Нужен ключ OpenRouter — Настройки.», «Настройки» a link", async () => {
    await openNini({ apiKey: { stored: false, last4: null, encryptionAvailable: true, rejected: false } });
    const v = await openPhoto(3);
    const button = animateIn(v);
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(whyOf(button)).toBe("Нужен ключ OpenRouter — Настройки.");
    expect(within(v).getByRole("button", { name: "Настройки" })).toBeDefined();
  });

  test("37d: under `off` a frame of «Смелая» waits with «Кадры «Смелой» пока не оживляются.», the viewer still naming its model", async () => {
    await openNini({ clips: { boldClips: "off" } });
    const v = await openPhoto(1, "Ночнушки и бельё");
    expect(whyOf(animateIn(v))).toBe("Кадры «Смелой» пока не оживляются.");
    expect(within(v).getByText("Seedream 5 Pro · 2K")).toBeDefined();
  });

  test("37b: while another clip renders — «Сейчас снимается другой клип…», and the queue shows «Клип · Nini»", async () => {
    const h = await openNini();
    await animateFromSheet(await openSheet());
    // Two steps: sent, then rendering — the paid slot is held until the clip's money closes (I5.50).
    runJobs(h.scheduler, 2);
    await flush();
    fireEvent.click(screen.getByRole("tab", { name: "Фото" }));
    await flush();
    const button = animateIn(await openPhoto(3));
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(whyOf(button)).toBe(CLIP_REASONS_RU["one-at-a-time"]);
    expect(within(sidebarQueue()).getByText("Клип · Nini")).toBeDefined();
  });
});

/** The listing after Grok got dearer: in mode auto the worst case is Grok's reserve, so every ceiling moves. */
const GROK_DEARER = { std: { perSecondMicros: 84_000, perInputImageMicros: 0 }, pro: { perSecondMicros: 112_000, perInputImageMicros: 0 }, grok: { perSecondMicros: 160_000, perInputImageMicros: 10_000 } };

describe("38: the sheet «Оживить фото»", () => {
  test("the frame, the motions from the engine, quality, length, the model, the price line and the button at its ceiling (mode auto)", async () => {
    await openNini();
    const s = await openSheet();
    expect(within(s).getByText("Фото 3 из 3 · Дом")).toBeDefined();
    expect(within(s).getByText("первый кадр")).toBeDefined();
    const motions = within(s).getByRole("radiogroup", { name: "Движение" });
    expect(within(motions).getAllByRole("radio").map((r) => r.getAttribute("aria-label") ?? r.closest("label")?.textContent)).toEqual(["Моргает и улыбается", "Наклоняет голову", "Медленный вдох"]);
    expect((radio(s, "Моргает и улыбается") as HTMLInputElement).checked).toBe(true);
    expect((radio(s, "Обычное · 720p") as HTMLInputElement).checked).toBe(true);
    expect((radio(s, "5 секунд") as HTMLInputElement).checked).toBe(true);
    expect(within(s).getByText("Kling 3.0 · 720p")).toBeDefined();
    expect(priceLine(s)).toBe("Обычно $0.42 · не больше $0.85");
    expect(notes(s)).toEqual(["Если Kling откажет бесплатно, клип снимет Grok — поэтому «не больше». Оплаченный отказ сам не переснимается.", "Звука нет. Клип появится во вкладке «Клипы» через 1–3 минуты."]);
    expect(within(s).getByRole("button", { name: "Оживить · до $0.85" })).toBeDefined();
    expect(within(s).getByRole("button", { name: "Отмена" })).toBeDefined();
  });

  test("«Чётче · 1080p» names the model «Kling 3.0 · 1080p» with the 720p line of the fallback; «10 секунд» moves the price to the engine's", async () => {
    await openNini();
    const s = await openSheet();
    fireEvent.click(radio(s, "Чётче · 1080p"));
    expect(within(s).getByText("Kling 3.0 · 1080p")).toBeDefined();
    expect(within(s).getByText("Запасная модель (Grok) снимает в 720p")).toBeDefined();
    expect(priceLine(s)).toBe("Обычно $0.56 · не больше $0.85");
    fireEvent.click(radio(s, "10 секунд"));
    expect(priceLine(s)).toBe("Обычно $1.12 · не больше $1.55");
    expect(within(s).getByRole("button", { name: "Оживить · до $1.55" })).toBeDefined();
  });

  test("mode offer: «не больше $0.51», no Grok line", async () => {
    await openNini({ clips: { mode: "offer" } });
    const s = await openSheet();
    expect(priceLine(s)).toBe("Обычно $0.42 · не больше $0.51");
    expect(notes(s)).toEqual(["Звука нет. Клип появится во вкладке «Клипы» через 1–3 минуты."]);
    expect(within(s).getByRole("button", { name: "Оживить · до $0.51" })).toBeDefined();
  });

  test("«Оживить» sends ONE create at the price on show, then the «Клипы» tab shows the clip at work: «Готовим кадр» with «Отменить», then «Отправляем в Kling»", async () => {
    const h = await openNini();
    const s = await openSheet();
    const go = within(s).getByRole("button", { name: "Оживить · до $0.85" });
    fireEvent.click(go);
    fireEvent.click(go);
    await flush();
    await flush();
    const creates = callsOf(h.engine, "clips.create");
    expect(creates).toHaveLength(1);
    expect(creates[0]?.payload).toEqual({ avatarId: NINI.avatarId, photoId: PLAIN.photoId, motionId: "g-blink", model: "kling", quality: "std", seconds: 5, fallback: "auto", acceptedWorstMicros: 850_000 });
    expect(screen.queryByRole("dialog") === null).toBe(true);
    expect(clipsTab().getAttribute("aria-selected")).toBe("true");
    const work = tile("Клип в работе: Моргает и улыбается");
    expect(within(work).getByRole("status").textContent).toBe("Готовим кадр");
    expect(within(work).getByText("в работе")).toBeDefined();
    expect(within(work).getByText("до $0.85")).toBeDefined();
    expect(within(work).getByRole("button", { name: "Отменить" })).toBeDefined();
    tick(h.scheduler);
    await flush();
    expect(within(tile("Клип в работе: Моргает и улыбается")).getByRole("status").textContent).toBe("Отправляем в Kling");
    expect(within(tile("Клип в работе: Моргает и улыбается")).queryByRole("button", { name: "Отменить" }) === null).toBe(true);
    expect(within(sidebarQueue()).getByText("Отправляем")).toBeDefined();
  });

  test("«Отменить» before the submit cancels the clip for free: the tile goes", async () => {
    const h = await openNini();
    await animateFromSheet(await openSheet());
    fireEvent.click(within(tile("Клип в работе: Моргает и улыбается")).getByRole("button", { name: "Отменить" }));
    await flush();
    expect(callsOf(h.engine, "avatars.cancel")).toHaveLength(1);
    runJobs(h.scheduler, 5);
    await flush();
    expect(screen.queryByRole("article", { name: /Клип в работе/ }) === null).toBe(true);
    expect(h.engine.peekClips().posts).toEqual([]);
  });

  test("38b: PRICE_CHANGED asks the engine again and says the new ceiling; the click needs to come again", async () => {
    const h = await openNini();
    const s = await openSheet();
    expect(priceLine(s)).toBe("Обычно $0.42 · не больше $0.85");
    // The listing moved after the sheet was read: the click accepts $0.85, the engine's worst is now higher.
    h.engine.setClipRates(GROK_DEARER);
    await animateFromSheet(s);
    expect(priceLine(sheet())).not.toContain("$0.85");
    const worst = /не больше (\$[\d.]+)/.exec(priceLine(sheet()))?.[1] ?? "";
    expect(worst).not.toBe("");
    expect(within(sheet()).getByText(/Цена изменилась: теперь не больше/).textContent).toBe(`Цена изменилась: теперь не больше ${worst}. Подтвердите ещё раз.`);
    expect(within(sheet()).getByRole("button", { name: `Оживить · до ${worst}` })).toBeDefined();
    expect(callsOf(h.engine, "clips.options").length).toBeGreaterThanOrEqual(2);
    expect(callsOf(h.engine, "clips.create")).toHaveLength(1);
    fireEvent.click(radio(sheet(), "10 секунд"));
    expect(within(sheet()).queryByText(/Цена изменилась/) === null).toBe(true);
  });

  test("38b: while the new price is read the figures on show stay, the main button keeps the focus and a click on it sends nothing; the new figure comes with the focus still there", async () => {
    const h = await openNini();
    const s = await openSheet();
    h.engine.setClipRates(GROK_DEARER);
    h.engine.delayNext("clips.options", 50);
    const go = within(s).getByRole("button", { name: "Оживить · до $0.85" });
    go.focus();
    fireEvent.click(go);
    await flush();
    await flush();
    expect(callsOf(h.engine, "clips.create")).toHaveLength(1);
    // The re-read is on its way: the old figures stay, nothing under the focus turns off.
    const main = within(sheet()).getByRole("button", { name: "Оживить · до $0.85" });
    expect(main.hasAttribute("disabled")).toBe(false);
    expect(main.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement === main).toBe(true);
    fireEvent.click(main);
    await flush();
    expect(callsOf(h.engine, "clips.create")).toHaveLength(1);
    tick(h.scheduler, 3);
    await flush();
    await flush();
    const worst = /не больше (\$[\d.]+)/.exec(priceLine(sheet()))?.[1] ?? "";
    expect(worst).not.toBe("$0.85");
    const fresh = within(sheet()).getByRole("button", { name: `Оживить · до ${worst}` });
    expect(fresh.getAttribute("aria-disabled")).not.toBe("true");
    expect(document.activeElement === fresh).toBe(true);
    expect(within(sheet()).getByText(/Цена изменилась: теперь не больше/).textContent).toBe(`Цена изменилась: теперь не больше ${worst}. Подтвердите ещё раз.`);
  });

  test("38c: the month holds Kling alone — «Оживить» waits, the notice says what the clip needs, «Оживить без запасной модели · до $0.51» sends fallback none", async () => {
    const h = await openNini({ money: { spentMicros: 9_400_000, monthlyBudgetMicros: 10_000_000 } });
    const s = await openSheet();
    const main = within(s).getByRole("button", { name: "Оживить · до $0.85" });
    expect(main.hasAttribute("disabled")).toBe(true);
    expect(within(s).getByText(/Не хватает месячного бюджета/).textContent).toBe("Не хватает месячного бюджета: клипу нужно до $0.85. Бюджет — в Настройках.");
    // The approved 38c draws it without a full stop (README §S5.VD decision 14).
    expect(notes(s)).toContain("Если Kling откажет, Grok снимать не будем");
    await animateFromSheet(s, /^Оживить без запасной модели · до \$0\.51$/);
    expect(callsOf(h.engine, "clips.create")[0]?.payload).toMatchObject({ fallback: "none", acceptedWorstMicros: 504_000 });
  });

  test("38e: a frame of «Смелая» — Kling alone in both modes, the line about no fallback in place of the Grok line", async () => {
    await openNini();
    const s = await openSheet(1, "Ночнушки и бельё");
    expect(within(s).getByText("Фото 1 из 3 · Ночнушки и бельё")).toBeDefined();
    expect(within(s).getByText("Kling 3.0 · 720p")).toBeDefined();
    expect(priceLine(s)).toBe("Обычно $0.42 · не больше $0.51");
    expect(notes(s)).toEqual(["Для кадров «Смелой» запасной модели нет: если Kling откажет, клип не снимется — отказ бесплатный.", "Звука нет. Клип появится во вкладке «Клипы» через 1–3 минуты."]);
    expect(within(s).queryByRole("button", { name: /без запасной модели/ }) === null).toBe(true);
    fireEvent.click(radio(s, "Чётче · 1080p"));
    expect(within(s).queryByText("Запасная модель (Grok) снимает в 720p") === null).toBe(true);
    expect(priceLine(s)).toBe("Обычно $0.56 · не больше $0.68");
  });

  test("38f: the video prices cannot be read — the notice in the form's place, «Цена —», «Оживить» waits described by it", async () => {
    const h = await openNini();
    h.engine.setVideoPrices("missing");
    const s = await openSheet();
    expect(within(s).getByText(PRICE_SCOPES_RU.video)).toBeDefined();
    expect(priceLine(s)).toBe("—");
    const go = within(s).getByRole("button", { name: "Оживить" });
    expect(go.hasAttribute("disabled")).toBe(true);
    expect(whyOf(go)).toContain(PRICE_SCOPES_RU.video);
    expect(within(s).queryByRole("radiogroup") === null).toBe(true);
  });

  test("«Отмена» closes the sheet and the viewer is there again, the focus back on «Оживить»", async () => {
    await openNini();
    const s = await openSheet();
    fireEvent.click(within(s).getByRole("button", { name: "Отмена" }));
    await flush();
    expect(screen.queryByRole("dialog", { name: "Оживить фото" }) === null).toBe(true);
    expect(focusedLabel()).toBe(describeElement(animateIn(viewer())));
  });

  test("Escape closes the sheet only, never the viewer under it", async () => {
    await openNini();
    await openSheet();
    fireEvent.keyDown(document.activeElement ?? window, { key: "Escape" });
    await flush();
    expect(screen.queryByRole("dialog", { name: "Оживить фото" }) === null).toBe(true);
    expect(viewer()).toBeDefined();
  });
});

describe("StrictMode", () => {
  test("one click on «Оживить · до $0.85» sends exactly one create", async () => {
    const scheduler = new ManualScheduler();
    const engine = new MockEngine({ scheduler, latencyMs: 0, avatars: [summary(PHOTOS)], photos: PHOTOS });
    render(
      <StrictMode>
        <App client={mockEngineClient(engine)} />
      </StrictMode>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Nini" }));
    await screen.findByRole("heading", { level: 1, name: "Nini" });
    await flush();
    await animateFromSheet(await openSheet());
    expect(callsOf(engine, "clips.create")).toHaveLength(1);
  });
});

describe("40–42: the tiles", () => {
  test("41: a clip that came — the poster, «0:05», «новый», «лицо 0.86», «$0.42», and the tab's count «, новых: 1»", async () => {
    const h = await openNini();
    await animateFromSheet(await openSheet());
    runJobs(h.scheduler, 60);
    await flush();
    await flush();
    const ready = tile("Клип: Моргает и улыбается");
    expect(within(ready).getByText("новый")).toBeDefined();
    expect(within(ready).getByText("лицо 0.86")).toBeDefined();
    expect(within(ready).getByText("0:05")).toBeDefined();
    expect(within(ready).getByText(/^\$0\.42 · /)).toBeDefined();
    expect(within(ready).getByRole("button", { name: "Открыть клип «Моргает и улыбается», 0:05" })).toBeDefined();
    expect(clipsTab().textContent).toBe("Клипы1, новых: 1");
    expect(within(sidebarQueue()).queryByText("Клип · Nini") === null).toBe(true);
  });

  test("40: the phases as they come, «Снимается · m:ss» counting, the steps filling", async () => {
    const h = await openNini();
    await animateFromSheet(await openSheet());
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const work = screen.queryByRole("article", { name: "Клип в работе: Моргает и улыбается" });
      if (work === null) break;
      seen.add((within(work).getByRole("status").textContent ?? "").replace(/\d+:\d\d/, "m:ss"));
      tick(h.scheduler);
      await flush();
    }
    expect([...seen]).toEqual(["Готовим кадр", "Отправляем в Kling", "Снимается · m:ss", "Скачивается", "Проверяем лицо", "Сохраняем"]);
  });

  test("40 #late: «Задерживается. Клип ещё может прийти до HH:MM — потом понадобится сверка расходов.»", async () => {
    const h = await openNini();
    h.engine.scriptNextClip("late");
    await animateFromSheet(await openSheet());
    for (let i = 0; i < 20 && screen.queryByText(/^Задерживается\./) === null; i++) {
      tick(h.scheduler);
      await flush();
    }
    const work = tile("Клип в работе: Моргает и улыбается");
    expect(within(work).getByRole("status").textContent).toMatch(/^Задерживается\. Клип ещё может прийти до \d\d:\d\d — потом понадобится сверка расходов\.$/);
    expect(within(work).getByText("задерживается")).toBeDefined();
    expect(within(sidebarQueue()).getByText("Задерживается")).toBeDefined();
  });

  test("42a: Kling and Grok both refused for free — «Kling и Grok отказали — бесплатно», «Оживить снова…» opens the sheet again, the trash removes the tile at once", async () => {
    const h = await openNini();
    h.engine.scriptNextClip({ first: "refused-free", then: "refused-free" });
    await animateFromSheet(await openSheet());
    runJobs(h.scheduler, 80);
    await flush();
    await flush();
    const failed = tile("Клип не получился: Моргает и улыбается");
    expect(within(failed).getByText("Kling и Grok отказали — бесплатно")).toBeDefined();
    fireEvent.click(within(failed).getByRole("button", { name: "Оживить снова…" }));
    await flush();
    expect(within(sheet()).getByText("Фото 3 из 3 · Дом")).toBeDefined();
    fireEvent.click(within(sheet()).getByRole("button", { name: "Отмена" }));
    await flush();
    fireEvent.click(within(tile("Клип не получился: Моргает и улыбается")).getByRole("button", { name: "Удалить клип «Моргает и улыбается»" }));
    await flush();
    await flush();
    expect(callsOf(h.engine, "clips.delete")).toHaveLength(1);
    expect(screen.queryByRole("dialog") === null).toBe(true);
    expect(screen.queryByRole("article", { name: /Клип не получился/ }) === null).toBe(true);
  });

  test("42n then 42r (mode offer): «Снять на Grok · до $0.85» sends a Grok create at the engine's own price; Grok's free refusal offers «Оживить снова…», never Grok again", async () => {
    const h = await openNini({ clips: { mode: "offer" } });
    h.engine.scriptNextClip("refused-free");
    await animateFromSheet(await openSheet());
    runJobs(h.scheduler, 80);
    await flush();
    await flush();
    const offered = tile("Клип не получился: Моргает и улыбается");
    expect(within(offered).getByText("Kling отказал бесплатно")).toBeDefined();
    expect(within(offered).queryByRole("button", { name: "Оживить снова…" }) === null).toBe(true);
    h.engine.scriptNextClip("refused-free");
    fireEvent.click(within(offered).getByRole("button", { name: "Снять на Grok · до $0.85" }));
    await flush();
    await flush();
    const grok = callsOf(h.engine, "clips.create").at(-1);
    expect(grok?.payload).toMatchObject({ model: "grok", fallback: "none", motionId: "g-blink", seconds: 5, acceptedWorstMicros: 850_000 });
    tick(h.scheduler);
    await flush();
    expect(within(screen.getAllByRole("article", { name: "Клип в работе: Моргает и улыбается" })[0] as HTMLElement).getByRole("status").textContent).toBe("Отправляем в Grok");
    runJobs(h.scheduler, 80);
    await flush();
    await flush();
    const refused = screen.getAllByRole("article", { name: "Клип не получился: Моргает и улыбается" }).find((a) => within(a).queryByText("Grok отказал бесплатно") !== null);
    expect(refused).toBeDefined();
    expect(within(refused as HTMLElement).getByRole("button", { name: "Оживить снова…" })).toBeDefined();
    expect(within(refused as HTMLElement).queryByRole("button", { name: /Снять на Grok/ }) === null).toBe(true);
  });

  test("42d: an uncertain submit — «Неизвестно, оплачено ли — сверка покажет» with «до $0.51 — спишется при сверке», no retry", async () => {
    const h = await openNini();
    h.engine.scriptNextClip("uncertain");
    await animateFromSheet(await openSheet());
    runJobs(h.scheduler, 10);
    await flush();
    await flush();
    const failed = tile("Клип не получился: Моргает и улыбается");
    expect(within(failed).getByText("Неизвестно, оплачено ли — сверка покажет")).toBeDefined();
    expect(within(failed).getByText("до $0.51 — спишется при сверке")).toBeDefined();
    expect(within(failed).queryAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["Удалить клип «Моргает и улыбается»"]);
  });

  test("42q: a frame of «Смелая» refused for free — no fallback for it, «Оживить снова…» opens its own sheet", async () => {
    const h = await openNini();
    h.engine.scriptNextClip("refused-free");
    await animateFromSheet(await openSheet(1, "Ночнушки и бельё"));
    runJobs(h.scheduler, 80);
    await flush();
    await flush();
    const failed = tile("Клип не получился: Моргает и улыбается");
    expect(within(failed).getByText("Kling отказал бесплатно — для кадров «Смелой» запасной модели нет")).toBeDefined();
    fireEvent.click(within(failed).getByRole("button", { name: "Оживить снова…" }));
    await flush();
    expect(within(sheet()).getByText("Фото 1 из 3 · Ночнушки и бельё")).toBeDefined();
    expect(priceLine(sheet())).toBe("Обычно $0.42 · не больше $0.51");
  });

  test("a clip job that ended with no record (its reserve refused before anything was sent) is still shown to the owner, free, and can be put away", async () => {
    const h = await openNini();
    await animateFromSheet(await openSheet());
    act(() => h.engine.requireReconcile(["open-reserves"]));
    tick(h.scheduler);
    await flush();
    await flush();
    const failed = tile("Клип не получился: Моргает и улыбается");
    expect(within(failed).getByText("Клип не снят")).toBeDefined();
    expect(within(failed).getByText(ERROR_MESSAGES_RU.RECONCILE_REQUIRED)).toBeDefined();
    fireEvent.click(within(failed).getByRole("button", { name: "Убрать «Моргает и улыбается»" }));
    await flush();
    expect(screen.queryByRole("article", { name: /Клип не получился/ }) === null).toBe(true);
    expect(callsOf(h.engine, "clips.delete")).toHaveLength(0);
  });

  test("a «Клип не снят» tile put away stays away after the tab is left and come back to", async () => {
    const h = await openNini();
    await animateFromSheet(await openSheet());
    act(() => h.engine.requireReconcile(["open-reserves"]));
    tick(h.scheduler);
    await flush();
    await flush();
    fireEvent.click(within(tile("Клип не получился: Моргает и улыбается")).getByRole("button", { name: "Убрать «Моргает и улыбается»" }));
    await flush();
    expect(screen.queryByRole("article", { name: /Клип не получился/ }) === null).toBe(true);
    fireEvent.click(screen.getByRole("tab", { name: "Фото" }));
    await flush();
    await showClips();
    expect(screen.queryByRole("article", { name: /Клип не получился/ }) === null).toBe(true);
  });

  test("a ready clip whose poster file is missing shows the placeholder, not a broken picture", async () => {
    const scheduler = new ManualScheduler();
    const engine = new MockEngine({ scheduler, latencyMs: 0, avatars: [summary(PHOTOS)], photos: PHOTOS });
    engine.seedClips(NINI.avatarId, 1);
    const client = { ...mockEngineClient(engine), kind: "window" as const };
    render(<App client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Nini" }));
    await screen.findByRole("heading", { level: 1, name: "Nini" });
    await flush();
    await showClips();
    const ready = screen.getAllByRole("article")[0] as HTMLElement;
    const img = ready.querySelector("img.clip-poster-img");
    expect(img).not.toBeNull();
    fireEvent.error(img as Element);
    await flush();
    expect(ready.querySelector("img.clip-poster-img") === null).toBe(true);
    expect(ready.querySelector(".portrait-placeholder")).not.toBeNull();
  });
});

describe("43: the clip viewer and «Сохранить в папку»", () => {
  async function readyClip() {
    const h = await openNini();
    await animateFromSheet(await openSheet());
    runJobs(h.scheduler, 60);
    await flush();
    await flush();
    fireEvent.click(within(tile("Клип: Моргает и улыбается")).getByRole("button", { name: "Открыть клип «Моргает и улыбается», 0:05" }));
    await flush();
    await flush();
    return h;
  }
  const clipViewer = (): HTMLElement => screen.getByRole("dialog", { name: /^Клип \d+ из \d+$/ });
  const fact = (dt: string): string => {
    const term = within(clipViewer()).getByText(dt, { selector: "dt" });
    return term.nextElementSibling?.textContent ?? "";
  };

  test("its facts: from which photo, the motion, the model, the cost, the face; opening it marks it seen", async () => {
    const h = await readyClip();
    expect(clipViewer().getAttribute("aria-label") ?? within(clipViewer()).getByRole("heading", { level: 2 }).textContent).toBe("Клип 1 из 1");
    expect(fact("Из фото")).toBe("Фото 3 · Дом");
    expect(fact("Движение")).toBe("Моргает и улыбается");
    expect(fact("Модель")).toBe("Kling 3.0 · 720p · 5 с");
    expect(fact("Стоимость")).toBe("$0.42");
    expect(fact("Лицо")).toBe("0.86 (по 10 кадрам)");
    expect(callsOf(h.engine, "clips.markSeen")).toHaveLength(1);
    expect(clipsTab().querySelector(".tab-new") === null).toBe(true);
    expect(within(clipViewer()).getByText("без звука · по кругу")).toBeDefined();
  });

  test("«Сохранить в папку»: «Сохраняем…» holding the focus, «Сохраняем · N %» past 2 s, then 43a with the claimed name and what the file is", async () => {
    const h = await readyClip();
    const save = within(clipViewer()).getByRole("button", { name: "Сохранить в папку" });
    save.focus();
    fireEvent.click(save);
    await flush();
    expect(callsOf(h.engine, "clips.export")).toHaveLength(1);
    const busy = within(clipViewer()).getByRole("button", { name: "Сохраняем…" });
    expect(busy === save).toBe(true);
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    expect(busy.hasAttribute("disabled")).toBe(false);
    expect(document.activeElement === busy).toBe(true);
    fireEvent.click(busy);
    await flush();
    expect(callsOf(h.engine, "clips.export")).toHaveLength(1);
    expect(within(sidebarQueue()).getByText("Клип · Nini")).toBeDefined();
    tick(h.scheduler, 2);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_100));
    });
    expect(within(clipViewer()).getByRole("button", { name: /^Сохраняем · \d+\u00a0%$/ }) === save).toBe(true);
    const bar = within(clipViewer()).getByRole("progressbar", { name: "Сохранение клипа в папку" });
    expect(Number(bar.getAttribute("aria-valuenow"))).toBeGreaterThan(0);
    expect(within(sidebarQueue()).getByText(/^Сохраняем \d+\s?%$/)).toBeDefined();
    tick(h.scheduler, 10);
    await flush();
    await flush();
    const saved = within(clipViewer()).getByText(/^Сохранено:/);
    expect(saved.textContent).toMatch(/^Сохранено: export \/ Nini \/ \d{4}-\d\d-\d\d_clip_001\.mp4/);
    expect(within(clipViewer()).getByText("1080 × 1920 · 30 к/с · метаданные очищены")).toBeDefined();
    fireEvent.click(within(clipViewer()).getByRole("button", { name: "Показать в Finder" }));
    await flush();
    expect(callsOf(h.engine, "clips.reveal")).toHaveLength(1);
    expect(h.engine.revealedClips).toHaveLength(1);
  });

  test("43c: the encode failed — «Не удалось сохранить клип в папку — файл в Studio цел. Попробуйте ещё раз.», and «Сохранить в папку» again", async () => {
    const h = await readyClip();
    h.engine.nextClipExport("fail");
    fireEvent.click(within(clipViewer()).getByRole("button", { name: "Сохранить в папку" }));
    await flush();
    tick(h.scheduler, 4);
    await flush();
    await flush();
    expect(within(clipViewer()).getByRole("alert").textContent).toBe(CLIP_EXPORT_FAILED_RU);
    expect(within(clipViewer()).getByRole("button", { name: "Сохранить в папку" }).getAttribute("aria-disabled")).not.toBe("true");
  });

  test("43c′: the clip's file in Studio is damaged — «Файл клипа в Studio повреждён или не читается — сохранить его в папку нельзя.», not «файл в Studio цел»", async () => {
    const h = await readyClip();
    h.engine.nextClipExport("damaged");
    fireEvent.click(within(clipViewer()).getByRole("button", { name: "Сохранить в папку" }));
    await flush();
    tick(h.scheduler, 4);
    await flush();
    await flush();
    const alert = within(clipViewer()).getByRole("alert");
    expect(alert.textContent).toBe("Файл клипа в Studio повреждён или не читается — сохранить его в папку нельзя.");
    expect(alert.textContent).toBe(CLIP_FILE_DAMAGED_RU);
    expect(alert.textContent).not.toContain("цел");
  });

  test("43b: the export folder cannot take it — the app's own words and «Открыть папку в Настройках»", async () => {
    const h = await readyClip();
    h.engine.setExportDisk({ status: "unavailable", reason: "missing" });
    fireEvent.click(within(clipViewer()).getByRole("button", { name: "Сохранить в папку" }));
    await flush();
    await flush();
    expect(within(clipViewer()).getByText("Папка «Готовые видео» недоступна")).toBeDefined();
    expect(within(clipViewer()).getByText("Папка не найдена.")).toBeDefined();
    expect(within(clipViewer()).getByRole("button", { name: "Открыть папку в Настройках" })).toBeDefined();
  });

  test("44: «Удалить» asks first; over a clip never saved the text says there is no copy; «Удалить» removes it", async () => {
    const h = await readyClip();
    fireEvent.click(within(clipViewer()).getByRole("button", { name: "Удалить" }));
    await flush();
    const ask = screen.getByRole("alertdialog", { name: "Удалить клип?" });
    expect(within(ask).getByText("Файл клипа удалится из Studio. Копии в «Готовые видео» нет — если клип нужен, сначала сохраните его в папку. Деньги за него уже потрачены.")).toBeDefined();
    fireEvent.click(within(ask).getByRole("button", { name: "Отмена" }));
    await flush();
    expect(screen.queryByRole("alertdialog") === null).toBe(true);
    expect(clipViewer()).toBeDefined();
    fireEvent.click(within(clipViewer()).getByRole("button", { name: "Удалить" }));
    await flush();
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "Удалить клип?" })).getByRole("button", { name: "Удалить" }));
    await flush();
    await flush();
    expect(callsOf(h.engine, "clips.delete")).toHaveLength(1);
    expect(screen.queryByRole("dialog") === null).toBe(true);
    expect(tilesNamed()).toEqual([]);
    // Its tile is gone with it: the focus waits on the tab's heading, never on the page.
    expect(focusedLabel()).toBe(describeElement(screen.getByRole("heading", { level: 2, name: "Клипы" })));
  });

  test("44 over a saved clip: «Копия в «Готовые видео» останется.»", async () => {
    const h = await readyClip();
    fireEvent.click(within(clipViewer()).getByRole("button", { name: "Сохранить в папку" }));
    await flush();
    tick(h.scheduler, 10);
    await flush();
    await flush();
    fireEvent.click(within(clipViewer()).getByRole("button", { name: "Удалить" }));
    await flush();
    expect(within(screen.getByRole("alertdialog", { name: "Удалить клип?" })).getByText("Файл клипа удалится из Studio. Копия в «Готовые видео» останется. Деньги за него уже потрачены.")).toBeDefined();
  });

  test("«Из фото» opens the photo in the photo viewer", async () => {
    await readyClip();
    fireEvent.click(within(clipViewer()).getByRole("button", { name: "Фото 3 · Дом" }));
    await flush();
    expect(screen.getByRole("dialog", { name: "Фото 3 из 3" })).toBeDefined();
  });
});

describe("43d: the clip viewer keeps nothing of the clip it left", () => {
  /** Two ready clips of Nini's library (no photo of them in the gallery), the newest open. */
  async function openSeeded() {
    const h = setup({ avatars: [summary(PHOTOS)], photos: PHOTOS });
    h.engine.seedClips(NINI.avatarId, 2);
    fireEvent.click(await screen.findByRole("button", { name: "Nini" }));
    await screen.findByRole("heading", { level: 1, name: "Nini" });
    await flush();
    await showClips();
    openTile(0);
    await flush();
    await flush();
    return h;
  }
  const openTile = (n: number): void => {
    const opens = screen.getAllByRole("button", { name: /^Открыть клип/ });
    const target = opens[n];
    if (target === undefined) throw new Error(`no tile ${n}`);
    fireEvent.click(target);
  };
  const clipViewer = (): HTMLElement => screen.getByRole("dialog", { name: /^Клип \d+ из \d+$/ });
  const saveButton = (): HTMLElement => within(clipViewer()).getByRole("button", { name: /^Сохран/ });
  const news = (): string => clipViewer().querySelector("p[aria-live='polite']")?.textContent ?? "";
  async function step(key: "ArrowLeft" | "ArrowRight"): Promise<void> {
    fireEvent.keyDown(window, { key });
    await flush();
    await flush();
  }

  // There is no command for one photo by id, and the photo viewer closes on a photo the pages read do not hold: so a source photo beyond the pages read cannot be opened from here, and
  // the line says where it is instead of offering a button that would do nothing.
  test("a source photo beyond the pages read is named as being in the gallery, with no button that would open nothing", async () => {
    const many = Array.from({ length: MAX_LISTED_PHOTOS + 1 }, (_, i) => scenePhoto(i + 1, {}, NINI));
    const h = setup({ avatars: [summary(many)], photos: many });
    h.engine.seedClips(NINI.avatarId, 1);
    fireEvent.click(await screen.findByRole("button", { name: "Nini" }));
    await screen.findByRole("heading", { level: 1, name: "Nini" });
    await flush();
    await showClips();
    openTile(0);
    await flush();
    await flush();
    const source = within(clipViewer()).getByText("Из фото", { selector: "dt" }).nextElementSibling;
    expect(source?.textContent).toBe("исходное фото — в галерее");
    expect(source?.querySelector("button") === null).toBe(true);
  });

  test("a refusal shown on one clip is gone under the next one", async () => {
    const h = await openSeeded();
    h.engine.failNext("clips.export", { code: "INTERNAL", detail: "the disk said no" });
    fireEvent.click(saveButton());
    await flush();
    expect(clipViewer().querySelector(".viewer-error") === null).toBe(false);
    await step("ArrowRight");
    expect(within(clipViewer()).getByRole("heading", { level: 2 }).textContent).toBe("Клип 2 из 2");
    expect(clipViewer().querySelector(".viewer-error") === null).toBe(true);
  });

  test("a folder that refused the save and is back lets «Сохранить в папку» work again, on any clip", async () => {
    const h = await openSeeded();
    h.engine.setExportDisk({ status: "unavailable", reason: "missing" });
    fireEvent.click(saveButton());
    await flush();
    await flush();
    expect(saveButton().getAttribute("aria-disabled")).toBe("true");
    h.engine.setExportDisk({ status: "ok" });
    await act(async () => {
      await h.client.request("export.check", {});
    });
    await flush();
    expect(within(clipViewer()).queryByText("Папка «Готовые видео» недоступна") === null).toBe(true);
    expect(saveButton().getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(saveButton());
    await flush();
    expect(callsOf(h.engine, "clips.export")).toHaveLength(2);
  });

  test("opening a clip whose export finished earlier says nothing", async () => {
    const h = await openSeeded();
    fireEvent.click(saveButton());
    await flush();
    tick(h.scheduler, 10);
    await flush();
    await flush();
    expect(news()).toBe("Клип сохранён в папку.");
    fireEvent.click(within(clipViewer()).getByRole("button", { name: "Закрыть" }));
    await flush();
    openTile(0);
    await flush();
    await flush();
    expect(within(clipViewer()).getByText(/^Сохранено:/)).toBeDefined();
    expect(news()).toBe("");
  });

  test("stepping onto a clip does not carry the last clip's news along, nor its «Сохраняем…»", async () => {
    const h = await openSeeded();
    fireEvent.click(saveButton());
    await flush();
    tick(h.scheduler, 10);
    await flush();
    await flush();
    await step("ArrowRight");
    expect(news()).toBe("");
    await step("ArrowLeft");
    expect(news()).toBe("");
  });
});

describe("a deleted clip does not come back as a «Сохраняем» tile", () => {
  test("create X, delete it, export Y: while the list is read again after the export, X has no tile and nothing is announced for it", async () => {
    const h = setup({ avatars: [summary(PHOTOS)], photos: PHOTOS });
    h.engine.seedClips(NINI.avatarId, 1);
    fireEvent.click(await screen.findByRole("button", { name: "Nini" }));
    await screen.findByRole("heading", { level: 1, name: "Nini" });
    await flush();
    await animateFromSheet(await openSheet());
    runJobs(h.scheduler, 60);
    await flush();
    await flush();
    // X (the one made now, the newest) is deleted from its viewer.
    const newest = screen.getAllByRole("button", { name: /^Открыть клип/ })[0];
    if (newest === undefined) throw new Error("no clip tile");
    fireEvent.click(newest);
    await flush();
    await flush();
    const viewerOf = (): HTMLElement => screen.getByRole("dialog", { name: /^Клип \d+ из \d+$/ });
    fireEvent.click(within(viewerOf()).getByRole("button", { name: "Удалить" }));
    await flush();
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "Удалить клип?" })).getByRole("button", { name: "Удалить" }));
    await flush();
    await flush();
    expect(tilesNamed()).toHaveLength(1);
    // Y (the seeded one) is exported; the list read after the export ends is slow.
    fireEvent.click(screen.getByRole("button", { name: /^Открыть клип/ }));
    await flush();
    await flush();
    fireEvent.click(within(viewerOf()).getByRole("button", { name: "Сохранить в папку" }));
    await flush();
    await flush();
    h.engine.delayNext("clips.list", 1_000_000);
    const listsBefore = callsOf(h.engine, "clips.list").length;
    for (let i = 0; i < 30 && callsOf(h.engine, "clips.list").length === listsBefore; i++) {
      tick(h.scheduler, 1);
      await flush();
    }
    expect(callsOf(h.engine, "clips.list").length).toBeGreaterThan(listsBefore);
    fireEvent.click(within(viewerOf()).getByRole("button", { name: "Закрыть" }));
    await flush();
    expect(screen.queryAllByRole("article", { name: /Клип в работе/ })).toHaveLength(0);
    expect(screen.queryAllByText("Сохраняем")).toHaveLength(0);
  });
});

describe("46: after a restart", () => {
  test("a clip in work when Studio closed: the recovery tile, one banner with the clip's line and no «Перейти к сверке», then the recovered clip «до сверки»", async () => {
    const h = await openNini();
    await animateFromSheet(await openSheet());
    // Sent and rendering when Studio closes: the restart's recovery job polls the provider for it.
    tick(h.scheduler, 2);
    await flush();
    // The window reads `reconcileAvailableAt` against its own clock, which is the engine's on one machine: here the mock's.
    setSystemTime(new Date(h.engine.peekClips().nowMs));
    try {
      act(() => h.engine.restart());
      await flush();
      await flush();
      const recovering = screen.getByRole("article", { name: /^Клип в работе/ });
      expect(within(recovering).getByRole("status").textContent).toBe("Восстанавливаем после перезапуска");
      expect(within(recovering).getByText("после перезапуска")).toBeDefined();
      expect(screen.getByText("Нужна сверка расходов")).toBeDefined();
      // 46 #held: a clip that was rendering may still bill for up to an hour after its submit (I5.48), far past the restart's own minutes: the banner says until when.
      expect(screen.getByText(/^Сверка ждёт окончания клипа — до \d\d:\d\d\.$/)).toBeDefined();
      expect(screen.queryByText(CLIP_RESTART_BANNER) === null).toBe(true);
      expect(screen.queryByRole("button", { name: "Перейти к сверке" }) === null).toBe(true);
      expect(within(sidebarQueue()).getByText("Восстановление")).toBeDefined();
      runJobs(h.scheduler, 40);
      await flush();
      await flush();
      const recovered = screen.getAllByRole("article").find((a) => a.textContent?.includes("Клип восстановлен после перезапуска"));
      expect(recovered?.textContent).toContain("Клип восстановлен после перезапуска · до сверки: $0.51 (OpenRouter: $0.42)");
    } finally {
      setSystemTime();
    }
  });
});
