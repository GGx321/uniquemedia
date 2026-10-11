import { describe, expect, test } from "bun:test";
import { ERROR_MESSAGES_RU, NO_ANSWER_DETAIL_PREFIX, type ErrorCode, type FailedPortraitSlot } from "../../../shared/engine";
import { errorText } from "../../lib/errors";
import {
  ageRejectedLine,
  answerLost,
  batchFits,
  capReason,
  freeFailureLine,
  goneTiles,
  likenessText,
  NONE_PASSED,
  paidFailureLine,
  slotCharge,
  startRefusalText,
  variantLabel,
} from "./portraitModel";

// S5.3d: what the reference portrait says (.omc/stage5/design 16–17, README «Для S5.3d»): a slot's own words by its outcome, the paid failures only
// in the summary (a moderation refusal is free), the age check's line agreed in number, and the limit.

const refused: FailedPortraitSlot = { slot: 5, reason: "failed", error: { code: "MODERATION_REFUSED" }, reserveLeftOpen: false };
const timedOut = (slot: number): Extract<FailedPortraitSlot, { reason: "failed" }> => ({ slot, reason: "failed", error: { code: "TIMEOUT" }, reserveLeftOpen: true });
const failedWith = (slot: number, code: ErrorCode): Extract<FailedPortraitSlot, { reason: "failed" }> => ({ slot, reason: "failed", error: { code }, reserveLeftOpen: false });

describe("a finished batch's slots without a portrait", () => {
  test("each says why, in slot order: the face check's drops and the age check's are paid, a refusal is free, a failure paid", () => {
    const tiles = goneTiles("off", [
      refused,
      { slot: 4, reason: "unlike", likeness: 0.4812 },
      { slot: 1, reason: "no-face" },
      { slot: 2, reason: "multiple-faces" },
      { slot: 3, reason: "age-rejected" },
    ]);
    expect(tiles.map((t) => [t.title, t.sub])).toEqual([
      ["Лицо не найдено", "стоимость учтена"],
      ["Несколько лиц", "стоимость учтена"],
      ["Скрыт проверкой возраста", "стоимость учтена"],
      ["Не похожа · 0.48", "стоимость учтена"],
      ["Модель отказалась · бесплатно", null],
    ]);
    // Dropped after it was drawn: the dark tile; nothing to show: the dashed one.
    expect(tiles.map((t) => t.look)).toEqual(["dropped", "dropped", "dropped", "dropped", "failed"]);
  });

  test("a failure that may have been billed is said as paid (16e); one that sent nothing or settled at 0 as free", () => {
    expect(goneTiles("off", [timedOut(1)]).map((t) => [t.title, t.sub, t.look])).toEqual([["Не получилось · стоимость учтена", null, "failed"]]);
    expect(goneTiles("off", [failedWith(2, "BUDGET_EXCEEDED")]).map((t) => [t.title, t.sub, t.look])).toEqual([["Не получилось · бесплатно", null, "failed"]]);
    expect(goneTiles("off", [failedWith(3, "INTERNAL")]).map((t) => t.title)).toEqual(["Не получилось · стоимость учтена"]);
  });
});

describe("what a failed slot cost (the money rules of settleRule.ts)", () => {
  test("never sent: the budget refused its hold — free", () => {
    for (const code of ["BUDGET_EXCEEDED", "RUN_CAP_EXCEEDED", "RECONCILE_REQUIRED"] as const) expect(slotCharge(failedWith(1, code), "off")).toBe("free");
  });

  test("age check off — a final non-2xx answer settles at 0: free (the image is the slot's only request)", () => {
    for (const code of ["MODERATION_REFUSED", "AUTH_INVALID", "INSUFFICIENT_CREDITS", "RATE_LIMITED"] as const) expect(slotCharge(failedWith(1, code), "off")).toBe("free");
    // A 5xx that outlasted the transport retries is NETWORK with its reserve settled (not left open).
    expect(slotCharge(failedWith(1, "NETWORK"), "off")).toBe("free");
  });

  test("age check on — the image was paid before the check: a check refused by the budget or answered non-2xx is never free (review M2)", () => {
    for (const code of ["RATE_LIMITED", "NETWORK", "BUDGET_EXCEEDED", "RUN_CAP_EXCEEDED"] as const) expect(slotCharge(failedWith(1, code), "on")).toBe("paid");
    for (const code of ["AUTH_INVALID", "INSUFFICIENT_CREDITS", "RECONCILE_REQUIRED", "INTERNAL"] as const) expect(slotCharge(failedWith(1, code), "on")).toBe("paid");
    // The coordinator's rule: a model's moderation refusal stays free; a reserve left open stays open.
    expect(slotCharge(failedWith(1, "MODERATION_REFUSED"), "on")).toBe("free");
    expect(slotCharge(timedOut(1), "on")).toBe("open");
  });

  test("age check on — the tiles and the lines say those slots cost, and none of them «ничего не стоили»", () => {
    const slots = (["RATE_LIMITED", "NETWORK", "BUDGET_EXCEEDED", "RUN_CAP_EXCEEDED"] as const).map((code, i) => failedWith(i + 1, code));
    expect(goneTiles("on", slots).map((t) => t.title)).toEqual(Array.from({ length: 4 }, () => "Не получилось · стоимость учтена"));
    expect(freeFailureLine("on", slots)).toBeNull();
    expect(paidFailureLine("on", slots)).toBe("4\u00a0варианта не удалось получить: причины разные — подробности в журнале. Стоимость попытки учтена.");
    expect(goneTiles("on", [refused]).map((t) => t.title)).toEqual(["Модель отказалась · бесплатно"]);
  });

  test("a timeout or a lost connection leaves the reserve open at its worst until a reconcile — counted", () => {
    expect(slotCharge(timedOut(1), "off")).toBe("open");
    expect(slotCharge({ slot: 1, reason: "failed", error: { code: "NETWORK" }, reserveLeftOpen: true }, "off")).toBe("open");
  });

  test("anything else may have bought its image (a paid answer it could not use, a bill above the worst case) — counted", () => {
    for (const code of ["INTERNAL", "SETTLE_ABOVE_WORST", "LEDGER_WRITE_FAILED", "TIMEOUT"] as const) expect(slotCharge(failedWith(1, code), "off")).toBe("paid");
  });
});

describe("the summary of failed slots (16e)", () => {
  test("counts only the paid ones, with their shared reason", () => {
    expect(paidFailureLine("off", [timedOut(1), timedOut(2), refused])).toBe(
      `2 варианта не удалось получить: ${ERROR_MESSAGES_RU.TIMEOUT} Стоимость попытки учтена.`,
    );
  });

  test("says nothing when the only failure was a free refusal (16)", () => {
    expect(paidFailureLine("off", [refused, { slot: 4, reason: "unlike", likeness: 0.48 }])).toBeNull();
  });

  test("leaves out what cost nothing, and says the worst-price rule for a lost connection whose text does not", () => {
    expect(paidFailureLine("off", [failedWith(1, "BUDGET_EXCEEDED"), failedWith(2, "RATE_LIMITED")])).toBeNull();
    expect(paidFailureLine("off", [{ slot: 1, reason: "failed", error: { code: "NETWORK" }, reserveLeftOpen: true }])).toBe(
      `1 вариант не удалось получить: ${ERROR_MESSAGES_RU.NETWORK.charAt(0).toLowerCase()}${ERROR_MESSAGES_RU.NETWORK.slice(1)} До сверки попытка считается по худшей цене. Стоимость попытки учтена.`,
    );
  });

  test("the free failures other than a refusal say why, and that they cost nothing", () => {
    expect(freeFailureLine("off", [failedWith(1, "BUDGET_EXCEEDED"), failedWith(2, "BUDGET_EXCEEDED"), refused])).toBe(
      `2 варианта не удалось получить: ${ERROR_MESSAGES_RU.BUDGET_EXCEEDED.charAt(0).toLowerCase()}${ERROR_MESSAGES_RU.BUDGET_EXCEEDED.slice(1)} Эти попытки ничего не стоили.`,
    );
    expect(freeFailureLine("off", [refused, timedOut(2)])).toBeNull();
  });

  test("names no reason when the paid failures disagree, and still says the worst-price rule for the reserves left open", () => {
    expect(paidFailureLine("off", [timedOut(1), { slot: 2, reason: "failed", error: { code: "NETWORK" }, reserveLeftOpen: true }])).toBe(
      "2 варианта не удалось получить: причины разные — подробности в журнале. До сверки попытка считается по худшей цене. Стоимость попытки учтена.",
    );
    expect(paidFailureLine("off", [failedWith(1, "INTERNAL"), failedWith(2, "SETTLE_ABOVE_WORST")])).toBe(
      "2 варианта не удалось получить: причины разные — подробности в журнале. Стоимость попытки учтена.",
    );
  });
});

describe("the age check's line (16b)", () => {
  test("agrees in number: one is «отклонён … не показан», several «отклонены … не показаны»", () => {
    expect(ageRejectedLine(0)).toBeNull();
    expect(ageRejectedLine(1)).toBe("1 вариант отклонён проверкой возраста и не показан. Его стоимость учтена.");
    expect(ageRejectedLine(2)).toBe("2 варианта отклонены проверкой возраста и не показаны. Их стоимость учтена.");
    expect(ageRejectedLine(5)).toBe("5 вариантов отклонены проверкой возраста и не показаны. Их стоимость учтена.");
  });
});

describe("the limit of 15 waiting (16c)", () => {
  test("another batch fits up to 10 waiting; from 11 on five more would pass the limit", () => {
    expect(batchFits(0)).toBe(true);
    expect(batchFits(10)).toBe(true);
    expect(batchFits(11)).toBe(false);
    expect(batchFits(15)).toBe(false);
  });

  test("at 15 the mockup's words; below it, how many wait", () => {
    expect(capReason(15)).toBe("Уже 15 вариантов — выберите один или удалите все.");
    expect(capReason(12)).toBe("Уже 12 вариантов — ещё 5 превысят предел в 15. Выберите один или удалите все.");
  });
});

describe("words around the numbers", () => {
  test("a likeness is two decimals, as the gallery's badge", () => {
    expect(likenessText(0.7649)).toBe("0.76");
    expect(likenessText(1)).toBe("1.00");
  });

  test("a radio names its letter, its likeness and «лучший»", () => {
    expect(variantLabel("A", 0.76, true)).toBe("Вариант A · сходство 0.76 · лучший");
    expect(variantLabel("C", 0.61, false)).toBe("Вариант C · сходство 0.61");
  });

  test("17's line names the gate", () => {
    expect(NONE_PASSED).toBe("Ни один вариант не похож на исходное фото (порог 0.55). Платные попытки учтены.");
  });

  test("a refusal adds that nothing was started, unless its own text already says nothing was spent", () => {
    expect(startRefusalText({ code: "BUDGET_EXCEEDED" })).toBe(`${ERROR_MESSAGES_RU.BUDGET_EXCEEDED} Варианты не запускались — ничего не потрачено.`);
    expect(startRefusalText({ code: "FACE_GATE_UNAVAILABLE" })).toBe(ERROR_MESSAGES_RU.FACE_GATE_UNAVAILABLE);
  });

  test("an answer that never came is no refusal: the batch may be drawing, so nothing is said of what was spent (M1)", () => {
    const lost = { code: "INTERNAL" as const, detail: `${NO_ANSWER_DETAIL_PREFIX}30 s` };
    expect(answerLost(lost)).toBe(true);
    expect(answerLost({ code: "INTERNAL" })).toBe(false);
    expect(startRefusalText(lost)).toBe(errorText(lost));
    expect(startRefusalText(lost)).not.toContain("ничего не потрачено");
    expect(startRefusalText(lost)).not.toContain("не запускались");
  });
});
