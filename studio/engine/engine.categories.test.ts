import { describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CategoryPool, CategorySummary, Estimate } from "../shared/engine";
import { openLibrary } from "./library";
import { sequentialIds, steppingClock } from "./library/testing/helpers";
import { chatBody, type FetchCall, type Reply, type Step } from "./openrouter/testing/fakes";
import { rawFileName } from "./rawStore";
import { command, engineSettings, failed, ledgerLines, MODERATION, network, ok, startEngine, until, useEngineDir, writeLedger } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// CS.2: the category commands against a real engine over a real ledger and library in a temp dir; every request goes to a fake fetch
// (prices, and the pool call's chat completions), nothing reaches the network. The harness's `descriptors` steps are the chat queue.

const dir = useEngineDir("studio-engine-categories-");

/** One pool attempt at its ceilings (grok-4.3, fallback prices): 10K in at $1.25/M + 4K out at $2.50/M. */
const ATTEMPT_WORST = 22_500;
/** The estimate at the dated fallback prices: one typical attempt, and both attempts at their ceilings. */
const ESTIMATE: Estimate = { expectedMicros: 6_000, worstMicros: 2 * ATTEMPT_WORST, prices: "fallback", pricesAsOf: "2026-09-24" };

type Json = Record<string, unknown>;

function place(name: string, over: Json = {}): Json {
  return {
    name,
    times: ["morning", "midday"],
    activities: [
      { text: "reading a menu", twoHanded: false },
      { text: "stirring a cappuccino", twoHanded: true },
    ],
    mirror: false,
    ...over,
  };
}

function answer(over: Json = {}): Json {
  return {
    label: "Paris cafes",
    locations: ["a corner cafe", "a flower stall", "a bookshop", "a riverside bench", "a bakery counter"].map((name, i) => place(name, { mirror: i === 2 })),
    outfits: ["a beige trench coat and jeans", "a striped tee and a beret", "a black midi dress"],
    shotDeck: ["friend", "friend", "selfie", "mirror", "candid"],
    ...over,
  };
}

function poolReply(content: unknown = answer(), cost = 0.005): Step {
  return { status: 200, body: chatBody(typeof content === "string" ? content : JSON.stringify(content), { cost }) };
}

const MODERATION_STEP: Step = MODERATION;

/** A chat answer held until `release`, after the request has arrived. */
function held(content: Step) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived = false;
  const step: Step = async () => {
    arrived = true;
    await gate;
    return content as Reply;
  };
  return { step, release, arrived: () => arrived };
}

function createCommand(over: Json = {}): unknown {
  return command("categories.create", { name: "Кофейни Парижа", description: "кофейни и булочные Парижа", acceptedWorstMicros: ESTIMATE.worstMicros, ...over });
}

async function creating(engine: Awaited<ReturnType<typeof startEngine>>["engine"], over: Json = {}): Promise<{ category: CategorySummary; spentMicros: number }> {
  const response = ok(await engine.handle(createCommand(over)));
  if (response.type !== "categories.create") throw new Error(`expected a create answer, got ${response.type}`);
  return response.result;
}

async function listOf(engine: Awaited<ReturnType<typeof startEngine>>["engine"]) {
  const response = ok(await engine.handle(command("categories.list")));
  if (response.type !== "categories.list") throw new Error(`expected a list answer, got ${response.type}`);
  return response.result;
}

function chatCalls(net: ReturnType<typeof network>): FetchCall[] {
  return net.calls.filter((c) => c.url.endsWith("/chat/completions"));
}

function categoriesDir(): string {
  return join(dir(), "library", "categories");
}

async function folder(): Promise<string[]> {
  return (await readdir(categoriesDir()).catch(() => [])).sort();
}

const POOL: CategoryPool = {
  locations: ["a corner cafe", "a flower stall", "a bookshop", "a riverside bench", "a bakery counter"].map((name, i) => ({
    name,
    times: ["morning", "midday"],
    activities: [
      { text: "reading a menu", twoHanded: false },
      { text: "stirring a cappuccino", twoHanded: true },
    ],
    mirror: i === 2,
  })),
  outfits: ["a beige trench coat and jeans", "a striped tee and a beret", "a black midi dress", "a red scarf and a coat"],
  shotDeck: ["friend", "friend", "selfie", "mirror", "candid"],
};

let seeded = 0;
/** A clock that moves on a second at every use and never goes back across the seeds of one test, so creation order is seeding order. */
let seedTick = 0;
const seedClock = (): Date => new Date(Date.parse("2026-10-01T10:00:00.000Z") + ++seedTick * 1000);

async function seedCategory(over: { categoryId?: `cat-${string}`; name?: string; spentMicros?: number } = {}): Promise<`cat-${string}`> {
  const { library } = await openLibrary(join(dir(), "library"), { now: seedClock, newId: sequentialIds(`seedcat${++seeded}`) });
  const categoryId = over.categoryId ?? `cat-seed-${String(seeded).padStart(6, "0")}`;
  await library.categories.create({
    categoryId,
    name: over.name ?? `Seeded ${seeded}`,
    description: "кофейни",
    label: "Paris cafes",
    style: "phone",
    pool: POOL,
    model: "x-ai/grok-4.3",
    spentMicros: over.spentMicros ?? 5_000,
  });
  return categoryId;
}

/** Live prices for the default models: cheaper than the table ($1/M in, $2/M out). */
function livePrices(call: FetchCall): Reply {
  if (call.url.endsWith("/endpoints")) {
    return { status: 200, body: { id: "x-ai/grok-imagine-image-2.0", endpoints: [{ pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.03, variant: "low_1k" }] }] } };
  }
  return { status: 200, body: { data: [{ id: "x-ai/grok-4.3", pricing: { prompt: "0.000001", completion: "0.000002" } }] } };
}

// ---------- categories.estimate ----------

describe("categories.estimate", () => {
  test("prices the pool call at the dated fallback prices when none can be fetched, and says so", async () => {
    const { engine } = await startEngine(dir());
    expect(ok(await engine.handle(command("categories.estimate"))).result).toEqual(ESTIMATE);
  });

  test("is two attempts at their ceilings and one typical attempt at live prices fetched without the key", async () => {
    const net = network({ prices: livePrices });
    const { engine } = await startEngine(dir(), { net });

    const response = ok(await engine.handle(command("categories.estimate")));

    // 10K in × $1/M + 4K out × $2/M = $0.018 an attempt; typical 1,800 in + 1,500 out = $0.0048.
    expect(response.result).toEqual({ expectedMicros: 4_800, worstMicros: 36_000, prices: "live", pricesAsOf: "2026-09-24" });
    expect(net.calls.map((c) => [c.method, "Authorization" in c.headers])).toEqual([["GET", false]]);
  });

  test("prices the text model alone: an image model with no price does not block it", async () => {
    const { engine } = await startEngine(dir(), { init: { settings: engineSettings(dir(), { imageModel: "acme/unknown-image" }) } });
    expect(ok(await engine.handle(command("categories.estimate"))).result).toEqual(ESTIMATE);
  });

  test("a text model neither the live prices nor the table know answers PRICE_UNAVAILABLE", async () => {
    const { engine } = await startEngine(dir(), { init: { settings: engineSettings(dir(), { textModel: "acme/unknown-text" }) } });
    expect(failed(await engine.handle(command("categories.estimate"))).error.code).toBe("PRICE_UNAVAILABLE");
  });

  test("needs no key and no library", async () => {
    const { engine } = await startEngine(dir(), { key: null, init: { settings: engineSettings(dir(), { libraryPath: join(dir(), "missing") }) } });
    expect(ok(await engine.handle(command("categories.estimate"))).result).toEqual(ESTIMATE);
  });
});

// ---------- categories.list ----------

describe("categories.list", () => {
  test("an empty library lists nothing, with nothing unreadable, interrupted or busy", async () => {
    const { engine } = await startEngine(dir());
    expect(await listOf(engine)).toEqual({ categories: [], unreadable: 0, interrupted: [], busy: null });
  });

  test("lists the categories in creation order with their pool, model and what each has cost", async () => {
    const first = await seedCategory({ categoryId: "cat-aaaaaaaa", name: "Alpha", spentMicros: 5_000 });
    const second = await seedCategory({ categoryId: "cat-bbbbbbbb", name: "Beta", spentMicros: 11_000 });
    const { engine } = await startEngine(dir());

    const listed = await listOf(engine);

    expect(listed.categories.map((c) => [c.categoryId, c.name, c.spentMicros, c.label, c.style, c.model])).toEqual([
      [first, "Alpha", 5_000, "Paris cafes", "phone", "x-ai/grok-4.3"],
      [second, "Beta", 11_000, "Paris cafes", "phone", "x-ai/grok-4.3"],
    ]);
    expect(listed.categories[0]?.pool).toEqual(POOL);
  });

  test("counts a file it cannot read and leaves it where it is", async () => {
    await seedCategory();
    await writeFile(join(categoriesDir(), "cat-broken-json.json"), "{nope");
    const { engine } = await startEngine(dir());

    expect(await listOf(engine)).toMatchObject({ unreadable: 1 });
    expect(await folder()).toContain("cat-broken-json.json");
  });

  test("a library with no folder open answers LIBRARY_UNAVAILABLE", async () => {
    const { engine } = await startEngine(dir(), { init: { settings: engineSettings(dir(), { libraryPath: join(dir(), "missing") }) } });
    expect(failed(await engine.handle(command("categories.list"))).error.code).toBe("LIBRARY_UNAVAILABLE");
  });

  test("a call a closed Studio left is listed as interrupted, counted at the worst case its reserve holds until the reconcile", async () => {
    await seedCategory({ categoryId: "cat-paris-cafes", name: "Кофейни" });
    const { library } = await openLibrary(join(dir(), "library"), { now: steppingClock("2026-10-05T12:00:00.000Z") });
    await library.categories.writePending({ jobId: "job-00000041", kind: "create", name: "Горы зимой", description: "горы", categoryId: null, startedAt: "2026-10-05T12:00:00.000Z" });
    await library.categories.writePending({ jobId: "job-00000042", kind: "regenerate", name: "Кофейни", description: "кофейни и булочные", categoryId: "cat-paris-cafes", startedAt: "2026-10-05T12:05:00.000Z" });
    await writeLedger(dir(), [
      { type: "reserve", attemptId: "job-00000041:pool#1", jobId: "job-00000041", scope: { avatarJobId: "job-00000041" }, model: "x-ai/grok-4.3", worstMicros: ATTEMPT_WORST, at: "2026-10-05T12:00:01.000Z" },
      { type: "reserve", attemptId: "job-00000042:pool#1", jobId: "job-00000042", scope: { avatarJobId: "job-00000042" }, model: "x-ai/grok-4.3", worstMicros: ATTEMPT_WORST, at: "2026-10-05T12:05:01.000Z" },
      { type: "settle", attemptId: "job-00000042:pool#1", costMicros: 6_000, estimated: false, at: "2026-10-05T12:05:09.000Z" },
    ]);
    const { engine } = await startEngine(dir());

    const { interrupted } = await listOf(engine);

    expect(interrupted).toEqual([
      { jobId: "job-00000041", kind: "create", name: "Горы зимой", description: "горы", categoryId: null, startedAt: "2026-10-05T12:00:00.000Z", spentMicros: ATTEMPT_WORST, openReserveMicros: ATTEMPT_WORST },
      { jobId: "job-00000042", kind: "regenerate", name: "Кофейни", description: "кофейни и булочные", categoryId: "cat-paris-cafes", startedAt: "2026-10-05T12:05:00.000Z", spentMicros: 6_000, openReserveMicros: 0 },
    ]);
  });

  test("a call killed before its reserve was written is counted at nothing, with no open reserve: a known zero", async () => {
    const { library } = await openLibrary(join(dir(), "library"), { now: steppingClock("2026-10-05T12:00:00.000Z") });
    await library.categories.writePending({ jobId: "job-00000051", kind: "create", name: "Горы зимой", description: "горы", categoryId: null, startedAt: "2026-10-05T12:00:00.000Z" });
    const { engine } = await startEngine(dir());

    const { interrupted } = await listOf(engine);

    expect(interrupted.map((i) => [i.jobId, i.spentMicros, i.openReserveMicros])).toEqual([["job-00000051", 0, 0]]);
  });

  test("a ledger that cannot be read leaves the interrupted call's cost unknown (null), not 0", async () => {
    const { library } = await openLibrary(join(dir(), "library"), { now: steppingClock("2026-10-05T12:00:00.000Z") });
    await library.categories.writePending({ jobId: "job-00000052", kind: "create", name: "Горы зимой", description: "горы", categoryId: null, startedAt: "2026-10-05T12:00:00.000Z" });
    await mkdir(join(dir(), "userData", "ledger.jsonl"), { recursive: true });
    const { engine } = await startEngine(dir());

    const { interrupted } = await listOf(engine);

    expect(interrupted.map((i) => [i.jobId, i.spentMicros, i.openReserveMicros])).toEqual([["job-00000052", null, null]]);
  });
});

// ---------- categories.dismissInterrupted ----------

describe("categories.dismissInterrupted", () => {
  async function leave(jobId: string) {
    const { library } = await openLibrary(join(dir(), "library"), { now: steppingClock("2026-10-05T12:00:00.000Z") });
    await library.categories.writePending({ jobId, kind: "create", name: "Горы зимой", description: "горы", categoryId: null, startedAt: "2026-10-05T12:00:00.000Z" });
  }

  test("forgets the record of an interrupted call, free", async () => {
    await leave("job-00000041");
    const { engine, net } = await startEngine(dir());

    expect(ok(await engine.handle(command("categories.dismissInterrupted", { jobId: "job-00000041" }))).result).toEqual({ jobId: "job-00000041" });

    expect((await listOf(engine)).interrupted).toEqual([]);
    expect(await folder()).toEqual([]);
    expect(net.calls).toHaveLength(0);
  });

  test("answers NOT_FOUND for a record that is not listed", async () => {
    const { engine } = await startEngine(dir());
    expect(failed(await engine.handle(command("categories.dismissInterrupted", { jobId: "job-00000099" }))).error.code).toBe("NOT_FOUND");
  });
});

// ---------- categories.create ----------

describe("categories.create", () => {
  test("one paid pool call makes a category: stored, announced, booked at its cost, and the call's record is gone", async () => {
    const net = network({ descriptors: [poolReply(answer(), 0.0051)] });
    const { engine, events } = await startEngine(dir(), { net });

    const { category, spentMicros } = await creating(engine, { name: "  Кофейни Парижа " });

    expect(category).toMatchObject({ name: "Кофейни Парижа", description: "кофейни и булочные Парижа", label: "Paris cafes", style: "phone", model: "x-ai/grok-4.3", spentMicros: 5_100 });
    expect(category.categoryId).toMatch(/^cat-/);
    expect(category.pool.locations).toHaveLength(5);
    expect(spentMicros).toBe(5_100);
    expect(await folder()).toEqual([`${category.categoryId}.json`]);
    expect(events().filter((e) => e.type === "category.changed").map((e) => e.payload)).toEqual([{ change: "upserted", category }]);
    expect(events().map((e) => e.type)).toContain("money.changed");
    const [reserve, settle, ...rest] = ledgerLines(dir());
    expect(rest).toEqual([]);
    expect(reserve).toMatchObject({ type: "reserve", model: "x-ai/grok-4.3", worstMicros: ATTEMPT_WORST, scope: { avatarJobId: reserve?.jobId } });
    expect(String(reserve?.attemptId)).toMatch(/:pool#1$/);
    expect(settle).toMatchObject({ type: "settle", costMicros: 5_100 });
    expect((await listOf(engine)).categories).toEqual([category]);
  });

  test("the request: the settings' text model, reasoning low, the strict scene_pool schema, the description, and nothing of the name", async () => {
    const net = network({ descriptors: [poolReply()] });
    const { engine } = await startEngine(dir(), { net });

    await creating(engine, { name: "ZEBRA-NAME-MARKER", description: "кофейни и булочные Парижа" });

    const [call] = chatCalls(net);
    const body = call?.json();
    expect(body).toMatchObject({ model: "x-ai/grok-4.3", reasoning: { effort: "low" }, response_format: { type: "json_schema", json_schema: { name: "scene_pool", strict: true } } });
    expect(call?.body).toContain("кофейни и булочные Парижа");
    expect(call?.body?.toLowerCase()).not.toContain("zebra-name-marker");
  });

  test("an answer with a bad item is salvaged in the one call: the category lacks the item, nothing more is paid", async () => {
    const net = network({ descriptors: [poolReply(answer({ outfits: ["a beige trench coat and jeans", "a striped tee and a beret", "a black midi dress", "a red bikini"] }))] });
    const { engine } = await startEngine(dir(), { net });

    const { category } = await creating(engine);

    expect(category.pool.outfits).toEqual(["a beige trench coat and jeans", "a striped tee and a beret", "a black midi dress"]);
    expect(chatCalls(net)).toHaveLength(1);
  });

  test("an answer that cannot be used is asked once more; both attempts are booked and both are the category's cost", async () => {
    const net = network({ descriptors: [poolReply(answer({ shotDeck: [] }), 0.004), poolReply(answer(), 0.0062)] });
    const { engine } = await startEngine(dir(), { net });

    const { category, spentMicros } = await creating(engine);

    expect(spentMicros).toBe(10_200);
    expect(category.spentMicros).toBe(10_200);
    expect(ledgerLines(dir()).filter((l) => l.type === "reserve").map((l) => l.attemptId).map((id) => String(id).replace(/^.*:/, ""))).toEqual(["pool#1", "pool#2"]);
  });

  test("an answer rejected twice is POOL_REJECTED: nothing stored, both attempts booked and told in the error, the call's record gone", async () => {
    const net = network({ descriptors: [poolReply({ pool: "cafes" }, 0.0051), poolReply(answer({ label: "" }), 0.0062)] });
    const { engine, events } = await startEngine(dir(), { net });

    const refused = failed(await engine.handle(createCommand()));

    expect(refused.error).toMatchObject({ code: "POOL_REJECTED", spentMicros: 11_300 });
    expect(await folder()).toEqual([]);
    expect(events().filter((e) => e.type === "category.changed")).toEqual([]);
    expect(ledgerLines(dir()).filter((l) => l.type === "settle").map((l) => l.costMicros)).toEqual([5_100, 6_200]);
  });

  test("a moderation refusal is free and final: MODERATION_REFUSED with nothing spent, nothing stored", async () => {
    const net = network({ descriptors: [MODERATION_STEP] });
    const { engine } = await startEngine(dir(), { net });

    const refused = failed(await engine.handle(createCommand()));

    expect(refused.error).toMatchObject({ code: "MODERATION_REFUSED", spentMicros: 0 });
    expect(chatCalls(net)).toHaveLength(1);
    expect(await folder()).toEqual([]);
  });

  test("a refusal after a rejected first answer still tells what that first answer cost", async () => {
    const net = network({ descriptors: [poolReply(answer({ shotDeck: [] }), 0.006), MODERATION_STEP] });
    const { engine } = await startEngine(dir(), { net });

    expect(failed(await engine.handle(createCommand())).error).toMatchObject({ code: "MODERATION_REFUSED", spentMicros: 6_000 });
  });

  test("a 401 marks the key rejected: the next paid command is refused without sending", async () => {
    const net = network({ descriptors: [{ status: 401, body: { error: { message: "No auth credentials found" } } }, poolReply()] });
    const { engine } = await startEngine(dir(), { net });

    expect(failed(await engine.handle(createCommand())).error.code).toBe("AUTH_INVALID");
    expect(failed(await engine.handle(createCommand({ name: "Another" }))).error.code).toBe("AUTH_INVALID");
    expect(chatCalls(net)).toHaveLength(1);
  });

  test("a request that got no answer leaves its reserve open: NETWORK, counted at the worst case until the reconcile; a restart then refuses paid commands", async () => {
    const net = network({ descriptors: [{ reject: new TypeError("fetch failed") }, poolReply()] });
    const { engine } = await startEngine(dir(), { net });

    const refused = failed(await engine.handle(createCommand()));

    expect(refused.error).toMatchObject({ code: "NETWORK", spentMicros: ATTEMPT_WORST });
    const lines = ledgerLines(dir());
    expect(lines.map((l) => l.type)).toEqual(["reserve"]);
    expect(lines[0]).toMatchObject({ worstMicros: ATTEMPT_WORST });
    expect(await folder()).toEqual([]);

    // A new process finds the open reserve and refuses every paid call until the owner reconciles.
    const again = await startEngine(dir(), { net: network({ descriptors: [poolReply()] }) });
    expect(failed(await again.engine.handle(createCommand({ name: "Another" }))).error.code).toBe("RECONCILE_REQUIRED");
  });

  test("the worst case accepted one micro-dollar below the current one: PRICE_CHANGED, nothing sent, no ledger line, no record", async () => {
    const net = network({ descriptors: [poolReply()] });
    const { engine } = await startEngine(dir(), { net });

    const refused = failed(await engine.handle(createCommand({ acceptedWorstMicros: ESTIMATE.worstMicros - 1 })));

    expect(refused.error.code).toBe("PRICE_CHANGED");
    expect(chatCalls(net)).toHaveLength(0);
    expect(ledgerLines(dir())).toEqual([]);
    expect(await folder()).toEqual([]);
  });

  test("the worst case accepted exactly, or above, goes through", async () => {
    const net = network({ descriptors: [poolReply(), poolReply()] });
    const { engine } = await startEngine(dir(), { net });

    await creating(engine, { acceptedWorstMicros: ESTIMATE.worstMicros });
    await creating(engine, { name: "Second", acceptedWorstMicros: ESTIMATE.worstMicros + 1_000_000 });

    expect((await listOf(engine)).categories).toHaveLength(2);
  });

  test("a month with no room for the worst case: BUDGET_EXCEEDED, nothing sent", async () => {
    const net = network({ descriptors: [poolReply()] });
    const { engine } = await startEngine(dir(), { net, init: { settings: engineSettings(dir(), { monthlyBudgetMicros: ESTIMATE.worstMicros - 1 }) } });

    expect(failed(await engine.handle(createCommand())).error.code).toBe("BUDGET_EXCEEDED");
    expect(chatCalls(net)).toHaveLength(0);
  });

  test("without a key: AUTH_INVALID, nothing sent", async () => {
    const net = network();
    const { engine } = await startEngine(dir(), { net, key: null });

    expect(failed(await engine.handle(createCommand())).error.code).toBe("AUTH_INVALID");
    expect(net.calls).toHaveLength(0);
  });

  test("without a library: LIBRARY_UNAVAILABLE, nothing sent", async () => {
    const net = network();
    const { engine } = await startEngine(dir(), { net, init: { settings: engineSettings(dir(), { libraryPath: join(dir(), "missing") }) } });

    expect(failed(await engine.handle(createCommand())).error.code).toBe("LIBRARY_UNAVAILABLE");
    expect(net.calls).toHaveLength(0);
  });

  test("a name another category holds (any letter case, edge spaces) is VALIDATION: nothing sent, nothing booked", async () => {
    await seedCategory({ name: "Кофейни Парижа" });
    const net = network({ descriptors: [poolReply()] });
    const { engine } = await startEngine(dir(), { net });

    const refused = failed(await engine.handle(createCommand({ name: " кофейни парижа " })));

    expect(refused.error.code).toBe("VALIDATION");
    expect(refused.error.categoryReason).toBe("name-taken");
    expect(chatCalls(net)).toHaveLength(0);
    expect(ledgerLines(dir())).toEqual([]);
  });

  test("the 51st category is VALIDATION: nothing sent, nothing booked", async () => {
    await seedCategory({ categoryId: "cat-fifty-0000", name: "Fifty 0" });
    const stored = JSON.parse(await readFile(join(categoriesDir(), "cat-fifty-0000.json"), "utf8"));
    for (let i = 1; i < 50; i++) await writeFile(join(categoriesDir(), `cat-fifty-${String(i).padStart(4, "0")}.json`), JSON.stringify({ ...stored, categoryId: `cat-fifty-${String(i).padStart(4, "0")}`, name: `Fifty ${i}` }));
    const net = network({ descriptors: [poolReply()] });
    const { engine } = await startEngine(dir(), { net });

    const refused = failed(await engine.handle(createCommand()));
    expect(refused.error.code).toBe("VALIDATION");
    expect(refused.error.categoryReason).toBe("limit");
    expect(chatCalls(net)).toHaveLength(0);
    expect(ledgerLines(dir())).toEqual([]);
  });

  test("a name taken while the paid call runs (a record that appeared in the folder) is VALIDATION with the reason, the cost and the kept pool", async () => {
    await seedCategory({ categoryId: "cat-appears-0001", name: "Appears Later" });
    const record = await readFile(join(categoriesDir(), "cat-appears-0001.json"), "utf8");
    await unlink(join(categoriesDir(), "cat-appears-0001.json"));
    const hold = held(poolReply());
    const net = network({ descriptors: [hold.step] });
    const { engine } = await startEngine(dir(), { net });

    const creatingNow = engine.handle(createCommand({ name: "appears later" }));
    await until(hold.arrived, "the request to arrive");
    await writeFile(join(categoriesDir(), "cat-appears-0001.json"), record);
    hold.release();
    const refused = failed(await creatingNow);

    expect(refused.error).toMatchObject({ code: "VALIDATION", categoryReason: "name-taken", spentMicros: 5_000 });
    expect(refused.error.detail).toContain("raw/");
  });

  test("a library write that fails after the paid call fails the command; the money stays booked and the paid pool is kept in raw/", async () => {
    let failWrites = false;
    const net = network({ descriptors: [poolReply(answer(), 0.0051)] });
    const { engine } = await startEngine(dir(), {
      net,
      deps: {
        library: {
          testHooks: {
            beforeRename: (path) => {
              // The pending record is written first and must go through; the category's own record is the write that fails.
              if (failWrites && !path.includes("pending-")) throw new Error("the disk is full");
            },
          },
        },
      },
    });
    failWrites = true;

    const refused = failed(await engine.handle(createCommand()));

    expect(refused.error).toMatchObject({ code: "INTERNAL", spentMicros: 5_100 });
    const jobId = String(ledgerLines(dir())[0]?.jobId);
    expect(refused.error.detail).toContain(`raw/${rawFileName(`${jobId}:category`)}`);
    const kept = JSON.parse(await readFile(join(dir(), "userData", "raw", rawFileName(`${jobId}:category`)), "utf8"));
    expect(kept).toMatchObject({ name: "Кофейни Парижа", label: "Paris cafes" });
    expect(kept.pool.locations).toHaveLength(5);
    expect(ledgerLines(dir()).at(-1)).toMatchObject({ type: "settle", costMicros: 5_100 });
    expect((await listOf(engine)).categories).toEqual([]);
  });
});

// ---------- serialisation ----------

describe("one category call at a time", () => {
  test("a second create while one runs is IN_FLIGHT: nothing reserved for it, and the busy call is named; the first still ends well", async () => {
    const hold = held(poolReply());
    const net = network({ descriptors: [hold.step, poolReply()] });
    const { engine } = await startEngine(dir(), { net });

    const first = engine.handle(createCommand({ name: "Горы зимой" }));
    await until(hold.arrived, "the first request to arrive");
    const second = failed(await engine.handle(createCommand({ name: "Другая" })));

    expect(second.error.code).toBe("IN_FLIGHT");
    expect(chatCalls(net)).toHaveLength(1);
    expect(ledgerLines(dir()).filter((l) => l.type === "reserve")).toHaveLength(1);
    expect((await listOf(engine)).busy).toEqual({ kind: "create", name: "Горы зимой", categoryId: null });

    hold.release();
    ok(await first);
    expect((await listOf(engine)).busy).toBeNull();
    expect(ok(await engine.handle(createCommand({ name: "Другая" }))).ok).toBe(true);
  });

  test("while a call runs its record is on disk and is not listed as interrupted; when it ends the record is gone", async () => {
    const hold = held(poolReply());
    const net = network({ descriptors: [hold.step] });
    const { engine } = await startEngine(dir(), { net });

    const first = engine.handle(createCommand());
    await until(hold.arrived, "the request to arrive");

    expect((await folder()).filter((f) => f.startsWith("pending-"))).toHaveLength(1);
    expect((await listOf(engine)).interrupted).toEqual([]);

    hold.release();
    ok(await first);
    expect((await folder()).filter((f) => f.startsWith("pending-"))).toEqual([]);
  });

  test("a failed call also releases the flag and removes its record", async () => {
    const net = network({ descriptors: [MODERATION_STEP, poolReply()] });
    const { engine } = await startEngine(dir(), { net });

    failed(await engine.handle(createCommand()));

    expect((await folder()).filter((f) => f.startsWith("pending-"))).toEqual([]);
    expect(ok(await engine.handle(createCommand({ name: "Next" }))).ok).toBe(true);
  });

  test("a library switch is refused while a call runs, and goes through after", async () => {
    const hold = held(poolReply());
    const net = network({ descriptors: [hold.step] });
    const { engine, posted } = await startEngine(dir(), { net });
    await mkdir(join(dir(), "other"));

    const first = engine.handle(createCommand());
    await until(hold.arrived, "the request to arrive");
    await engine.receive({ kind: "control", type: "library.open", callId: "call-00000001", path: join(dir(), "other") });
    expect(posted.at(-1)).toMatchObject({ kind: "control", type: "reply", callId: "call-00000001", error: { code: "IN_FLIGHT" } });

    hold.release();
    ok(await first);
  });

  test("two creates that run together at 49 make one more: the 50 limit is not passed", async () => {
    await seedCategory({ categoryId: "cat-fifty-0000", name: "Fifty 0" });
    const stored = JSON.parse(await readFile(join(categoriesDir(), "cat-fifty-0000.json"), "utf8"));
    for (let i = 1; i < 49; i++) await writeFile(join(categoriesDir(), `cat-fifty-${String(i).padStart(4, "0")}.json`), JSON.stringify({ ...stored, categoryId: `cat-fifty-${String(i).padStart(4, "0")}`, name: `Fifty ${i}` }));
    const net = network({ descriptors: [poolReply(), poolReply()] });
    const { engine } = await startEngine(dir(), { net });

    const results = await Promise.all([engine.handle(createCommand({ name: "Race A" })), engine.handle(createCommand({ name: "Race B" }))]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok && r.error.code === "IN_FLIGHT")).toBeDefined();
    expect((await listOf(engine)).categories).toHaveLength(50);
  });

  test("a rename to the name a running create is about to take is refused at once, so the paid create is not lost: it completes", async () => {
    const hold = held(poolReply());
    const net = network({ descriptors: [hold.step] });
    const { engine } = await startEngine(dir(), { net });
    const other = await seedCategory({ name: "Other" });

    const creatingNow = engine.handle(createCommand({ name: "Горы зимой" }));
    await until(hold.arrived, "the request to arrive");
    const refused = failed(await engine.handle(command("categories.update", { categoryId: other, name: " горы ЗИМОЙ " })));
    hold.release();
    const created = ok(await creatingNow);

    expect(refused.error).toMatchObject({ code: "VALIDATION", categoryReason: "name-taken" });
    expect(refused.error.spentMicros).toBeUndefined();
    if (created.type !== "categories.create") throw new Error("wrong type");
    expect(created.result.category.name).toBe("Горы зимой");
    expect((await listOf(engine)).categories.map((c) => c.name)).toEqual(["Other", "Горы зимой"]);
  });

  test("a rename to any other name, and a removal, are not held up by a running create", async () => {
    const hold = held(poolReply());
    const net = network({ descriptors: [hold.step] });
    const { engine } = await startEngine(dir(), { net });
    const other = await seedCategory({ name: "Other" });

    const creatingNow = engine.handle(createCommand({ name: "Горы зимой" }));
    await until(hold.arrived, "the request to arrive");
    expect(ok(await engine.handle(command("categories.update", { categoryId: other, name: "Другое имя" }))).ok).toBe(true);
    hold.release();
    ok(await creatingNow);
  });
});

// ---------- categories.regenerate ----------

describe("categories.regenerate", () => {
  function regenerate(categoryId: string, over: Json = {}): unknown {
    return command("categories.regenerate", { categoryId, description: "кофейни и булочные у Сены", acceptedWorstMicros: ESTIMATE.worstMicros, ...over });
  }

  const NEW_ANSWER = answer({ label: "Seine bakeries", outfits: ["a red coat", "a blue scarf", "a green dress"], shotDeck: ["photographer", "photographer", "photographer", "candid", "candid"], locations: ["a quay", "a bridge", "a bakery", "a market", "a bookstall"].map((n) => place(n)) });

  test("a new pool for the same id and name: the spend adds to the total, the old pool is replaced, and the change is announced", async () => {
    const id = await seedCategory({ name: "Кофейни", spentMicros: 5_000 });
    const net = network({ descriptors: [poolReply(NEW_ANSWER, 0.006)] });
    const { engine, events } = await startEngine(dir(), { net });

    const response = ok(await engine.handle(regenerate(id)));
    if (response.type !== "categories.regenerate") throw new Error("wrong type");

    expect(response.result.spentMicros).toBe(6_000);
    expect(response.result.category).toMatchObject({ categoryId: id, name: "Кофейни", description: "кофейни и булочные у Сены", label: "Seine bakeries", style: "editorial", spentMicros: 11_000 });
    expect(response.result.category.pool.outfits).toEqual(["a red coat", "a blue scarf", "a green dress"]);
    expect(events().filter((e) => e.type === "category.changed")).toHaveLength(1);
    expect(await folder()).toEqual([`${id}.json`]);
  });

  test("a failed regeneration keeps the old pool, tells what it cost and adds that to the category's total", async () => {
    const id = await seedCategory({ name: "Кофейни", spentMicros: 5_000 });
    const net = network({ descriptors: [poolReply({ pool: "cafes" }, 0.0051), poolReply(answer({ label: "" }), 0.0062)] });
    const { engine, events } = await startEngine(dir(), { net });

    const refused = failed(await engine.handle(regenerate(id)));

    expect(refused.error).toMatchObject({ code: "POOL_REJECTED", spentMicros: 11_300 });
    const kept = (await listOf(engine)).categories[0];
    expect(kept?.pool).toEqual(POOL);
    expect(kept?.label).toBe("Paris cafes");
    expect(kept?.spentMicros).toBe(5_000 + 11_300);
    expect(events().filter((e) => e.type === "category.changed")).toHaveLength(1);
  });

  test("a refusal that cost nothing leaves the category untouched, with no event", async () => {
    const id = await seedCategory({ spentMicros: 5_000 });
    const net = network({ descriptors: [MODERATION_STEP] });
    const { engine, events } = await startEngine(dir(), { net });

    expect(failed(await engine.handle(regenerate(id))).error).toMatchObject({ code: "MODERATION_REFUSED", spentMicros: 0 });

    expect((await listOf(engine)).categories[0]?.spentMicros).toBe(5_000);
    expect(events().filter((e) => e.type === "category.changed")).toEqual([]);
  });

  test("an unknown category is NOT_FOUND before any price, reserve or record", async () => {
    const net = network({ descriptors: [poolReply()] });
    const { engine } = await startEngine(dir(), { net });

    expect(failed(await engine.handle(regenerate("cat-nobody-here"))).error.code).toBe("NOT_FOUND");
    expect(net.calls).toHaveLength(0);
    expect(ledgerLines(dir())).toEqual([]);
  });

  test("PRICE_CHANGED sends nothing and leaves the category as it was", async () => {
    const id = await seedCategory();
    const net = network({ descriptors: [poolReply()] });
    const { engine } = await startEngine(dir(), { net });

    expect(failed(await engine.handle(regenerate(id, { acceptedWorstMicros: ESTIMATE.worstMicros - 1 }))).error.code).toBe("PRICE_CHANGED");
    expect(chatCalls(net)).toHaveLength(0);
    expect((await listOf(engine)).categories[0]?.pool).toEqual(POOL);
  });

  test("the request carries the new description, never the category's name", async () => {
    const id = await seedCategory({ name: "ZEBRA-NAME-MARKER" });
    const net = network({ descriptors: [poolReply(NEW_ANSWER)] });
    const { engine } = await startEngine(dir(), { net });

    ok(await engine.handle(regenerate(id)));

    const [call] = chatCalls(net);
    expect(call?.body).toContain("кофейни и булочные у Сены");
    expect(call?.body?.toLowerCase()).not.toContain("zebra-name-marker");
  });

  test("the busy call names its category from the moment the command is issued, before the engine has read the category itself", async () => {
    const id = await seedCategory({ name: "Кофейни" });
    const hold = held(poolReply(NEW_ANSWER));
    const net = network({ descriptors: [hold.step] });
    const { engine } = await startEngine(dir(), { net });

    const running = engine.handle(regenerate(id));
    // No await between the command and the list: the regenerate has claimed its call and read nothing yet.
    const listed = await listOf(engine);

    expect(listed.busy).toEqual({ kind: "regenerate", name: "Кофейни", categoryId: id });
    await until(hold.arrived, "the request to arrive");
    hold.release();
    ok(await running);
  });

  test("while it runs a rename or a delete of that category is IN_FLIGHT, another category's is not, and the busy call names its category", async () => {
    const id = await seedCategory({ name: "Кофейни" });
    const other = await seedCategory({ name: "Other" });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrived = false;
    const net = network({
      descriptors: [
        async () => {
          arrived = true;
          await gate;
          return poolReply(NEW_ANSWER) as Reply;
        },
      ],
    });
    const { engine } = await startEngine(dir(), { net });

    const running = engine.handle(regenerate(id));
    await until(() => arrived, "the request to arrive");

    expect(failed(await engine.handle(command("categories.update", { categoryId: id, name: "Renamed" }))).error.code).toBe("IN_FLIGHT");
    expect(failed(await engine.handle(command("categories.delete", { categoryId: id }))).error.code).toBe("IN_FLIGHT");
    expect(ok(await engine.handle(command("categories.update", { categoryId: other, name: "Other renamed" }))).ok).toBe(true);
    expect((await listOf(engine)).busy).toEqual({ kind: "regenerate", name: "Кофейни", categoryId: id });
    expect(failed(await engine.handle(regenerate(other))).error.code).toBe("IN_FLIGHT");

    release();
    ok(await running);
  });
});

// ---------- categories.update / categories.delete ----------

describe("categories.update", () => {
  test("a rename is free, stored trimmed and announced", async () => {
    const id = await seedCategory({ name: "Old" });
    const { engine, events, net } = await startEngine(dir());

    const response = ok(await engine.handle(command("categories.update", { categoryId: id, name: " New name " })));
    if (response.type !== "categories.update") throw new Error("wrong type");

    expect(response.result.category.name).toBe("New name");
    expect((await listOf(engine)).categories[0]?.name).toBe("New name");
    expect(events().filter((e) => e.type === "category.changed")).toHaveLength(1);
    expect(net.calls).toHaveLength(0);
    expect(ledgerLines(dir())).toEqual([]);
  });

  test("a name another category holds is VALIDATION and changes nothing", async () => {
    await seedCategory({ name: "Alpha" });
    const beta = await seedCategory({ name: "Beta" });
    const { engine } = await startEngine(dir());

    const refused = failed(await engine.handle(command("categories.update", { categoryId: beta, name: "ALPHA" })));
    expect(refused.error.code).toBe("VALIDATION");
    expect(refused.error.categoryReason).toBe("name-taken");
    expect((await listOf(engine)).categories.map((c) => c.name)).toEqual(["Alpha", "Beta"]);
  });

  test("removes a place or an outfit by its text", async () => {
    const id = await seedCategory();
    const { engine } = await startEngine(dir());

    const response = ok(await engine.handle(command("categories.update", { categoryId: id, removeOutfits: ["a red scarf and a coat"] })));
    if (response.type !== "categories.update") throw new Error("wrong type");

    expect(response.result.category.pool.outfits).toEqual(["a beige trench coat and jeans", "a striped tee and a beret", "a black midi dress"]);
  });

  test("a pool at its minimum refuses the removal with VALIDATION and stays as it was", async () => {
    const id = await seedCategory();
    const { engine } = await startEngine(dir());

    const refused = failed(await engine.handle(command("categories.update", { categoryId: id, removeLocations: ["a flower stall"] })));
    expect(refused.error.code).toBe("VALIDATION");
    expect(refused.error.categoryReason).toBe("below-minimum");
    expect((await listOf(engine)).categories[0]?.pool).toEqual(POOL);
  });

  test("removing the last place with a mirror from a deck that draws one is VALIDATION with the reason mirror-needed", async () => {
    const id = await seedCategory();
    // The seeded pool holds the minimum of 5 places: a 6th, without a mirror, makes room for the removal.
    const file = join(categoriesDir(), `${id}.json`);
    const stored = JSON.parse(await readFile(file, "utf8"));
    stored.pool.locations.push({ name: "a quiet lane", times: ["morning"], activities: [{ text: "walking", twoHanded: false }, { text: "carrying bags", twoHanded: true }], mirror: false });
    await writeFile(file, JSON.stringify(stored));
    const { engine } = await startEngine(dir());

    const refused = failed(await engine.handle(command("categories.update", { categoryId: id, removeLocations: ["a bookshop"] })));

    expect(refused.error.code).toBe("VALIDATION");
    expect(refused.error.categoryReason).toBe("mirror-needed");
  });

  test("a text that names no item is VALIDATION, an unknown category NOT_FOUND", async () => {
    const id = await seedCategory();
    const { engine } = await startEngine(dir());

    const unknownItem = failed(await engine.handle(command("categories.update", { categoryId: id, removeOutfits: ["a hat nobody has"] })));
    expect(unknownItem.error.code).toBe("VALIDATION");
    expect(unknownItem.error.categoryReason).toBe("item-not-found");
    const unknownCategory = failed(await engine.handle(command("categories.update", { categoryId: "cat-nobody-here", name: "x" })));
    expect(unknownCategory.error.code).toBe("NOT_FOUND");
    expect(unknownCategory.error.categoryReason).toBeUndefined();
  });

  test("without a library: LIBRARY_UNAVAILABLE", async () => {
    const { engine } = await startEngine(dir(), { init: { settings: engineSettings(dir(), { libraryPath: join(dir(), "missing") }) } });
    expect(failed(await engine.handle(command("categories.update", { categoryId: "cat-nobody-here", name: "x" }))).error.code).toBe("LIBRARY_UNAVAILABLE");
  });
});

describe("categories.delete", () => {
  test("removes the category, announces it, and a name it held can be used again", async () => {
    const id = await seedCategory({ name: "Gone" });
    const { engine, events } = await startEngine(dir());

    expect(ok(await engine.handle(command("categories.delete", { categoryId: id }))).result).toEqual({ categoryId: id });

    expect((await listOf(engine)).categories).toEqual([]);
    expect(events().filter((e) => e.type === "category.changed").map((e) => e.payload)).toEqual([{ change: "removed", categoryId: id }]);
    await seedCategory({ name: "Gone" });
  });

  test("a regenerate issued while the delete of its category is queued behind another write is refused, with nothing sent or reserved: the paid pool would have nowhere to go", async () => {
    const id = await seedCategory({ name: "Gone" });
    const busy = await seedCategory({ name: "Busy" });
    // A write of another category holds the folder's lock, so the delete has passed its checks and waits for the record to be removed.
    let letGo: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    let holding = false;
    const net = network({ descriptors: [poolReply()] });
    const { engine } = await startEngine(dir(), {
      net,
      deps: {
        library: {
          testHooks: {
            beforeRename: async (path) => {
              if (!path.includes(busy)) return;
              holding = true;
              await gate;
            },
          },
        },
      },
    });

    const renaming = engine.handle(command("categories.update", { categoryId: busy, name: "Busy renamed" }));
    await until(() => holding, "the rename to hold the folder's lock");
    const removing = engine.handle(command("categories.delete", { categoryId: id }));
    // The delete command is past its first await only once the library is live: give it that, then ask for the regenerate.
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Not awaited before the lock is let go: a regenerate that is not refused waits on the same lock before it can record its call.
    const regenerating = engine.handle(command("categories.regenerate", { categoryId: id, description: "кофейни у Сены", acceptedWorstMicros: ESTIMATE.worstMicros }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    letGo();
    const [renamed, removed, regenerated] = await Promise.all([renaming, removing, regenerating]);

    expect(failed(regenerated).error.code).toBe("IN_FLIGHT");
    expect(ok(renamed).ok).toBe(true);
    expect(ok(removed).result).toEqual({ categoryId: id });
    expect(chatCalls(net)).toHaveLength(0);
    expect(ledgerLines(dir())).toEqual([]);
  });

  test("a rename issued while the delete of its category is under way is refused too", async () => {
    const id = await seedCategory({ name: "Gone" });
    const { engine } = await startEngine(dir());

    const deleting = engine.handle(command("categories.delete", { categoryId: id }));
    const renaming = engine.handle(command("categories.update", { categoryId: id, name: "Renamed" }));
    const [deleted, renamed] = await Promise.all([deleting, renaming]);

    expect(ok(deleted).ok).toBe(true);
    expect(failed(renamed).error.code).toBe("IN_FLIGHT");
  });

  test("once the delete has ended the category is simply not there: a regenerate is NOT_FOUND, not IN_FLIGHT", async () => {
    const id = await seedCategory({ name: "Gone" });
    const { engine } = await startEngine(dir(), { net: network({ descriptors: [poolReply()] }) });
    ok(await engine.handle(command("categories.delete", { categoryId: id })));

    const refused = failed(await engine.handle(command("categories.regenerate", { categoryId: id, description: "кофейни у Сены", acceptedWorstMicros: ESTIMATE.worstMicros })));

    expect(refused.error.code).toBe("NOT_FOUND");
  });

  test("an unknown category is NOT_FOUND", async () => {
    const { engine } = await startEngine(dir());
    expect(failed(await engine.handle(command("categories.delete", { categoryId: "cat-nobody-here" }))).error.code).toBe("NOT_FOUND");
  });
});

// ---------- the key is not needed for free commands ----------

test("the free commands need no key", async () => {
  const id = await seedCategory({ name: "Old" });
  const { engine } = await startEngine(dir(), { key: null });

  expect(ok(await engine.handle(command("categories.update", { categoryId: id, name: "New" }))).ok).toBe(true);
  expect(ok(await engine.handle(command("categories.delete", { categoryId: id }))).ok).toBe(true);
});
