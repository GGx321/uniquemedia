import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BoldImageParams } from "../engine/openrouter/types";
import { asLibraryReference, fakeFetch, imageBody, imageParams, JPEG, makeClient, PNG, setupMoney, type Money } from "../engine/openrouter/testing/fakes";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { BOLD_MODEL, boldRequestProblems, expectedBilledMicros, failedReasonsOf, ownerRequestProblems, type SentImageRequest } from "./boldSmoke";
useNativeGlobals();

// 5a.3 (S5.9f, plan s5a3 §12): what the packaged smoke asserts of the image requests a «Смелая» run sends, as pure functions the Electron smoke calls. They are held here against the bodies the
// ENGINE's own client builds (not hand-written ones), so a smoke that would pass in CI is one the engine's real requests pass, and against bodies that break one rule at a time.

const GROK = "x-ai/grok-imagine-image-2.0";
let money: Money;
beforeEach(async () => {
  money = await setupMoney();
});
afterEach(async () => {
  await money.cleanup();
});

/** The request the engine's client sends for these params, as the mock OpenRouter would record it. */
async function sentBy(params: BoldImageParams | ReturnType<typeof imageParams>): Promise<SentImageRequest> {
  const { fetch, calls } = fakeFetch([{ status: 200, body: imageBody(PNG, { cost: 0.045 }) }]);
  await makeClient(fetch).client.generateImage(params);
  const body = calls[0]?.json();
  if (body === undefined) throw new Error("the client sent nothing");
  return { model: String(body.model), resolution: typeof body.resolution === "string" ? body.resolution : null, body };
}

const boldParams = (): BoldImageParams => ({ ...imageParams(money, { model: BOLD_MODEL, aspectRatio: "9:16" }), quality: null, resolution: "2K", references: [asLibraryReference(JPEG)] });
const ownerParams = () => imageParams(money, { model: GROK, aspectRatio: "9:16" });
const withBody = (request: SentImageRequest, edit: (body: Record<string, unknown>) => Record<string, unknown>): SentImageRequest => {
  const body = edit({ ...request.body });
  return { model: typeof body.model === "string" ? body.model : null, resolution: typeof body.resolution === "string" ? body.resolution : null, body };
};

describe("boldRequestProblems", () => {
  test("finds none in the request the engine sends for a Seedream slot", async () => {
    expect(boldRequestProblems(await sentBy(boldParams()))).toEqual([]);
  });

  test("names the model when the request is not for Seedream", async () => {
    const request = withBody(await sentBy(boldParams()), (b) => ({ ...b, model: GROK }));
    expect(boldRequestProblems(request).join("\n")).toContain("model");
  });

  test("names the resolution when it is not 2K", async () => {
    const request = withBody(await sentBy(boldParams()), (b) => ({ ...b, resolution: "1K" }));
    expect(boldRequestProblems(request).join("\n")).toContain("resolution");
  });

  test("names the aspect ratio when it is not 9:16", async () => {
    const request = withBody(await sentBy(boldParams()), (b) => ({ ...b, aspect_ratio: "3:4" }));
    expect(boldRequestProblems(request).join("\n")).toContain("aspect_ratio");
  });

  test("names the references when there are two", async () => {
    const request = withBody(await sentBy(boldParams()), (b) => ({ ...b, input_references: [...(b.input_references as unknown[]), ...(b.input_references as unknown[])] }));
    expect(boldRequestProblems(request).join("\n")).toContain("input_references");
  });

  test("names the references when there are none", async () => {
    const request = withBody(await sentBy(boldParams()), ({ input_references: _dropped, ...rest }) => rest);
    expect(boldRequestProblems(request).join("\n")).toContain("input_references");
  });

  test("names the quality knob when the request carries one", async () => {
    const request = withBody(await sentBy(boldParams()), (b) => ({ ...b, quality: "low" }));
    expect(boldRequestProblems(request).join("\n")).toContain("quality");
  });
});

describe("ownerRequestProblems", () => {
  test("finds none in the request the engine sends for a slot on the owner's model", async () => {
    expect(ownerRequestProblems(await sentBy(ownerParams()))).toEqual([]);
  });

  test("names the resolution when a frame of the owner's model is asked at 2K", async () => {
    const request = withBody(await sentBy(ownerParams()), (b) => ({ ...b, resolution: "2K" }));
    expect(ownerRequestProblems(request).join("\n")).toContain("resolution");
  });

  test("names the model when the owner's slot went to Seedream", async () => {
    const request = withBody(await sentBy(ownerParams()), (b) => ({ ...b, model: BOLD_MODEL }));
    expect(ownerRequestProblems(request).join("\n")).toContain("model");
  });
});

describe("failedReasonsOf", () => {
  test("lists the reasons of a run's job.done in slot order", () => {
    const end = { type: "job.done", payload: { result: { failedReasons: [{ slotIndex: 4, reason: "model-empty" }, { slotIndex: 2, reason: "model-refused" }] } } };
    expect(failedReasonsOf(end)).toEqual(["model-refused", "model-empty"]);
  });

  test("lists none when the result names no reason", () => {
    expect(failedReasonsOf({ type: "job.done", payload: { result: { failedSlots: 0 } } })).toEqual([]);
  });
});

describe("expectedBilledMicros", () => {
  const request = (resolution: string): SentImageRequest => ({ model: resolution === "2K" ? BOLD_MODEL : GROK, resolution, body: {} });

  test("bills a 2K image at the Seedream bill and a 1K one at the mock's image cost, in whole micro-dollars", () => {
    expect(expectedBilledMicros([request("2K"), request("1K"), request("2K")], 0)).toBe(45_000 + 40_000 + 45_000);
  });

  test("a refused request is free: the refusal takes one 2K request off the bill", () => {
    expect(expectedBilledMicros([request("2K"), request("2K"), request("1K")], 1)).toBe(45_000 + 40_000);
  });

  test("an empty answer is billed like any other request, so it is in the sum", () => {
    expect(expectedBilledMicros([request("2K")], 0)).toBe(45_000);
  });
});
