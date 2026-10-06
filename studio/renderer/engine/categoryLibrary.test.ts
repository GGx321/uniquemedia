import { describe, expect, test } from "bun:test";
import type { AvatarSummary, CategoryInterrupted, CategorySummary, CommandMessage, CommandType, Estimate } from "../../shared/engine";
import { DEFAULT_TRAITS } from "../lib/traits";
import { CategoryLibrary, type CategoryLibraryView } from "./categoryLibrary";
import { mockCategoryPool } from "./mockCategories";
import { MockEngine, mockDescriptor, mockEngineClient } from "./mockEngine";
import { ManualScheduler } from "./scheduler";
import { EngineStore } from "./store";

// CS.3: the window's category slice. One per window (the engine provider owns it), so a create the owner hid, or a screen left while a pool
// is composed, still lands: its answer goes into this slice, not into a component that may be gone. It lists on demand (`categories.list`,
// first when a screen retains it, again after a snapshot taken again and on a library switch), follows `category.changed`, prices the pool
// call (`categories.estimate`, keyed by the text model it runs on) and makes the window's one paid category call at a time.

const MIA: AvatarSummary = {
  avatarId: "avatar-mia-0001",
  name: "Mia",
  descriptor: mockDescriptor(DEFAULT_TRAITS),
  masterPhotoId: "photo-mia-0001",
  createdAt: "2026-09-24T09:00:00.000Z",
  status: "active",
  photoCount: 1,
  videoCount: 0,
  eligibleUnusedCount: 0,
  usage: { state: "ok" },
};

function category(n: number, name: string): CategorySummary {
  const { label, style, pool } = mockCategoryPool(name, `описание ${name}`);
  return {
    categoryId: `cat-seeded-${String(n).padStart(4, "0")}`,
    name,
    description: `описание ${name}`,
    label,
    style,
    pool,
    model: "x-ai/grok-4.3",
    spentMicros: 5_000,
    // Before the mock's clock starts (2026-09-24), so a category the mock makes is newer, as it would be.
    createdAt: `2026-09-0${n}T09:00:00.000Z`,
    updatedAt: `2026-09-0${n}T09:00:00.000Z`,
  };
}

const PARIS = category(1, "Кофейни Парижа");
const WINTER = category(2, "Горы зимой");

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

async function started(options: ConstructorParameters<typeof MockEngine>[0] = {}) {
  const scheduler = new ManualScheduler();
  const engine = new MockEngine({ scheduler, avatars: [MIA], ...options });
  const client = mockEngineClient(engine);
  const store = new EngineStore(client);
  store.start();
  const library = new CategoryLibrary(client, store);
  library.start();
  await settle();
  return { scheduler, engine, client, store, library };
}

type Harness = Awaited<ReturnType<typeof started>>;

const callsOf = <T extends CommandType>(engine: MockEngine, type: T): Extract<CommandMessage, { type: T }>[] =>
  engine.calls.filter((c): c is Extract<CommandMessage, { type: T }> => c.type === type);

function ready(view: CategoryLibraryView) {
  if (view.list.status !== "ready") throw new Error(`the list is ${view.list.status}`);
  return view.list;
}

const names = (h: Harness) => ready(h.library.getView()).categories.map((c) => c.name);

function price(h: Harness): Estimate {
  const p = h.library.getView().price;
  if (p === null) throw new Error("no price");
  return p.estimate;
}

/** Retains the slice as a screen would, and lets the list and the price answer. */
async function retained(h: Harness): Promise<() => void> {
  const release = h.library.retain();
  await settle();
  return release;
}

describe("the list", () => {
  test("is not asked for until a screen retains the slice; then once, with the pool call's price", async () => {
    const h = await started({ categories: [PARIS, WINTER] });
    expect(callsOf(h.engine, "categories.list")).toHaveLength(0);
    expect(h.library.getView().list.status).toBe("loading");
    await retained(h);
    expect(callsOf(h.engine, "categories.list")).toHaveLength(1);
    expect(names(h)).toEqual(["Кофейни Парижа", "Горы зимой"]);
    expect(price(h)).toMatchObject({ expectedMicros: 6_000, worstMicros: 45_000 });
    // A second screen retaining it asks nothing more.
    await retained(h);
    expect(callsOf(h.engine, "categories.list")).toHaveLength(1);
    expect(callsOf(h.engine, "categories.estimate")).toHaveLength(1);
  });

  test("follows category.changed: a category made in another window comes in creation order, a deleted one goes", async () => {
    const h = await started({ categories: [PARIS] });
    await retained(h);
    await h.client.request("categories.create", { name: "Рынки", description: "рынки", acceptedWorstMicros: 45_000 });
    await settle();
    expect(names(h)).toEqual(["Кофейни Парижа", "Рынки"]);
    await h.client.request("categories.update", { categoryId: PARIS.categoryId, name: "Кофейни и улочки" });
    await settle();
    expect(names(h)).toEqual(["Кофейни и улочки", "Рынки"]);
    await h.client.request("categories.delete", { categoryId: PARIS.categoryId });
    await settle();
    expect(names(h)).toEqual(["Рынки"]);
  });

  test("a change heard before the list answers is applied to it, not lost", async () => {
    const h = await started({ categories: [PARIS] });
    h.engine.delayNext("categories.list", 50);
    h.library.retain();
    await settle();
    await h.client.request("categories.delete", { categoryId: PARIS.categoryId });
    await settle();
    h.scheduler.runAll();
    await settle();
    // The mock answers the list as it is when it answers; either way the deleted category is not shown.
    expect(names(h)).toEqual([]);
  });

  test("is asked again after a snapshot taken again, keeping the last list on show meanwhile", async () => {
    const h = await started({ categories: [PARIS] });
    await retained(h);
    h.engine.delayNext("categories.list", 50);
    h.store.reload();
    await settle();
    expect(callsOf(h.engine, "categories.list")).toHaveLength(2);
    expect(names(h)).toEqual(["Кофейни Парижа"]);
    h.scheduler.runAll();
    await settle();
    expect(names(h)).toEqual(["Кофейни Парижа"]);
  });

  test("a library switch lists again, and the old library's list is not shown for the new one", async () => {
    const h = await started({ categories: [PARIS] });
    await retained(h);
    h.engine.delayNext("categories.list", 50);
    await h.client.request("settings.setLibraryPath", { path: "/Users/studio/Other library" });
    await settle();
    expect(h.library.getView().list.status).toBe("loading");
    h.scheduler.runAll();
    await settle();
    expect(callsOf(h.engine, "categories.list").length).toBeGreaterThanOrEqual(2);
    expect(h.library.getView().list.status).toBe("ready");
  });

  test("a library switch while no screen shows the slice: the next screen starts from loading, never from the old library's list", async () => {
    const h = await started({ categories: [PARIS] });
    const release = await retained(h);
    expect(names(h)).toEqual(["Кофейни Парижа"]);
    release();
    await h.client.request("settings.setLibraryPath", { path: "/Users/studio/Other library" });
    await settle();
    const lists = callsOf(h.engine, "categories.list").length;
    h.engine.delayNext("categories.list", 50);
    h.library.retain();
    expect(h.library.getView().list.status).toBe("loading");
    await settle();
    expect(callsOf(h.engine, "categories.list").length).toBe(lists + 1);
    expect(h.library.getView().list.status).toBe("loading");
    h.scheduler.runAll();
    await settle();
    expect(h.library.getView().list.status).toBe("ready");
  });

  test("a snapshot taken again while no screen shows the slice: the next screen lists afresh", async () => {
    const h = await started({ categories: [PARIS] });
    const release = await retained(h);
    release();
    h.store.reload();
    await settle();
    const lists = callsOf(h.engine, "categories.list").length;
    await retained(h);
    expect(callsOf(h.engine, "categories.list").length).toBe(lists + 1);
  });

  test("a failed list says why, and a reload asks again", async () => {
    const h = await started({ categories: [PARIS] });
    h.engine.failNext("categories.list", { code: "LIBRARY_UNAVAILABLE" });
    await retained(h);
    const list = h.library.getView().list;
    expect(list.status === "failed" && list.error.code).toBe("LIBRARY_UNAVAILABLE");
    h.library.reload();
    await settle();
    expect(names(h)).toEqual(["Кофейни Парижа"]);
  });

  test("a delete while categories are left out over the limit lists again, so the one that comes back is shown", async () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ ...category(1, `Категория ${i + 1}`), categoryId: `cat-many-${String(i + 1).padStart(4, "0")}` as const, createdAt: new Date(Date.UTC(2026, 8, 1, 9, i)).toISOString() }));
    const h = await started({ categories: many });
    await retained(h);
    expect(ready(h.library.getView()).overLimit).toBe(1);
    expect(ready(h.library.getView()).categories).toHaveLength(50);
    const result = await h.library.remove(many[0]?.categoryId ?? "cat-none-0000");
    expect(result.ok).toBe(true);
    await settle();
    expect(ready(h.library.getView()).overLimit).toBe(0);
    expect(names(h).at(-1)).toBe("Категория 51");
  });
});

describe("the price", () => {
  test("is asked again when the text model the pool call runs on changes", async () => {
    const h = await started();
    await retained(h);
    expect(callsOf(h.engine, "categories.estimate")).toHaveLength(1);
    const settings = h.store.getView().settings;
    if (settings === null) throw new Error("no settings");
    h.engine.setCategoryPrice({ expectedMicros: 7_000, worstMicros: 52_000 });
    await h.client.request("settings.setModels", { imageModel: settings.imageModel, textModel: "openai/gpt-5-mini" });
    await settle();
    expect(callsOf(h.engine, "categories.estimate")).toHaveLength(2);
    expect(price(h)).toMatchObject({ worstMicros: 52_000 });
    expect(h.library.getView().price?.key).toContain("openai/gpt-5-mini");
  });
});

describe("a create", () => {
  test("sends exactly the accepted worst case, is in view while it runs, then lands in the list and tells who listens", async () => {
    const h = await started({ categories: [PARIS] });
    await retained(h);
    const created: string[] = [];
    h.library.subscribeCreated((c) => created.push(c.name));
    h.engine.delayNext("categories.create", 100);
    const done = h.library.create("Рынки", "рынки и прилавки", price(h));
    await settle();
    expect(h.library.getView().call).toMatchObject({ kind: "create", name: "Рынки", description: "рынки и прилавки", acceptedWorstMicros: 45_000 });
    h.scheduler.runAll();
    await done;
    await settle();
    expect(callsOf(h.engine, "categories.create").map((c) => c.payload)).toEqual([{ name: "Рынки", description: "рынки и прилавки", acceptedWorstMicros: 45_000 }]);
    expect(h.library.getView().call).toBeNull();
    expect(names(h)).toEqual(["Кофейни Парижа", "Рынки"]);
    expect(created).toEqual(["Рынки"]);
    const outcome = h.library.getView().outcomes.create;
    expect(outcome?.ok === true && outcome.spentMicros).toBe(6_000);
  });

  test("a second create or a regenerate while one is on its way sends nothing", async () => {
    const h = await started({ categories: [PARIS] });
    await retained(h);
    h.engine.delayNext("categories.create", 100);
    const first = h.library.create("Рынки", "рынки", price(h));
    const second = h.library.create("Рынки", "рынки", price(h));
    const third = h.library.regenerate(PARIS.categoryId, "новое описание", price(h));
    await settle();
    h.scheduler.runAll();
    await Promise.all([first, second, third]);
    expect(callsOf(h.engine, "categories.create")).toHaveLength(1);
    expect(callsOf(h.engine, "categories.regenerate")).toHaveLength(0);
  });

  test("PRICE_CHANGED creates nothing: the price is asked again and the outcome keeps the refused worst case to compare", async () => {
    const h = await started();
    await retained(h);
    const accepted = price(h);
    h.engine.setCategoryPrice({ expectedMicros: 7_000, worstMicros: 52_000 });
    await h.library.create("Рынки", "рынки", accepted);
    await settle();
    expect(names(h)).toEqual([]);
    const outcome = h.library.getView().outcomes.create;
    expect(outcome?.ok === false && outcome.error.code).toBe("PRICE_CHANGED");
    expect(outcome?.ok === false && outcome.previousWorstMicros).toBe(45_000);
    expect(price(h)).toMatchObject({ worstMicros: 52_000 });
  });

  test("PRICE_CHANGED takes the old price off until the fresh one answers: no button offers a price that was just refused", async () => {
    const h = await started();
    await retained(h);
    const accepted = price(h);
    h.engine.setCategoryPrice({ expectedMicros: 7_000, worstMicros: 52_000 });
    h.engine.delayNext("categories.estimate", 50);
    await h.library.create("Рынки", "рынки", accepted);
    await settle();
    expect(h.library.getView().price).toBeNull();
    h.scheduler.runAll();
    await settle();
    expect(price(h)).toMatchObject({ worstMicros: 52_000 });
  });

  test("PRICE_CHANGED while an estimate is already on its way: the forced re-price wins over the older answer", async () => {
    const h = await started();
    await retained(h);
    const accepted = price(h);
    h.engine.delayNext("categories.estimate", 100);
    h.library.refreshPrice();
    await settle();
    h.engine.setCategoryPrice({ expectedMicros: 7_000, worstMicros: 52_000 });
    await h.library.create("Рынки", "рынки", accepted);
    await settle();
    expect(price(h)).toMatchObject({ worstMicros: 52_000 });
    h.scheduler.runAll();
    await settle();
    expect(price(h)).toMatchObject({ worstMicros: 52_000 });
  });

  test("a list taken while this window's call ran stops naming it as busy once the call is over", async () => {
    const h = await started();
    await retained(h);
    h.engine.delayNext("categories.create", 100);
    const done = h.library.create("Рынки", "рынки", price(h));
    await settle();
    h.library.reload();
    await settle();
    expect(ready(h.library.getView()).busy).toEqual({ kind: "create", name: "Рынки", categoryId: null });
    h.scheduler.runAll();
    await done;
    await settle();
    expect(ready(h.library.getView()).busy).toBeNull();
  });

  test("another window's call named as busy stops being named once it ends: category.changed lists again", async () => {
    const h = await started();
    await retained(h);
    h.engine.delayNext("categories.create", 500);
    const other = h.client.request("categories.create", { name: "Горы зимой", description: "горы", acceptedWorstMicros: 45_000 });
    await settle();
    h.library.reload();
    await settle();
    expect(ready(h.library.getView()).busy).toEqual({ kind: "create", name: "Горы зимой", categoryId: null });
    h.scheduler.runAll();
    await other;
    await settle();
    expect(ready(h.library.getView()).busy).toBeNull();
  });

  test("an IN_FLIGHT refusal is dropped once the list shows nothing composing any more", async () => {
    const h = await started();
    await retained(h);
    h.engine.delayNext("categories.create", 500);
    const other = h.client.request("categories.create", { name: "Горы зимой", description: "горы", acceptedWorstMicros: 45_000 });
    await settle();
    await h.library.create("Рынки", "рынки", price(h));
    await settle();
    expect(h.library.getView().outcomes.create?.ok === false && h.library.getView().outcomes.create?.error.code).toBe("IN_FLIGHT");
    h.scheduler.runAll();
    await other;
    await settle();
    expect(h.library.getView().outcomes.create).toBeNull();
  });

  test("refused because another window's call runs: nothing is sent twice, and a fresh list names the other call", async () => {
    const h = await started();
    await retained(h);
    h.engine.delayNext("categories.create", 500);
    const other = h.client.request("categories.create", { name: "Горы зимой", description: "горы", acceptedWorstMicros: 45_000 });
    await settle();
    const lists = callsOf(h.engine, "categories.list").length;
    await h.library.create("Рынки", "рынки", price(h));
    await settle();
    const outcome = h.library.getView().outcomes.create;
    expect(outcome?.ok === false && outcome.error.code).toBe("IN_FLIGHT");
    expect(callsOf(h.engine, "categories.list").length).toBe(lists + 1);
    expect(ready(h.library.getView()).busy).toEqual({ kind: "create", name: "Горы зимой", categoryId: null });
    h.scheduler.runAll();
    await other;
  });

  test("a failed pool says what it cost, and nothing is created", async () => {
    const h = await started();
    await retained(h);
    h.engine.failNextCategoryCall({ code: "POOL_REJECTED" }, 11_000);
    await h.library.create("Рынки", "рынки", price(h));
    await settle();
    const outcome = h.library.getView().outcomes.create;
    expect(outcome?.ok === false && outcome.error).toMatchObject({ code: "POOL_REJECTED", spentMicros: 11_000 });
    expect(outcome?.call).toMatchObject({ name: "Рынки", description: "рынки" });
    expect(names(h)).toEqual([]);
    h.library.clearOutcome("create");
    expect(h.library.getView().outcomes.create).toBeNull();
  });
});

describe("a regenerate", () => {
  test("replaces the pool, says what this call cost, and remembers the category was regenerated", async () => {
    const h = await started({ categories: [PARIS] });
    await retained(h);
    await h.library.regenerate(PARIS.categoryId, "кофейни и бистро", price(h));
    await settle();
    const after = ready(h.library.getView()).categories[0];
    expect(after?.description).toBe("кофейни и бистро");
    expect(after?.spentMicros).toBe(PARIS.spentMicros + 6_000);
    const outcome = h.library.getView().outcomes.regenerate;
    expect(outcome?.ok === true && outcome.spentMicros).toBe(6_000);
    expect(h.library.getView().regenerated.get(PARIS.categoryId)).toBe("regenerated");
    // A later failure does not take back that the pool was regenerated.
    h.engine.failNextCategoryCall({ code: "POOL_REJECTED" }, 11_000);
    await h.library.regenerate(PARIS.categoryId, "кофейни и бистро", price(h));
    await settle();
    expect(h.library.getView().regenerated.get(PARIS.categoryId)).toBe("regenerated");
  });

  test("a failed one keeps the old pool and the category's total takes what it cost", async () => {
    const h = await started({ categories: [PARIS] });
    await retained(h);
    h.engine.failNextCategoryCall({ code: "POOL_REJECTED" }, 11_000);
    await h.library.regenerate(PARIS.categoryId, "кофейни и бистро", price(h));
    await settle();
    const after = ready(h.library.getView()).categories[0];
    expect(after?.pool).toEqual(PARIS.pool);
    expect(after?.spentMicros).toBe(PARIS.spentMicros + 11_000);
    const outcome = h.library.getView().outcomes.regenerate;
    expect(outcome?.ok === false && outcome.error.code).toBe("POOL_REJECTED");
    expect(h.library.getView().regenerated.get(PARIS.categoryId)).toBe("retried");
  });
});

describe("a regenerate that was refused for free", () => {
  test("PRICE_CHANGED, IN_FLIGHT and VALIDATION spent nothing: the category is not marked as retried", async () => {
    const h = await started({ categories: [PARIS] });
    await retained(h);
    const accepted = price(h);
    h.engine.setCategoryPrice({ expectedMicros: 7_000, worstMicros: 52_000 });
    await h.library.regenerate(PARIS.categoryId, "кофейни и бистро", accepted);
    await settle();
    expect(h.library.getView().outcomes.regenerate?.ok === false && h.library.getView().outcomes.regenerate?.error.code).toBe("PRICE_CHANGED");
    expect(h.library.getView().regenerated.has(PARIS.categoryId)).toBe(false);
    h.engine.failNext("categories.regenerate", { code: "VALIDATION", categoryReason: "limit" });
    await h.library.regenerate(PARIS.categoryId, "кофейни и бистро", price(h));
    await settle();
    expect(h.library.getView().outcomes.regenerate?.ok === false && h.library.getView().outcomes.regenerate?.error.code).toBe("VALIDATION");
    expect(h.library.getView().regenerated.has(PARIS.categoryId)).toBe(false);
    h.engine.failNext("categories.regenerate", { code: "IN_FLIGHT" });
    await h.library.regenerate(PARIS.categoryId, "кофейни и бистро", price(h));
    await settle();
    expect(h.library.getView().regenerated.has(PARIS.categoryId)).toBe(false);
  });
});

describe("the free commands", () => {
  test("a rename and a removed item are shown from the answer at once", async () => {
    const h = await started({ categories: [PARIS] });
    await retained(h);
    const place = PARIS.pool.locations[0]?.name ?? "";
    const reply = await h.library.update(PARIS.categoryId, { name: "Кофейни" });
    expect(reply.ok).toBe(true);
    expect(names(h)).toEqual(["Кофейни"]);
    const refused = await h.library.update(PARIS.categoryId, { removeLocations: [place] });
    // The mock's pools hold exactly five places: one fewer is refused, and nothing changes.
    expect(refused.ok === false && refused.error.categoryReason).toBe("below-minimum");
    expect(ready(h.library.getView()).categories[0]?.pool.locations).toHaveLength(5);
  });

  test("dismissing an interrupted call lists again, and the record is gone", async () => {
    const interrupted: CategoryInterrupted = {
      jobId: "job-left-0001",
      kind: "create",
      name: "Кофейни Парижа",
      description: "кофейни",
      categoryId: null,
      startedAt: "2026-10-05T09:00:00.000Z",
      spentMicros: 22_500,
      openReserveMicros: 22_500,
    };
    const h = await started({ interruptedCategories: [interrupted] });
    await retained(h);
    expect(ready(h.library.getView()).interrupted).toHaveLength(1);
    const reply = await h.library.dismissInterrupted("job-left-0001");
    expect(reply.ok).toBe(true);
    await settle();
    expect(ready(h.library.getView()).interrupted).toHaveLength(0);
  });
});
