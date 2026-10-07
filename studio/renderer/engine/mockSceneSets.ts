import {
  ideaNamesMirror,
  isCustomCategory,
  MAX_COMPOSE_SCENES,
  orderCategories,
  PROTOCOL_VERSION,
  SCENE_CHUNK_ATTEMPTS,
  SCENE_CHUNK_SIZE,
  SCENE_TEXT_MAX,
  splitCount,
  youthWords,
  type CategoryRef,
  type CategorySummary,
  type EngineError,
  type JobState,
  type ScenePlace,
  type ScenePose,
  type SceneEditOp,
  type SceneGaveUpBy,
  type SceneComposeTally,
  type SceneProblem,
  type SceneReason,
  type SceneSetView,
  type SceneStoppedBy,
  type SceneView,
  type UnsequencedEvent,
} from "../../shared/engine";
import { mockAnglesOf } from "./mockCategories";
import type { Scheduler } from "./scheduler";

// The mock's scene sets (CS.4a): what the engine's store, view builder, edit rules and writer job do, with no disk, no ledger and no model. A set is
// planned deterministically from its id's position and the request, the writer's sentences are made from the scene, and the money is the engine's own at
// the fallback prices, so a dev build and a test see the same numbers twice. The mock engine owns the gates (key, ledger, price, month) and the events'
// transport; this owns the sets, their jobs and the order of their refusals after the gates.
//
// The invariants are the engine's: answered attempts per chunk are at most two across ALL jobs (an open reserve counts as answered until the reconcile,
// and as a settle at its worst case after it), a chunk's ids are four and never reused, a chunk a job gave up on is never asked again, and the job goes on
// past it. `status` and `stoppedBy` are derived, never stored.

/** One writer attempt at its ceilings at the fallback prices (14K in at $1.25/M, 8K out at $2.50/M). */
export const MOCK_SCENE_ATTEMPT_WORST = 37_500;
/** The writer's typical tokens per scene (106 in, 130 out) at the same prices, in micro-dollars; 20 scenes expect $0.00915. */
const TYPICAL_PER_SCENE = 457.5;
/** What a rejected answer cost: its tokens, paid and unusable. */
const REJECTED_COST = 2_000;
/** Writer ids per chunk: the answered attempts plus two spares for attempts that got no answer. */
const IDS_PER_CHUNK = SCENE_CHUNK_ATTEMPTS + 2;
const CANCEL_CONFIRM_MS = 50;

/** What the next request of a writer job comes back as (`failNextSceneAttempt`); an unscripted one is a good answer, and `ok` scripts one explicitly. */
export type MockSceneAttempt = "ok" | "rejected" | "refused" | "rate-limited" | "provider-error" | "network" | "timeout";

/** A set seeded as a compose would have left it. */
export interface MockSceneSetSeed {
  avatarId: string;
  sceneSetId: string;
  count: number;
  /** The first N scenes have a sentence, in whole chunks' order. */
  written?: number;
  /** The write that did not finish: the set reads stopped, for this reason (`closed` when no outcome was kept). Absent: the set is ready. */
  stopped?: SceneStoppedBy;
  /**
   * CS.6: the request a closed Studio cut off: this chunk's attempt keeps its reserve open at the worst case (an answered attempt, waiting for the
   * reconcile), as the engine's ledger holds it after a crash mid-request.
   */
  cutOff?: { chunk: number };
  categories?: readonly CategoryRef[];
  /** The text model the set was made with; the mock's default when absent. */
  textModel?: string;
  /**
   * The scenes themselves, instead of the mock's own plan (the parity rig seeds the real engine's store with the very same ones). A `text` is a written scene;
   * an `idea` makes an own scene (written from it, with its text).
   */
  scenes?: readonly (
    | { category: CategoryRef; shot: SceneView["shot"]; pose: SceneView["pose"]; place: ScenePlace; text?: string }
    | { idea: string; shot: SceneView["shot"]; pose: SceneView["pose"]; text: string }
  )[];
  /** Writes already started (a seeded review write has a number under it). */
  writes?: number;
  /**
   * Review writes a closed Studio left unresolved: nothing was reserved for them yet, so each has both attempts, unless `cutOff` says the Studio closed
   * while its request was out (CS.6): that attempt keeps its reserve open at the worst case, as `cutOff` does for a chunk.
   */
  reviewWrites?: readonly (
    | { kind: "rewrite"; k: number; sceneIds: number[]; redraw?: boolean; stoppedBy?: Exclude<SceneStoppedBy, "closed">; cutOff?: boolean }
    | { kind: "idea"; k: number; idea: string; count: number; shot: SceneView["shot"] | null; sceneIds: number[]; stoppedBy?: Exclude<SceneStoppedBy, "closed">; cutOff?: boolean }
  )[];
}

interface Attempt {
  key: string;
  /** Answered: a settled paid answer, or a reserve that may have been billed. */
  paid: boolean;
  /** What it cost once closed. */
  cost: number;
  /** Reserved and not closed by the engine: counted at its worst case until a reconcile. */
  open: boolean;
}

interface Chunk {
  chunk: number;
  sceneIds: number[];
  attempts: Attempt[];
  gaveUp?: "rejected" | "refused";
}

interface Scene {
  sceneId: number;
  /** An own scene (written from an idea) has no category and no place. */
  category: CategoryRef | "own";
  shot: SceneView["shot"];
  pose: SceneView["pose"];
  place: ScenePlace | null;
  /** The idea an own scene was written from; null for a planned one. */
  idea: string | null;
  text: string | null;
  edited: boolean;
  removed: boolean;
}

/** A rewrite or an idea write of the review (CS.4b): one request under ids of its own, kept for the money it spent and the ids it burnt. */
interface Review {
  k: number;
  kind: "rewrite" | "idea";
  closed: boolean;
  /** A rewrite names its targets; an idea write names the scene ids it reserved. */
  sceneIds: number[];
  redraw: boolean;
  /** What a redraw drew for each target, kept until its sentence is accepted. */
  draws: Map<number, { place: ScenePlace; shot: SceneView["shot"]; pose: SceneView["pose"] }>;
  idea?: string;
  shot?: SceneView["shot"] | null;
  /** The shot and pose drawn for each scene an idea write will add. */
  own: { sceneId: number; shot: SceneView["shot"]; pose: SceneView["pose"] }[];
  /** What a redraw will refresh the set's snapshot of each custom category with: the name and the angles the library had when the write was PLANNED, kept until accepted. */
  snapshots: { ref: CategoryRef; name: string | null; poses?: ScenePose[] }[];
  attempts: Attempt[];
  stoppedBy?: Exclude<SceneStoppedBy, "closed">;
  stoppedError?: EngineError;
}

/** What a review write is, once planned and found allowed: the engine's `ReviewPlan`. */
export interface MockReviewPlan {
  kind: "rewrite" | "idea";
  k: number;
  count: number;
  sceneIds?: number[];
  attemptsLeft: number;
  begin: (set: MockSet) => Review;
}

type ReviewTarget =
  | { kind: "rewrite"; sceneIds: number[]; redraw: boolean }
  | { kind: "idea"; idea: string; count: number; shot: SceneView["shot"] | null }
  | { kind: "resume"; write: number };

/** The most scenes a set holds, and the most scenes one write covers. */
const SET_ROOM = 200;
const MAX_REVIEW_RECORDS = 500;

interface MockSet {
  sceneSetId: string;
  avatarId: string;
  createdAt: string;
  revision: number;
  runId: string;
  poses: { profile: boolean; back: boolean };
  categories: { ref: CategoryRef; name: string | null; poses?: ScenePose[] }[];
  scenes: Scene[];
  chunks: Chunk[];
  write: { k: number; kind: "compose" | "unwritten"; stoppedBy?: Exclude<SceneStoppedBy, "closed">; stoppedError?: EngineError } | null;
  /** The rewrites and idea writes of the review, in the order they began. */
  reviews: Review[];
  writes: number;
  /** The write that last refreshed each category's snapshot: an older write that finishes later does not undo a newer one's (the engine's `snapshotWrites`). */
  snapshotWrites: Map<string, number>;
  used: boolean;
  /** The text model the set was made with (the settings may change it later; the set keeps its own). */
  textModel: string;
  /** The counters when the last write job ended, as the compose said them; absent until a job ended. */
  lastOutcome?: SceneComposeTally;
}

interface Job {
  jobId: string;
  sceneSetId: string;
  avatarId: string;
  kind: "compose" | "unwritten" | "rewrite" | "idea";
  /** The write's number and its scenes, for a rewrite or an idea write. */
  k?: number;
  sceneIds?: number[];
  status: JobState["status"];
  done: number;
  total: number;
  error: EngineError | null;
  written: number;
  unwritten: number;
  timers: (() => void)[];
  /** The chunks still to be asked, in order. */
  queue: number[];
}

export interface MockSceneSetDeps {
  scheduler: Scheduler;
  stepMs: number;
  nextId: (prefix: string) => string;
  nowIso: () => string;
  emit: (event: UnsequencedEvent) => void;
  textModel: () => string;
  /** The custom category the library holds, for its pool and its name. */
  category: (ref: string) => CategorySummary | undefined;
  /** Whether the mock's money holds this attempt's reserve open (a reconcile closes every one). */
  reserveOpen: (key: string) => boolean;
  openReserve: (key: string, worstMicros: number) => void;
  spend: (micros: number) => void;
  emitMoney: () => void;
  /** Makes the next paid call wait for a reconcile (an open reserve of a request that may have been billed). */
  needReconcile: () => void;
  /** Whether the ledger can be read: a set's spend is known only then (null, null when it cannot). */
  ledgerReadable: () => boolean;
  /** Whether a cancel finds a request at the model (its reserve then stays open) or lands between requests (nothing is open). */
  cancelHasRequestOut: () => boolean;
}

/** The counters of the PLANNED scenes that are not removed, as they are now: own scenes are the owner's and are not part of what a compose wrote. */
function tallyOf(scenes: readonly SceneView[]): SceneComposeTally {
  const active = scenes.filter((s) => !s.removed && s.origin === "planned");
  return { total: active.length, written: active.filter((s) => s.text !== null).length, gaveUp: active.filter((s) => s.unwritten === "gave-up").length };
}

// ---------- the plan: deterministic, from the request ----------

interface PlaceTable {
  place: string;
  time: string;
  activity: string;
  outfit: string;
  mirror: boolean;
}

const BUILT_IN_PLACES: Record<string, readonly PlaceTable[]> = {
  home: [
    { place: "a sunny kitchen", time: "morning", activity: "pouring coffee", outfit: "a linen shirt and shorts", mirror: false },
    { place: "a cosy living room", time: "evening", activity: "reading on the sofa", outfit: "an oversized knit sweater", mirror: false },
    { place: "a bedroom mirror", time: "morning", activity: "fixing her hair", outfit: "a silk robe and slacks", mirror: true },
  ],
  travel: [
    { place: "an old town square", time: "midday", activity: "studying a map", outfit: "a denim jacket and a skirt", mirror: false },
    { place: "a seaside promenade", time: "golden hour", activity: "walking with a coffee", outfit: "a light summer dress", mirror: false },
    { place: "a hotel room mirror", time: "evening", activity: "adjusting a scarf", outfit: "a black midi dress", mirror: true },
  ],
  shoot: [
    { place: "a white studio", time: "studio lighting", activity: "turning to the light", outfit: "a tailored blazer and trousers", mirror: false },
    { place: "a brick loft", time: "midday", activity: "leaning on a wall", outfit: "a long camel coat", mirror: false },
  ],
  glam: [
    { place: "a rooftop bar", time: "night", activity: "holding a glass", outfit: "a satin evening dress", mirror: false },
    { place: "a hotel lobby mirror", time: "evening", activity: "checking her lipstick", outfit: "a velvet gown", mirror: true },
  ],
  fit: [
    { place: "a city park", time: "morning", activity: "stretching on the grass", outfit: "leggings and a fitted tee", mirror: false },
    { place: "a gym mirror", time: "midday", activity: "tying her shoes", outfit: "a training set", mirror: true },
  ],
};

const SHOTS: SceneView["shot"][] = ["friend", "selfie", "mirror", "candid"];
const SHOOT_SHOTS: SceneView["shot"][] = ["photographer", "candid", "photographer"];

/** The places a category draws from: a built-in's own, or the custom category's pool as the library holds it. */
function tablesOf(ref: CategoryRef, custom: CategorySummary | undefined): readonly PlaceTable[] {
  return custom !== undefined
    ? custom.pool.locations.map((l, i): PlaceTable => ({ place: l.name, time: l.times[0] ?? "midday", activity: l.activities[0]?.text ?? "standing", outfit: custom.pool.outfits[i % custom.pool.outfits.length] ?? "a plain dress", mirror: l.mirror }))
    : (BUILT_IN_PLACES[ref] ?? BUILT_IN_PLACES.home ?? []);
}

function planScenes(
  count: number,
  refs: readonly CategoryRef[],
  poses: { profile: boolean; back: boolean },
  category: (ref: string) => CategorySummary | undefined,
): Scene[] {
  const scenes: Scene[] = [];
  let index = 0;
  for (const { ref, count: n } of splitCount(count, refs)) {
    const custom = isCustomCategory(ref) ? category(ref) : undefined;
    const tables = tablesOf(ref, custom);
    const deck: SceneView["shot"][] = custom !== undefined ? [...custom.pool.shotDeck] : ref === "shoot" ? SHOOT_SHOTS : SHOTS;
    // CS.8a: a custom category with `poses` draws every pose from them (the run's toggles are not asked); a phone-in-hand shot that turns away takes another shot.
    const angles = custom?.pool.poses;
    for (let k = 0; k < n; k++) {
      index += 1;
      let shot = deck[k % deck.length] ?? "friend";
      const angled = angles === undefined ? undefined : anglePick(angles, k, shot, deck);
      if (angled !== undefined) shot = angled.shot;
      const mirrors = tables.filter((t) => t.mirror);
      // A mirror shot needs a mirror place; a deck with none draws no mirror shot.
      if (shot === "mirror" && mirrors.length === 0) shot = "friend";
      const row = shot === "mirror" ? (mirrors[k % mirrors.length] ?? tables[0]) : (tables.filter((t) => !t.mirror)[k % Math.max(1, tables.filter((t) => !t.mirror).length)] ?? tables[0]);
      if (row === undefined) throw new Error("the mock has no place to plan a scene in");
      // Selfies and mirror shots face the camera whatever the run allows; the others may turn when the run says so.
      const phone = shot === "selfie" || shot === "mirror";
      const pose: SceneView["pose"] =
        angled !== undefined
          ? angled.pose
          : phone || k % 5 < 3
            ? k % 2 === 0
              ? "front"
              : "three-quarter"
            : poses.profile && k % 5 === 3
              ? "profile"
              : poses.back && k % 5 === 4
                ? "back"
                : "three-quarter";
      scenes.push({ sceneId: index, category: ref, shot, pose, place: { location: row.place, timeOfDay: row.time, activity: row.activity, outfit: row.outfit }, idea: null, text: null, edited: false, removed: false });
    }
  }
  return scenes;
}

/** Whether a shot has the phone in hand: such a scene faces the camera. */
function holdsPhone(shot: SceneView["shot"]): boolean {
  return shot === "selfie" || shot === "mirror";
}

/**
 * CS.8a: the pose and shot of the k-th scene of a category whose description named its angles: the k-th pose of the list round and round, and, when it turns the
 * scene away (back or profile) while the shot holds a phone, the first shot of the deck nobody holds a phone for, or a friend when the deck has none (never the photographer: such a category is finished as a phone photo).
 */
export function anglePick(poses: readonly SceneView["pose"][], k: number, shot: SceneView["shot"], deck: readonly SceneView["shot"][]): { pose: SceneView["pose"]; shot: SceneView["shot"] } {
  const pose = poses[k % poses.length] ?? "front";
  if (!holdsPhone(shot) || pose === "front" || pose === "three-quarter") return { pose, shot };
  return { pose, shot: deck.find((candidate) => !holdsPhone(candidate)) ?? "friend" };
}

/** The angle an idea asks for in its own words («вид сзади», «в профиль», "back view"), or undefined when it says nothing: what the model would pick for «Авто». */
function ideaAngle(idea: string): "back" | "profile" | undefined {
  const angles = mockAnglesOf(idea);
  return angles.includes("back") ? "back" : angles.includes("profile") ? "profile" : undefined;
}

/** The sentence the mock's writer gives a scene; a write's number makes a rewrite say something new (the compose's own sentence is take 0, as before). */
function sentenceOf(scene: Scene, take = 0): string {
  const mark = take === 0 ? `${scene.sceneId}` : `${scene.sceneId}, take ${take}`;
  if (scene.place === null) return `She enjoys ${scene.idea ?? "a quiet moment"}, caught by a friend in the afternoon light (${mark}).`;
  return `A friend catches her ${scene.place.activity} at ${scene.place.location} in the ${scene.place.timeOfDay}, wearing ${scene.place.outfit} (${mark}).`;
}

/** The poses a set allows a scene: a selfie or mirror faces the camera whatever the set allows, the others may turn when it says so. */
function poseFor(shot: SceneView["shot"], poses: { profile: boolean; back: boolean }, n: number): SceneView["pose"] {
  if (shot === "selfie" || shot === "mirror") return n % 2 === 0 ? "front" : "three-quarter";
  const allowed: SceneView["pose"][] = ["front", "three-quarter", ...(poses.profile ? (["profile"] as const) : []), ...(poses.back ? (["back"] as const) : [])];
  return allowed[n % allowed.length] ?? "front";
}

/** What «Авто» draws a shot from: never the mirror (an own scene has no place for one to sit on). */
const AUTO_SHOTS: SceneView["shot"][] = ["friend", "selfie", "candid"];

/** The attempts a review write may still use: the answered ones are at most two across all jobs, and its four ids are never reused. */
function reviewLeft(review: Review): number {
  if (review.closed) return 0;
  const answered = review.attempts.filter((a) => a.paid).length;
  return Math.max(0, Math.min(SCENE_CHUNK_ATTEMPTS - answered, IDS_PER_CHUNK - review.attempts.length));
}

function chunksOf(setId: string, scenes: readonly Scene[]): Chunk[] {
  const chunks: Chunk[] = [];
  for (let i = 0; i < scenes.length; i += SCENE_CHUNK_SIZE) {
    chunks.push({ chunk: chunks.length + 1, sceneIds: scenes.slice(i, i + SCENE_CHUNK_SIZE).map((s) => s.sceneId), attempts: [] });
  }
  void setId;
  return chunks;
}

/** A VALIDATION of a scene-set command with its closed reason (and the scene it is about, when it is about one): the engine's `sceneRefusal`. */
function refuse(detail: string, sceneReason: SceneReason, sceneId?: number): EngineError {
  return { code: "VALIDATION", detail, sceneReason, ...(sceneId === undefined ? {} : { sceneId }) };
}

// ---------- the text rules (the engine's `textProblem`) ----------

/** The assembler's revealing words (studio/engine/scenes/words.ts), exactly: the parity suite plays a text with one through both engines. */
const REVEALING_WORDS = /\b(bikini|swimsuit|swimwear|lingerie|sports bra|thong|stockings?|slip dress|robe over lingerie)\b/i;
const LINE_BREAK = new RegExp(`[\\n\\r${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`);

/** Whether a stored text breaks the assembler's word rules now (a youth word, a revealing word): the engine's `sentenceProblems`, checked at an approval. */
function breaksWordRules(text: string): boolean {
  return youthWords(text, "descriptor").length > 0 || new RegExp(REVEALING_WORDS, "i").test(text);
}

function textProblem(text: string): SceneProblem | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { reason: "empty", words: [] };
  if (trimmed.length > SCENE_TEXT_MAX) return { reason: "too-long", words: [] };
  if (LINE_BREAK.test(trimmed)) return { reason: "not-one-line", words: [] };
  if (/\p{Cc}/u.test(trimmed)) return { reason: "control-char", words: [] };
  const youth = youthWords(trimmed, "descriptor");
  if (youth.length > 0) return { reason: "youth-word", words: youth.slice(0, 12).map((w) => w.slice(0, 64)) };
  const revealing = Array.from(trimmed.matchAll(new RegExp(REVEALING_WORDS, "gi")), (m) => m[0]);
  if (revealing.length > 0) return { reason: "revealing-word", words: revealing.slice(0, 12).map((w) => w.slice(0, 64)) };
  return null;
}

// ---------- the library of sets ----------

export class MockSceneSets {
  readonly #deps: MockSceneSetDeps;
  #sets: MockSet[] = [];
  #jobs: Job[] = [];
  /** Set files the library could not read: one number for every avatar, or a number per avatar. */
  #unreadable: number | Readonly<Record<string, number>> = 0;
  #scripted: MockSceneAttempt[] = [];

  constructor(deps: MockSceneSetDeps, seeds: readonly MockSceneSetSeed[] = [], unreadable: number | Readonly<Record<string, number>> = 0) {
    this.#deps = deps;
    this.#unreadable = unreadable;
    for (const seed of seeds) this.#seed(seed);
  }

  #seed(seed: MockSceneSetSeed): void {
    const refs = seed.categories ?? ["home"];
    const scenes: Scene[] =
      seed.scenes === undefined
        ? planScenes(seed.count, refs, { profile: false, back: false }, this.#deps.category)
        : seed.scenes.map(
            (s, i): Scene =>
              "idea" in s
                ? { sceneId: i + 1, category: "own", shot: s.shot, pose: s.pose, place: null, idea: s.idea, text: s.text, edited: false, removed: false }
                : { sceneId: i + 1, category: s.category, shot: s.shot, pose: s.pose, place: { ...s.place }, idea: null, text: s.text ?? null, edited: false, removed: false },
          );
    const chunks = chunksOf(seed.sceneSetId, scenes.filter((scene) => scene.place !== null));
    const written = seed.written ?? 0;
    if (seed.scenes === undefined) for (const scene of scenes) if (scene.sceneId <= written) scene.text = sentenceOf(scene);
    // A chunk whose scenes were written was answered once.
    for (const chunk of chunks) {
      if (chunk.sceneIds.every((id) => id <= written)) chunk.attempts.push({ key: `${seed.sceneSetId}:writer-${chunk.chunk}#1`, paid: true, cost: Math.round(chunk.sceneIds.length * TYPICAL_PER_SCENE), open: false });
    }
    // A request the closed Studio cut off: its reserve stays open at the worst case and counts as answered, until the reconcile closes it there.
    const cutOff = (key: string): Attempt => {
      this.#deps.openReserve(key, MOCK_SCENE_ATTEMPT_WORST);
      this.#deps.needReconcile();
      return { key, paid: true, cost: 0, open: true };
    };
    if (seed.cutOff !== undefined) {
      const chunk = chunks.find((c) => c.chunk === seed.cutOff?.chunk);
      if (chunk === undefined) throw new Error(`the seed has no chunk ${seed.cutOff.chunk} to cut off`);
      chunk.attempts.push(cutOff(`${seed.sceneSetId}:writer-${chunk.chunk}#${chunk.attempts.length + 1}`));
    }
    const stopped = seed.stopped;
    this.#sets.push({
      sceneSetId: seed.sceneSetId,
      avatarId: seed.avatarId,
      createdAt: this.#deps.nowIso(),
      revision: 1,
      runId: this.#deps.nextId("run"),
      poses: { profile: false, back: false },
      categories: refs.map((ref) => this.#categoryEntry(ref)),
      scenes,
      chunks,
      write: stopped === undefined ? null : { k: 1, kind: "compose", ...(stopped === "closed" ? {} : { stoppedBy: stopped, ...(stopped === "failed" ? { stoppedError: { code: "INTERNAL" as const } } : {}) }) },
      reviews: (seed.reviewWrites ?? []).map((w): Review => {
        const attempts = w.cutOff === true ? [cutOff(`${seed.sceneSetId}:write-${w.k}#1`)] : [];
        const base = { k: w.k, closed: false, redraw: false, draws: new Map(), snapshots: [], attempts, ...(w.stoppedBy === undefined ? {} : { stoppedBy: w.stoppedBy }) };
        return w.kind === "rewrite"
          ? { ...base, kind: "rewrite", sceneIds: [...w.sceneIds], redraw: w.redraw === true, own: [] }
          : { ...base, kind: "idea", sceneIds: [...w.sceneIds], idea: w.idea, shot: w.shot, own: w.sceneIds.map((sceneId) => ({ sceneId, shot: w.shot ?? "friend", pose: "front" as const })) };
      }),
      writes: Math.max(seed.writes ?? 0, ...(seed.reviewWrites ?? []).map((w) => w.k), stopped === undefined ? 0 : 1),
      snapshotWrites: new Map(),
      used: false,
      // A seed is built before the settings exist: the mock's default text model, as a set made at first launch has.
      textModel: seed.textModel ?? "x-ai/grok-4.3",
    });
  }

  // ---------- controls ----------

  /** The next request of a writer job comes back as `outcome` (queued: the requests after it are unscripted again, good answers). */
  failNextSceneAttempt(outcome: MockSceneAttempt): void {
    this.#scripted.push(outcome);
  }

  /** The set's run was started: its run's folder exists, so it is read-only. */
  markUsed(sceneSetId: string): void {
    const set = this.#sets.find((s) => s.sceneSetId === sceneSetId);
    if (set !== undefined) set.used = true;
  }

  // ---------- reading ----------

  find(sceneSetId: string): MockSet | undefined {
    return this.#sets.find((s) => s.sceneSetId === sceneSetId);
  }

  /** Whether a scenes job of this avatar is queued or running. */
  liveFor(avatarId: string): boolean {
    return this.#jobs.some((j) => j.avatarId === avatarId && j.status === "running");
  }

  /** The jobs queued or running, for what a library switch or a reconcile waits for. */
  running(): { status: JobState["status"] }[] {
    return this.#jobs.filter((j) => j.status === "running");
  }

  #liveJob(sceneSetId: string): Job | undefined {
    return this.#jobs.find((j) => j.sceneSetId === sceneSetId && j.status === "running");
  }

  isLive(sceneSetId: string): boolean {
    return this.#liveJob(sceneSetId) !== undefined;
  }

  /** The avatar's open set, else its newest. Null with none. */
  get(avatarId: string): { sceneSet: SceneSetView | null; unreadable: number } {
    const mine = this.#sets.filter((s) => s.avatarId === avatarId);
    const shown = [...mine].reverse().find((s) => !s.used) ?? mine.at(-1);
    const unreadable = typeof this.#unreadable === "number" ? this.#unreadable : (this.#unreadable[avatarId] ?? 0);
    return { sceneSet: shown === undefined ? null : this.view(shown), unreadable };
  }

  hasOpenSet(avatarId: string): boolean {
    return this.#sets.some((s) => s.avatarId === avatarId && !s.used);
  }

  jobStates(): JobState[] {
    return this.#jobs.map((j) => this.jobState(j));
  }

  jobState(j: Job): JobState {
    const base = { kind: "scenes" as const, jobId: j.jobId, sceneSetId: j.sceneSetId, avatarId: j.avatarId, status: j.status, done: j.done, total: j.total };
    if (j.status === "done") return { ...base, result: { kind: "scenes", sceneSetId: j.sceneSetId, avatarId: j.avatarId, written: j.written, unwritten: j.unwritten } };
    if (j.status === "failed" && j.error !== null) return { ...base, error: j.error };
    return base;
  }

  // ---------- attempts, per chunk, across all jobs ----------

  #answered(chunk: Chunk): number {
    return chunk.attempts.filter((a) => a.paid).length;
  }

  #attemptsLeft(chunk: Chunk): number {
    return chunk.gaveUp === undefined ? Math.max(0, Math.min(SCENE_CHUNK_ATTEMPTS - this.#answered(chunk), IDS_PER_CHUNK - chunk.attempts.length)) : 0;
  }

  #request(set: MockSet, chunk: Chunk): number[] {
    return set.scenes.filter((s) => chunk.sceneIds.includes(s.sceneId) && !s.removed && s.text === null).map((s) => s.sceneId);
  }

  #pending(set: MockSet): { chunk: Chunk; ids: number[] }[] {
    return set.chunks.flatMap((chunk) => {
      const ids = this.#request(set, chunk);
      return ids.length > 0 && this.#attemptsLeft(chunk) > 0 ? [{ chunk, ids }] : [];
    });
  }

  #chunkGaveUpBy(set: MockSet, chunk: Chunk): SceneGaveUpBy | null {
    if (chunk.gaveUp !== undefined) return chunk.gaveUp;
    const lacksText = set.scenes.some((s) => chunk.sceneIds.includes(s.sceneId) && s.text === null);
    return this.#attemptsLeft(chunk) === 0 && lacksText ? "no-attempts" : null;
  }

  /** The price of «Дописать»: each chunk still to write at the attempts it has left. */
  writePrice(set: MockSet): { expected: number; worst: number } {
    let worst = 0;
    let scenes = 0;
    for (const { chunk, ids } of this.#pending(set)) {
      worst += this.#attemptsLeft(chunk) * MOCK_SCENE_ATTEMPT_WORST;
      scenes += ids.length;
    }
    return { expected: Math.min(Math.round(scenes * TYPICAL_PER_SCENE), worst), worst };
  }

  /** The price of composing `count` scenes: chunks of 25, two attempts each. */
  composePrice(count: number): { expected: number; worst: number } {
    if (count === 0) return { expected: 0, worst: 0 };
    const worst = Math.ceil(count / SCENE_CHUNK_SIZE) * SCENE_CHUNK_ATTEMPTS * MOCK_SCENE_ATTEMPT_WORST;
    return { expected: Math.min(Math.round(count * TYPICAL_PER_SCENE), worst), worst };
  }

  // ---------- the view ----------

  view(set: MockSet): SceneSetView {
    const live = this.#liveJob(set.sceneSetId);
    const liveK = live?.k;
    const pending = this.#pending(set).length > 0;
    const stopped = !set.used && live === undefined && set.write !== null && pending;
    const status: SceneSetView["status"] = set.used ? "used" : live !== undefined ? "writing" : stopped ? "stopped" : "ready";
    const stoppedBy: SceneStoppedBy | null = stopped ? (set.write?.stoppedBy ?? "closed") : null;
    let spent = 0;
    let open = 0;
    for (const attempt of [...set.chunks.flatMap((c) => c.attempts), ...set.reviews.flatMap((r) => r.attempts)]) {
      if (attempt.open && this.#deps.reserveOpen(attempt.key)) {
        spent += MOCK_SCENE_ATTEMPT_WORST;
        open += MOCK_SCENE_ATTEMPT_WORST;
      } else if (attempt.open) {
        // The reconcile closed it at its worst case.
        spent += MOCK_SCENE_ATTEMPT_WORST;
      } else {
        spent += attempt.cost;
      }
    }
    // The writes that can still be carried on and that no job runs now: their scenes are flagged, their ideas listed (CS.4b).
    const interrupted = set.reviews.filter((r) => !r.closed && r.k !== liveK && reviewLeft(r) > 0);
    const markers = new Map<number, { write: number; stoppedBy: SceneStoppedBy }>();
    for (const review of interrupted) if (review.kind === "rewrite") for (const sceneId of review.sceneIds) markers.set(sceneId, { write: review.k, stoppedBy: review.stoppedBy ?? "closed" });
    const scenes: SceneView[] = set.scenes.map((scene): SceneView => {
      const marker = markers.get(scene.sceneId);
      const mark = marker === undefined ? {} : { rewriteInterrupted: marker };
      if (scene.place === null || scene.category === "own") {
        return {
          sceneId: scene.sceneId,
          origin: "own",
          category: "own",
          categoryName: null,
          shot: scene.shot,
          pose: scene.pose,
          place: null,
          idea: scene.idea,
          text: scene.text,
          edited: scene.edited,
          removed: scene.removed,
          unwritten: null,
          gaveUpBy: null,
          chunk: null,
          ...mark,
        };
      }
      const chunk = set.chunks.find((c) => c.sceneIds.includes(scene.sceneId));
      const gaveUpBy = scene.text === null && chunk !== undefined ? this.#chunkGaveUpBy(set, chunk) : null;
      return {
        sceneId: scene.sceneId,
        origin: "planned",
        category: scene.category,
        categoryName: isCustomCategory(scene.category) ? (set.categories.find((c) => c.ref === scene.category)?.name ?? null) : null,
        shot: scene.shot,
        pose: scene.pose,
        place: { ...scene.place },
        idea: null,
        text: scene.text,
        edited: scene.edited,
        removed: scene.removed,
        unwritten: scene.text !== null ? null : gaveUpBy !== null ? "gave-up" : "pending",
        gaveUpBy,
        chunk: chunk?.chunk ?? null,
        ...mark,
      };
    });
    const ideas = interrupted.flatMap((r) => (r.kind === "idea" ? [{ write: r.k, idea: r.idea ?? "", count: r.own.length, shot: r.shot ?? null, stoppedBy: r.stoppedBy ?? ("closed" as const) }] : []));
    return {
      sceneSetId: set.sceneSetId,
      avatarId: set.avatarId,
      createdAt: set.createdAt,
      revision: set.revision,
      status,
      stoppedBy,
      stoppedError: stoppedBy === "failed" ? (set.write?.stoppedError ?? { code: "INTERNAL" }) : null,
      runId: set.used ? set.runId : null,
      poses: { ...set.poses },
      categories: set.categories.map((c) => ({ ...c })),
      textModel: set.textModel,
      // The engine reads the spend off the ledger: with a ledger that cannot be read it is unknown, and so is the open part of it.
      spentMicros: this.#deps.ledgerReadable() ? spent : null,
      openReserveMicros: this.#deps.ledgerReadable() ? open : null,
      write: live === undefined ? null : { kind: live.kind, count: live.total, ...(live.sceneIds === undefined ? {} : { sceneIds: [...live.sceneIds] }) },
      lastCompose: set.lastOutcome !== undefined ? { ...set.lastOutcome } : scenes.length === 0 ? null : tallyOf(scenes),
      chunks: set.chunks.map((c) => ({ chunk: c.chunk, sceneIds: [...c.sceneIds], attemptsLeft: this.#attemptsLeft(c), gaveUpBy: this.#chunkGaveUpBy(set, c) })),
      scenes,
      ...(ideas.length === 0 ? {} : { interruptedIdeas: ideas }),
    };
  }

  #announce(set: MockSet): void {
    this.#deps.emit({ v: PROTOCOL_VERSION, id: this.#deps.nextId("evt"), kind: "event", type: "scenes.changed", payload: { change: "upserted", sceneSet: this.view(set) } });
  }

  // ---------- free changes ----------

  /** An edit: the engine's order — the set, its job (IN_FLIGHT), used (VALIDATION), the revision (SCENES_CHANGED), then the edit itself. */
  edit(sceneSetId: string, revision: number, op: SceneEditOp): { view: SceneSetView } | { problem: SceneProblem } | { error: EngineError } {
    const set = this.find(sceneSetId);
    if (set === undefined) return { error: { code: "NOT_FOUND", detail: `no scene set ${sceneSetId} in the open library` } };
    const refusal = this.#changeRefusal(set);
    if (refusal !== null) return { error: refusal };
    if (set.revision !== revision) return { error: { code: "SCENES_CHANGED", detail: `scene set ${sceneSetId} is at revision ${set.revision}, not ${revision}` } };
    const known = new Set(set.scenes.map((s) => s.sceneId));
    if (op.op === "text") {
      const scene = set.scenes.find((s) => s.sceneId === op.sceneId);
      if (scene === undefined) return { error: refuse(`the set has no scene ${op.sceneId}`, "scene-missing", op.sceneId) };
      if (scene.removed) return { error: refuse(`scene ${op.sceneId} is removed; restore it before editing its text`, "target-removed", op.sceneId) };
      const problem = textProblem(op.text);
      if (problem !== null) return { problem };
      const text = op.text.trim();
      if (scene.text === text && scene.edited) return { view: this.view(set) };
      scene.text = text;
      scene.edited = true;
    } else if (op.op === "dismissInterrupted") {
      // The engine's order: the write, or the scenes the set has, then the scenes that have an unresolved rewrite to let go.
      if (op.write !== undefined) {
        const review = set.reviews.find((r) => r.k === op.write && !r.closed);
        if (review === undefined) return { error: refuse(`scene set ${sceneSetId} has no unresolved write ${op.write}`, "no-open-write") };
        review.closed = true;
        delete review.stoppedBy;
        delete review.stoppedError;
      } else {
        const ids = op.sceneIds ?? [];
        const missing = ids.filter((id) => !known.has(id));
        if (missing.length > 0) return { error: refuse(`the set has no scene ${missing.join(", ")}`, "scene-missing", missing[0]) };
        const open = set.reviews.filter((r) => r.kind === "rewrite" && !r.closed);
        const unmarked = ids.filter((id) => !open.some((r) => r.sceneIds.includes(id)));
        if (unmarked.length > 0) return { error: refuse(`scene ${unmarked.join(", ")} has no unresolved rewrite to dismiss`, "nothing-to-dismiss") };
        this.#takeOver(set, new Set(ids));
      }
    } else {
      const missing = op.sceneIds.filter((id) => !known.has(id));
      if (missing.length > 0) return { error: refuse(`the set has no scene ${missing.join(", ")}`, "scene-missing", missing[0]) };
      const removed = op.op === "remove";
      const targets = set.scenes.filter((s) => op.sceneIds.includes(s.sceneId));
      if (!targets.some((s) => s.removed !== removed)) return { view: this.view(set) };
      for (const scene of targets) scene.removed = removed;
    }
    set.revision += 1;
    this.#announce(set);
    return { view: this.view(set) };
  }

  /** What refuses a change of a set: its job runs (IN_FLIGHT), or it is used (VALIDATION). */
  #changeRefusal(set: MockSet): EngineError | null {
    if (this.isLive(set.sceneSetId)) return { code: "IN_FLIGHT", detail: `scene set ${set.sceneSetId} is being written; change it when that ends (or cancel it)` };
    if (set.used) return refuse(`scene set ${set.sceneSetId} is used by run ${set.runId} and is read-only`, "set-used");
    return null;
  }

  discard(sceneSetId: string): { error: EngineError } | { avatarId: string } {
    const set = this.find(sceneSetId);
    if (set === undefined) return { error: { code: "NOT_FOUND", detail: `no scene set ${sceneSetId} in the open library` } };
    const refusal = this.#changeRefusal(set);
    if (refusal !== null) return { error: refusal };
    this.#sets = this.#sets.filter((s) => s !== set);
    this.#deps.emit({ v: PROTOCOL_VERSION, id: this.#deps.nextId("evt"), kind: "event", type: "scenes.changed", payload: { change: "removed", sceneSetId, avatarId: set.avatarId } });
    return { avatarId: set.avatarId };
  }

  // ---------- the approval (CS.5) ----------

  /**
   * The engine's approval refusals (engine/sceneSets/toRun.ts), in its order, all free: no such set (NOT_FOUND), the revision moved (SCENES_CHANGED), an
   * active scene with no text, none or more than a run draws active, an active text that breaks today's word rules (VALIDATION), a job of the set running
   * (IN_FLIGHT), the set already used (VALIDATION).
   * Otherwise the set and the scenes a run would draw, in the set's order.
   */
  approvalOf(sceneSetId: string, revision: number): { error: EngineError } | { set: MockSet; active: readonly Scene[] } {
    const set = this.find(sceneSetId);
    if (set === undefined) return { error: { code: "NOT_FOUND", detail: `no scene set ${sceneSetId} in the open library` } };
    if (set.revision !== revision) return { error: { code: "SCENES_CHANGED", detail: `scene set ${sceneSetId} is at revision ${set.revision}, not ${revision}` } };
    const active = set.scenes.filter((s) => !s.removed);
    const empty = active.filter((s) => s.text === null).map((s) => s.sceneId);
    const [firstEmpty] = empty;
    if (firstEmpty !== undefined) return { error: refuse(`scene(s) ${empty.join(", ")} of set ${sceneSetId} have no text: write, type or remove them first`, "scene-without-text", firstEmpty) };
    if (active.length === 0) return { error: refuse(`scene set ${sceneSetId} has no scene to draw: every scene is removed`, "no-active-scenes") };
    if (active.length > MAX_COMPOSE_SCENES) return { error: refuse(`scene set ${sceneSetId} has ${active.length} active scenes; a run draws at most ${MAX_COMPOSE_SCENES}`, "too-many-active") };
    // A text stored before a rule was tightened (the engine re-checks every active text at an approval, and so does the mock).
    const unfit = active.find((s) => s.text !== null && breaksWordRules(s.text));
    if (unfit !== undefined) return { error: refuse(`the text of scene ${unfit.sceneId} of set ${sceneSetId} breaks today's word rules: edit or remove it first`, "scene-text-problem", unfit.sceneId) };
    if (this.isLive(sceneSetId)) return { error: { code: "IN_FLIGHT", detail: `scene set ${sceneSetId} is being written; wait for that to end (or cancel it)` } };
    if (set.used) return { error: refuse(`scene set ${sceneSetId} is already used by run ${set.runId}`, "set-used") };
    return { set, active };
  }

  /** The set's run was made (the engine's folder exists under the set's pre-issued run id): the set is used, and every window hears it. */
  approve(set: MockSet): void {
    set.used = true;
    this.#announce(set);
  }

  /** An avatar was deleted: its sets went to the Trash with its folder. */
  removeAvatar(avatarId: string): void {
    for (const set of this.#sets) {
      if (set.avatarId === avatarId) this.#deps.emit({ v: PROTOCOL_VERSION, id: this.#deps.nextId("evt"), kind: "event", type: "scenes.changed", payload: { change: "removed", sceneSetId: set.sceneSetId, avatarId } });
    }
    this.#sets = this.#sets.filter((s) => s.avatarId !== avatarId);
    this.#jobs = this.#jobs.filter((j) => j.avatarId !== avatarId);
  }

  // ---------- the paid writes ----------

  /** What a set keeps of a category it is planned from: the name, and (CS.8a) the angles its pool carried then. */
  #categoryEntry(ref: CategoryRef): { ref: CategoryRef; name: string | null; poses?: ScenePose[] } {
    const custom = isCustomCategory(ref) ? this.#deps.category(ref) : undefined;
    return { ref, name: custom?.name ?? null, ...(custom?.pool.poses === undefined ? {} : { poses: [...custom.pool.poses] }) };
  }

  /** A compose that passed the engine's gates: plans and stores the set, launches its job (none for an empty set). */
  compose(request: { avatarId: string; count: number; categories: readonly CategoryRef[]; poses: { profile: boolean; back: boolean } }): { sceneSetId: string; jobId: string | null } {
    const sceneSetId = this.#deps.nextId("set");
    const refs = orderCategories(request.categories);
    const scenes = request.count === 0 ? [] : planScenes(request.count, refs, request.poses, this.#deps.category);
    const set: MockSet = {
      sceneSetId,
      avatarId: request.avatarId,
      createdAt: this.#deps.nowIso(),
      revision: 1,
      runId: this.#deps.nextId("run"),
      poses: { ...request.poses },
      categories: request.categories.map((ref) => this.#categoryEntry(ref)),
      scenes,
      chunks: chunksOf(sceneSetId, scenes),
      write: scenes.length === 0 ? null : { k: 1, kind: "compose" },
      reviews: [],
      writes: scenes.length === 0 ? 0 : 1,
      snapshotWrites: new Map(),
      used: false,
      textModel: this.#deps.textModel(),
    };
    this.#sets.push(set);
    if (scenes.length === 0) {
      this.#announce(set);
      return { sceneSetId, jobId: null };
    }
    return { sceneSetId, jobId: this.#launch(set, "compose") };
  }

  /** A write that passed the gates: records it in the set and launches its job. */
  write(set: MockSet): string {
    set.writes += 1;
    set.write = { k: set.writes, kind: "unwritten" };
    // The last job's outcome goes with the next write: a job that dies before it can record its own must not leave «Готово 25 из 35» over a complete set.
    delete set.lastOutcome;
    set.revision += 1;
    return this.#launch(set, "unwritten");
  }

  // ---------- review writes (CS.4b) ----------

  /** A target's scenes that the set lacks or has removed: refused, the engine's wording. */
  #targetProblem(set: MockSet, sceneIds: readonly number[]): EngineError | null {
    for (const sceneId of sceneIds) {
      const scene = set.scenes.find((s) => s.sceneId === sceneId);
      if (scene === undefined) return refuse(`the set has no scene ${sceneId}`, "scene-missing", sceneId);
      if (scene.removed) return refuse(`scene ${sceneId} is removed; restore it before writing it again`, "target-removed", sceneId);
    }
    return null;
  }

  /** A rewrite of scenes takes them over from any unresolved rewrite that still named them; that one keeps its other scenes, or closes when it has none. */
  #takeOver(set: MockSet, taken: ReadonlySet<number>): void {
    for (const review of set.reviews) {
      if (review.kind !== "rewrite" || review.closed) continue;
      const remaining = review.sceneIds.filter((id) => !taken.has(id));
      if (remaining.length === review.sceneIds.length) continue;
      if (remaining.length === 0) {
        review.closed = true;
        delete review.stoppedBy;
        delete review.stoppedError;
      } else {
        for (const id of review.sceneIds) if (taken.has(id)) review.draws.delete(id);
        review.sceneIds = remaining;
      }
    }
  }

  /**
   * What a rewrite, an idea write or a resume is, or why it is refused (free, the engine's order and wording). Draws once, from the set's own state, and
   * keeps the draw in the write; the write itself is made only by `begin`.
   */
  planReview(set: MockSet, target: ReviewTarget): { error: EngineError } | { plan: MockReviewPlan } {
    const invalid = (detail: string, reason: SceneReason): { error: EngineError } => ({ error: refuse(detail, reason) });
    if (target.kind === "resume") {
      const review = set.reviews.find((r) => r.k === target.write && !r.closed);
      if (review === undefined) return invalid(`scene set ${set.sceneSetId} has no unresolved write ${target.write}`, "no-open-write");
      const attemptsLeft = reviewLeft(review);
      if (attemptsLeft === 0) return invalid(`write ${target.write} has no attempt left: dismiss it, or write the scenes again`, "no-attempts-left");
      // A scene the owner removed since the write was interrupted is not written: the write goes on with the scenes still in the set (the engine's rule).
      const dropped = new Set(review.kind === "rewrite" ? review.sceneIds.filter((id) => set.scenes.find((sc) => sc.sceneId === id)?.removed === true) : []);
      const active = review.kind === "rewrite" ? review.sceneIds.filter((id) => !dropped.has(id)) : [];
      if (review.kind === "rewrite") {
        if (active.length === 0) return invalid(`every scene of write ${target.write} is removed: dismiss it, or restore a scene`, "target-removed");
        const problem = this.#targetProblem(set, active);
        if (problem !== null) return { error: problem };
      }
      return {
        plan: {
          kind: review.kind,
          k: review.k,
          count: review.kind === "rewrite" ? active.length : review.own.length,
          ...(review.kind === "rewrite" ? { sceneIds: [...active] } : {}),
          attemptsLeft,
          begin: () => {
            if (dropped.size > 0) {
              for (const id of dropped) review.draws.delete(id);
              review.sceneIds = active;
            }
            delete review.stoppedBy;
            delete review.stoppedError;
            return review;
          },
        },
      };
    }
    if (set.reviews.length >= MAX_REVIEW_RECORDS) return invalid(`a set records at most ${MAX_REVIEW_RECORDS} writes of this kind`, "write-record-cap");
    const k = set.writes + 1;
    if (target.kind === "idea") {
      const reserved = set.reviews.reduce((sum, r) => sum + (r.kind === "idea" && !r.closed ? r.own.length : 0), 0);
      if (set.scenes.length + reserved + target.count > SET_ROOM) return invalid(`a set holds at most ${SET_ROOM} scenes: this one has ${set.scenes.length}${reserved > 0 ? ` and an interrupted idea write holds room for ${reserved} more` : ""}`, "idea-room");
      const used = [...set.scenes.map((s) => s.sceneId), ...set.reviews.flatMap((r) => (r.kind === "idea" ? r.own.map((o) => o.sceneId) : []))];
      const first = used.length === 0 ? 1 : Math.max(...used) + 1;
      // CS.8a: the angle is the idea's own (the run's toggles are not asked): «вид сзади» is a view from behind, on «Авто» with a shot nobody holds a phone for; a shot the
      // owner chose stays, and a selfie or a mirror shot faces the camera whatever the idea says. An idea with no angle in it faces the camera.
      const wanted = ideaAngle(target.idea);
      const own = Array.from({ length: target.count }, (_, i) => {
        // On «Авто» an idea that names a mirror gets the mirror (the engine allows it then and not otherwise), facing the camera.
        const mirror = target.shot === null && ideaNamesMirror(target.idea);
        const shot = target.shot ?? (mirror ? "mirror" : wanted === undefined ? (AUTO_SHOTS[(k + i) % AUTO_SHOTS.length] ?? "friend") : "candid");
        const pose: SceneView["pose"] = holdsPhone(shot) || wanted === undefined ? ((k + i) % 2 === 0 ? "front" : "three-quarter") : wanted;
        return { sceneId: first + i, shot, pose };
      });
      return {
        plan: {
          kind: "idea",
          k,
          count: target.count,
          attemptsLeft: SCENE_CHUNK_ATTEMPTS,
          begin: (current) => {
            const review: Review = { k, kind: "idea", closed: false, sceneIds: own.map((o) => o.sceneId), redraw: false, draws: new Map(), idea: target.idea.trim(), shot: target.shot, own, snapshots: [], attempts: [] };
            current.reviews.push(review);
            current.writes = k;
            return review;
          },
        },
      };
    }
    // A rewrite: the scenes, then (a redraw) the categories they draw from, then what one request can be written from.
    const problem = this.#targetProblem(set, target.sceneIds);
    if (problem !== null) return { error: problem };
    const scenes = target.sceneIds.flatMap((id) => set.scenes.filter((s) => s.sceneId === id));
    if (target.redraw) {
      for (const ref of new Set(scenes.flatMap((s) => (s.category !== "own" && isCustomCategory(s.category) ? [s.category] : [])))) {
        if (this.#deps.category(ref) === undefined) return { error: { code: "NOT_FOUND", detail: `no custom category ${ref}` } };
      }
    }
    const planned = scenes.filter((s) => s.place !== null);
    if (planned.length !== 0 && planned.length !== scenes.length) return invalid("a rewrite covers planned scenes or own scenes, not both: they are written from different prompts", "mixed-kinds");
    if (target.redraw && planned.length !== scenes.length) return invalid("only a planned scene has a place to redraw; an own scene is written again from its idea", "own-redraw");
    const draws = new Map<number, { place: ScenePlace; shot: SceneView["shot"]; pose: SceneView["pose"] }>();
    // A redraw takes its snapshot of each custom category now, when the write is planned: a rename between this and the answer does not change it.
    const snapshots: Review["snapshots"] = [];
    if (target.redraw) {
      for (const ref of new Set(planned.flatMap((sc) => (sc.category !== "own" && isCustomCategory(sc.category) ? [sc.category] : [])))) {
        const fresh = this.#deps.category(ref);
        if (fresh !== undefined) snapshots.push({ ref, name: fresh.name, ...(fresh.pool.poses === undefined ? {} : { poses: [...fresh.pool.poses] }) });
      }
    }
    if (target.redraw) {
      const shown = new Set(set.scenes.flatMap((s) => (s.place !== null && !s.removed ? [s.place.location] : [])));
      const shownOutfits = new Set(set.scenes.flatMap((s) => (s.place !== null && !s.removed ? [s.place.outfit] : [])));
      for (const scene of planned) {
        const ref = scene.category === "own" ? "home" : scene.category;
        const custom = isCustomCategory(ref) ? this.#deps.category(ref) : undefined;
        let tables = tablesOf(ref, custom);
        // CS.8a: a category with `poses` redraws its pose from them, and a phone that would turn away gives way to another shot of the deck.
        const angled = custom?.pool.poses === undefined ? undefined : anglePick(custom.pool.poses, k + scene.sceneId, scene.shot, custom.pool.shotDeck);
        let shot = angled?.shot ?? scene.shot;
        if (shot === "mirror") {
          const mirrors = tables.filter((t) => t.mirror);
          if (mirrors.length === 0) shot = "selfie";
          else tables = mirrors;
        }
        const own = scene.place?.location ?? "";
        const fresh = tables.filter((t) => !shown.has(t.place));
        const other = tables.filter((t) => t.place !== own);
        const candidates = fresh.length > 0 ? fresh : other.length > 0 ? other : tables;
        const row = candidates[(k + scene.sceneId) % candidates.length] ?? tables[0];
        if (row === undefined) throw new Error("the mock has no place to redraw a scene into");
        const outfits = [...new Set(tables.map((t) => t.outfit))];
        const freshOutfits = outfits.filter((o) => !shownOutfits.has(o));
        const otherOutfits = outfits.filter((o) => o !== scene.place?.outfit);
        const pickFrom = freshOutfits.length > 0 ? freshOutfits : otherOutfits.length > 0 ? otherOutfits : outfits;
        const outfit = pickFrom[(k + scene.sceneId) % pickFrom.length] ?? row.outfit;
        shown.add(row.place);
        shownOutfits.add(outfit);
        draws.set(scene.sceneId, { place: { location: row.place, timeOfDay: row.time, activity: row.activity, outfit }, shot, pose: angled?.pose ?? poseFor(shot, set.poses, k + scene.sceneId) });
      }
    }
    return {
      plan: {
        kind: "rewrite",
        k,
        count: scenes.length,
        sceneIds: [...target.sceneIds],
        attemptsLeft: SCENE_CHUNK_ATTEMPTS,
        begin: (current) => {
          this.#takeOver(current, new Set(target.sceneIds));
          const review: Review = { k, kind: "rewrite", closed: false, sceneIds: [...target.sceneIds], redraw: target.redraw, draws, own: [], snapshots, attempts: [] };
          current.reviews.push(review);
          current.writes = k;
          return review;
        },
      },
    };
  }

  /** What a review write could cost: one request at the writer's typical tokens, asked at most as many times as it has attempts left. */
  reviewPrice(plan: MockReviewPlan): { expected: number; worst: number } {
    const worst = plan.attemptsLeft * MOCK_SCENE_ATTEMPT_WORST;
    return { expected: Math.min(Math.round(plan.count * TYPICAL_PER_SCENE), worst), worst };
  }

  /**
   * A write that passed every gate and was cancelled before its job began (the engine's cancel that beats the start, while the prices load): the set's file
   * is never touched, the set is announced as it is, then `job.cancelled`, and only after both does the command answer. Returns the job's id.
   */
  cancelUnstarted(set: MockSet, kind: Job["kind"]): string {
    const job: Job = { jobId: this.#deps.nextId("job"), sceneSetId: set.sceneSetId, avatarId: set.avatarId, kind, status: "cancelled", done: 0, total: 0, error: null, written: 0, unwritten: 0, timers: [], queue: [] };
    this.#jobs.push(job);
    this.#announce(set);
    this.#deps.emit({ v: PROTOCOL_VERSION, id: this.#deps.nextId("evt"), kind: "event", type: "job.cancelled", payload: { kind: "scenes", jobId: job.jobId, sceneSetId: set.sceneSetId, avatarId: set.avatarId } });
    return job.jobId;
  }

  /** A review write that passed the gates: records it in the set and launches its job. */
  writeReview(set: MockSet, plan: MockReviewPlan): string {
    const review = plan.begin(set);
    set.revision += 1;
    return this.#launchReview(set, review);
  }

  #launchReview(set: MockSet, review: Review): string {
    const job: Job = {
      jobId: this.#deps.nextId("job"),
      sceneSetId: set.sceneSetId,
      avatarId: set.avatarId,
      kind: review.kind,
      k: review.k,
      ...(review.kind === "rewrite" ? { sceneIds: [...review.sceneIds] } : {}),
      status: "running",
      done: 0,
      total: review.kind === "rewrite" ? review.sceneIds.length : review.own.length,
      error: null,
      written: 0,
      unwritten: 0,
      timers: [],
      queue: [],
    };
    this.#jobs.push(job);
    this.#announce(set);
    this.#progress(job);
    job.timers.push(this.#deps.scheduler.schedule(this.#deps.stepMs, () => this.#runReview(job, set, review)));
    return job.jobId;
  }

  /** The write's one request, asked again under the next id while it is rejected and attempts are left; an attempt that got no answer stops the job. */
  #runReview(job: Job, set: MockSet, review: Review): void {
    if (job.status !== "running") return;
    for (;;) {
      if (reviewLeft(review) === 0) {
        review.closed = true;
        this.#end(job, set, { status: "failed", error: { code: "INTERNAL", detail: `the scene writer's answer for write ${review.k} was rejected on every attempt` }, stoppedBy: "failed" });
        return;
      }
      const attempt: Attempt = { key: `${set.sceneSetId}:write-${review.k}#${review.attempts.length + 1}`, paid: false, cost: 0, open: false };
      review.attempts.push(attempt);
      const outcome = this.#scripted.shift() ?? "ok";
      switch (outcome) {
        case "ok": {
          attempt.paid = true;
          attempt.cost = Math.round(job.total * TYPICAL_PER_SCENE);
          this.#deps.spend(attempt.cost);
          this.#accept(set, review);
          job.done += job.total;
          job.written += job.total;
          set.revision += 1;
          this.#announce(set);
          this.#progress(job);
          this.#end(job, set, { status: "done" });
          return;
        }
        case "rejected":
          attempt.paid = true;
          attempt.cost = REJECTED_COST;
          this.#deps.spend(REJECTED_COST);
          continue;
        case "refused":
          review.closed = true;
          this.#end(job, set, { status: "failed", error: { code: "MODERATION_REFUSED" }, stoppedBy: "failed" });
          return;
        case "rate-limited":
          this.#end(job, set, { status: "failed", error: { code: "RATE_LIMITED", retryAfterMs: 120_000 }, stoppedBy: "rate-limited" });
          return;
        case "provider-error":
          this.#end(job, set, { status: "failed", error: { code: "NETWORK" }, stoppedBy: "provider-error" });
          return;
        case "network":
        case "timeout":
          attempt.paid = true;
          attempt.open = true;
          this.#deps.openReserve(attempt.key, MOCK_SCENE_ATTEMPT_WORST);
          this.#deps.needReconcile();
          this.#end(job, set, { status: "failed", error: { code: outcome === "timeout" ? "TIMEOUT" : "NETWORK" }, stoppedBy: outcome });
          return;
      }
    }
  }

  /** The accepted answer goes into the set, all of it: a rewrite's targets get their sentences (a redraw, its new place), an idea write's scenes join the set. */
  #accept(set: MockSet, review: Review): void {
    if (review.kind === "idea") {
      for (const own of review.own) {
        const scene: Scene = { sceneId: own.sceneId, category: "own", shot: own.shot, pose: own.pose, place: null, idea: review.idea ?? null, text: null, edited: false, removed: false };
        scene.text = sentenceOf(scene, review.k);
        set.scenes.push(scene);
      }
    } else {
      for (const sceneId of review.sceneIds) {
        const scene = set.scenes.find((s) => s.sceneId === sceneId);
        if (scene === undefined) continue;
        const drawn = review.draws.get(sceneId);
        if (review.redraw && drawn !== undefined) {
          scene.place = { ...drawn.place };
          scene.shot = drawn.shot;
          scene.pose = drawn.pose;
        }
        scene.text = sentenceOf(scene, review.k);
        scene.edited = false;
      }
    }
    // A redraw refreshes the set's snapshot of the category with the name taken when it was planned, unless a LATER write already refreshed it.
    if (review.redraw) {
      for (const snapshot of review.snapshots) {
        const entry = set.categories.find((c) => c.ref === snapshot.ref);
        if (entry === undefined || (set.snapshotWrites.get(snapshot.ref) ?? 0) >= review.k) continue;
        // The whole snapshot is put in place, as the engine's `snapshotOf` does: angles the category no longer has are gone from the view.
        entry.name = snapshot.name;
        if (snapshot.poses === undefined) delete entry.poses;
        else entry.poses = [...snapshot.poses];
        set.snapshotWrites.set(snapshot.ref, review.k);
      }
    }
    review.closed = true;
    delete review.stoppedBy;
    delete review.stoppedError;
  }

  // ---------- the job ----------

  #launch(set: MockSet, kind: "compose" | "unwritten"): string {
    const pending = this.#pending(set);
    const job: Job = {
      jobId: this.#deps.nextId("job"),
      sceneSetId: set.sceneSetId,
      avatarId: set.avatarId,
      kind,
      status: "running",
      done: 0,
      total: pending.reduce((sum, p) => sum + p.ids.length, 0),
      error: null,
      written: 0,
      unwritten: 0,
      timers: [],
      queue: pending.map((p) => p.chunk.chunk),
    };
    this.#jobs.push(job);
    this.#announce(set);
    this.#progress(job);
    job.queue.forEach((chunkNumber, i) => {
      job.timers.push(this.#deps.scheduler.schedule(this.#deps.stepMs * (i + 1), () => this.#runChunk(job, set, chunkNumber)));
    });
    job.timers.push(this.#deps.scheduler.schedule(this.#deps.stepMs * (job.queue.length + 1), () => this.#end(job, set, { status: "done" })));
    return job.jobId;
  }

  #progress(job: Job): void {
    this.#deps.emit({ v: PROTOCOL_VERSION, id: this.#deps.nextId("evt"), kind: "event", type: "job.progress", payload: { kind: "scenes", jobId: job.jobId, sceneSetId: job.sceneSetId, avatarId: job.avatarId, done: job.done, total: job.total } });
  }

  /** One chunk: its attempts until it is written, given up on, or an attempt gets no answer (the job stops). */
  #runChunk(job: Job, set: MockSet, chunkNumber: number): void {
    if (job.status !== "running") return;
    const chunk = set.chunks.find((c) => c.chunk === chunkNumber);
    if (chunk === undefined) return;
    for (;;) {
      const ids = this.#request(set, chunk);
      if (ids.length === 0 || this.#attemptsLeft(chunk) === 0) return;
      const attempt: Attempt = { key: `${set.sceneSetId}:writer-${chunk.chunk}#${chunk.attempts.length + 1}`, paid: false, cost: 0, open: false };
      chunk.attempts.push(attempt);
      const outcome = this.#scripted.shift() ?? "ok";
      switch (outcome) {
        case "ok": {
          attempt.paid = true;
          attempt.cost = Math.round(ids.length * TYPICAL_PER_SCENE);
          this.#deps.spend(attempt.cost);
          for (const scene of set.scenes) if (ids.includes(scene.sceneId) && scene.text === null) scene.text = sentenceOf(scene);
          job.done += ids.length;
          job.written += ids.length;
          set.revision += 1;
          this.#announce(set);
          this.#progress(job);
          return;
        }
        case "rejected":
          attempt.paid = true;
          attempt.cost = REJECTED_COST;
          this.#deps.spend(REJECTED_COST);
          if (this.#answered(chunk) >= SCENE_CHUNK_ATTEMPTS) {
            chunk.gaveUp = "rejected";
            set.revision += 1;
            this.#announce(set);
            return;
          }
          continue;
        case "refused":
          chunk.gaveUp = "refused";
          set.revision += 1;
          this.#announce(set);
          return;
        case "rate-limited":
          this.#end(job, set, { status: "failed", error: { code: "RATE_LIMITED", retryAfterMs: 120_000 }, stoppedBy: "rate-limited" });
          return;
        case "provider-error":
          this.#end(job, set, { status: "failed", error: { code: "NETWORK" }, stoppedBy: "provider-error" });
          return;
        case "network":
        case "timeout":
          // The request may have been billed: its reserve stays open at the worst case, and counts as an answered attempt.
          attempt.paid = true;
          attempt.open = true;
          this.#deps.openReserve(attempt.key, MOCK_SCENE_ATTEMPT_WORST);
          this.#deps.needReconcile();
          this.#end(job, set, { status: "failed", error: { code: outcome === "timeout" ? "TIMEOUT" : "NETWORK" }, stoppedBy: outcome });
          return;
      }
    }
  }

  /** The job's end: money, the set's last state (scenes.changed), then the job's own event: always in that order. */
  #end(job: Job, set: MockSet, end: { status: "done" } | { status: "failed"; error: EngineError; stoppedBy: Exclude<SceneStoppedBy, "closed"> } | { status: "cancelled" }): void {
    if (job.status !== "running") return;
    for (const cancel of job.timers) cancel();
    job.timers = [];
    job.status = end.status;
    if (end.status === "failed") job.error = end.error;
    job.unwritten = Math.max(0, job.total - job.written);
    const review = job.k === undefined ? undefined : set.reviews.find((r) => r.k === job.k);
    if (review !== undefined) {
      // A rewrite or an idea write keeps why it stopped in its own record, and only while it can still be resumed; the compose's record and outcome are not its to touch.
      if (end.status !== "done" && !review.closed) {
        if (reviewLeft(review) === 0) {
          review.closed = true;
          delete review.stoppedBy;
          delete review.stoppedError;
        } else {
          review.stoppedBy = end.status === "cancelled" ? "cancelled" : end.stoppedBy;
          if (end.status === "failed" && end.stoppedBy === "failed") review.stoppedError = end.error;
          else delete review.stoppedError;
        }
      }
    } else if (set.write !== null) {
      if (end.status === "done") set.write = null;
      else {
        const { k, kind } = set.write;
        set.write = { k, kind, stoppedBy: end.status === "cancelled" ? "cancelled" : end.stoppedBy, ...(end.status === "failed" && end.stoppedBy === "failed" ? { stoppedError: end.error } : {}) };
      }
    }
    set.revision += 1;
    if (review === undefined) set.lastOutcome = tallyOf(this.view(set).scenes);
    this.#deps.emitMoney();
    this.#announce(set);
    const { jobId, sceneSetId, avatarId } = job;
    if (end.status === "done") {
      this.#deps.emit({ v: PROTOCOL_VERSION, id: this.#deps.nextId("evt"), kind: "event", type: "job.done", payload: { jobId, result: { kind: "scenes", sceneSetId, avatarId, written: job.written, unwritten: job.unwritten } } });
    } else if (end.status === "failed") {
      this.#deps.emit({ v: PROTOCOL_VERSION, id: this.#deps.nextId("evt"), kind: "event", type: "job.failed", payload: { kind: "scenes", jobId, sceneSetId, avatarId, error: end.error } });
    } else {
      this.#deps.emit({ v: PROTOCOL_VERSION, id: this.#deps.nextId("evt"), kind: "event", type: "job.cancelled", payload: { kind: "scenes", jobId, sceneSetId, avatarId } });
    }
  }

  /**
   * Aborts the set's job. The chunk its request was out for is cut off: its attempt keeps a reserve open at the worst case (an aborted request may have been
   * billed), so every paid action waits for a reconcile, as the engine's cancel does. The job ends a moment later, with the chunks already written kept.
   */
  cancel(sceneSetId: string): void {
    const job = this.#liveJob(sceneSetId);
    const set = this.find(sceneSetId);
    if (job === undefined || set === undefined) return;
    for (const cancel of job.timers) cancel();
    job.timers = [];
    const review = job.k === undefined ? undefined : set.reviews.find((r) => r.k === job.k);
    if (review !== undefined) {
      if (reviewLeft(review) > 0 && this.#deps.cancelHasRequestOut()) {
        const attempt: Attempt = { key: `${set.sceneSetId}:write-${review.k}#${review.attempts.length + 1}`, paid: true, cost: 0, open: true };
        review.attempts.push(attempt);
        this.#deps.openReserve(attempt.key, MOCK_SCENE_ATTEMPT_WORST);
        this.#deps.needReconcile();
        this.#deps.emitMoney();
      }
      job.timers.push(this.#deps.scheduler.schedule(CANCEL_CONFIRM_MS, () => this.#end(job, set, { status: "cancelled" })));
      return;
    }
    const next = this.#pending(set)[0]?.chunk;
    if (next !== undefined && this.#attemptsLeft(next) > 0 && this.#deps.cancelHasRequestOut()) {
      const attempt: Attempt = { key: `${set.sceneSetId}:writer-${next.chunk}#${next.attempts.length + 1}`, paid: true, cost: 0, open: true };
      next.attempts.push(attempt);
      this.#deps.openReserve(attempt.key, MOCK_SCENE_ATTEMPT_WORST);
      this.#deps.needReconcile();
      this.#deps.emitMoney();
    }
    job.timers.push(this.#deps.scheduler.schedule(CANCEL_CONFIRM_MS, () => this.#end(job, set, { status: "cancelled" })));
  }
}
