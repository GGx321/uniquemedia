import { afterEach, expect, test } from "bun:test";
import { screen, within } from "@testing-library/react";
import { PHOTO_IDS } from "./engine/mockEngine.testkit";
import { asAnotherWindow, makeDraft, MIA, studio } from "./screens/montage/screenKit";
import { flush, runAll, tick } from "./testing";

// 3d.6: a render has its own row in the sidebar's queue box, «Рендер a / b» (AM4), and is never counted as «Генерация».

afterEach(() => {
  Reflect.deleteProperty(window, "studio");
});

const queue = (): HTMLElement => screen.getByRole("region", { name: "Очередь" });

test("a render is «Рендер 0 / 1» in the queue box, never «Генерация 0 / 240»", async () => {
  const { client } = await studio();
  const made = await makeDraft(client, MIA.avatarId, [PHOTO_IDS[0] ?? ""]);
  await asAnotherWindow(() => client.request("videos.render", { montageId: made.montageId }));

  const box = within(queue());
  expect(box.getByText(/^1\s*задача$/)).toBeDefined();
  expect(box.getByText("Рендер")).toBeDefined();
  expect(box.getByText("0 / 1")).toBeDefined();
  expect(box.queryByText("Генерация")).toBeNull();
  expect(box.queryByText(/240/)).toBeNull();
});

test("«Рендер a / b» counts what was submitted since the queue was last empty: a ended of b, and goes with the queue", async () => {
  const { client, scheduler } = await studio();
  const first = await makeDraft(client, MIA.avatarId, [PHOTO_IDS[0] ?? ""]);
  const second = await makeDraft(client, MIA.avatarId, [PHOTO_IDS[1] ?? ""]);
  await asAnotherWindow(() => client.request("videos.render", { montageId: first.montageId }));
  await asAnotherWindow(() => client.request("videos.render", { montageId: second.montageId }));
  expect(within(queue()).getByText("0 / 2")).toBeDefined();
  expect(within(queue()).getByText(/^2\s*задачи$/)).toBeDefined();

  // The pool runs one at a time: the first ends, the second is still on its way.
  for (let i = 0; i < 40 && within(queue()).queryByText("1 / 2") === null; i++) {
    tick(scheduler);
    await flush();
  }
  expect(within(queue()).getByText("1 / 2")).toBeDefined();
  expect(within(queue()).getByText(/^1\s*задача$/)).toBeDefined();

  runAll(scheduler);
  await flush();
  expect(within(queue()).getByText("пусто")).toBeDefined();
  expect(within(queue()).queryByText("Рендер")).toBeNull();
});

test("the next submit after the queue emptied starts a new count", async () => {
  const { client, scheduler } = await studio();
  const first = await makeDraft(client, MIA.avatarId, [PHOTO_IDS[0] ?? ""]);
  const second = await makeDraft(client, MIA.avatarId, [PHOTO_IDS[1] ?? ""]);
  await asAnotherWindow(() => client.request("videos.render", { montageId: first.montageId }));
  runAll(scheduler);
  await flush();
  expect(within(queue()).getByText("пусто")).toBeDefined();

  await asAnotherWindow(() => client.request("videos.render", { montageId: second.montageId }));
  expect(within(queue()).getByText("0 / 1")).toBeDefined();
});
