import { expect, test } from "bun:test";
import { CLIP_IN_FLIGHT_REASONS, CLIP_REASONS_RU, CLIP_VALIDATION_REASONS, ERROR_MESSAGES_RU, PRICE_SCOPES_RU } from "../../shared/engine";
import { errorText } from "./errors";

// Stage 5, 5b.1, S5.V8 (plan s5b1 §5.2): a clip command the engine refused says why (`clipReason`), and a video price that cannot be read says so (`priceScope: "video"`): the window shows
// their own texts, never the general one of the code.

test.each([...CLIP_VALIDATION_REASONS])("the VALIDATION reason %s shows its own text", (clipReason) => {
  const text = errorText({ code: "VALIDATION", clipReason });
  expect(text).toBe(CLIP_REASONS_RU[clipReason]);
  expect(text).not.toBe(ERROR_MESSAGES_RU.VALIDATION);
});

test.each([...CLIP_IN_FLIGHT_REASONS])("the IN_FLIGHT reason %s shows its own text", (clipReason) => {
  const text = errorText({ code: "IN_FLIGHT", clipReason });
  expect(text).toBe(CLIP_REASONS_RU[clipReason]);
  expect(text).not.toBe(ERROR_MESSAGES_RU.IN_FLIGHT);
});

test("«Сейчас снимается другой клип» is said as the contract words it (§5.2)", () => {
  expect(errorText({ code: "IN_FLIGHT", clipReason: "one-at-a-time" })).toBe("Сейчас снимается другой клип — дождитесь его (обычно 1–3 минуты).");
});

test("PRICE_UNAVAILABLE for the video prices (38f) says that only clips wait", () => {
  expect(errorText({ code: "PRICE_UNAVAILABLE", priceScope: "video" })).toBe(PRICE_SCOPES_RU.video);
  expect(PRICE_SCOPES_RU.video).toBe("Цены видео у OpenRouter сейчас не читаются — клип не запустить. Фото работают как обычно.");
});

test("a PRICE_UNAVAILABLE of no scope, and the 2K tier's (said by its own screens), keep the general text here", () => {
  expect(errorText({ code: "PRICE_UNAVAILABLE" })).toBe(ERROR_MESSAGES_RU.PRICE_UNAVAILABLE);
  expect(errorText({ code: "PRICE_UNAVAILABLE", priceScope: "bold" })).toBe(ERROR_MESSAGES_RU.PRICE_UNAVAILABLE);
});

test("VALIDATION and IN_FLIGHT without a clip reason keep their general texts", () => {
  expect(errorText({ code: "VALIDATION" })).toBe(ERROR_MESSAGES_RU.VALIDATION);
  expect(errorText({ code: "IN_FLIGHT" })).toBe(ERROR_MESSAGES_RU.IN_FLIGHT);
});
