import { describe, expect, test } from "bun:test";
import { ERROR_MESSAGES_RU, EXPORT_UNAVAILABLE_REASONS, EXPORT_UNAVAILABLE_REASONS_RU } from "../../shared/engine";
import { EXPORT_UNAVAILABLE_TITLE, LIBRARY_RENDER_BUSY_TEXT, pickedNotice, refusedPickText, unavailableText } from "./exportFolder";
import { NBSP } from "./format";

// 3e.3: what the «Готовые видео» card tells the owner after a pick, and why a folder cannot be used. Pure text, from the engine's
// counts and its closed list of reasons.

const n = (count: number, word: string): string => `${count}${NBSP}${word}`;

describe("pickedNotice", () => {
  test("a folder with no video to resolve or to leave behind is just chosen", () => {
    expect(pickedNotice({ resolved: 0, elsewhere: 0, incomplete: false })).toEqual({ tone: "ok", text: "Папка выбрана.", hint: null });
  });

  test("a folder that holds every video (the moved one, or the first again) says so", () => {
    expect(pickedNotice({ resolved: 2, elsewhere: 0, incomplete: false })).toEqual({ tone: "ok", text: `Папка выбрана: все ${n(2, "видео")} на месте.`, hint: null });
  });

  test("one video is one video, not «все 1»", () => {
    expect(pickedNotice({ resolved: 1, elsewhere: 0, incomplete: false }).text).toBe(`Папка выбрана: ${n(1, "видео")} на месте.`);
  });

  test("videos left in the previous folder are counted, and the way back is named", () => {
    const notice = pickedNotice({ resolved: 2, elsewhere: 3, incomplete: false });

    expect(notice.tone).toBe("warn");
    expect(notice.text).toBe(`Папка выбрана: ${n(2, "видео")} на месте, ${n(3, "видео")} остались в прежней папке.`);
    expect(notice.hint).toBe("Они снова откроются, когда вы выберете прежнюю папку ещё раз.");
  });

  test("a new folder with nothing in it leaves every video behind", () => {
    expect(pickedNotice({ resolved: 0, elsewhere: 2, incomplete: false }).text).toBe(`Папка выбрана: ${n(0, "видео")} на месте, ${n(2, "видео")} остались в прежней папке.`);
  });

  test.each([
    [1, "осталось"],
    [2, "остались"],
    [4, "остались"],
    [5, "остались"],
    [11, "остались"],
    [21, "осталось"],
    [22, "остались"],
  ])("%i left behind agrees with «%s»", (count, verb) => {
    expect(pickedNotice({ resolved: 0, elsewhere: count, incomplete: false }).text).toContain(`${n(count, "видео")} ${verb} в прежней папке`);
  });
});

describe("pickedNotice when the counts are not whole", () => {
  const HINT = "Часть записей о видео прочитать не удалось, поэтому числа могут быть неполными.";

  test("never claims that every video is there: no «все», and a warning that says why", () => {
    const notice = pickedNotice({ resolved: 3, elsewhere: 0, incomplete: true });

    expect(notice.text).toBe(`Папка выбрана: ${n(3, "видео")} на месте.`);
    expect(notice.text).not.toContain("все");
    expect(notice).toMatchObject({ tone: "warn", hint: HINT });
  });

  test("a folder that seems empty is still announced, with the warning", () => {
    expect(pickedNotice({ resolved: 0, elsewhere: 0, incomplete: true })).toEqual({ tone: "warn", text: "Папка выбрана.", hint: HINT });
  });

  test("videos left behind and incomplete counts: both hints are given", () => {
    const notice = pickedNotice({ resolved: 1, elsewhere: 2, incomplete: true });

    expect(notice.tone).toBe("warn");
    expect(notice.hint).toContain("Они снова откроются");
    expect(notice.hint).toContain(HINT);
  });
});

describe("LIBRARY_RENDER_BUSY_TEXT", () => {
  test("says it is the renders that hold the library folder, not paid requests, and what to do", () => {
    expect(LIBRARY_RENDER_BUSY_TEXT).toBe("Пока идут рендеры, папку библиотеки менять нельзя: дождитесь их конца или отмените их.");
  });
});

describe("refusedPickText", () => {
  test.each([...EXPORT_UNAVAILABLE_REASONS])("a folder refused as %s says why, and that the old folder stays", (exportReason) => {
    const text = refusedPickText({ code: "EXPORT_UNAVAILABLE", exportReason });

    expect(text).toContain("Эту папку выбрать нельзя.");
    expect(text).toContain(EXPORT_UNAVAILABLE_REASONS_RU[exportReason]);
    expect(text).toContain("Прежняя папка осталась.");
  });

  test("a damaged marker with records never tells the owner to delete, move or rename the file", () => {
    const text = refusedPickText({ code: "EXPORT_UNAVAILABLE", exportReason: "invalid-marker-with-records" });

    expect(text).not.toMatch(/(?<!не )(удал|убер|сотр|переим|перенес|перемест)/i);
  });

  test("a pick refused while a render runs says to wait for it, or to cancel it", () => {
    expect(refusedPickText({ code: "IN_FLIGHT" })).toBe("Пока идут рендеры, папку менять нельзя: дождитесь их конца или отмените их.");
  });

  test("any other error is the ordinary text for it", () => {
    expect(refusedPickText({ code: "VALIDATION" })).toBe(ERROR_MESSAGES_RU.VALIDATION);
  });

  test("EXPORT_UNAVAILABLE with no reason (an engine that did not say) still says the folder cannot be chosen", () => {
    expect(refusedPickText({ code: "EXPORT_UNAVAILABLE" })).toContain("Эту папку выбрать нельзя.");
  });
});

describe("unavailableText", () => {
  test("the title names the folder as the owner knows it", () => {
    expect(EXPORT_UNAVAILABLE_TITLE).toBe("Папка «Готовые видео» недоступна");
  });

  test.each([...EXPORT_UNAVAILABLE_REASONS])("%s is its own text and nothing else", (reason) => {
    expect(unavailableText(reason)).toBe(EXPORT_UNAVAILABLE_REASONS_RU[reason]);
  });

  test("the damaged marker of a library with records is never advised away", () => {
    expect(unavailableText("invalid-marker-with-records")).not.toMatch(/(?<!не )(удал|убер|сотр|переим|перенес|перемест)/i);
  });
});
