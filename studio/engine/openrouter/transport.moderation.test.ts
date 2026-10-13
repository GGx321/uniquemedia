import { expect, test } from "bun:test";
import { isModerationRefusal } from "./transport";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

const body = (message: string): string => JSON.stringify({ error: { message } });

test("is exported for the video client, which reads a failed job's text with it", () => {
  expect(typeof isModerationRefusal).toBe("function");
});

test("counts a 400 whose error message names content moderation", () => {
  expect(isModerationRefusal(400, body("xAI blocked this request through content moderation."))).toBe(true);
});

test("counts a 403 and a 422 the same way", () => {
  expect(isModerationRefusal(403, body("flagged by the provider"))).toBe(true);
  expect(isModerationRefusal(422, body("the image may contain sensitive information"))).toBe(true);
});

test("does not count a status outside 400, 403 and 422", () => {
  expect(isModerationRefusal(500, body("content moderation"))).toBe(false);
  expect(isModerationRefusal(404, body("content moderation"))).toBe(false);
});

test("does not count a plain validation error", () => {
  expect(isModerationRefusal(400, body("duration must be 5 or 10"))).toBe(false);
});

test("does not count a body that is not an error object", () => {
  expect(isModerationRefusal(400, "content moderation")).toBe(false);
});

test("counts a provider code in the error metadata", () => {
  const text = JSON.stringify({ error: { message: "Provider returned error", metadata: { raw: "InputImageSensitiveContentDetected" } } });
  expect(isModerationRefusal(400, text)).toBe(true);
});
