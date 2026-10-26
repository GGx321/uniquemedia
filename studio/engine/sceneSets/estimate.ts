import { MAX_SCENES_PER_WRITE, type Estimate, type SceneLevel } from "../../shared/engine";
import type { StoredSceneSet } from "../library/sceneSets";
import { WRITER_CALL, writerAttemptWorstMicros, writerCallOf, writerChunksMicros, writerExpectedMicros, type WriterCall, type WriterMode } from "../money/estimate";
import { coversAt, llmPossibleSlots, writerChunksWorst, writerModeAt, type CoversOf, type SplitEntry } from "../../shared/scenes/writerBound";
import type { PricedBook, PriceModels } from "../money/priceCache";
import type { LedgerView } from "../runs/journal";
import { writerModeOf } from "../scenes/writer";
import { pendingChunks } from "./chunks";
import { setLocal } from "./local";

// CS.4a: what a compose and a «Дописать» could cost, in one place: the estimate commands show it, the paid commands compare the owner's accepted
// worst case with it and cap the job at that, and the job sends exactly these calls (the scene writer's own call shape, money/estimate.ts's WRITER_CALL),
// so no reserve exceeds what the owner was shown.

/** The models a scene set's calls price: the settings' text model alone. */
export function sceneSetPriceModels(textModel: string): PriceModels {
  return { imageModels: [], chatModels: [textModel] };
}

/** The writer's call of a mode on the settings' text model, with the one source of truth's limits (money/estimate.ts's `writerCallOf`, r2.1 L2). */
function writerCall(textModel: string, mode: WriterMode): WriterCall {
  return { ...writerCallOf(mode), model: textModel };
}

/**
 * One writer attempt at its ceiling on the settings' text model (the figure `composeEstimate` multiplies by the attempts per chunk and the chunks).
 * 5a.4 (S5.BA5, r2.1 N1): priced by `writerAttemptWorstMicros`, the one attempt price, which adds the call's reasoning allowance (none for the ordinary call). The mode is
 * required: the bold call's attempt is 48 750 µ$ at the fallback prices, the ordinary one's 37 500.
 */
export function writerCeilingMicros(priced: PricedBook, textModel: string, mode: WriterMode): number {
  return writerAttemptWorstMicros(priced.book, writerCall(textModel, mode));
}

/**
 * 5a.4 (S5.BA5; BA5a review R2-L1): a compose's expected writer cost for `chunks` requests carrying `scenes` model scenes, at a mode, never above the worst case of those requests:
 * `composeEstimate`'s own figure, and the launch unit's table by requests and scenes (autopilot/prices.ts), so the two cannot drift. Nothing to ask is nothing.
 */
export function composeExpectedMicros(priced: PricedBook, textModel: string, mode: WriterMode, chunks: number, scenes: number): number {
  if (chunks === 0 || scenes === 0) return 0;
  const call = writerCall(textModel, mode);
  // Round 2 (M1): one attempt of each request at the typical tokens (`writerExpectedMicros`).
  return Math.min(writerExpectedMicros(priced.book, call, chunks, scenes), writerChunksMicros(priced.book, call, chunks));
}

/**
 * Composing a `split` of scenes: the writer's worst case for them (`writerChunksWorst` requests of at most 25 scenes, each asked up to twice at the ceiling,
 * the very figure a run's estimate carries for its writer), expected at the writer's typical tokens for the scenes only the model can write. Since 5a.2 the
 * code template writes every scene of a built-in category and of a custom one it covers (`covers`), so those cost nothing; an empty set, or one with no scene
 * for the model, costs nothing and prices nothing.
 */
export function composeEstimate(priced: PricedBook, textModel: string, split: readonly SplitEntry[], covers: CoversOf, level: SceneLevel | undefined): Estimate {
  const free: Estimate = { expectedMicros: 0, worstMicros: 0, prices: priced.book.source, pricesAsOf: priced.asOf };
  // 5a.2 (S5.6c2, I5.30): the code template writes every scene of a built-in category and of a covered custom one; the writer is priced for the uncovered
  // custom categories' scenes alone (`writerChunksWorst`), and a compose with none of them prices no writer, so its model needs no price.
  // 5a.4 (S5.BA5, I5.77, BA3 review M-1): at «Смелая» no custom category is covered (`coversAt`) and the writer is the bold call (`writerModeAt`). `level` is required (M3).
  const coveredAt = coversAt(covers, level);
  const chunks = writerChunksWorst(split, coveredAt);
  const scenes = llmPossibleSlots(split, coveredAt);
  if (chunks === 0 || scenes === 0) return free;
  const mode = writerModeAt(level);
  const worstMicros = writerChunksMicros(priced.book, writerCall(textModel, mode), chunks);
  return { expectedMicros: composeExpectedMicros(priced, textModel, mode, chunks, scenes), worstMicros, prices: priced.book.source, pricesAsOf: priced.asOf };
}

/**
 * A rewrite or an idea write (CS.4b): ONE writer request for one to five scenes, asked at most `attemptsLeft` times (2 for a fresh write; after an open or
 * reconciled reserve one, after a free 429/5xx two again), each at the writer's ceiling, so the worst case is exactly what the job's cap is set to. Expected
 * at the writer's typical tokens for the scenes. A write with none left costs nothing.
 */
export function reviewWriteEstimate(priced: PricedBook, textModel: string, scenes: number, attemptsLeft: number, modelScenes: number, mode: WriterMode): Estimate {
  if (!Number.isInteger(scenes) || scenes < 1 || scenes > MAX_SCENES_PER_WRITE) throw new RangeError(`a write covers 1..${MAX_SCENES_PER_WRITE} scenes, got ${scenes}`);
  if (!Number.isInteger(attemptsLeft) || attemptsLeft < 0 || attemptsLeft > WRITER_CALL.maxAttempts) throw new RangeError(`a write has 0..${WRITER_CALL.maxAttempts} attempts left, got ${attemptsLeft}`);
  if (!Number.isInteger(modelScenes) || modelScenes < 0 || modelScenes > scenes) throw new RangeError(`a write of ${scenes} scenes has 0..${scenes} for the model, got ${modelScenes}`);
  // 5a.2 (S5.6c2): from the write's actual slots. The code template writes what it can at $0, so a write whose every scene renders costs nothing; the
  // request that remains carries the model's scenes alone. A write with a scene the template cannot write (an idea, an own scene, an old-pool slot of an
  // interrupted rewrite) is priced as before: its attempts left at the writer's ceiling.
  if (attemptsLeft === 0 || modelScenes === 0) return { expectedMicros: 0, worstMicros: 0, prices: priced.book.source, pricesAsOf: priced.asOf };
  // 5a.4 (S5.BA5, r2.1 L3; BA5a review L4): in the mode the write's job asks it in (`writerModeOf` over its scenes for the model, S5.BA4), required.
  const call = writerCall(textModel, mode);
  const worstMicros = attemptsLeft * writerAttemptWorstMicros(priced.book, call);
  // One request (round 2, M1: its per-call term once).
  return { expectedMicros: Math.min(writerExpectedMicros(priced.book, call, 1, modelScenes), worstMicros), worstMicros, prices: priced.book.source, pricesAsOf: priced.asOf };
}

/**
 * «Дописать»: the chunks still to write, each at `min(2 − answered, unused ids) × the ceiling` (the same arithmetic as a run's `remainingPlan`):
 * an open or reconciled reserve is an answered attempt, so an interrupted chunk is priced at one attempt, never a fresh pair. Chunks out of attempts,
 * given up, or with nothing left to ask (every scene removed or typed) cost nothing.
 */
export function writeEstimate(priced: PricedBook, set: StoredSceneSet, ledger: LedgerView | null): Estimate {
  // 5a.2 (S5.6c2): only a pending chunk that holds a scene the template cannot write is a request; a `free` chunk (every scene renders) is written with no
  // request, whatever its attempts or its verdict, and adds nothing. A mixed chunk's request carries its model scenes alone.
  const asked = pendingChunks(set, ledger).filter((pending) => !pending.free);
  if (asked.length === 0) return { expectedMicros: 0, worstMicros: 0, prices: priced.book.source, pricesAsOf: priced.asOf };
  // 5a.4 (S5.BA5, r2.1 L3; BA5a review L4): each chunk in the mode its job asks it in, `writerModeOf` over the scenes it sends the model (the very `setLocal` the job's
  // phase reads, S5.BA4): a chunk with a «Смелая» frame at the bold call, any other at the ordinary one.
  // Which scenes go to the model is the same whatever the avatar's origin (it changes only the coverage a sentence ends with).
  const local = setLocal(set, 0, false);
  const slotOf = new Map(set.scenes.flatMap((scene) => (scene.origin === "planned" ? [[scene.sceneId, scene.slot] as const] : [])));
  const modeOf = (sceneIds: readonly number[]): WriterMode =>
    writerModeOf(
      sceneIds.flatMap((sceneId) => {
        const slot = slotOf.get(sceneId);
        return slot !== undefined && local(slot) === null ? [slot] : [];
      }),
    );
  let worstMicros = 0;
  const load = new Map<WriterMode, { requests: number; scenes: number }>();
  for (const pending of asked) {
    const mode = modeOf(pending.sceneIds);
    worstMicros += pending.state.attemptsLeft * writerAttemptWorstMicros(priced.book, writerCall(set.models.text, mode));
    const sum = load.get(mode) ?? { requests: 0, scenes: 0 };
    load.set(mode, { requests: sum.requests + (pending.state.attemptsLeft > 0 ? 1 : 0), scenes: sum.scenes + pending.modelScenes });
  }
  // Round 2 (M1): one attempt of each chunk that can still be asked, at the typical tokens of its mode (`writerExpectedMicros`).
  let expected = 0;
  for (const [mode, { requests, scenes }] of load) if (scenes > 0) expected += writerExpectedMicros(priced.book, writerCall(set.models.text, mode), requests, scenes);
  return { expectedMicros: Math.min(expected, worstMicros), worstMicros, prices: priced.book.source, pricesAsOf: priced.asOf };
}
