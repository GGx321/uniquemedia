import { describe, expect, test } from "bun:test";
import type { FetchCall } from "../openrouter/testing/fakes";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { imageReply, imageReplyFor, isSeedream } from "./wiringKit";
useNativeGlobals();

// 5a.3 (S5.9f, plan s5a3 §12): the wiring kit's fake image endpoint answers by the model a request names, so a parity story can refuse or empty ONLY the Seedream requests of a «Смелая» run
// and leave the owner's model alone. Without a fault it is `imageReply`, byte for byte, so every older story keeps the answers it was bound to.

const SEEDREAM = "bytedance-seed/seedream-5-0-pro";
const GROK = "x-ai/grok-imagine-image-2.0";

function callFor(model: string): FetchCall {
  const body = JSON.stringify({ model, prompt: "p", aspect_ratio: "9:16" });
  return { url: "https://openrouter.ai/api/v1/images", method: "POST", headers: {}, body, redirect: undefined, signal: new AbortController().signal, json: () => JSON.parse(body), response: { pulledChunks: 0, cancelled: false } };
}

describe("isSeedream", () => {
  test("is true for a request that names the Seedream model", () => {
    expect(isSeedream(callFor(SEEDREAM))).toBe(true);
  });

  test("is false for a request that names the owner's model", () => {
    expect(isSeedream(callFor(GROK))).toBe(false);
  });
});

describe("imageReplyFor", () => {
  test("answers as imageReply does when no fault is armed, for either model", () => {
    expect(imageReplyFor(callFor(GROK), 3)).toEqual(imageReply(3));
    expect(imageReplyFor(callFor(SEEDREAM), 3)).toEqual(imageReply(3));
  });

  test("refuses a Seedream request through content moderation: a 400 whose message the transport matches", () => {
    const reply = imageReplyFor(callFor(SEEDREAM), 1, "refuse");
    expect(reply).toMatchObject({ status: 400 });
    expect(JSON.stringify("body" in reply ? reply.body : null)).toContain("content moderation");
  });

  test("answers a Seedream request with a 2xx that holds no image but carries a bill", () => {
    const reply = imageReplyFor(callFor(SEEDREAM), 1, "empty");
    expect(reply).toMatchObject({ status: 200, body: { data: [], usage: { cost: 0.045 } } });
  });

  test("leaves the owner's model alone whatever fault is armed", () => {
    expect(imageReplyFor(callFor(GROK), 2, "refuse")).toEqual(imageReply(2));
    expect(imageReplyFor(callFor(GROK), 2, "empty")).toEqual(imageReply(2));
  });
});
