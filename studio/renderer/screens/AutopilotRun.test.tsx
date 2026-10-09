import { describe, expect, test } from "bun:test";
import { act, screen, within } from "@testing-library/react";
import type { LaunchDraftInput, LaunchView } from "../../shared/engine";
import { freePhotos, MIA } from "../engine/mockEngine.testkit";
import type { MockTrackSeed } from "../engine/mockMusicStore";
import { flush, openSection, setup, tick } from "../testing";

// Stage 4, S4.8: the window against the mock that RUNS a launch on its clock (not the canned one the older screen tests use): the card moves by itself from «Идёт запуск» to «Запуск
// завершён», the history counts the videos the launch made (S4.6g L6: «Результаты · 0» when the mock's videos had no record), and a hold the testkit raises is on the card.

const TRACK: MockTrackSeed = { trackId: "track-run-0001", title: "Run track", artist: "Run artist", durationMs: 12_000, explicit: false, highlightsMs: [1_500], hasCover: false, peaks: Array.from({ length: 240 }, (_, i) => (i * 7) % 1001) };

async function started(over: Partial<LaunchDraftInput> = {}) {
  const photos = freePhotos(6, MIA);
  const { engine, client, scheduler } = setup({ avatars: [{ ...MIA, photoCount: 6, eligibleUnusedCount: 6 }], photos, sceneReview: "off" });
  engine.setRunImagePrice(50_000);
  engine.seedMusicTracks([TRACK]);
  await flush();
  const draft: LaunchDraftInput = {
    avatarIds: [MIA.avatarId],
    videosPerAvatar: 2,
    mix: { single: 0, collage: 0, slides: 100 },
    categories: ["home"],
    poses: { profile: false, back: false },
    library: false,
    generate: true,
    sceneReview: false,
    stickers: false,
    ...over,
  };
  const answers: LaunchView[] = [];
  await act(async () => {
    const estimate = await client.request("autopilot.estimate", { draft });
    if (!estimate.ok) throw new Error(`estimate refused: ${estimate.error.code}`);
    const reply = await client.request("autopilot.start", { draft: { ...draft, planSeed: estimate.result.preview.planSeed }, acceptedWorstMicros: estimate.result.preview.estimate.worstMicros });
    if (!reply.ok) throw new Error(`start refused: ${reply.error.code}`);
    answers.push(reply.result.launch);
  });
  await openSection("Автопилот");
  await screen.findByRole("heading", { level: 1, name: "Автопилот" });
  await flush();
  const [launch] = answers;
  if (launch === undefined) throw new Error("no launch");
  return { engine, client, scheduler, launch };
}

const card = (): HTMLElement => {
  const live = document.getElementById("ap-live");
  if (live === null) throw new Error("no live card");
  return live;
};

describe("the window against a launch the mock runs", () => {
  test("the card starts at «Идёт запуск» with the avatar still to do, moves with the mock's clock and ends at «Запуск завершён» with the results counted", async () => {
    const { scheduler } = await started();
    expect(within(card()).getByRole("heading", { level: 2, name: "Идёт запуск" })).toBeDefined();
    expect(within(card()).queryByRole("button", { name: /^Результаты/ }) === null).toBe(true);
    for (let i = 0; i < 40 && document.getElementById("ap-live")?.querySelector("h2")?.textContent !== "Запуск завершён"; i++) {
      tick(scheduler, 1);
      await flush();
    }
    expect(within(card()).getByRole("heading", { level: 2, name: "Запуск завершён" })).toBeDefined();
    expect(within(card()).getByRole("button", { name: "Результаты · 2" })).toBeDefined();
  });

  test("a hold the testkit raises is on the card with its fix, and «Продолжить» clears it", async () => {
    const { engine, scheduler } = await started();
    act(() => engine.failLaunchPaidStep("credits"));
    tick(scheduler, 2);
    await flush();
    expect(within(card()).getByRole("heading", { level: 2, name: "Идёт запуск" })).toBeDefined();
    const title = Array.from(card().querySelectorAll(".notice-title")).map((t) => t.textContent);
    expect(title).toContain("Пополните баланс OpenRouter");
  });

  test("«Пауза» with nothing in flight pauses at once, and the window shows the pause", async () => {
    const { client, launch } = await started();
    await act(async () => {
      await client.request("autopilot.pause", { launchId: launch.launchId });
    });
    await flush();
    expect(within(card()).getByRole("heading", { level: 2, name: "Запуск на паузе" })).toBeDefined();
  });
});
