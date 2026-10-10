import { describe, expect, test } from "bun:test";
import type { DescriptorCheck } from "../../../shared/engine";
import type { JobView } from "../../engine/store";
import { aspectRows, avatarHeld, lastLine, mismatchTitle, proposalReason, runDrawing, textMismatch, whenLabel, wordDiff, type DiffPart } from "./lookModel";

// S5.0d: the words of the «Внешность» tab, apart from the components: the verdict, the aspect rows, the proposal as an edit, «последняя: …», and
// whether the avatar is held by work the paid check would be refused for.

const TEXT = "24-year-old European woman with fair skin and grey-blue eyes, shoulder-length wavy blonde hair, a small mole on the cheek";

function check(patch: Partial<DescriptorCheck> = {}): DescriptorCheck {
  return { matches: true, aspects: { hair: { state: "ok" }, eyes: { state: "ok" }, marks: { state: "ok" }, body: { state: "not-visible" } }, proposal: null, checkedText: TEXT, ...patch };
}

const hairMismatch = check({
  matches: false,
  aspects: { hair: { state: "mismatch", descriptor: "волнистые блонд", photo: "прямые платиновые с чёлкой" }, eyes: { state: "ok" }, marks: { state: "ok" }, body: { state: "not-visible" } },
});

/** The diff written as the screen reads it: [-struck-] and {+inserted+}. */
function written(parts: readonly DiffPart[]): string {
  return parts.map((p) => (p.kind === "same" ? p.text : p.kind === "del" ? `[-${p.text}-]` : `{+${p.text}+}`)).join("");
}

describe("the aspect rows", () => {
  test("while the check runs every aspect waits, and the body only «если в кадре»", () => {
    expect(aspectRows(null).map((r) => [r.label, r.mark, r.note])).toEqual([
      ["Волосы", "wait", null],
      ["Глаза", "wait", null],
      ["Приметы", "wait", null],
      ["Тело", "wait", "если в кадре"],
    ]);
  });

  test("a matching check: three ticks, and a body the photo does not show is grey, not an error", () => {
    expect(aspectRows(check()).map((r) => [r.label, r.mark, r.note])).toEqual([
      ["Волосы", "ok", null],
      ["Глаза", "ok", null],
      ["Приметы", "ok", null],
      ["Тело", "skip", "на фото не видно"],
    ]);
  });

  test("a mismatch carries the check's own words for «В описании» and «На фото»", () => {
    const hair = aspectRows(hairMismatch)[0];
    expect([hair?.mark, hair?.said, hair?.seen, hair?.spoken]).toEqual(["bad", "волнистые блонд", "прямые платиновые с чёлкой", "не совпадает"]);
  });

  test("an aspect the answer left out was not checked", () => {
    const rows = aspectRows(check({ aspects: { hair: { state: "ok" }, eyes: { state: "ok" } } }));
    expect(rows.map((r) => [r.label, r.mark, r.note])).toEqual([
      ["Волосы", "ok", null],
      ["Глаза", "ok", null],
      ["Приметы", "skip", "не проверено"],
      ["Тело", "skip", "не проверено"],
    ]);
  });
});

describe("the verdict", () => {
  test("names every contradicted aspect, in the card's order", () => {
    expect(mismatchTitle(hairMismatch)).toBe("Не совпадает: волосы");
    const two = check({ matches: false, aspects: { hair: { state: "mismatch" }, eyes: { state: "mismatch" }, marks: { state: "ok" }, body: { state: "mismatch" } } });
    expect(mismatchTitle(two)).toBe("Не совпадает: волосы, глаза, тело");
  });

  test("a body-only mismatch is not one the text can fix", () => {
    expect(textMismatch(hairMismatch)).toBe(true);
    expect(textMismatch(check({ matches: false, aspects: { hair: { state: "ok" }, eyes: { state: "ok" }, marks: { state: "ok" }, body: { state: "mismatch" } } }))).toBe(false);
  });

  test("the proposal's reason quotes what the check sees on the photo", () => {
    expect(proposalReason(hairMismatch)).toBe("Сверка видит на фото: волосы — прямые платиновые с чёлкой.");
    const bare = check({ matches: false, aspects: { hair: { state: "ok" }, eyes: { state: "mismatch" }, marks: { state: "ok" } } });
    expect(proposalReason(bare)).toBe("Сверка нашла расхождение: глаза.");
  });
});

describe("when and «последняя»", () => {
  const now = new Date(2026, 9, 10, 18, 0);
  const at = new Date(2026, 9, 10, 14, 22);

  test("a check on the tab says the time today; one at creation or import says so", () => {
    expect(whenLabel("page", at, now)).toBe("сегодня, 14:22");
    expect(whenLabel("create", at, now)).toBe("при сохранении");
    expect(whenLabel("import", at, now)).toBe("при импорте");
  });

  test("a check of an earlier day says its date", () => {
    expect(whenLabel("page", new Date(2026, 9, 8, 9, 5), now)).toMatch(/^8 окт\.?, 09:05$/);
  });

  test("«последняя»: none yet, a time and a verdict, or where it ran", () => {
    expect(lastLine(null, now)).toBe("последняя: ещё не было");
    expect(lastLine({ at, context: "page", matches: true }, now)).toBe("последняя: 14:22 · совпадало");
    expect(lastLine({ at, context: "create", matches: false }, now)).toBe("последняя: при сохранении · не совпадало");
  });
});

describe("the proposal as an edit", () => {
  test("a changed phrase is one strike and one insert, the rest kept", () => {
    const proposal = "24-year-old European woman with fair skin and grey-blue eyes, shoulder-length straight platinum-white hair with choppy layers and bangs, a small mole on the cheek";
    expect(written(wordDiff(TEXT, proposal))).toBe(
      "24-year-old European woman with fair skin and grey-blue eyes, shoulder-length [-wavy blonde-]{+straight platinum-white+} hair{+ with choppy layers and bangs+}, a small mole on the cheek",
    );
  });

  test("one word changed: one strike, one insert", () => {
    expect(written(wordDiff("26-year-old woman, brown eyes, long hair", "26-year-old woman, green eyes, long hair"))).toBe("26-year-old woman, [-brown-]{+green+} eyes, long hair");
  });

  test("the kept and inserted parts put together are the proposal, and the kept and struck ones the old text", () => {
    const before = "25-year-old woman, light skin, hazel eyes, freckles";
    const after = "25-year-old woman, light olive skin, green eyes";
    const parts = wordDiff(before, after);
    expect(parts.filter((p) => p.kind !== "del").map((p) => p.text).join("")).toBe(after);
    expect(parts.filter((p) => p.kind !== "ins").map((p) => p.text).join("")).toBe(before);
  });

  test("the same text is one kept run", () => {
    expect(wordDiff(TEXT, TEXT)).toEqual([{ kind: "same", text: TEXT }]);
  });
});

describe("whether the avatar is held", () => {
  const job = (patch: Partial<JobView>): JobView => ({
    jobId: "job-1",
    kind: "run",
    avatarId: "a1",
    runId: "run-1",
    montageId: null,
    videoId: null,
    status: "running",
    saving: false,
    done: 0,
    total: 4,
    result: null,
    error: null,
    ...patch,
  });

  test("a running or queued photo run or candidates batch of hers holds her; one that ended, a render, or another avatar's does not", () => {
    const view = (jobs: JobView[], inFlight: string[] = []) => ({ jobs, paidInFlightAvatars: new Set(inFlight) });
    expect(avatarHeld(view([job({})]), "a1")).toBe(true);
    expect(avatarHeld(view([job({ status: "queued" })]), "a1")).toBe(true);
    expect(avatarHeld(view([job({ kind: "avatar.candidates" })]), "a1")).toBe(true);
    expect(avatarHeld(view([job({ status: "done" })]), "a1")).toBe(false);
    expect(avatarHeld(view([job({ kind: "render" })]), "a1")).toBe(false);
    expect(avatarHeld(view([job({ avatarId: "a2" })]), "a1")).toBe(false);
    expect(avatarHeld(view([], ["a1"]), "a1")).toBe(true);
  });

  test("a photo run drawing now is told apart (an edit is allowed during it)", () => {
    expect(runDrawing({ jobs: [job({})] }, "a1")).toBe(true);
    expect(runDrawing({ jobs: [job({ kind: "avatar.candidates" })] }, "a1")).toBe(false);
  });
});
