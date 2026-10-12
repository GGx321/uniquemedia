import { describe, expect, test } from "bun:test";
import { ERROR_MESSAGES_RU, LAUNCH_REASONS_RU, SCENE_REASONS_RU } from "./errorMessagesRu";
import { EngineError, LAUNCH_REASONS, SCENE_REASONS } from "./errors";
import { PROTOCOL_VERSION } from "./envelope";
import { SceneSetView, SceneView } from "./scenes";
import { Estimate, JobResult, PhotoSummary } from "./state";

// Stage 5, 5a.3, S5.9a (plan s5a3 §11): «Смелая» joins the contract ADDITIVELY and without ids. Every new field is optional, so each shape is tried in its old form
// (it parses and gains no key), then with the new field, then with it broken. The engine draws nothing «Смелая» here: the two bold categories arrive with S5.9b2.

const scene = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  sceneId: 1,
  origin: "planned",
  category: "home",
  categoryName: null,
  shot: "friend",
  pose: "front",
  place: { location: "a kitchen", timeOfDay: "morning", activity: "pouring coffee", outfit: "a linen shirt" },
  idea: null,
  text: "A friend catches her laughing at the counter.",
  edited: false,
  removed: false,
  unwritten: null,
  gaveUpBy: null,
  chunk: 1,
  ...over,
});

const setView = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  sceneSetId: "set-aaaa-0001",
  avatarId: "avatar-aaaa-0001",
  createdAt: "2026-10-07T10:00:00.000Z",
  revision: 1,
  status: "ready",
  stoppedBy: null,
  stoppedError: null,
  runId: null,
  categories: [{ ref: "home", name: null }],
  textModel: "x-ai/grok-4.3",
  spentMicros: 11_000,
  openReserveMicros: 0,
  write: null,
  lastCompose: { total: 1, written: 1, gaveUp: 0 },
  chunks: [{ chunk: 1, sceneIds: [1], attemptsLeft: 1, gaveUpBy: null }],
  scenes: [scene()],
  ...over,
});

const estimate = { expectedMicros: 200_000, worstMicros: 230_000, prices: "live", pricesAsOf: "2026-09-24" };
const photo = {
  photoId: "photo-0002",
  avatarId: "avatar-0001",
  runId: "run-00000001",
  category: "home",
  createdAt: "2026-09-24T11:00:00Z",
  used: false,
  usedIn: [] as string[],
  rejected: false,
  reserved: false,
  eligible: true,
};

describe("the protocol", () => {
  test("stays at version 5: «Смелая» is additive", () => {
    expect(PROTOCOL_VERSION).toBe(5);
  });
});

describe("SceneView and SceneSetView in 5a.3", () => {
  test("a bold scene and a bold set echo their level", () => {
    expect(SceneView.parse(scene({ level: "bold" })).level).toBe("bold");
    expect(SceneSetView.parse(setView({ level: "bold" })).level).toBe("bold");
  });

  test("ordinary is still the absence of a level on a scene and on a set", () => {
    expect(SceneView.safeParse(scene({ level: "ordinary" })).success).toBe(false);
    expect(SceneSetView.safeParse(setView({ level: "ordinary" })).success).toBe(false);
  });

  test("a scene before 5a.3 parses and gains no route", () => {
    expect("route" in SceneView.parse(scene())).toBe(false);
  });

  test("a scene on Seedream keeps its route", () => {
    expect(SceneView.parse(scene({ level: "bold", route: "seedream" })).route).toBe("seedream");
  });

  test("a route other than seedream is refused", () => {
    expect(SceneView.safeParse(scene({ route: "grok" })).success).toBe(false);
    expect(SceneView.safeParse(scene({ route: "" })).success).toBe(false);
  });

  test("a set whose scene carries a route round-trips", () => {
    const view = setView({ level: "bold", scenes: [scene({ level: "bold", route: "seedream" })] });
    expect<unknown>(SceneSetView.parse(view)).toEqual(view);
  });
});

describe("Estimate.boldAttemptMicros", () => {
  test("an estimate before 5a.3 parses to the very same document", () => {
    expect<unknown>(Estimate.parse(estimate)).toEqual(estimate);
  });

  test("an estimate that names the price of a Seedream attempt round-trips", () => {
    const bold = { ...estimate, boldAttemptMicros: 93_000 };
    expect<unknown>(Estimate.parse(bold)).toEqual(bold);
  });

  test("the attempt price is a whole number of micro-dollars, never negative", () => {
    expect(Estimate.safeParse({ ...estimate, boldAttemptMicros: 0 }).success).toBe(true);
    expect(Estimate.safeParse({ ...estimate, boldAttemptMicros: -1 }).success).toBe(false);
    expect(Estimate.safeParse({ ...estimate, boldAttemptMicros: 93_000.5 }).success).toBe(false);
  });
});

describe("EngineError.priceScope", () => {
  test("a PRICE_UNAVAILABLE for the 2K tier says so", () => {
    expect(EngineError.parse({ code: "PRICE_UNAVAILABLE", priceScope: "bold" }).priceScope).toBe("bold");
  });

  test("a PRICE_UNAVAILABLE without a scope is still valid and gains none", () => {
    expect("priceScope" in EngineError.parse({ code: "PRICE_UNAVAILABLE" })).toBe(false);
  });

  test("a scope other than bold is refused", () => {
    expect(EngineError.safeParse({ code: "PRICE_UNAVAILABLE", priceScope: "text" }).success).toBe(false);
  });

  test("a scope on any other code is refused", () => {
    expect(EngineError.safeParse({ code: "PRICE_CHANGED", priceScope: "bold" }).success).toBe(false);
    expect(EngineError.safeParse({ code: "VALIDATION", priceScope: "bold" }).success).toBe(false);
  });
});

describe("PhotoSummary.route", () => {
  test("a photo before 5a.3 parses to the very same document", () => {
    expect<unknown>(PhotoSummary.parse(photo)).toEqual(photo);
  });

  test("a photo drawn on the Seedream route keeps it", () => {
    expect(PhotoSummary.parse({ ...photo, route: "seedream" }).route).toBe("seedream");
  });

  test("a route other than seedream is refused", () => {
    expect(PhotoSummary.safeParse({ ...photo, route: "fallback" }).success).toBe(false);
  });
});

describe("the new scene reasons", () => {
  test.each(["bold-level-needed", "model-refused", "model-empty"] as const)("%s is a scene reason with a Russian text of its own", (reason) => {
    expect([...SCENE_REASONS]).toContain(reason);
    expect(SCENE_REASONS_RU[reason]).not.toBe(ERROR_MESSAGES_RU.VALIDATION);
    expect(/[а-яё]/i.test(SCENE_REASONS_RU[reason])).toBe(true);
  });

  test("a refusal carries bold-level-needed as a scene reason and as a launch reason", () => {
    expect(EngineError.safeParse({ code: "VALIDATION", sceneReason: "bold-level-needed" }).success).toBe(true);
    expect([...LAUNCH_REASONS]).toContain("bold-level-needed");
    expect(EngineError.safeParse({ code: "VALIDATION", launchReason: "bold-level-needed" }).success).toBe(true);
  });

  test("a run result names a slot that ended on a refusal or an empty answer", () => {
    const result = { kind: "run", runId: "run-00000001", avatarId: "avatar-0001", photoIds: ["photo-0002"], failedSlots: 2, failedReasons: [{ slotIndex: 2, reason: "model-refused" }, { slotIndex: 5, reason: "model-empty" }] };
    expect(JobResult.safeParse(result).success).toBe(true);
  });

  test("the refusal for a missing «Смелая» is free and names both categories", () => {
    expect(SCENE_REASONS_RU["bold-level-needed"]).toBe("«Ночнушки и бельё» и «Пляж и бассейн» рисуются только с подачей «Смелая» — ничего не списано.");
    expect(LAUNCH_REASONS_RU["bold-level-needed"]).toBe(SCENE_REASONS_RU["bold-level-needed"]);
  });

  test("a model refusal says the refusal is free and that the attempts paid before it are in the spend", () => {
    expect(SCENE_REASONS_RU["model-refused"]).toBe("Модель не нарисовала кадр «Смелой»; сам отказ бесплатный, оплаченные до него попытки — в расходах.");
  });

  test("an empty answer is never called free", () => {
    expect(SCENE_REASONS_RU["model-empty"]).toBe("Модель вернула пустой ответ на кадр «Смелой»; попытка учтена в расходах.");
    expect(SCENE_REASONS_RU["model-empty"]).not.toContain("бесплатн");
  });
});
