import { describe, expect, test } from "bun:test";
import { CATEGORY_LABEL_MAX, POOL_TEXT_MAX, POOL_TIMES, type CategorySnapshot } from "../../shared/engine";
import { SceneSetFile, type PlannedSceneSet } from "../library/sceneSets";
import { sampleSet } from "../library/testing/sceneSetSample";
import { WRITER_CALL } from "../money/estimate";
import { promptTokenFloor } from "../openrouter/chat";
import { runWriterConfig } from "../runs/plan";
import { WRITER_JSON_SCHEMA, type PlanSlot, type WriterRefusal } from "../scenes";
import { lightOf } from "../scenes/phoneLook";
import { POSE_LABEL, SHOT_LABEL } from "../scenes/writer";
import type { Pose } from "../scenes/schema";
import { SHOTS } from "../scenes/types";
import { worstSlotList } from "../scenes/testing/worstSlotList";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// CS.4a: THE WRITER PROMPT FLOOR PIN holds for every chunk a scene set can send. The set's request is a subset of one chunk of at most 25 scenes, built by the
// same `writerMessages` a run uses, and the set file holds every custom scene to the bounds a plan holds it to — so the worst chunk a set can carry is the worst
// chunk CS.1 pinned (scenes/writer.custom.test.ts): 25 custom slots at POOL_TEXT_MAX, a 24-char label, the time, shot and pose with the widest labels (read from
// the tables, S5.1b), the worst refusal, at least 200 tokens under the ceiling.
// If the file accepted a longer text, the reserve of an attempt could exceed the worst case the owner accepted and the job's own cap would refuse it.

const CUSTOM = "cat-paris-cafes" as const;
const longestOf = <T extends string>(keys: readonly T[], label: (key: T) => string): T => keys.reduce((a, b) => (label(b).length > label(a).length ? b : a));
const WORST_TIME = longestOf([...POOL_TIMES, "a time the table does not know"], lightOf);
const WORST_SHOT = longestOf(SHOTS, (s) => SHOT_LABEL[s]);
const WORST_POSE = longestOf(Object.keys(POSE_LABEL) as Pose[], (p) => POSE_LABEL[p]);
const MARGIN = 200;
/** The first scene number of the worst chunk: a set holds up to 100 scenes, a chunk 25. */
const WORST_FIRST_ID = 100 - WRITER_CALL.slotsPerCall + 1;
const CEILING = WRITER_CALL.inputTokens;

const snapshot: CategorySnapshot = { ref: CUSTOM, name: "я".repeat(40), label: "L".repeat(CATEGORY_LABEL_MAX), style: "editorial" };

/** A set of one full chunk of custom scenes, every text at `textLength`, built by hand so no draw can be luckier. */
function worstSet(textLength: number): Omit<PlannedSceneSet, "schemaVersion" | "revision" | "createdAt" | "updatedAt"> {
  const base = sampleSet({ count: WRITER_CALL.slotsPerCall });
  return {
    ...base,
    request: { ...base.request, categories: [CUSTOM] },
    categories: [snapshot],
    // A set holds up to 100 scenes, so a full chunk can be scenes 76..100: the widest numbers (the slot number is the scene's id, and the file checks it).
    chunks: base.chunks.map((chunk) => ({ ...chunk, sceneIds: chunk.sceneIds.map((id) => id + WORST_FIRST_ID - 1) })),
    scenes: base.scenes.map((scene, i) => ({
      ...scene,
      sceneId: scene.sceneId + WORST_FIRST_ID - 1,
      slot: {
        ...scene.slot,
        slotIndex: scene.sceneId + WORST_FIRST_ID - 1,
        category: CUSTOM,
        location: "x".repeat(textLength),
        timeOfDay: WORST_TIME,
        activity: "x".repeat(textLength),
        outfit: "x".repeat(textLength),
        shot: WORST_SHOT,
        pose: WORST_POSE,
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
  // The subset of the numbers that `slotList` tells in the most characters (scenes/testing/worstSlotList.ts). A set holds up to 100 scenes, so a chunk's numbers go up to 100:
  // the widest are 76..100, whatever numbers the sample's slots carry.
  const rest = worstSlotList(Array.from({ length: slots.length }, (_, i) => 100 - slots.length + 1 + i));
  return {
    problems: ["not-json", "empty", "missing-slots", "unknown-slot", "duplicate-slot", "two-handed", "youth-word", "revealing-word", "pose-contradiction", "phone-in-selfie"],
    missingSlots: rest,
    twoHandedSlots: rest,
    wordSlots: rest,
    poseSlots: rest,
    phoneSlots: rest,
    words: hostileWords,
  };
}

describe("the writer prompt floor pin, for a scene set", () => {
  test("a full chunk of custom scenes at the bounds, asked again after the worst refusal, stays at least 200 tokens under the 14K ceiling", () => {
    const parsed = SceneSetFile.parse(stamped(worstSet(POOL_TEXT_MAX)));
    const slots = parsed.scenes.flatMap((s) => (s.origin === "planned" ? [s.slot] : []));
    const messages = runWriterConfig(parsed.categories).messages(slots, worstRefusal(slots));
    const floor = promptTokenFloor({ messages, jsonSchema: WRITER_JSON_SCHEMA, images: 0 });
    expect(floor).toBeLessThanOrEqual(CEILING - MARGIN);
    // The measured margin of the honest worst (numbers 76..100 told in the longest list slotList can make): re-measure it when the writer prompt or a refusal text changes.
    // 268 -> 253 at S5.4 (C1): the phone-in-selfie refusal reason grew by 15 bytes (" or said selfie"); still above the 200 floor.
    expect(CEILING - floor).toBe(253);
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

// CS.4b: THE PHASE-2 FLOOR PIN. The worst review-time write is ONE request for at most five scenes: five redrawn custom slots (every text at its bound, the
// category's freshest 24-char label), or five own scenes with 500-char ideas (ideaWriter.test.ts pins those), asked again after the worst refusal. Neither can
// come near the 25-slot chunk of the pin above, so the ceiling the owner accepted covers every write — as long as the file holds a write to five scenes and a
// redrawn slot to the bounds a plan's slot is held to, which is pinned here.
describe("the phase-2 floor pin: the worst review-time write", () => {
  const redrawnSet = (textLength: number, scenes: number) => {
    const base = worstSet(textLength);
    const slots = base.scenes.slice(0, scenes).map((s) => s.slot);
    return { ...base, writes: 2, reviewWrites: [{ kind: "rewrite", k: 2, jobId: "job-aaaa-0002", attemptIds: [1, 2, 3, 4].map((n) => `${base.sceneSetId}:write-2#${n}`), closed: false, sceneIds: slots.map((s) => s.slotIndex), redraw: true, slots, snapshots: [snapshot] }] };
  };

  test("five redrawn custom slots at the bounds, asked again after the worst refusal, stay at least 200 tokens under the 14K ceiling", () => {
    const parsed = SceneSetFile.parse(stamped(redrawnSet(POOL_TEXT_MAX, 5) as never));
    const record = parsed.reviewWrites?.[0];
    if (record === undefined || record.kind !== "rewrite") throw new Error("no rewrite record");
    const messages = runWriterConfig(record.snapshots).messages(record.slots, worstRefusal(record.slots));
    expect(promptTokenFloor({ messages, jsonSchema: WRITER_JSON_SCHEMA, images: 0 })).toBeLessThanOrEqual(CEILING - MARGIN);
  });

  test("a redrawn slot in a write's record is held to the pool bound: one character over is refused by the file", () => {
    expect(SceneSetFile.safeParse(stamped(redrawnSet(POOL_TEXT_MAX, 5) as never)).success).toBe(true);
    expect(SceneSetFile.safeParse(stamped(redrawnSet(POOL_TEXT_MAX + 1, 5) as never)).success).toBe(false);
  });

  test("a write holds at most the five scenes the pin was measured at: a record of six is refused by the file", () => {
    expect(SceneSetFile.safeParse(stamped(redrawnSet(POOL_TEXT_MAX, 6) as never)).success).toBe(false);
  });
});
