import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { LaunchView, type AvatarSummary, type LaunchAvatarView, type LaunchDraftInput, type PhotoSummary } from "../../shared/engine";
import type { EngineClient } from "../engine/client";
import type { MockEngine } from "../engine/mockEngine";
import { freePhotos, MIA, SOFIA } from "../engine/mockEngine.testkit";
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
async function launchWithSet({ paused = false, written }: { paused?: boolean; written?: number } = {}): Promise<World> {
  // This machine's own switch is OFF: a launch's set shows on «Фото» whatever it says.
  const { engine, client } = setup({ ...library(), sceneReview: "off" });
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
  const row = started.avatars.find((a) => a.avatarId === SOFIA.avatarId);
  if (row === undefined || row.sceneSetId === null || row.scenes === null) throw new Error("Sofia has no set in the launch");
  act(() => engine.seedSceneSet({ avatarId: SOFIA.avatarId, sceneSetId: row.sceneSetId ?? "", count: row.scenes ?? 0, written: written ?? row.scenes ?? 0, categories: ["home"], launchId: started.launchId }));
  return { engine, client, launch: started, row };
}

/** From the launch card's row, as the owner goes: «Открыть «Фото»» of Sofia. */
async function openFromAutopilot(): Promise<void> {
  await openSection("Автопилот");
  await screen.findByRole("heading", { level: 1, name: "Автопилот" });
  await flush();
  const live = document.getElementById("ap-live");
  if (live === null) throw new Error("no live card");
  fireEvent.click(within(live).getByRole("button", { name: "Открыть «Фото» · Sofia" }));
  await flush();
  await screen.findByRole("heading", { level: 1, name: "Sofia" });
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
    expect(within(strip()).getByText(/^Ракурсы: анфас, три четверти\. Пока идёт запуск, набор не пересоставить и не удалить/)).toBeDefined();
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

  test("scenes without text: the button says how many go, the line under it what the owner can do", async () => {
    const { engine, launch, row } = await launchWithSet();
    const fewer = { ...row, scenes: 14, scenesWithoutText: 2, continuePhotos: 12 };
    act(() => engine.announceLaunch(LaunchView.parse({ ...launch, avatars: launch.avatars.map((a) => (a.avatarId === SOFIA.avatarId ? fewer : a)) })));
    await openFromAutopilot();
    expect(goButton().textContent).toBe(`Продолжить запуск: 12${NBSP}фото · 2${NBSP}сцены без текста уберём`);
    expect(descriptionOf(goButton())).toBe("Фото будет на 2 меньше — или допишите эти сцены, тогда 14.");
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
  test("«Сцены принять: M фото · фото — после «Продолжить»»; accepted, the button gives way to «принято — ждёт «Продолжить»», which takes the focus", async () => {
    const { engine, row } = await launchWithSet({ paused: true });
    await openFromAutopilot();
    expect(within(strip()).getByRole("note").textContent ?? "").toContain("запуск на паузе · в пределах запуска");
    expect(goButton().textContent).toBe(`Сцены принять: ${row.continuePhotos ?? 0}${NBSP}фото · фото — после «Продолжить»`);
    expect(within(strip()).getByText("Запуск на паузе. Сцены можно принять сейчас — рисовать начнём после «Продолжить».")).toBeDefined();
    fireEvent.click(goButton());
    await flush();
    expect(callsOf(engine, "autopilot.continueAfterReview")).toHaveLength(1);
    const accepted = await within(strip()).findByText("принято — ждёт «Продолжить»");
    await waitFor(() => expect(describeElement(document.activeElement)).toBe(describeElement(accepted)));
    expect(within(column()).getByText("Сцены приняты — набор только для чтения, пока идёт запуск.")).toBeDefined();
    expect(callsOf(engine, "runs.startFromScenes")).toHaveLength(0);
  });
});

describe("a launch's batches on «Фото»", () => {
  test("a stopped batch of the launch reads «в запуске автопилота»; the owner's own run keeps its «Продолжить»", async () => {
    const { engine, launch } = await launchWithSet({ paused: true });
    engine.seedRun({ avatarId: SOFIA.avatarId, count: 5, categories: ["home"], poses: { profile: false, back: false } }, 2, undefined, { launchId: launch.launchId });
    engine.seedRun({ avatarId: SOFIA.avatarId, count: 5, categories: ["home"], poses: { profile: false, back: false } }, 1);
    await openFromAutopilot();
    await waitFor(() => expect(within(column()).getAllByRole("article", { name: /^Остановлена/ })).toHaveLength(1));
    const batch = within(column()).getByRole("article", { name: /^Остановлена/ });
    expect(batch.textContent).toContain("Готово 2 из 5 · партия запуска на паузе");
    expect(within(batch).getByText("в запуске автопилота")).toBeDefined();
    expect(within(batch).queryByRole("button") === null).toBe(true);
    await waitFor(() => expect(within(column()).getAllByRole("article", { name: /^Остановлен\s/ })).toHaveLength(1));
    expect(within(within(column()).getByRole("article", { name: /^Остановлен\s/ })).getByRole("button", { name: /^(Продолжить|Считаем)/ })).toBeDefined();
  });

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

  test("the launch's own batch drawing now (its `RunSummary.launchId`): «в запуске автопилота» instead of «Отменить», the batch and the launch under the bar", async () => {
    const { engine, client, launch } = await launchWithSet();
    const runId = engine.seedRun({ avatarId: SOFIA.avatarId, count: 5, categories: ["home"], poses: { profile: false, back: false } }, 1, undefined, { launchId: launch.launchId });
    await resumeRun(client, runId);
    const drawing = launch.avatars.map((a) => (a.avatarId === SOFIA.avatarId ? { ...a, phase: "drawing" as const, slice: { index: 1, total: 1 } } : a));
    act(() => engine.announceLaunch(LaunchView.parse({ ...launch, avatars: drawing })));
    await openSofia();
    await waitFor(() => expect(within(column()).getByText(/^Рисуем фото: \d+ из 5$/)).toBeDefined());
    await waitFor(() => expect(within(progress()).getByText("в запуске автопилота")).toBeDefined());
    expect(within(progress()).queryByRole("button", { name: "Отменить" }) === null).toBe(true);
    expect(within(progress()).getByText(/^партия 1 из 1 · до \$[\d.]+ · запуск /)).toBeDefined();
  });

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

  test("the launch stopped: its stopped batch is read again and becomes the owner's to continue (L9)", async () => {
    const { engine, client, launch } = await launchWithSet({ paused: true });
    engine.seedRun({ avatarId: SOFIA.avatarId, count: 5, categories: ["home"], poses: { profile: false, back: false } }, 2, undefined, { launchId: launch.launchId });
    await openFromAutopilot();
    await waitFor(() => expect(within(column()).getAllByRole("article", { name: /^Остановлена/ })).toHaveLength(1));
    await act(async () => {
      const stopped = await client.request("autopilot.stop", { launchId: launch.launchId });
      if (!stopped.ok) throw new Error("stop refused");
    });
    await flush();
    await waitFor(() => expect(within(column()).queryAllByRole("article", { name: /^Остановлена/ })).toHaveLength(0));
    const own = within(column()).getByRole("article", { name: /^Остановлен\s/ });
    expect(within(own).getByRole("button", { name: /^(Продолжить|Считаем)/ })).toBeDefined();
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

  test("«Стоп» on its way: no «Продолжить запуск» — «запуск останавливается», the set goes back as an ordinary one", async () => {
    const { engine, launch } = await launchWithSet();
    await openFromAutopilot();
    act(() => engine.announceLaunch(LaunchView.parse({ ...launch, status: "stopping" })));
    await flush();
    expect(within(strip()).queryByRole("button", { name: /^Продолжить запуск/ }) === null).toBe(true);
    expect(within(strip()).getByText("запуск останавливается")).toBeDefined();
    expect(within(strip()).getByText("Запуск останавливается — набор вернётся на «Фото» обычным.")).toBeDefined();
  });
});
