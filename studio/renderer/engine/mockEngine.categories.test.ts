import { describe, expect, test } from "bun:test";
import { CategoryLabel, CategoryPool, type AvatarSummary, type CategoryInterrupted, type CategorySummary, type EventMessage, type RunRequest } from "../../shared/engine";
import { DEFAULT_TRAITS } from "../lib/traits";
import { mockCategoryPool } from "./mockCategories";
import { MockEngine, mockDescriptor, mockEngineClient } from "./mockEngine";
import { ManualScheduler } from "./scheduler";

// CS.2: the mock's category library, driven through the same validating client the renderer uses, so an answer that drifts from the contract
// (or from the engine's own order of checks, which the parity suite pins for the free commands) fails here first.

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

/** The pool call's price in the mock, as the engine's at the fallback prices: one typical attempt, two at their ceilings. */
const ESTIMATE = { expectedMicros: 6_000, worstMicros: 45_000 };

function makeMock(options: ConstructorParameters<typeof MockEngine>[0] = {}) {
  const scheduler = new ManualScheduler();
  const engine = new MockEngine({ scheduler, avatars: [MIA], ...options });
  const client = mockEngineClient(engine);
  const events: EventMessage[] = [];
  client.subscribe((e) => events.push(e));
  return { scheduler, engine, client, events };
}

type Mock = ReturnType<typeof makeMock>;

async function unwrap<T>(reply: Promise<{ ok: true; result: T } | { ok: false; error: { code: string } }>): Promise<T> {
  const r = await reply;
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`);
  return r.result;
}

/** What the mock's ledger holds for the month so far, in micro-dollars. */
async function spentOf(m: Mock): Promise<number> {
  const status = await unwrap(m.client.request("money.status", {}));
  if (!("spentMicros" in status)) throw new Error("the ledger is not open");
  return status.spentMicros;
}

const missing = "cat-nobody-here" as const;

const create = (m: Mock, name = "Кофейни Парижа", accepted = ESTIMATE.worstMicros) => m.client.request("categories.create", { name, description: "кофейни и булочные Парижа", acceptedWorstMicros: accepted });

async function created(m: Mock, name = "Кофейни Парижа"): Promise<CategorySummary> {
  return (await unwrap(create(m, name))).category;
}

const changes = (events: EventMessage[]) => events.flatMap((e) => (e.type === "category.changed" ? [e.payload] : []));

describe("categories.estimate", () => {
  test("is the pool call's price: $0.006 expected, $0.045 worst, at the prices the mock's others use", async () => {
    const { client } = makeMock();
    expect(await unwrap(client.request("categories.estimate", {}))).toMatchObject(ESTIMATE);
  });

  test("follows setCategoryPrice, so a test can make an accepted price stale", async () => {
    const { client, engine } = makeMock();
    engine.setCategoryPrice({ expectedMicros: 7_000, worstMicros: 50_000 });
    expect(await unwrap(client.request("categories.estimate", {}))).toMatchObject({ expectedMicros: 7_000, worstMicros: 50_000 });
  });
});

describe("categories.list", () => {
  test("an empty library lists nothing, with nothing unreadable, interrupted or busy", async () => {
    const { client } = makeMock();
    expect(await unwrap(client.request("categories.list", {}))).toEqual({ categories: [], unreadable: 0, overLimit: 0, interrupted: [], busy: null });
  });

  test("answers the categories the mock was seeded with, the unreadable count and the interrupted calls", async () => {
    const first = await created(makeMock(), "Alpha");
    const interrupted: CategoryInterrupted = { jobId: "job-00000041", kind: "create", name: "Горы зимой", description: "горы", categoryId: null, startedAt: "2026-10-05T12:00:00.000Z", spentMicros: 22_500, openReserveMicros: 22_500 };
    const { client } = makeMock({ categories: [first], unreadableCategories: 2, interruptedCategories: [interrupted] });

    expect(await unwrap(client.request("categories.list", {}))).toEqual({ categories: [first], unreadable: 2, overLimit: 0, interrupted: [interrupted], busy: null });
  });

  test("without a library: LIBRARY_UNAVAILABLE", async () => {
    const { client, engine } = makeMock();
    engine.setLibraryAvailable(false);
    expect(await client.request("categories.list", {})).toMatchObject({ ok: false, error: { code: "LIBRARY_UNAVAILABLE" } });
  });
});

describe("categories.create", () => {
  test("makes a category with a valid pool, booked at the pool call's typical price, announced and listed", async () => {
    const m = makeMock();
    const before = await spentOf(m);

    const { category, spentMicros } = await unwrap(create(m, "  Кофейни Парижа "));

    expect(category).toMatchObject({ name: "Кофейни Парижа", description: "кофейни и булочные Парижа", spentMicros: 6_000 });
    expect(spentMicros).toBe(6_000);
    expect(CategoryPool.safeParse(category.pool).success).toBe(true);
    expect(category.categoryId).toMatch(/^cat-/);
    expect(changes(m.events)).toEqual([{ change: "upserted", category }]);
    expect((await spentOf(m)) - before).toBe(6_000);
    expect((await unwrap(m.client.request("categories.list", {}))).categories).toEqual([category]);
  });

  test("the pool is deterministic from the name: the same name gives the same pool and label, other names give other ones", async () => {
    const a = await created(makeMock(), "Кофейни Парижа");
    const again = await created(makeMock(), "Кофейни Парижа");
    const other = await created(makeMock(), "Горы зимой");

    expect(again.pool).toEqual(a.pool);
    expect(again.label).toBe(a.label);
    expect(other.pool).not.toEqual(a.pool);
    expect(a.label).toMatch(/^[\x21-\x7e][\x20-\x7e]{0,22}[\x21-\x7e]$/);
  });

  test("every pool the mock makes passes the contract's pool and its label the label rule, whatever the name and description", () => {
    for (let i = 0; i < 300; i++) {
      const made = mockCategoryPool(`name ${i}`, `description ${i * 7}`);
      expect(CategoryPool.safeParse(made.pool).success).toBe(true);
      expect(CategoryLabel.safeParse(made.label).success).toBe(true);
    }
  });

  test("the gates run in the engine's order: key, ledger, library, then the price, then the month, then the name and the limit — nothing is spent by a refusal", async () => {
    const noKey = makeMock({ apiKey: { stored: false, last4: null, encryptionAvailable: true, rejected: false } });
    const noLibrary = makeMock();
    noLibrary.engine.setLibraryAvailable(false);
    const stale = makeMock();
    const poor = makeMock({ money: { monthlyBudgetMicros: ESTIMATE.worstMicros - 1 } });
    const before = await Promise.all([noKey, noLibrary, stale, poor].map(spentOf));

    expect(await create(noKey)).toMatchObject({ ok: false, error: { code: "AUTH_INVALID" } });
    expect(await create(noLibrary)).toMatchObject({ ok: false, error: { code: "LIBRARY_UNAVAILABLE" } });
    expect(await create(stale, "Кофейни", ESTIMATE.worstMicros - 1)).toMatchObject({ ok: false, error: { code: "PRICE_CHANGED" } });
    expect(await create(poor)).toMatchObject({ ok: false, error: { code: "BUDGET_EXCEEDED" } });

    expect(await Promise.all([noKey, noLibrary, stale, poor].map(spentOf))).toEqual(before);
    for (const m of [noKey, noLibrary, stale, poor]) expect(changes(m.events)).toEqual([]);
  });

  test("a name another category holds (any letter case, edge spaces) is VALIDATION and spends nothing", async () => {
    const m = makeMock();
    await created(m, "Кофейни Парижа");
    const spent = await spentOf(m);

    expect(await create(m, " кофейни парижа ")).toMatchObject({ ok: false, error: { code: "VALIDATION", categoryReason: "name-taken" } });

    expect(await spentOf(m)).toBe(spent);
    expect((await unwrap(m.client.request("categories.list", {}))).categories).toHaveLength(1);
  });

  test("the 51st category is VALIDATION", async () => {
    const m = makeMock();
    for (let i = 0; i < 50; i++) await created(m, `Category ${i}`);
    expect(await create(m, "One too many")).toMatchObject({ ok: false, error: { code: "VALIDATION", categoryReason: "limit" } });
    expect((await unwrap(m.client.request("categories.list", {}))).categories).toHaveLength(50);
  });

  test("a file that cannot be read counts towards the limit, as it does in the engine: 49 readable and one unreadable leave no room", async () => {
    const m = makeMock();
    for (let i = 0; i < 49; i++) await created(m, `Category ${i}`);
    const full = makeMock({ categories: (await unwrap(m.client.request("categories.list", {}))).categories, unreadableCategories: 1 });

    expect(await create(full, "One too many")).toMatchObject({ ok: false, error: { code: "VALIDATION", categoryReason: "limit" } });
  });

  test("more than 50 seeded categories list as the 50 oldest and a count of the rest, never an answer the contract refuses", async () => {
    const m = makeMock();
    for (let i = 0; i < 50; i++) await created(m, `Category ${i}`);
    const fifty = (await unwrap(m.client.request("categories.list", {}))).categories;
    const extra = { ...fifty[0], categoryId: "cat-fifty-one-0001" as const, name: "Fifty one" } as CategorySummary;
    const over = makeMock({ categories: [...fifty, extra] });

    const listed = await unwrap(over.client.request("categories.list", {}));

    expect(listed.categories).toHaveLength(50);
    expect(listed.overLimit).toBe(1);
  });

  test("a forced failure of the call books what it cost, carries it in the error, and stores nothing", async () => {
    const m = makeMock();
    m.engine.failNextCategoryCall({ code: "POOL_REJECTED" }, 11_300);
    const before = await spentOf(m);

    const reply = await create(m);

    expect(reply).toMatchObject({ ok: false, error: { code: "POOL_REJECTED", spentMicros: 11_300 } });
    expect((await spentOf(m)) - before).toBe(11_300);
    expect((await unwrap(m.client.request("categories.list", {}))).categories).toEqual([]);
    expect(changes(m.events)).toEqual([]);
    // One call at a time ended: the next one goes through.
    expect((await create(m)).ok).toBe(true);
  });
});

describe("one category call at a time", () => {
  test("a second paid call while one is waiting is IN_FLIGHT at once, the busy call is named in the list, and a library switch is refused", async () => {
    const m = makeMock();
    m.engine.delayNext("categories.create", 1_000);
    const first = create(m, "Горы зимой");
    await Promise.resolve();

    expect(await m.client.request("categories.create", { name: "Другая", description: "d", acceptedWorstMicros: ESTIMATE.worstMicros })).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });
    expect(await m.client.request("settings.setLibraryPath", { path: "/elsewhere" })).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });

    m.scheduler.runAll();
    expect((await first).ok).toBe(true);
    expect((await unwrap(m.client.request("categories.list", {}))).busy).toBeNull();
  });

  test("a rename to the name a create in flight is about to take is refused at once, and the create still completes", async () => {
    const m = makeMock();
    const other = await created(m, "Other");
    m.engine.delayNext("categories.create", 1_000);
    const first = create(m, "Горы зимой");
    await Promise.resolve();

    expect(await m.client.request("categories.update", { categoryId: other.categoryId, name: " горы ЗИМОЙ " })).toMatchObject({ ok: false, error: { code: "VALIDATION", categoryReason: "name-taken" } });
    expect(await m.client.request("categories.update", { categoryId: other.categoryId, name: "Другое" })).toMatchObject({ ok: true });

    m.scheduler.runAll();
    expect((await first).ok).toBe(true);
    expect((await unwrap(m.client.request("categories.list", {}))).categories.map((c) => c.name)).toEqual(["Другое", "Горы зимой"]);
  });

  test("the list names the call in flight", async () => {
    const m = makeMock();
    m.engine.delayNext("categories.create", 1_000);
    const first = create(m, "Горы зимой");
    await Promise.resolve();

    expect(await unwrap(m.client.request("categories.list", {}))).toMatchObject({ busy: { kind: "create", name: "Горы зимой", categoryId: null } });
    m.scheduler.runAll();
    await first;
  });
});

describe("categories.regenerate", () => {
  const regenerate = (m: Mock, categoryId: `cat-${string}`, accepted = ESTIMATE.worstMicros) => m.client.request("categories.regenerate", { categoryId, description: "кофейни и булочные у Сены", acceptedWorstMicros: accepted });

  test("a new pool for the same id and name; the call's price adds to the total; announced", async () => {
    const m = makeMock();
    const old = await created(m, "Кофейни");
    m.events.length = 0;

    const result = await unwrap(regenerate(m, old.categoryId));

    expect(result.spentMicros).toBe(6_000);
    expect(result.category).toMatchObject({ categoryId: old.categoryId, name: "Кофейни", description: "кофейни и булочные у Сены", spentMicros: 12_000 });
    expect(result.category.pool).not.toEqual(old.pool);
    expect(changes(m.events)).toEqual([{ change: "upserted", category: result.category }]);
  });

  test("an unknown category is NOT_FOUND, and an accepted worst case below the price is PRICE_CHANGED", async () => {
    const m = makeMock();
    const old = await created(m);
    expect(await regenerate(m, missing)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await regenerate(m, old.categoryId, ESTIMATE.worstMicros - 1)).toMatchObject({ ok: false, error: { code: "PRICE_CHANGED" } });
  });

  test("a failed regeneration keeps the old pool, tells what it cost, and adds that to the category's total", async () => {
    const m = makeMock();
    const old = await created(m);
    m.events.length = 0;
    m.engine.failNextCategoryCall({ code: "POOL_REJECTED" }, 11_300);

    expect(await regenerate(m, old.categoryId)).toMatchObject({ ok: false, error: { code: "POOL_REJECTED", spentMicros: 11_300 } });

    const [kept] = (await unwrap(m.client.request("categories.list", {}))).categories;
    expect(kept?.pool).toEqual(old.pool);
    expect(kept?.spentMicros).toBe(6_000 + 11_300);
    expect(changes(m.events)).toHaveLength(1);
  });

  test("while it waits, a rename or a delete of that category is IN_FLIGHT, another category's is not, and the busy call names its category", async () => {
    const m = makeMock();
    const target = await created(m, "Кофейни");
    const other = await created(m, "Other");
    m.engine.delayNext("categories.regenerate", 1_000);
    const running = regenerate(m, target.categoryId);
    await Promise.resolve();

    expect(await m.client.request("categories.update", { categoryId: target.categoryId, name: "Renamed" })).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });
    expect(await m.client.request("categories.delete", { categoryId: target.categoryId })).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });
    expect((await m.client.request("categories.update", { categoryId: other.categoryId, name: "Other renamed" })).ok).toBe(true);
    expect(await unwrap(m.client.request("categories.list", {}))).toMatchObject({ busy: { kind: "regenerate", name: "Кофейни", categoryId: target.categoryId } });
    m.scheduler.runAll();
    await running;
  });
});

describe("categories.update and categories.delete", () => {
  test("a rename is free, stored trimmed and announced; a name another category holds is VALIDATION", async () => {
    const m = makeMock();
    const alpha = await created(m, "Alpha");
    await created(m, "Beta");
    m.events.length = 0;

    const { category } = await unwrap(m.client.request("categories.update", { categoryId: alpha.categoryId, name: " Alpha two " }));

    expect(category.name).toBe("Alpha two");
    expect(category.updatedAt >= alpha.updatedAt).toBe(true);
    expect(changes(m.events)).toEqual([{ change: "upserted", category }]);
    expect(await m.client.request("categories.update", { categoryId: alpha.categoryId, name: "BETA" })).toMatchObject({ ok: false, error: { code: "VALIDATION", categoryReason: "name-taken" } });
  });

  test("removes a place or an outfit by its text, never below the pool's minimums, never the last mirror place, never one that is not there", async () => {
    const m = makeMock();
    const made = await created(m);
    const [firstOutfit] = made.pool.outfits;
    const [firstPlace] = made.pool.locations;
    if (firstOutfit === undefined || firstPlace === undefined) throw new Error("unreachable");

    // A fresh pool is at its minimum in places: no place can go.
    expect(await m.client.request("categories.update", { categoryId: made.categoryId, removeLocations: [firstPlace.name] })).toMatchObject({ ok: false, error: { code: "VALIDATION", categoryReason: "below-minimum" } });
    expect(await m.client.request("categories.update", { categoryId: made.categoryId, removeOutfits: ["a hat nobody has"] })).toMatchObject({ ok: false, error: { code: "VALIDATION", categoryReason: "item-not-found" } });
    const kept = (await unwrap(m.client.request("categories.list", {}))).categories[0];
    expect(kept?.pool).toEqual(made.pool);
    // Outfits: the mock's pool has more than the minimum, so one can go.
    if (made.pool.outfits.length > 3) {
      const { category } = await unwrap(m.client.request("categories.update", { categoryId: made.categoryId, removeOutfits: [firstOutfit] }));
      expect(category.pool.outfits).toEqual(made.pool.outfits.slice(1));
    }
  });

  test("an unknown category is NOT_FOUND, and delete removes, announces and frees the name", async () => {
    const m = makeMock();
    const made = await created(m, "Gone");
    expect(await m.client.request("categories.update", { categoryId: missing, name: "x" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await m.client.request("categories.delete", { categoryId: missing })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    m.events.length = 0;

    expect(await unwrap(m.client.request("categories.delete", { categoryId: made.categoryId }))).toEqual({ categoryId: made.categoryId });

    expect(changes(m.events)).toEqual([{ change: "removed", categoryId: made.categoryId }]);
    expect((await unwrap(m.client.request("categories.list", {}))).categories).toEqual([]);
    expect((await create(m, "Gone")).ok).toBe(true);
  });

  test("without a library: LIBRARY_UNAVAILABLE", async () => {
    const m = makeMock();
    m.engine.setLibraryAvailable(false);
    expect(await m.client.request("categories.update", { categoryId: missing, name: "x" })).toMatchObject({ ok: false, error: { code: "LIBRARY_UNAVAILABLE" } });
  });
});

describe("categories.dismissInterrupted", () => {
  const interrupted: CategoryInterrupted = { jobId: "job-00000041", kind: "create", name: "Горы зимой", description: "горы", categoryId: null, startedAt: "2026-10-05T12:00:00.000Z", spentMicros: 22_500, openReserveMicros: 22_500 };

  test("forgets the record of an interrupted call", async () => {
    const m = makeMock({ interruptedCategories: [interrupted] });
    expect(await unwrap(m.client.request("categories.dismissInterrupted", { jobId: interrupted.jobId }))).toEqual({ jobId: interrupted.jobId });
    expect((await unwrap(m.client.request("categories.list", {}))).interrupted).toEqual([]);
  });

  test("dismissing an interrupted regenerate adds what it is counted at to its category's total and announces the change, as the engine does", async () => {
    const m = makeMock();
    const made = await created(m, "Кофейни");
    const regenerating: CategoryInterrupted = { jobId: "job-00000042", kind: "regenerate", name: "Кофейни", description: "кофейни", categoryId: made.categoryId, startedAt: "2026-10-05T12:00:00.000Z", spentMicros: 22_500, openReserveMicros: 22_500 };
    m.engine.seedInterruptedCategory(regenerating);
    m.events.length = 0;

    await unwrap(m.client.request("categories.dismissInterrupted", { jobId: regenerating.jobId }));

    const listed = await unwrap(m.client.request("categories.list", {}));
    expect(listed.categories[0]?.spentMicros).toBe(made.spentMicros + 22_500);
    expect(changes(m.events)).toEqual([{ change: "upserted", category: listed.categories[0] }]);
  });

  test("dismissing an interrupted create changes no category", async () => {
    const m = makeMock({ interruptedCategories: [interrupted] });
    await unwrap(m.client.request("categories.dismissInterrupted", { jobId: interrupted.jobId }));
    expect(changes(m.events)).toEqual([]);
  });

  test("NOT_FOUND for a record that is not listed", async () => {
    const { client } = makeMock();
    expect(await client.request("categories.dismissInterrupted", { jobId: "job-00000099" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  test("a test can leave one", async () => {
    const m = makeMock();
    m.engine.seedInterruptedCategory(interrupted);
    expect((await unwrap(m.client.request("categories.list", {}))).interrupted).toEqual([interrupted]);
  });
});

describe("a custom category in a run request", () => {
  const request = (categories: RunRequest["categories"]): RunRequest => ({ avatarId: MIA.avatarId, count: 4, categories, poses: { profile: false, back: false } });

  test("one the library holds is accepted: it is priced as any run, and its photos carry its ref and the name it had at the start", async () => {
    const m = makeMock();
    const made = await created(m, "Кофейни Парижа");
    const run = request(["home", made.categoryId]);
    const { estimate } = await unwrap(m.client.request("runs.estimate", run));
    const builtIn = await unwrap(m.client.request("runs.estimate", request(["home"])));
    expect(estimate).toEqual(builtIn.estimate);

    await unwrap(m.client.request("runs.start", { ...run, acceptedWorstMicros: estimate.worstMicros }));
    await unwrap(m.client.request("categories.update", { categoryId: made.categoryId, name: "Renamed later" }));
    m.scheduler.runAll();

    const { photos } = await unwrap(m.client.request("photos.list", { avatarId: MIA.avatarId }));
    const custom = photos.filter((p) => p.category === made.categoryId);
    expect(custom).toHaveLength(2);
    expect(custom.every((p) => p.categoryName === "Кофейни Парижа")).toBe(true);
    expect(photos.filter((p) => p.category === "home").every((p) => p.categoryName === undefined)).toBe(true);
  });

  test("an unknown or deleted one is NOT_FOUND, before the price", async () => {
    const m = makeMock();
    const made = await created(m);
    await unwrap(m.client.request("categories.delete", { categoryId: made.categoryId }));

    const estimate = await m.client.request("runs.estimate", request(["home", made.categoryId]));
    expect(estimate).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await m.client.request("runs.start", { ...request(["home", made.categoryId]), acceptedWorstMicros: 0 })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });
});
