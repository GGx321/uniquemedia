import { describe, expect, test } from "bun:test";
import { localSentences } from "../../engine/scenes/localSentences";
import { BANKS, CUES, GAZE } from "../../shared/scenes/banks";
import { shotOf } from "../../shared/scenes/captures";
import { localTexts, slotOf, type LocalScene } from "./mockBankScenes";

// S5.6R (round C): the mock writes a scene set's texts with the shared template, as the engine does (`setLocal` → `localSentences`), so it caps a gaze and an
// expression at twice in any 20 sentences the same way, and its texts stay the engine's for the same scenes and keys.

const SET_ID = "sceneset-00000001";
const VOICES = [...GAZE, ...CUES].map((v) => v.text);
const mostSaid = (texts: readonly (string | null)[]): number => Math.max(0, ...VOICES.map((voice) => texts.filter((t) => t?.includes(voice) === true).length));

/** 20 scenes of one open «Гламур» place and moment, as a friend's photos: only the draws differ, and each sentence has a gaze and a cue. */
function scenes(n: number): LocalScene[] {
  const place = BANKS.glamour.places.find((p) => p.room !== true && p.moments.some((m) => m.captures.includes("friend") && m.gaze === undefined && m.expression === undefined && m.angle === undefined && m.outfits === undefined));
  const moment = place?.moments.find((m) => m.captures.includes("friend") && m.gaze === undefined && m.expression === undefined && m.angle === undefined && m.outfits === undefined);
  const outfit = BANKS.glamour.outfits.find((o) => o.pinOnly !== true);
  if (place === undefined || moment === undefined || outfit === undefined) throw new Error("no open «Гламур» friend moment");
  return Array.from({ length: n }, (_, i) => ({
    sceneId: i + 1,
    category: "glam",
    shot: shotOf("friend"),
    capture: "friend",
    pose: "front",
    place: { location: place.name, timeOfDay: place.times[0] ?? "evening", activity: moment.text, outfit: outfit.text },
    removed: false,
  }));
}

describe("the mock's scene texts (localTexts)", () => {
  test("a 20-scene set says no gaze and no expression three times", () => {
    const set = scenes(20);
    const text = localTexts({ sceneSetId: SET_ID, k: 0, scenes: set, snapshots: [], impliedNudity: false });
    expect(mostSaid(set.map((s) => text(s.sceneId)))).toBeLessThanOrEqual(2);
  });

  test("are the engine's texts for the same scenes and keys", () => {
    const set = scenes(40);
    const text = localTexts({ sceneSetId: SET_ID, k: 0, scenes: set, snapshots: [], impliedNudity: false });
    const slots = set.flatMap((s) => {
      const slot = slotOf(s);
      return slot === null ? [] : [{ ...slot, slotIndex: s.sceneId }];
    });
    const engine = localSentences({ slots, keyOf: (slot) => `${SET_ID}:${slot.slotIndex}:0` });
    expect(set.map((s) => text(s.sceneId))).toEqual(slots.map(engine));
  });
});
