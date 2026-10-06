import {
  isCustomCategory,
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
  type SceneEditOp,
  type SceneGaveUpBy,
  type SceneProblem,
  type SceneSetView,
  type SceneStoppedBy,
  type SceneView,
  type UnsequencedEvent,
} from "../../shared/engine";
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

/** What the next request of a writer job comes back as (`failNextSceneAttempt`); an unscripted one is a good answer. */
export type MockSceneAttempt = "rejected" | "refused" | "rate-limited" | "provider-error" | "network" | "timeout";

/** A set seeded as a compose would have left it. */
export interface MockSceneSetSeed {
  avatarId: string;
  sceneSetId: string;
  count: number;
  /** The first N scenes have a sentence, in whole chunks' order. */
  written?: number;
  /** The write that did not finish: the set reads stopped, for this reason (`closed` when no outcome was kept). Absent: the set is ready. */
  stopped?: SceneStoppedBy;
  categories?: readonly CategoryRef[];
  /** The scenes themselves, instead of the mock's own plan (the parity rig seeds the real engine's store with the very same ones). A `text` is a written scene. */
  scenes?: readonly { category: CategoryRef; shot: SceneView["shot"]; pose: SceneView["pose"]; place: ScenePlace; text?: string }[];
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
  category: CategoryRef;
  shot: SceneView["shot"];
  pose: SceneView["pose"];
  place: ScenePlace;
  text: string | null;
  edited: boolean;
  removed: boolean;
}

interface MockSet {
  sceneSetId: string;
  avatarId: string;
  createdAt: string;
  revision: number;
  runId: string;
  poses: { profile: boolean; back: boolean };
  categories: { ref: CategoryRef; name: string | null }[];
  scenes: Scene[];
  chunks: Chunk[];
  write: { k: number; kind: "compose" | "unwritten"; stoppedBy?: Exclude<SceneStoppedBy, "closed">; stoppedError?: EngineError } | null;
  writes: number;
  used: boolean;
}

interface Job {
  jobId: string;
  sceneSetId: string;
  avatarId: string;
  kind: "compose" | "unwritten";
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
    const tables: readonly PlaceTable[] =
      custom !== undefined
        ? custom.pool.locations.map((l, i): PlaceTable => ({ place: l.name, time: l.times[0] ?? "midday", activity: l.activities[0]?.text ?? "standing", outfit: custom.pool.outfits[i % custom.pool.outfits.length] ?? "a plain dress", mirror: l.mirror }))
        : (BUILT_IN_PLACES[ref] ?? BUILT_IN_PLACES.home ?? []);
    const deck: SceneView["shot"][] = custom !== undefined ? [...custom.pool.shotDeck] : ref === "shoot" ? SHOOT_SHOTS : SHOTS;
    for (let k = 0; k < n; k++) {
      index += 1;
      let shot = deck[k % deck.length] ?? "friend";
      const mirrors = tables.filter((t) => t.mirror);
      // A mirror shot needs a mirror place; a deck with none draws no mirror shot.
      if (shot === "mirror" && mirrors.length === 0) shot = "friend";
      const row = shot === "mirror" ? (mirrors[k % mirrors.length] ?? tables[0]) : (tables.filter((t) => !t.mirror)[k % Math.max(1, tables.filter((t) => !t.mirror).length)] ?? tables[0]);
      if (row === undefined) throw new Error("the mock has no place to plan a scene in");
      // Selfies and mirror shots face the camera whatever the run allows; the others may turn when the run says so.
      const phone = shot === "selfie" || shot === "mirror";
      const pose: SceneView["pose"] = phone || k % 5 < 3 ? (k % 2 === 0 ? "front" : "three-quarter") : poses.profile && k % 5 === 3 ? "profile" : poses.back && k % 5 === 4 ? "back" : "three-quarter";
      scenes.push({ sceneId: index, category: ref, shot, pose, place: { location: row.place, timeOfDay: row.time, activity: row.activity, outfit: row.outfit }, text: null, edited: false, removed: false });
    }
  }
  return scenes;
}

function sentenceOf(scene: Scene): string {
  return `A friend catches her ${scene.place.activity} at ${scene.place.location} in the ${scene.place.timeOfDay}, wearing ${scene.place.outfit} (${scene.sceneId}).`;
}

function chunksOf(setId: string, scenes: readonly Scene[]): Chunk[] {
  const chunks: Chunk[] = [];
  for (let i = 0; i < scenes.length; i += SCENE_CHUNK_SIZE) {
    chunks.push({ chunk: chunks.length + 1, sceneIds: scenes.slice(i, i + SCENE_CHUNK_SIZE).map((s) => s.sceneId), attempts: [] });
  }
  void setId;
  return chunks;
}

// ---------- the text rules (the engine's `textProblem`) ----------

/** The assembler's revealing words (studio/engine/scenes/words.ts), exactly: the parity suite plays a text with one through both engines. */
const REVEALING_WORDS = /\b(bikini|swimsuit|swimwear|lingerie|sports bra|thong|stockings?|slip dress|robe over lingerie)\b/i;
const LINE_BREAK = new RegExp(`[\\n\\r${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`);

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
  #unreadable = 0;
  #scripted: MockSceneAttempt[] = [];

  constructor(deps: MockSceneSetDeps, seeds: readonly MockSceneSetSeed[] = [], unreadable = 0) {
    this.#deps = deps;
    this.#unreadable = unreadable;
    for (const seed of seeds) this.#seed(seed);
  }

  #seed(seed: MockSceneSetSeed): void {
    const refs = seed.categories ?? ["home"];
    const scenes: Scene[] =
      seed.scenes === undefined
        ? planScenes(seed.count, refs, { profile: false, back: false }, this.#deps.category)
        : seed.scenes.map((s, i) => ({ sceneId: i + 1, category: s.category, shot: s.shot, pose: s.pose, place: { ...s.place }, text: s.text ?? null, edited: false, removed: false }));
    const chunks = chunksOf(seed.sceneSetId, scenes);
    const written = seed.written ?? 0;
    if (seed.scenes === undefined) for (const scene of scenes) if (scene.sceneId <= written) scene.text = sentenceOf(scene);
    // A chunk whose scenes were written was answered once.
    for (const chunk of chunks) {
      if (chunk.sceneIds.every((id) => id <= written)) chunk.attempts.push({ key: `${seed.sceneSetId}:writer-${chunk.chunk}#1`, paid: true, cost: Math.round(chunk.sceneIds.length * TYPICAL_PER_SCENE), open: false });
    }
    const stopped = seed.stopped;
    this.#sets.push({
      sceneSetId: seed.sceneSetId,
      avatarId: seed.avatarId,
      createdAt: this.#deps.nowIso(),
      revision: 1,
      runId: this.#deps.nextId("run"),
      poses: { profile: false, back: false },
      categories: refs.map((ref) => ({ ref, name: isCustomCategory(ref) ? (this.#deps.category(ref)?.name ?? null) : null })),
      scenes,
      chunks,
      write: stopped === undefined ? null : { k: 1, kind: "compose", ...(stopped === "closed" ? {} : { stoppedBy: stopped, ...(stopped === "failed" ? { stoppedError: { code: "INTERNAL" as const } } : {}) }) },
      writes: stopped === undefined ? 0 : 1,
      used: false,
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
    return { sceneSet: shown === undefined ? null : this.view(shown), unreadable: this.#unreadable };
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
    const pending = this.#pending(set).length > 0;
    const stopped = !set.used && live === undefined && set.write !== null && pending;
    const status: SceneSetView["status"] = set.used ? "used" : live !== undefined ? "writing" : stopped ? "stopped" : "ready";
    const stoppedBy: SceneStoppedBy | null = stopped ? (set.write?.stoppedBy ?? "closed") : null;
    let spent = 0;
    let open = 0;
    for (const attempt of set.chunks.flatMap((c) => c.attempts)) {
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
    const scenes: SceneView[] = set.scenes.map((scene) => {
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
      };
    });
    const active = scenes.filter((s) => !s.removed);
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
      textModel: this.#deps.textModel(),
      spentMicros: spent,
      openReserveMicros: open,
      write: live === undefined ? null : { kind: live.kind, count: live.total },
      lastCompose: scenes.length === 0 ? null : { total: active.length, written: active.filter((s) => s.text !== null).length, gaveUp: active.filter((s) => s.unwritten === "gave-up").length },
      chunks: set.chunks.map((c) => ({ chunk: c.chunk, sceneIds: [...c.sceneIds], attemptsLeft: this.#attemptsLeft(c), gaveUpBy: this.#chunkGaveUpBy(set, c) })),
      scenes,
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
      if (scene === undefined) return { error: { code: "VALIDATION", detail: `the set has no scene ${op.sceneId}` } };
      if (scene.removed) return { error: { code: "VALIDATION", detail: `scene ${op.sceneId} is removed; restore it before editing its text` } };
      const problem = textProblem(op.text);
      if (problem !== null) return { problem };
      const text = op.text.trim();
      if (scene.text === text && scene.edited) return { view: this.view(set) };
      scene.text = text;
      scene.edited = true;
    } else {
      const missing = op.sceneIds.filter((id) => !known.has(id));
      if (missing.length > 0) return { error: { code: "VALIDATION", detail: `the set has no scene ${missing.join(", ")}` } };
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
    if (set.used) return { code: "VALIDATION", detail: `scene set ${set.sceneSetId} is used by run ${set.runId} and is read-only` };
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

  /** An avatar was deleted: its sets went to the Trash with its folder. */
  removeAvatar(avatarId: string): void {
    this.#sets = this.#sets.filter((s) => s.avatarId !== avatarId);
    this.#jobs = this.#jobs.filter((j) => j.avatarId !== avatarId);
  }

  // ---------- the paid writes ----------

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
      categories: request.categories.map((ref) => ({ ref, name: isCustomCategory(ref) ? (this.#deps.category(ref)?.name ?? null) : null })),
      scenes,
      chunks: chunksOf(sceneSetId, scenes),
      write: scenes.length === 0 ? null : { k: 1, kind: "compose" },
      writes: scenes.length === 0 ? 0 : 1,
      used: false,
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
    set.revision += 1;
    return this.#launch(set, "unwritten");
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
    if (set.write !== null) {
      if (end.status === "done") set.write = null;
      else {
        const { k, kind } = set.write;
        set.write = { k, kind, stoppedBy: end.status === "cancelled" ? "cancelled" : end.stoppedBy, ...(end.status === "failed" && end.stoppedBy === "failed" ? { stoppedError: end.error } : {}) };
      }
    }
    set.revision += 1;
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
    const next = this.#pending(set)[0]?.chunk;
    if (next !== undefined && this.#attemptsLeft(next) > 0) {
      const attempt: Attempt = { key: `${set.sceneSetId}:writer-${next.chunk}#${next.attempts.length + 1}`, paid: true, cost: 0, open: true };
      next.attempts.push(attempt);
      this.#deps.openReserve(attempt.key, MOCK_SCENE_ATTEMPT_WORST);
      this.#deps.needReconcile();
      this.#deps.emitMoney();
    }
    job.timers.push(this.#deps.scheduler.schedule(CANCEL_CONFIRM_MS, () => this.#end(job, set, { status: "cancelled" })));
  }
}
