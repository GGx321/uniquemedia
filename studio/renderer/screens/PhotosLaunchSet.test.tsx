import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { LaunchView, PRICE_SCOPES_RU, type AvatarSummary, type LaunchAvatarView, type LaunchDraftInput, type PhotoSummary } from "../../shared/engine";
import type { EngineClient } from "../engine/client";
import type { MockEngine } from "../engine/mockEngine";
import { freePhotos, MIA, SOFIA } from "../engine/mockEngine.testkit";
import { errorText } from "../lib/errors";
import { formatUsdTiered } from "../lib/money";
import { callsOf, describeElement, flush, openSection, setup } from "../testing";

// S4.9b: a launch's scene set on «Фото» (PhotosS4.dc.html: review, review-paused, overplan, drawing; HostStates «Фото»; plan §4.7): the launch's band over
// the set, «Продолжить запуск: M фото» (`autopilot.continueAfterReview` with the view's set and revision) in place of «Отрисовать», «Сцены принять» while
// the launch is paused, no «+ Своя сцена», and «в запуске автопилота» wherever a paid action of the set or its batches would be. The mock's launch names a
// set for each avatar that generates but writes none: the test seeds it (`MockEngine.seedSceneSet`) under the launch's own ids.

const NBSP = "\u00a0";
const ELENA: AvatarSummary = { ...MIA, avatarId: "avatar-elena-0004", name: "Elena", masterPhotoId: "photo-elena-master" };

function library(): { avatars: AvatarSummary[]; photos: PhotoSummary[] } {
  const counts: Record<string, number> = { [MIA.avatarId]: 31, [SOFIA.avatarId]: 4, [ELENA.avatarId]: 14 };
  const roster = [MIA, SOFIA, ELENA];
  return {
    avatars: roster.map((a) => ({ ...a, photoCount: counts[a.avatarId] ?? 0, eligibleUnusedCount: counts[a.avatarId] ?? 0 })),
    photos: roster.flatMap((a) => freePhotos(counts[a.avatarId] ?? 0, a)),
  };
}

interface World {
  readonly engine: MockEngine;
  readonly client: EngineClient;
  readonly launch: LaunchView;
  /** Sofia's row in the launch: she waits for the review of her set. */
  readonly row: LaunchAvatarView;
}

/** A launch with «Сцены на проверку» (Sofia's scenes wait for the owner), her set seeded with `written` of its scenes written, the launch paused if asked. */
async function launchWithSet({ paused = false, written, level, who = SOFIA }: { paused?: boolean; written?: number; level?: "bold"; who?: AvatarSummary } = {}): Promise<World> {
  // This machine's own switch is OFF: a launch's set shows on «Фото» whatever it says.
  // S4.8: written against the mock's CANNED launch (a mid-run state that moves only by clicks); the mock now runs one by default.
  const { engine, client } = setup({ ...library(), sceneReview: "off", launchRun: "canned" });
  engine.setRunImagePrice(70_000);
  await flush();
  const draft: LaunchDraftInput = {
    avatarIds: [MIA.avatarId, SOFIA.avatarId, ELENA.avatarId],
    videosPerAvatar: 10,
    mix: { single: 70, collage: 20, slides: 10 },
    categories: ["home"],
    poses: { profile: false, back: false },
    library: true,
    generate: true,
    sceneReview: true,
    stickers: false,
    ...(level === undefined ? {} : { level }),
  };
  let launch: LaunchView | null = null;
  await act(async () => {
    const estimate = await client.request("autopilot.estimate", { draft });
    if (!estimate.ok) throw new Error("estimate refused");
    const reply = await client.request("autopilot.start", { draft: { ...draft, planSeed: estimate.result.preview.planSeed }, acceptedWorstMicros: estimate.result.preview.estimate.worstMicros });
    if (!reply.ok) throw new Error("start refused");
    launch = reply.result.launch;
    if (paused) {
      const p = await client.request("autopilot.pause", { launchId: reply.result.launch.launchId });
      if (p.ok) launch = p.result.launch;
    }
  });
  if (launch === null) throw new Error("no launch");
  const started: LaunchView = launch;
  const row = started.avatars.find((a) => a.avatarId === who.avatarId);
  if (row === undefined || row.sceneSetId === null || row.scenes === null) throw new Error(`${who.name} has no set in the launch`);
  act(() =>
    engine.seedSceneSet({ avatarId: who.avatarId, sceneSetId: row.sceneSetId ?? "", count: row.scenes ?? 0, written: written ?? row.scenes ?? 0, categories: ["home"], launchId: started.launchId, ...(level === undefined ? {} : { level }) }),
  );
  return { engine, client, launch: started, row };
}

/** From the launch card's row, as the owner goes: «Открыть «Фото»» of Sofia (or of the avatar named). */
async function openFromAutopilot(name = "Sofia"): Promise<void> {
  await openSection("Автопилот");
  await screen.findByRole("heading", { level: 1, name: "Автопилот" });
  await flush();
  const live = document.getElementById("ap-live");
  if (live === null) throw new Error("no live card");
  fireEvent.click(within(live).getByRole("button", { name: `Открыть «Фото» · ${name}` }));
  await flush();
  await screen.findByRole("heading", { level: 1, name });
  await screen.findByRole("region", { name: "Набор сцен запуска" });
  await flush();
}

const strip = (): HTMLElement => screen.getByRole("region", { name: "Набор сцен запуска" });
const column = (): HTMLElement => screen.getByRole("region", { name: "Сцены" });
const goButton = (): HTMLElement => within(strip()).getByRole("button", { name: /^(Продолжить запуск|Сцены принять)/ });
const descriptionOf = (el: HTMLElement): string =>
  (el.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter((id) => id !== "")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");

describe("a launch's set on «Фото» (PhotoLaunchReview)", () => {
  test("the band, the price «в пределах запуска», no switch, no «Пересоставить…», no «+ Своя сцена»; the focus on «Продолжить запуск: M фото»", async () => {
    const { row } = await launchWithSet();
    await openFromAutopilot();
    const band = within(strip()).getByRole("note");
    expect(band.textContent ?? "").toMatch(new RegExp(`^Набор запуска от \\d\\d:\\d\\dв пределах запуска · до \\${formatUsdTiered(row.drawAllocationMicros ?? 0, "up")}Открыть «Автопилот»$`));
    await waitFor(() => expect(describeElement(document.activeElement)).toBe(describeElement(goButton())));
    expect(goButton().textContent).toBe(`Продолжить запуск: ${row.continuePhotos ?? 0}${NBSP}фото`);
    expect(screen.queryByRole("switch", { name: "Сцены на проверку" }) === null).toBe(true);
    expect(screen.queryByRole("button", { name: "Пересоставить…" }) === null).toBe(true);
    expect(within(strip()).queryByRole("button", { name: /^Мои категории/ }) === null).toBe(true);
    // S5.7c: the angle comes from the scene; a launch whose draft still carries «Ракурсы» names no «Подача».
    expect(within(strip()).getByText(/^Ракурс — из сцены\. Пока идёт запуск, набор не пересоставить и не удалить/)).toBeDefined();
    expect(within(strip()).getByText("в пределах запуска — новых денег нет")).toBeDefined();
    expect(Array.from(strip().querySelectorAll(".photos-cost-total")).map((r) => r.textContent)).toEqual([`Пределдо ${formatUsdTiered(row.drawAllocationMicros ?? 0, "up")}`]);
    expect(within(column()).queryByRole("button", { name: /Своя сцена/ }) === null).toBe(true);
    expect(within(column()).getByText("свои сцены — не в запуске")).toBeDefined();
    // The scenes can still be edited while they wait for the review: the pencil and «Другая сцена» stay.
    expect(within(column()).getAllByRole("button", { name: /^Изменить текст сцены/ }).length > 0).toBe(true);
  });

  test("«Продолжить запуск» sends the launch's set and revision; the set becomes the launch's, read only, «в запуске автопилота»", async () => {
    const { engine, launch, row } = await launchWithSet();
    await openFromAutopilot();
    fireEvent.click(goButton());
    await flush();
    const [sent] = callsOf(engine, "autopilot.continueAfterReview");
    expect(sent?.payload).toEqual({ launchId: launch.launchId, avatarId: SOFIA.avatarId, sceneSetId: row.sceneSetId ?? "", revision: row.setRevision ?? 0 });
    await waitFor(() => expect(within(strip()).getByText("в запуске автопилота", { selector: ".ap-launch-mark" })).toBeDefined());
    expect(within(strip()).queryByRole("button", { name: /^Продолжить запуск/ }) === null).toBe(true);
    expect(within(column()).getByText("Набор стал частью запуска — правки закрыты.")).toBeDefined();
    expect(within(column()).queryAllByRole("button", { name: /^Изменить текст сцены/ })).toHaveLength(0);
    // Nothing of the owner's own paid path was asked.
    expect(callsOf(engine, "runs.startFromScenes")).toHaveLength(0);
    fireEvent.click(within(strip()).getByRole("button", { name: /^Открыть «Автопилот»/ }));
    await flush();
    expect(screen.getByRole("heading", { level: 1, name: "Автопилот" })).toBeDefined();
  });

  test("over the plan (the engine's refusal): the button closed, «в плане N», the reason in red", async () => {
    const { engine, row } = await launchWithSet();
    await openFromAutopilot();
    engine.failNext("autopilot.continueAfterReview", { code: "VALIDATION", sceneReason: "over-plan", detail: "more active scenes than planned" });
    fireEvent.click(goButton());
    await flush();
    expect(goButton().getAttribute("aria-disabled")).toBe("true");
    expect(goButton().textContent).toContain(`в плане ${row.photos.total}`);
    expect(descriptionOf(goButton())).toMatch(/^Сцен больше плана.* Запуск не рисует больше, чем принято при «Запустить»\.$/);
    fireEvent.click(goButton());
    await flush();
    expect(callsOf(engine, "autopilot.continueAfterReview")).toHaveLength(1);
  });

  // S5.9g round 2 (plan s5a3 gap D): «Продолжить запуск» refused for the 2K tier alone says state 55's sentence, not the general price text.
  test("refused for a missing 2K tier (priceScope «bold»): state 55's warning, never the general price text", async () => {
    const { engine } = await launchWithSet();
    await openFromAutopilot();
    engine.failNext("autopilot.continueAfterReview", { code: "PRICE_UNAVAILABLE", priceScope: "bold", detail: "the price list has no 2K tier" });
    fireEvent.click(goButton());
    await flush();
    const notice = await screen.findByText(PRICE_SCOPES_RU.bold);
    expect(notice.closest(".notice")?.classList.contains("notice-warn")).toBe(true);
    expect(screen.queryByText(errorText({ code: "PRICE_UNAVAILABLE" })) === null).toBe(true);
  });

  // 5a.4 (S5.BA8b round 2, MEDIUM-2; §5.9 row 24): a «Смелая» launch's set is drawn on the route, every scene of it by Seedream 5 Pro in 2K whatever the settings' model; its strip
  // names that model, as the owner's own set's strip does, and the settings' model only for a set off the route.
  test("the set moved (SCENES_CHANGED): told, nothing drawn, the focus stays on the button", async () => {
    const { engine } = await launchWithSet();
    await openFromAutopilot();
    engine.failNext("autopilot.continueAfterReview", { code: "SCENES_CHANGED", detail: "the set moved" });
    goButton().focus();
    fireEvent.click(goButton());
    await flush();
    expect(screen.getByText("Набор изменился")).toBeDefined();
    expect(describeElement(document.activeElement)).toBe(describeElement(goButton()));
  });
});

describe("the launch paused (PhotoLaunchReviewPaused)", () => {
});

describe("a launch's batches on «Фото»", () => {
  /** Resumes a seeded run of Sofia's through the engine: its job then draws, as the launch's batch or the owner's own. */
  async function resumeRun(client: EngineClient, runId: string): Promise<void> {
    await act(async () => {
      const price = await client.request("runs.estimateResume", { runId });
      if (!price.ok) throw new Error(`estimate refused: ${price.error.code}`);
      const run = await client.request("runs.resume", { runId, acceptedWorstMicros: price.result.estimate.worstMicros });
      if (!run.ok) throw new Error(`resume refused: ${run.error.code}`);
    });
  }

  async function openSofia(): Promise<void> {
    await openSection("Аватары");
    fireEvent.click(await screen.findByRole("button", { name: /^Sofia/ }));
    await flush();
    await screen.findByRole("heading", { level: 1, name: "Sofia" });
  }

  const progress = (): HTMLElement => {
    const bar = column().querySelector<HTMLElement>(".job-progress");
    if (bar === null) throw new Error("no batch drawing");
    return bar;
  };


  test("the owner's own run, resumed while the launch is paused: its «Отменить», no launch label, no launch limit — though the row still says it draws (M2)", async () => {
    const { engine, client, launch } = await launchWithSet({ paused: true });
    const runId = engine.seedRun({ avatarId: SOFIA.avatarId, count: 5, categories: ["home"], poses: { profile: false, back: false } }, 1);
    await resumeRun(client, runId);
    // The launch's last word still has Sofia drawing (it was, before the pause): the batch on screen is not that one.
    const stale = launch.avatars.map((a) => (a.avatarId === SOFIA.avatarId ? { ...a, phase: "drawing" as const, slice: { index: 1, total: 1 } } : a));
    act(() => engine.announceLaunch(LaunchView.parse({ ...launch, avatars: stale })));
    await openSofia();
    await waitFor(() => expect(within(column()).getByText(/^Рисуем фото: \d+ из 5$/)).toBeDefined());
    await flush();
    expect(within(progress()).getByRole("button", { name: "Отменить" })).toBeDefined();
    expect(within(progress()).queryByText("в запуске автопилота") === null).toBe(true);
    expect(within(progress()).queryByText(/^партия 1 из 1 · до/) === null).toBe(true);
  });
});

describe("a paid click on the strip is sent once (round 1 M4), and «Стоп» on its way (L1)", () => {
  test("two clicks on «Продолжить запуск» send one; after the reply, before the view, a click sends none; the view then lands", async () => {
    const { engine } = await launchWithSet();
    await openFromAutopilot();
    engine.setDelivery(false);
    fireEvent.click(goButton());
    fireEvent.click(goButton());
    await flush();
    expect(callsOf(engine, "autopilot.continueAfterReview")).toHaveLength(1);
    expect(goButton().getAttribute("aria-busy")).toBe("true");
    expect(goButton().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(goButton());
    await flush();
    expect(callsOf(engine, "autopilot.continueAfterReview")).toHaveLength(1);
    engine.setDelivery(true);
    act(() => engine.touchMoney());
    await flush();
    await waitFor(() => expect(within(strip()).getByText("в запуске автопилота", { selector: ".ap-launch-mark" })).toBeDefined());
  });

});

// ---------- S4.9d: what the S4.9b review left on the strip ----------

describe("S4.9d: the strip's focus as the design's keyboard table has it (S4.9b L5)", () => {
});

describe("S4.6p: the strip shows the engine's expected price of the draw (PhotosS4: «12 фото ≈ $0.84», «Предел до $2.94»)", () => {
  const stepsOf = (): string[] => Array.from(strip().querySelectorAll(".scene-step"), (el) => el.textContent ?? "");

  test("step 2 is «≈ $X», the engine's own expected price of the photos still to draw; the limit stays in «Предел». The window works out no money", async () => {
    const { engine, client, launch, row } = await launchWithSet();
    await openFromAutopilot();
    await flush();
    // What the strip itself asked, before the test asks anything.
    const askedByStrip = callsOf(engine, "runs.estimateImages").map((c) => c.payload);
    const asked = await client.request("runs.estimateImages", { launchId: launch.launchId, avatarId: SOFIA.avatarId });
    if (!asked.ok) throw new Error("the engine refused the price");
    expect(asked.result.photos).toBe(row.continuePhotos ?? Number.NaN);
    await waitFor(() => expect(stepsOf()[1]).toBe(`2${row.continuePhotos ?? 0}${NBSP}фото≈ ${formatUsdTiered(asked.result.estimate.expectedMicros, "nearest")}`));
    expect(Array.from(strip().querySelectorAll(".photos-cost-total")).map((r) => r.textContent)).toEqual([`Пределдо ${formatUsdTiered(row.drawAllocationMicros ?? 0, "up")}`]);
    expect(askedByStrip.some((payload) => "launchId" in payload && payload.launchId === launch.launchId && payload.avatarId === SOFIA.avatarId)).toBe(true);
    expect(callsOf(engine, "scenes.estimateCompose")).toHaveLength(0);
    // The generate card prices its own run (the form's count and categories); the strip no longer probes with one built-in category to take the writer off.
    expect(callsOf(engine, "runs.estimate").filter((c) => c.payload.categories.length === 1 && c.payload.categories[0] === "home")).toHaveLength(0);
  });

  test("a price the engine cannot give leaves step 2 at «≈ …»: nothing is worked out in its place, and the limit stays", async () => {
    const { engine, row } = await launchWithSet();
    engine.failNext("runs.estimateImages", { code: "PRICE_UNAVAILABLE", detail: "no price" });
    await openFromAutopilot();
    await flush();
    expect(stepsOf()[1]).toBe(`2${row.continuePhotos ?? 0}${NBSP}фото≈ …`);
    expect(Array.from(strip().querySelectorAll(".photos-cost-total")).map((r) => r.textContent)).toEqual([`Пределдо ${formatUsdTiered(row.drawAllocationMicros ?? 0, "up")}`]);
  });
});

