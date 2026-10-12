import type { AvatarDescriptor, BoldCategory } from "../../shared/engine";
import { BANKS } from "../../shared/scenes/banks";
import type { BankPlace, Moment, Outfit } from "../../shared/scenes/banks/types";
import { captureOfShot, type Capture } from "../../shared/scenes/captures";
import { asLibraryReference, JPEG } from "../openrouter/testing/fakes";
import { assembleRun, hairLinesOf, plan, roomPlaceOf, slotLookOf, type PlanSlot } from "../scenes";
import { localSentences } from "../scenes/localSentences";
import { slotKeyOf } from "../scenes/phoneLook";
import { boldPrompt } from "./boldPrompt";
import { isBoldSlot } from "./journal";

// Test-only (S5.R4-fix B): the «Смелая» prompts a run really sends, made by the very chain `promptsOf` in runJob.ts runs: the planner draws the slots, the code template writes
// each sentence (the writer phase's `local`, in slot order, one dedup set and one gaze-and-cue tally for the run), `assembleRun` puts the prompt together with the room, look and
// hair lookups wired in, and a Seedream slot's prompt takes `boldPrompt`. Nothing is mocked but the avatar: the bank text the owner reads is what these sweeps scan.

const DESCRIPTOR: AvatarDescriptor = { age: 25, text: "25-year-old European woman, light olive skin, hazel eyes, shoulder-length wavy chestnut hair, athletic build." };
const MASTER = asLibraryReference(JPEG);

export interface RunPromptsInput {
  category: BoldCategory;
  seed: number;
  count: number;
  legsShare: 0 | 15 | 30;
  cameraRealism: boolean;
}

/** One slot of a run as the image request sees it: the slot, what it drew from the bank, its template sentence and its final prompt. */
export interface PromptFrame {
  slot: PlanSlot;
  place: BankPlace;
  moment: Moment;
  outfit: Outfit;
  capture: Capture;
  sentence: string;
  prompt: string;
}

/** The prompts of one «Смелая» run at «Подача: Смелая», slot by slot, in plan order. Throws when a slot is left to the writer or ends at the assembler: neither may happen here. */
export function boldRunPrompts(input: RunPromptsInput): PromptFrame[] {
  const runId = `run-${input.seed.toString(16).padStart(8, "0")}`;
  const scenes = plan({ seed: input.seed, count: input.count, categories: [input.category], level: "bold", legsShare: input.legsShare });
  const slots = scenes.slots;
  const written = localSentences({ slots, keyOf: (slot) => slotKeyOf(runId, slot.attemptIdBase), snapshots: undefined });
  const sentences = new Map<number, string>();
  for (const slot of slots) {
    const sentence = written(slot);
    if (sentence === null) throw new Error(`${input.category} seed ${input.seed}: slot ${slot.slotIndex} was left to the writer`);
    sentences.set(slot.slotIndex, sentence);
  }
  const hairLines = hairLinesOf(slots, "long", runId);
  const results = assembleRun(DESCRIPTOR, scenes, sentences, MASTER, {
    runId,
    cameraRealism: input.cameraRealism,
    roomPlaceOf,
    lookOf: slotLookOf,
    hairStyleOf: (slot) => hairLines.get(slot.slotIndex) ?? null,
  });
  const bank = BANKS[input.category];
  return slots.map((slot, i) => {
    const result = results[i];
    if (result === undefined || !result.ok) throw new Error(`${input.category} seed ${input.seed}: slot ${slot.slotIndex} ended at the assembler`);
    const place = bank.places.find((p) => p.name === slot.location);
    const moment = place?.moments.find((m) => m.text === slot.activity);
    const outfit = bank.outfits.find((o) => o.text === slot.outfit);
    if (place === undefined || moment === undefined || outfit === undefined) throw new Error(`${input.category}: slot ${slot.slotIndex} names an item the bank does not have`);
    return {
      slot,
      place,
      moment,
      outfit,
      capture: slot.capture ?? captureOfShot(slot.shot),
      sentence: sentences.get(slot.slotIndex) ?? "",
      prompt: isBoldSlot(slot) ? boldPrompt(result.prompt) : result.prompt,
    };
  });
}

/** The reviewer's matrix: both banks, 10 and 20 photos, «Ножки» 0 / 15 / 30 %, «Реализм камеры» on and off, over `seeds` seeds. */
export function boldPromptMatrix(seeds: number): PromptFrame[] {
  const out: PromptFrame[] = [];
  for (const category of ["nightwear", "beach"] as const) {
    for (const count of [10, 20]) {
      for (const legsShare of [0, 15, 30] as const) {
        for (const cameraRealism of [false, true]) {
          for (let seed = 1; seed <= seeds; seed++) out.push(...boldRunPrompts({ category, seed: seed * 7919 + count, count, legsShare, cameraRealism }));
        }
      }
    }
  }
  return out;
}
