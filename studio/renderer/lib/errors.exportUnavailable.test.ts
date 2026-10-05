import { expect, test } from "bun:test";
import { errorText } from "./errors";

// EXPORT_UNAVAILABLE is answered to a render, to «Удалить» (the video IS saved, and may be gone after a timeout whose outcome is unknown) and to «Папка «Готовые видео»»:
// the general text must not claim a video was not saved.

test.each([
  ["a render", { code: "EXPORT_UNAVAILABLE" as const, exportReason: "missing" as const }],
  ["a delete whose folder did not answer", { code: "EXPORT_UNAVAILABLE" as const, exportReason: "not-writable" as const, detail: "the export folder did not answer in time; look at the video list before trying again" }],
  ["opening the folder", { code: "EXPORT_UNAVAILABLE" as const, exportReason: "missing" as const }],
])("the text for %s does not say the video was not saved", (_name, error) => {
  expect(errorText(error)).not.toContain("видео не сохранено");
});

test("the text still points to Settings, says nothing was spent and gives the reason", () => {
  const text = errorText({ code: "EXPORT_UNAVAILABLE", exportReason: "not-a-directory" });
  expect(text).toContain("Настройках");
  expect(text).toContain("ничего не потрачено");
  expect(text).toContain("лежит файл");
});
