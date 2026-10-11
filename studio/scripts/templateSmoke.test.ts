import { describe, expect, test } from "bun:test";
import { ideaWriteProblems, templateComposeProblems } from "./templateSmoke";

// 5a.2 (S5.6e, plan s5a2 §5.7): the packaged-app smoke holds that the code template writes a built-in category's scenes with no writer request and no money, and that an idea write still reaches the
// writer. These are the rules its checks apply to the facts it reads off the mock OpenRouter and the ledger; the app itself is only run in CI.

const BEFORE = { writerRequests: 3, spentMicros: 41_000 };

describe("templateComposeProblems", () => {
  test("says nothing about a compose that sent no writer request, spent nothing and wrote every scene", () => {
    expect(templateComposeProblems(BEFORE, { ...BEFORE }, { wanted: 5, written: 5 })).toEqual([]);
  });

  test("names a writer request the compose sent", () => {
    expect(templateComposeProblems(BEFORE, { ...BEFORE, writerRequests: 4 }, { wanted: 5, written: 5 })).toEqual(["the compose sent 1 writer request, not none"]);
  });

  test("names money the compose spent, in whole micro-dollars", () => {
    expect(templateComposeProblems(BEFORE, { ...BEFORE, spentMicros: 41_458 }, { wanted: 5, written: 5 })).toEqual(["the compose spent 458 µ$, not nothing"]);
  });

  test("names scenes left unwritten", () => {
    expect(templateComposeProblems(BEFORE, { ...BEFORE }, { wanted: 5, written: 4 })).toEqual(["the compose wrote 4 of 5 scenes"]);
  });

  test("names every problem at once, in a fixed order", () => {
    expect(templateComposeProblems(BEFORE, { writerRequests: 5, spentMicros: 42_000 }, { wanted: 5, written: 0 })).toEqual([
      "the compose sent 2 writer requests, not none",
      "the compose spent 1000 µ$, not nothing",
      "the compose wrote 0 of 5 scenes",
    ]);
  });
});

describe("ideaWriteProblems", () => {
  test("says nothing about an idea write that was exactly one more writer request and was paid", () => {
    expect(ideaWriteProblems(BEFORE, { writerRequests: 4, spentMicros: 41_458 })).toEqual([]);
  });

  test("names an idea write the template answered itself: no request reached the writer", () => {
    expect(ideaWriteProblems(BEFORE, { ...BEFORE, spentMicros: 41_458 })).toEqual(["the idea write sent 0 writer requests, not one"]);
  });

  test("names more than one request", () => {
    expect(ideaWriteProblems(BEFORE, { writerRequests: 6, spentMicros: 41_458 })).toEqual(["the idea write sent 3 writer requests, not one"]);
  });

  test("names an idea write that cost nothing", () => {
    expect(ideaWriteProblems(BEFORE, { writerRequests: 4, spentMicros: 41_000 })).toEqual(["the idea write spent nothing"]);
  });
});
