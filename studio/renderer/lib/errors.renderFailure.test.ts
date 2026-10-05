import { expect, test } from "bun:test";
import { RENDER_NO_SPACE_DETAIL_PREFIX } from "../../shared/engine";
import { errorText } from "./errors";

// A retry fixes some render failures and not others: the text must not say «Попробуйте ещё раз» where it cannot help.

test("a render with no room for its temporary files says to free disk space, not to try again", () => {
  const text = errorText({ code: "RENDER_FAILED", detail: `${RENDER_NO_SPACE_DETAIL_PREFIX}: about 900 MiB are needed` });
  expect(text).toContain("не хватает места");
  expect(text).toContain("Освободите");
  expect(text).not.toContain("Попробуйте ещё раз");
});

test("a render failure of any other kind still says to try again", () => {
  expect(errorText({ code: "RENDER_FAILED", detail: "ffmpeg failed: boom" })).toContain("Попробуйте ещё раз");
});

test("a video that failed its check is not told «Попробуйте ещё раз»: the check is the same next time", () => {
  const text = errorText({ code: "RENDER_VERIFY_FAILED", detail: "the output failed verification (frame-count)" });
  expect(text).not.toContain("Попробуйте ещё раз");
  expect(text).toContain("не сохранено");
  expect(text).toContain("измените монтаж");
});
