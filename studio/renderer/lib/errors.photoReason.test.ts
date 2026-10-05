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

test("a photo held by a render says the render is queued or running, and that a finished render keeps the photo in its video", () => {
  const text = errorText({ code: "PHOTO_UNAVAILABLE", issues: PHOTO_ISSUES, photoReason: "held-by-render" });
  expect(text).toContain("рендер");
  expect(text).toContain("Отмените тот рендер");
  expect(text).toContain("если он соберётся, фото останется в том видео");
  expect(text).toContain("Выберите другое фото");
});

test("a photo held by an unfinished video says so and does not advise cancelling a render that does not exist", () => {
  const text = errorText({ code: "PHOTO_UNAVAILABLE", issues: PHOTO_ISSUES, photoReason: "pending-video" });
  expect(text).toContain("не успело сохраниться");
  expect(text).not.toContain("Отмените");
  // No promise that waiting helps: an unfinished video is settled at start-up (or a library switch) only, and an unreadable one holds every photo.
  expect(text).not.toContain("Подождите");
  expect(text).not.toContain("подождите");
  expect(text).toContain("при запуске Studio");
  // The notice the engine raises for an unreadable intent is named, as the owner reads it.
  expect(text).toContain("Незавершённое видео не прочитано");
  expect(text).toContain("выберите другое фото");
});

test.each(["index-stale", "log-needs-repair"] as const)("a refusal from an avatar whose records cannot be trusted (%s) says every photo of the avatar is refused, not one", (photoReason) => {
  const text = errorText({ code: "PHOTO_UNAVAILABLE", issues: PHOTO_ISSUES, photoReason });
  expect(text).toContain("все фото этого аватара");
});

test("a broken-records refusal points to the Photos screen, which says what happened, and promises no repair button (a record the disk will not open has none)", () => {
  const text = errorText({ code: "PHOTO_UNAVAILABLE", issues: PHOTO_ISSUES, photoReason: "log-needs-repair" });
  expect(text).toContain("«Фото»");
  expect(text).toContain("там написано, что случилось и что можно сделать");
  expect(text).not.toContain("убрать повреждённую запись");
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
