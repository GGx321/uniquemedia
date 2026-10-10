import { describe, expect, test } from "bun:test";
import { checkDescriptorEdit, normaliseDescriptorText } from "./descriptorEdit";

// The owner's hand-typed descriptor, judged by the same rules the prompt-time contract applies (AvatarDescriptor), with one closed reason per way it can fail.

const GOOD = "25-year-old European woman, hazel eyes, shoulder-length wavy chestnut hair, athletic build";

describe("checkDescriptorEdit", () => {
  test("accepts a text that states the age and breaks no rule, returning it normalised", () => {
    expect(checkDescriptorEdit(`  ${GOOD}  `, 25)).toEqual({ ok: true, text: GOOD });
  });

  test("folds typography before judging it (curly quotes and en dashes become plain ones)", () => {
    expect(checkDescriptorEdit("25–year–old woman, “warm” smile", 25)).toEqual({ ok: true, text: '25-year-old woman, "warm" smile' });
  });

  test.each(["", "   ", "\n\t "])("refuses the blank text %j as empty", (text) => {
    expect(checkDescriptorEdit(text, 25)).toEqual({ ok: false, reason: "empty", words: [] });
  });

  test.each(["25-year-old woman\u200B", "25-year-old woman ", "25-year-old﻿ woman"])("refuses invisible characters in %j", (text) => {
    expect(checkDescriptorEdit(text, 25)).toEqual({ ok: false, reason: "hidden-chars", words: [] });
  });

  test("accepts a newline, which is only whitespace and folds to a space", () => {
    expect(checkDescriptorEdit("25-year-old woman,\nhazel eyes", 25)).toEqual({ ok: true, text: "25-year-old woman, hazel eyes" });
  });

  test("refuses a text without the age anchor", () => {
    expect(checkDescriptorEdit("European woman, hazel eyes", 25)).toEqual({ ok: false, reason: "no-anchor", words: [] });
  });

  test("refuses an anchor with a different age than the avatar's", () => {
    expect(checkDescriptorEdit("26-year-old European woman", 25)).toMatchObject({ ok: false, reason: "no-anchor" });
  });

  test("accepts the anchor anywhere in the text, not only at the start", () => {
    expect(checkDescriptorEdit("European woman, a 25-year-old with hazel eyes", 25)).toMatchObject({ ok: true });
  });

  test("accepts exactly 600 characters", () => {
    const base = `${GOOD}, `;
    const exactly = base + "x".repeat(600 - base.length);
    expect(exactly).toHaveLength(600);
    expect(checkDescriptorEdit(exactly, 25)).toMatchObject({ ok: true });
  });

  test("refuses 601 characters as too-long", () => {
    const base = `${GOOD}, `;
    const over = base + "x".repeat(601 - base.length);
    expect(over).toHaveLength(601);
    expect(checkDescriptorEdit(over, 25)).toEqual({ ok: false, reason: "too-long", words: [] });
  });

  test("refuses Cyrillic as script", () => {
    expect(checkDescriptorEdit("25-year-old \u0436\u0435\u043D\u0449\u0438\u043D\u0430, hazel eyes", 25)).toEqual({ ok: false, reason: "script", words: [] });
  });

  test("refuses Arabic-Indic digits as non-ascii-digits", () => {
    expect(checkDescriptorEdit("25-year-old woman with \u0663 freckles", 25)).toMatchObject({ ok: false, reason: "non-ascii-digits" });
  });

  test("refuses another age in the text as other-age", () => {
    expect(checkDescriptorEdit("25-year-old woman who looks 19 years old", 25)).toEqual({ ok: false, reason: "other-age", words: [] });
  });

  test("refuses an age ceiling of 21 or less as under-21-bound", () => {
    expect(checkDescriptorEdit("25-year-old woman, under 21", 25)).toMatchObject({ ok: false, reason: "under-21-bound" });
  });

  test("refuses a youth word and names it", () => {
    const result = checkDescriptorEdit("25-year-old petite woman, hazel eyes", 25);
    expect(result).toMatchObject({ ok: false, reason: "youth-word" });
    expect(result.ok ? [] : result.words).toEqual(["petite"]);
  });

  test("refuses a stray number beside the anchor as number", () => {
    expect(checkDescriptorEdit("25-year-old woman with 3 moles", 25)).toEqual({ ok: false, reason: "number", words: [] });
  });

  test("reports the anchor first when the text breaks several rules", () => {
    expect(checkDescriptorEdit("a petite woman", 25)).toMatchObject({ ok: false, reason: "no-anchor" });
  });
});

describe("normaliseDescriptorText", () => {
  test("folds fullwidth digits and strips accents", () => {
    expect(normaliseDescriptorText("２５-year-old café")).toBe("25-year-old cafe");
  });
});
