import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { EngineClient } from "../engine/client";
import { flush } from "../testing";
import { MEDIA_RETRY_DELAY_MS } from "../ui/useMediaRetry";
import { IDS, mineStudio, openMine, preview } from "./montage/mineScreenKit";
import { photoClip } from "./montage/testkit";

// Review r1 LOW-5: an own photo in a cell whose record is not known (not read yet, or the library no longer holds it) has no size to cut a
// window from; its cell shows a stand-in instead of an empty black cell. A picture that does not load (the real client's media route answered
// an error) gives way to the stand-in too, after the one more try every `studio-media://` picture gets.

const OWN = "media-demo-0001";
const ownCellClip = (mediaId: string) => ({ ...photoClip(0, IDS[0] ?? "", 2_000), cell: { photo: { source: "own" as const, mediaId }, focus: null } });
const asWindow = (base: EngineClient): EngineClient => ({ ...base, kind: "window" });

describe("an own photo's cell with no picture to draw", () => {
  test("a photo the library does not hold: the cell shows the stand-in, not nothing", async () => {
    const { engine, client } = await mineStudio();
    await openMine(engine, client, { clips: [ownCellClip("media-00000404"), photoClip(1, IDS[1] ?? "", 2_000)] });
    const cell = within(preview()).getByRole("button", { name: "Кадр 1: своё фото" });
    expect(cell.querySelector(".pv-photo-standin") !== null).toBe(true);
    expect(cell.querySelector("img") === null).toBe(true);
  });

  test("a picture the media route cannot serve is asked for once more, then gives way to the stand-in", async () => {
    const { engine, client } = await mineStudio(asWindow);
    engine.seedOwnMedia([{ kind: "photo", name: "croissant.jpg", bytes: 900_000, createdAt: "2026-10-01T10:00:00.000Z" }]);
    await openMine(engine, client, { clips: [ownCellClip(OWN), photoClip(1, IDS[1] ?? "", 2_000)] });
    const cell = (): HTMLElement => within(preview()).getByRole("button", { name: "Кадр 1: своё фото" });
    const picture = (): HTMLImageElement | null => cell().querySelector("img.pv-photo");
    await waitFor(() => expect(picture() !== null).toBe(true));
    expect(picture()?.getAttribute("src")).toBe(`studio-media://media/${OWN}`);

    // A busy or slow disk answers 503/504, which an `<img>` cannot tell from a missing file: one failure is a pause with the stand-in
    // (never the errored picture), then a second try (useMediaRetry.ts); only the second failure stays.
    fireEvent.error(picture() ?? document.body);
    await flush();
    expect(picture() === null).toBe(true);
    expect(cell().querySelector(".pv-photo-standin") !== null).toBe(true);
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, MEDIA_RETRY_DELAY_MS + 60)));
    expect(picture()?.getAttribute("src")).toBe(`studio-media://media/${OWN}`);
    expect(cell().querySelector(".pv-photo-standin") === null).toBe(true);

    fireEvent.error(picture() ?? document.body);
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, MEDIA_RETRY_DELAY_MS + 60)));
    expect(picture() === null).toBe(true);
    expect(cell().querySelector(".pv-photo-standin") !== null).toBe(true);
  });
});
