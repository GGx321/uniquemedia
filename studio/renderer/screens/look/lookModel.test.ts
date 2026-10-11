import { describe, expect, test } from "bun:test";
import type { DescriptorCheck } from "../../../shared/engine";
import type { JobView } from "../../engine/store";
import type { LookLanding } from "../../navigation";
import { aspectRows, avatarHeld, landingText, lastLine, mismatchTitle, proposalReason, runDrawing, textMismatch, whenLabel, wordDiff, type DiffPart } from "./lookModel";

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
  test("a changed phrase is one strike and one insert, the rest kept (the mockup's 10)", () => {
    const proposal = "24-year-old European woman with fair skin and grey-blue eyes, shoulder-length straight platinum-white hair with choppy layers and bangs, a small mole on the cheek";
    expect(written(wordDiff(TEXT, proposal))).toBe(
      "24-year-old European woman with fair skin and grey-blue eyes, shoulder-length [-wavy blonde hair-]{+straight platinum-white hair with choppy layers and bangs+}, a small mole on the cheek",
    );
  });

  test("one kept word between two changes joins them; a kept phrase or a comma does not", () => {
    expect(written(wordDiff("a red big hat on", "a blue big cap on"))).toBe("a [-red big hat-]{+blue big cap+} on");
    expect(written(wordDiff("a red big wide hat on", "a blue big wide cap on"))).toBe("a [-red-]{+blue+} big wide [-hat-]{+cap+} on");
    expect(written(wordDiff("brown eyes, long hair", "green eyes, short hair"))).toBe("[-brown-]{+green+} eyes, [-long-]{+short+} hair");
  });

  test("no strike or insert starts or ends with a space the two texts share", () => {
    const cases: [string, string][] = [
      ["24-year-old woman, wavy blonde hair, a mole", "24-year-old woman, straight platinum hair with bangs, a mole"],
      ["25-year-old woman with hazel eyes and freckles", "25-year-old woman with green eyes and light freckles"],
      ["a b c d e", "a x c y e"],
      ["one two three", "uno dos three"],
    ];
    for (const [before, after] of cases) {
      const parts = wordDiff(before, after);
      for (let i = 0; i < parts.length - 1; i++) {
        const [left, right] = [parts[i], parts[i + 1]];
        // A strike followed by its insert: both end, or both start, with the same space only if it could have been kept.
        if (left?.kind === "del" && right?.kind === "ins") {
          expect(/\s$/.test(left.text) && /\s$/.test(right.text)).toBe(false);
          expect(/^\s/.test(left.text) && /^\s/.test(right.text)).toBe(false);
        }
      }
      expect(parts.filter((p) => p.kind !== "del").map((p) => p.text).join("")).toBe(after);
      expect(parts.filter((p) => p.kind !== "ins").map((p) => p.text).join("")).toBe(before);
    }
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

  test("a scenes job of hers holds her too (the engine claims the avatar for it), while it runs and only then", () => {
    const view = (jobs: JobView[]) => ({ jobs, paidInFlightAvatars: new Set<string>() });
    expect(avatarHeld(view([job({ kind: "scenes", runId: null })]), "a1")).toBe(true);
    expect(avatarHeld(view([job({ kind: "scenes", runId: null, status: "done" })]), "a1")).toBe(false);
    expect(avatarHeld(view([job({ kind: "scenes", runId: null, avatarId: "a2" })]), "a1")).toBe(false);
  });

  test("S5.3d: a reference-portrait batch of hers holds her too, while it runs and only then", () => {
    const view = (jobs: JobView[]) => ({ jobs, paidInFlightAvatars: new Set<string>() });
    expect(avatarHeld(view([job({ kind: "avatar.portraits", runId: null })]), "a1")).toBe(true);
    expect(avatarHeld(view([job({ kind: "avatar.portraits", runId: null, status: "queued" })]), "a1")).toBe(true);
    expect(avatarHeld(view([job({ kind: "avatar.portraits", runId: null, status: "cancelled" })]), "a1")).toBe(false);
    expect(avatarHeld(view([job({ kind: "avatar.portraits", runId: null, avatarId: "a2" })]), "a1")).toBe(false);
    // The description and the body stay editable during the batch: it is not a photo run «drawing» either.
    expect(runDrawing({ jobs: [job({ kind: "avatar.portraits", runId: null })] }, "a1")).toBe(false);
  });

  test("a photo run drawing now is told apart (an edit is allowed during it)", () => {
    expect(runDrawing({ jobs: [job({})] }, "a1")).toBe(true);
    expect(runDrawing({ jobs: [job({ kind: "avatar.candidates" })] }, "a1")).toBe(false);
  });
});

describe("the line over the tab after the avatar was made (S5.2d: an import's body proposal still open)", () => {
  test("after «Сохранить»: the same line whatever the body", () => {
    expect(landingText({ kind: "created", checkWorstMicros: 25_000 }, "Mia", false)).toBe("Аватар «Mia» сохранён. Мастер-портрет готов для фото.");
    expect(landingText({ kind: "created", checkWorstMicros: null }, "Mia", true)).toBe("Аватар «Mia» сохранён. Мастер-портрет готов для фото.");
  });

  test("after «Импортировать»: the check's outcome, then what is left — the body while its proposal waits (05, 06)", () => {
    const imported = (c: DescriptorCheck | null): LookLanding => ({ kind: "imported", check: c, portraitsWorstMicros: null });
    expect(landingText(imported(null), "Lea", false)).toBe("Аватар «Lea» импортирован. Описание прочитано с фото.");
    expect(landingText(imported(null), "Lea", true)).toBe("Аватар «Lea» импортирован. Описание прочитано с фото — осталось тело.");
    expect(landingText(imported(check()), "Lea", false)).toBe("Аватар «Lea» импортирован. Описание прочитано с фото и сверено с ним.");
    expect(landingText(imported(check()), "Lea", true)).toBe("Аватар «Lea» импортирован. Описание прочитано с фото и сверено с ним — осталось тело.");
    expect(landingText(imported(hairMismatch), "Ava", false)).toBe("Аватар «Ava» импортирован. Описание прочитано с фото — проверьте сверку.");
    expect(landingText(imported(hairMismatch), "Ava", true)).toBe("Аватар «Ava» импортирован. Описание прочитано с фото — проверьте тело и сверку.");
  });

  test("S5.3d: the import's reference portraits after it — drawing (15), ready (16), or nothing to say (17, 18, 18b, 23)", () => {
    const landing: LookLanding = { kind: "imported", check: check(), portraitsWorstMicros: 300_000 };
    expect(landingText(landing, "Nini", true, "drawing")).toBe("Аватар «Nini» импортирован. Описание прочитано с фото и сверено с ним — осталось тело. Рисуем варианты мастер-портрета.");
    expect(landingText(landing, "Nini", false, "ready")).toBe("Аватар «Nini» импортирован. Описание прочитано с фото и сверено с ним. Варианты готовы — выберите мастер-портрет.");
    expect(landingText(landing, "Nini", false, null)).toBe("Аватар «Nini» импортирован. Описание прочитано с фото и сверено с ним.");
    // A wizard avatar has no portraits to speak of.
    expect(landingText({ kind: "created", checkWorstMicros: null }, "Mia", false, "drawing")).toBe("Аватар «Mia» сохранён. Мастер-портрет готов для фото.");
  });
});
