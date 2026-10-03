import { describe, expect, test } from "bun:test";
import { MontageDraft } from "../../../shared/engine";
import { parseSeconds, setLayerTime, timeRefusalLabel } from "./timeInput";
import { draftSpec, textLayer } from "./testkit";

// 3d.5: «Время 0.3 — 4.4 с» (R32, R37): a text's or a sticker's start and end typed in seconds. Each is the timeline's own trim
// (`trimLayer`: the 100 ms grid, at least 0.3 s, never further past the montage's end), so the field and a handle drag agree.

/** Four 2 s clips (8.0 s) with a text over 1.0–4.0 s. */
const SPEC = draftSpec(4, { layers: [textLayer(0, 1_000, 4_000)] });
const range = (spec: MontageDraft): [number, number] => [spec.layers[0]?.startMs ?? -1, spec.layers[0]?.endMs ?? -1];

describe("reading typed seconds", () => {
  test("a dot or a comma, spaces around, whole seconds; to the nearest 100 ms", () => {
    expect(parseSeconds("4.4")).toBe(4_400);
    expect(parseSeconds(" 4,4 ")).toBe(4_400);
    expect(parseSeconds("4")).toBe(4_000);
    expect(parseSeconds("0")).toBe(0);
    expect(parseSeconds("4.44")).toBe(4_400);
    expect(parseSeconds("4.46")).toBe(4_500);
  });

  test("anything else is no time at all", () => {
    for (const text of ["", " ", "abc", "-1", "4..4", "4.4.4", "1e3", "Infinity", "4 с"]) expect(parseSeconds(text)).toBe(null);
  });
});

describe("a typed start or end", () => {
  test("moves that edge on the 100 ms grid, the other one kept", () => {
    const start = setLayerTime(SPEC, 0, "start", "0.3");
    expect(start.ok && range(start.spec)).toEqual([300, 4_000]);
    const end = setLayerTime(SPEC, 0, "end", "4,4");
    expect(end.ok && range(end.spec)).toEqual([1_000, 4_400]);
    if (end.ok) expect(MontageDraft.safeParse(end.spec).success).toBe(true);
  });

  test("the same time is the same draft", () => {
    const same = setLayerTime(SPEC, 0, "end", "4.0");
    expect(same.ok && same.spec).toBe(SPEC);
  });

  test("0.3 s is the shortest a layer may be; a hundred ms less is refused", () => {
    const shortest = setLayerTime(SPEC, 0, "end", "1.3");
    expect(shortest.ok && range(shortest.spec)).toEqual([1_000, 1_300]);
    expect(setLayerTime(SPEC, 0, "end", "1.2")).toEqual({ ok: false, reason: "too-short" });
  });

  test("an end at the montage's end is taken; past it is refused", () => {
    const atEnd = setLayerTime(SPEC, 0, "end", "8");
    expect(atEnd.ok && range(atEnd.spec)).toEqual([1_000, 8_000]);
    expect(setLayerTime(SPEC, 0, "end", "8.1")).toEqual({ ok: false, reason: "outside-montage" });
  });

  test("no time at all is refused, and nothing changes", () => {
    expect(setLayerTime(SPEC, 0, "start", "soon")).toEqual({ ok: false, reason: "not-a-number" });
  });

  test("each refusal says what to do, in seconds as the timeline writes them (a no-break space before «с»)", () => {
    const plain = (text: string): string => text.replace(/ /g, " ");
    expect(plain(timeRefusalLabel("not-a-number", 8_000))).toBe("Введите секунды, например 4.4");
    expect(plain(timeRefusalLabel("too-short", 8_000))).toBe("Слой не может быть короче 0.3 с");
    expect(plain(timeRefusalLabel("outside-montage", 8_000))).toBe("Слой должен закончиться до конца ролика, 8.0 с");
  });
});
