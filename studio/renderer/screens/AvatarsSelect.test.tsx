import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { AvatarSummary, LaunchDraftInput, PhotoSummary } from "../../shared/engine";
import { freePhotos, MIA, NORA, SOFIA } from "../engine/mockEngine.testkit";
import { callsOf, describeElement, flush, focusedLabel, setup } from "../testing";

// S4.9c: several avatars chosen on «Аватары» (Main.dc.html; MainS4-selected → ApFromMain; plan §13 item 13, §18): a box on each active avatar's tile —
// Space chooses, Shift with a click or with Space chooses the run from the last box —, the bar «Выбрано: N · M неиспользованных фото» with «Снять выбор»
// and «Автопилот для выбранных», which opens «Автопилот» with them chosen. The mockup's paid «Сгенерировать фото» for several avatars is not in the plan.

const NBSP = " ";
const ELENA: AvatarSummary = { ...MIA, avatarId: "avatar-elena-0004", name: "Elena", masterPhotoId: "photo-elena-master" };
const AVA: AvatarSummary = { ...MIA, avatarId: "avatar-ava-0005", name: "Ava", masterPhotoId: "photo-ava-master" };

/** Mia 31 unused photos, Sofia 12, Elena 20, Ava 9 (her usage cannot be read when `avaUnknown`), Nora archived. */
async function openAvatars({ avaUnknown = false } = {}) {
  const counts: Record<string, number> = { [MIA.avatarId]: 31, [SOFIA.avatarId]: 12, [ELENA.avatarId]: 20, [AVA.avatarId]: 9, [NORA.avatarId]: 4 };
  const roster = [MIA, SOFIA, ELENA, AVA, NORA];
  const photos: PhotoSummary[] = roster.flatMap((a) => freePhotos(counts[a.avatarId] ?? 0, a));
  const avatars = roster.map((a) => ({
    ...a,
    photoCount: counts[a.avatarId] ?? 0,
    eligibleUnusedCount: counts[a.avatarId] ?? 0,
    ...(a === AVA && avaUnknown ? { usage: { state: "unknown" as const, reasons: ["record-unreadable" as const] } } : {}),
  }));
  const h = setup({ avatars, photos });
  await screen.findByRole("heading", { level: 1, name: "Аватары" });
  await flush();
  return h;
}

/**
 * What the choice's live region says while `step` runs: it clears itself a moment after it speaks, so its words are recorded as they change (a
 * MutationObserver). One observer per step: happy-dom holds an observer's callback only weakly, and a long-lived one can be collected mid-test.
 */
async function saying(step: () => void): Promise<string[]> {
  const region = document.querySelector('[data-announcer="avatars-chosen"]');
  if (region === null) throw new Error("no live region for the choice");
  const said: string[] = [];
  const watch = new MutationObserver(() => said.push(region.textContent ?? ""));
  watch.observe(region, { childList: true, characterData: true, subtree: true });
  try {
    step();
    await flush();
    return said.filter((text) => text !== "");
  } finally {
    watch.disconnect();
  }
}

const box = (name: string): HTMLElement => screen.getByRole("button", { name: `Выбрать ${name}` });
const pressed = (): string[] => screen.queryAllByRole("button", { name: /^Выбрать /, pressed: true }).map((b) => (b.getAttribute("aria-label") ?? "").slice("Выбрать ".length));
const bar = (): HTMLElement => screen.getByRole("region", { name: "Выбранные аватары" });

describe("choosing avatars on «Аватары»", () => {
  test("every active avatar has its box, the archived one none; nothing is chosen and there is no bar at first", async () => {
    await openAvatars();
    expect(["Mia", "Sofia", "Elena", "Ava"].map((name) => box(name).getAttribute("aria-pressed"))).toEqual(["false", "false", "false", "false"]);
    expect(screen.queryByRole("button", { name: "Выбрать Nora" }) === null).toBe(true);
    expect(screen.queryByRole("region", { name: "Выбранные аватары" }) === null).toBe(true);
  });

  test("a click (Space on the box) chooses one; the bar counts it and its unused photos; a second click takes it back", async () => {
    await openAvatars();
    fireEvent.click(box("Mia"));
    expect(pressed()).toEqual(["Mia"]);
    expect(bar().querySelector(".avatars-sel-n")?.textContent).toBe("Выбрано: 1");
    expect(bar().querySelector(".mono")?.textContent).toBe(`31${NBSP}неиспользованное фото`);
    expect(box("Mia").closest("article")?.classList.contains("avatar-card-chosen")).toBe(true);
    fireEvent.click(box("Sofia"));
    expect(bar().querySelector(".mono")?.textContent).toBe(`43${NBSP}неиспользованных фото`);
    fireEvent.click(box("Mia"));
    expect(pressed()).toEqual(["Sofia"]);
  });

  test("Shift with a click chooses the run from the last box; Shift+Space does the same from the keyboard; the count is said each time", async () => {
    await openAvatars();
    expect(await saying(() => fireEvent.click(box("Mia")))).toEqual(["Выбрано: 1"]);
    expect(await saying(() => fireEvent.click(box("Elena"), { shiftKey: true }))).toEqual(["Выбрано: 3"]);
    expect(pressed()).toEqual(["Mia", "Sofia", "Elena"]);
    expect(await saying(() => fireEvent.keyDown(box("Ava"), { key: " ", shiftKey: true }))).toEqual(["Выбрано: 4"]);
    expect(pressed()).toEqual(["Mia", "Sofia", "Elena", "Ava"]);
    expect(bar().querySelector(".avatars-sel-n")?.textContent).toBe("Выбрано: 4");
    expect(await saying(() => fireEvent.click(within(bar()).getByRole("button", { name: "Снять выбор" })))).toEqual(["Выбор снят"]);
  });

  test("a run from a box taken back clears the run", async () => {
    await openAvatars();
    fireEvent.click(box("Mia"));
    fireEvent.click(box("Sofia"));
    fireEvent.click(box("Elena"));
    fireEvent.click(box("Mia"));
    fireEvent.click(box("Elena"), { shiftKey: true });
    expect(pressed()).toEqual([]);
  });

  test("an avatar whose usage cannot be read counts no unused photos, and the bar says so", async () => {
    await openAvatars({ avaUnknown: true });
    fireEvent.click(box("Elena"));
    fireEvent.click(box("Ava"));
    expect(bar().querySelector(".mono")?.textContent).toBe(`20${NBSP}неиспользованных фото · у 1 неизвестно`);
  });

  test("the bar: «Снять выбор» and «Автопилот для выбранных», no paid «Сгенерировать фото»; «Снять выбор» clears it and gives the focus to the box last toggled", async () => {
    await openAvatars();
    fireEvent.click(box("Mia"));
    fireEvent.click(box("Sofia"));
    expect(within(bar()).getAllByRole("button").map((b) => b.textContent)).toEqual(["Снять выбор", "Автопилот для выбранных"]);
    expect(screen.queryByRole("button", { name: "Сгенерировать фото" }) === null).toBe(true);
    const autopilot = within(bar()).getByRole("button", { name: "Автопилот для выбранных" });
    expect(document.getElementById(autopilot.getAttribute("aria-describedby") ?? "")?.textContent).toBe("откроет «Автопилот» с ними");
    fireEvent.click(within(bar()).getByRole("button", { name: "Снять выбор" }));
    expect(screen.queryByRole("region", { name: "Выбранные аватары" }) === null).toBe(true);
    expect(pressed()).toEqual([]);
    expect(focusedLabel()).toBe(describeElement(box("Sofia")));
  });

  // Fix round 1: a run starts from a box on screen. An anchor archived since gives way to the box Shift-clicked now, and the next Shift-click is a run from it.
  test("an anchor archived since: the Shift-click toggles one box and becomes the anchor; the next Shift-click chooses the run", async () => {
    const { client } = await openAvatars();
    fireEvent.click(box("Mia"));
    await act(async () => {
      const reply = await client.request("avatars.archive", { avatarId: MIA.avatarId });
      if (!reply.ok) throw new Error(reply.error.code);
    });
    await flush();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Выбрать Mia" }) === null).toBe(true));
    fireEvent.click(box("Sofia"), { shiftKey: true });
    expect(pressed()).toEqual(["Sofia"]);
    fireEvent.click(box("Ava"), { shiftKey: true });
    expect(pressed()).toEqual(["Sofia", "Elena", "Ava"]);
  });

  test("an anchor hidden by the search: the same; the bar counts the chosen ones the search hides", async () => {
    await openAvatars();
    fireEvent.click(box("Elena"));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "i" } });
    expect(screen.queryByRole("button", { name: "Выбрать Elena" }) === null).toBe(true);
    fireEvent.click(box("Mia"), { shiftKey: true });
    expect(pressed()).toEqual(["Mia"]);
    fireEvent.click(box("Sofia"), { shiftKey: true });
    expect(pressed()).toEqual(["Mia", "Sofia"]);
    // Elena is still chosen, out of sight: the bar says so, and her photos still count.
    expect(bar().querySelector(".avatars-sel-n")?.textContent).toBe("Выбрано: 3 (1 скрыто поиском)");
    expect(bar().querySelector(".mono")?.textContent).toBe(`63${NBSP}неиспользованных фото`);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    expect(pressed()).toEqual(["Mia", "Sofia", "Elena"]);
    expect(bar().querySelector(".avatars-sel-n")?.textContent).toBe("Выбрано: 3");
  });

  test("chosen avatars the filter hides: the bar says the filter hides them", async () => {
    await openAvatars();
    fireEvent.click(box("Mia"));
    fireEvent.click(box("Sofia"));
    fireEvent.click(screen.getByRole("radio", { name: "Архив" }));
    expect(bar().querySelector(".avatars-sel-n")?.textContent).toBe("Выбрано: 2 (2 скрыто фильтром)");
  });

  test("S4.9d (S4.9c N4): «Архив» with a search typed — the filter is what hides the chosen ones, and the bar says so", async () => {
    await openAvatars();
    fireEvent.click(box("Mia"));
    fireEvent.click(box("Sofia"));
    fireEvent.click(screen.getByRole("radio", { name: "Архив" }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "o" } });
    expect(bar().querySelector(".avatars-sel-n")?.textContent).toBe("Выбрано: 2 (2 скрыто фильтром)");
    // «Активные» with the search: the search is what hides them.
    fireEvent.click(screen.getByRole("radio", { name: "Активные" }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "sof" } });
    expect(bar().querySelector(".avatars-sel-n")?.textContent).toBe("Выбрано: 2 (1 скрыто поиском)");
  });

  test("an avatar archived while chosen leaves the choice", async () => {
    const { client } = await openAvatars();
    fireEvent.click(box("Mia"));
    fireEvent.click(box("Sofia"));
    await act(async () => {
      const reply = await client.request("avatars.archive", { avatarId: SOFIA.avatarId });
      if (!reply.ok) throw new Error(reply.error.code);
    });
    await flush();
    await waitFor(() => expect(pressed()).toEqual(["Mia"]));
    expect(bar().querySelector(".avatars-sel-n")?.textContent).toBe("Выбрано: 1");
  });
});

describe("«Автопилот для выбранных»", () => {
  test("opens «Автопилот» with those avatars chosen, says where they came from, and plans them", async () => {
    const { engine } = await openAvatars();
    fireEvent.click(box("Sofia"));
    fireEvent.click(box("Mia"));
    fireEvent.click(box("Ava"));
    fireEvent.click(within(bar()).getByRole("button", { name: "Автопилот для выбранных" }));
    await screen.findByRole("heading", { level: 1, name: "Автопилот" });
    await flush();
    const column = screen.getByRole("group", { name: /^Аватары/ });
    expect(within(column).getAllByRole("button", { pressed: true }).map((b) => b.getAttribute("aria-label"))).toEqual(["Mia", "Sofia", "Ava"]);
    expect(document.querySelector(".ap-from-main")?.textContent).toBe("Выбраны на экране «Аватары»: 3. Поменять можно здесь.");
    await waitFor(() => expect(callsOf(engine, "autopilot.estimate").some((c) => c.payload.draft.avatarIds.join() === [MIA.avatarId, SOFIA.avatarId, AVA.avatarId].join())).toBe(true));
  });

  // Fix round 1: while a launch is unfinished, «Автопилот» shows that launch's settings — a choice slipped into the next form there would go unseen.
  test("while a launch runs: the bar warns, and «Автопилот» leaves the form alone and says the choice was not put in", async () => {
    const { client, engine } = await openAvatars();
    const draft: LaunchDraftInput = {
      avatarIds: [AVA.avatarId],
      videosPerAvatar: 2,
      mix: { single: 100, collage: 0, slides: 0 },
      categories: ["home"],
      poses: { profile: false, back: false },
      library: true,
      generate: false,
      sceneReview: false,
      stickers: false,
    };
    let launchId = "";
    await act(async () => {
      const estimate = await client.request("autopilot.estimate", { draft });
      if (!estimate.ok) throw new Error(estimate.error.code);
      const reply = await client.request("autopilot.start", { draft: { ...draft, planSeed: estimate.result.preview.planSeed }, acceptedWorstMicros: estimate.result.preview.estimate.worstMicros });
      if (!reply.ok) throw new Error(reply.error.code);
      launchId = reply.result.launch.launchId;
    });
    await flush();
    fireEvent.click(box("Mia"));
    fireEvent.click(box("Sofia"));
    expect(bar().querySelector(".avatars-sel-hint")?.textContent).toBe("запуск не закончен — в форму выбор не попадёт");
    const estimates = callsOf(engine, "autopilot.estimate").length;
    fireEvent.click(within(bar()).getByRole("button", { name: "Автопилот для выбранных" }));
    await screen.findByRole("heading", { level: 1, name: "Автопилот" });
    await flush();
    const column = screen.getByRole("group", { name: /^Аватары/ });
    // The launch's own avatar, as the launch was started; not the two chosen on «Аватары».
    expect(within(column).getAllByRole("button", { pressed: true }).map((b) => b.getAttribute("aria-label"))).toEqual(["Ava"]);
    const said = [...document.querySelectorAll(".ap-from-main")].map((el) => el.textContent);
    expect(said).toEqual(["Выбранные на экране «Аватары» (2) не подставлены: запуск не закончен, и здесь его настройки. Выберите их снова после «Стоп» или конца запуска."]);
    expect(callsOf(engine, "autopilot.estimate").length).toBe(estimates);
    // Once stopped, the next form is the one it was: the choice was never put in.
    await act(async () => {
      const stopped = await client.request("autopilot.stop", { launchId });
      if (!stopped.ok) throw new Error(stopped.error.code);
    });
    await flush();
    await flush();
    expect(within(screen.getByRole("group", { name: /^Аватары/ })).queryAllByRole("button", { pressed: true }).map((b) => b.getAttribute("aria-label"))).not.toEqual(["Mia", "Sofia"]);
    expect(document.querySelector(".ap-from-main") === null).toBe(true);
  });

  test("the line counts the brought avatars still active: one archived since leaves the number, and the last takes the line with it — never «…: 0»", async () => {
    const { client } = await openAvatars();
    fireEvent.click(box("Mia"));
    fireEvent.click(box("Sofia"));
    fireEvent.click(within(bar()).getByRole("button", { name: "Автопилот для выбранных" }));
    await screen.findByRole("heading", { level: 1, name: "Автопилот" });
    await flush();
    expect(document.querySelector(".ap-from-main")?.textContent).toBe("Выбраны на экране «Аватары»: 2. Поменять можно здесь.");
    const archive = async (avatarId: string): Promise<void> => {
      await act(async () => {
        const reply = await client.request("avatars.archive", { avatarId });
        if (!reply.ok) throw new Error(reply.error.code);
      });
      await flush();
    };
    await archive(SOFIA.avatarId);
    await waitFor(() => expect(document.querySelector(".ap-from-main")?.textContent).toBe("Выбраны на экране «Аватары»: 1. Поменять можно здесь."));
    await archive(MIA.avatarId);
    await waitFor(() => expect(document.querySelector(".ap-from-main") === null).toBe(true));
    expect(document.body.textContent ?? "").not.toContain("«Аватары»: 0");
  });
});
