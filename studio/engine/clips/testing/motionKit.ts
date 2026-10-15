import type { ChatParams, ChatResult } from "../../openrouter/types";
import type { PlanSlot } from "../../scenes/schema";
import { frameFactsOf, type FrameFacts } from "../frameFacts";
import { photoOf, pick, sceneRun, slotOf } from "./frameFixtures";

// Test-only (S5.WC3): the frames and the scripted chat the part C tests share.

/** A gallery photo's facts, or a thrown error for anything else. */
export function galleryFacts(run: ReturnType<typeof sceneRun>, slot: PlanSlot): FrameFacts {
  const result = frameFactsOf(photoOf(run, slot), run);
  if (result.kind !== "gallery") throw new Error(`expected a gallery photo, got ${result.kind}`);
  return result.facts;
}

/** An ordinary frame: a timer shot at home (her face shows, her phone is propped, no bank phone moment). */
export function timerFrame(): FrameFacts {
  const run = sceneRun("run-00000601", [slotOf(pick("home", (m) => m.captures.includes("timer") && m.legs === undefined && m.angle === undefined), "timer")]);
  return galleryFacts(run, run.scenes.slots[0] as PlanSlot);
}

/** A frame of «Смелая»: a mirror selfie in «Ночнушки и бельё», one hand on her hip. */
export function boldMirrorFrame(): FrameFacts {
  const picked = pick("nightwear", (m) => m.text === "stands with one hand on her hip" && m.captures.includes("mirror") && m.noLegwear !== true);
  const run = sceneRun("run-00000602", [slotOf(picked, "mirror", "front")]);
  return galleryFacts(run, run.scenes.slots[0] as PlanSlot);
}

/** A good motion for either frame above. */
export const GOOD_MOTION = "she slowly tucks a strand of hair behind her ear";
export const GOOD_MOTION_2 = "she tilts her head a little to one side and smiles";
export const GOOD_MOTION_3 = "she slowly takes a breath and relaxes her shoulders";
/** Takes clothing off: `takes-off` on an ordinary frame; accepted as an OWN idea on a frame of «Смелая» (Q-H = 2). */
export const UNDRESS_MOTION = "she slowly takes off her robe";

export interface PaidOk {
  readonly content: string;
  readonly costMicros?: number;
}

/** A scripted chat answer: a 2xx with a body, paid at `costMicros` (default 2 000). */
export function okAnswer(content: string, costMicros = 2_000): ChatResult {
  return { status: "ok", content, finishReason: "stop", costMicros, estimated: false, latencyMs: 5, httpTries: 1, aboveWorst: false };
}

/** A moderation refusal (free). */
export function refusedAnswer(): ChatResult {
  return { status: "refused", httpStatus: 400, message: "blocked by content moderation", ledger: { action: "settled", costMicros: 0, estimated: false } };
}

/** A paid 2xx with an empty message (`EMPTY_CONTENT`). */
export function emptyAnswer(costMicros = 1_500): ChatResult {
  return { status: "error", kind: "EMPTY_CONTENT", message: "the message has no content", httpStatus: 200, fatal: false, ledger: { action: "settled", costMicros, estimated: false } };
}

/** A 401. */
export function authAnswer(): ChatResult {
  return { status: "error", kind: "AUTH_INVALID", message: "401", httpStatus: 401, fatal: true, ledger: { action: "settled", costMicros: 0, estimated: false } };
}

/** A chat that answers the scripted results in turn and records every call's params. */
export function scriptedChat(script: readonly ChatResult[]): { chat: (params: ChatParams) => Promise<ChatResult>; calls: ChatParams[] } {
  const calls: ChatParams[] = [];
  let n = 0;
  return {
    calls,
    chat: async (params) => {
      calls.push(params);
      const next = script[n++];
      if (next === undefined) throw new Error(`the chat was called ${n} times; the script has ${script.length}`);
      return next;
    },
  };
}
