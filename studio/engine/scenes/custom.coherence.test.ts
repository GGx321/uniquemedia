import { describe, expect, test } from "bun:test";
import { captureOfShot, posesFor } from "../../shared/scenes/captures";
import { covers, customActivityAllowed } from "../../shared/scenes/custom";
import { templateSentence } from "../../shared/scenes/template";
import { sentenceProblems } from "./assembler";
import type { Pool } from "./pools";
import { OWNER_LIKE_POOL } from "./testing/ownerLikePool";
import { SWEEP_CUSTOM_POOL } from "./testing/lookRules";
import { readWriterScenes } from "./writer";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.2 (S5.6a, I5.23 for custom categories): today's stored custom pools render through the adapter, their captures derived from their stored decks
// (plan r1.2), and every slot the planner can draw from them passes the gates an LLM sentence passes (readWriterScenes) and the assembler's last gate.
// The fixtures stand in for the owner's library: the engine's shared custom pool (its youth word renamed, as the look sweeps use it) and the
// owner-like pool of real descriptions.

const REF = "cat-paris-cafes";
const POOLS: Array<[string, Pool]> = [
  ["the shared custom pool", SWEEP_CUSTOM_POOL],
  ["the owner-like pool", OWNER_LIKE_POOL],
];

describe.each(POOLS)("%s", (_name, pool) => {
  test("is covered: every activity reads after «she is»", () => {
    expect(covers(pool)).toBe(true);
  });

  test("every slot the planner can draw renders and passes the writer's reader and the assembler's last gate", () => {
    const problems: string[] = [];
    let checked = 0;
    for (const place of pool.locations) {
      for (const shot of new Set(pool.shotDeck)) {
        if (shot === "mirror" && place.mirror !== true) continue;
        const capture = captureOfShot(shot);
        for (const pose of posesFor(capture)) {
          for (const activity of place.activities.filter((a) => customActivityAllowed(a, capture, pose))) {
            for (const outfit of pool.outfits) {
              const sentence = templateSentence({ category: REF, location: place.name, activity: activity.text, outfit, shot, pose }, { key: `${place.name}:${shot}:${pose}`, snapshots: [{ ref: REF }] });
              checked++;
              if (sentence === null) {
                problems.push(`null: ${place.name} / ${activity.text} / ${shot} / ${pose}`);
                continue;
              }
              const answer = readWriterScenes([{ slotIndex: 1, sentence }], [{ slotIndex: 1, shot, pose }]);
              if (!answer.ok) problems.push(`${answer.problems.join(",")}: ${sentence}`);
              if (sentenceProblems(sentence).length > 0) problems.push(`last gate: ${sentence}`);
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
    expect(problems).toEqual([]);
  });
});
