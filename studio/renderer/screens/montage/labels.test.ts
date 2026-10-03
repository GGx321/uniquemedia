import { describe, expect, test } from "bun:test";
import type { Montage } from "../../../shared/engine";
import { NBSP } from "../../lib/format";
import { clockLabel, draftMeta, draftName, draftTitle, outputLabel, outputParts, renderButtonLabel, saveLabel, whenLabel } from "./labels";
import { draftSpec, montageOf, photoClip } from "./testkit";

// The words the drafts screen and the editor header show (EditorEmpty, Editor, EditorNew artboards).

/** A number bound to its unit by a no-break space, as the rest of Studio writes it ("25 лет", "20 МБ"); separators stay breakable. */
const nb = (s: string): string => s.replace(/(\d) (?=[^\d\s·])/g, `$1${NBSP}`).replace(/≈ /g, `≈${NBSP}`);

describe("names", () => {
  test("a named draft is quoted after its avatar; an unnamed one is «без названия» (K1)", () => {
    expect(draftTitle("Mia", "кафе и город")).toBe("Mia · «кафе и город»");
    expect(draftTitle("Elena", null)).toBe("Elena · без названия");
    expect(draftName(null)).toBe("без названия");
    expect(draftName("утро дома")).toBe("утро дома");
  });

  test("a draft whose avatar is not listed shows its own name alone", () => {
    expect(draftTitle(null, "кафе и город")).toBe("«кафе и город»");
    expect(draftTitle(null, null)).toBe("Без названия");
  });
});

describe("the summary line of a draft card", () => {
  test("length, clips and texts, as the artboard counts them", () => {
    const spec = draftSpec([photoClip(0, "photo-mia-0001", 2_400), photoClip(1, "photo-mia-0002", 3_200), photoClip(2, "photo-mia-0003", 2_000), photoClip(3, "photo-mia-0004", 2_000)], {
      layers: [1, 2, 3].map((n) => ({ layerId: `layer-00${n}`, kind: "text" as const, startMs: 0, endMs: 1_000, value: "hi", font: "manrope" as const, style: "plaque" as const, color: "#ffffff", x: 0.5, y: 0.5, scale: 1 })),
    });
    expect(draftMeta(spec)).toBe(nb("9.6 с · 4 кадра · 3 текста"));
  });

  test("one text, no text, and no clips at all", () => {
    const one = draftSpec(3, { layers: [{ layerId: "layer-001", kind: "text", startMs: 0, endMs: 1_000, value: "hi", font: "manrope", style: "plaque", color: "#ffffff", x: 0.5, y: 0.5, scale: 1 }] });
    expect(draftMeta(one)).toBe(nb("6.0 с · 3 кадра · 1 текст"));
    expect(draftMeta(draftSpec(1))).toBe(nb("2.0 с · 1 кадр · без текста"));
    expect(draftMeta(draftSpec(5))).toBe(nb("10.0 с · 5 кадров · без текста"));
    expect(draftMeta(draftSpec(0))).toBe("нет кадров");
  });
});

describe("the output line of the editor header", () => {
  test("frame, rate, length and the expected size from estimateBytes (9.6 s → ≈ 4.2 МБ)", () => {
    const spec = draftSpec([photoClip(0, "photo-mia-0001", 4_800), photoClip(1, "photo-mia-0002", 4_800)]);
    expect(outputLabel(spec)).toBe(nb("1080×1920 · 30 fps · 9.6 с · ≈ 4.2 МБ"));
  });

  test("an empty draft has no size, only its zero length", () => {
    expect(outputLabel(draftSpec(0))).toBe(nb("1080×1920 · 30 fps · 0 с"));
  });

  test("its two parts: the format, the same for every draft (the first to go in a narrow window), and the draft's own length and size", () => {
    const spec = draftSpec([photoClip(0, "photo-mia-0001", 4_800), photoClip(1, "photo-mia-0002", 4_800)]);
    expect(outputParts(spec)).toEqual({ format: nb("1080×1920 · 30 fps"), length: nb("9.6 с · ≈ 4.2 МБ") });
    expect(outputParts(draftSpec(0))).toEqual({ format: nb("1080×1920 · 30 fps"), length: nb("0 с") });
  });
});

describe("times", () => {
  const now = new Date("2026-09-30T18:00:00.000Z");

  test("today, yesterday, this year and another year", () => {
    expect(whenLabel("2026-09-30T14:02:00.000Z", now, "UTC")).toBe("сегодня, 14:02");
    expect(whenLabel("2026-09-29T21:40:00.000Z", now, "UTC")).toBe("вчера, 21:40");
    expect(whenLabel("2026-09-26T09:15:00.000Z", now, "UTC")).toBe(nb("26 сент., 09:15"));
    expect(whenLabel("2025-12-31T23:59:00.000Z", now, "UTC")).toBe(nb("31 дек. 2025, 23:59"));
  });

  test("midnight is 00:05, never 24:05", () => {
    expect(whenLabel("2026-09-30T00:05:00.000Z", now, "UTC")).toBe("сегодня, 00:05");
  });

  test("«today» follows the owner's clock, not UTC", () => {
    // 23:30 UTC on the 29th is already the 30th in Moscow (UTC+3).
    expect(whenLabel("2026-09-29T23:30:00.000Z", now, "Europe/Moscow")).toBe("сегодня, 02:30");
  });

  test("the timeline clock: minutes, seconds and tenths", () => {
    expect(clockLabel(0)).toBe("00:00.0");
    expect(clockLabel(4_100)).toBe("00:04.1");
    expect(clockLabel(9_600)).toBe("00:09.6");
    expect(clockLabel(75_000)).toBe("01:15.0");
  });
});

describe("the save state under the draft's name", () => {
  const saved: Montage = montageOf(draftSpec(1), null, "2026-09-30T14:02:00.000Z");

  test("saved, with the time of the engine's last answer", () => {
    expect(saveLabel({ kind: "saved" }, saved, { fresh: false, timeZone: "UTC" })).toBe("черновик · сохранён 14:02");
  });

  test("just created and not edited since", () => {
    expect(saveLabel({ kind: "saved" }, saved, { fresh: true, timeZone: "UTC" })).toBe("черновик · создан только что");
  });

  test("an edit on its way", () => {
    expect(saveLabel({ kind: "pending" }, saved, { fresh: false, timeZone: "UTC" })).toBe("черновик · сохраняется…");
    expect(saveLabel({ kind: "saving" }, saved, { fresh: true, timeZone: "UTC" })).toBe("черновик · сохраняется…");
  });

  test("a refused save and a deleted draft", () => {
    expect(saveLabel({ kind: "failed", error: { code: "INTERNAL" } }, saved, { fresh: false, timeZone: "UTC" })).toBe("черновик · не сохранён");
    expect(saveLabel({ kind: "gone" }, saved, { fresh: false, timeZone: "UTC" })).toBe("черновик удалён");
  });
});

// 3d.6: the words on the render button while a render is on its way.
describe("renderButtonLabel", () => {
  test("submitting, queued (with how many renders are ahead), running (floor percent), saving", () => {
    expect(renderButtonLabel({ kind: "submitting" })).toBe("Рендер…");
    expect(renderButtonLabel({ kind: "queued", after: 0, cancelling: false })).toBe("В очереди");
    expect(renderButtonLabel({ kind: "queued", after: 2, cancelling: false })).toBe("В очереди · после 2");
    expect(renderButtonLabel({ kind: "running", percent: 42, cancelling: false })).toBe(`Рендер · 42${NBSP}%`);
    expect(renderButtonLabel({ kind: "running", percent: 0, cancelling: false })).toBe(`Рендер · 0${NBSP}%`);
    expect(renderButtonLabel({ kind: "running", percent: 100, cancelling: false })).toBe(`Рендер · 100${NBSP}%`);
    expect(renderButtonLabel({ kind: "saving" })).toBe("Сохранение…");
  });

  test("a cancel that is out says so instead of the progress", () => {
    expect(renderButtonLabel({ kind: "running", percent: 42, cancelling: true })).toBe("Отменяем…");
    expect(renderButtonLabel({ kind: "queued", after: 1, cancelling: true })).toBe("Отменяем…");
  });
});
