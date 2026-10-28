import { afterEach, describe, expect, spyOn } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { PhotoSummary } from "../../shared/engine";
import { flush, tick } from "../testing";
import * as runForm from "./photos/runForm";
import { library, moreButton, openGallery, press, tileOf, tiles } from "./photos/moreScreenKit";
import { heavyTest } from "../../testing/bunTiers";

// What a screen redraws when one photo lands in a big gallery. Every tile is drawn once: a new photo in front moves the number of each
// photo after it («Фото 5» becomes «Фото 6»). What must not happen is a second drawing of a tile for the same landing (it was two each
// before the tiles were memoized). `photoCategoryLabel` is called once per drawing of a tile (the viewer is closed here).

const spies: { mockRestore: () => void }[] = [];
afterEach(() => spies.splice(0).forEach((spy) => spy.mockRestore()));

describe("one photo landing in a gallery of 1 050", () => {
  heavyTest("draws each tile once, not twice", async () => {
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

  // The run starting moves the progress key, so the screen asks photos.list at once; on a slow runner that answer lands after the test has begun counting
  // (CI 38532866925: 1551 = 1051 + one page of 500). This holds that answer back until the test releases it; `change` may alter the photos it brings.
  async function startRunWithHeldRead(change?: (photo: PhotoSummary) => PhotoSummary) {
    const { scheduler, engine } = await openGallery(library(1050));
    await press(moreButton());
    await waitFor(() => expect(tiles()).toHaveLength(1000));
    await press(moreButton());
    await waitFor(() => expect(tiles()).toHaveLength(1050));

    const held: (() => void)[] = [];
    let answered = false;
    const request = engine.request.bind(engine);
    engine.request = async (command) => {
      if (command.type !== "photos.list" || held.length > 0) return request(command);
      await new Promise<void>((release) => held.push(release));
      const reply = await request(command);
      answered = true;
      if (change === undefined || reply.type !== "photos.list" || !reply.ok) return reply;
      return { ...reply, result: { ...reply.result, photos: reply.result.photos.map(change) } };
    };
    fireEvent.click(screen.getByRole("button", { name: "Больше" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Сгенерировать 25 фото/ }));
    await screen.findByText("Рисуем фото: 0 из 25");
    await waitFor(() => expect(held).toHaveLength(1)); // the read the run's start asked is on its way

    const spy = spyOn(runForm, "photoCategoryLabel");
    spies.push(spy);
    /** Lets the held answer go and returns once the screen has been handed it and has drawn what it will. */
    const release = async () => {
      held[0]?.();
      await waitFor(() => expect(answered).toBe(true));
      for (let i = 0; i < 4; i++) await flush();
    };
    return { scheduler, spy, release };
  }

  // The held answer brings the first page again as new objects with the same content: no tile may be drawn for it.
  heavyTest("a re-read asked when the run started answers late and changes nothing: it draws no tile", async () => {
    const { scheduler, spy, release } = await startRunWithHeldRead();
    await release(); // the slow answer comes now
    expect(spy.mock.calls.length).toBeLessThanOrEqual(10);

    tick(scheduler, 1);
    await flush();
    await waitFor(() => expect(tiles()).toHaveLength(1051));
    await flush();
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(1051 + 10);
  });

  // The other side of the same rule: a photo the re-read DID change is a new object, so its tile is drawn again, and only its tile.
  heavyTest("a re-read that changes one photo draws that photo's tile and no other", async () => {
    const changed = "photo-mia-0700";
    const { spy, release } = await startRunWithHeldRead((photo) => (photo.photoId === changed ? { ...photo, category: "own", categoryName: "Rooftop" } : photo));
    await release();
    await waitFor(() => expect(tileOf(changed)?.getAttribute("aria-label")).toContain("Rooftop"));
    await flush();
    expect(spy.mock.calls.length).toBe(1);
  });
});
