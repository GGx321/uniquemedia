import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ClipSuggestResult, ClipTranslateResult, Estimate, ResponseMessage } from "../../../shared/engine";
import { ledgerLines } from "../../testing/engineHarness";
import { clipsDir, options, optionsOf, seedClipAvatar, startClipEngine, type ClipEngine, type SeedOptions } from "./engineClipKit";
import { chatReply, errorOf, motionNetwork, resultOf, send, type ChatHandler, type MotionNetwork } from "./motionNet";

// Test-only (S5.WC3): a real engine over a real library with one gallery photo and the chat route of the fake OpenRouter, and the four part C commands as functions.

/** Four of them differ from every code motion of a frame (S5.WC3c: a suggestion equal to a code motion is not stored). */
export const GOOD_TEXTS = [
  "she slowly tucks a strand of hair behind her ear",
  "she slowly lifts her chin and smiles softly",
  "she slowly turns toward the window and smiles",
  "she slowly looks down and smiles to herself",
  "she slowly glances to the side and looks back",
] as const;

/** The owner's idea, with a canary far enough in that the first 40 characters (the label) do not hold it. */
export const IDEA = "медленно поворачивает голову к окну и улыбается, CANARY-9c41";
export const CANARY = "CANARY-9c41";

export const FRAME_READING = { capture: "unknown", phoneVisible: false, faceVisible: true };

/** The writer's answer for these texts (labels «Движение n»). */
export function suggestionReply(texts: readonly string[], cost = 0.0034, frame: Record<string, unknown> = FRAME_READING) {
  return chatReply({ motions: texts.map((text, i) => ({ label_ru: `Движение ${i + 1}`, text_en: text })), frame }, cost);
}

/** The translator's answer. */
export function ideaReply(text: string, cost = 0.001) {
  return chatReply({ text_en: text }, cost);
}

export interface MotionWorld {
  readonly started: ClipEngine;
  readonly net: MotionNetwork;
  readonly avatarId: string;
  readonly photoId: string;
  readonly masterId: string;
  /** A second avatar with its own gallery photo (`second: true`): the guard is global, any avatar. */
  readonly other: { avatarId: string; photoId: string } | undefined;
  readonly libraryDir: string;
  readonly dir: string;
  estimateSuggest(): Promise<Estimate>;
  estimateIdea(): Promise<Estimate>;
  suggest(accepted?: number): Promise<ResponseMessage>;
  translate(text?: string, accepted?: number): Promise<ResponseMessage>;
  suggestOk(texts: readonly string[]): Promise<ClipSuggestResult>;
  translateOk(text: string, idea?: string): Promise<ClipTranslateResult>;
  options(): Promise<ReturnType<typeof optionsOf>>;
  storePath(): string;
  /** Writes the photo's motion store as it is given (a test sets up or tampers with it). */
  writeStore(file: unknown): Promise<void>;
  ledger(): Record<string, unknown>[];
}

export async function motionWorld(
  dir: string,
  opts: { chat?: ChatHandler; seed?: SeedOptions; engine?: Parameters<typeof startClipEngine>[1]; net?: MotionNetwork; beforeStart?: () => Promise<void>; second?: boolean } = {},
): Promise<MotionWorld> {
  const libraryDir = join(dir, "library");
  const seeded = await seedClipAvatar(libraryDir, opts.seed);
  const other = opts.second === true ? await seedClipAvatar(libraryDir, opts.seed) : undefined;
  const net = opts.net ?? motionNetwork(opts.chat === undefined ? {} : { chat: opts.chat });
  await opts.beforeStart?.();
  const started = await startClipEngine(dir, { ...opts.engine, net });
  const { avatarId, photoId } = seeded;
  const estimate = async (type: "clips.estimateSuggest" | "clips.estimateIdea"): Promise<Estimate> => Estimate.parse(resultOf(await send(started, type, { avatarId, photoId })));
  const world: MotionWorld = {
    started,
    net,
    avatarId,
    photoId,
    masterId: seeded.masterId,
    other: other === undefined ? undefined : { avatarId: other.avatarId, photoId: other.photoId },
    libraryDir,
    dir,
    estimateSuggest: () => estimate("clips.estimateSuggest"),
    estimateIdea: () => estimate("clips.estimateIdea"),
    suggest: async (accepted) => send(started, "clips.suggestMotions", { avatarId, photoId, acceptedWorstMicros: accepted ?? (await estimate("clips.estimateSuggest")).worstMicros }),
    translate: async (text = IDEA, accepted) => send(started, "clips.translateIdea", { avatarId, photoId, text, acceptedWorstMicros: accepted ?? (await estimate("clips.estimateIdea")).worstMicros }),
    suggestOk: async (texts) => {
      net.setChat(() => suggestionReply(texts));
      return ClipSuggestResult.parse(resultOf(await world.suggest()));
    },
    translateOk: async (text, idea = IDEA) => {
      net.setChat(() => ideaReply(text));
      return ClipTranslateResult.parse(resultOf(await world.translate(idea)));
    },
    options: async () => optionsOf(await options(started, avatarId, photoId)),
    storePath: () => join(libraryDir, "avatars", avatarId, "motions", `${photoId}.json`),
    writeStore: async (file) => {
      const path = join(libraryDir, "avatars", avatarId, "motions", `${photoId}.json`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(file, null, 2));
    },
    ledger: () => ledgerLines(dir),
  };
  return world;
}

export { chatReply, clipsDir, errorOf, resultOf, send };
