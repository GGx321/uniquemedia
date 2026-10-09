import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MIA } from "../engine/mockEngine.testkit";
import { callsOf, describeElement, flush, focusedLabel, runAll, setup } from "../testing";
import { historyLibrary, octAt } from "./autopilot/historyTestkit";
import { MARKS_UNKNOWN } from "./photos/DeleteVideoDialog";

// S4.9c: the «Видео» tab of «Фото» with the autopilot (PhotoVideos; HostStates «Фото», the video tile; plan §8.4, §8.5, §17 Q4): a video the autopilot made
// carries «автопилот» and is «Видео N» (it has no draft, so no «Изменить»); every video has «Опубликовано» and its mark on the frame; «Скрыть опубликованные»;
// marks that cannot be read are said; the trash asks with two ways, «и отклонить фото» chosen for a published video, and a delete that fails reads the lists again.

/** Mia with two videos of a launch (the first published) and one of her own montage, on her «Видео» tab. */
async function openVideos(before: (engine: ReturnType<typeof setup>["engine"]) => void = () => undefined) {
  const h = setup(historyLibrary());
  const seeded = h.engine.seedLaunch({
    createdAt: octAt(8, 14, 2),
    endedAt: octAt(8, 14, 31),
    draft: { avatarIds: [MIA.avatarId], videosPerAvatar: 2 },
    videos: [
      { avatarId: MIA.avatarId, shape: "single", size: 1, state: "done", durationMs: 7_000, bytes: 1_700_000, track: { source: "trending", title: "Golden Hour Loop", artist: "Lumi" }, published: true },
      { avatarId: MIA.avatarId, shape: "collage", size: 3, state: "done", durationMs: 8_500, bytes: 2_300_000, track: { source: "own", title: "lofi-bed.m4a", artist: null } },
    ],
  });
  before(h.engine);
  await act(async () => {
    const made = await h.client.request("montages.create", { avatarId: MIA.avatarId, photoIds: ["photo-mia-0011", "photo-mia-0012"] });
    if (!made.ok) throw new Error(made.error.code);
    await h.client.request("montages.save", { montageId: made.result.montage.montageId, spec: made.result.montage.spec, name: "утро дома" });
    const render = await h.client.request("videos.render", { montageId: made.result.montage.montageId });
    if (!render.ok) throw new Error(render.error.code);
    runAll(h.scheduler);
  });
  await flush();
  fireEvent.click(await screen.findByRole("button", { name: "Mia" }));
  await screen.findByRole("heading", { level: 1, name: "Mia" });
  await flush();
  fireEvent.click(screen.getByRole("tab", { name: "Видео" }));
  await flush();
  await flush();
  return { ...h, videoIds: seeded.videoIds };
}

const card = (name: string): HTMLElement => screen.getByRole("article", { name });
const cards = (): string[] => screen.queryAllByRole("article").map((el) => el.querySelector(".video-name")?.textContent ?? "");
const published = (name: string): HTMLElement => within(card(name)).getByRole("switch", { name: `Опубликовано: ${name}` });

describe("«Видео» on «Фото» with the autopilot", () => {
  test("a video of the autopilot: «Видео N» with «автопилот», no «Изменить»; the owner's own keeps its name and «Изменить»; every one has «Опубликовано»", async () => {
    await openVideos();
    expect(cards()).toEqual(["утро дома", "Видео 2", "Видео 1"]);
    const auto = card("Видео 1");
    expect(auto.querySelector(".video-ap-tag")?.textContent).toBe("автопилот");
    expect(within(auto).queryByRole("button", { name: "Изменить" }) === null).toBe(true);
    expect(published("Видео 1").getAttribute("aria-checked")).toBe("true");
    expect(auto.querySelector(".video-pub-mark") !== null).toBe(true);
    const own = card("утро дома");
    expect(own.querySelector(".video-ap-tag") === null).toBe(true);
    expect(within(own).getByRole("button", { name: "Изменить" })).toBeDefined();
    expect(published("утро дома").getAttribute("aria-checked")).toBe("false");
  });

  test("«Опубликовано» sends the mark by id and the card follows; «Скрыть опубликованные N» hides the published ones", async () => {
    const { engine, videoIds } = await openVideos();
    expect(document.querySelector(".videos-hide")?.textContent).toBe("Скрыть опубликованные 1");
    fireEvent.click(published("Видео 2"));
    await flush();
    expect(callsOf(engine, "videos.setPublished").map((c) => c.payload)).toEqual([{ videoId: videoIds[1], published: true }]);
    await waitFor(() => expect(published("Видео 2").getAttribute("aria-checked")).toBe("true"));
    expect(document.querySelector(".videos-hide")?.textContent).toBe("Скрыть опубликованные 2");
    fireEvent.click(screen.getByRole("switch", { name: /^Скрыть опубликованные/ }));
    expect(cards()).toEqual(["утро дома"]);
    // Marked while they are hidden: the card leaves, and the focus goes to the tab's heading, as after a delete.
    const own = published("утро дома");
    own.focus();
    fireEvent.click(own);
    await flush();
    await waitFor(() => expect(cards()).toEqual([]));
    expect(focusedLabel()).toBe(describeElement(screen.getByRole("heading", { level: 2, name: "Видео" })));
  });

  test("marks that cannot be read: the notice, every video unmarked; a mark heals the log and the list is read again", async () => {
    const { engine } = await openVideos((mock) => mock.tearPublishedLog(MIA.avatarId));
    expect(screen.getByText("Отметки «Опубликовано» не читаются — все видео показаны без отметки. Studio по ним ничего не удаляет; новая отметка допишется.")).toBeDefined();
    expect(published("Видео 1").getAttribute("aria-checked")).toBe("false");
    const reads = callsOf(engine, "videos.list").length;
    fireEvent.click(published("Видео 2"));
    await flush();
    await flush();
    expect(callsOf(engine, "videos.list").length).toBeGreaterThan(reads);
    await waitFor(() => expect(published("Видео 1").getAttribute("aria-checked")).toBe("true"));
    expect(screen.queryByText(/не читаются/) === null).toBe(true);
  });

  test("marks that cannot be read: the delete starts on the plain way and the dialog says the mark is not read (fix round 1)", async () => {
    await openVideos((mock) => mock.tearPublishedLog(MIA.avatarId));
    fireEvent.click(within(card("Видео 1")).getByRole("button", { name: /^Удалить видео / }));
    const dialog = await screen.findByRole("alertdialog", { name: "Удалить видео 1?" });
    expect(within(dialog).getByRole("radio", { name: /^Только удалить видео/ }).getAttribute("aria-checked")).toBe("true");
    expect(dialog.querySelector(".ap-del-marks")?.textContent?.trim()).toBe(MARKS_UNKNOWN);
    expect(within(card("Видео 1")).getByRole("button", { name: /^Удалить видео / }).classList.contains("video-trash-on")).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Отмена" }));
    await flush();
    expect(within(card("Видео 1")).getByRole("button", { name: /^Удалить видео / }).classList.contains("video-trash-on")).toBe(false);
  });

  test("marks that read: the dialog says nothing of them", async () => {
    await openVideos();
    fireEvent.click(within(card("Видео 2")).getByRole("button", { name: /^Удалить видео / }));
    const dialog = await screen.findByRole("alertdialog", { name: "Удалить видео 2?" });
    expect(dialog.querySelector(".ap-del-marks") === null).toBe(true);
  });

  test("deleting a published video: «Удалить видео и отклонить фото» is chosen; the photos are rejected and it is said", async () => {
    const { engine, videoIds } = await openVideos();
    fireEvent.click(within(card("Видео 1")).getByRole("button", { name: /^Удалить видео / }));
    const dialog = await screen.findByRole("alertdialog", { name: "Удалить видео 1?" });
    expect(within(dialog).getByRole("radio", { name: /^Удалить видео и отклонить фото/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(dialog).getByRole("button", { name: "Удалить и отклонить фото" }));
    await flush();
    expect(callsOf(engine, "videos.delete").map((c) => c.payload)).toEqual([{ videoId: videoIds[0], mode: "video", rejectPhotos: true }]);
    // The card goes; the numbers are places among the avatar's videos, so the one left is «Видео 1» now.
    await waitFor(() => expect(cards()).toEqual(["утро дома", "Видео 1"]));
    // The matcher compares the text with its spaces collapsed: the no-break space reads as a plain one.
    expect(screen.getByText("Видео 1 удалено, 1 фото отклонено.")).toBeDefined();
    expect(within(card("Видео 1")).getByRole("switch", { name: "Опубликовано: Видео 1" }).getAttribute("aria-checked")).toBe("false");
  });

  // S4.6g round 1, M3: a delete that timed out says `outcome: "unknown"` in every mode; none of them reads as a definite failure of the export folder, with a link to Settings.
  test("a plain delete that timed out (outcome unknown): the unconfirmed words, no Settings link, the list and the photos read again", async () => {
    const { engine } = await openVideos();
    engine.failNext("videos.delete", { code: "EXPORT_UNAVAILABLE", exportReason: "not-writable", outcome: "unknown" });
    const reads = callsOf(engine, "videos.list").length;
    fireEvent.click(within(card("Видео 2")).getByRole("button", { name: /^Удалить видео / }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Удалить видео" }));
    await flush();
    await flush();
    const alert = screen.getByRole("alert");
    expect(alert.querySelector(".notice-title")?.textContent).toBe("Удаление не подтвердилось — списки прочитаны заново");
    expect(alert.textContent).toContain("а удаление могло дойти до конца");
    expect(alert.textContent ?? "").not.toContain("нельзя записывать");
    expect(screen.queryByRole("button", { name: /в Настройках/ }) === null).toBe(true);
    expect(callsOf(engine, "videos.list").length).toBeGreaterThan(reads);
  });

  test("«Удалить запись» that timed out (outcome unknown): the same, not a definite failure of the folder", async () => {
    const { engine, videoIds } = await openVideos();
    engine.setVideoFileState(videoIds[1] ?? "", "missing");
    fireEvent.click(screen.getByRole("tab", { name: "Фото" }));
    fireEvent.click(screen.getByRole("tab", { name: "Видео" }));
    await flush();
    engine.failNext("videos.delete", { code: "EXPORT_UNAVAILABLE", exportReason: "not-writable", outcome: "unknown" });
    fireEvent.click(within(card("Видео 2")).getByRole("button", { name: "Удалить запись" }));
    await flush();
    await flush();
    const alert = screen.getByRole("alert");
    expect(alert.querySelector(".notice-title")?.textContent).toBe("Удаление не подтвердилось — списки прочитаны заново");
    expect(alert.textContent).toContain("а удаление могло дойти до конца");
    expect(screen.queryByRole("button", { name: /в Настройках/ }) === null).toBe(true);
  });

  test("a delete with the photos rejected that fails: its own words, and the list and the avatar's photos are read again", async () => {
    const { engine } = await openVideos();
    engine.failNext("videos.delete", { code: "EXPORT_UNAVAILABLE", exportReason: "not-writable" });
    const reads = callsOf(engine, "videos.list").length;
    const avatarReads = callsOf(engine, "avatars.list").length;
    fireEvent.click(within(card("Видео 1")).getByRole("button", { name: /^Удалить видео / }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Удалить и отклонить фото" }));
    await flush();
    await flush();
    const alert = screen.getByRole("alert");
    // Fix round 1: never «не удалено» — a timeout reads the same while the delete may still go on; the lists, read again, show what stands.
    expect(alert.querySelector(".notice-title")?.textContent).toBe("Удаление не подтвердилось — списки прочитаны заново");
    expect(alert.textContent).toContain("Фото, что успели уйти в «Отклонённые», там и останутся.");
    expect(alert.textContent ?? "").not.toContain("не удалено");
    expect(callsOf(engine, "videos.list").length).toBeGreaterThan(reads);
    expect(callsOf(engine, "avatars.list").length).toBeGreaterThan(avatarReads);
    expect(cards().includes("Видео 1")).toBe(true);
  });
});
