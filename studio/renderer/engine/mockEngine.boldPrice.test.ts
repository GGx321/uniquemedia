import { describe, expect, test } from "bun:test";
import type { RunRequest } from "../../shared/engine";
import { MOCK_AGE_CHECK_PER_SLOT, MOCK_BOLD_IMAGE } from "./mockEngine";
import { IMAGE, draftOf, errorOf, runUntil, runWorld, startRun, toDone } from "./mockLaunchRun.testkit";
import { MIA, makeMock, mixedSetSeed, unwrap } from "./mockEngine.testkit";

// 5a.3 (S5.9f, plan s5a3 §10, §12): the mock prices the «Смелая» route like the engine's price book: one 2K attempt is 93 000 µ$ (the engine's `high_resolution` 90 000 + the reference 3 000),
// a photo of a «Смелая» category is priced on it (never below the settings' model), `Estimate.boldAttemptMicros` is present only when a photo is on that route, a missing 2K tier is a
// PRICE_UNAVAILABLE with `priceScope: "bold"` and nothing else, and a «Смелая» launch prices every photo at the bold unit (option B). Every figure below is the engine's own formula over the
// mock's flat 50 000 µ$ image; the worked examples of §10.3 are the same formula over the engine's dated table.

const ATTEMPTS = 3;
const NO_POSES = { profile: false, back: false };
const request = (count: number, categories: RunRequest["categories"], level?: "bold"): RunRequest => ({ avatarId: MIA.avatarId, count, categories, poses: NO_POSES, ...(level === undefined ? {} : { level }) });
const estimateOf = async (mock: ReturnType<typeof makeMock>, req: RunRequest) => (await unwrap(mock.client.request("runs.estimate", req))).estimate;

describe("the bold attempt's price", () => {
  test("is the engine's 2K attempt: 90 000 µ$ for the tier and 3 000 µ$ for the reference", () => {
    expect(MOCK_BOLD_IMAGE).toBe(93_000);
  });
});

describe("a run of a «Смелая» category is priced on the 2K route", () => {
  test("«Ночнушки и бельё» 10 at «Смелая»: worst is 10 photos × 3 attempts × 93 000 µ$, expected is 10 × 93 000 µ$", async () => {
    const estimate = await estimateOf(makeMock(), request(10, ["nightwear"], "bold"));
    expect(estimate).toMatchObject({ worstMicros: 10 * ATTEMPTS * MOCK_BOLD_IMAGE, expectedMicros: 10 * MOCK_BOLD_IMAGE });
  });

  test("names its 2K attempt in the estimate, for the card's price line", async () => {
    expect((await estimateOf(makeMock(), request(10, ["nightwear"], "bold"))).boldAttemptMicros).toBe(MOCK_BOLD_IMAGE);
  });

  test("«Дом» 10 with «Ночнушки и бельё» 10: the ordinary photos stay at the mock's image, the bold ones are on 2K", async () => {
    const estimate = await estimateOf(makeMock(), request(20, ["home", "nightwear"], "bold"));
    expect(estimate.worstMicros).toBe(10 * ATTEMPTS * IMAGE + 10 * ATTEMPTS * MOCK_BOLD_IMAGE);
    expect(estimate.expectedMicros).toBe(10 * IMAGE + 10 * MOCK_BOLD_IMAGE);
  });

  test("a bold photo is never priced below the settings' model: a dearer model keeps its price on the bold slots, the attempt stays the 2K one", async () => {
    const mock = makeMock();
    mock.engine.setRunImagePrice(120_000);
    const estimate = await estimateOf(mock, request(10, ["nightwear"], "bold"));
    expect(estimate.worstMicros).toBe(10 * ATTEMPTS * 120_000);
    // The expected figure never falls below the owner's model either (S5.R4-fix, the engine's `boldExpected`).
    expect(estimate.expectedMicros).toBe(10 * 120_000);
    expect(estimate.boldAttemptMicros).toBe(MOCK_BOLD_IMAGE);
  });

  test("with the age check on, every attempt adds the check's ceiling and every photo its typical share", async () => {
    const mock = makeMock({ imageAgeCheck: "on" });
    const estimate = await estimateOf(mock, request(10, ["nightwear"], "bold"));
    expect(estimate.worstMicros).toBe(10 * ATTEMPTS * (MOCK_BOLD_IMAGE + MOCK_AGE_CHECK_PER_SLOT.worst));
    expect(estimate.expectedMicros).toBe(10 * (MOCK_BOLD_IMAGE + MOCK_AGE_CHECK_PER_SLOT.expected));
  });

  test("the start's cap is the estimate's worst case: a lower accepted sum is PRICE_CHANGED, the estimate's own sum starts the run", async () => {
    const mock = makeMock();
    const req = request(10, ["nightwear"], "bold");
    const worst = (await estimateOf(mock, req)).worstMicros;
    expect(await errorOf(mock.client.request("runs.start", { ...req, acceptedWorstMicros: worst - 1 }))).toMatchObject({ code: "PRICE_CHANGED" });
    expect((await unwrap(mock.client.request("runs.start", { ...req, acceptedWorstMicros: worst }))).runId).toBeString();
  });
});

describe("a run with no photo on the 2K route", () => {
  test("«Смелая» over the five ordinary categories is priced as it always was and names no 2K attempt", async () => {
    const estimate = await estimateOf(makeMock(), request(10, ["home", "travel"], "bold"));
    expect(estimate.worstMicros).toBe(10 * ATTEMPTS * IMAGE);
    expect("boldAttemptMicros" in estimate).toBe(false);
  });

  test("an ordinary run names no 2K attempt", async () => {
    expect("boldAttemptMicros" in (await estimateOf(makeMock(), request(10, ["home"])))).toBe(false);
  });
});

describe("a run made from a set is priced by the scenes that are on the 2K route", () => {
  async function setEstimate(categories: RunRequest["categories"], level?: "flirty" | "bold") {
    const mock = makeMock();
    await unwrap(mock.client.request("scenes.compose", { avatarId: MIA.avatarId, count: 10, categories, ...(level === undefined ? {} : { level }), acceptedWorstMicros: 10_000_000 }));
    mock.scheduler.runAll();
    const set = (await unwrap(mock.client.request("scenes.get", { avatarId: MIA.avatarId }))).sceneSet;
    if (set === null) throw new Error("no set after compose");
    const routed = set.scenes.filter((s) => s.route === "seedream").length;
    const { estimate } = await unwrap(mock.client.request("runs.estimateFromScenes", { sceneSetId: set.sceneSetId, revision: set.revision }));
    return { estimate, routed, total: set.scenes.length };
  }

  // 5a.4 (S5.BA2, 2026-10-26, Q-A2): every nightwear scene is on the route now, so a set with scenes off it was «Дом» and nightwear at «Смелая» (the «Дом» scenes drawn as «Кокетливая», no route).
  // 5a.4 (S5.BA3, 2026-10-26, plan s5a4 §7.4, QB-5, BA2 part 2 review L1): «Смелая» plans «Дом» on the route once the mock mirrors the engine, and the mix is the point here, so the set is one stored
  // before 5a.4 (an old set keeps no route): seeded, not composed.
  test("a set stored before 5a.4, «Дом» and «Ночнушки и бельё»: exactly the scenes with a route are 2K, the rest stay at the mock's image", async () => {
    const mock = makeMock({ sceneSets: [mixedSetSeed(MIA.avatarId, "set-old-0001")] });
    const set = (await unwrap(mock.client.request("scenes.get", { avatarId: MIA.avatarId }))).sceneSet;
    if (set === null) throw new Error("no seeded set");
    const routed = set.scenes.filter((s) => s.route === "seedream").length;
    const total = set.scenes.length;
    const { estimate } = await unwrap(mock.client.request("runs.estimateFromScenes", { sceneSetId: set.sceneSetId, revision: set.revision }));
    expect(routed).toBeGreaterThan(0);
    expect(routed).toBeLessThan(total);
    expect(estimate.worstMicros).toBe((total - routed) * ATTEMPTS * IMAGE + routed * ATTEMPTS * MOCK_BOLD_IMAGE);
    expect(estimate.expectedMicros).toBe((total - routed) * IMAGE + routed * MOCK_BOLD_IMAGE);
    expect(estimate.boldAttemptMicros).toBe(MOCK_BOLD_IMAGE);
  });

  test("«Ночнушки и бельё» at «Смелая»: every scene is on 2K (Q-A2)", async () => {
    const { estimate, routed, total } = await setEstimate(["nightwear"], "bold");
    expect(routed).toBe(total);
    expect(estimate.worstMicros).toBe(total * ATTEMPTS * MOCK_BOLD_IMAGE);
  });

  test("«Пляж и бассейн» at «Смелая»: every scene is on 2K", async () => {
    const { estimate, total } = await setEstimate(["beach"], "bold");
    expect(estimate.worstMicros).toBe(total * ATTEMPTS * MOCK_BOLD_IMAGE);
  });

  test("a set with no scene on the route names no 2K attempt", async () => {
    const { estimate } = await setEstimate(["home"], "flirty");
    expect("boldAttemptMicros" in estimate).toBe(false);
  });
});

describe("a price list with no 2K tier", () => {
  test("refuses an estimate that needs the tier as PRICE_UNAVAILABLE with the bold scope", async () => {
    const mock = makeMock();
    mock.engine.lackBoldPrice();
    expect(await errorOf(mock.client.request("runs.estimate", request(10, ["nightwear"], "bold")))).toMatchObject({ code: "PRICE_UNAVAILABLE", priceScope: "bold" });
  });

  test("refuses a start that needs the tier the same way, before a run exists", async () => {
    const mock = makeMock();
    mock.engine.lackBoldPrice();
    const error = await errorOf(mock.client.request("runs.start", { ...request(10, ["nightwear"], "bold"), acceptedWorstMicros: 100_000_000 }));
    expect(error).toMatchObject({ code: "PRICE_UNAVAILABLE", priceScope: "bold" });
    expect((await unwrap(mock.client.request("runs.list", {}))).runs).toHaveLength(0);
  });

  test("still estimates a run with no «Смелая» category, at any level", async () => {
    const mock = makeMock();
    mock.engine.lackBoldPrice();
    expect((await estimateOf(mock, request(10, ["home"]))).worstMicros).toBe(10 * ATTEMPTS * IMAGE);
    expect((await estimateOf(mock, request(10, ["home"], "bold"))).worstMicros).toBe(10 * ATTEMPTS * IMAGE);
  });

  test("a set whose scenes are on the route cannot be estimated", async () => {
    const mock = makeMock();
    await unwrap(mock.client.request("scenes.compose", { avatarId: MIA.avatarId, count: 10, categories: ["beach"], level: "bold", acceptedWorstMicros: 10_000_000 }));
    mock.scheduler.runAll();
    const set = (await unwrap(mock.client.request("scenes.get", { avatarId: MIA.avatarId }))).sceneSet;
    if (set === null) throw new Error("no set");
    mock.engine.lackBoldPrice();
    expect(await errorOf(mock.client.request("runs.estimateFromScenes", { sceneSetId: set.sceneSetId, revision: set.revision }))).toMatchObject({ code: "PRICE_UNAVAILABLE", priceScope: "bold" });
  });

  test("a launch of the route is refused its estimate the same way, a launch of the five is not", async () => {
    const mock = runWorld();
    mock.engine.lackBoldPrice();
    expect(await errorOf(mock.client.request("autopilot.estimate", { draft: draftOf({ categories: ["nightwear"], level: "bold" }) }))).toMatchObject({ code: "PRICE_UNAVAILABLE", priceScope: "bold" });
    const plain = await unwrap(mock.client.request("autopilot.estimate", { draft: draftOf({ categories: ["home"], level: "bold" }) }));
    expect(plain.preview.estimate.worstMicros).toBeGreaterThan(0);
  });

  test("restoring the tier prices the run again", async () => {
    const mock = makeMock();
    mock.engine.lackBoldPrice();
    mock.engine.lackBoldPrice(false);
    expect((await estimateOf(mock, request(10, ["nightwear"], "bold"))).boldAttemptMicros).toBe(MOCK_BOLD_IMAGE);
  });
});

describe("a «Смелая» launch prices every photo at the bold unit (option B)", () => {
  const plan = async (mock: ReturnType<typeof runWorld>, over: Parameters<typeof draftOf>[0]) => (await unwrap(mock.client.request("autopilot.estimate", { draft: draftOf(over) }))).preview;

  test("a launch of «Ночнушки и бельё» at «Смелая»: worst is the photos × 3 × 93 000 µ$, expected the photos × 93 000 µ$", async () => {
    const preview = await plan(runWorld(), { categories: ["nightwear"], level: "bold" });
    const photos = preview.totals.toGenerate;
    expect(photos).toBeGreaterThan(0);
    expect(preview.estimate.worstMicros).toBe(photos * ATTEMPTS * MOCK_BOLD_IMAGE);
    expect(preview.estimate.expectedMicros).toBe(photos * MOCK_BOLD_IMAGE);
  });

  test("a mixed launch prices its ordinary photos at the bold unit too: the cost of over-reserving, not of drawing", async () => {
    const preview = await plan(runWorld(), { categories: ["home", "nightwear"], level: "bold" });
    expect(preview.estimate.worstMicros).toBe(preview.totals.toGenerate * ATTEMPTS * MOCK_BOLD_IMAGE);
  });

  test("a «Смелая» launch of the five ordinary categories keeps the mock's image price", async () => {
    const preview = await plan(runWorld(), { categories: ["home"], level: "bold" });
    expect(preview.estimate.worstMicros).toBe(preview.totals.toGenerate * ATTEMPTS * IMAGE);
  });

  test("an ordinary launch keeps the mock's image price", async () => {
    const preview = await plan(runWorld(), { categories: ["home"] });
    expect(preview.estimate.worstMicros).toBe(preview.totals.toGenerate * ATTEMPTS * IMAGE);
  });

  test("the price of the launch's photos still to draw is the bold unit, with the 2K attempt named", async () => {
    const mock = runWorld();
    const started = await startRun(mock, { categories: ["nightwear"], level: "bold" });
    const drawing = await runUntil(mock, started.launchId, "the draw", (v) => v.avatars.some((a) => a.phase === "drawing"));
    const row = drawing.avatars[0];
    if (row === undefined) throw new Error("no row");
    const { estimate, photos } = await unwrap(mock.client.request("runs.estimateImages", { launchId: started.launchId, avatarId: row.avatarId }));
    expect(photos).toBeGreaterThan(0);
    expect(estimate.worstMicros).toBe(photos * ATTEMPTS * MOCK_BOLD_IMAGE);
    expect(estimate.boldAttemptMicros).toBe(MOCK_BOLD_IMAGE);
  });

  test("the launch's photos settle at the bold unit, so its spend stays within the worst case it was accepted at", async () => {
    const mock = runWorld();
    const started = await startRun(mock, { categories: ["nightwear"], level: "bold" });
    const done = await toDone(mock, started.launchId);
    expect(done.spentMicros).toBeGreaterThan(0);
    expect(done.spentMicros).toBeLessThanOrEqual(started.acceptedMicros);
    expect(done.spentMicros % MOCK_BOLD_IMAGE).toBe(0);
  });
});
