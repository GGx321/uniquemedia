import { afterEach, describe, expect, jest, test } from "bun:test";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { PHOTO_IDS } from "../engine/mockEngine.testkit";
import { SAVING_STALL_MS } from "../engine/renderJobs";
import { asAnotherWindow, makeDraft, MIA, openDrafts, studio } from "../screens/montage/screenKit";
import { callsOf, flush, runAll, tick } from "../testing";

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

  test("a file that is gone says so in the notice", async () => {
    const { client, engine, scheduler } = await studio();
    await renderOf(client, [P(0), P(1)]);
    await openDrafts();
    runAll(scheduler);
    await flush();
    await screen.findByText("Видео готово");
    const listed = await client.request("videos.list", { avatarId: MIA.avatarId });
    engine.setVideoFileState(listed.ok ? (listed.result.videos[0]?.videoId ?? "") : "", "missing");

    fireEvent.click(screen.getByRole("button", { name: "Открыть в папке" }));
    await flush();
    expect(screen.getByText(/Файла нет в папке «Готовые видео»/)).toBeDefined();
  });

  test("another refusal of «Открыть в папке» is told by its own text, not as a missing file", async () => {
    const { client, engine, scheduler } = await studio();
    await renderOf(client, [P(0), P(1)]);
    await openDrafts();
    runAll(scheduler);
    await flush();
    await screen.findByText("Видео готово");
    engine.failNext("videos.reveal", { code: "LIBRARY_UNAVAILABLE" });

    fireEvent.click(screen.getByRole("button", { name: "Открыть в папке" }));
    await flush();
    expect(screen.getByText(/Папка библиотеки недоступна/)).toBeDefined();
    expect(screen.queryByText(/Файла нет в папке/) === null).toBe(true);
  });

  test("«Открыть в папке» is disabled while its request is out: one click, one request", async () => {
    const { client, engine, scheduler } = await studio();
    await renderOf(client, [P(0), P(1)]);
    await openDrafts();
    runAll(scheduler);
    await flush();
    await screen.findByText("Видео готово");
    engine.delayNext("videos.reveal", 1_000);

    const button = screen.getByRole("button", { name: "Открыть в папке" });
    fireEvent.click(button);
    await flush();
    expect(screen.getByRole("button", { name: "Открыть в папке" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Открыть в папке" }));
    await flush();
    expect(callsOf(engine, "videos.reveal")).toHaveLength(1);
    runAll(scheduler);
    await flush();
    expect(screen.getByRole("button", { name: "Открыть в папке" }).hasAttribute("disabled")).toBe(false);
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

  test("a render that ended while the owner was in the editor of that very draft is told by its header, not twice", async () => {
    const { client, scheduler } = await studio();
    await makeDraft(client, MIA.avatarId, [P(0), P(1)]);
    await openDrafts();
    fireEvent.click(screen.getByRole("button", { name: "Открыть" }));
    await screen.findByRole("region", { name: "Таймлайн" });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Рендер" }));
    await flush();
    runAll(scheduler);
    await flush();

    await screen.findByText("Готово");
    expect(screen.queryByText("Видео готово") === null).toBe(true);
  });

  test("a cancelled render raises none: it is the owner's own doing", async () => {
    const { client, scheduler } = await studio();
    const made = await renderOf(client, [P(0), P(1)]);
    await openDrafts();
    const running = await client.request("engine.snapshot", {});
    const jobId = running.ok ? (running.result.jobs[0]?.jobId ?? "") : "";
    await asAnotherWindow(() => client.request("videos.cancel", { jobId }));
    runAll(scheduler);
    await flush();
    expect(screen.queryByText("Видео готово") === null).toBe(true);
    expect(screen.queryByText("Рендер не удался") === null).toBe(true);
    expect(made.montageId).toMatch(/^montage-/);
  });
});

describe("a saving phase that never ends", () => {
  test("is told once it has lasted the limit, wherever the owner is, and the notice goes when the render ends", async () => {
    const { client, scheduler } = await studio();
    await renderOf(client, [P(0), P(1)]);
    await openDrafts();
    jest.useFakeTimers();
    // Up to the saving phase, and no further: the commit never comes.
    for (let i = 0; i < 12 && screen.queryByText("Сохранение…") === null; i++) {
      tick(scheduler);
      await flush();
    }
    expect(screen.getByText("Сохранение…")).toBeDefined();
    expect(screen.queryByText("Сохранение идёт дольше обычного") === null).toBe(true);

    act(() => {
      jest.advanceTimersByTime(SAVING_STALL_MS + 10_000);
    });
    await flush();
    expect(screen.getByText("Сохранение идёт дольше обычного")).toBeDefined();

    runAll(scheduler);
    await flush();
    expect(screen.queryByText("Сохранение идёт дольше обычного") === null).toBe(true);
  });
});
