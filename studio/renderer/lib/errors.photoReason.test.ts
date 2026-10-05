import { expect, test } from "bun:test";
import { MONTAGE_ISSUE_MESSAGES_RU } from "../../shared/engine";
import { errorText } from "./errors";

// A refused scene photo says why (`photoReason`): one photo goes into one video, a running render holds its photos, and an avatar whose records cannot be trusted
// refuses every photo it has, which one replacement cannot fix.

const PHOTO_ISSUES = [{ code: "photo-unavailable" as const, path: ["photoIds", 0] }];

test("a photo already in a video says so, and says one photo goes into one video", () => {
  const text = errorText({ code: "PHOTO_UNAVAILABLE", issues: PHOTO_ISSUES, photoReason: "in-video" });
  expect(text).toContain("уже в другом видео");
  expect(text).toContain("одно фото");
});

test("a photo held by a render says the render is queued or running and tells to wait", () => {
  const text = errorText({ code: "PHOTO_UNAVAILABLE", issues: PHOTO_ISSUES, photoReason: "held-by-render" });
  expect(text).toContain("рендер");
  expect(text).toContain("Дождитесь");
});

test.each(["index-stale", "log-needs-repair"] as const)("a refusal from an avatar whose records cannot be trusted (%s) says every photo of the avatar is refused, not one", (photoReason) => {
  const text = errorText({ code: "PHOTO_UNAVAILABLE", issues: PHOTO_ISSUES, photoReason });
  expect(text).toContain("все фото этого аватара");
});

test("a broken-records refusal points to the Photos screen where the way out is", () => {
  expect(errorText({ code: "PHOTO_UNAVAILABLE", issues: PHOTO_ISSUES, photoReason: "log-needs-repair" })).toContain("«Фото»");
});

test("a refusal with no reason lists what it can be, and never blames the age check", () => {
  const text = errorText({ code: "PHOTO_UNAVAILABLE", issues: PHOTO_ISSUES });
  expect(text).toContain("уже в другом видео");
  expect(text).toContain("отклонено");
  expect(text).not.toContain("возраст");
});

test("the issue text for a photo no longer says it was only rejected", () => {
  expect(MONTAGE_ISSUE_MESSAGES_RU["photo-unavailable"]).toContain("уже в другом видео");
});
