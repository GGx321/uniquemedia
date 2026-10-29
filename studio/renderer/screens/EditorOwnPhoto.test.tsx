import { describe, expect, test } from "bun:test";
import { within } from "@testing-library/react";
import { IDS, mineStudio, openMine, preview } from "./montage/mineScreenKit";
import { photoClip } from "./montage/testkit";

// Review r1 LOW-5: an own photo in a cell whose record is not known (not read yet, or the library no longer holds it) has no size to cut a
// window from; its cell shows a stand-in instead of an empty black cell. A picture that does not load (the real client's media route answered
// an error) gives way to the stand-in too, after the one more try every `studio-media://` picture gets.

const ownCellClip = (mediaId: string) => ({ ...photoClip(0, IDS[0] ?? "", 2_000), cell: { photo: { source: "own" as const, mediaId }, focus: null } });

describe("an own photo's cell with no picture to draw", () => {
  test("a photo the library does not hold: the cell shows the stand-in, not nothing", async () => {
    const { engine, client } = await mineStudio();
    await openMine(engine, client, { clips: [ownCellClip("media-00000404"), photoClip(1, IDS[1] ?? "", 2_000)] });
    const cell = within(preview()).getByRole("button", { name: "Кадр 1: своё фото" });
    expect(cell.querySelector(".pv-photo-standin") !== null).toBe(true);
    expect(cell.querySelector("img") === null).toBe(true);
  });
});
