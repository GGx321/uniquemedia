import { describe, expect, test } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { EngineClient } from "../engine/client";
import { flush } from "../testing";
import { IDS, mineStudio, openMine, preview } from "./montage/mineScreenKit";
import { photoClip } from "./montage/testkit";

// Review r1 LOW-5: an own photo in a cell whose record is not known (not read yet, or the library no longer holds it) has no size to cut a
// window from; its cell shows a stand-in instead of an empty black cell. A picture that does not load (the real client's media route answered
// an error) gives way to the stand-in too.

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

  test("a picture the media route cannot serve gives way to the stand-in", async () => {
    const { engine, client } = await mineStudio(asWindow);
    engine.seedOwnMedia([{ kind: "photo", name: "croissant.jpg", bytes: 900_000, createdAt: "2026-10-01T10:00:00.000Z" }]);
    await openMine(engine, client, { clips: [ownCellClip(OWN), photoClip(1, IDS[1] ?? "", 2_000)] });
    const cell = (): HTMLElement => within(preview()).getByRole("button", { name: "Кадр 1: своё фото" });
    await waitFor(() => expect(cell().querySelector("img.pv-photo") !== null).toBe(true));
    const picture = cell().querySelector("img.pv-photo");
    expect(picture?.getAttribute("src")).toBe(`studio-media://media/${OWN}`);
    fireEvent.error(picture ?? document.body);
    await flush();
    expect(cell().querySelector("img.pv-photo") === null).toBe(true);
    expect(cell().querySelector(".pv-photo-standin") !== null).toBe(true);
  });
});
