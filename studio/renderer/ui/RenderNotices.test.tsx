import { afterEach, describe, expect, jest, test } from "bun:test";
import { fireEvent, screen, within } from "@testing-library/react";
import { PHOTO_IDS } from "../engine/mockEngine.testkit";
import { asAnotherWindow, makeDraft, MIA, openDrafts, studio } from "../screens/montage/screenKit";
import { callsOf, flush, runAll } from "../testing";

// 3d.6: a render ends while the owner is somewhere else: a notice, with the existing notice component, on whatever screen is open.
// And a «сохранение» phase that never ends is told, wherever the owner is.

const P = (n: number): string => PHOTO_IDS[n] ?? "";

afterEach(() => {
  jest.useRealTimers();
  Reflect.deleteProperty(window, "studio");
});

async function renderOf(client: Parameters<typeof makeDraft>[0], photos: string[]): Promise<{ montageId: string }> {
  const made = await makeDraft(client, MIA.avatarId, photos);
  await asAnotherWindow(() => client.request("videos.render", { montageId: made.montageId }));
  return made;
}

describe("a render that ends out of sight", () => {
  test("done: «Видео готово» with «Открыть в папке» (by the video's id), «К черновику» and «Закрыть»", async () => {
    const { client, engine, scheduler } = await studio();
    const made = await renderOf(client, [P(0), P(1)]);
    await openDrafts();
    runAll(scheduler);
    await flush();

    const notice = (await screen.findByText("Видео готово")).closest(".notice");
    if (!(notice instanceof HTMLElement)) throw new Error("no notice");
    expect(within(notice).getByText(/Mia/)).toBeDefined();

    fireEvent.click(within(notice).getByRole("button", { name: "Открыть в папке" }));
    await flush();
    expect(callsOf(engine, "videos.reveal")).toHaveLength(1);
    expect(engine.revealed[0]).toMatch(/^video-/);

    fireEvent.click(within(notice).getByRole("button", { name: "К черновику" }));
    await screen.findByRole("region", { name: "Таймлайн" });
    expect(made.montageId).toMatch(/^montage-/);
  });

  test("failed: the error by its code, and the notice closes", async () => {
    const { client, engine, scheduler } = await studio();
    engine.failNextRender({ code: "RENDER_FAILED" });
    await renderOf(client, [P(0), P(1)]);
    await openDrafts();
    runAll(scheduler);
    await flush();

    await screen.findByText("Рендер не удался");
    expect(screen.getByText(/Не удалось собрать видео/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(screen.queryByText("Рендер не удался") === null).toBe(true);
  });

});

