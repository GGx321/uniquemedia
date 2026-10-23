import {
  CLIP_CHOICES_MAX,
  MOTION_ENGLISH,
  MOTION_ID_MAX,
  MOTION_LABEL_MAX,
  MOTION_MAX_ATTEMPTS,
  MOTION_PROBLEMS,
  MOTION_STORE_MAX_ITEMS,
  MOTION_TEXT_MAX,
  ownIdeaLabel,
  type ClipFrameNote,
  type ClipFrameReading,
  type ClipMotionChoice,
  type ClipMotionSource,
  type ClipSuggestResult,
  type ClipTranslateResult,
  type CommandPayload,
  type EngineError,
  type Estimate,
  type MotionProblem,
} from "../../shared/engine";
import { freshDrafts, sameText, sheetVisionTexts } from "../../shared/engine/motionKnown";
import { CAPTURES } from "../../shared/scenes/captures";
import type { ContentLevel } from "../../shared/scenes/contentLine";
import { motionTextProblems, ownIdeaNamesAge, repairMayHelp, type MotionFrame } from "../../shared/scenes/motionText";

// Stage 5, 5b.2, S5.WC4 (plan s5b2 §5.3, §5.6 «C», I5.66-I5.68; Q-H = 2): the vision motion writer and «Своя идея» of the mock engine, the mirror of engine/clips/{motionService,motionWriter,ideaTranslator,motionStore}.ts.
// The mock plays the model's answers from a script (`MockModelReply`: what OpenRouter would answer, in the words the transport reads), and does with each one what the engine does: the same parsing, the SAME shared motion check
// (`shared/scenes/motionText.ts`, imported, not copied), the same second attempt with closed problem codes, the same money (a reserve per attempt before it is sent, a settle by the answer, the cost of every result), the same
// guard (both ways, global) and the same store (ids from `next`, never reused, twelve FIFO, a changed photo empties it).
//
// HELD to the engine by tests that can import both: the prices and the normalising/ check (mockEngine.clipMotions.table.test.ts), the stories of parity (scenarios.clipMotions.ts).
// `stored()` re-checks a listed item with `checkModelText` (the shared check plus the motion English of the contract); the engine re-checks with `clipMotionProblems` (the same plus `clipPromptOf`'s 130 words). They
// differ only on a record someone tampered with. The one thing the mock does not run is `clipPromptOf`'s 130-word cap: a planless frame (all the mock has) puts at most 60 characters between fixed lines, so the cap cannot bind there (the table test pins it).

type Out<T> = { ok: true; result: T } | { ok: false; error: EngineError };
const good = <T>(result: T): Out<T> => ({ ok: true, result });
const bad = (error: EngineError): Out<never> => ({ ok: false, error });

// ---------- the prices ----------

/**
 * The two estimates at the bundled price table, for the engine's system prompts (S5.WCX, final): `motionPrice.suggestPrice` / `translatePrice` read the largest message a call can send, so the worst case follows the prompt text.
 * Held to the engine by mockEngine.clipMotions.table.test.ts (it fails the day a prompt changes, and says which number to move here).
 */
export const MOCK_SUGGEST_PRICE = { expectedMicros: 5_310, worstMicros: 34_024 } as const;
export const MOCK_TRANSLATE_PRICE = { expectedMicros: 1_363, worstMicros: 29_088 } as const;

type CallKind = "suggest" | "idea";

const priceOf = (kind: CallKind): { expectedMicros: number; worstMicros: number } => (kind === "suggest" ? MOCK_SUGGEST_PRICE : MOCK_TRANSLATE_PRICE);

// What ONE attempt reserves (engine/openrouter/chat.ts `chatAttemptWorstMicros`, at the bundled price of the default text model): the caller's ceilings, the prompt never below its byte floor, rounded up to a whole
// micro-dollar. The engine reserves for the message it really sends (the system prompt, the user's JSON with the frame, the idea, the feedback and the previous text, the schema, and the photo's allowance), not for half
// of the call's widest case, so the mock builds the same user JSON and counts the same bytes. The sizes of the system prompts and of the two schemas are held to the engine by
// mockEngine.clipMotions.table.test.ts, and the whole reserve of every attempt by mockEngine.clipMotions.money.test.ts (the real ledger).
export const MOCK_PROMPT_BYTES: { writer: number; translator: number } = { writer: 2_464, translator: 3_217 };
export const MOCK_SCHEMA_BYTES: { suggest: number; idea: number } = { suggest: 669, idea: 249 };
/** The caller's ceilings of one attempt (engine/money/motionEstimate.ts), the reasoning allowance (S5.WCX: priced as completion on top of `maxTokens`, never sent) included. */
const CEILINGS = {
  suggest: { maxTokens: 1_000, reasoningTokens: 3_000, inputTokens: 3_000, images: 1 },
  idea: { maxTokens: 500, reasoningTokens: 3_000, inputTokens: 1_000, images: 0 },
} as const;
const TEMPLATE_TOKENS_PER_MESSAGE = 16;
const CHAT_IMAGE_TOKEN_ALLOWANCE = 1_500;
/** The text model's price in pico-dollars per token (x-ai/grok-4.3 at the bundled table). */
const PROMPT_PICO = 1_250_000;
const COMPLETION_PICO = 2_500_000;

/** The user message's JSON, as the engine writes it (`messagesOf` of the writer and of the translator), and the bytes the reserve counts. */
export function attemptWorstMicros(kind: CallKind, user: string): number {
  const system = kind === "suggest" ? MOCK_PROMPT_BYTES.writer : MOCK_PROMPT_BYTES.translator;
  const { maxTokens, reasoningTokens, inputTokens, images } = CEILINGS[kind];
  const floor = system + new TextEncoder().encode(user).length + MOCK_SCHEMA_BYTES[kind] + 2 * TEMPLATE_TOKENS_PER_MESSAGE + images * CHAT_IMAGE_TOKEN_ALLOWANCE;
  const pico = (maxTokens + reasoningTokens) * COMPLETION_PICO + Math.max(inputTokens, floor) * PROMPT_PICO;
  return Math.floor((pico + 999_999) / 1_000_000);
}

/** engine/clips/motionCall.ts `framePayload` for a planless frame: nobody is known to have taken the photo, her face shows, no activity, no phone. */
function framePayloadOf(frame: MockMotionFrame): Record<string, unknown> {
  return {
    capture: "unknown",
    plannedCapture: "unknown",
    faceVisible: "yes",
    faceRole: "judged",
    legsFraming: false,
    level: typeof frame.level === "string" ? frame.level : "bold",
    bold: frame.bold,
    activity: null,
    phoneAllowed: false,
  };
}

type Feedback = readonly (MotionProblem | "unreadable")[];
/** How much of the model's own last English text is fed back to it (engine/clips/ideaTranslator.ts `PREVIOUS_MAX_CHARS`). */
const PREVIOUS_MAX_CHARS = 80;

// ---------- the model's answers, scripted ----------

/**
 * What the model's HTTP answer was, one per attempt, in the order the attempts are sent.
 * - answer: a 2xx with this content, billed `costMicros` (the call's expected figure when absent).
 * - empty: a 2xx with no content (EMPTY_CONTENT): billed, unusable, a second attempt may follow.
 * - unusable-body: a 2xx that is not a chat answer at all (UNUSABLE_PAID_RESPONSE): settled at the attempt's worst case, no second attempt.
 * - refused: a 400 from content moderation: free.
 * - http: any other final status: 401 `AUTH_INVALID`, 402 `INSUFFICIENT_CREDITS`, 429 `RATE_LIMITED`, 5xx `NETWORK`; free (a non-2xx settles at 0).
 * - timeout, network: no answer: the reserve STAYS OPEN at its worst case (it may have been billed).
 */
export type MockModelReply =
  | { kind: "answer"; content: string; costMicros?: number }
  | { kind: "empty"; costMicros?: number }
  | { kind: "unusable-body" }
  | { kind: "refused" }
  | { kind: "http"; status: 401 | 402 | 429 | 500 | 502 | 503 }
  | { kind: "timeout" }
  | { kind: "network" };

/** The writer's answer for these texts (labels «Движение n»), as JSON. */
export function mockSuggestionAnswer(texts: readonly string[], frame: { capture?: string; phoneVisible?: boolean; faceVisible?: boolean } = {}, costMicros?: number): MockModelReply {
  const content = JSON.stringify({
    motions: texts.map((text, i) => ({ label_ru: `Движение ${i + 1}`, text_en: text })),
    frame: { capture: frame.capture ?? "unknown", phoneVisible: frame.phoneVisible ?? false, faceVisible: frame.faceVisible ?? true },
  });
  return { kind: "answer", content, ...(costMicros === undefined ? {} : { costMicros }) };
}

/** The translator's answer: the English text, and no refusal. */
export function mockIdeaAnswer(text: string, costMicros?: number): MockModelReply {
  return { kind: "answer", content: JSON.stringify({ text_en: text, refusal: "none" }), ...(costMicros === undefined ? {} : { costMicros }) };
}

/** S5.WCX: the translator's own refusal of an idea that is not one small motion: no text, one closed code (engine/clips/ideaTranslator.ts `TRANSLATOR_REFUSALS`). */
export function mockIdeaRefusal(code: MockTranslatorRefusal, costMicros?: number): MockModelReply {
  return { kind: "answer", content: JSON.stringify({ text_en: "", refusal: code }), ...(costMicros === undefined ? {} : { costMicros }) };
}

/** What an unscripted attempt answers: three small motions, or the translation of any idea into one. Demo and tests that do not care. */
const DEFAULT_SUGGESTIONS = ["she slowly tucks a strand of hair behind her ear", "she slowly lifts her chin and smiles softly", "she slowly turns toward the window and smiles"] as const;
const DEFAULT_TRANSLATION = "she slowly turns her head toward the window and smiles";

// ---------- the checks (mirrors of engine/clips/motionCall.ts and motionWriter.ts) ----------

/** What the check reads of a frame: a planless photo (all the mock has) is taken by nobody it knows, and its face shows (a photo with no motion offers no call). */
export interface MockMotionFrame {
  readonly bold: boolean;
  readonly level: ContentLevel;
  /** The English of the scene and code motions the frame offers: a suggestion equal to one is not stored (the engine's `motionChoicesOf`, S5.WC3c). */
  readonly offered: readonly string[];
}

/** engine/clips/motionCall.ts `normalizeModelText`: typographic apostrophes, one space, no final period, a leading «She» in lowercase. */
export function normalizeModelText(raw: string): string {
  return raw
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/, "")
    .trim()
    .replace(/^(She|Her)(?=\s)/, (word) => word.toLowerCase());
}

/** engine/clips/motionCall.ts `checkModelText` (the 130-word cap aside, see the header). */
export function checkModelText(frame: Pick<MockMotionFrame, "bold" | "level">, raw: string, source: Extract<ClipMotionSource, "vision" | "own">): { text: string; problems: MotionProblem[] } {
  const text = normalizeModelText(raw);
  const problems = motionTextProblems(text, checkedFrame(frame), source);
  if (problems.length > 0) return { text, problems };
  if (text.length > MOTION_TEXT_MAX || !MOTION_ENGLISH.test(text)) return { text, problems: ["not-motion"] };
  return { text, problems };
}

/** What the shared check reads of the mock's frame (a planless photo, her face showing). */
function checkedFrame(frame: Pick<MockMotionFrame, "bold" | "level">): MotionFrame {
  return { capture: "unknown", plannedCapture: "unknown", face: "yes", level: frame.level, bold: frame.bold, moment: null };
}

/** engine/clips/motionWriter.ts and ideaTranslator.ts: a refusal of the age guard gets no repair (the shared `repairMayHelp`, S5.WC2c). */
function mayRepair(frame: Pick<MockMotionFrame, "bold" | "level">, text: string, source: Extract<ClipMotionSource, "vision" | "own">): boolean {
  return repairMayHelp(text, checkedFrame(frame), source);
}

const CAPTURE_NAMES: readonly string[] = [...CAPTURES, "unknown"];

interface WriterAnswer {
  motions: { label_ru: string; text_en: string }[];
  frame: { capture: string; phoneVisible: boolean; faceVisible: boolean };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && keys.every((key) => key in value);

/** The writer's answer under the strict schema the engine reads it with; the first three motions are kept. Null: unreadable. */
function readWriterAnswer(content: string): WriterAnswer | null {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isRecord(json) || !onlyKeys(json, ["motions", "frame"])) return null;
  const { motions, frame } = json;
  if (!Array.isArray(motions) || !isRecord(frame) || !onlyKeys(frame, ["capture", "phoneVisible", "faceVisible"])) return null;
  const { capture, phoneVisible, faceVisible } = frame;
  if (typeof capture !== "string" || !CAPTURE_NAMES.includes(capture) || typeof phoneVisible !== "boolean" || typeof faceVisible !== "boolean") return null;
  const read: WriterAnswer["motions"] = [];
  for (const motion of motions) {
    if (!isRecord(motion) || !onlyKeys(motion, ["label_ru", "text_en"]) || typeof motion.label_ru !== "string" || typeof motion.text_en !== "string") return null;
    read.push({ label_ru: motion.label_ru, text_en: motion.text_en });
  }
  return read.length === 0 ? null : { motions: read.slice(0, CLIP_CHOICES_MAX.vision), frame: { capture, phoneVisible, faceVisible } };
}

/** engine/clips/ideaTranslator.ts `TRANSLATOR_REFUSALS` (held to it by the table test): the codes the translator answers instead of a text. */
export const MOCK_TRANSLATOR_REFUSALS = ["two-movements", "not-small", "staging", "not-motion"] as const satisfies readonly MotionProblem[];
export type MockTranslatorRefusal = (typeof MOCK_TRANSLATOR_REFUSALS)[number];
const isRefusal = (value: unknown): value is MockTranslatorRefusal => (MOCK_TRANSLATOR_REFUSALS as readonly unknown[]).includes(value);

/** The translator's answer under the strict schema the engine reads it with: the text, or its own refusal (which wins). Null: unreadable. */
function readIdeaAnswer(content: string): { kind: "text"; text: string } | { kind: "refusal"; code: MockTranslatorRefusal } | null {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isRecord(json) || !onlyKeys(json, ["text_en", "refusal"]) || typeof json.text_en !== "string") return null;
  if (json.refusal === "none") return { kind: "text", text: json.text_en };
  return isRefusal(json.refusal) ? { kind: "refusal", code: json.refusal } : null;
}

/** engine/clips/motionWriter.ts `cleanLabel`: cleaned of control and format characters, cut by word to 40 characters; null when nothing is left. */
function cleanLabel(raw: string): string | null {
  const flat = raw.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, "").replace(/\s+/g, " ").trim();
  if (flat === "") return null;
  const label = ownIdeaLabel(flat);
  return label.length <= MOTION_LABEL_MAX ? label : null;
}

/** The marks the frame reading may carry: a planless frame plans no capture, so only a phone in view is a mark (marks only, never a refusal). */
function readingOf(frame: WriterAnswer["frame"]): ClipFrameReading {
  const notes: ClipFrameNote[] = [];
  if (frame.phoneVisible) notes.push("second-phone");
  return { notes };
}

// ---------- one attempt (the transport and `stepOf`) ----------

type ChatStep =
  | { kind: "answer"; content: string; costMicros: number }
  | { kind: "unreadable"; costMicros: number; final?: true }
  | { kind: "refused"; costMicros: number }
  | { kind: "no-room"; costMicros: number }
  | { kind: "error"; error: EngineError; costMicros: number; leftOpen: boolean };

/** engine/clips/motionCall.ts `endsAsResult`: a later attempt's failure ends the call as a plain result with what was paid, unless it must reach the owner as it is. */
function endsAsResult(step: Extract<ChatStep, { kind: "error" }>, paidBefore: number): boolean {
  return paidBefore > 0 && !step.leftOpen && step.error.code !== "AUTH_INVALID" && step.error.code !== "INSUFFICIENT_CREDITS";
}

// ---------- the store (engine/clips/motionStore.ts) ----------

/** A stored suggestion or idea. Mutable on purpose: a test edits the store as the owner's disk could (`tamper`). */
export interface MockStoredItem {
  id: string;
  source: Extract<ClipMotionSource, "vision" | "own">;
  label: string;
  text: string;
}
type StoredItem = MockStoredItem;

export interface MockMotionStore {
  /** The photo file the items were made for: another file empties the store. */
  sha: string;
  next: { vision: number; own: number };
  items: StoredItem[];
  reading?: ClipFrameReading;
}

type Store = MockMotionStore;
const emptyStore = (sha: string): Store => ({ sha, next: { vision: 1, own: 1 }, items: [] });
const PREFIX = { vision: "v", own: "o" } as const;

const isFull = (store: Store, source: StoredItem["source"]): boolean => store.next[source] > MOTION_ID_MAX;

/** Ids issued in order from the source's counter, appended; the oldest past twelve go. A source with fewer ids left than drafts keeps the first ones. */
function addItems(store: Store, source: StoredItem["source"], drafts: readonly { label: string; text: string }[]): StoredItem[] {
  const made: StoredItem[] = [];
  for (const draft of drafts) {
    if (store.next[source] > MOTION_ID_MAX) break;
    made.push({ id: `${PREFIX[source]}-${store.next[source]}`, source, label: draft.label, text: draft.text });
    store.next[source] += 1;
  }
  const all = [...store.items, ...made];
  store.items = all.slice(Math.max(0, all.length - MOTION_STORE_MAX_ITEMS));
  return made;
}

const choiceOf = (item: StoredItem): ClipMotionChoice => ({ id: item.id, source: item.source, label: item.label, text: item.text });

// ---------- the ports and the class ----------

/** The photo as a part C call reads it: why it cannot be brought to life, or its frame and its file's identity. */
export type MockMotionRead = Out<{ frame: MockMotionFrame; sha: string }>;

/** What the mock engine hands the motions. */
export interface MockMotionPorts {
  /** A clip or a batch holds the clip money unit (the ONE predicate behind both directions of the guard). */
  unitHeld(): boolean;
  /** The key and ledger gate (`usableKey`, then `paidBudget`), or its refusal. */
  gate(): EngineError | null;
  /** What the budget refuses an attempt's reserve with while the ledger is halted or needs a reconcile, or null. */
  reserveRefusal(): EngineError | null;
  /** A settle came in above its reserve: the ledger halts (`SETTLE_ABOVE_WORST`) until the owner reconciles. */
  haltLedger(): void;
  markKeyRejected(): void;
  /** The avatar's photo exists (an active avatar, not being deleted, the photo its own): NOT_FOUND otherwise. The master is a photo. */
  find(avatarId: string, photoId: string): Out<true>;
  /** The photo as the clip rules read it (`find` first), in `clips.create`'s order. */
  read(avatarId: string, photoId: string): MockMotionRead;
  /** The usual price source of the mock's estimates. */
  prices(): Pick<Estimate, "prices" | "pricesAsOf">;
  /** The month's committed money (spent + open + held) and its limit. */
  committedMicros(): number;
  monthlyBudgetMicros(): number;
  /** The mock's open reserves (attempt id to worst), and the settle of the cost. */
  reserves: Map<string, number>;
  spend(micros: number): void;
  emitMoney(): void;
  nextId(prefix: string): string;
  /** A timer of the mock's scheduler: how long a call takes in the demo (never in a test, which holds or releases the answer itself). */
  sleep(ms: number): Promise<void>;
  /** The paid count a library switch and a reconcile wait for. */
  paidStart(): void;
  paidEnd(): void;
  log(line: string): void;
}

export interface MockMotionOptions {
  /** How long a call waits for the model's answer (0: no time passes unless the call is held). */
  callMs?: number;
}

interface Line {
  attemptId: string;
  worstMicros: number;
  state: "open" | "settled";
  costMicros: number;
  estimated: boolean;
}

export class MockClipMotions {
  readonly #ports: MockMotionPorts;
  readonly #callMs: number;
  readonly #stores = new Map<string, Store>();
  readonly #lines: Line[] = [];
  readonly #caps = new Map<string, number>();
  readonly #suggesting = new Set<string>();
  readonly #translating = new Set<string>();
  readonly #byAvatar = new Map<string, number>();
  #running = 0;
  /** A restart ends every call that was in flight: a call that wakes up in a later epoch does nothing. */
  #epoch = 0;
  #script: MockModelReply[] = [];
  #held = false;
  #door: { promise: Promise<void>; open: () => void } | null = null;
  /** Calls waiting at the model (`hold`): a test says «the request is at the model». */
  #atModel = 0;

  constructor(ports: MockMotionPorts, options: MockMotionOptions = {}) {
    this.#ports = ports;
    this.#callMs = options.callMs ?? 0;
  }

  // ---------- the controls ----------

  /** Arms the answers of the NEXT attempts, in the order they are sent (used up one per attempt; an attempt without one answers by default). */
  script(replies: readonly MockModelReply[]): void {
    this.#script = [...replies];
  }

  /** While held, a call waits at the model after its reserve: the request is out, no answer has come. Released, every waiting call goes on. */
  hold(held: boolean): void {
    this.#held = held;
    if (!held) {
      this.#door?.open();
      this.#door = null;
    }
  }

  /** How many calls are waiting at the model now. */
  waiting(): number {
    return this.#atModel;
  }

  /** A part C call runs now, any avatar, any photo: `clips.create` and `clips.createBatch` wait while this is above 0. */
  running(): number {
    return this.#running;
  }

  runningFor(avatarId: string): number {
    return this.#byAvatar.get(avatarId) ?? 0;
  }

  /** The calls' ledger lines, for the tests: `<job>:motion#N` and `<job>:idea#N`. */
  lines(): readonly Readonly<Line>[] {
    return this.#lines.map((line) => ({ ...line }));
  }

  /** The live caps as the autopilot's room reads them: each running call's scope, its cap and what it has committed. */
  liveCaps(): { capMicros: number; committedMicros: number }[] {
    return [...this.#caps].map(([jobId, capMicros]) => {
      let committedMicros = 0;
      for (const line of this.#lines) if (line.attemptId.startsWith(`${jobId}:`)) committedMicros += line.state === "open" ? line.worstMicros : line.costMicros;
      return { capMicros, committedMicros };
    });
  }

  /** The store of a photo as it stands now, for the tests. */
  storeOf(avatarId: string, photoId: string): Readonly<Store> | undefined {
    return this.#stores.get(`${avatarId}/${photoId}`);
  }

  /** The engine process restarts: a call in flight is gone with it (no answer ever comes, nothing is counted any more); the stores are files and stay. */
  restart(): void {
    this.#epoch += 1;
    this.#suggesting.clear();
    this.#translating.clear();
    this.#byAvatar.clear();
    this.#caps.clear();
    this.#running = 0;
    this.hold(false);
  }

  /** A test changes a store as the owner's disk could. */
  tamper(avatarId: string, photoId: string, sha: string, change: (store: Store) => void): void {
    change(this.#read(avatarId, photoId, sha));
  }

  /** The stores as the tests read them, by photo id. */
  stores(): Record<string, Readonly<Store>> {
    return Object.fromEntries(
      [...this.#stores].map(([key, store]) => [
        key.slice(key.indexOf("/") + 1),
        { ...store, next: { ...store.next }, items: store.items.map((i) => ({ ...i })), ...(store.reading === undefined ? {} : { reading: { notes: [...store.reading.notes] } }) },
      ]),
    );
  }

  /** The avatar is gone: its stores go with its folder. */
  removeAvatar(avatarId: string): void {
    for (const key of [...this.#stores.keys()]) if (key.startsWith(`${avatarId}/`)) this.#stores.delete(key);
  }

  // ---------- the store ----------

  #read(avatarId: string, photoId: string, sha: string): Store {
    const key = `${avatarId}/${photoId}`;
    const found = this.#stores.get(key);
    if (found === undefined || found.sha !== sha) {
      const fresh = emptyStore(sha);
      this.#stores.set(key, fresh);
      return fresh;
    }
    return found;
  }

  /** `clips.options`' view (engine `ClipMotions.stored`): the newest three suggestions and the newest two ideas that pass the check made now, in the order they were made, and the last reading. Free. */
  stored(avatarId: string, photoId: string, frame: MockMotionFrame, sha: string): { motions: ClipMotionChoice[]; reading: ClipFrameReading | undefined } {
    const store = this.#read(avatarId, photoId, sha);
    const newest = (source: StoredItem["source"]): StoredItem[] => {
      const kept: StoredItem[] = [];
      for (const item of [...store.items].reverse()) {
        if (item.source !== source || checkModelText(frame, item.text, item.source).problems.length > 0) continue;
        kept.push(item);
        if (kept.length === CLIP_CHOICES_MAX[source]) break;
      }
      return kept.reverse();
    };
    return { motions: [...newest("vision"), ...newest("own")].map(choiceOf), reading: store.reading === undefined ? undefined : { notes: [...store.reading.notes] } };
  }

  /** The label of an own idea in the photo's store by its English text, for a recovered clip (I5.67); null when the store (as it reads for this file) does not hold it. */
  ownLabelOf(avatarId: string, photoId: string, text: string, sha: string): string | null {
    const store = this.#read(avatarId, photoId, sha);
    return [...store.items].reverse().find((item) => item.source === "own" && item.text === text)?.label ?? null;
  }

  // ---------- the free estimates ----------

  estimateSuggest(payload: CommandPayload<"clips.estimateSuggest">): Out<Estimate> {
    return this.#estimate("suggest", payload.avatarId, payload.photoId);
  }

  estimateIdea(payload: CommandPayload<"clips.estimateIdea">): Out<Estimate> {
    return this.#estimate("idea", payload.avatarId, payload.photoId);
  }

  #estimate(kind: CallKind, avatarId: string, photoId: string): Out<Estimate> {
    const found = this.#ports.find(avatarId, photoId);
    if (!found.ok) return found;
    const { expectedMicros, worstMicros } = priceOf(kind);
    return good({ expectedMicros, worstMicros, ...this.#ports.prices() });
  }

  // ---------- the paid calls ----------

  /** The guard, all of it before the first await: a clip money unit in flight, or a call for this photo and kind. Then the call is counted. */
  #enter(kind: CallKind, avatarId: string, photoId: string): Out<() => void> {
    if (this.#ports.unitHeld()) return bad({ code: "IN_FLIGHT", clipReason: "clip-busy", detail: "a clip or a batch of clips is being made; a motion call waits until its money is closed" });
    const running = kind === "suggest" ? this.#suggesting : this.#translating;
    const key = `${avatarId}/${photoId}`;
    if (running.has(key)) {
      return bad({
        code: "IN_FLIGHT",
        clipReason: kind === "suggest" ? "suggest-busy" : "idea-busy",
        detail: kind === "suggest" ? "motions are already being suggested for this photo" : "an idea for this photo is already being translated",
      });
    }
    running.add(key);
    this.#running += 1;
    this.#byAvatar.set(avatarId, (this.#byAvatar.get(avatarId) ?? 0) + 1);
    this.#ports.paidStart();
    const epoch = this.#epoch;
    return good(() => {
      // A restart cleared every count already: the call that outlived it owes nothing.
      if (epoch !== this.#epoch) return;
      running.delete(key);
      this.#running -= 1;
      const left = (this.#byAvatar.get(avatarId) ?? 1) - 1;
      if (left <= 0) this.#byAvatar.delete(avatarId);
      else this.#byAvatar.set(avatarId, left);
      this.#ports.paidEnd();
    });
  }

  /** Everything a paid call checks before it spends, in the contract's order: the photo's (`#photoReady`), then the money's (`#moneyReady`). */
  #prepare(kind: CallKind, avatarId: string, photoId: string, acceptedWorstMicros: number): Out<{ frame: MockMotionFrame; sha: string }> {
    const read = this.#photoReady(kind, avatarId, photoId);
    if (!read.ok) return read;
    return this.#moneyReady(kind, acceptedWorstMicros, read.result);
  }

  /** The key, the ledger, the photo and its store, as the engine's `#prepare`. */
  #photoReady(kind: CallKind, avatarId: string, photoId: string): Out<{ frame: MockMotionFrame; sha: string }> {
    const gated = this.#ports.gate();
    if (gated !== null) return bad(gated);
    const found = this.#ports.find(avatarId, photoId);
    if (!found.ok) return found;
    const read = this.#ports.read(avatarId, photoId);
    if (!read.ok) return read;
    const source = kind === "suggest" ? "vision" : "own";
    if (isFull(this.#read(avatarId, photoId, read.result.sha), source)) {
      return bad({ code: "VALIDATION", clipReason: "motions-full", detail: `every ${PREFIX[source]}- id of photo ${photoId} was issued; ids are never reused` });
    }
    return good(read.result);
  }

  /** The accepted worst case and the month. */
  #moneyReady(kind: CallKind, acceptedWorstMicros: number, ready: { frame: MockMotionFrame; sha: string }): Out<{ frame: MockMotionFrame; sha: string }> {
    const { worstMicros } = priceOf(kind);
    if (worstMicros > acceptedWorstMicros) return bad({ code: "PRICE_CHANGED", detail: `the worst case is now ${worstMicros} µ$, above the accepted ${acceptedWorstMicros} µ$` });
    const committed = this.#ports.committedMicros();
    if (committed + worstMicros > this.#ports.monthlyBudgetMicros()) {
      return bad({ code: "BUDGET_EXCEEDED", detail: `committed ${committed} µ$ + this job's worst case ${worstMicros} µ$ > the monthly budget ${this.#ports.monthlyBudgetMicros()} µ$` });
    }
    return good(ready);
  }

  async suggestMotions(payload: CommandPayload<"clips.suggestMotions">): Promise<Out<ClipSuggestResult>> {
    const entered = this.#enter("suggest", payload.avatarId, payload.photoId);
    if (!entered.ok) return entered;
    try {
      const ready = this.#prepare("suggest", payload.avatarId, payload.photoId, payload.acceptedWorstMicros);
      if (!ready.ok) return ready;
      return await this.#suggest(payload.avatarId, payload.photoId, ready.result);
    } finally {
      entered.result();
    }
  }

  async translateIdea(payload: CommandPayload<"clips.translateIdea">): Promise<Out<ClipTranslateResult>> {
    const entered = this.#enter("idea", payload.avatarId, payload.photoId);
    if (!entered.ok) return entered;
    try {
      const photo = this.#photoReady("idea", payload.avatarId, payload.photoId);
      if (!photo.ok) return photo;
      // S5.WC2c round 2 (M1), as the engine: the age guard on his own words, before any money; refused free and final.
      if (ownIdeaNamesAge(payload.text, photo.result.frame.level)) return good({ outcome: "rejected", problems: ["content"], costMicros: 0 });
      const ready = this.#moneyReady("idea", payload.acceptedWorstMicros, photo.result);
      if (!ready.ok) return ready;
      return await this.#translate(payload.avatarId, payload.photoId, payload.text, ready.result);
    } finally {
      entered.result();
    }
  }

  // ---------- one attempt ----------

  /** The model's next answer: the script's, else the default of the call. */
  #nextReply(kind: CallKind): MockModelReply {
    const scripted = this.#script.shift();
    if (scripted !== undefined) return scripted;
    return kind === "suggest" ? mockSuggestionAnswer(DEFAULT_SUGGESTIONS) : mockIdeaAnswer(DEFAULT_TRANSLATION);
  }

  /** Waits for the model: the demo's time, and the test's hold. */
  async #atTheModel(): Promise<void> {
    if (this.#callMs > 0) await this.#ports.sleep(this.#callMs);
    if (!this.#held) {
      await Promise.resolve();
      return;
    }
    this.#door ??= (() => {
      let open: () => void = () => undefined;
      const promise = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { promise, open };
    })();
    this.#atModel += 1;
    try {
      await this.#door.promise;
    } finally {
      this.#atModel -= 1;
    }
  }

  /** One attempt as the transport runs it: reserve (the month and the ledger permitting), send, close the reserve by the settle rule. */
  async #attempt(jobId: string, kind: CallKind, n: number, user: string): Promise<ChatStep> {
    const ports = this.#ports;
    const attemptId = `${jobId}:${kind === "suggest" ? "motion" : "idea"}#${n}`;
    const worstMicros = attemptWorstMicros(kind, user);
    // The budget's reserve: the ledger halted or needing a reconcile first (a bill above an earlier reserve stops it), then the call's own scope cap, then the month.
    const refusal = ports.reserveRefusal();
    if (refusal !== null) return { kind: "error", error: refusal, costMicros: 0, leftOpen: false };
    let inScope = 0;
    for (const earlier of this.#lines) if (earlier.attemptId.startsWith(`${jobId}:`)) inScope += earlier.state === "open" ? earlier.worstMicros : earlier.costMicros;
    if (inScope + worstMicros > priceOf(kind).worstMicros) return { kind: "no-room", costMicros: 0 };
    if (ports.committedMicros() + worstMicros > ports.monthlyBudgetMicros()) return { kind: "no-room", costMicros: 0 };
    const line: Line = { attemptId, worstMicros, state: "open", costMicros: 0, estimated: false };
    this.#lines.push(line);
    ports.reserves.set(attemptId, worstMicros);
    const epoch = this.#epoch;
    await this.#atTheModel();
    // The process died while the request was out: no answer, the reserve stays as the dead process left it.
    if (epoch !== this.#epoch) return { kind: "error", error: { code: "INTERNAL", detail: "the engine restarted" }, costMicros: 0, leftOpen: true };
    const reply = this.#nextReply(kind);
    const settle = (costMicros: number, estimated = false): void => {
      line.state = "settled";
      line.costMicros = costMicros;
      line.estimated = estimated;
      ports.reserves.delete(attemptId);
      ports.spend(costMicros);
      // A bill above the reserve is recorded, and the ledger stops (`SETTLE_ABOVE_WORST`): the next reserve of any kind is refused. The answer is still used (engine/openrouter/transport.ts, `aboveWorst`).
      if (costMicros > worstMicros) ports.haltLedger();
    };
    const expected = priceOf(kind).expectedMicros;
    switch (reply.kind) {
      case "answer": {
        const costMicros = reply.costMicros ?? expected;
        settle(costMicros);
        return { kind: "answer", content: reply.content, costMicros };
      }
      case "empty": {
        const costMicros = reply.costMicros ?? expected;
        settle(costMicros);
        return { kind: "unreadable", costMicros };
      }
      case "unusable-body":
        // A paid body that cannot be read settles at the attempt's worst case (estimated) and ends the call: a second try would not help.
        settle(worstMicros, true);
        return { kind: "unreadable", costMicros: worstMicros, final: true };
      case "refused":
        settle(0);
        return { kind: "refused", costMicros: 0 };
      case "http": {
        settle(0);
        const code = reply.status === 401 ? "AUTH_INVALID" : reply.status === 402 ? "INSUFFICIENT_CREDITS" : reply.status === 429 ? "RATE_LIMITED" : "NETWORK";
        return { kind: "error", error: { code, detail: `HTTP ${reply.status}` }, costMicros: 0, leftOpen: false };
      }
      case "timeout":
        return { kind: "error", error: { code: "TIMEOUT", detail: "no response within 60000 ms" }, costMicros: 0, leftOpen: true };
      case "network":
        return { kind: "error", error: { code: "NETWORK", detail: "fetch failed" }, costMicros: 0, leftOpen: true };
    }
  }

  /** The call's scope: capped at its worst case while it runs, in every ending. */
  async #capped<T>(jobId: string, kind: CallKind, run: () => Promise<T>): Promise<T> {
    const before = this.#lines.length;
    this.#caps.set(jobId, priceOf(kind).worstMicros);
    try {
      return await run();
    } finally {
      this.#caps.delete(jobId);
      if (this.#lines.length !== before) this.#ports.emitMoney();
    }
  }

  // ---------- the vision writer ----------

  async #suggest(avatarId: string, photoId: string, ready: { frame: MockMotionFrame; sha: string }): Promise<Out<ClipSuggestResult>> {
    const jobId = this.#ports.nextId("job");
    // S5.WCX, as the engine: the writer is told what the sheet lists (the frame's scene and code motions and the suggestions on the sheet), as data.
    const passes = (item: StoredItem): boolean => checkModelText(ready.frame, item.text, "vision").problems.length === 0;
    const listed = [...ready.frame.offered.map(sameText), ...sheetVisionTexts(this.#read(avatarId, photoId, ready.sha).items, passes)];
    const outcome = await this.#capped(jobId, "suggest", () => this.#runWriter(jobId, photoId, ready.frame, listed));
    if (outcome.kind === "error") {
      if (outcome.error.code === "AUTH_INVALID") this.#ports.markKeyRejected();
      return bad(outcome.error);
    }
    if (outcome.kind === "none") return good({ outcome: "none", costMicros: outcome.costMicros });
    const store = this.#read(avatarId, photoId, ready.sha);
    // The engine's rule (clips/motionService.ts): known = the frame's scene and code motions and the suggestions on the sheet (the newest three; an own idea is another source); nothing new writes nothing, the reading included.
    const known = [...ready.frame.offered.map(sameText), ...sheetVisionTexts(store.items, (item) => checkModelText(ready.frame, item.text, "vision").problems.length === 0)];
    const { fresh, repeated } = freshDrafts(outcome.drafts, known);
    if (fresh.length === 0) return good(repeated ? { outcome: "none", reason: "repeated", costMicros: outcome.costMicros } : { outcome: "none", costMicros: outcome.costMicros });
    const made = addItems(store, "vision", fresh);
    store.reading = outcome.reading;
    if (made.length === 0) return good({ outcome: "none", costMicros: outcome.costMicros });
    return good({ outcome: "ok", motions: made.map(choiceOf).map((m) => ({ ...m, source: "vision" as const })), reading: outcome.reading, costMicros: outcome.costMicros });
  }

  async #runWriter(
    jobId: string,
    photoId: string,
    frame: MockMotionFrame,
    listed: readonly string[],
  ): Promise<{ kind: "ok"; drafts: { label: string; text: string }[]; reading: ClipFrameReading; costMicros: number } | { kind: "none"; costMicros: number } | { kind: "error"; error: EngineError; costMicros: number }> {
    let cost = 0;
    // What the next attempt is told: the closed codes of what was wrong with the last answer, never a text.
    let feedback: Feedback = [];
    for (let attempt = 1; attempt <= MOTION_MAX_ATTEMPTS; attempt++) {
      const user = JSON.stringify({ frame: framePayloadOf(frame), listed, ...(feedback.length === 0 ? {} : { problems: feedback }) });
      const step = await this.#attempt(jobId, "suggest", attempt, user);
      cost += step.costMicros;
      if (step.kind === "refused") return { kind: "none", costMicros: cost };
      if (step.kind === "no-room") {
        return attempt === 1 ? { kind: "error", error: { code: "BUDGET_EXCEEDED", detail: "the month has no room for the motion writer's call" }, costMicros: cost } : { kind: "none", costMicros: cost };
      }
      if (step.kind === "error") return endsAsResult(step, cost - step.costMicros) ? { kind: "none", costMicros: cost } : { kind: "error", error: step.error, costMicros: cost };
      if (step.kind === "unreadable") {
        if (step.final === true) return { kind: "none", costMicros: cost };
        feedback = ["unreadable"];
        continue;
      }
      const answer = readWriterAnswer(step.content);
      if (answer === null) {
        feedback = ["unreadable"];
        continue;
      }
      const drafts: { label: string; text: string }[] = [];
      const seen = new Set<string>();
      let mayHelp = false;
      const repairable = new Set<MotionProblem>();
      for (const [i, motion] of answer.motions.entries()) {
        const label = cleanLabel(motion.label_ru);
        const { text, problems } = checkModelText(frame, motion.text_en, "vision");
        if (problems.length > 0) {
          this.#ports.log(`[clip] photo ${photoId}: suggestion ${i + 1} of ${answer.motions.length} dropped (${problems.join(", ")})`);
          if (mayRepair(frame, text, "vision")) {
            mayHelp = true;
            for (const problem of problems) repairable.add(problem);
          }
          continue;
        }
        if (label === null) {
          this.#ports.log(`[clip] photo ${photoId}: suggestion ${i + 1} of ${answer.motions.length} dropped (no label)`);
          continue;
        }
        if (seen.has(sameText(text))) continue;
        seen.add(sameText(text));
        drafts.push({ label, text });
      }
      if (drafts.length > 0) return { kind: "ok", drafts, reading: readingOf(answer.frame), costMicros: cost };
      if (!mayHelp) return { kind: "none", costMicros: cost };
      const codes = MOTION_PROBLEMS.filter((problem) => repairable.has(problem));
      feedback = codes.length === 0 ? ["unreadable"] : codes;
    }
    return { kind: "none", costMicros: cost };
  }

  // ---------- the translator ----------

  async #translate(avatarId: string, photoId: string, idea: string, ready: { frame: MockMotionFrame; sha: string }): Promise<Out<ClipTranslateResult>> {
    const jobId = this.#ports.nextId("job");
    const outcome = await this.#capped(jobId, "idea", () => this.#runTranslator(jobId, idea, ready.frame));
    if (outcome.kind === "error") {
      if (outcome.error.code === "AUTH_INVALID") this.#ports.markKeyRejected();
      return bad(outcome.error);
    }
    if (outcome.kind === "none") return good({ outcome: "none", costMicros: outcome.costMicros });
    if (outcome.kind === "rejected") return good({ outcome: "rejected", problems: outcome.problems, costMicros: outcome.costMicros });
    // The engine cuts the label from his words; the store keeps that label and the English text, never the idea.
    const store = this.#read(avatarId, photoId, ready.sha);
    const made = addItems(store, "own", [{ label: ownIdeaLabel(idea), text: outcome.text }])[0];
    if (made === undefined) return good({ outcome: "none", costMicros: outcome.costMicros });
    return good({ outcome: "ok", item: { ...choiceOf(made), source: "own" as const }, costMicros: outcome.costMicros });
  }

  async #runTranslator(
    jobId: string,
    idea: string,
    frame: MockMotionFrame,
  ): Promise<{ kind: "ok"; text: string; costMicros: number } | { kind: "rejected"; problems: MotionProblem[]; costMicros: number } | { kind: "none"; costMicros: number } | { kind: "error"; error: EngineError; costMicros: number }> {
    let cost = 0;
    let lastProblems: MotionProblem[] | null = null;
    const settled = (): { kind: "rejected"; problems: MotionProblem[]; costMicros: number } | { kind: "none"; costMicros: number } =>
      lastProblems === null ? { kind: "none", costMicros: cost } : { kind: "rejected", problems: lastProblems, costMicros: cost };
    let feedback: Feedback = [];
    let previous: string | null = null;
    for (let attempt = 1; attempt <= MOTION_MAX_ATTEMPTS; attempt++) {
      // The idea is a value inside JSON (data, never instructions), alone: nothing of the frame (S5.WCX); the feedback is closed codes and the previous text only when it is plain motion English.
      const user = JSON.stringify({ idea, ...(feedback.length === 0 ? {} : { problems: feedback }), ...(previous === null ? {} : { previous }) });
      const step = await this.#attempt(jobId, "idea", attempt, user);
      cost += step.costMicros;
      if (step.kind === "refused") return settled();
      if (step.kind === "no-room") {
        return attempt === 1 ? { kind: "error", error: { code: "BUDGET_EXCEEDED", detail: "the month has no room for the translator's call" }, costMicros: cost } : settled();
      }
      if (step.kind === "error") return endsAsResult(step, cost - step.costMicros) ? settled() : { kind: "error", error: step.error, costMicros: cost };
      if (step.kind === "unreadable") {
        if (step.final === true) return settled();
        feedback = ["unreadable"];
        previous = null;
        continue;
      }
      const answer = readIdeaAnswer(step.content);
      if (answer === null) {
        feedback = ["unreadable"];
        previous = null;
        continue;
      }
      // S5.WCX: the translator's own refusal is final.
      if (answer.kind === "refusal") return { kind: "rejected", problems: [answer.code], costMicros: cost };
      const { text, problems } = checkModelText(frame, answer.text, "own");
      if (problems.length === 0) return { kind: "ok", text, costMicros: cost };
      lastProblems = problems;
      // The age guard's refusal gets no repair (S5.WC2c), nor her phone or her face (S5.WCX: only a change of the idea fixes those).
      if (!mayRepair(frame, text, "own") || problems.some((problem) => problem === "phone" || problem === "face-hidden")) return settled();
      feedback = problems;
      previous = MOTION_ENGLISH.test(text) ? text.slice(0, PREVIOUS_MAX_CHARS) : null;
    }
    return settled();
  }
}

/** Held to the engine's closed list by the table test: every problem a rejection can carry. */
export const MOCK_MOTION_PROBLEMS: readonly MotionProblem[] = MOTION_PROBLEMS;
