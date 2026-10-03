import { afterEach, describe, expect, test } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { EXPORT_CHANGING_DETAIL, NO_ANSWER_DETAIL_PREFIX, type EngineError } from "../../shared/engine";
import { PHOTO_IDS } from "../engine/mockEngine.testkit";
import { callsOf, flush, runAll, tick } from "../testing";
import { asAnotherWindow, makeDraft, MIA, openDrafts, studio } from "./montage/screenKit";

// 3d.6: the editor's render button and what it says through a render's life: queued, running, saving, done, failed, cancelled; the
// refusals of `videos.render`; a lost answer; «Открыть в папке». The state machine is tested without a screen in renderJobs.test.ts.

const P = (n: number): string => PHOTO_IDS[n] ?? "";

/** Opens the newest draft from the drafts screen (cards are newest first), and waits for the editor. */
async function openEditor(): Promise<void> {
  await openDrafts();
  await screen.findAllByRole("heading", { level: 3, name: /Mia/ });
  const [open] = screen.getAllByRole("button", { name: "Открыть" });
  if (open === undefined) throw new Error("no draft card");
  fireEvent.click(open);
  await screen.findByRole("region", { name: "Таймлайн" });
  await flush();
}

afterEach(() => {
  Reflect.deleteProperty(window, "studio");
});

const renderButton = (): HTMLElement => screen.getByRole("button", { name: "Рендер" });
const isDisabled = (el: HTMLElement): boolean => el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";
const submit = async (): Promise<void> => {
  fireEvent.click(renderButton());
  await flush();
};
/** Steps the mock's clock until `done()` or `max` steps. */
async function until(scheduler: Parameters<typeof tick>[0], done: () => boolean, max = 60): Promise<void> {
  for (let i = 0; i < max && !done(); i++) {
    tick(scheduler);
    await flush();
  }
}

describe("a render's life on the button", () => {
  test("running: «Рендер · P %» and «Отменить рендер»; cancel sends videos.cancel, and the button is ready again once it ended", async () => {
    const { client, engine, scheduler } = await studio();
    await makeDraft(client, MIA.avatarId, [P(0), P(1)]);
    await openEditor();
    await submit();
    await until(scheduler, () => screen.queryByRole("button", { name: /^Рендер · [1-9]\d*\s%$/ }) !== null);
    const cancel = screen.getByRole("button", { name: "Отменить рендер" });
    expect(isDisabled(cancel)).toBe(false);

    fireEvent.click(cancel);
    await flush();
    const job = callsOf(engine, "videos.cancel")[0];
    expect(job?.payload.jobId).toMatch(/^job-/);
    // The engine answered, the job has not stopped yet: no second cancel, and the button does not claim it ended.
    expect(isDisabled(screen.getByRole("button", { name: "Отменить рендер" }))).toBe(true);

    runAll(scheduler);
    await flush();
    expect(screen.queryByRole("button", { name: "Отменить рендер" }) === null).toBe(true);
    await waitFor(() => expect(isDisabled(renderButton())).toBe(false));
  });

  test("queued behind another render: «В очереди · после 1», and it can be cancelled", async () => {
    const { client, engine, scheduler } = await studio();
    const first = await makeDraft(client, MIA.avatarId, [P(0), P(1)]);
    await makeDraft(client, MIA.avatarId, [P(2), P(3)]);
    await asAnotherWindow(() => client.request("videos.render", { montageId: first.montageId }));
    await openEditor();
    await submit();

    const queued = await screen.findByRole("button", { name: /^В очереди · после 1$/ });
    expect(isDisabled(queued)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Отменить рендер" }));
    await flush();
    expect(callsOf(engine, "videos.cancel")).toHaveLength(1);
    await waitFor(() => expect(screen.queryByRole("button", { name: /В очереди/ }) === null).toBe(true));
    expect(isDisabled(renderButton())).toBe(false);
    runAll(scheduler);
  });

  test("the saving phase says «Сохранение…» and disables Cancel: a cancel there cannot stop the job", async () => {
    const { client, engine, scheduler } = await studio();
    await makeDraft(client, MIA.avatarId, [P(0), P(1)]);
    await openEditor();
    await submit();
    await until(scheduler, () => screen.queryByRole("button", { name: /Сохранение…/ }) !== null);

    expect(screen.getByRole("button", { name: /Сохранение…/ })).toBeDefined();
    const cancel = screen.getByRole("button", { name: "Отменить рендер" });
    expect(isDisabled(cancel)).toBe(true);
    fireEvent.click(cancel);
    await flush();
    expect(callsOf(engine, "videos.cancel")).toHaveLength(0);
    runAll(scheduler);
  });

  test("done: «Готово», «Открыть в папке» (asks main by the video's id) and «Рендер» blocked while the photos are in the new video", async () => {
    const { client, engine, scheduler } = await studio();
    await makeDraft(client, MIA.avatarId, [P(0), P(1)]);
    await openEditor();
    await submit();
    runAll(scheduler);
    await flush();

    await screen.findByText("Готово");
    expect(screen.getByText("Фото уже в видео из этого черновика — замените их или удалите то видео")).toBeDefined();
    expect(isDisabled(renderButton())).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Открыть в папке" }));
    await flush();
    const asked = callsOf(engine, "videos.reveal");
    expect(asked).toHaveLength(1);
    expect(engine.revealed).toEqual([asked[0]?.payload.videoId ?? ""]);
    expect(engine.revealed[0]).toMatch(/^video-/);
  });

  test("«Открыть в папке» for a file that is gone says so, in words, not «Запрошенный объект не найден»", async () => {
    const { client, engine, scheduler } = await studio();
    await makeDraft(client, MIA.avatarId, [P(0), P(1)]);
    await openEditor();
    await submit();
    runAll(scheduler);
    await flush();
    await screen.findByText("Готово");
    const listed = await client.request("videos.list", { avatarId: MIA.avatarId });
    engine.setVideoFileState(listed.ok ? (listed.result.videos[0]?.videoId ?? "") : "", "missing");

    fireEvent.click(screen.getByRole("button", { name: "Открыть в папке" }));
    await flush();
    await screen.findByText(/Файла нет в папке «Готовые видео»/);
    expect(screen.queryByText(/Запрошенный объект не найден/) === null).toBe(true);
    expect(engine.revealed).toEqual([]);
  });

  test("failed: the error by its code, «Повторить рендер», and the retry sends a new render", async () => {
    const { client, engine, scheduler } = await studio();
    await makeDraft(client, MIA.avatarId, [P(0), P(1)]);
    await openEditor();
    engine.failNextRender({ code: "RENDER_FAILED" });
    await submit();
    runAll(scheduler);
    await flush();

    await screen.findByText(/Не удалось собрать видео/);
    const retry = screen.getByRole("button", { name: "Повторить рендер" });
    expect(isDisabled(retry)).toBe(false);
    fireEvent.click(retry);
    await flush();
    expect(callsOf(engine, "videos.render")).toHaveLength(2);
    runAll(scheduler);
    await flush();
    await screen.findByText("Готово");
    expect(screen.queryByText(/Не удалось собрать видео/) === null).toBe(true);
  });

  test("a failed render's notice can be closed, and the button is plain «Рендер» again", async () => {
    const { client, engine, scheduler } = await studio();
    await makeDraft(client, MIA.avatarId, [P(0), P(1)]);
    await openEditor();
    engine.failNextRender({ code: "RENDER_FAILED" });
    await submit();
    runAll(scheduler);
    await flush();
    await screen.findByText(/Не удалось собрать видео/);

    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(screen.queryByText(/Не удалось собрать видео/) === null).toBe(true);
    expect(isDisabled(renderButton())).toBe(false);
  });

  test("a render that fails in its saving phase is failed too, with the text of its code", async () => {
    const { client, engine, scheduler } = await studio();
    await makeDraft(client, MIA.avatarId, [P(0), P(1)]);
    await openEditor();
    engine.failNextRender({ code: "EXPORT_UNAVAILABLE", exportReason: "not-writable" }, "saving");
    await submit();
    runAll(scheduler);
    await flush();
    await screen.findByText(/Папка «Готовые видео» недоступна/);
    expect(screen.getByRole("button", { name: "Повторить рендер" })).toBeDefined();
  });

  test("clicks on the busy button, while the answer is out and after it, send one render", async () => {
    const { client, engine, scheduler } = await studio();
    await makeDraft(client, MIA.avatarId, [P(0), P(1)]);
    await openEditor();
    fireEvent.click(renderButton());
    for (let i = 0; i < 3; i++) {
      const busy = screen.getAllByRole("button", { name: /^Рендер/ }).at(0);
      if (busy !== undefined) fireEvent.click(busy);
      await flush();
    }
    expect(callsOf(engine, "videos.render")).toHaveLength(1);
    runAll(scheduler);
  });
});

describe("an engine that restarts under a submit", () => {
  test("an ok answer whose job event never came does not leave the button in «Рендер…» when the engine restarts", async () => {
    const { client, engine } = await studio();
    await makeDraft(client, MIA.avatarId, [P(0), P(1)]);
    await openEditor();
    engine.setDelivery(false);
    await submit();
    expect(screen.getByRole("button", { name: "Рендер…" })).toBeDefined();

    engine.setDelivery(true);
    engine.restart();
    await flush();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Рендер…" }) === null).toBe(true));
    expect(screen.getAllByRole("button", { name: /^Рендер/ }).length).toBeGreaterThan(0);
  });
});

describe("what a refusal says (nothing was queued: the button is ready again)", () => {
  async function refused(error: EngineError): Promise<void> {
    const { client, engine } = await studio();
    await makeDraft(client, MIA.avatarId, [P(0), P(1)]);
    await openEditor();
    engine.failNext("videos.render", error);
    await submit();
  }

  test("RENDER_QUEUE_FULL names the limit and says nothing was spent or saved", async () => {
    const { client, engine, scheduler } = await studio();
    const other = await makeDraft(client, MIA.avatarId, [P(2), P(3)]);
    await makeDraft(client, MIA.avatarId, [P(0), P(1)]);
    await asAnotherWindow(() => client.request("videos.render", { montageId: other.montageId }));
    engine.setRenderQueueLimit(1);
    await openEditor();
    await submit();

    await screen.findByText(/В очереди уже 1\sрендер: это предел/);
    expect(screen.getByText(/Ничего не потрачено и не сохранено/)).toBeDefined();
    expect(isDisabled(renderButton())).toBe(false);
    // Safe to ask again: once the queue has room, the same click goes through.
    engine.setRenderQueueLimit(20);
    await submit();
    expect(callsOf(engine, "videos.render")).toHaveLength(3);
    await screen.findByRole("button", { name: /В очереди|Рендер · \d+\s%|Рендер…/ });
    runAll(scheduler);
  });

  test("LIBRARY_TOO_NEW says to update the app", async () => {
    await refused({ code: "LIBRARY_TOO_NEW" });
    await screen.findByText(/более новой версией Studio/);
    expect(screen.getByText(/Обновите приложение/)).toBeDefined();
    expect(isDisabled(renderButton())).toBe(false);
  });

  test("a switch of the export folder in that moment has its own text, not the one about paid requests", async () => {
    await refused({ code: "IN_FLIGHT", detail: EXPORT_CHANGING_DETAIL });
    await screen.findByText(/Папку «Готовые видео» как раз меняют/);
    expect(screen.queryByText(/платных/) === null).toBe(true);
    expect(isDisabled(renderButton())).toBe(false);
  });

  test("EXPORT_UNAVAILABLE names the reason and links to the Settings card", async () => {
    await refused({ code: "EXPORT_UNAVAILABLE", exportReason: "not-writable" });
    await screen.findByText(/Папка «Готовые видео» недоступна/);
    expect(screen.getByRole("button", { name: "Открыть папку в Настройках" })).toBeDefined();
  });

  test("PHOTO_UNAVAILABLE highlights the cells named by its issues and never shows its detail", async () => {
    await refused({ code: "PHOTO_UNAVAILABLE", detail: "an unreadable video record: Mia/2026-10-03_photo_001.mp4", issues: [{ code: "photo-unavailable", path: ["clips", 0, "cells", 1] }] });
    await screen.findByText(/Это фото нельзя использовать в видео/);
    expect(screen.queryByText(/unreadable video record/) === null).toBe(true);
    expect(screen.queryByText(/photo_001/) === null).toBe(true);
    const clips = document.querySelectorAll(".ed-clip-slot");
    expect(clips[0]?.className).toContain("ed-clip-warn");
  });

  test("MONTAGE_INVALID says what the engine found wrong, and highlights its frames", async () => {
    await refused({ code: "MONTAGE_INVALID", issues: [{ code: "cell-empty", path: ["clips", 0, "cell"] }] });
    await screen.findByText(/Монтаж не готов к рендеру: исправьте отмеченные проблемы\. В кадре есть пустая ячейка/);
    expect(document.querySelectorAll(".ed-clip-slot")[0]?.className).toContain("ed-clip-warn");
  });

  test("NOT_FOUND is a refusal the owner can read, and the notice closes", async () => {
    await refused({ code: "NOT_FOUND" });
    await screen.findByText(/Запрошенный объект не найден/);
    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(screen.queryByText(/Запрошенный объект не найден/) === null).toBe(true);
  });

  test("a refused render is not a failed job: no «Повторить рендер», the plain button retries", async () => {
    await refused({ code: "RENDER_QUEUE_FULL", detail: "the render queue is full: 20 renders are already queued or running" });
    await screen.findByText(/В очереди уже 20\sрендеров/);
    expect(screen.queryByRole("button", { name: "Повторить рендер" }) === null).toBe(true);
    expect(isDisabled(renderButton())).toBe(false);
  });
});

describe("an answer that never came", () => {
  test("the job is found by its draft from the events, whatever the answer said: the button shows the running render", async () => {
    const { client, engine, scheduler } = await studio();
    const made = await makeDraft(client, MIA.avatarId, [P(0), P(1)]);
    await openEditor();
    engine.failNext("videos.render", { code: "INTERNAL", detail: `${NO_ANSWER_DETAIL_PREFIX}30 s` });
    await submit();
    // The engine did queue it; only its answer was lost: the job arrives as events and in the snapshot.
    await asAnotherWindow(() => client.request("videos.render", { montageId: made.montageId }));
    await screen.findByRole("button", { name: /^Рендер · \d+\s%$|^В очереди/ });
    expect(screen.getByRole("button", { name: "Отменить рендер" })).toBeDefined();
    runAll(scheduler);
  });

  test("with no job to be found the owner is told it may have been queued, and nothing is retried on its own", async () => {
    const { client, engine } = await studio();
    await makeDraft(client, MIA.avatarId, [P(0), P(1)]);
    await openEditor();
    engine.failNext("videos.render", { code: "INTERNAL", detail: `${NO_ANSWER_DETAIL_PREFIX}30 s` });
    await submit();
    // The job is waited for a moment (the events and snapshot name it) before the owner is told it may exist.
    await screen.findByText(/Движок не ответил вовремя/, {}, { timeout: 4_000 });
    expect(screen.getByText(/посмотрите на экран и в очередь слева/)).toBeDefined();
    expect(callsOf(engine, "videos.render")).toHaveLength(1);
  });
});

describe("the export folder, live", () => {
  test("«Рендер» follows `export.status`: an unplugged folder blocks it with the link, a replugged one frees it", async () => {
    const { client, engine } = await studio();
    await makeDraft(client, MIA.avatarId, [P(0), P(1)]);
    await openEditor();
    expect(isDisabled(renderButton())).toBe(false);

    engine.setExportDisk({ status: "unavailable", reason: "missing" });
    await client.request("export.check", {});
    await flush();
    await screen.findByText(/^Папка «Готовые видео» недоступна/);
    expect(isDisabled(renderButton())).toBe(true);
    expect(within(document.querySelector<HTMLElement>(".ed-head") ?? document.body).getByRole("button", { name: "Настройки" })).toBeDefined();

    engine.setExportDisk({ status: "ok" });
    await client.request("export.check", {});
    await flush();
    await waitFor(() => expect(isDisabled(renderButton())).toBe(false));
  });

  test("a render too big for the free space is refused for that render only: the status stays ok and the button stays ready", async () => {
    const { client, engine } = await studio();
    await makeDraft(client, MIA.avatarId, [P(0), P(1)]);
    await openEditor();
    engine.setExportFreeBytes(1);
    await submit();
    await screen.findByText(/Папка «Готовые видео» недоступна/);
    expect(isDisabled(renderButton())).toBe(false);
  });
});
