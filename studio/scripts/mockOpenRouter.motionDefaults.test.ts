import { describe, expect, test } from "bun:test";
import { CODE_MOTIONS } from "../engine/clips/motion";
import { frameFactsOf } from "../engine/clips/frameFacts";
import { clipMotionProblems } from "../engine/clips/prompt";
import { everyMoment, photoOf, sceneRun, slotOf } from "../engine/clips/testing/frameFixtures";
import { sameText } from "../shared/engine/motionKnown";
import { posesFor } from "../shared/scenes/captures";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { DEFAULT_MOTION_SUGGESTIONS, DEFAULT_MOTION_TRANSLATION } from "./mockOpenRouter";
useNativeGlobals();

// Stage 5, 5b.2: the mock's default motions must never collide with a motion the frame already offers. The engine drops a suggestion whose text equals a code or scene motion (shared/engine/motionKnown.ts), so a default
// that equals one makes `clips.suggestMotions` answer fewer than three (the packaged smoke's v-1..v-3). This pins every default against the code motions, every bank scene motion and each other, and holds the suggestions
// to the engine's motion check as `vision` on every home frame.

const DEFAULTS = [...DEFAULT_MOTION_SUGGESTIONS, DEFAULT_MOTION_TRANSLATION].map(sameText);
const SCENE_TEXTS = new Set(everyMoment().map((picked) => sameText(picked.moment.motion)));

describe("the mock's default motions", () => {
  test("none equals a code motion, a bank scene motion or another default", () => {
    const known = new Set([...CODE_MOTIONS.map((m) => sameText(m.text)), ...SCENE_TEXTS]);
    expect(DEFAULTS.filter((text) => known.has(text))).toEqual([]);
    expect(new Set(DEFAULTS).size).toBe(DEFAULTS.length);
  });

  test("the suggestions pass the motion check as vision on every home moment and capture", () => {
    let frames = 0;
    const problems: string[] = [];
    for (const picked of everyMoment().filter((p) => p.category === "home")) {
      for (const capture of picked.moment.captures) {
        const run = sceneRun("run-00000601", [slotOf(picked, capture, posesFor(capture)[0] ?? "front")]);
        const result = frameFactsOf(photoOf(run, run.scenes.slots[0] ?? (() => { throw new Error("no slot"); })()), run);
        if (result.kind !== "gallery") throw new Error(`expected a gallery photo, got ${result.kind}`);
        frames++;
        for (const text of DEFAULT_MOTION_SUGGESTIONS) {
          const found = clipMotionProblems(result.facts, text, "vision");
          if (found.length > 0) problems.push(`${capture}: ${text}: ${found.join(",")}`);
        }
      }
    }
    expect(frames).toBeGreaterThan(70);
    expect(problems).toEqual([]);
  });
});
