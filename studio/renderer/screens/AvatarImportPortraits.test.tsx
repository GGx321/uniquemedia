import { describe, expect, test } from "bun:test";
import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ERROR_MESSAGES_RU, type AvatarSummary } from "../../shared/engine";
import { App } from "../App";
import { MockEngine, mockEngineClient } from "../engine/mockEngine";
import { MIA } from "../engine/mockEngine.testkit";
import { EngineProvider, useEngineView } from "../engine/react";
import { ManualScheduler } from "../engine/scheduler";
import type { EngineView } from "../engine/store";
import { NavigationProvider, type LookLanding } from "../navigation";
import { callsOf, estimateText, flush, inAct, runAll, setup } from "../testing";
import { paidSettingsFocus } from "./look/lookModel";
import { MasterCard } from "./look/MasterCard";
import { usePortraits } from "./look/usePortraits";
import { paidBlockedReason } from "./photos/runForm";

// S5.3d: the import's second price line and the start it accepts (.omc/stage5/design 14, 14a, 14b, 14c, 15, 18b). The click on «Импортировать» accepts
// both engine prices — the import's and the portraits' — and the new avatar's «Внешность» starts the batch once, at exactly the worst case shown. The
// window never adds them up.

const text = (el: Element): string => el.textContent ?? "";
const PORTRAITS_LINE = "Эта кнопка сразу запустит и 5 вариантов мастер-портрета · до $0.30";
const masterCard = (): HTMLElement => screen.getByRole("region", { name: "Мастер-портрет" });
const panel = (): HTMLElement => screen.getByRole("region", { name: "Варианты мастер-портрета" });
const startButton = (): HTMLElement => within(masterCard()).getByRole("button", { name: /^(Получить 5 вариантов|Подтвердить новую цену)/ });
const importButton = (): HTMLElement => screen.getByRole("button", { name: /Импортировать · до|Подтвердить новую цену · до/ });

/** The accessible description an element points at, as one string. */
function describedBy(el: HTMLElement): string {
  const ids = (el.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
  return ids.map((id) => document.getElementById(id)?.textContent ?? `(#${id} missing)`).join(" ");
}

async function openImport(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Импортировать аватара" }));
  await screen.findByRole("heading", { level: 1, name: "Импортировать аватара" });
}

async function pickAndName(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: /Выбрать фото/ }));
  await waitFor(() => expect(estimateText()).not.toBeNull());
  fireEvent.change(screen.getByPlaceholderText("Mia"), { target: { value: "Zoe" } });
}

async function importZoe(): Promise<void> {
  await openImport();
  await pickAndName();
  fireEvent.click(importButton());
  await screen.findByRole("heading", { level: 1, name: "Zoe" });
  await flush();
}

describe("14 · the import screen", () => {
  test("the second line is the portraits' own engine price, said beside the import's and never added to it", async () => {
    const { engine } = setup();
    await openImport();
    await pickAndName();
    expect(screen.getByText((_, el) => el?.classList.contains("portrait-then") === true).textContent).toBe(PORTRAITS_LINE);
    // The button keeps the import's own price; the line it points at says what else it accepts.
    expect(importButton().textContent).toBe("Импортировать · до $0.063");
    expect(describedBy(importButton())).toBe(PORTRAITS_LINE);
    expect(screen.getByText("Дальше — страница аватара: мастер-портрет, тело и итог сверки.")).toBeDefined();
    expect(callsOf(engine, "avatars.estimatePortraits").map((c) => c.payload)).toEqual([{}]);
    expect(callsOf(engine, "avatars.generatePortraits")).toHaveLength(0);
  });

  test("14b: no portraits price — the line says they are made in «Внешность», and the import still works without starting them", async () => {
    const { engine } = setup();
    engine.failNext("avatars.estimatePortraits", { code: "PRICE_UNAVAILABLE" });
    await openImport();
    await pickAndName();
    expect(screen.getByText("Варианты мастер-портрета: цена недоступна — сделаете их во «Внешности»")).toBeDefined();
    expect(screen.queryByText(/Эта кнопка сразу запустит/) === null).toBe(true);
    fireEvent.click(importButton());
    await screen.findByRole("heading", { level: 1, name: "Zoe" });
    await flush();
    expect(callsOf(engine, "avatars.importAvatar")).toHaveLength(1);
    expect(callsOf(engine, "avatars.generatePortraits")).toHaveLength(0);
    // 20: the card offers the start at its own price, and the landing line says nothing of portraits.
    expect(startButton().textContent).toBe("Получить 5 вариантов · до $0.30");
    expect(screen.getByText(/^Аватар «Zoe» импортирован\./).textContent).toBe("Аватар «Zoe» импортирован. Описание прочитано с фото и сверено с ним — осталось тело.");
  });

  test("14c: a higher import price asks both prices again; the new click accepts the fresh ones", async () => {
    const { engine } = setup();
    await openImport();
    await pickAndName();
    engine.setImportPrice({ expectedMicros: 8_000, worstMicros: 70_000 });
    fireEvent.click(importButton());
    await screen.findByText(/Цена выросла/);
    expect(callsOf(engine, "avatars.estimateImport")).toHaveLength(2);
    expect(callsOf(engine, "avatars.estimatePortraits")).toHaveLength(2);
    expect(importButton().textContent).toBe("Подтвердить новую цену · до $0.070");
    expect(describedBy(importButton())).toBe(PORTRAITS_LINE);

    fireEvent.click(importButton());
    await screen.findByRole("heading", { level: 1, name: "Zoe" });
    await flush();
    expect(callsOf(engine, "avatars.importAvatar").map((c) => c.payload.acceptedWorstMicros)).toEqual([62_500, 70_000]);
    expect(callsOf(engine, "avatars.generatePortraits").map((c) => c.payload.acceptedWorstMicros)).toEqual([300_000]);
  });
});

describe("15 · the landing starts the batch once", () => {
  test("at the worst case the click accepted; a look at «Фото» and back is not a second start", async () => {
    const { engine } = setup();
    await importZoe();
    expect(callsOf(engine, "avatars.generatePortraits").map((c) => c.payload.acceptedWorstMicros)).toEqual([300_000]);
    expect(screen.getByText(/^Аватар «Zoe» импортирован\./).textContent).toBe(
      "Аватар «Zoe» импортирован. Описание прочитано с фото и сверено с ним — осталось тело. Рисуем варианты мастер-портрета.",
    );
    expect(text(panel())).toContain("Рисуем портреты: 0 из 5");
    // The body editor the import opened is still there and usable while the batch draws.
    expect(screen.getByRole("button", { name: "Сохранить тело" })).toBeDefined();

    fireEvent.click(screen.getByRole("tab", { name: "Фото" }));
    await flush();
    fireEvent.click(screen.getByRole("tab", { name: "Внешность" }));
    await flush();
    expect(callsOf(engine, "avatars.generatePortraits")).toHaveLength(1);
    expect(text(panel())).toContain("Рисуем портреты: 0 из 5");
  });

  test("the landing line says the portraits are ready once they are (16)", async () => {
    const { scheduler } = setup();
    await importZoe();
    runAll(scheduler);
    await flush();
    expect(screen.getByText(/^Аватар «Zoe» импортирован\./).textContent).toBe(
      "Аватар «Zoe» импортирован. Описание прочитано с фото и сверено с ним — осталось тело. Варианты готовы — выберите мастер-портрет.",
    );
  });

  test("React's development double mount (StrictMode) still starts it once", async () => {
    const scheduler = new ManualScheduler();
    const engine = new MockEngine({ scheduler, latencyMs: 0 });
    render(
      <StrictMode>
        <App client={mockEngineClient(engine)} />
      </StrictMode>,
    );
    await importZoe();
    await flush();
    expect(callsOf(engine, "avatars.generatePortraits").map((c) => c.payload.acceptedWorstMicros)).toEqual([300_000]);
    expect(text(panel())).toContain("Рисуем портреты: 0 из 5");
  });
});

describe("18b · the landing's start refused before anything was paid", () => {
  test("no face on the imported photo: not offered again, in §3's words; the landing line says nothing of portraits", async () => {
    const { engine } = setup();
    engine.scriptNextPortraits({ refuse: { code: "MASTER_FACE_UNUSABLE" } });
    await importZoe();
    expect(callsOf(engine, "avatars.generatePortraits")).toHaveLength(1);
    expect(isOff(startButton())).toBe(true);
    expect(text(masterCard())).toContain("На исходном фото не найдено лицо — варианты не с чем сравнить. Ничего не потрачено.");
    expect(screen.getByText(/^Аватар «Zoe» импортирован\./).textContent).toBe("Аватар «Zoe» импортирован. Описание прочитано с фото и сверено с ним — осталось тело.");
  });

  test("the budget: the app's text and that nothing was started", async () => {
    const { engine } = setup();
    engine.failNext("avatars.generatePortraits", { code: "BUDGET_EXCEEDED" });
    await importZoe();
    expect(screen.getByText(`${ERROR_MESSAGES_RU.BUDGET_EXCEEDED} Варианты не запускались — ничего не потрачено.`)).toBeDefined();
    expect(isOff(startButton())).toBe(false);
  });

  test("a price that rose after it was shown is refused, not paid: the card shows the new price and waits for a click", async () => {
    const { engine, client } = setup();
    await openImport();
    await pickAndName();
    // The age check turned on after the import screen priced the portraits: the batch's worst case is now 5 × (60 000 + 5 250).
    await act(async () => {
      await client.request("settings.setImageAgeCheck", { imageAgeCheck: "on" });
    });
    fireEvent.click(importButton());
    await screen.findByRole("heading", { level: 1, name: "Zoe" });
    await flush();

    expect(callsOf(engine, "avatars.generatePortraits").map((c) => c.payload.acceptedWorstMicros)).toEqual([300_000]);
    const notice = screen.getByText(/^Было не больше/).closest(".notice");
    expect(text(notice ?? document.body)).toBe("Цена вырослаБыло не больше $0.30, теперь не больше $0.33. Подтвердите новую цену. Варианты не запускались — ничего не потрачено.");
    expect(startButton().textContent).toBe("Подтвердить новую цену · до $0.33");
    fireEvent.click(startButton());
    await flush();
    expect(callsOf(engine, "avatars.generatePortraits").map((c) => c.payload.acceptedWorstMicros)).toEqual([300_000, 326_250]);
    expect(text(panel())).toContain("Рисуем портреты: 0 из 5");
  });
});

// The import itself needs a working key and no halt, so these land on the card directly, with the landing the import's navigation hands over: the
// screen's own hook and card, as «Внешность» holds them.
describe("18b · never without a key or under a reconcile", () => {
  const NINI: AvatarSummary = { ...MIA, avatarId: "avatar-nini-0004", name: "Nini", masterPhotoId: "photo-nini-source" };

  function Card({ avatar, view, landing }: { avatar: AvatarSummary; view: EngineView; landing: LookLanding }) {
    const blockedReason = paidBlockedReason(view);
    const portraits = usePortraits(avatar, landing, { view, shown: true, ready: true, paidBlocked: blockedReason !== null });
    return <MasterCard avatar={avatar} portraits={portraits} blockedReason={blockedReason} settingsFocus={paidSettingsFocus(view)} />;
  }

  function Landed({ landing }: { landing: LookLanding }) {
    const view = useEngineView();
    const avatar = view.avatars.find((a) => a.avatarId === NINI.avatarId);
    return view.phase !== "ready" || avatar === undefined ? null : <Card avatar={avatar} view={view} landing={landing} />;
  }

  function land(engine: MockEngine): void {
    const landing: LookLanding = { kind: "imported", check: null, portraitsWorstMicros: 300_000 };
    render(
      <EngineProvider client={mockEngineClient(engine)}>
        <NavigationProvider value={{ navigate: () => undefined, guard: () => () => undefined }}>
          <Landed landing={landing} />
        </NavigationProvider>
      </EngineProvider>,
    );
  }

  test("no key: nothing is sent, and the card says why and that nothing was started", async () => {
    const engine = new MockEngine({
      scheduler: new ManualScheduler(),
      latencyMs: 0,
      avatars: [NINI],
      portraits: [{ avatarId: NINI.avatarId, sourcePhotoId: NINI.masterPhotoId }],
      apiKey: { stored: false, last4: null, encryptionAvailable: true, rejected: false },
    });
    land(engine);
    await screen.findByRole("region", { name: "Мастер-портрет" });
    await flush();
    expect(callsOf(engine, "avatars.generatePortraits")).toHaveLength(0);
    expect(text(masterCard())).toContain("Нужен рабочий ключ OpenRouter — добавьте его в Настройках. Варианты не запускались — ничего не потрачено.");
    expect(within(masterCard()).getByRole("button", { name: "Открыть ключ в Настройках" })).toBeDefined();
    expect(isOff(startButton())).toBe(true);
  });

  test("a reconcile needed: nothing is sent, and the card points at the money", async () => {
    const engine = new MockEngine({ scheduler: new ManualScheduler(), latencyMs: 0, avatars: [NINI], portraits: [{ avatarId: NINI.avatarId, sourcePhotoId: NINI.masterPhotoId }] });
    inAct(() => engine.requireReconcile(["open-reserves"]));
    land(engine);
    await screen.findByRole("region", { name: "Мастер-портрет" });
    await flush();
    expect(callsOf(engine, "avatars.generatePortraits")).toHaveLength(0);
    expect(text(masterCard())).toContain("Платные запросы остановлены до сверки расходов. Варианты не запускались — ничего не потрачено.");
    expect(within(masterCard()).getByRole("button", { name: "Открыть деньги в Настройках" })).toBeDefined();
  });
});

function isOff(el: HTMLElement): boolean {
  return el.hasAttribute("disabled");
}
