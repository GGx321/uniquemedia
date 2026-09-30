import { describe, expect, test } from "bun:test";
import { fireEvent, screen, within } from "@testing-library/react";
import { ERROR_MESSAGES_RU } from "../../shared/engine";
import { freePhotos, scenePhoto } from "../engine/mockEngine.testkit";
import { callsOf, openSection } from "../testing";
import { MIA, studio } from "./montage/screenKit";

// 3d.2: the Photos screen's «Монтаж из выбранных · N» → `montages.create` (`defaultSpec` in the engine) → the editor.
// Disabled at 0 and above 20 with the reason; one photo → one video (the owner's Q1); PHOTO_UNAVAILABLE marks tiles (K11).

const header = (): HTMLElement => {
  const found = document.querySelector<HTMLElement>(".ed-head");
  if (found === null) throw new Error("no editor header");
  return found;
};

describe("from the Photos screen", () => {
  test("«Монтаж из выбранных · 2» makes a draft of the picked photos in the order picked, and opens it", async () => {
    const { engine } = await studio();
    await openSection("Фото");
    const picks = await screen.findAllByRole("button", { name: /Выбрать для монтажа/ });
    // The gallery is newest first: pick the second tile, then the first.
    fireEvent.click(picks[1] ?? document.body);
    fireEvent.click(picks[0] ?? document.body);
    const montage = screen.getByRole("button", { name: /Монтаж из выбранных/ });
    expect(montage.textContent).toBe("Монтаж из выбранных · 2");
    fireEvent.click(montage);

    await screen.findByRole("heading", { level: 1, name: "Mia · без названия" });
    const gallery = freePhotos(6).map((p) => p.photoId).reverse();
    expect(callsOf(engine, "montages.create").at(-1)?.payload).toEqual({ avatarId: MIA.avatarId, photoIds: [gallery[1], gallery[0]] });
    expect(within(header()).getByText("черновик · создан только что")).toBeDefined();
    expect(within(header()).getByText("1080×1920 · 30 fps · 8.0 с · ≈ 3.5 МБ")).toBeDefined();
  });

  test("it is disabled with nothing picked, and above 20 photos with the reason next to it", async () => {
    await studio({ photos: freePhotos(21) });
    await openSection("Фото");
    const montage = screen.getByRole("button", { name: /Монтаж из выбранных/ });
    expect(montage.hasAttribute("disabled")).toBe(true);
    for (const pick of await screen.findAllByRole("button", { name: /Выбрать для монтажа/ })) fireEvent.click(pick);
    expect(montage.textContent).toBe("Монтаж из выбранных · 21");
    expect(montage.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Не больше 20 фото в одном ролике — снимите лишние").id).toBe(montage.getAttribute("aria-describedby") ?? "");
  });

  test("a photo already in a video cannot be picked: one photo, one video", async () => {
    await studio({ photos: [scenePhoto(1), scenePhoto(2, { used: true, usedIn: ["video-0000001"] })] });
    await openSection("Фото");
    const used = await screen.findByRole("button", { name: /Фото уже в видео/ });
    expect(used.hasAttribute("disabled")).toBe(true);
  });

  test("a photo the engine refuses is marked on its tile, and the refusal is said", async () => {
    const { engine } = await studio({ photos: freePhotos(2) });
    await openSection("Фото");
    const picks = await screen.findAllByRole("button", { name: /Выбрать для монтажа/ });
    fireEvent.click(picks[0] ?? document.body);
    fireEvent.click(picks[1] ?? document.body);
    engine.failNext("montages.create", { code: "PHOTO_UNAVAILABLE", issues: [{ code: "photo-unavailable", path: ["photoIds", 1] }] });
    fireEvent.click(screen.getByRole("button", { name: /Монтаж из выбранных/ }));

    await screen.findByText(ERROR_MESSAGES_RU.PHOTO_UNAVAILABLE);
    expect(picks[1]?.closest(".photo-tile")?.classList.contains("photo-tile-refused")).toBe(true);
    expect(picks[0]?.closest(".photo-tile")?.classList.contains("photo-tile-refused")).toBe(false);
    expect(screen.getByRole("heading", { level: 1, name: "Mia" })).toBeDefined();
  });
});
