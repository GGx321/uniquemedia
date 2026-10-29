import { describe, expect, test } from "bun:test";
import { CategoryPool, type AvatarSummary, type EventMessage } from "../../shared/engine";
import { DEFAULT_TRAITS } from "../lib/traits";
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
const ESTIMATE = { expectedMicros: 5_125, worstMicros: 45_000 };

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


const create = (m: Mock, name = "Кофейни Парижа", accepted = ESTIMATE.worstMicros) => m.client.request("categories.create", { name, description: "кофейни и булочные Парижа", acceptedWorstMicros: accepted });


const changes = (events: EventMessage[]) => events.flatMap((e) => (e.type === "category.changed" ? [e.payload] : []));

describe("categories.estimate", () => {
  test("is the pool call's price: $0.005125 expected, $0.045 worst, at the prices the mock's others use", async () => {
    const { client } = makeMock();
    expect(await unwrap(client.request("categories.estimate", {}))).toMatchObject(ESTIMATE);
  });

});

describe("categories.create", () => {
  test("makes a category with a valid pool, booked at the pool call's typical price, announced and listed", async () => {
    const m = makeMock();
    const before = await spentOf(m);

    const { category, spentMicros } = await unwrap(create(m, "  Кофейни Парижа "));

    expect(category).toMatchObject({ name: "Кофейни Парижа", description: "кофейни и булочные Парижа", spentMicros: 5_125 });
    expect(spentMicros).toBe(5_125);
    expect(CategoryPool.safeParse(category.pool).success).toBe(true);
    expect(category.categoryId).toMatch(/^cat-/);
    expect(changes(m.events)).toEqual([{ change: "upserted", category }]);
    expect((await spentOf(m)) - before).toBe(5_125);
    expect((await unwrap(m.client.request("categories.list", {}))).categories).toEqual([category]);
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

