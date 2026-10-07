import type { CategoriesListResult, CategorySummary, CustomCategoryId, EngineError, Estimate, ScenePose } from "../../shared/engine";
import type { EngineClient } from "./client";
import type { CategoryStoreChange, EngineStore } from "./store";

// CS.3: the window's own category slice, built on the store's category listeners (CS.2). One per window (the engine provider owns it), so
// what a screen starts outlives the screen: a create the owner hid with «Скрыть», or a Photos screen left while a pool is composed, still
// lands here, and the screen shown next reads it. It holds:
// - the library's custom categories (`categories.list`): asked when a screen first retains the slice, again after a snapshot taken again
//   (the store's `resynced`: a gap, a restarted engine, a library switch) and for another engine or library folder, then kept current by
//   `category.changed` in seq order. The last list stays on show while the same library is listed again;
// - the pool call's price (`categories.estimate`), keyed by the text model it runs on: a change of that model asks again, and a price for
//   another key is never offered;
// - the window's one paid category call (`categories.create` / `categories.regenerate`), sent only with the worst case a priced button
//   showed, never twice (a second ask while one is on its way sends nothing), and its outcome until the screen clears it.
// The free commands (rename, remove an item, delete, forget an interrupted call) go through here too, so their answers show at once.

export type CategoryList =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly error: EngineError }
  | ({ readonly status: "ready" } & CategoriesListResult);

interface CallBase {
  /** The name asked for (a create) or the category's own (a regenerate). */
  readonly name: string;
  readonly description: string;
  readonly acceptedWorstMicros: number;
  /** `Date.now()` at the click. */
  readonly startedAt: number;
}

/** The paid category call this window is making: what was asked, at which accepted worst case, and when (for the dialog's seconds). */
export type CategoryCall =
  | (CallBase & { readonly kind: "create"; readonly categoryId: null })
  | (CallBase & { readonly kind: "regenerate"; readonly categoryId: CustomCategoryId });

/**
 * How the window's last create or regenerate ended. A success carries the category and what this call cost; a failure the engine's
 * error (its `spentMicros` from the moment the call started) and, for PRICE_CHANGED, the worst case the refused click had accepted,
 * so the new price can be told as «было не больше … теперь не больше …».
 */
export type CategoryOutcome =
  | { readonly ok: true; readonly call: CategoryCall; readonly category: CategorySummary; readonly spentMicros: number }
  | { readonly ok: false; readonly call: CategoryCall; readonly error: EngineError; readonly previousWorstMicros: number | null };

export interface CategoryLibraryView {
  readonly list: CategoryList;
  /** The pool call's price for `key` (the text model it runs on); null until asked, and while a re-price after PRICE_CHANGED failed. */
  readonly price: { readonly key: string; readonly estimate: Estimate } | null;
  readonly priceError: EngineError | null;
  readonly call: CategoryCall | null;
  readonly outcomes: { readonly create: CategoryOutcome | null; readonly regenerate: CategoryOutcome | null };
  /**
   * The categories this window regenerated since it opened: `regenerated` once one answered, `retried` while only failed ones did (they cost,
   * and kept the old pool). The sheet says «пересоздана» and «всего потрачено» from it. The contract keeps no date or count of
   * regenerations (`updatedAt` moves with a rename too), so after a restart a regenerated category reads «создана … · потрачено» with its
   * true total.
   */
  readonly regenerated: ReadonlyMap<string, "regenerated" | "retried">;
}

/** A free command's answer as the screen needs it. */
export type FreeReply<T> = { readonly ok: true; readonly result: T } | { readonly ok: false; readonly error: EngineError };

const INITIAL: CategoryLibraryView = {
  list: { status: "loading" },
  price: null,
  priceError: null,
  call: null,
  outcomes: { create: null, regenerate: null },
  regenerated: new Map(),
};

/** The library's order: oldest first, then by id (the engine's store lists them so). */
function byCreation(a: CategorySummary, b: CategorySummary): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.categoryId < b.categoryId ? -1 : a.categoryId > b.categoryId ? 1 : 0;
}

function upsert(categories: readonly CategorySummary[], category: CategorySummary): CategorySummary[] {
  const known = categories.some((c) => c.categoryId === category.categoryId);
  return known ? categories.map((c) => (c.categoryId === category.categoryId ? category : c)) : [...categories, category].sort(byCreation);
}

function applyChange(list: CategoriesListResult, change: CategoryStoreChange): CategoriesListResult {
  return change.change === "upserted"
    ? { ...list, categories: upsert(list.categories, change.category) }
    : { ...list, categories: list.categories.filter((c) => c.categoryId !== change.categoryId) };
}

export class CategoryLibrary {
  #view: CategoryLibraryView = INITIAL;
  readonly #listeners = new Set<() => void>();
  readonly #created = new Set<(category: CategorySummary) => void>();
  /** How many screens show the slice: nothing is asked of the engine while none does. */
  #retained = 0;
  /** The library (engine and folder) the list belongs to, and the one the store is on now. */
  #listedKey: string | null = null;
  /** A snapshot or a library switch was heard while no screen showed the slice: the next one to retain it lists again. */
  #stale = false;
  /** The list asked for and not yet answered: its library key, and whether it must be asked again once it answers. */
  #listing: { key: string; generation: number; again: boolean } | null = null;
  #generation = 0;
  /** Changes heard while the list was on its way: applied to its answer. */
  #early: CategoryStoreChange[] = [];
  #pricing: string | null = null;
  /** The newest price request: only its answer counts, so a forced re-price outranks an older estimate still on its way. */
  #priceGeneration = 0;
  #sending = false;
  #stop: (() => void) | null = null;

  constructor(
    private readonly client: Pick<EngineClient, "request">,
    private readonly store: Pick<EngineStore, "getView" | "subscribe" | "subscribeCategories">,
    private readonly now: () => number = () => Date.now(),
  ) {}

  // ---------- React glue (useSyncExternalStore) ----------

  readonly getView = (): CategoryLibraryView => this.#view;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** A create of this window succeeded (dialog shown or hidden): the Photos form puts the new category in the run at once (owner decision 4). */
  subscribeCreated(listener: (category: CategorySummary) => void): () => void {
    this.#created.add(listener);
    return () => {
      this.#created.delete(listener);
    };
  }

  // ---------- lifecycle ----------

  /** Follows the store (its library and text model, and `category.changed`); asks the engine nothing until a screen retains the slice. */
  start(): () => void {
    this.#stop?.();
    const stopView = this.store.subscribe(() => this.#onStore());
    const stopCategories = this.store.subscribeCategories((signal) => {
      if (signal.change === "resynced") this.#list();
      else this.#onChange(signal);
    });
    this.#stop = () => {
      stopView();
      stopCategories();
    };
    return () => {
      this.#stop?.();
      this.#stop = null;
    };
  }

  /** A screen shows the categories: the first one has them listed and priced. Returns its release. */
  retain(): () => void {
    this.#retained += 1;
    this.#onStore();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#retained -= 1;
    };
  }

  /** Lists again (a retry, or a dialog that wants a fresh `busy`), keeping the last list on show. */
  reload(): void {
    if (this.#view.list.status === "failed") this.#update({ list: { status: "loading" } });
    this.#list();
  }

  /** Prices the pool call again (a dialog opened: the price it shows is a fresh one). */
  refreshPrice(): void {
    this.#price(true);
  }

  // ---------- the paid call ----------

  /** A new category, at the worst case `accepted` that a priced button showed. Nothing is sent while another call of this window is on its way. */
  async create(name: string, description: string, accepted: Estimate): Promise<void> {
    await this.#call({ kind: "create", categoryId: null, name: name.trim(), description, acceptedWorstMicros: accepted.worstMicros, startedAt: this.now() });
  }

  /** A new pool for `categoryId` from `description`, at the worst case `accepted` that a priced button showed. */
  async regenerate(categoryId: CustomCategoryId, description: string, accepted: Estimate): Promise<void> {
    const list = this.#view.list;
    const name = list.status === "ready" ? (list.categories.find((c) => c.categoryId === categoryId)?.name ?? "") : "";
    await this.#call({ kind: "regenerate", categoryId, name, description, acceptedWorstMicros: accepted.worstMicros, startedAt: this.now() });
  }

  clearOutcome(kind: "create" | "regenerate"): void {
    if (this.#view.outcomes[kind] === null) return;
    this.#update({ outcomes: { ...this.#view.outcomes, [kind]: null } });
  }

  async #call(call: CategoryCall): Promise<void> {
    // A second click before the screen re-renders its disabled button must never send twice.
    if (this.#sending) return;
    this.#sending = true;
    this.#update({ call, outcomes: { ...this.#view.outcomes, [call.kind]: null } });
    let outcome: CategoryOutcome;
    try {
      const reply =
        call.kind === "create"
          ? await this.client.request("categories.create", { name: call.name, description: call.description, acceptedWorstMicros: call.acceptedWorstMicros })
          : await this.client.request("categories.regenerate", { categoryId: call.categoryId, description: call.description, acceptedWorstMicros: call.acceptedWorstMicros });
      if (reply.ok) {
        this.#apply({ change: "upserted", category: reply.result.category });
        outcome = { ok: true, call, category: reply.result.category, spentMicros: reply.result.spentMicros };
      } else {
        outcome = { ok: false, call, error: reply.error, previousWorstMicros: reply.error.code === "PRICE_CHANGED" ? call.acceptedWorstMicros : null };
      }
    } finally {
      this.#sending = false;
    }
    let regenerated = this.#view.regenerated;
    if (call.kind === "regenerate") {
      const was = regenerated.get(call.categoryId);
      // A failed one is «retried» only if it cost something: a refusal for free (PRICE_CHANGED, IN_FLIGHT, VALIDATION) changed nothing.
      const spent = !outcome.ok && (outcome.error.spentMicros ?? 0) > 0;
      if (outcome.ok || was === "regenerated") regenerated = new Map(regenerated).set(call.categoryId, "regenerated");
      else if (spent) regenerated = new Map(regenerated).set(call.categoryId, "retried");
    }
    // A list taken while this call ran names it as the engine's call in flight: it is over now.
    const list = this.#view.list;
    const ownBusy = list.status === "ready" && list.busy !== null && list.busy.kind === call.kind && list.busy.categoryId === call.categoryId && list.busy.name === call.name;
    this.#update({ call: null, outcomes: { ...this.#view.outcomes, [call.kind]: outcome }, regenerated, ...(ownBusy ? { list: { ...list, busy: null } } : {}) });
    if (outcome.ok && call.kind === "create") for (const listener of [...this.#created]) listener(outcome.category);
    // Refused for its price: nothing was sent. The price just refused is taken off, so no button offers it again; the fresh one answers
    // (and outranks an estimate already on its way), and a new click confirms it.
    if (!outcome.ok && outcome.error.code === "PRICE_CHANGED") {
      this.#update({ price: null, priceError: null });
      this.#price(true);
    }
    // Refused because another call runs (another window's): a fresh list names it.
    if (!outcome.ok && outcome.error.code === "IN_FLIGHT") this.#list();
  }

  // ---------- the free commands ----------

  /** A rename and/or places or outfits to remove (free); the answer is shown at once. */
  async update(categoryId: CustomCategoryId, change: { name?: string; removeLocations?: string[]; removeOutfits?: string[]; poses?: ScenePose[] | null }): Promise<FreeReply<CategorySummary>> {
    const reply = await this.client.request("categories.update", { categoryId, ...change });
    if (!reply.ok) return reply;
    this.#apply({ change: "upserted", category: reply.result.category });
    return { ok: true, result: reply.result.category };
  }

  /** Deletes a category (free). One left out over the limit comes back, so the list is asked again then. */
  async remove(categoryId: CustomCategoryId): Promise<FreeReply<CustomCategoryId>> {
    const reply = await this.client.request("categories.delete", { categoryId });
    if (!reply.ok) return reply;
    this.#apply({ change: "removed", categoryId });
    return { ok: true, result: categoryId };
  }

  /** Forgets an interrupted call (free); the list is asked again, which no longer names it. */
  async dismissInterrupted(jobId: string): Promise<FreeReply<string>> {
    const reply = await this.client.request("categories.dismissInterrupted", { jobId });
    if (!reply.ok) return reply;
    const list = this.#view.list;
    if (list.status === "ready") this.#update({ list: { ...list, interrupted: list.interrupted.filter((i) => i.jobId !== jobId) } });
    this.#list();
    return { ok: true, result: jobId };
  }

  // ---------- internals ----------

  /** Which engine and library folder the store is on; null before its first snapshot. */
  #libraryKey(): string | null {
    const view = this.store.getView();
    if (view.phase !== "ready" || view.settings === null) return null;
    return `${view.bootId ?? ""}\n${view.settings.libraryPath}`;
  }

  #priceKey(): string | null {
    const settings = this.store.getView().settings;
    return settings === null ? null : settings.textModel;
  }

  #onStore(): void {
    if (this.#retained === 0) return;
    const key = this.#libraryKey();
    if (key === null) return;
    if (this.#listing?.key !== key) {
      // Another engine or library folder: what was listed belongs to the old one and is never shown for the new one, also when the switch
      // was heard while no screen showed the slice.
      if (this.#listedKey !== null && key !== this.#listedKey && this.#view.list.status !== "loading") this.#update({ list: { status: "loading" } });
      if (key !== this.#listedKey || this.#stale) this.#list();
    }
    this.#price(false);
  }

  #list(): void {
    if (this.#retained === 0) {
      // Nobody shows it: the next screen to retain the slice lists afresh (and starts from loading if the library is another one).
      this.#stale = true;
      return;
    }
    const key = this.#libraryKey();
    if (key === null) return;
    if (this.#listing !== null && this.#listing.key === key) {
      // One is on its way: it is asked once more when it answers (changes in the gap may predate its answer).
      this.#listing.again = true;
      return;
    }
    const generation = ++this.#generation;
    this.#stale = false;
    this.#listing = { key, generation, again: false };
    this.#early = [];
    void this.client.request("categories.list", {}).then((reply) => {
      const listing = this.#listing;
      if (listing === null || listing.generation !== generation) return;
      this.#listing = null;
      if (key !== this.#libraryKey()) {
        // The library moved while it was asked: ask the new one.
        this.#list();
        return;
      }
      if (reply.ok) {
        this.#listedKey = key;
        const list = this.#early.splice(0).reduce(applyChange, reply.result);
        // Nothing composing any more: a refusal that said another call was running is over.
        const { create, regenerate } = this.#view.outcomes;
        const over = (o: CategoryOutcome | null): boolean => list.busy === null && o?.ok === false && o.error.code === "IN_FLIGHT";
        this.#update({ list: { status: "ready", ...list }, ...(over(create) || over(regenerate) ? { outcomes: { create: over(create) ? null : create, regenerate: over(regenerate) ? null : regenerate } } : {}) });
      } else if (this.#view.list.status !== "ready" || this.#listedKey !== key) {
        this.#update({ list: { status: "failed", error: reply.error } });
      }
      if (listing.again) this.#list();
    });
  }

  #onChange(change: CategoryStoreChange): void {
    if (this.#listing !== null) this.#early.push(change);
    this.#apply(change);
    // A call another window made was named as busy: a change says it may be over, and a fresh list says whether it is.
    const list = this.#view.list;
    if (list.status === "ready" && list.busy !== null) this.#list();
  }

  #apply(change: CategoryStoreChange): void {
    const list = this.#view.list;
    if (list.status !== "ready") return;
    this.#update({ list: { status: "ready", ...applyChange(list, change) } });
    // A category left out over the limit takes the place of one deleted: only a new list says which.
    if (change.change === "removed" && list.overLimit > 0) this.#list();
  }

  /** Asks for the pool call's price, unless it is known for the current key (or `fresh` asks again anyway). */
  #price(fresh: boolean): void {
    if (this.#retained === 0) return;
    const key = this.#priceKey();
    if (key === null) return;
    if (!fresh && (this.#pricing === key || this.#view.price?.key === key)) return;
    const generation = ++this.#priceGeneration;
    this.#pricing = key;
    void this.client.request("categories.estimate", {}).then((reply) => {
      if (generation !== this.#priceGeneration) return;
      this.#pricing = null;
      if (this.#priceKey() !== key) {
        // The text model moved on while this was asked: the new one is priced instead.
        this.#price(false);
        return;
      }
      if (reply.ok) this.#update({ price: { key, estimate: reply.result }, priceError: null });
      else this.#update({ price: null, priceError: reply.error });
    });
  }

  #update(patch: Partial<CategoryLibraryView>): void {
    this.#view = { ...this.#view, ...patch };
    for (const listener of [...this.#listeners]) listener();
  }
}
