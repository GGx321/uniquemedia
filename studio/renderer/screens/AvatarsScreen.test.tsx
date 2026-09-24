import { expect, test } from "bun:test";
import { fireEvent, screen, within } from "@testing-library/react";
import type { AvatarSummary, Draft } from "../../shared/engine";
import { MOCK_ESTIMATE, mockDescriptor } from "../engine/mockEngine";
import { DEFAULT_TRAITS } from "../lib/traits";
import { callsOf, flush, setup, inAct } from "../testing";

function zoe(): AvatarSummary {
  return {
    avatarId: "avatar-zoe-0001",
    name: "Zoe",
    descriptor: mockDescriptor(DEFAULT_TRAITS),
    masterPhotoId: "photo-zoe-0001",
    createdAt: "2026-09-24T09:00:00.000Z",
    status: "active",
    photoCount: 3,
  };
}

function cardNames(): string[] {
  return screen.queryAllByRole("heading", { level: 2 }).map((h) => h.textContent ?? "");
}

test("a fresh library shows the empty state with a way to start", async () => {
  setup();
  expect(await screen.findByText("Библиотека пуста")).toBeDefined();
  expect(screen.getByRole("button", { name: /Создать первый аватар/ })).toBeDefined();
});

test("without a key the empty state also points to Settings", async () => {
  setup({ apiKey: { stored: false, last4: null, encryptionAvailable: true, rejected: false } });
  expect(await screen.findByRole("button", { name: "Сначала добавить ключ OpenRouter" })).toBeDefined();
  expect(screen.getByText("Добавьте ключ OpenRouter")).toBeDefined();
});

test("the grid comes from engine.snapshot and is refreshed with avatars.list", async () => {
  const { engine } = setup({ preset: "demo" });
  await screen.findByRole("heading", { level: 2, name: "Mia" });
  await flush();
  expect(cardNames()).toEqual(["Mia", "Sofia", "Elena", "Ava", "Kira"]);
  expect(callsOf(engine, "engine.snapshot")).toHaveLength(1);
  expect(callsOf(engine, "avatars.list")).toHaveLength(1);
  expect(screen.getByText(/5\s*аватаров · 466 фото/)).toBeDefined();

  const mia = screen.getByRole("article", { name: "Mia" });
  expect(within(mia).getByText("124 фото")).toBeDefined();
  expect(within(mia).getByText("Активен")).toBeDefined();
  expect(within(mia).getByRole("img", { name: "Мастер-портрет: Mia" })).toBeDefined();
});

test("the archive filter shows archived avatars only", async () => {
  setup({ preset: "demo" });
  await screen.findByRole("heading", { level: 2, name: "Mia" });
  fireEvent.click(screen.getByRole("radio", { name: "Архив · 1" }));
  expect(cardNames()).toEqual(["Nora"]);
  expect(screen.getByText("В архиве")).toBeDefined();
  expect(screen.queryByRole("button", { name: /Новый аватар/ })).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: "Активные · 5" }));
  expect(cardNames()).toContain("Mia");
});

test("a seq hole is caught up through engine.events", async () => {
  const { engine } = setup({ preset: "demo" });
  await screen.findByRole("heading", { level: 2, name: "Mia" });
  engine.setDelivery(false);
  inAct(() => engine.touchMoney());
  engine.setDelivery(true);
  inAct(() => engine.touchMoney());
  await flush();
  expect(callsOf(engine, "engine.events")).toHaveLength(1);
  expect(callsOf(engine, "engine.snapshot")).toHaveLength(1);
});

test("a gap refetches the snapshot and shows what changed meanwhile", async () => {
  const { engine } = setup({ preset: "demo", eventCapacity: 2 });
  await screen.findByRole("heading", { level: 2, name: "Mia" });
  engine.setDelivery(false);
  engine.addAvatarSilently(zoe());
  inAct(() => engine.touchMoney());
  inAct(() => engine.touchMoney());
  inAct(() => engine.touchMoney());
  engine.setDelivery(true);
  inAct(() => engine.touchMoney());
  expect(await screen.findByRole("heading", { level: 2, name: "Zoe" })).toBeDefined();
  expect(callsOf(engine, "engine.snapshot")).toHaveLength(2);
});

test("a new bootId (engine restart) refetches the snapshot", async () => {
  const { engine } = setup({ preset: "demo" });
  await screen.findByRole("heading", { level: 2, name: "Mia" });
  engine.addAvatarSilently(zoe());
  inAct(() => engine.restart());
  expect(await screen.findByRole("heading", { level: 2, name: "Zoe" })).toBeDefined();
  expect(callsOf(engine, "engine.snapshot")).toHaveLength(2);
});

test("returning to the window catches up via engine.events", async () => {
  const { engine } = setup({ preset: "demo" });
  await screen.findByRole("heading", { level: 2, name: "Mia" });
  document.dispatchEvent(new Event("visibilitychange"));
  await flush();
  expect(callsOf(engine, "engine.events").length).toBeGreaterThanOrEqual(1);
});

test("a draft from the snapshot is listed and reopens the wizard with its candidates", async () => {
  const draft: Draft = {
    avatarId: "avatar-draft-0001",
    traits: DEFAULT_TRAITS,
    descriptor: mockDescriptor(DEFAULT_TRAITS),
    candidates: ["a", "b", "c", "d"].map((x) => ({ avatarId: "avatar-draft-0001", photoId: `photo-draft-000${x}` })),
    estimate: { ...MOCK_ESTIMATE },
  };
  const { engine } = setup({ drafts: [draft] });
  const card = await screen.findByRole("article", { name: "Черновик" });
  expect(within(card).getByText(/4\s*варианта — выберите/)).toBeDefined();

  fireEvent.click(within(card).getByRole("button", { name: "Продолжить" }));
  await screen.findByRole("heading", { level: 1, name: "Новый аватар" });
  expect(screen.getAllByRole("radio", { name: /^Вариант [A-D]$/ })).toHaveLength(4);
  expect(screen.getByText("зафиксирована в черновике")).toBeDefined();
  expect(screen.getByText(draft.descriptor.text)).toBeDefined();

  fireEvent.click(screen.getByRole("radio", { name: "Вариант C" }));
  fireEvent.change(screen.getByRole("textbox", { name: /Имя/ }), { target: { value: "Lena" } });
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await screen.findByRole("heading", { level: 2, name: "Lena" });
  expect(callsOf(engine, "avatars.pick")[0]?.payload).toEqual({ avatarId: draft.avatarId, photoId: "photo-draft-000c", name: "Lena" });
  expect(screen.queryByRole("article", { name: "Черновик" })).toBeNull();
});

test("an engine that does not answer shows a retry", async () => {
  const { engine } = setup({ preset: "demo" });
  // The snapshot request is in flight but not yet answered: make its answer an error.
  engine.failNext("engine.snapshot", { code: "INTERNAL" });
  expect(await screen.findByText("Движок не отвечает")).toBeDefined();
  expect(screen.getByText("Внутренняя ошибка движка.")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
  expect(await screen.findByRole("heading", { level: 2, name: "Mia" })).toBeDefined();
});
