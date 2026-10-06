import { describe, expect, test } from "bun:test";
import { CATEGORY_LABEL_MAX, POOL_TEXT_MAX, TIME_OF_DAY_MAX, type CategorySnapshot } from "../../shared/engine";
import { SceneSetFile, type StoredSceneSet } from "../library/sceneSets";
import { sampleSet } from "../library/testing/sceneSetSample";
import { WRITER_CALL } from "../money/estimate";
import { promptTokenFloor } from "../openrouter/chat";
import { runWriterConfig } from "../runs/plan";
import { WRITER_JSON_SCHEMA, type PlanSlot, type WriterRefusal } from "../scenes";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// CS.4a: THE WRITER PROMPT FLOOR PIN holds for every chunk a scene set can send. The set's request is a subset of one chunk of at most 25 scenes, built by the
// same `writerMessages` a run uses, and the set file holds every custom scene to the bounds a plan holds it to — so the worst chunk a set can carry is the worst
// chunk CS.1 pinned (scenes/writer.custom.test.ts): 25 custom slots at POOL_TEXT_MAX, a 24-char label, the worst refusal, at least 200 tokens under the ceiling.
// If the file accepted a longer text, the reserve of an attempt could exceed the worst case the owner accepted and the job's own cap would refuse it.

const CUSTOM = "cat-paris-cafes" as const;
const MARGIN = 200;
const CEILING = WRITER_CALL.inputTokens;

const snapshot: CategorySnapshot = { ref: CUSTOM, name: "я".repeat(40), label: "L".repeat(CATEGORY_LABEL_MAX), style: "editorial" };

/** A set of one full chunk of custom scenes, every text at `textLength`, built by hand so no draw can be luckier. */
function worstSet(textLength: number): Omit<StoredSceneSet, "schemaVersion" | "revision" | "createdAt" | "updatedAt"> {
  const base = sampleSet({ count: WRITER_CALL.slotsPerCall });
  return {
    ...base,
    request: { ...base.request, categories: [CUSTOM] },
    categories: [snapshot],
    scenes: base.scenes.map((scene, i) => ({
      ...scene,
      slot: {
        ...scene.slot,
        slotIndex: scene.sceneId,
        category: CUSTOM,
        location: "x".repeat(textLength),
        timeOfDay: "x".repeat(TIME_OF_DAY_MAX),
        activity: "x".repeat(textLength),
        outfit: "x".repeat(textLength),
        shot: "photographer" as const,
        pose: "three-quarter" as const,
        attemptIdBase: `slot-${i + 1}`,
      },
    })),
  };
}

const stamped = (set: ReturnType<typeof worstSet>) => ({ schemaVersion: 1, revision: 1, createdAt: "2026-10-07T10:00:00.000Z", updatedAt: "2026-10-07T10:00:00.000Z", ...set });

/** 160 distinct words of exactly 16 bytes each, of the four widest kinds: far more than the feedback will tell, which clips them. */
const hostileWords = Array.from({ length: 40 }, (_, i) => {
  const n = String(i).padStart(4, "0");
  return [`${"W".repeat(12)}${n}`, `${"Я".repeat(6)}${n}`, `${"😀".repeat(3)}${n}`, `${"é".repeat(6)}${n}`];
}).flat();

function worstRefusal(slots: readonly PlanSlot[]): WriterRefusal {
  const indices = slots.map((s) => s.slotIndex);
  const rest = indices.slice(0, -1);
  return {
    problems: ["not-json", "empty", "missing-slots", "unknown-slot", "duplicate-slot", "two-handed", "youth-word", "revealing-word", "pose-contradiction"],
    missingSlots: indices.slice(-1),
    twoHandedSlots: rest,
    wordSlots: rest,
    poseSlots: rest,
    words: hostileWords,
  };
}

describe("the writer prompt floor pin, for a scene set", () => {
  test("a full chunk of custom scenes at the bounds, asked again after the worst refusal, stays at least 200 tokens under the 14K ceiling", () => {
    const parsed = SceneSetFile.parse(stamped(worstSet(POOL_TEXT_MAX)));
    const slots = parsed.scenes.map((s) => s.slot);
    const messages = runWriterConfig(parsed.categories).messages(slots, worstRefusal(slots));
    expect(promptTokenFloor({ messages, jsonSchema: WRITER_JSON_SCHEMA, images: 0 })).toBeLessThanOrEqual(CEILING - MARGIN);
  });

  test("a set file does not hold a custom scene's text past the bound the pin was measured at", () => {
    expect(SceneSetFile.safeParse(stamped(worstSet(POOL_TEXT_MAX))).success).toBe(true);
    expect(SceneSetFile.safeParse(stamped(worstSet(POOL_TEXT_MAX + 1))).success).toBe(false);
  });

  test("a chunk of a set holds at most the 25 scenes the pin was measured at", () => {
    const base = sampleSet({ count: 30 });
    const oneChunk = { ...base, chunks: [{ chunk: 1, sceneIds: base.scenes.map((s) => s.sceneId), attemptIds: base.chunks[0]?.attemptIds ?? [] }] };
    expect(SceneSetFile.safeParse(stamped(oneChunk)).success).toBe(false);
  });

  test("an attempt's reserve at a full worst chunk is the ceiling's price, not the prompt floor's", () => {
    // WRITER_CALL.inputTokens is the price the owner accepted: the floor must not raise the reserve above it.
    expect(promptTokenFloor({ messages: runWriterConfig([snapshot]).messages(worstSet(POOL_TEXT_MAX).scenes.map((s) => s.slot), undefined), jsonSchema: WRITER_JSON_SCHEMA, images: 0 })).toBeLessThan(CEILING);
  });
});
