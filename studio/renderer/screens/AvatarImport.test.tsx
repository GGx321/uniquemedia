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

function confirmCheckbox(): HTMLElement {
  return screen.getByRole("checkbox", { name: "это ИИ-персона, а не фото реального человека" });
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
  expect(screen.queryByText(/ожидаемая/)).toBeNull();
  expect(callsOf(engine, "avatars.pickImportPhoto")).toHaveLength(0);
  expect(callsOf(engine, "avatars.estimateImport")).toHaveLength(0);
});

// M1: the import screen's own empty state — there is no "Оценить стоимость"
// button here to point to; the estimate appears on its own after a pick.
test("M1: the empty estimate state never mentions the wizard's own (nonexistent, here) estimate button", async () => {
  setup();
  await openImport();
  expect(await screen.findByText(/Сначала выберите фото/)).toBeTruthy();
  expect(screen.queryByText(/Оценить стоимость/)).toBeNull();
});

// M1: the import's age check is mandatory whatever settings.imageAgeCheck
// says — the caption must say so plainly, not the avatar-creation wording
// ("Дескриптор и 4 портрета…") which does not describe this flow at all.
test("M1: the estimate's caption is the import's own — the mandatory age check and describe attempts, not avatar-creation wording", async () => {
  setup();
  await openImport();
  await pickPhoto();

  expect(await screen.findByText(/Обязательная проверка возраста и описание по фото \(до 2 попыток\)/)).toBeTruthy();
  expect(screen.queryByText(/Дескриптор и 4 портрета/)).toBeNull();
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

test("the confirmation checkbox is required: the engine refuses without it, so the UI never sends acceptedWorstMicros with it unchecked", async () => {
  const { engine } = setup();
  await openImport();
  await pickPhoto();
  fireEvent.change(nameInput(), { target: { value: "Zoe" } });

  fireEvent.click(importButton());
  await flush();

  expect(await screen.findByText(/Подтвердите, что это ИИ-персона/)).toBeTruthy();
  expect(callsOf(engine, "avatars.importAvatar")).toHaveLength(0);
});

test("a name is required before the import is sent", async () => {
  const { engine } = setup();
  await openImport();
  await pickPhoto();
  fireEvent.click(confirmCheckbox());

  fireEvent.click(importButton());
  await flush();

  expect(await screen.findByText("Введите имя.")).toBeTruthy();
  expect(callsOf(engine, "avatars.importAvatar")).toHaveLength(0);
});

test("happy path: pick, tick the confirmation, name it, import — lands back on Avatars with the new avatar saved", async () => {
  const { engine } = setup();
  await openImport();
  await pickPhoto();
  fireEvent.click(confirmCheckbox());
  fireEvent.change(nameInput(), { target: { value: "Zoe" } });

  fireEvent.click(importButton());
  await screen.findByRole("heading", { level: 1, name: "Аватары" });

  const [imported] = callsOf(engine, "avatars.importAvatar");
  expect(imported?.payload).toMatchObject({ name: "Zoe", confirmedAiPersona: true });
  await screen.findByText(/Аватар «Zoe» сохранён/);
  await screen.findByRole("heading", { level: 2, name: "Zoe" });
});

test("AGE_CHECK_FAILED: nothing to retry with, back to step 1 with a clear message", async () => {
  const { engine } = setup();
  engine.failNextImportAgeCheck();
  await openImport();
  await pickPhoto();
  fireEvent.click(confirmCheckbox());
  fireEvent.change(nameInput(), { target: { value: "Zoe" } });

  fireEvent.click(importButton());
  await screen.findByText(/не подтвердила уверенно/);

  expect(estimateText()).toBeNull();
  expect(pickButton().textContent).toBe("Выбрать фото");
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
    fireEvent.click(confirmCheckbox());
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
  fireEvent.click(confirmCheckbox());
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
  fireEvent.click(confirmCheckbox());
  fireEvent.change(nameInput(), { target: { value: "Zoe" } });
  engine.setImportPrice({ expectedMicros: 6_000, worstMicros: 45_000 });

  fireEvent.click(importButton());
  await screen.findByText(/Цена выросла/);

  expect(callsOf(engine, "avatars.importAvatar")).toHaveLength(1);
  expect(importButton().textContent).toContain("Подтвердить новую цену");
});
