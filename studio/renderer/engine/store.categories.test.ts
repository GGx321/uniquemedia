import { describe, expect, test } from "bun:test";
import { MockEngine, mockEngineClient } from "./mockEngine";
import { ManualScheduler } from "./scheduler";
import { EngineStore, type CategorySignal } from "./store";

// CS.2: the store hands `category.changed` to its category listeners in seq order, once each, and `resynced` after a snapshot taken again
// (the categories are listed on demand with `categories.list`, so a change missed in the gap is fetched again, not replayed). The window's own
// category slice (CS.3) is built on this.

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

async function started() {
  const engine = new MockEngine({ scheduler: new ManualScheduler() });
  const client = mockEngineClient(engine);
  const store = new EngineStore(client);
  store.start();
  await settle();
  return { engine, client, store };
}

describe("the category listeners", () => {
  test("hear each category.changed in order, and `resynced` after a snapshot taken again (never on the first one)", async () => {
    const h = await started();
    const heard: CategorySignal[] = [];
    const stop = h.store.subscribeCategories((signal) => heard.push(signal));

    const created = await h.client.request("categories.create", { name: "Кофейни Парижа", description: "кофейни", acceptedWorstMicros: 45_000 });
    if (!created.ok) throw new Error("create failed");
    await settle();
    expect(heard.map((s) => s.change)).toEqual(["upserted"]);

    await h.client.request("categories.delete", { categoryId: created.result.category.categoryId });
    await settle();
    expect(heard.map((s) => s.change)).toEqual(["upserted", "removed"]);

    h.store.reload();
    await settle();
    expect(heard.map((s) => s.change)).toEqual(["upserted", "removed", "resynced"]);

    stop();
    h.store.reload();
    await settle();
    expect(heard).toHaveLength(3);
  });

  test("the event keeps the view's seq moving without putting a category in the view", async () => {
    const h = await started();
    const before = h.store.getView().lastSeq;
    await h.client.request("categories.create", { name: "Кофейни Парижа", description: "кофейни", acceptedWorstMicros: 45_000 });
    await settle();
    expect(h.store.getView().lastSeq).toBeGreaterThan(before);
    expect(Object.keys(h.store.getView())).not.toContain("categories");
  });
});
