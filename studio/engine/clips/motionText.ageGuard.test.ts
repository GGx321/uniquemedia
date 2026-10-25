import { describe, expect, test } from "bun:test";
import { AGE_PROBES } from "../../shared/scenes/ageProbes.testkit";
import { AGE_GUARD_RULES, motionTextFindings, motionTextProblems, ownIdeaNamesAge, repairMayHelp } from "../../shared/scenes/motionText";
import { boldMirrorFrame, timerFrame } from "./testing/motionKit";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.2, S5.FU-AGE: the gaps the review found in the kept minor-age guard, closed on the one motion check and on the free pre-check of the owner's words. The
// probes are shared (scenes/ageProbes.testkit.ts) with the vision writer's, the translator's, the engine's and the mock's tests, so every route reads the same phrases.

const FRAMES = [
  ["ordinary", timerFrame()],
  ["«Смелая»", boldMirrorFrame()],
] as const;
const MODEL_SOURCES = ["vision", "own"] as const;

const ageRulesOf = (text: string, frame: (typeof FRAMES)[number][1], source: (typeof MODEL_SOURCES)[number]): string[] => [
  ...new Set(motionTextFindings(text, frame, source).filter((finding) => AGE_GUARD_RULES.includes(finding.rule)).map((finding) => finding.rule)),
];

describe.each(AGE_PROBES.map((probes) => [probes.name, probes] as const))("the kept minor-age guard, %s (S5.FU-AGE)", (_name, probes) => {
  test("each English probe is refused `content` by a rule of the age guard, on an ordinary frame and on «Смелая», for vision and own", () => {
    for (const text of probes.english) {
      for (const [where, frame] of FRAMES) {
        for (const source of MODEL_SOURCES) {
          expect([text, where, source, motionTextProblems(text, frame, source), ageRulesOf(text, frame, source).length > 0]).toEqual([text, where, source, ["content"], true]);
        }
      }
    }
  });

  test("its refusal is final: no repair may take the age out, on any frame", () => {
    for (const text of probes.english) for (const [where, frame] of FRAMES) for (const source of MODEL_SOURCES) expect([text, where, source, repairMayHelp(text, frame, source)]).toEqual([text, where, source, false]);
  });

  test("each idea in his own words is refused by the free pre-check, before any paid call, on every frame", () => {
    for (const idea of probes.ideas) for (const [where, frame] of FRAMES) expect([idea, where, ownIdeaNamesAge(idea, frame.level)]).toEqual([idea, where, true]);
  });

  test("the English probes said as his idea are refused by the pre-check too", () => {
    for (const idea of probes.english) for (const [where, frame] of FRAMES) expect([idea, where, ownIdeaNamesAge(idea, frame.level)]).toEqual([idea, where, true]);
  });

  test("no rule of the age guard reads a text that names no age, on any frame or model source", () => {
    for (const text of probes.passes) for (const [where, frame] of FRAMES) for (const source of MODEL_SOURCES) expect([text, where, source, ageRulesOf(text, frame, source)]).toEqual([text, where, source, []]);
  });

  test("the pre-check reads none of his words that name no age, nor the English passes", () => {
    for (const idea of [...probes.ideaPasses, ...probes.passes]) for (const [where, frame] of FRAMES) expect([idea, where, ownIdeaNamesAge(idea, frame.level)]).toEqual([idea, where, false]);
  });
});
