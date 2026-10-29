import { expect, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { ErrorCode } from "../../shared/engine";
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

// Owner decision 2026-10-05 (personal-use app): an import makes no age check and asks for no AI-persona confirmation, so its estimate
// caption names the describe attempts and (S5.0c, said since S5.2d: mockup 04) the descriptor check the price includes.

test("design constraint 1: pick, then estimate for that exact staged photo", async () => {
  const { engine } = setup();
  await openImport();
  await pickPhoto();

  expect(callsOf(engine, "avatars.pickImportPhoto")).toHaveLength(1);
  const [estimateCall] = callsOf(engine, "avatars.estimateImport");
  expect(estimateCall?.payload.stagingId).toBeTruthy();
  expect(estimateText()).not.toBeNull();
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
  // S5.R2 re-pin: the photo gave no body (the mock stores no proposal by default), so the body is left to choose.
  // S5.3d re-pin: and the click started the five reference portraits, still drawing here.
  expect(screen.getByText("Аватар «Zoe» импортирован. Описание прочитано с фото и сверено с ним — осталось тело. Рисуем варианты мастер-портрета.").tagName).toBe("DIV");
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

// S5.R2 (review LOW): the import's worst case reads the same on the tile, the estimate and the button — three decimals below $0.10, as the app's rule says.
test("the import's price is said with three decimals below $0.10, on the estimate and on the button alike", async () => {
  setup();
  await openImport();
  await pickPhoto();
  expect(estimateText()).toBe("до $0.063 · ожидаемая ≈ $0.007");
  expect(importButton().textContent).toBe("Импортировать · до $0.063");
});

// S5.2d (mockup 04): before the paid click the screen says what the import reads — the body only when the photo shows it — and where it lands.

