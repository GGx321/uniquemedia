import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { startMockOpenRouter, type MockOpenRouter } from "./mockOpenRouter";
useNativeGlobals();

// Stage 5, 5b.2, S5.WC4: the chat route of part C in the packaged smoke's mock OpenRouter, unit-tested here with no Electron. The vision writer ("motion_suggestions") and the idea translator ("motion_idea") are
// answered as a model answers them: the strict JSON the engine reads, billed once against /credits. Without the `motions` option both are unexpected requests, like the video routes without `clips`.

const nativeFetch = Bun.fetch;
const happyDomResponse = globalThis.Response;
const sample = await nativeFetch("data:,");
const nativeResponse = sample.constructor;
beforeAll(() => {
  if (typeof nativeResponse === "function") globalThis.Response = nativeResponse as typeof Response;
});
afterAll(() => {
  globalThis.Response = happyDomResponse;
});

let mock: MockOpenRouter | null = null;
afterEach(async () => {
  await mock?.stop();
  mock = null;
});

async function started(motions: Parameters<typeof startMockOpenRouter>[0]["motions"] = true): Promise<MockOpenRouter> {
  mock = await startMockOpenRouter({ descriptorText: "A 25-year-old woman.", motions });
  return mock;
}

const chat = (m: MockOpenRouter, schema: string, user: unknown): Promise<Response> =>
  nativeFetch(`${m.url}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "x-ai/grok-4.3", messages: [{ role: "system", content: "s" }, { role: "user", content: JSON.stringify(user) }], response_format: { type: "json_schema", json_schema: { name: schema, strict: true, schema: {} } } }),
  });

async function contentOf(response: Response): Promise<{ content: unknown; cost: number }> {
  const body = (await response.json()) as { choices: { message: { content: string } }[]; usage: { cost: number } };
  return { content: JSON.parse(body.choices[0]?.message.content ?? "null"), cost: body.usage.cost };
}

describe("the vision writer's route", () => {
  test("answers three small motions with labels and a frame reading, billed once", async () => {
    const m = await started();
    const response = await chat(m, "motion_suggestions", { frame: {} });
    expect(response.status).toBe(200);
    const { content, cost } = await contentOf(response);
    expect(content).toMatchObject({ motions: [{ label_ru: "Движение 1" }, { label_ru: "Движение 2" }, { label_ru: "Движение 3" }], frame: { capture: "unknown", phoneVisible: false, faceVisible: true } });
    expect(cost).toBe(0.0034);
    expect(m.totalUsageUsd()).toBeCloseTo(0.0034, 9);
    expect(m.motionRequests()).toHaveLength(1);
    expect(m.unexpected).toEqual([]);
  });

  test("answers the texts the scenario names", async () => {
    const m = await started({ suggestions: ["she slowly turns her head"] });
    const { content } = await contentOf(await chat(m, "motion_suggestions", {}));
    expect(content).toMatchObject({ motions: [{ text_en: "she slowly turns her head" }] });
  });
});

describe("the idea translator's route", () => {
  test("answers one English motion, billed once", async () => {
    const m = await started();
    const response = await chat(m, "motion_idea", { idea: "медленно поворачивает голову" });
    expect(response.status).toBe(200);
    const { content, cost } = await contentOf(response);
    expect(content).toEqual({ text_en: "she tilts her head a little to one side and smiles" });
    expect(cost).toBe(0.001);
    expect(m.totalUsageUsd()).toBeCloseTo(0.001, 9);
    expect(m.motionRequests()).toHaveLength(1);
  });

  test("answers the translation the scenario names", async () => {
    const m = await started({ translation: "she slowly looks down and smiles to herself" });
    const { content } = await contentOf(await chat(m, "motion_idea", {}));
    expect(content).toEqual({ text_en: "she slowly looks down and smiles to herself" });
  });
});

describe("without the option", () => {
  test("both are unexpected requests, answered 404 and kept", async () => {
    const m = await started(false);
    expect((await chat(m, "motion_suggestions", {})).status).toBe(404);
    expect((await chat(m, "motion_idea", {})).status).toBe(404);
    expect(m.unexpected).toHaveLength(2);
    expect(m.totalUsageUsd()).toBe(0);
  });
});
