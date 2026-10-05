import { describe, expect, test } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { ERROR_MESSAGES_RU } from "../../shared/engine";
import { freePhotos, scenePhoto } from "../engine/mockEngine.testkit";
import { callsOf, flush, openSection, runAll } from "../testing";
import { asAnotherWindow, makeDraft, MIA, studio } from "./montage/screenKit";

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
    expect(document.querySelector(".ed-output")?.textContent?.replace(/\s/g, " ")).toBe("1080×1920 · 30 fps · 8.0 с · ≈ 3.5 МБ");
  });

  test("slice review 5-L3: the photos picked are kept by the window while it runs, per avatar: a trip to Settings and back keeps them; a draft made of them clears them", async () => {
    const { engine } = await studio();
    await openSection("Фото");
    const picks = await screen.findAllByRole("button", { name: /Выбрать для монтажа/ });
    fireEvent.click(picks[1] ?? document.body);
    fireEvent.click(picks[0] ?? document.body);
    expect(screen.getByRole("button", { name: /Монтаж из выбранных/ }).textContent).toBe("Монтаж из выбранных · 2");

    await openSection("Настройки");
    await screen.findByRole("heading", { level: 1, name: "Настройки" });
    await openSection("Фото");
    await screen.findAllByRole("button", { name: /Выбрать для монтажа|Снять выбор/ });
    const montage = screen.getByRole("button", { name: /Монтаж из выбранных/ });
    expect(montage.textContent).toBe("Монтаж из выбранных · 2");
    // In the order they were picked.
    fireEvent.click(montage);
    await screen.findByRole("heading", { level: 1, name: "Mia · без названия" });
    const gallery = freePhotos(6).map((p) => p.photoId).reverse();
    expect(callsOf(engine, "montages.create").at(-1)?.payload.photoIds).toEqual([gallery[1], gallery[0]]);

    await openSection("Фото");
    await screen.findAllByRole("button", { name: /Выбрать для монтажа/ });
    expect(screen.getByRole("button", { name: /Монтаж из выбранных/ }).textContent).toBe("Монтаж из выбранных · 0");
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

  test("with nothing picked, why the button waits is on screen", async () => {
    await studio({ photos: freePhotos(2) });
    await openSection("Фото");
    const montage = screen.getByRole("button", { name: /Монтаж из выбранных/ });
    const why = screen.getByText("Отметьте фото, чтобы собрать ролик");
    expect(why.id).toBe(montage.getAttribute("aria-describedby") ?? "");
  });

  test("a photo already in a video is marked like the editor's bin: dimmed, with how many videos hold it", async () => {
    await studio({ photos: [scenePhoto(1), scenePhoto(2, { used: true, usedIn: ["video-0000001"] })] });
    await openSection("Фото");
    const pick = await screen.findByRole("button", { name: /Фото уже в видео/ });
    const tile = pick.closest(".photo-tile");
    expect(tile?.classList.contains("photo-tile-used")).toBe(true);
    expect(within(tile instanceof HTMLElement ? tile : document.body).getByText("в 1 видео")).toBeDefined();
  });

  test("after a refusal the gallery is read again (the tile says why), and unpicking another photo keeps the mark", async () => {
    const { client, engine, scheduler } = await studio({ photos: freePhotos(3) });
    await openSection("Фото");
    const picks = await screen.findAllByRole("button", { name: /Выбрать для монтажа/ });
    fireEvent.click(picks[0] ?? document.body);
    fireEvent.click(picks[1] ?? document.body);
    // Meanwhile another window puts the second picked photo into a video.
    const gallery = freePhotos(3).map((p) => p.photoId).reverse();
    const other = await makeDraft(client, MIA.avatarId, [gallery[1] ?? ""]);
    await asAnotherWindow(() => client.request("videos.render", { montageId: other.montageId }));
    runAll(scheduler);
    await flush();
    const reads = callsOf(engine, "photos.list").length;

    fireEvent.click(screen.getByRole("button", { name: /Монтаж из выбранных/ }));
    await screen.findByText(ERROR_MESSAGES_RU.PHOTO_UNAVAILABLE);
    await waitFor(() => expect(callsOf(engine, "photos.list").length).toBeGreaterThan(reads));
    const refusedTile = (await screen.findByText("в 1 видео")).closest(".photo-tile");
    expect(refusedTile?.classList.contains("photo-tile-refused")).toBe(true);

    fireEvent.click(screen.getAllByRole("button", { name: /Выбрать для монтажа/ })[0] ?? document.body);
    expect(document.querySelectorAll(".photo-tile-refused")).toHaveLength(1);
  });

  test("the refusal goes once its marked photos are unpicked, and it can be closed", async () => {
    const { engine } = await studio({ photos: freePhotos(3) });
    await openSection("Фото");
    const picks = await screen.findAllByRole("button", { name: /Выбрать для монтажа/ });
    fireEvent.click(picks[0] ?? document.body);
    fireEvent.click(picks[1] ?? document.body);
    engine.failNext("montages.create", { code: "PHOTO_UNAVAILABLE", issues: [{ code: "photo-unavailable", path: ["photoIds", 1] }] });
    fireEvent.click(screen.getByRole("button", { name: /Монтаж из выбранных/ }));
    await screen.findByText(ERROR_MESSAGES_RU.PHOTO_UNAVAILABLE);

    fireEvent.click(screen.getAllByRole("button", { name: /Выбрать для монтажа/ })[1] ?? document.body);
    expect(screen.queryByText(ERROR_MESSAGES_RU.PHOTO_UNAVAILABLE) === null).toBe(true);

    engine.failNext("montages.create", { code: "PHOTO_UNAVAILABLE", issues: [{ code: "photo-unavailable", path: ["photoIds", 0] }] });
    fireEvent.click(screen.getByRole("button", { name: /Монтаж из выбранных/ }));
    await screen.findByText(ERROR_MESSAGES_RU.PHOTO_UNAVAILABLE);
    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(screen.queryByText(ERROR_MESSAGES_RU.PHOTO_UNAVAILABLE) === null).toBe(true);
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
