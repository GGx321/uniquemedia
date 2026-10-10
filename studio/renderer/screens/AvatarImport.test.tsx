import { expect, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { ErrorCode } from "../../shared/engine";
import { MAX_SOURCE_PIXELS } from "../../node/downscale";
import { callsOf, estimateText, flush, setup } from "../testing";

/** From the Avatars grid into the import screen, as "Импортировать аватара" does. */
async function openImport(): Promise<void> {
  const button = await screen.findByRole("button", { name: "Импортировать аватара" });
  fireEvent.click(button);
  await screen.findByRole("heading", { level: 1, name: "Импортировать аватара" });
}

function pickButton(): HTMLElement {
  return screen.getByRole("button", { name: /Выбрать фото|Выбрать другое фото/ });
}

async function pickPhoto(): Promise<void> {
  fireEvent.click(pickButton());
  await waitFor(() => expect(estimateText()).not.toBeNull());
}

function nameInput(): HTMLElement {
  return screen.getByPlaceholderText("Mia");
}

function importButton(): HTMLElement {
  return screen.getByRole("button", { name: /Импортировать · до|Подтвердить новую цену · до/ });
}

// M4: the UI text next to "до 20 МБ" states the same pixel cap the engine
// actually enforces for free (checkImportPhoto, importStaging.ts) — a
// renderer-local copy (it cannot import the Node-only module itself), cross-
// checked here against the real constant so it cannot silently drift.
test("M4: the pixel limit shown next to the size cap matches MAX_SOURCE_PIXELS exactly", async () => {
  setup();
  await openImport();
  const text = await screen.findByText(/до 20 МБ/);
  // "px" keeps to its number with a no-break space, as the other units do.
  const match = /не крупнее (\d+)×(\d+)\s?px/.exec(text.textContent ?? "");
  if (match === null) throw new Error(`expected a "не крупнее W×H px" in: ${text.textContent}`);
  const [, width, height] = match;
  expect(Number(width) * Number(height)).toBe(MAX_SOURCE_PIXELS);
});

test("nothing is spent until a photo is picked: no estimate button and no estimate request", async () => {
  const { engine } = setup();
  await openImport();
  expect(estimateText()).toBeNull();
  expect(screen.queryByText(/ожидаемая/) === null).toBe(true);
  expect(callsOf(engine, "avatars.pickImportPhoto")).toHaveLength(0);
  expect(callsOf(engine, "avatars.estimateImport")).toHaveLength(0);
});

// M1: the import screen's own empty state — there is no "Оценить стоимость"
// button here to point to; the estimate appears on its own after a pick.
test("M1: the empty estimate state never mentions the wizard's own (nonexistent, here) estimate button", async () => {
  setup();
  await openImport();
  expect(await screen.findByText(/Сначала выберите фото/)).toBeTruthy();
  expect(screen.queryByText(/Оценить стоимость/) === null).toBe(true);
});

// Owner decision 2026-10-05 (personal-use app): an import makes no age check and asks for no AI-persona confirmation, so its estimate
// caption names only the describe attempts.
test("M1: the estimate's caption is the import's own — the describe attempts only, no age check, not avatar-creation wording", async () => {
  setup();
  await openImport();
  await pickPhoto();

  expect(await screen.findByText(/Описание по фото \(до 2 попыток\)/)).toBeTruthy();
  expect(screen.queryByText(/проверка возраста/i) === null).toBe(true);
  expect(screen.queryByText(/Дескриптор и 4 портрета/) === null).toBe(true);
});

test("design constraint 1: pick, then estimate for that exact staged photo", async () => {
  const { engine } = setup();
  await openImport();
  await pickPhoto();

  expect(callsOf(engine, "avatars.pickImportPhoto")).toHaveLength(1);
  const [estimateCall] = callsOf(engine, "avatars.estimateImport");
  expect(estimateCall?.payload.stagingId).toBeTruthy();
  expect(estimateText()).not.toBeNull();
});

test("a cancelled dialog changes nothing: no estimate, the button offers to pick again", async () => {
  const { engine } = setup();
  engine.queueImportPick({ picked: false });
  await openImport();
  fireEvent.click(pickButton());
  await flush();

  expect(estimateText()).toBeNull();
  expect(callsOf(engine, "avatars.estimateImport")).toHaveLength(0);
  expect(pickButton().textContent).toBe("Выбрать фото");
});

test("there is no AI-persona checkbox and no checkbox of any kind: only the name stands between the estimate and the import", async () => {
  setup();
  await openImport();
  await pickPhoto();

  expect(screen.queryByRole("checkbox") === null).toBe(true);
  expect(screen.queryByText(/ИИ-персон/) === null).toBe(true);
});

test("a name is required before the import is sent", async () => {
  const { engine } = setup();
  await openImport();
  await pickPhoto();

  fireEvent.click(importButton());
  await flush();

  expect(await screen.findByText("Введите имя.")).toBeTruthy();
  expect(callsOf(engine, "avatars.importAvatar")).toHaveLength(0);
});

// S5.0d re-pin (the owner's decision, plan §5.5): an import no longer ends on the Avatars grid but on the new avatar's «Внешность», with its check.
test("happy path: pick, name it, import — lands on the new avatar's «Внешность»", async () => {
  const { engine } = setup();
  await openImport();
  await pickPhoto();
  fireEvent.change(nameInput(), { target: { value: "Zoe" } });

  fireEvent.click(importButton());
  await screen.findByRole("heading", { level: 1, name: "Zoe" });

  const [imported] = callsOf(engine, "avatars.importAvatar");
  expect(imported?.payload).toMatchObject({ name: "Zoe" });
  expect(imported?.payload).not.toHaveProperty("confirmedAiPersona");
  expect(screen.getByRole("tab", { name: "Внешность" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByText("Аватар «Zoe» импортирован. Описание прочитано с фото и сверено с ним.").tagName).toBe("DIV");
});

// T6c review round 3, L4: the old code guessed "consumed or not" from the
// error code alone — wrong for BUDGET_EXCEEDED (raised both from the free
// pre-check, before the stage is touched, and from inside the paid job,
// after it) and missing IMPORT_SUBJECT_INVALID entirely. Guessing is gone:
// after any non-PRICE_CHANGED error, confirmImport asks the engine itself
// (the free avatars.estimateImport) whether the stage survived it — NOT_FOUND
// drops it, ok keeps it — so it is right for every current and future code
// without a list to maintain.
test.each(["NETWORK", "INTERNAL", "IMPORT_SUBJECT_INVALID"] satisfies ErrorCode[])(
  "%s raised after the stage is consumed: the probe finds it gone, back to step 1",
  async (code) => {
    const { engine } = setup();
    await openImport();
    await pickPhoto();
    fireEvent.change(nameInput(), { target: { value: "Zoe" } });
    engine.failNextImportAfterConsuming({ code });

    fireEvent.click(importButton());
    await waitFor(() => expect(pickButton().textContent).toBe("Выбрать фото"));

    expect(estimateText()).toBeNull();
  },
);

test("BUDGET_EXCEEDED raised by the free pre-check never touches the stage: the probe finds it still live, the photo stays picked", async () => {
  const { engine } = setup();
  await openImport();
  await pickPhoto();
  fireEvent.change(nameInput(), { target: { value: "Zoe" } });
  engine.failNext("avatars.importAvatar", { code: "BUDGET_EXCEEDED" });

  fireEvent.click(importButton());
  await screen.findByText(/Месячный бюджет исчерпан/);

  // Unlike the post-consumption codes above: the stage is still exactly
  // what it was, so the picked photo and its estimate are still there.
  expect(estimateText()).not.toBeNull();
  expect(pickButton().textContent).toBe("Выбрать другое фото");
});

test("PRICE_CHANGED re-asks: the fresh estimate is shown and must be confirmed again", async () => {
  const { engine } = setup();
  await openImport();
  await pickPhoto();
  fireEvent.change(nameInput(), { target: { value: "Zoe" } });
  // S5.0c (deliberate re-pin): the import price now includes the check (57 500 at the fallback table), so the raised price must be above that.
  engine.setImportPrice({ expectedMicros: 8_000, worstMicros: 70_000 });

  fireEvent.click(importButton());
  await screen.findByText(/Цена выросла/);

  expect(callsOf(engine, "avatars.importAvatar")).toHaveLength(1);
  expect(importButton().textContent).toContain("Подтвердить новую цену");
});

// The large-screen audit (H2): the import takes a photo of any size; a small one makes a soft master portrait and a weak reference
// for every photo run. The screen says so next to the picked size — advice only: the import still goes ahead (no new gate).
const SMALL_ADVICE = "Маленькое фото (246×281 px) — портрет и сгенерированные фото будут нечёткими. Лучше от 1024 px по короткой стороне.";
const adviceText = (): string | null => screen.queryByText(/Маленькое фото/)?.textContent?.replace(/ /g, " ") ?? null;

test("H2: a photo under 768 px on its short side is advised against, with its size — and the import still goes ahead", async () => {
  const { engine } = setup();
  engine.queueImportPick({ picked: true, stagingId: "staging-small-0001", width: 246, height: 281 });
  await openImport();
  await pickPhoto();

  expect(adviceText()).toBe(SMALL_ADVICE);
  fireEvent.change(nameInput(), { target: { value: "Zoe" } });
  expect(importButton().hasAttribute("disabled")).toBe(false);
  fireEvent.click(importButton());
  // S5.0d re-pin: the import lands on the new avatar's «Внешность».
  await screen.findByRole("heading", { level: 1, name: "Zoe" });

  const [imported] = callsOf(engine, "avatars.importAvatar");
  expect(imported?.payload.stagingId).toBe("staging-small-0001");
});

test("H2: the advice is said politely, as a status, not as an alert (nothing went wrong)", async () => {
  const { engine } = setup();
  engine.queueImportPick({ picked: true, stagingId: "staging-small-0001", width: 246, height: 281 });
  await openImport();
  await pickPhoto();

  const role = screen.queryByText(/Маленькое фото/)?.closest(".notice")?.getAttribute("role") ?? null;
  expect(role).toBe("status");
});

test("H2: a short side of 768 px or more gets no advice", async () => {
  const { engine } = setup();
  engine.queueImportPick({ picked: true, stagingId: "staging-edge-0001", width: 1024, height: 768 });
  await openImport();
  await pickPhoto();

  expect(screen.getByText(/1024×768/)).toBeTruthy();
  expect(adviceText()).toBeNull();
});

test("H2: picking a larger photo after a small one drops the advice", async () => {
  const { engine } = setup();
  engine.queueImportPick({ picked: true, stagingId: "staging-small-0001", width: 246, height: 281 });
  await openImport();
  await pickPhoto();
  expect(adviceText()).toBe(SMALL_ADVICE);

  // The mock's own pick: 1024 × 1365.
  fireEvent.click(pickButton());
  await waitFor(() => expect(screen.getByText(/1024×1365/)).toBeTruthy());
  expect(adviceText()).toBeNull();
});
