import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { type MediaSummary } from "../../shared/engine";
import type { MockEngine } from "../engine/mockEngine";
import { demoTracks } from "../engine/mockMusicStore";
import { freePhotos, MIA } from "../engine/mockEngine.testkit";
import { callsOf, describeElement, flush, focusedLabel, openSection, setup } from "../testing";
import { media, mineStudio, openMine, seedMine } from "./montage/mineScreenKit";
import { WORLD_DEBOUNCE_MS } from "./autopilot/useLaunchPlan";

// S4.9c: «для автопилота» on the owner's own tracks (plan §7; ApPlanMusic; LaunchStates «Музыка»): the chip «Тренды + мои · N треков» opens «Музыка для
// автопилота» — the trends that fit (none marked E), the own tracks with their mark (`media.setForAutopilot`, free, saved at once), and when the trends
// refresh by themselves; not modal, the plan behind it asked again. «Мои треки…» of the waiting-music notice opens the same window, and the editor's «Мои» has
// the same mark.

const NBSP = " ";
const MUSIC_KEY = { stored: true, last4: "7c1e", rejected: false };

/** Mia (31 free photos), 22 stored trends (3 of them marked E), 9 requests sent in the window, and four own tracks of which two are marked. */
async function openAutopilot(): Promise<{ engine: MockEngine; client: ReturnType<typeof setup>["client"]; tracks: MediaSummary[] }> {
  const photos = freePhotos(31, MIA);
  const h = setup({ avatars: [{ ...MIA, photoCount: 31, eligibleUnusedCount: 31 }], photos, musicKey: MUSIC_KEY, music: { tracks: demoTracks(22), sendsDaysAgo: [1, 2, 3, 4, 5, 6, 7, 8, 9] } });
  h.engine.setRunImagePrice(70_000);
  h.engine.seedOwnMedia([
    { kind: "audio", name: "intro-theme.mp3", bytes: 900_000, facts: { durationMs: 60_000 }, createdAt: "2026-10-01T10:00:00.000Z" },
    { kind: "audio", name: "voice-memo.m4a", bytes: 90_000, facts: { durationMs: 8_000 }, createdAt: "2026-10-01T10:01:00.000Z" },
    { kind: "audio", name: "lofi-bed.m4a", bytes: 1_400_000, facts: { durationMs: 90_000 }, createdAt: "2026-10-01T10:02:00.000Z" },
    { kind: "audio", name: "summer-loop.m4a", bytes: 700_000, facts: { durationMs: 42_000 }, createdAt: "2026-10-01T10:03:00.000Z" },
  ]);
  let tracks: MediaSummary[] = [];
  await act(async () => {
    const listed = await h.client.request("media.list", { kind: "audio" });
    if (!listed.ok) throw new Error(listed.error.code);
    tracks = listed.result.media;
    for (const name of ["summer-loop.m4a", "lofi-bed.m4a"]) await h.client.request("media.setForAutopilot", { mediaId: tracks.find((t) => t.name === name)?.mediaId ?? "", on: true });
  });
  await flush();
  await openSection("Автопилот");
  await screen.findByRole("heading", { level: 1, name: "Автопилот" });
  await flush();
  // Mia chosen: the plan is asked, and with it the music's figures.
  fireEvent.click(within(screen.getByRole("group", { name: /^Аватары/ })).getByRole("button", { name: "Mia" }));
  await waitFor(() => expect(callsOf(h.engine, "autopilot.estimate").some((c) => c.payload.draft.avatarIds.length === 1)).toBe(true));
  await flush();
  await flush();
  return { engine: h.engine, client: h.client, tracks };
}

const chip = (): HTMLElement => screen.getByRole("button", { name: /^Тренды \+ мои/ });
const dialog = (): HTMLElement => screen.getByRole("dialog", { name: "Музыка для автопилота" });
const mark = (name: string): HTMLElement => within(dialog()).getByRole("switch", { name: `Для автопилота: ${name}` });

describe("«Музыка для автопилота»", () => {
  test("the chip says the tracks the plan can take and opens the window: trends that fit, the own tracks with their marks, the auto refresh", async () => {
    await openAutopilot();
    expect(chip().textContent).toBe(`Тренды + мои · 21${NBSP}трек`);
    expect(chip().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(chip());
    await flush();
    expect(chip().getAttribute("aria-expanded")).toBe("true");
    const pop = dialog();
    expect(pop.getAttribute("aria-modal")).toBe("false");
    expect(pop.querySelector(".ap-music-part .ap-music-row")?.textContent).toBe("Тренды19 подходят");
    expect(pop.querySelector(".ap-music-part .ap-music-note")?.textContent).toBe(`Сохранённые тренды без пометки E — 3${NBSP}трека с пометкой пропускаем. Тренд, что реже всего был у аватара, — первым.`);
    expect(pop.querySelector(".ap-music-own .ap-music-row")?.textContent).toBe("Мои треки2 из 4 отмечены");
    expect(within(pop).getAllByRole("switch").map((s) => `${s.getAttribute("aria-label")}=${s.getAttribute("aria-checked")}`)).toEqual([
      "Для автопилота: summer-loop.m4a=true",
      "Для автопилота: lofi-bed.m4a=true",
      "Для автопилота: voice-memo.m4a=false",
      "Для автопилота: intro-theme.mp3=false",
    ]);
    expect(Array.from(pop.querySelectorAll(".ap-trk-note")).map((n) => n.textContent)).toEqual(["0:42", "1:30", `0:08 · короче 10${NBSP}с — только для коротких`, "1:00"]);
    expect(pop.querySelector(".ap-music-foot .ap-music-note")?.textContent).toBe("Тренды свежие — при запуске обновлять не нужно. Осталось 21 из 30 запросов.");
    // It opens with the focus on the first mark (the design's keyboard table).
    expect(focusedLabel()).toBe(describeElement(mark("summer-loop.m4a")));
  });

  test("a mark is saved at once and free; the window counts it, and the plan behind it is asked again", async () => {
    const { engine, tracks } = await openAutopilot();
    fireEvent.click(chip());
    await flush();
    const estimates = callsOf(engine, "autopilot.estimate").length;
    fireEvent.click(mark("lofi-bed.m4a"));
    await flush();
    expect(callsOf(engine, "media.setForAutopilot").at(-1)?.payload).toEqual({ mediaId: tracks.find((t) => t.name === "lofi-bed.m4a")?.mediaId ?? "(none)", on: false });
    await waitFor(() => expect(mark("lofi-bed.m4a").getAttribute("aria-checked")).toBe("false"));
    expect(dialog().querySelector(".ap-music-own .ap-music-row")?.textContent).toBe("Мои треки1 из 4 отмечен");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, WORLD_DEBOUNCE_MS + 400));
    });
    await flush();
    expect(callsOf(engine, "autopilot.estimate").length).toBeGreaterThan(estimates);
    await waitFor(() => expect(chip().textContent).toBe(`Тренды + мои · 20${NBSP}треков`));
    expect(callsOf(engine, "autopilot.start")).toHaveLength(0);
  });

  test("a track the render cannot read (not an m4a): the engine refuses the mark, and the row says so from then on", async () => {
    const { engine } = await openAutopilot();
    fireEvent.click(chip());
    await flush();
    engine.failNext("media.setForAutopilot", { code: "MEDIA_UNSUPPORTED", mediaReason: "format", detail: "only an m4a track can be marked for the autopilot" });
    fireEvent.click(mark("intro-theme.mp3"));
    await flush();
    expect(mark("intro-theme.mp3").getAttribute("aria-disabled")).toBe("true");
    expect(mark("intro-theme.mp3").getAttribute("aria-checked")).toBe("false");
    expect(mark("intro-theme.mp3").closest("li")?.querySelector(".ap-trk-note")?.textContent).toBe("не m4a — отметить нельзя");
    const sent = callsOf(engine, "media.setForAutopilot").length;
    fireEvent.click(mark("intro-theme.mp3"));
    await flush();
    expect(callsOf(engine, "media.setForAutopilot").length).toBe(sent);
  });

});

describe("«для автопилота» in the editor's «Мои»", () => {
  test("each own track has the mark (aria-pressed): a click saves it, free; the row follows the library's word; the line under the list says what it is", async () => {
    const { engine, client } = await mineStudio();
    seedMine(engine);
    await openMine(engine, client);
    const tracks = within(media()).getByRole("list", { name: "Свои треки" });
    const flag = (name: string): HTMLElement => within(tracks).getByRole("button", { name: `Для автопилота: ${name}` });
    expect([flag("voice-note.m4a").getAttribute("aria-pressed"), flag("summer-edit.mp3").getAttribute("aria-pressed")]).toEqual(["false", "false"]);
    fireEvent.click(flag("summer-edit.mp3"));
    await flush();
    expect(callsOf(engine, "media.setForAutopilot").map((c) => c.payload)).toEqual([{ mediaId: "media-demo-0003", on: true }]);
    await waitFor(() => expect(flag("summer-edit.mp3").getAttribute("aria-pressed")).toBe("true"));
    expect(flag("summer-edit.mp3").textContent).toBe("для автопилота");
    expect(within(media()).getByText("«для автопилота» — автопилот может брать трек в свои видео. В этот монтаж трек ставится как раньше — кликом по строке.")).toBeDefined();
    // The mark is not the montage's: the draft's music is untouched.
    expect(callsOf(engine, "montages.save")).toHaveLength(0);
    fireEvent.click(flag("summer-edit.mp3"));
    await flush();
    await waitFor(() => expect(flag("summer-edit.mp3").getAttribute("aria-pressed")).toBe("false"));
  });

});
