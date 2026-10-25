import {
  ownIdeaLabel,
  type ClipFrameReading,
  type ClipMotionChoice,
  type ClipOptions,
  type ClipSuggestResult,
  type ClipTranslateResult,
  type CommandPayload,
  type Estimate,
} from "../../shared/engine";
import { freshDrafts, sameText, sheetVisionTexts } from "../../shared/engine/motionKnown";
import { ownIdeaNamesAge } from "../../shared/scenes/motionText";
import { EngineFailure } from "../engineFailure";
import type { Library } from "../library";
import type { PhotoSidecar } from "../library/schemas";
import { scopeKey, type Budget } from "../money/budget";
import { timeoutSignal, untilAborted } from "../money/timeoutSignal";
import { motionPriceModels } from "../money/motionEstimate";
import { suggestPrice, translatePrice } from "./motionPrice";
import type { PricedBook, PriceModels } from "../money/priceCache";
import type { OpenRouterClient } from "../openrouter/types";
import type { FrameFacts } from "./frameFacts";
import { runIdeaTranslator } from "./ideaTranslator";
import { motionChoicesOf } from "./motion";
import { clipMotionProblems } from "./prompt";
import { addItems, isFull, listedItems, MotionStores, type MotionItem } from "./motionStore";
import { runMotionWriter } from "./motionWriter";

// Stage 5, 5b.2, S5.WC3 (plan s5b2 §5.3, I5.66-I5.68; Q-H = 2): the four part C commands (`clips.estimateSuggest`, `clips.suggestMotions`, `clips.estimateIdea`, `clips.translateIdea`) and the photo's stored
// motions, on the clip service's seams.
//
// The money is the descriptor check's pattern WITHOUT its avatar claim: a free estimate; a held call with the owner's `acceptedWorstMicros`; key, ledger, library, avatar and photo, the photo's own reasons,
// the price, the accepted worst case, the month; then the call under its own scope `{avatarJobId: jobId}`, capped at its worst case, in try/finally; at most two attempts (the writer's and the translator's
// own); `#pendingDelete` and the library are looked at again after the last await. A photo run or an edit of the avatar goes on meanwhile; an avatar delete waits for the avatar's running calls
// (`runningFor`), and a library switch waits for the paid count (`paidStart`).
//
// The guard, both ways (r2.1 N10): a call answers IN_FLIGHT `clip-busy` while the clip money unit is held (no chat line may enter a clip's proof window); while ANY call runs (`running()`, any avatar, any
// photo) the clip service answers `motion-busy` to `clips.create` and `clips.createBatch`; one call per photo and kind at a time (`suggest-busy`, `idea-busy`). All of it is decided synchronously, before
// the first await.

/** What the clip service reads of a photo for a part C call: its facts and file, or why it cannot be brought to life. */
export type MotionFactsRead =
  | { kind: "suitable"; facts: FrameFacts; bytes: Uint8Array }
  | { kind: "refused"; reason: Extract<ClipOptions, { suitable: false }>["reason"] };

export interface ClipMotionsDeps {
  newId: () => string;
  /** The time, ISO, for a stored item's `at`. */
  now: () => string;
  /** A clip or a batch holds the clip money unit. */
  unitHeld: () => boolean;
  currentLibrary: () => Library | null;
  liveLibrary: () => Promise<Library>;
  usableKey: (purpose: string) => string;
  paidBudget: () => Budget;
  /** The active avatar's photo, or NOT_FOUND (the clip service's own lookup). */
  photoOf: (library: Library, avatarId: string, photoId: string) => PhotoSidecar;
  assertAvatarOnDisk: (library: Library, avatarId: string) => Promise<void>;
  /** The photo's facts and bytes, or its reason (the clip service's own read, in `clips.create`'s order). */
  facts: (library: Library, photo: PhotoSidecar) => Promise<MotionFactsRead>;
  prices: (models: PriceModels) => Promise<PricedBook>;
  textModel: () => string;
  checkAccepted: (worstMicros: number, acceptedWorstMicros: number) => void;
  checkMonthlyRoom: (budget: Budget, worstMicros: number) => void;
  paidStart: () => void;
  paidEnd: () => void;
  setCap: (key: string, micros: number) => void;
  clearCap: (key: string) => void;
  openRouter: (key: string, timeoutMs?: number) => Pick<OpenRouterClient, "chat">;
  /** How long one HTTP try of a call may wait for its answer: 60 s like the descriptor check, not the client's 180 s default (review L4). */
  callTimeoutMs: number;
  /** How long the photo's downscale may take before the call ends free (review M1; `REFERENCE_TIMEOUT_MS` like the check's photo load). */
  downscaleTimeoutMs: number;
  /** How long the call's two disk reads (the photo's facts and file, then the motion store) may take before it ends free as `photo-unreadable`: a stalled disk must not keep the call counted (S5.FU-DATA 1). */
  readTimeoutMs: number;
  emitMoney: () => void;
  markKeyRejected: (key: string) => void;
  pendingDelete: (avatarId: string) => boolean;
  /** The photo as a JPEG of at most `maxSide` px on its long side. */
  downscale: (bytes: Uint8Array, maxSide: number, signal?: AbortSignal) => Promise<Uint8Array>;
  log: (line: string) => void;
}

/** The vision writer sees the photo at most this big (I5.68): never the master, never the original size. */
export const MOTION_IMAGE_MAX_SIDE = 1024;

const MODEL_SOURCES = ["vision", "own"] as const;

function choiceOf(item: MotionItem): ClipMotionChoice {
  return { id: item.id, source: item.source, label: item.label, text: item.text };
}

export class ClipMotions {
  readonly #deps: ClipMotionsDeps;
  readonly #stores: MotionStores;
  /** Part C calls running now, any avatar: `clips.create` and `clips.createBatch` wait while this is above 0. */
  #running = 0;
  readonly #byAvatar = new Map<string, number>();
  readonly #suggesting = new Set<string>();
  readonly #translating = new Set<string>();

  constructor(deps: ClipMotionsDeps, stores: MotionStores = new MotionStores(deps.log)) {
    this.#deps = deps;
    this.#stores = stores;
  }

  /** Part C calls running now (the guard's other direction). */
  running(): number {
    return this.#running;
  }

  /** Calls of this avatar running now: an avatar delete waits for them. */
  runningFor(avatarId: string): number {
    return this.#byAvatar.get(avatarId) ?? 0;
  }

  /** The label of an own idea in the photo's store by its English text, for a recovered clip (I5.67). Null when the store does not hold it. */
  async ownLabelOf(library: Library, avatarId: string, photoId: string, text: string): Promise<string | null> {
    const photo = library.getPhoto(photoId);
    if (photo === undefined || photo.avatarId !== avatarId) return null;
    const { file } = await this.#stores.read(library.avatarDirPath(avatarId), photo.id, photo.sha256);
    const found = [...file.items].reverse().find((item) => item.source === "own" && item.text === text);
    return found?.label ?? null;
  }

  /**
   * The stored suggestions and ideas of a photo as `clips.options` lists them (plan s5b2 §5.3): the newest three suggestions and the newest two own ideas that pass the check made now, in the order they
   * were made, and the last frame reading. A free read: no model call.
   */
  async stored(library: Library, photo: PhotoSidecar, facts: FrameFacts): Promise<{ motions: ClipMotionChoice[]; reading: ClipFrameReading | undefined }> {
    try {
      const { file } = await this.#stores.read(library.avatarDirPath(photo.avatarId), photo.id, photo.sha256);
      const passes = (item: MotionItem): boolean => clipMotionProblems(facts, item.text, item.source).length === 0;
      return { motions: listedItems(file, passes).map(choiceOf), reading: file.reading };
    } catch (error) {
      // A store that cannot be read is no store: the sheet still lists the scene's and the code's motions.
      this.#deps.log(`[clip] the motion store of photo ${photo.id} could not be read (${error instanceof Error ? error.name : typeof error})`);
      return { motions: [], reading: undefined };
    }
  }

  // ---------- the free estimates ----------

  async estimateSuggest(payload: CommandPayload<"clips.estimateSuggest">): Promise<Estimate> {
    await this.#photoForEstimate(payload.avatarId, payload.photoId);
    const textModel = this.#deps.textModel();
    return suggestPrice(await this.#deps.prices(motionPriceModels(textModel)), textModel);
  }

  async estimateIdea(payload: CommandPayload<"clips.estimateIdea">): Promise<Estimate> {
    await this.#photoForEstimate(payload.avatarId, payload.photoId);
    const textModel = this.#deps.textModel();
    return translatePrice(await this.#deps.prices(motionPriceModels(textModel)), textModel);
  }

  async #photoForEstimate(avatarId: string, photoId: string): Promise<void> {
    const library = this.#deps.currentLibrary();
    if (library === null) throw new EngineFailure({ code: "LIBRARY_UNAVAILABLE", detail: "no library is open: its folder is missing or unreadable; choose one in Settings" });
    this.#deps.photoOf(library, avatarId, photoId);
  }

  // ---------- the paid calls ----------

  /** The guard, all of it synchronous: a clip money unit in flight, or a call for this photo and kind. Then the call is counted. */
  #enter(kind: "suggest" | "idea", avatarId: string, photoId: string): () => void {
    if (this.#deps.unitHeld()) {
      throw new EngineFailure({ code: "IN_FLIGHT", clipReason: "clip-busy", detail: "a clip or a batch of clips is being made; a motion call waits until its money is closed" });
    }
    const running = kind === "suggest" ? this.#suggesting : this.#translating;
    const key = `${avatarId}/${photoId}`;
    if (running.has(key)) {
      throw new EngineFailure({
        code: "IN_FLIGHT",
        clipReason: kind === "suggest" ? "suggest-busy" : "idea-busy",
        detail: kind === "suggest" ? "motions are already being suggested for this photo" : "an idea for this photo is already being translated",
      });
    }
    running.add(key);
    this.#running += 1;
    this.#byAvatar.set(avatarId, (this.#byAvatar.get(avatarId) ?? 0) + 1);
    this.#deps.paidStart();
    return () => {
      running.delete(key);
      this.#running -= 1;
      const left = (this.#byAvatar.get(avatarId) ?? 1) - 1;
      if (left <= 0) this.#byAvatar.delete(avatarId);
      else this.#byAvatar.set(avatarId, left);
      this.#deps.paidEnd();
    };
  }

  async suggestMotions(payload: CommandPayload<"clips.suggestMotions">): Promise<ClipSuggestResult> {
    const leave = this.#enter("suggest", payload.avatarId, payload.photoId);
    try {
      return await this.#suggest(payload);
    } finally {
      leave();
    }
  }

  async translateIdea(payload: CommandPayload<"clips.translateIdea">): Promise<ClipTranslateResult> {
    const leave = this.#enter("idea", payload.avatarId, payload.photoId);
    try {
      return await this.#translate(payload);
    } finally {
      leave();
    }
  }

  /** Everything a paid call checks before it spends, in the contract's order. The store is read here too: a source that issued its last id is `motions-full`. */
  async #prepare(
    purpose: string,
    source: (typeof MODEL_SOURCES)[number],
    avatarId: string,
    photoId: string,
  ): Promise<{ key: string; budget: Budget; library: Library; photo: PhotoSidecar; facts: FrameFacts; bytes: Uint8Array; sha: string; items: readonly MotionItem[] }> {
    const deps = this.#deps;
    const key = deps.usableKey(purpose);
    const budget = deps.paidBudget();
    const library = await deps.liveLibrary();
    const photo = deps.photoOf(library, avatarId, photoId);
    await deps.assertAvatarOnDisk(library, avatarId);
    // Bounded (S5.FU-DATA 1): the call is counted from its first step, and a disk that stalls would keep it counted, answering `motion-busy` to every clip, avatar delete and library switch until restart.
    const bound = timeoutSignal(deps.readTimeoutMs);
    let read: MotionFactsRead;
    let store: Awaited<ReturnType<MotionStores["read"]>>;
    try {
      read = await untilAborted(deps.facts(library, photo), bound.signal);
      if (read.kind === "refused") throw new EngineFailure({ code: "VALIDATION", clipReason: read.reason, detail: `photo ${photo.id} cannot be brought to life (${read.reason})` });
      store = await untilAborted(this.#stores.read(library.avatarDirPath(avatarId), photo.id, photo.sha256), bound.signal);
    } catch (error) {
      if (!bound.signal.aborted) throw error;
      deps.log(`[clip] the disk did not answer for photo ${photo.id} in time (${error instanceof Error ? error.name : typeof error})`);
      throw new EngineFailure({ code: "VALIDATION", clipReason: "photo-unreadable", detail: `photo ${photo.id} could not be read` });
    } finally {
      bound.clear();
    }
    if (!store.writable) throw new EngineFailure({ code: "INTERNAL", detail: `the motion store of photo ${photo.id} was written by a newer build and is left as it is` });
    if (isFull(store.file, source)) {
      throw new EngineFailure({ code: "VALIDATION", clipReason: "motions-full", detail: `every ${source === "vision" ? "v" : "o"}- id of photo ${photo.id} was issued; ids are never reused` });
    }
    return { key, budget, library, photo, facts: read.facts, bytes: read.bytes, sha: photo.sha256, items: store.file.items };
  }

  /** Whether the avatar has gone or the library was switched away: it is being deleted, no longer in the library, or the library is not the open one. */
  #gone(library: Library, avatarId: string): boolean {
    const deps = this.#deps;
    return deps.pendingDelete(avatarId) || library.getAvatar(avatarId) === undefined || deps.currentLibrary() !== library;
  }

  /** Before the money: the avatar is still there and not being deleted, or NOT_FOUND. */
  #stillThere(library: Library, avatarId: string): void {
    if (this.#gone(library, avatarId)) throw new EngineFailure({ code: "NOT_FOUND", detail: `avatar ${avatarId} is no longer in the open library` });
  }

  /**
   * After the last await: nothing is stored for an avatar that is going. A call that was BILLED ends as `none` with its cost (S5.FU-DATA 3: the owner is told what was paid, never a bare NOT_FOUND);
   * a call that cost nothing is NOT_FOUND as before.
   */
  #goneAfter(library: Library, avatarId: string, costMicros: number): boolean {
    if (!this.#gone(library, avatarId)) return false;
    if (costMicros > 0) return true;
    throw new EngineFailure({ code: "NOT_FOUND", detail: `avatar ${avatarId} is no longer in the open library` });
  }

  async #suggest(payload: CommandPayload<"clips.suggestMotions">): Promise<ClipSuggestResult> {
    const deps = this.#deps;
    const { avatarId } = payload;
    const ready = await this.#prepare("suggest motions for a photo", "vision", avatarId, payload.photoId);
    const textModel = deps.textModel();
    const priced = await deps.prices(motionPriceModels(textModel));
    const estimate = suggestPrice(priced, textModel);
    deps.checkAccepted(estimate.worstMicros, payload.acceptedWorstMicros);
    deps.checkMonthlyRoom(ready.budget, estimate.worstMicros);
    // The photo at most 1024 px, a JPEG: made from the gallery photo's own bytes, never the master's.
    // Bounded (review M1): a hung ffmpeg would keep the call counted, and with it every clip, avatar delete and library switch, refused until restart. The signal kills ffmpeg.
    let image: Uint8Array;
    const bound = timeoutSignal(deps.downscaleTimeoutMs);
    try {
      image = await untilAborted(deps.downscale(ready.bytes, MOTION_IMAGE_MAX_SIDE, bound.signal), bound.signal);
    } catch (error) {
      deps.log(`[clip] photo ${ready.photo.id} could not be scaled for the motion writer (${error instanceof Error ? error.name : typeof error})`);
      throw new EngineFailure({ code: "VALIDATION", clipReason: "photo-unreadable", detail: `photo ${ready.photo.id} could not be read` });
    } finally {
      bound.clear();
    }
    this.#stillThere(ready.library, avatarId);

    const jobId = deps.newId();
    const scope = { avatarJobId: jobId };
    const client = deps.openRouter(ready.key, deps.callTimeoutMs);
    // Known: the suggestions ON THE SHEET (the newest three; an older one has left it, and a model that suggests it again brings it back as a new item) and the frame's own scene and code motions (the sheet lists them already). An own idea is a separate source and does not count (S5.WC3c).
    // S5.WCX: the writer is told them too, as data, so that it suggests something else.
    const frameTexts = motionChoicesOf(ready.facts).map((choice) => sameText(choice.text));
    const passes = (item: MotionItem): boolean => clipMotionProblems(ready.facts, item.text, item.source).length === 0;
    const listed = [...frameTexts, ...sheetVisionTexts(ready.items, passes)];
    deps.setCap(scopeKey(scope), estimate.worstMicros);
    const linesBefore = ready.budget.ledger.lines.length;
    let outcome: Awaited<ReturnType<typeof runMotionWriter>>;
    try {
      outcome = await runMotionWriter(
        { chat: (params) => client.chat(params), budget: ready.budget, priceBook: priced.book, log: deps.log },
        { jobId, scope, textModel, photoId: ready.photo.id, image, facts: ready.facts, listed },
      );
    } finally {
      deps.clearCap(scopeKey(scope));
      if (ready.budget.ledger.lines.length !== linesBefore || ready.budget.ledger.failed) deps.emitMoney();
    }
    if (outcome.kind === "error") {
      if (outcome.error.code === "AUTH_INVALID") deps.markKeyRejected(ready.key);
      throw new EngineFailure(outcome.error);
    }
    if (this.#goneAfter(ready.library, avatarId, outcome.costMicros)) return { outcome: "none", costMicros: outcome.costMicros };
    if (outcome.kind === "none") return { outcome: "none", costMicros: outcome.costMicros };
    const at = deps.now();
    try {
      let made: MotionItem[] = [];
      let repeated = false;
      await this.#stores.update(ready.library.avatarDirPath(avatarId), ready.photo.id, ready.sha, (file) => {
        // Round 3 L5: a suggestion the store already holds (another call wrote it) is not stored twice; the writer dedupes within one answer only. The sheet is read again here: another call may
        // have written while this one ran.
        const known = [...frameTexts, ...sheetVisionTexts(file.items, passes)];
        const { fresh, repeated: allKnown } = freshDrafts(outcome.drafts, known);
        // Nothing new: nothing is written, the reading of the last stored call stays.
        if (fresh.length === 0) {
          repeated = allKnown;
          return null;
        }
        const added = addItems(file, "vision", fresh.map((draft) => ({ label: draft.label, text: draft.text, model: textModel, at })));
        made = added.items;
        return { ...added.file, reading: outcome.reading };
      });
      if (made.length === 0) return repeated ? { outcome: "none", reason: "repeated", costMicros: outcome.costMicros } : { outcome: "none", costMicros: outcome.costMicros };
      return { outcome: "ok", motions: made.map(choiceOf), reading: outcome.reading, costMicros: outcome.costMicros };
    } catch (error) {
      // The call is paid; the owner is told so. Only ids are logged.
      deps.log(`[clip] the suggestions of photo ${ready.photo.id} could not be stored (${error instanceof Error ? error.name : typeof error})`);
      return { outcome: "none", costMicros: outcome.costMicros };
    }
  }

  async #translate(payload: CommandPayload<"clips.translateIdea">): Promise<ClipTranslateResult> {
    const deps = this.#deps;
    const { avatarId } = payload;
    const ready = await this.#prepare("translate an idea", "own", avatarId, payload.photoId);
    // S5.WC2c round 2 (M1): the age guard on his own words, before any money: refused free and final, and nothing reaches the model. Only the photo's id is logged.
    if (ownIdeaNamesAge(payload.text, ready.facts.level)) {
      deps.log(`[clip] the idea for photo ${ready.photo.id} is refused before the call: the age guard`);
      return { outcome: "rejected", problems: ["content"], costMicros: 0 };
    }
    const textModel = deps.textModel();
    const priced = await deps.prices(motionPriceModels(textModel));
    const estimate = translatePrice(priced, textModel);
    deps.checkAccepted(estimate.worstMicros, payload.acceptedWorstMicros);
    deps.checkMonthlyRoom(ready.budget, estimate.worstMicros);
    this.#stillThere(ready.library, avatarId);

    const jobId = deps.newId();
    const scope = { avatarJobId: jobId };
    const client = deps.openRouter(ready.key, deps.callTimeoutMs);
    deps.setCap(scopeKey(scope), estimate.worstMicros);
    const linesBefore = ready.budget.ledger.lines.length;
    let outcome: Awaited<ReturnType<typeof runIdeaTranslator>>;
    try {
      // The idea (`payload.text`) is read here and nowhere else: it goes into the chat request as JSON data and into the call's own scrub of a saved raw body, and is not kept.
      outcome = await runIdeaTranslator(
        { chat: (params) => client.chat(params), budget: ready.budget, priceBook: priced.book, log: deps.log },
        { jobId, scope, textModel, photoId: ready.photo.id, idea: payload.text, facts: ready.facts },
      );
    } finally {
      deps.clearCap(scopeKey(scope));
      if (ready.budget.ledger.lines.length !== linesBefore || ready.budget.ledger.failed) deps.emitMoney();
    }
    if (outcome.kind === "error") {
      if (outcome.error.code === "AUTH_INVALID") deps.markKeyRejected(ready.key);
      throw new EngineFailure(outcome.error);
    }
    if (this.#goneAfter(ready.library, avatarId, outcome.costMicros)) return { outcome: "none", costMicros: outcome.costMicros };
    if (outcome.kind === "none") return { outcome: "none", costMicros: outcome.costMicros };
    if (outcome.kind === "rejected") return { outcome: "rejected", problems: outcome.problems, costMicros: outcome.costMicros };
    // The engine cuts the label from his words (`ownIdeaLabel`); the item keeps that label and the English text, never the idea.
    const label = ownIdeaLabel(payload.text);
    try {
      let made: MotionItem | undefined;
      await this.#stores.update(ready.library.avatarDirPath(avatarId), ready.photo.id, ready.sha, (file) => {
        const added = addItems(file, "own", [{ label, text: outcome.text, model: textModel, at: deps.now() }]);
        made = added.items[0];
        return added.file;
      });
      if (made === undefined) return { outcome: "none", costMicros: outcome.costMicros };
      return { outcome: "ok", item: choiceOf(made), costMicros: outcome.costMicros };
    } catch (error) {
      deps.log(`[clip] the idea for photo ${ready.photo.id} could not be stored (${error instanceof Error ? error.name : typeof error})`);
      return { outcome: "none", costMicros: outcome.costMicros };
    }
  }
}
