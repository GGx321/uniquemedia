import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { flush, tick } from "../testing";
import * as runForm from "./photos/runForm";
import { library, moreButton, openGallery, press, tiles } from "./photos/moreScreenKit";

// What a screen redraws when one photo lands in a big gallery. Every tile is drawn once: a new photo in front moves the number of each
// photo after it («Фото 5» becomes «Фото 6»). What must not happen is a second drawing of a tile for the same landing (it was two each
// before the tiles were memoized). `photoCategoryLabel` is called once per drawing of a tile (the viewer is closed here).

const spies: { mockRestore: () => void }[] = [];
afterEach(() => spies.splice(0).forEach((spy) => spy.mockRestore()));

describe("one photo landing in a gallery of 1 050", () => {
  test("draws each tile once, not twice", async () => {
    const { scheduler } = await openGallery(library(1050));
    await press(moreButton());
    await waitFor(() => expect(tiles()).toHaveLength(1000));
    await press(moreButton());
    await waitFor(() => expect(tiles()).toHaveLength(1050));
    fireEvent.click(screen.getByRole("button", { name: "Больше" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Сгенерировать 25 фото/ }));
    await screen.findByText("Рисуем фото: 0 из 25");

    const spy = spyOn(runForm, "photoCategoryLabel");
    spies.push(spy);
    tick(scheduler, 1); // a slot lands: its photo, job.progress and avatar.changed
    await flush();
    await waitFor(() => expect(tiles()).toHaveLength(1051));
    await flush();
    expect(spy.mock.calls.length).toBeGreaterThan(0); // the spy still sees the tiles drawn, or the bound below proves nothing
    expect(spy.mock.calls.length).toBeLessThanOrEqual(1051 + 10);
  });
});
