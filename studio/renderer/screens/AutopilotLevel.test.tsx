import { describe, expect, test } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { AvatarSummary, PhotoSummary } from "../../shared/engine";
import { freePhotos, MIA, SOFIA } from "../engine/mockEngine.testkit";
import type { MockEngine } from "../engine/mockEngine";
import { callsOf, flush, openSection, setup } from "../testing";
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
  // 2026-10-12, S5.9g (plan s5a3 §13.1; mockup 52): «Смелая» ships, so the row «…«Смелая» disabled» («…появится позже.») now pins the live radio; «Смелая»
  // itself is covered in AutopilotBold.test.tsx.
  test("is a row «Подача · ракурс берётся из сцены» with «Обычная» checked and all three live; no «Ракурсы» any more", async () => {
    world();
    await openAutopilot();
    expect(within(settings()).queryByText("Ракурсы") === null).toBe(true);
    expect(within(settings()).queryByRole("button", { name: "Профиль" }) === null).toBe(true);
    expect(within(settings()).queryByRole("button", { name: "Со спины" }) === null).toBe(true);
    expect(within(levelGroup()).getAllByRole("radio").map((r) => r.getAttribute("value"))).toEqual(["ordinary", "flirty", "bold"]);
    expect(level("Обычная").checked).toBe(true);
    expect(level("Смелая").disabled).toBe(false);
    expect(within(settings()).getByText("ракурс берётся из сцены")).toBeDefined();
    expect(within(settings()).queryByText(BOLD_LATER) === null).toBe(true);
    expect(within(settings()).queryByText(/кокетливые: взгляд, улыбка, поза/) === null).toBe(true);
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

