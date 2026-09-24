import { expect, test } from "bun:test";
import { AvatarTraits } from "../../shared/engine";
import { DEFAULT_TRAITS } from "./traits";
import { vibeIssues } from "./vibe";

function contractAccepts(vibe: string, age = 25): boolean {
  return AvatarTraits.safeParse({ ...DEFAULT_TRAITS, age, vibe }).success;
}

test("ordinary vibes pass, «girl next door» included", () => {
  for (const vibe of ["girl next door", "girl next door, кофе, путешествия, книги", "it-girl energy", "youthful smile", ""]) {
    expect(vibeIssues(vibe, 25)).toEqual([]);
    expect(contractAccepts(vibe)).toBe(true);
  }
});

test("«schoolgirl» is refused with the word named", () => {
  const issues = vibeIssues("schoolgirl style, coffee", 25);
  expect(issues).toHaveLength(1);
  expect(issues[0]).toContain("«schoolgirl»");
  expect(issues[0]).toContain("от 21 года");
  expect(contractAccepts("schoolgirl style, coffee")).toBe(false);
});

test("Russian youth words are refused too", () => {
  expect(vibeIssues("школьница, книги", 25)[0]).toContain("«школьница»");
});

test("another age in the vibe points to the slider", () => {
  const issues = vibeIssues("17 years old, loves books", 25);
  expect(issues.some((i) => i.includes("другой возраст (17)") && i.includes("ползунком"))).toBe(true);
  expect(contractAccepts("17 years old, loves books")).toBe(false);
});

test("the avatar's own age is fine", () => {
  expect(vibeIssues("25 years old, runner", 25)).toEqual([]);
});

test("an under-21 bound is refused", () => {
  const issues = vibeIssues("looks younger than 20", 25);
  expect(issues.some((i) => i.includes("ограничение возраста (20)"))).toBe(true);
});

test("mixed scripts inside a word and non-ASCII digits are refused", () => {
  expect(vibeIssues("years оld", 25)).toContain("Пишите латиницей или кириллицей и не смешивайте алфавиты внутри одного слова.");
  expect(vibeIssues("coffee ٢", 25)).toContain("Используйте обычные цифры 0–9.");
});

test("length is capped at 200 with the current count", () => {
  expect(vibeIssues("a".repeat(200), 25)).toEqual([]);
  expect(vibeIssues("a".repeat(201), 25)).toEqual(["Не длиннее 200 символов — сейчас 201."]);
});

test("invisible characters are refused", () => {
  expect(vibeIssues("coffee​books", 25)).toContain("Уберите невидимые и управляющие символы.");
  expect(contractAccepts("coffee​books")).toBe(false);
});

test("whenever the UI finds no issue, the contract accepts the vibe", () => {
  const samples = ["teen", "barely legal", "sweet sixteen", "под 18", "ей 16", "just turned 18", "coffee", "books and travel"];
  for (const vibe of samples) {
    if (vibeIssues(vibe, 25).length === 0) expect(contractAccepts(vibe)).toBe(true);
    else expect(contractAccepts(vibe)).toBe(false);
  }
});
