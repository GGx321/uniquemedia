import { describe, expect, test } from "bun:test";
import { fireEvent, screen, within } from "@testing-library/react";
import type { PhotoSummary } from "../../shared/engine";
import { MIA, scenePhoto } from "../engine/mockEngine.testkit";
import { flush, setup } from "../testing";

// S5.9g (plan s5a3 gap A, §13.1 «Viewer»; mockup 51 of .omc/stage5/design): a frame drawn on the «Смелая» route says «Seedream 5 Pro · 2K» in the viewer, beside its
// face badge (unchanged). The tag reads `PhotoSummary.route` and nothing else: the model id cannot tell 2K from the 1K moderation fallback, so a photo without
// `route` — an old one, or a fallback frame — shows no tag.

const ROUTE_TITLE = "Этот кадр рисует Seedream 5 Pro в 2K";

async function openViewer(photo: PhotoSummary, category: string): Promise<HTMLElement> {
  setup({ avatars: [{ ...MIA, photoCount: 1, eligibleUnusedCount: 1 }], photos: [photo] });
  fireEvent.click(await screen.findByRole("button", { name: "Mia" }));
  await screen.findByRole("heading", { level: 1, name: "Mia" });
  await flush();
  fireEvent.click(screen.getByRole("button", { name: `Открыть фото 1: ${category}` }));
  await flush();
  return screen.getByRole("dialog");
}

describe("the viewer's route tag (mockup 51)", () => {
  test("a Seedream-route frame: «лицо 0.71» as before, then «Seedream 5 Pro · 2K» with its title", async () => {
    const viewer = await openViewer(scenePhoto(1, { category: "nightwear", qa: { faceCos: 0.71 }, route: "seedream" }), "Ночнушки и бельё");
    const meta = viewer.querySelector(".viewer-meta");
    const parts = Array.from(meta?.children ?? []).map((el) => el.textContent ?? "");
    expect(parts).toEqual(["Ночнушки и бельё", "лицо 0.71", "Seedream 5 Pro · 2K"]);
    const tag = within(viewer).getByText("Seedream 5 Pro · 2K");
    expect(tag.getAttribute("title")).toBe(ROUTE_TITLE);
    // The face badge is the tile's own, untouched.
    expect(within(viewer).getByText("лицо 0.71").className).toBe("pill mono photo-badge photo-face");
  });

  test("a photo without `route` (an old one, or a 1K fallback frame) shows no tag", async () => {
    const viewer = await openViewer(scenePhoto(1, { category: "nightwear", qa: { faceCos: 0.71 } }), "Ночнушки и бельё");
    expect(within(viewer).queryByText("Seedream 5 Pro · 2K") === null).toBe(true);
    expect(within(viewer).queryByText(/Seedream/) === null).toBe(true);
  });

  test("the gallery tile stays as it was: no route tag on it", async () => {
    await openViewer(scenePhoto(1, { category: "beach", qa: { faceCos: 0.71 }, route: "seedream" }), "Пляж и бассейн");
    const tile = document.querySelector(".photo-tile");
    expect(tile?.textContent?.includes("Seedream") ?? true).toBe(false);
  });
});
