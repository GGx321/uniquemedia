import { describe, expect, test } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { ERROR_MESSAGES_RU, MAX_LISTED_PHOTOS } from "../../shared/engine";
import { MIA } from "../engine/mockEngine.testkit";
import { asAnotherWindow } from "./montage/screenKit";
import { library, moreButton, openGallery, press, tileOf, tiles } from "./photos/moreScreenKit";
import { callsOf, describeElement, flush, focusedLabel, openSection, runAll, tick } from "../testing";

// S4.P2: «Показать ещё» on the «Фото» gallery. photos.list answers 500 photos a page, newest first, with an opaque cursor to the next
// page and how many remain; the gallery appends pages on the owner's press, reads from page 1 again for new photos (a run's,
// `avatar.changed`), down to the page he had reached, and never mixes «could not read» (skippedTotal) with «beyond the page».

// Focus is asserted through `describeElement` (testing.tsx): a failed comparison of two elements would print the whole 500-tile page.

describe("«Показать ещё» appears exactly when there is more", () => {
  test("500 photos are the whole gallery: no button and no end", async () => {
    await openGallery(library(MAX_LISTED_PHOTOS));
    expect(moreButton() === null).toBe(true);
    expect(screen.queryByText(/Конец галереи/) === null).toBe(true);
  });

  test("501 photos: «Показать ещё · 1»; the press sends the cursor page 1 named and appends the last photo, once, focused", async () => {
    const { engine, client } = await openGallery(library(MAX_LISTED_PHOTOS + 1));
    const button = moreButton();
    if (button === null) throw new Error("no «Показать ещё»");
    expect(button.textContent).toBe("Показать ещё · 1");
    expect(callsOf(engine, "photos.list").map((c) => c.payload.cursor)).toEqual([undefined]);

    await press(button);
    await waitFor(() => expect(tiles()).toHaveLength(501));
    expect(new Set(tiles()).size).toBe(501);
    expect(tiles().at(-1)).toBe("photo-mia-0001");
    // The cursor went back to the engine as it came: the one page 1 named.
    const firstPage = await client.request("photos.list", { avatarId: MIA.avatarId });
    if (!firstPage.ok) throw new Error(firstPage.error.code);
    expect(callsOf(engine, "photos.list")[1]?.payload.cursor).toBe(firstPage.result.nextCursor ?? "none");
    // The focus moved to the first photo the page brought; the button went with the last page, and the gallery says it ends.
    expect(focusedLabel()).toBe("button «Открыть фото 501: Дом»");
    expect(moreButton() === null).toBe(true);
    expect(screen.getByText("Конец галереи · 501 фото")).toBeDefined();
  });

  test("1 001 photos page 500, 500, 1: the count is what remains, each page appended after the last, none twice", async () => {
    await openGallery(library(2 * MAX_LISTED_PHOTOS + 1));
    expect(moreButton()?.textContent).toBe("Показать ещё · 501");
    // What one press brings, for a screen reader: the next 500 of what remains.
    expect(moreButton()?.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText("Следующие 500 из 501 фото")).toBeDefined();

    await press(moreButton());
    await waitFor(() => expect(tiles()).toHaveLength(1000));
    expect(moreButton()?.textContent).toBe("Показать ещё · 1");
    // The button stays, so the focus went from it to photo 501, the first of the new page.
    expect(focusedLabel()).toBe(describeElement(tileOf("photo-mia-0501")));

    await press(moreButton());
    await waitFor(() => expect(tiles()).toHaveLength(1001));
    const expected = library(1001).map((p) => p.photoId).reverse();
    expect(tiles()).toEqual(expected);
  });
});

describe("the next page's own states", () => {
  test("on its way: the button is busy but keeps the focus, and the grid ends in loading tiles where the photos will land", async () => {
    const { engine, scheduler } = await openGallery(library(503));
    engine.delayNext("photos.list", 500);
    const button = moreButton();
    if (button === null) throw new Error("no «Показать ещё»");
    await press(button);

    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(focusedLabel()).toBe(describeElement(button));
    expect(document.querySelectorAll(".photos-gallery .photo-tile-next")).toHaveLength(3);
    // A second press while busy asks nothing more.
    fireEvent.click(button);
    await flush();
    expect(callsOf(engine, "photos.list")).toHaveLength(2);

    tick(scheduler, 1);
    await flush();
    await waitFor(() => expect(tiles()).toHaveLength(503));
    expect(document.querySelectorAll(".photos-gallery .photo-tile-next")).toHaveLength(0);
    expect(focusedLabel()).toBe(describeElement(tileOf("photo-mia-0003")));
  });

  test("failed: the reason under it and «Повторить» on the same button, still focused; the retry brings the page", async () => {
    const { engine } = await openGallery(library(502));
    engine.failNext("photos.list", { code: "INTERNAL" });
    const button = moreButton();
    if (button === null) throw new Error("no «Показать ещё»");
    await press(button);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(`Не удалось загрузить ещё фото. ${ERROR_MESSAGES_RU.INTERNAL}`);
    const retry = screen.getByRole("button", { name: "Повторить" });
    expect(retry === button).toBe(true);
    expect(focusedLabel()).toBe(describeElement(retry));
    expect(tiles()).toHaveLength(500);
    // The gallery's own error (a failed reload) is a different thing: none is shown.
    expect(document.querySelector(".photos-gallery .notice") === null).toBe(true);

    await press(retry);
    await waitFor(() => expect(tiles()).toHaveLength(502));
    expect(screen.queryByRole("alert") === null).toBe(true);
    expect(focusedLabel()).toBe(describeElement(tileOf("photo-mia-0002")));
  });

});

describe("a reload reads from page 1, down to the page the owner reached", () => {
  test("after a run's job.done: from page 1 without a cursor, the run's photos first, every page he opened still there, none twice", async () => {
    const { engine, scheduler } = await openGallery(library(501));
    await press(moreButton());
    await waitFor(() => expect(tiles()).toHaveLength(501));

    const before = callsOf(engine, "photos.list").length;
    fireEvent.click(await screen.findByRole("button", { name: /до \$\d/ }));
    await screen.findByText("Рисуем фото: 0 из 20");
    runAll(scheduler);
    await screen.findByText("Запуск завершён");
    await waitFor(() => expect(tiles()).toHaveLength(521));

    const reloads = callsOf(engine, "photos.list").slice(before);
    expect(reloads[0]?.payload.cursor).toBeUndefined();
    // Each reload starts at page 1: a call without a cursor opens every chain of pages read after the run began.
    expect(reloads.filter((c) => c.payload.cursor === undefined).length).toBeGreaterThan(0);
    expect(new Set(tiles()).size).toBe(521);
    // The run's 20 photos are newer than any cursor: they come first, and the 501 the owner had follow, in order.
    expect(tiles().slice(20)).toEqual(library(501).map((p) => p.photoId).reverse());
    expect(moreButton() === null).toBe(true);
    expect(screen.getByText("Конец галереи · 521 фото")).toBeDefined();
  });

});

describe("with a filter", () => {
});

describe("the picks", () => {
});
