import {
  categoryNameKey,
  MAX_CUSTOM_CATEGORIES,
  POOL_OUTFITS_MIN,
  POOL_PLACES_MIN,
  type CategoriesListResult,
  type CategoryBusy,
  type CategoryCallKind,
  type CategoryInterrupted,
  type CategoryPlace,
  type CategoryPool,
  type CategoryStyle,
  type CategorySummary,
  type CustomCategoryId,
  type EngineError,
} from "../../shared/engine";

// The mock's category library (CS.2): what the engine's store and pool call do, with no disk and no model. A pool is made from the owner's
// description and the name, deterministically, so a dev build and a test see the same category twice; everything it answers passes the
// contract (the mock engine parses its results). The mock engine owns the gates (key, ledger, price, month) and the events.

const MODEL = "x-ai/grok-4.3";

/** Twelve places; every third has a mirror (2, 5, 8, 11), so any five in a row, wrapping round included, hold one, and a deck that draws a mirror shot can always place it. */
const PLACES: readonly CategoryPlace[] = [
  { name: "a corner cafe", times: ["morning", "midday"], activities: [{ text: "reading a menu", twoHanded: false }, { text: "stirring a cappuccino", twoHanded: true }], mirror: false },
  { name: "a flower stall", times: ["morning", "midday"], activities: [{ text: "smelling a bouquet", twoHanded: false }, { text: "wrapping flowers", twoHanded: true }], mirror: false },
  { name: "a bookshop with a mirror", times: ["midday", "evening"], activities: [{ text: "browsing a shelf", twoHanded: false }, { text: "carrying a stack of books", twoHanded: true }], mirror: true },
  { name: "a riverside bench", times: ["golden hour", "evening"], activities: [{ text: "watching the water", twoHanded: false }, { text: "unwrapping a sandwich", twoHanded: true }], mirror: false },
  { name: "a bakery counter", times: ["morning"], activities: [{ text: "choosing a croissant", twoHanded: false }, { text: "boxing pastries", twoHanded: true }], mirror: false },
  { name: "a fitting room mirror", times: ["midday", "evening"], activities: [{ text: "adjusting a sleeve", twoHanded: false }, { text: "buttoning a jacket", twoHanded: true }], mirror: true },
  { name: "a quiet courtyard", times: ["midday", "golden hour"], activities: [{ text: "leaning on a wall", twoHanded: false }, { text: "tying a scarf", twoHanded: true }], mirror: false },
  { name: "a small gallery", times: ["midday", "evening"], activities: [{ text: "studying a painting", twoHanded: false }, { text: "holding a catalogue", twoHanded: true }], mirror: false },
  { name: "a hotel lobby mirror", times: ["evening", "night"], activities: [{ text: "checking her hair", twoHanded: false }, { text: "zipping a coat", twoHanded: true }], mirror: true },
  { name: "a market street", times: ["morning", "midday"], activities: [{ text: "picking an apple", twoHanded: false }, { text: "bagging oranges", twoHanded: true }], mirror: false },
  { name: "a rooftop terrace", times: ["golden hour", "night"], activities: [{ text: "gazing at the skyline", twoHanded: false }, { text: "pouring a drink", twoHanded: true }], mirror: false },
  { name: "a staircase with a mirror", times: ["morning", "midday"], activities: [{ text: "pausing on a step", twoHanded: false }, { text: "carrying a tote", twoHanded: true }], mirror: true },
];

const OUTFITS: readonly string[] = [
  "a beige trench coat and jeans",
  "a striped tee and a beret",
  "a black midi dress",
  "a linen shirt and shorts",
  "a long cardigan and trousers",
  "a red scarf and a wool coat",
  "a denim jacket and a skirt",
  "a silk blouse and slacks",
];

function hashOf(text: string): number {
  let hash = 2_166_136_261;
  for (const char of text) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash;
}

/** The deterministic pool of a category: from its description and name alone, so a regeneration with a new description gives a new pool. */
export function mockCategoryPool(name: string, description: string): { label: string; style: CategoryStyle; pool: CategoryPool } {
  const hash = hashOf(`${name.trim().toLowerCase()}\n${description}`);
  const start = hash % PLACES.length;
  const locations = Array.from({ length: POOL_PLACES_MIN }, (_, i) => PLACES[(start + i) % PLACES.length]).filter((p): p is CategoryPlace => p !== undefined);
  const outfitStart = (hash >>> 8) % OUTFITS.length;
  const outfitCount = POOL_OUTFITS_MIN + ((hash >>> 12) % 3);
  const outfits = Array.from({ length: outfitCount }, (_, i) => OUTFITS[(outfitStart + i) % OUTFITS.length]).filter((o): o is string => o !== undefined);
  const editorial = hash % 5 === 0;
  return {
    label: `Mock theme ${(hash >>> 16).toString(16).padStart(4, "0")}`,
    style: editorial ? "editorial" : "phone",
    pool: {
      locations: locations.map((p) => ({ ...p, times: [...p.times], activities: p.activities.map((a) => ({ ...a })) })),
      outfits,
      shotDeck: editorial ? ["photographer", "photographer", "photographer", "candid", "candid"] : ["friend", "friend", "selfie", "mirror", "candid"],
    },
  };
}


/** The paid call in flight, if any: what the engine's `#categoryCall` holds. */
interface Call {
  kind: CategoryCallKind;
  categoryId: CustomCategoryId | null;
  name: string | null;
}

export interface MockCategoriesSeed {
  categories?: readonly CategorySummary[];
  unreadable?: number;
  interrupted?: readonly CategoryInterrupted[];
}

export class MockCategories {
  #categories: CategorySummary[];
  #unreadable: number;
  #interrupted: CategoryInterrupted[];
  #call: Call | null = null;
  readonly #deps: { nextId: (prefix: string) => string; nowIso: () => string };

  constructor(seed: MockCategoriesSeed, deps: { nextId: (prefix: string) => string; nowIso: () => string }) {
    this.#categories = [...(seed.categories ?? [])];
    this.#unreadable = seed.unreadable ?? 0;
    this.#interrupted = [...(seed.interrupted ?? [])];
    this.#deps = deps;
  }

  list(): CategoriesListResult {
    const call = this.#call;
    const busy: CategoryBusy | null = call === null || call.name === null ? null : { kind: call.kind, name: call.name, categoryId: call.categoryId };
    return { categories: [...this.#categories], unreadable: this.#unreadable, interrupted: [...this.#interrupted], busy };
  }

  get(categoryId: string): CategorySummary | undefined {
    return this.#categories.find((c) => c.categoryId === categoryId);
  }

  /** Whether a run may name every custom ref: the first one the library does not hold, or undefined. */
  firstUnknown(refs: readonly string[]): string | undefined {
    return refs.find((ref) => this.get(ref) === undefined);
  }

  // ---------- the one paid call at a time ----------

  /** Claims the one paid call; false (IN_FLIGHT) when another is under way. */
  claim(call: Call): boolean {
    if (this.#call !== null) return false;
    this.#call = call;
    return true;
  }

  release(): void {
    this.#call = null;
  }

  /** Whether a paid call is under way: a library switch is refused meanwhile. */
  inFlight(): boolean {
    return this.#call !== null;
  }

  /** The call under way for `categoryId`: its record is about to be replaced. */
  regenerating(categoryId: string): boolean {
    return this.#call?.kind === "regenerate" && this.#call.categoryId === categoryId;
  }

  /** Whether the create in flight is about to take this name (the one name rule): a rename to it would lose the paid create at its write. */
  creating(name: string): boolean {
    return this.#call?.kind === "create" && this.#call.name !== null && categoryNameKey(this.#call.name) === categoryNameKey(name);
  }

  /** What a regenerate's claim names: the category's name, once known. */
  nameOf(categoryId: string): string | null {
    return this.get(categoryId)?.name ?? null;
  }

  // ---------- writes ----------

  /** VALIDATION when the library is full or another category holds the name (any letter case, edge spaces). */
  roomRefusal(name: string, exceptId: string | null): EngineError | null {
    if (exceptId === null && this.#categories.length >= MAX_CUSTOM_CATEGORIES) {
      return { code: "VALIDATION", categoryReason: "limit", detail: `the library already holds ${MAX_CUSTOM_CATEGORIES} categories; delete one first` };
    }
    if (this.#categories.some((c) => c.categoryId !== exceptId && categoryNameKey(c.name) === categoryNameKey(name))) {
      return { code: "VALIDATION", categoryReason: "name-taken", detail: "another category already has this name" };
    }
    return null;
  }

  create(name: string, description: string, spentMicros: number): CategorySummary {
    const now = this.#deps.nowIso();
    const { label, style, pool } = mockCategoryPool(name, description);
    const category: CategorySummary = {
      categoryId: `cat-${this.#deps.nextId("mock")}` as CustomCategoryId,
      name: name.trim(),
      description,
      label,
      style,
      pool,
      model: MODEL,
      spentMicros,
      createdAt: now,
      updatedAt: now,
    };
    this.#categories = [...this.#categories, category];
    return category;
  }

  replacePool(categoryId: string, description: string, spentMicros: number): CategorySummary | undefined {
    const current = this.get(categoryId);
    if (current === undefined) return undefined;
    const { label, style, pool } = mockCategoryPool(current.name, description);
    return this.#put({ ...current, description, label, style, pool, spentMicros: current.spentMicros + spentMicros, updatedAt: this.#deps.nowIso() });
  }

  addSpend(categoryId: string, micros: number): CategorySummary | undefined {
    const current = this.get(categoryId);
    return current === undefined ? undefined : this.#put({ ...current, spentMicros: current.spentMicros + micros, updatedAt: this.#deps.nowIso() });
  }

  /** A rename and/or items to remove, together or not at all, with the store's refusals. */
  update(categoryId: string, change: { name?: string; removeLocations?: readonly string[]; removeOutfits?: readonly string[] }): CategorySummary | EngineError {
    const current = this.get(categoryId);
    if (current === undefined) return { code: "NOT_FOUND", detail: `no readable category ${categoryId}` };
    let { name } = current;
    if (change.name !== undefined) {
      name = change.name.trim();
      const taken = this.roomRefusal(name, categoryId);
      if (taken !== null) return taken;
    }
    let { locations, outfits } = current.pool;
    for (const text of change.removeLocations ?? []) {
      if (!locations.some((l) => categoryNameKey(l.name) === categoryNameKey(text))) return { code: "VALIDATION", categoryReason: "item-not-found", detail: "the category has no such place" };
      locations = locations.filter((l) => categoryNameKey(l.name) !== categoryNameKey(text));
    }
    for (const text of change.removeOutfits ?? []) {
      if (!outfits.some((o) => categoryNameKey(o) === categoryNameKey(text))) return { code: "VALIDATION", categoryReason: "item-not-found", detail: "the category has no such outfit" };
      outfits = outfits.filter((o) => categoryNameKey(o) !== categoryNameKey(text));
    }
    if (locations.length < POOL_PLACES_MIN) return { code: "VALIDATION", categoryReason: "below-minimum", detail: `a pool keeps at least ${POOL_PLACES_MIN} places` };
    if (outfits.length < POOL_OUTFITS_MIN) return { code: "VALIDATION", categoryReason: "below-minimum", detail: `a pool keeps at least ${POOL_OUTFITS_MIN} outfits` };
    if (current.pool.shotDeck.includes("mirror") && !locations.some((l) => l.mirror)) return { code: "VALIDATION", categoryReason: "mirror-needed", detail: "the deck draws mirror shots: keep a place with a mirror" };
    return this.#put({ ...current, name, pool: { ...current.pool, locations, outfits }, updatedAt: this.#nextStamp(current.updatedAt) });
  }

  remove(categoryId: string): boolean {
    const before = this.#categories.length;
    this.#categories = this.#categories.filter((c) => c.categoryId !== categoryId);
    return this.#categories.length !== before;
  }

  // ---------- the calls a closed Studio left ----------

  leaveInterrupted(call: CategoryInterrupted): void {
    this.#interrupted = [...this.#interrupted, call];
  }

  dismiss(jobId: string): boolean {
    const before = this.#interrupted.length;
    this.#interrupted = this.#interrupted.filter((i) => i.jobId !== jobId);
    return this.#interrupted.length !== before;
  }

  #put(next: CategorySummary): CategorySummary {
    this.#categories = this.#categories.map((c) => (c.categoryId === next.categoryId ? next : c));
    return next;
  }

  #nextStamp(previous: string): string {
    const now = this.#deps.nowIso();
    return now > previous ? now : previous;
  }
}
