import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { LAUNCH_REASONS_RU, SCENE_REASONS_RU, type PhotoSummary, type SceneReason } from "../../shared/engine";
import type { JobView } from "../engine/store";
import { errorText } from "../lib/errors";
import { RunOutcome } from "./photos/ScenesColumn";

// S5.9g (plan s5a3 gap B, §13.1 «Run end», §13.2; mockup 50 of .omc/stage5/design): the end of a run counts its failed frames, says why each ended, and adds
// «Если за попытки платили, это уже учтено в расходах.» only while failed FRAMES remain whose own text does not speak of money. `model-refused` and
// `model-empty` speak of it themselves (the contract's texts), `slot-text-problem` says «бесплатно»: so a run whose every failed frame ended with one of
// them says the money once, never twice. The reasons' texts are the contract's (`SCENE_REASONS_RU`), word for word. One reason for every failed frame reads
// as its sentence alone (mockup 50, 50#empty); mixed reasons are counted, «Из них K — …» (50#mixed).

const GENERAL = "Если за попытки платили, это уже учтено в расходах.";
const REFUSED = SCENE_REASONS_RU["model-refused"];
const EMPTY = SCENE_REASONS_RU["model-empty"];
/** A reason's text after «Из них K —»: the contract's sentence with a lower-case first letter (mockup 50#mixed). */
const lower = (text: string): string => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;

function photo(id: string): PhotoSummary {
  return {
    photoId: id,
    avatarId: "avatar-mia-0001",
    runId: "run-00000001",
    category: "nightwear",
    createdAt: "2026-10-12T10:00:00.000Z",
    qa: { faceCos: 0.71 },
    used: false,
    usedIn: [],
    rejected: false,
    reserved: false,
    eligible: true,
  };
}

/** A run that kept `kept` photos and failed `failed` slots, `reasons` naming the ones that ended with a reason (slot 1, 2, … in order). */
function ended(kept: number, failed: number, reasons: readonly SceneReason[]): JobView {
  const photoIds = Array.from({ length: kept }, (_, i) => `p${i + 1}`);
  return {
    jobId: "job-1",
    kind: "run",
    avatarId: "avatar-mia-0001",
    runId: "run-00000001",
    montageId: null,
    videoId: null,
    status: "done",
    saving: false,
    done: kept,
    total: kept + failed,
    result: { kind: "run", runId: "run-00000001", avatarId: "avatar-mia-0001", photoIds, failedSlots: failed, ...(reasons.length === 0 ? {} : { failedReasons: reasons.map((reason, i) => ({ slotIndex: i + 1, reason })) }) },
    error: null,
  };
}

/** The run-end notice's second line: «Не получилось: N. …». */
function failedLine(): string {
  const line = document.querySelector(".run-end-line");
  if (line === null) throw new Error("no failed line");
  return line.textContent ?? "";
}
const occurrences = (text: string, part: string): number => text.split(part).length - 1;

describe("the end of a run with «Смелая» frames that ended (gap B: counted by frames)", () => {
  test("one failed `model-refused` → its own sentence, which speaks of the money: one money sentence, no general one", () => {
    render(<RunOutcome job={ended(19, 1, ["model-refused"])} fromSet={false} photos={[photo("p1")]} />);
    expect(failedLine()).toBe(`Не получилось: 1. ${REFUSED}`);
    expect(REFUSED).toBe("Модель не нарисовала кадр «Смелой»; сам отказ бесплатный, оплаченные до него попытки — в расходах.");
    expect(occurrences(failedLine(), "расход")).toBe(1);
  });

  test("a `model-refused` beside a frame that failed with no reason (an HTTP error) → the general sentence once, for that frame", () => {
    render(<RunOutcome job={ended(18, 2, ["model-refused"])} fromSet={false} photos={[photo("p1")]} />);
    expect(failedLine()).toBe(`Не получилось: 2. Из них 1 — ${lower(REFUSED)} ${GENERAL}`);
    expect(occurrences(failedLine(), GENERAL)).toBe(1);
  });

  // 2026-10-12, S5.9g round 2 (the owner-approved mockup 50 overrides the plan's gap-B row «3 refused → Из них 3»): when every failed frame shares one reason,
  // «Не получилось: N.» and the contract's sentence as it is — «Из них K — …» only when the reasons are mixed (50#mixed), which keeps the number agreement.
  test("50: two `model-refused`, every failed frame — «Не получилось: 2.» and the bare sentence, no «Из них», no general sentence", () => {
    render(<RunOutcome job={ended(18, 2, ["model-refused", "model-refused"])} fromSet={false} photos={[photo("p1")]} />);
    expect(failedLine()).toBe("Не получилось: 2. Модель не нарисовала кадр «Смелой»; сам отказ бесплатный, оплаченные до него попытки — в расходах.");
    expect(failedLine().includes("Из них")).toBe(false);
    expect(failedLine().includes(GENERAL)).toBe(false);
  });

  test("three `model-refused`, every failed frame — the bare sentence too", () => {
    render(<RunOutcome job={ended(17, 3, ["model-refused", "model-refused", "model-refused"])} fromSet={false} photos={[photo("p1")]} />);
    expect(failedLine()).toBe(`Не получилось: 3. ${REFUSED}`);
  });

  test("50#empty: two `model-empty`, every failed frame — mockup 50's line word for word", () => {
    render(<RunOutcome job={ended(18, 2, ["model-empty", "model-empty"])} fromSet={false} photos={[photo("p1")]} />);
    expect(failedLine()).toBe("Не получилось: 2. Модель вернула пустой ответ на кадр «Смелой»; попытка учтена в расходах.");
  });

  test("50#mixed: two refused and one empty → each counted, in the order they came, no general sentence", () => {
    render(<RunOutcome job={ended(17, 3, ["model-refused", "model-empty", "model-refused"])} fromSet={false} photos={[photo("p1")]} />);
    expect(failedLine()).toBe(`Не получилось: 3. Из них 2 — ${lower(REFUSED)} Из них 1 — ${lower(EMPTY)}`);
  });

  test("50#empty: one `model-empty` → the contract's text, which says the attempt is in the spend; never «бесплатно»", () => {
    render(<RunOutcome job={ended(19, 1, ["model-empty"])} fromSet={false} photos={[photo("p1")]} />);
    expect(failedLine()).toBe(`Не получилось: 1. ${EMPTY}`);
    expect(EMPTY).toBe("Модель вернула пустой ответ на кадр «Смелой»; попытка учтена в расходах.");
    expect(failedLine().includes("бесплатн")).toBe(false);
  });

  test("a free frame and a refused one: both counted, no general sentence (every failed frame's text speaks of the money)", () => {
    render(<RunOutcome job={ended(18, 2, ["slot-text-problem", "model-refused"])} fromSet={false} photos={[photo("p1")]} />);
    expect(failedLine()).toBe(`Не получилось: 2. Из них 1 — текст сцены не прошёл проверку слов: кадр пропущен, бесплатно. Из них 1 — ${lower(REFUSED)}`);
  });

  test("the reason gets its own line under the gallery's (mockup 50)", () => {
    render(<RunOutcome job={ended(18, 2, ["model-refused", "model-refused"])} fromSet={false} photos={[photo("p1")]} />);
    const notice = document.querySelector(".notice-text");
    expect(notice?.firstChild?.textContent).toBe("В галерее 18\u00a0фото этого запуска.");
    expect(notice?.lastElementChild?.classList.contains("run-end-line")).toBe(true);
  });
});

// The window never sends a «Смелая» category without «Смелая» (PhotosBold, AutopilotBold), so the engine says this only when another window raced it (mockup
// 48#refused): the card's ErrorNotice shows `errorText`, which must be the contract's sentence.
describe("`bold-level-needed` is the contract's text, wherever it shows (§13.2, exact)", () => {
  const TEXT = "«Ночнушки и бельё» и «Пляж и бассейн» рисуются только с подачей «Смелая» — ничего не списано.";

  test("a refused run or compose says it as a scene reason", () => {
    expect(errorText({ code: "VALIDATION", sceneReason: "bold-level-needed" })).toBe(TEXT);
  });

  test("a refused launch says it as a launch reason", () => {
    expect(LAUNCH_REASONS_RU["bold-level-needed"]).toBe(TEXT);
    expect(errorText({ code: "VALIDATION", launchReason: "bold-level-needed" })).toBe(TEXT);
  });
});
