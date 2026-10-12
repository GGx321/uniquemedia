import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { AvatarSummary, LaunchDraftInput, PhotoSummary } from "../../shared/engine";
import { freePhotos, MIA, SOFIA } from "../engine/mockEngine.testkit";
import type { MockEngine } from "../engine/mockEngine";
import { callsOf, flush, openSection, setup } from "../testing";
import { historyLibrary, octAt } from "./autopilot/historyTestkit";
import { flirtyFrames } from "./photos/level";

// S5.7c (plan s5a2 §6.1, §6.3; mockup 30 of .omc/stage5/design): «Автопилот»'s settings lose «Ракурсы» and gain a «Подача» row («ракурс берётся из
// сцены»): «Обычная» by default, «Кокетливая» with the plan's count of flirty new frames, «Смелая» disabled. The draft carries `level`, never poses; a
// running launch shows its own «Подача», read only.

const BOLD_LATER = "Смелая — ночнушки, бельё и пляж — появится позже.";

function world() {
  const roster: AvatarSummary[] = [MIA, SOFIA];
  const photos: PhotoSummary[] = [...freePhotos(3, MIA), ...freePhotos(2, SOFIA)];
  const utils = setup({ avatars: roster.map((a) => ({ ...a, photoCount: 3, eligibleUnusedCount: 3 })), photos, launchRun: "canned" });
  utils.engine.setRunImagePrice(70_000);
  return utils;
}

async function openAutopilot(): Promise<void> {
  await flush();
  await openSection("Автопилот");
  await screen.findByRole("heading", { level: 1, name: "Автопилот" });
  await flush();
}

function settings(): HTMLElement {
  return screen.getByRole("region", { name: "Настройки запуска" });
}
function levelGroup(): HTMLElement {
  return within(settings()).getByRole("radiogroup", { name: "Подача" });
}
function level(name: "Обычная" | "Кокетливая" | "Смелая"): HTMLInputElement {
  const radio = within(levelGroup()).getByRole("radio", { name });
  if (!(radio instanceof HTMLInputElement)) throw new Error("a level is a native radio");
  return radio;
}
const goButton = (): HTMLElement => screen.getByRole("button", { name: /^(Запустить|Считаем…|Запускаем…|Повторить оценку)/ });

async function choose(name: string): Promise<void> {
  fireEvent.click(within(screen.getByRole("group", { name: /^Аватары/ })).getByRole("button", { name }));
  await flush();
  await waitFor(() => expect(goButton().getAttribute("aria-busy")).toBeNull());
}

/** The plan calls (not the list's probe). */
function planCalls(engine: MockEngine) {
  return callsOf(engine, "autopilot.estimate").filter((c) => !(c.payload.draft.videosPerAvatar === 1 && !c.payload.draft.generate && c.payload.draft.library));
}

describe("«Подача» in «Настройки запуска» (mockup 30)", () => {
  test("is a row «Подача · ракурс берётся из сцены» with «Обычная» checked and «Смелая» disabled; no «Ракурсы» any more", async () => {
    world();
    await openAutopilot();
    expect(within(settings()).queryByText("Ракурсы") === null).toBe(true);
    expect(within(settings()).queryByRole("button", { name: "Профиль" }) === null).toBe(true);
    expect(within(settings()).queryByRole("button", { name: "Со спины" }) === null).toBe(true);
    expect(within(levelGroup()).getAllByRole("radio").map((r) => r.getAttribute("value"))).toEqual(["ordinary", "flirty", "bold"]);
    expect(level("Обычная").checked).toBe(true);
    expect(level("Смелая").disabled).toBe(true);
    expect(within(settings()).getByText("ракурс берётся из сцены")).toBeDefined();
    expect(within(settings()).getByText(BOLD_LATER)).toBeDefined();
    expect(within(settings()).queryByText(/кокетливые: взгляд, улыбка, поза/) === null).toBe(true);
  });

  test("asks the plan with no poses and no level while it is «Обычная»", async () => {
    const { engine } = world();
    await openAutopilot();
    await choose("Mia");
    const draft = planCalls(engine).at(-1)?.payload.draft;
    expect(draft !== undefined && "poses" in draft).toBe(false);
    expect(draft !== undefined && "level" in draft).toBe(false);
  });

  test("«Кокетливая» goes into the plan and the launch as `level`, and says how many of the new frames are flirty", async () => {
    const { engine, client } = world();
    await openAutopilot();
    await choose("Mia");
    fireEvent.click(level("Кокетливая"));
    await flush();
    await waitFor(() => expect(planCalls(engine).at(-1)?.payload.draft.level).toBe("flirty"));
    await waitFor(() => expect(goButton().getAttribute("aria-busy")).toBeNull());
    const draft = planCalls(engine).at(-1)?.payload.draft;
    if (draft === undefined) throw new Error("no plan was asked");
    expect("poses" in draft).toBe(false);
    // The plan's own new photos, per avatar, over the launch's categories (I5.28).
    const reply = await client.request("autopilot.estimate", { draft });
    if (!reply.ok) throw new Error("estimate refused");
    const { preview } = reply.result;
    const flirty = preview.avatars.filter((a) => a.blocked === null).reduce((sum, a) => sum + flirtyFrames(a.toGenerate, draft.categories), 0);
    expect(preview.totals.toGenerate).toBeGreaterThan(0);
    expect(within(settings()).getByText(new RegExp(`^≈ ${flirty} из ${preview.totals.toGenerate}\\s(нового кадра|новых кадров) — кокетливые: взгляд, улыбка, поза\\. Одежда — из категорий\\.$`))).toBeDefined();
    fireEvent.click(goButton());
    await flush();
    const started = callsOf(engine, "autopilot.start").at(-1)?.payload.draft;
    expect(started?.level).toBe("flirty");
    expect(started !== undefined && "poses" in started).toBe(false);
  });
});

describe("a launch's page (mockup 31)", () => {
  /** One ended launch of Mia's, as the history keeps it, its page open. */
  async function openLaunch(draft: Partial<LaunchDraftInput>): Promise<string[]> {
    const h = setup(historyLibrary());
    h.engine.seedLaunch({
      createdAt: octAt(11, 14, 2),
      endedAt: octAt(11, 14, 31),
      draft: { avatarIds: [MIA.avatarId], videosPerAvatar: 1, categories: ["home", "shoot", "glam"], ...draft },
      videos: [{ avatarId: MIA.avatarId, shape: "single", size: 1, state: "done", durationMs: 8_000, bytes: 2_000_000 }],
    });
    await openAutopilot();
    fireEvent.click(screen.getByRole("button", { name: /^История запусков/ }));
    await screen.findByRole("heading", { level: 1, name: "История запусков" });
    await flush();
    fireEvent.click(within(screen.getByRole("region", { name: "Запуски" })).getAllByRole("button", { name: /^Запуск / })[0] ?? document.body);
    await screen.findByRole("heading", { level: 1, name: "Запуск 11 окт., 14:02" });
    await flush();
    return Array.from(document.querySelectorAll(".ap-launch-bits > span")).map((s) => `${s.textContent ?? ""}${s.classList.contains("ap-bit-new") ? " [new]" : ""}`);
  }

  test("«Подача: кокетливая» after the categories, a brighter bit; no angles phrase", async () => {
    const bits = await openLaunch({ level: "flirty" });
    expect(bits.slice(2, 4)).toEqual(["Дом, Улица, Гламур", "Подача: кокетливая [new]"]);
    expect(bits.some((bit) => /анфас|профиль|со спины/.test(bit))).toBe(false);
  });

  test("a launch from before «Подача» names neither its «Ракурсы» nor a «Подача», with the new names of its categories", async () => {
    const bits = await openLaunch({ poses: { profile: true, back: false } });
    expect(bits[2]).toBe("Дом, Улица, Гламур");
    expect(bits.some((bit) => bit.startsWith("Подача") || /анфас|профиль|со спины/.test(bit))).toBe(false);
  });
});

describe("a running launch's «Подача», read only", () => {
  async function startLaunch(over: Partial<LaunchDraftInput>): Promise<void> {
    const { client } = world();
    await flush();
    const draft: LaunchDraftInput = {
      avatarIds: [SOFIA.avatarId],
      videosPerAvatar: 1,
      mix: { single: 100, collage: 0, slides: 0 },
      categories: ["home"],
      library: true,
      generate: true,
      sceneReview: false,
      stickers: false,
      ...over,
    };
    await act(async () => {
      const estimate = await client.request("autopilot.estimate", { draft });
      if (!estimate.ok) throw new Error("estimate refused");
      const started = await client.request("autopilot.start", { draft: { ...draft, planSeed: estimate.result.preview.planSeed }, acceptedWorstMicros: estimate.result.preview.estimate.worstMicros });
      if (!started.ok) throw new Error("start refused");
    });
    await openAutopilot();
  }

  test("shows «Кокетливая» for a flirty launch; a click changes nothing", async () => {
    await startLaunch({ level: "flirty" });
    expect(level("Кокетливая").checked).toBe(true);
    expect(level("Кокетливая").getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(level("Обычная"));
    await flush();
    expect(level("Кокетливая").checked).toBe(true);
  });

  test("shows «Обычная» for a launch from before «Подача», which still carries «Ракурсы»", async () => {
    await startLaunch({ poses: { profile: true, back: false } });
    expect(level("Обычная").checked).toBe(true);
    expect(within(settings()).queryByRole("button", { name: "Профиль" }) === null).toBe(true);
  });
});
