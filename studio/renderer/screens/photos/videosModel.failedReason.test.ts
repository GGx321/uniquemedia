import { expect, test } from "bun:test";
import { RENDER_NO_SPACE_DETAIL_PREFIX, RENDER_TIMEOUT_DETAIL_PREFIX } from "../../../shared/engine";
import { failedRenderLine } from "./videosModel";

// The card line of a failed render (A19) says what really happened for the causes the engine names, not «внутренняя ошибка».

test("a render that ran past its time limit says it did not finish in time", () => {
  expect(failedRenderLine({ code: "TIMEOUT", detail: `${RENDER_TIMEOUT_DETAIL_PREFIX} of 60 s` })).toBe("Не собралось: рендер не уложился во время. Фото остались свободными.");
});

test("a render with no room for its temporary files says the disk is short of space", () => {
  expect(failedRenderLine({ code: "RENDER_FAILED", detail: `${RENDER_NO_SPACE_DETAIL_PREFIX}: about 900 MiB are needed` })).toBe("Не собралось: не хватает места на диске. Фото остались свободными.");
});

test("a render refused for a record from a newer Studio says so", () => {
  expect(failedRenderLine({ code: "LIBRARY_TOO_NEW" })).toBe("Не собралось: записи видео созданы более новой версией Studio. Фото остались свободными.");
});

test("any other render failure keeps its short line", () => {
  expect(failedRenderLine({ code: "RENDER_FAILED", detail: "ffmpeg failed: boom" })).toBe("Не собралось: сборка не удалась. Фото остались свободными.");
});
