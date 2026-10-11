import { describe, expect, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { ERROR_MESSAGES_RU } from "../../shared/engine";
import type { EngineClient } from "../engine/client";
import { MIA } from "../engine/mockEngine.testkit";
import { asAnotherWindow } from "./montage/screenKit";
import { library, meterPhotosList, moreButton, openGallery, press, tileOf, tiles } from "./photos/moreScreenKit";
import { ManualScheduler } from "../engine/scheduler";
import { describeElement, flush, focusedLabel, openSection, runAll, tick } from "../testing";

// S4.P2 fix round: the gallery's reads under load and in each other's way. One read of photos.list at a time; a reason to read again
// that comes meanwhile is kept and read once after it (MEDIUM-1); a run's new photos read only the top (MEDIUM-1 c); «Показать ещё»
// and a re-read never cross (MEDIUM-3). Focus is asserted through `describeElement`: a failed element comparison prints the page.

/** Another window marks Mia's photo `n` «do not use»: `avatar.changed` follows. */
const reject = (client: EngineClient, n: number) =>
  asAnotherWindow(() => client.request("photos.setRejected", { avatarId: MIA.avatarId, photoId: `photo-mia-${String(n).padStart(4, "0")}`, rejected: true }));

/**
 * The gallery on a manual clock for the re-read wait too (LOW-D): no test here waits in real time for the 400 ms the hook leaves after a
 * read. `elapse` lets that wait pass; it is called from inside a `waitFor`, so the wait passes exactly when a read has ended and set it.
 */
async function openOnManualClock(photos: Parameters<typeof openGallery>[0]) {
  const pagesScheduler = new ManualScheduler();
  const harness = await openGallery(photos, { pagesScheduler });
  return { ...harness, pagesScheduler };
}

const elapse = (pagesScheduler: ManualScheduler): void => runAll(pagesScheduler);

const isRejected = (n: number): boolean => tileOf(`photo-mia-${String(n).padStart(4, "0")}`)?.closest(".photo-tile")?.classList.contains("photo-tile-rejected") === true;

describe("under load (MEDIUM-1)", () => {
  test("a run of 25 photos landing one by one with 3 pages open: one read at a time, each reads only the top, none goes deep", async () => {
    const { engine, scheduler, pagesScheduler } = await openOnManualClock(library(1050));
    await press(moreButton());
    await waitFor(() => expect(tiles()).toHaveLength(1000));
    await press(moreButton());
    await waitFor(() => expect(tiles()).toHaveLength(1050));

    fireEvent.click(screen.getByRole("button", { name: "Больше" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Сгенерировать 25 фото/ }));
    await screen.findByText("Рисуем фото: 0 из 25");
    const meter = meterPhotosList(engine);
    for (let step = 0; step < 80 && screen.queryByText("Запуск завершён") === null; step++) {
      tick(scheduler, 1); // a slot lands: its photo, job.progress and avatar.changed
      await flush();
      elapse(pagesScheduler); // the wait after the read in flight (if one is) passes: the worst case, a read for every photo
      await flush();
    }
    await screen.findByText("Запуск завершён");
    await waitFor(() => {
      elapse(pagesScheduler);
      expect(tiles()).toHaveLength(1075);
    });

    expect(meter.maxInFlight).toBe(1);
    // Every read went from the top and stopped at the first photo held: no cursor, so not one page past the first was read again.
    expect(meter.cursors.every((cursor) => cursor === undefined)).toBe(true);
    // Well under one read of the 3 pages per photo (75): about one page per photo, the arrivals in between folded together.
    expect(meter.cursors.length).toBeLessThanOrEqual(30);
    expect(tiles().slice(25)).toEqual(library(1050).map((p) => p.photoId).reverse());
    expect(new Set(tiles()).size).toBe(1075);
    expect(screen.getByText("Конец галереи · 1 075 фото")).toBeDefined();
  }, 30_000); // no timer is waited for any more; the time left is React drawing ~1 075 tiles on each of the 25 landings

  test("a mark that comes while a read is in flight is read only once the wait after it has passed on the clock", async () => {
    const { engine, client, scheduler, pagesScheduler } = await openOnManualClock(library(10));
    const meter = meterPhotosList(engine);
    engine.delayNext("photos.list", 500);
    await reject(client, 10); // re-read 1 starts, held back
    await reject(client, 9); // kept for after it
    tick(scheduler, 1);
    await flush();
    await waitFor(() => expect(pagesScheduler.pending).toBe(1)); // the read ended and set the wait
    expect(meter.cursors).toHaveLength(1);

    elapse(pagesScheduler);
    await waitFor(() => expect(meter.cursors).toHaveLength(2));
    await waitFor(() => expect(isRejected(9)).toBe(true));
    expect(pagesScheduler.pending).toBe(0);
  });

  test("marks set elsewhere while a re-read is on its way: one more re-read after it, not one per mark", async () => {
    const { engine, client, scheduler, pagesScheduler } = await openOnManualClock(library(1001));
    await press(moreButton());
    await waitFor(() => expect(tiles()).toHaveLength(1000));
    const meter = meterPhotosList(engine);
    engine.delayNext("photos.list", 500);
    await reject(client, 1001); // re-read 1 starts, its first page held back
    await reject(client, 1000);
    await reject(client, 999);
    await reject(client, 998);
    expect(meter.cursors).toEqual([undefined]);

    tick(scheduler, 1);
    await flush();
    await waitFor(() => {
      elapse(pagesScheduler);
      expect([1001, 1000, 999, 998].every(isRejected)).toBe(true);
    });
    // Two re-reads from page 1 down to page 2 (the owner's depth), each of two pages: the held-back one, and — once, after a short
    // wait — the one the three later marks asked for.
    await waitFor(() => {
      elapse(pagesScheduler);
      expect(meter.cursors).toHaveLength(4);
    });
    // Nothing more comes after it: no wait is left to pass, and letting any pass reads nothing.
    elapse(pagesScheduler);
    await flush();
    expect(pagesScheduler.pending).toBe(0);
    expect(meter.cursors.map((cursor) => (cursor === undefined ? "page 1" : "next"))).toEqual(["page 1", "next", "page 1", "next"]);
    expect(meter.maxInFlight).toBe(1);
    expect(tiles()).toHaveLength(1000);
  });
});

describe("«Показать ещё» and a re-read never cross (MEDIUM-3)", () => {
  test("pressed during a re-read: it waits for it, then goes on from the cursor that re-read named", async () => {
    const { engine, client, scheduler } = await openGallery(library(1001));
    const meter = meterPhotosList(engine);
    engine.delayNext("photos.list", 500);
    await reject(client, 1001);
    await press(moreButton());
    expect(moreButton()?.getAttribute("aria-busy")).toBe("true");
    expect(meter.cursors).toEqual([undefined]);

    tick(scheduler, 1);
    await flush();
    await waitFor(() => expect(tiles()).toHaveLength(1000));
    expect(meter.cursors).toHaveLength(2);
    expect(meter.cursors[1]).toBeDefined();
    expect(new Set(tiles()).size).toBe(1000);
    expect(isRejected(1001)).toBe(true);
    expect(focusedLabel()).toBe(describeElement(tileOf("photo-mia-0501")));
  });

  test("a re-read asked while «Показать ещё» is on its way waits for it, then reads from page 1 down to the new page", async () => {
    const { engine, client, scheduler, pagesScheduler } = await openOnManualClock(library(1001));
    const meter = meterPhotosList(engine);
    engine.delayNext("photos.list", 500);
    await press(moreButton());
    await reject(client, 2); // on the page still on its way
    expect(meter.cursors).toHaveLength(1);

    tick(scheduler, 1);
    await flush();
    await waitFor(() => expect(tiles()).toHaveLength(1000));
    expect(focusedLabel()).toBe(describeElement(tileOf("photo-mia-0501")));
    // Then, once, from page 1 with fresh cursors down to photo 2: the mark shows on the page just appended.
    await waitFor(() => {
      elapse(pagesScheduler);
      expect(isRejected(2)).toBe(true);
    });
    expect(meter.cursors.slice(1, 2)).toEqual([undefined]);
    expect(meter.cursors.slice(2).every((cursor) => cursor !== undefined)).toBe(true);
    expect(meter.maxInFlight).toBe(1);
    expect(tiles()).toHaveLength(1000);
  });

  test("a re-read that fails while «Показать ещё» waits: the failure is said above the list, and the page still comes", async () => {
    const { engine, client, scheduler } = await openGallery(library(1001));
    engine.delayNext("photos.list", 500);
    engine.failNext("photos.list", { code: "INTERNAL" });
    await reject(client, 1001);
    await press(moreButton());

    tick(scheduler, 1);
    await flush();
    await screen.findByText(ERROR_MESSAGES_RU.INTERNAL);
    await waitFor(() => expect(tiles()).toHaveLength(1000));
    expect(new Set(tiles()).size).toBe(1000);
  });

  test("a mark set while the page is on its way is kept when the page is appended (LOW-1)", async () => {
    const { engine, scheduler } = await openGallery(library(1001));
    engine.delayNext("photos.list", 500);
    await press(moreButton());
    fireEvent.click(screen.getByRole("button", { name: "Фото 1: отклонить — в видео не брать" }));
    await flush();
    expect(isRejected(1001)).toBe(true);

    tick(scheduler, 1);
    await flush();
    await waitFor(() => expect(tiles()).toHaveLength(1000));
    expect(isRejected(1001)).toBe(true);
  });
});

describe("the focus after «Показать ещё»", () => {
  test("is not taken from where the owner moved meanwhile", async () => {
    const { engine, scheduler } = await openGallery(library(1001));
    engine.delayNext("photos.list", 500);
    await press(moreButton());
    const all = screen.getByRole("button", { name: "Все" });
    all.focus();

    tick(scheduler, 1);
    await flush();
    await waitFor(() => expect(tiles()).toHaveLength(1000));
    expect(focusedLabel()).toBe(describeElement(all));
  });

  test("an empty last page (its photos went meanwhile): the button goes, the focus to the last tile, and it is said (LOW-2)", async () => {
    const { engine } = await openGallery(library(501));
    engine.setPhotoSidecarReadable("photo-mia-0001", false);
    // The announcer clears its text after ANNOUNCE_MS, which a slow runner can pass before the button is seen gone (macOS CI
    // 37891591934): so everything the live region ever said is recorded, and the words are looked for there.
    const region = document.querySelector(".photos-gallery .photos-more-said");
    if (region === null) throw new Error("the gallery's live region is not on screen");
    const said: string[] = [];
    const watch = new MutationObserver(() => said.push(region.textContent ?? ""));
    watch.observe(region, { childList: true, characterData: true, subtree: true });
    try {
      await press(moreButton());
      await waitFor(() => expect(moreButton() === null).toBe(true));
      expect(tiles()).toHaveLength(500);
      expect(focusedLabel()).toBe(describeElement(tileOf("photo-mia-0002")));
      await waitFor(() => expect(said).toContain("Больше фото нет"));
    } finally {
      watch.disconnect();
    }
  });
});

describe("the picks (MEDIUM-2)", () => {
  test("a pick whose photo went while the screen was away goes once the last page is read; a pick on a page keeps", async () => {
    const { engine } = await openGallery(library(502));
    await press(moreButton());
    await waitFor(() => expect(tiles()).toHaveLength(502));
    fireEvent.click(screen.getByRole("button", { name: "Выбрать для монтажа: фото 501, Дом" }));
    fireEvent.click(screen.getByRole("button", { name: "Выбрать для монтажа: фото 502, Дом" }));
    const montage = (): string => screen.getByRole("button", { name: /Монтаж из выбранных/ }).textContent ?? "";
    expect(montage()).toBe("Монтаж из выбранных · 2");

    await openSection("Настройки");
    engine.setPhotoSidecarReadable("photo-mia-0001", false);
    await openSection("Фото");
    await screen.findByRole("heading", { level: 1, name: "Mia" });
    await waitFor(() => expect(tiles()).toHaveLength(500));
    // Their page is not read yet: both are kept.
    expect(montage()).toBe("Монтаж из выбранных · 2");

    await press(moreButton());
    await waitFor(() => expect(tiles()).toHaveLength(501));
    // The whole gallery is read now and photo 1 is on no page: its pick goes, photo 2's stays.
    expect(montage()).toBe("Монтаж из выбранных · 1");
    expect(screen.getByRole("button", { name: "Выбрать для монтажа: фото 501, Дом" }).getAttribute("aria-pressed")).toBe("true");
  });
});
